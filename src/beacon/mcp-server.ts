/**
 * Model Context Protocol (MCP) surface for the humancard Beacon.
 *
 * Combines the tool registration (`humancard_*` tools) and the streamable-HTTP
 * transport mounting into a single module. The two exported entry points are:
 *
 * - {@link registerHumancardTools} — register all five MCP tools on a server.
 * - {@link mountMcp} — mount the transport at `/mcp` on an Express app.
 */

import { randomUUID } from "node:crypto";

import type { Express, Request, Response } from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { RawProfile } from "../profile.js";
import { generateAgentCard, A2A_PROTOCOL_VERSION } from "../generator.js";
import type { AgentCard, AgentSkill } from "../types/agent-card.js";
import { config } from "./config.js";
import { toPublicError } from "./errors.js";
import type { PaymentWrap } from "./x402-middleware.js";
import {
  checkDealbreakers,
  scoreOpportunity,
} from "../scoring/engine.js";
import type { DealbreakerCheck, ScoreResult } from "../scoring/types.js";

// ─────────────────────────── tool registration ──────────────────────────────

/** Common input shape — every tool accepts a `response_format` toggle. */
const responseFormatField = z.enum(["json", "markdown"]).default("json");

/** Build the AgentCard exactly as the live `/.well-known/...` endpoint would. */
function buildCard(profile: RawProfile): AgentCard {
  return generateAgentCard(profile, {
    url: `${config.BEACON_BASE_URL}/a2a`,
    agentVersion: "0.1.0",
    documentationUrl: "https://humancard.dev",
    additionalInterfaces: [
      { url: `${config.BEACON_BASE_URL}/mcp`, transport: "HTTP+JSON" },
    ],
  });
}

/** Render a profile as a Markdown summary. */
function renderProfileMarkdown(profile: RawProfile): string {
  const { identity, experience, stack, preferences } = profile;
  const tier1 = stack.tier1.join(", ");
  const tier2 = stack.tier2.join(", ");
  return [
    `# ${identity.name} — ${identity.title}`,
    ``,
    `**Location:** ${identity.location}  `,
    `**Work mode:** ${identity.remote}  `,
    `**Relocate:** ${identity.relocate}  `,
    `**Availability:** ${identity.available}`,
    ``,
    `## Summary`,
    identity.summary,
    ``,
    `## Experience`,
    `- Years: ${experience.years}`,
    `- Roles: ${experience.roles.length}`,
    `- Projects: ${experience.projects.length}`,
    ``,
    `## Stack`,
    `- **Tier 1 (daily):** ${tier1}`,
    `- **Tier 2 (working):** ${tier2}`,
    ``,
    `## Preferences`,
    `- Salary floor (USD): ${preferences.salary_floor_usd}`,
    `- Equity OK: ${preferences.equity ? "yes" : "no"}`,
    `- Sectors: ${preferences.sectors.join(", ")}`,
    `- Dealbreakers: ${preferences.dealbreakers.join("; ")}`,
  ].join("\n");
}

/** Render an AgentCard as a Markdown summary. */
function renderCardMarkdown(card: AgentCard): string {
  const lines: string[] = [
    `# ${card.name}`,
    ``,
    `**Protocol:** A2A ${A2A_PROTOCOL_VERSION}  `,
    `**Version:** ${card.version}  `,
    `**URL:** ${card.url}  `,
    `**Preferred transport:** ${card.preferredTransport}`,
    ``,
    `## Description`,
    card.description,
    ``,
    `## Skills`,
  ];
  for (const skill of card.skills) {
    lines.push(`- **${skill.name}** (${skill.id}) — ${skill.description}`);
  }
  return lines.join("\n");
}

/** Render a skills listing (tier1/tier2 with depth tags) as Markdown. */
function renderSkillsMarkdown(skills: AgentSkill[], profile: RawProfile): string {
  const lines = [`# Skills`, ``, `## Tier 1 (daily-use, deep)`];
  for (const t of profile.stack.tier1) lines.push(`- ${t} _(depth: tier1)_`);
  lines.push(``, `## Tier 2 (working knowledge)`);
  for (const t of profile.stack.tier2) lines.push(`- ${t} _(depth: tier2)_`);
  lines.push(``, `## A2A skill cards`);
  for (const skill of skills) {
    lines.push(`- **${skill.name}** — tags: ${skill.tags.join(", ")}`);
  }
  return lines.join("\n");
}

/** Render a dealbreaker result as Markdown. */
function renderDealbreakerMarkdown(result: DealbreakerCheck): string {
  if (result.passed) {
    return `# Dealbreakers: PASSED\n\nNo dealbreakers fired against the supplied job description.`;
  }
  const bullets = result.hits.map((h) => `- ${h}`).join("\n");
  return `# Dealbreakers: FAILED\n\nThe following dealbreaker phrases matched:\n\n${bullets}`;
}

