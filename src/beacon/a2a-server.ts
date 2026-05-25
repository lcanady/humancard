/**
 * Agent2Agent (A2A) protocol surface for the humancard Beacon.
 *
 * Combines the executor (text-routing logic) and Express mount (well-known
 * endpoints + JSON-RPC) into a single module. Two exports:
 *
 * - {@link HumancardA2AExecutor} — implements `AgentExecutor`, dispatching
 *   text commands to the same underlying scoring engine that MCP tools use.
 * - {@link mountA2A} — mount discovery and JSON-RPC endpoints on Express.
 */

import { randomUUID } from "node:crypto";

import type { Express } from "express";

import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import type { AgentCard as SdkAgentCard, Message, Part } from "@a2a-js/sdk";

import type { RawProfile } from "../profile.js";
import { generateAgentCard } from "../generator.js";
import type { AgentCard } from "../types/agent-card.js";
import { config } from "./config.js";
import { toPublicError } from "./errors.js";
import { checkDealbreakers, scoreOpportunity } from "../scoring/engine.js";

/**
 * Build the live AgentCard. Recomputed on each call so capability flags and
 * additional-interfaces always reflect the runtime state.
 */
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

/** One-line help string returned for unrecognized inputs. */
const HELP_TEXT: string = [
  "humancard Beacon (A2A surface). Available commands:",
  "  profile                 — return the full candidate profile",
  "  card                    — return the live A2A Agent Card",
  "  skills                  — return tier1/tier2 skills",
  "  dealbreakers: <text>    — scan <text> for dealbreaker phrases",
  "  score: <text>           — LLM-score <text> against weighted criteria",
].join("\n");

/** Concatenate all `text` parts from a Message. */
function extractText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Implementation of the A2A `AgentExecutor` that maps a user's text into
 * one of five operations matching the MCP toolset.
 */
export class HumancardA2AExecutor implements AgentExecutor {
  private readonly profile: RawProfile;
  /** Tracks tasks the executor has been asked to cancel mid-flight. */
  private readonly canceledTasks: Set<string> = new Set();

  /** @param profile Validated candidate profile, captured for the executor lifetime. */
  public constructor(profile: RawProfile) {
    this.profile = profile;
  }

  /** Handle a single user message and emit one agent reply. */
  public async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    try {
      const text = extractText(requestContext.userMessage);
      const replyText = await this.dispatch(text);
      this.publishReply(requestContext, eventBus, replyText);
    } catch (err) {
      const pub = toPublicError(err);
      this.publishReply(
        requestContext,
        eventBus,
        `Error (${pub.code}): ${pub.message}`,
      );
    } finally {
      eventBus.finished();
    }
  }

  /** Mark a task as canceled. */
  public async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.canceledTasks.add(taskId);
    return Promise.resolve();
  }

  /** Emit a single agent-role text reply on the event bus. */
  private publishReply(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    text: string,
  ): void {
    const reply: Message = {
      kind: "message",
      role: "agent",
      messageId: randomUUID(),
      parts: [{ kind: "text", text }],
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
    };
    eventBus.publish(reply);
  }

  /** Parse the user's text into one of the operations and produce a reply string. */
  private async dispatch(text: string): Promise<string> {
    if (text.length === 0) return HELP_TEXT;
    // Reject oversized inputs before doing any LLM dispatch — same cap as MCP.
    if (text.length > 8200) {
      return "Error (BAD_REQUEST): input too long — keep messages under 8KB.";
    }

    const lower = text.toLowerCase();

    if (lower.startsWith("score:")) {
      const jd = text.slice("score:".length).trim();
      if (jd.length === 0) return "Provide a job description after `score:`.";
      const result = await scoreOpportunity(this.profile, jd);
      return JSON.stringify(result, null, 2);
    }

    if (lower.startsWith("dealbreakers:")) {
      const jd = text.slice("dealbreakers:".length).trim();
      if (jd.length === 0) return "Provide a job description after `dealbreakers:`.";
      const result = checkDealbreakers(this.profile, jd);
      return JSON.stringify(result, null, 2);
    }

    if (lower === "profile") return JSON.stringify(this.profile, null, 2);
    if (lower === "card") return JSON.stringify(buildCard(this.profile), null, 2);
    if (lower === "skills") {
      const card = buildCard(this.profile);
      return JSON.stringify(
        {
          skills: card.skills,
          tier1: this.profile.stack.tier1,
          tier2: this.profile.stack.tier2,
        },
        null,
        2,
      );
    }

    return HELP_TEXT;
  }
}

/**
 * Mount the A2A surface onto the given Express app.
 *
 * Endpoints exposed:
 * - `GET /.well-known/agent-card.json` — A2A v0.3 discovery (canonical).
 * - `GET /.well-known/agent.json` — pre-v0.3 back-compat alias.
 * - `POST /a2a` — JSON-RPC (`message/send`, `message/stream`,
 *   `tasks/get`, `tasks/cancel`, `tasks/resubscribe`).
 */
export function mountA2A(app: Express, profile: RawProfile): void {
  const initialCard = buildCard(profile) as unknown as SdkAgentCard;
  const executor = new HumancardA2AExecutor(profile);
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(initialCard, taskStore, executor);

  const cardProvider = async (): Promise<SdkAgentCard> =>
    Promise.resolve(buildCard(profile) as unknown as SdkAgentCard);

  const cardMiddleware = agentCardHandler({ agentCardProvider: cardProvider });
  app.use("/.well-known/agent-card.json", cardMiddleware);
  app.use("/.well-known/agent.json", cardMiddleware);

  app.use(
    "/a2a",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
}