/** Render a score result as a Markdown table. */
function renderScoreMarkdown(result: ScoreResult): string {
  const header = [
    `# Opportunity score: ${result.totalScore} / 100 — **${result.recommendation.toUpperCase()}**`,
    ``,
    result.summary,
    ``,
    `| Criterion | Weight | Awarded | Earned | Reason |`,
    `|---|---:|---:|---:|---|`,
  ];
  for (const [name, entry] of Object.entries(result.breakdown)) {
    const earned = Math.round(entry.weight * entry.awarded * 10) / 10;
    const reason = entry.reason.replace(/\|/g, "\\|").replace(/\n/g, " ");
    header.push(
      `| ${name} | ${entry.weight} | ${entry.awarded.toFixed(2)} | ${earned} | ${reason} |`,
    );
  }
  return header.join("\n");
}

/** MCP tool result envelope. */
interface ToolResult<T extends Record<string, unknown>> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
  [key: string]: unknown;
}

function ok<T extends Record<string, unknown>>(text: string, structured: T): ToolResult<T> {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/**
 * Wrap a tool handler so any thrown error becomes a CallToolResult with an
 * `isError` flag and a public-safe message — never leaking internals.
 */
function safeHandler<Args, T extends Record<string, unknown>>(
  fn: (args: Args) => Promise<ToolResult<T>>,
): (
  args: Args,
) => Promise<
  | ToolResult<T>
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
      [key: string]: unknown;
    }
> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (err) {
      const pub = toPublicError(err);
      return {
        isError: true,
        content: [{ type: "text", text: `${pub.code}: ${pub.message}` }],
      };
    }
  };
}

/**
 * Register all five `humancard_*` MCP tools on the given server.
 *
 * Tool inventory:
 * - `humancard_get_profile` — full RawProfile.
 * - `humancard_get_card` — full AgentCard (live).
 * - `humancard_list_skills` — tier1/tier2 stack + skill cards.
 * - `humancard_check_dealbreakers` — deterministic JD dealbreaker scan.
 * - `humancard_score_opportunity` — LLM-backed weighted JD scoring.
 */
export function registerHumancardTools(
  server: McpServer,
  profile: RawProfile,
  paid: PaymentWrap = (handler) => handler as never,
): void {
  // ─── humancard_get_profile ───────────────────────────────────────────────
  const profileOutputShape = {
    profile: z.unknown(),
    response_format: z.enum(["json", "markdown"]),
  };
  server.registerTool(
    "humancard_get_profile",
    {
      title: "Get full profile",
      description:
        "Return the complete validated candidate profile (identity, experience, stack, preferences, scoring weights).",
      inputSchema: { response_format: responseFormatField },
      outputSchema: profileOutputShape,
      annotations: {
        title: "Get full profile",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler(async (args: { response_format: "json" | "markdown" }) => {
      const fmt = args.response_format;
      const text =
        fmt === "markdown" ? renderProfileMarkdown(profile) : JSON.stringify(profile, null, 2);
      return ok(text, { profile, response_format: fmt });
    }),
  );

  // ─── humancard_get_card ──────────────────────────────────────────────────
  const cardOutputShape = {
    card: z.unknown(),
    response_format: z.enum(["json", "markdown"]),
  };
  server.registerTool(
    "humancard_get_card",
    {
      title: "Get Agent Card",
      description:
        "Return the live A2A v0.3 Agent Card for this human, including the humancard extension payload.",
      inputSchema: { response_format: responseFormatField },
      outputSchema: cardOutputShape,
      annotations: {
        title: "Get Agent Card",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler(async (args: { response_format: "json" | "markdown" }) => {
      const card = buildCard(profile);
      const fmt = args.response_format;
      const text =
        fmt === "markdown" ? renderCardMarkdown(card) : JSON.stringify(card, null, 2);
      return ok(text, { card, response_format: fmt });
    }),
  );

  // ─── humancard_list_skills ───────────────────────────────────────────────
  const skillsOutputShape = {
    skills: z.array(z.unknown()),
    tier1: z.array(z.string()),
    tier2: z.array(z.string()),
    response_format: z.enum(["json", "markdown"]),
  };
  server.registerTool(
    "humancard_list_skills",
    {
      title: "List skills",
      description:
        "Return A2A skill cards plus the candidate's tier1 (daily-use) and tier2 (working knowledge) stack with depth tags.",
      inputSchema: { response_format: responseFormatField },
      outputSchema: skillsOutputShape,
      annotations: {
        title: "List skills",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler(async (args: { response_format: "json" | "markdown" }) => {
      const card = buildCard(profile);
      const fmt = args.response_format;
      const payload = {
        skills: card.skills,
        tier1: [...profile.stack.tier1],
        tier2: [...profile.stack.tier2],
        response_format: fmt,
      };
      const text =
        fmt === "markdown"
          ? renderSkillsMarkdown(card.skills, profile)
          : JSON.stringify(payload, null, 2);
      return ok(text, payload);
    }),
  );

  // ─── humancard_check_dealbreakers ────────────────────────────────────────
  const dealbreakerOutputShape = {
    passed: z.boolean(),
    hits: z.array(z.string()),
    response_format: z.enum(["json", "markdown"]),
  };
  server.registerTool(
    "humancard_check_dealbreakers",
    {
      title: "Check dealbreakers",
      description:
        "Deterministically scan a job description for the candidate's dealbreaker phrases. Returns which (if any) fired.",
      inputSchema: {
        job_description: z.string().min(1).max(8000, "job_description too long"),
        response_format: responseFormatField,
      },
      outputSchema: dealbreakerOutputShape,
      annotations: {
        title: "Check dealbreakers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler(
      async (args: { job_description: string; response_format: "json" | "markdown" }) => {
        const result = checkDealbreakers(profile, args.job_description);
        const fmt = args.response_format;
        const payload = { ...result, response_format: fmt };
        const text =
          fmt === "markdown" ? renderDealbreakerMarkdown(result) : JSON.stringify(payload, null, 2);
        return ok(text, payload);
      },
    ),
  );

  // ─── humancard_score_opportunity ─────────────────────────────────────────
  const scoreOutputShape = {
    totalScore: z.number(),
    breakdown: z.record(
      z.string(),
      z
        .object({
          weight: z.number(),
          awarded: z.number(),
          reason: z.string(),
        })
        .strict(),
    ),
    recommendation: z.enum(["pursue", "consider", "skip"]),
    summary: z.string(),
    response_format: z.enum(["json", "markdown"]),
  };
  server.registerTool(
    "humancard_score_opportunity",
    {
      title: "Score opportunity",
      description:
        "Score a job description against the candidate's weighted criteria using Claude. Returns a 0-100 weighted score, per-criterion breakdown, and a pursue/consider/skip recommendation.",
      inputSchema: {
        job_description: z.string().min(1).max(8000, "job_description too long"),
        response_format: responseFormatField,
      },
      outputSchema: scoreOutputShape,
      annotations: {
        title: "Score opportunity",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    paid(
      safeHandler(
        async (args: { job_description: string; response_format: "json" | "markdown" }) => {
          const result = await scoreOpportunity(profile, args.job_description);
          const fmt = args.response_format;
          const payload = { ...result, response_format: fmt };
          const text =
            fmt === "markdown" ? renderScoreMarkdown(result) : JSON.stringify(payload, null, 2);
          return ok(text, payload);
        },
      ),
    ),
  );
}

// ─────────────────────────── transport mounting ─────────────────────────────

type SessionMap = Map<string, StreamableHTTPServerTransport>;

/** Send a uniform JSON-RPC-shaped error response. */
function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

/**
 * Mount the MCP Streamable HTTP transport onto the given Express app at `/mcp`.
 */
export function mountMcp(app: Express, profile: RawProfile, paid: PaymentWrap): void {
  const sessions: SessionMap = new Map();

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId =
        typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined;

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId !== undefined && sessions.has(sessionId)) {
        transport = sessions.get(sessionId);
      } else if (sessionId === undefined && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string): void => {
            if (transport !== undefined) sessions.set(id, transport);
          },
          enableDnsRebindingProtection: true,
          allowedHosts: config.ALLOWED_HOSTS,
        });

        transport.onclose = (): void => {
          const id = transport?.sessionId;
          if (id !== undefined) sessions.delete(id);
        };

        const server = new McpServer({
          name: "humancard-beacon",
          version: "0.1.0",
        });
        registerHumancardTools(server, profile, paid);
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      } else {
        sendJsonRpcError(
          res,
          400,
          -32600,
          "Bad Request: missing Mcp-Session-Id and not an initialize request.",
        );
        return;
      }

      if (transport === undefined) {
        sendJsonRpcError(res, 500, -32603, "Internal error: transport unavailable.");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const pub = toPublicError(err);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, `${pub.code}: ${pub.message}`);
      }
    }
  };

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId =
        typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined;
      if (sessionId === undefined) {
        sendJsonRpcError(res, 400, -32600, "Bad Request: missing Mcp-Session-Id header.");
        return;
      }
      const transport = sessions.get(sessionId);
      if (transport === undefined) {
        sendJsonRpcError(res, 404, -32001, "Session not found.");
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      const pub = toPublicError(err);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, `${pub.code}: ${pub.message}`);
      }
    }
  };

  app.post("/mcp", (req, res) => {
    void handlePost(req, res);
  });
  app.get("/mcp", (req, res) => {
    void handleSessionRequest(req, res);
  });
  app.delete("/mcp", (req, res) => {
    void handleSessionRequest(req, res);
  });
}
