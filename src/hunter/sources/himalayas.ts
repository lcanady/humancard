/**
 * Himalayas remote-jobs MCP client. Connects to the public Himalayas MCP
 * endpoint (`https://mcp.himalayas.app/mcp`, no auth) and invokes their
 * `search_jobs` tool, normalizing results to the project-wide `JobRaw`
 * shape.
 *
 * Failure isolation: any transport, parse, or schema error is logged and
 * an empty array returned — the orchestrator must never let a single
 * source crash the cycle.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

/**
 * Zod schema for a single Himalayas job item as returned by the MCP tool.
 * The upstream payload is loose JSON; we only validate the fields we
 * actually consume and tolerate extras.
 */
const HimalayasJobSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    guid: z.string().optional(),
    slug: z.string().optional(),
    title: z.string().optional(),
    company_name: z.string().optional(),
    company: z.string().optional(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    application_link: z.string().url().optional(),
    job_url: z.string().url().optional(),
    url: z.string().url().optional(),
    pub_date: z.string().optional(),
    published_at: z.string().optional(),
    posted_at: z.string().optional(),
  })
  .passthrough();

type HimalayasJob = z.infer<typeof HimalayasJobSchema>;

/** Options accepted by {@link fetchHimalayasJobs}. */
export interface FetchHimalayasJobsOptions {
  /** Keyword set to OR-search; concatenated space-separated for the upstream tool. */
  keywords: string[];
  /** Optional max results cap forwarded to the tool. */
  limit?: number;
}

/**
 * Pull jobs from the Himalayas MCP server.
 *
 * @param opts Search keywords and optional result cap.
 * @returns Validated `JobRaw[]`. Empty on any failure.
 */
export async function fetchHimalayasJobs(
  opts: FetchHimalayasJobsOptions,
): Promise<JobRaw[]> {
  const query = opts.keywords.join(" ").trim();
  if (query.length === 0) return [];

  let client: Client | undefined;
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.himalayas.app/mcp"),
    );
    client = new Client(
      { name: "humancard-hunter", version: "0.1.0" },
      { capabilities: {} },
    );
    // The streamable-HTTP transport types `sessionId` as `string | undefined`
    // while the abstract `Transport` interface declares it as optional with
    // `exactOptionalPropertyTypes` strictness. Cast through `unknown` — the
    // runtime contract is identical.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

    const callArgs: Record<string, unknown> = { query };
    if (opts.limit !== undefined) callArgs["limit"] = opts.limit;

    const result = await client.callTool({
      name: "search_jobs",
      arguments: callArgs,
    });

    const items = extractItems(result);
    const jobs: JobRaw[] = [];
    for (const item of items) {
      const parsed = HimalayasJobSchema.safeParse(item);
      if (!parsed.success) {
        logger.warn("himalayas: skipping invalid item", {
          issues: parsed.error.issues,
        });
        continue;
      }
      const normalized = normalize(parsed.data);
      if (normalized !== null) jobs.push(normalized);
    }
    return jobs;
  } catch (err) {
    logger.error("himalayas: fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // Closing a half-open transport may throw; nothing useful to do.
      }
    }
  }
}

/**
 * Pull a flat array of upstream items out of the heterogeneous MCP
 * `tools/call` result envelope. Tries the structured-content path first
 * (most modern servers), then falls back to parsing JSON out of any
 * `text` content blocks.
 */
function extractItems(result: unknown): unknown[] {
  if (typeof result !== "object" || result === null) return [];
  const obj = result as Record<string, unknown>;

  const structured = obj["structuredContent"];
  if (structured !== undefined) {
    if (Array.isArray(structured)) return structured;
    if (typeof structured === "object" && structured !== null) {
      const sObj = structured as Record<string, unknown>;
      const candidates = ["jobs", "items", "results", "data"];
      for (const key of candidates) {
        const v = sObj[key];
        if (Array.isArray(v)) return v;
      }
    }
  }

  const content = obj["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "text"
      ) {
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string") {
          try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === "object" && parsed !== null) {
              const pObj = parsed as Record<string, unknown>;
              for (const key of ["jobs", "items", "results", "data"]) {
                const v = pObj[key];
                if (Array.isArray(v)) return v;
              }
            }
          } catch {
            // Non-JSON text content; ignore.
          }
        }
      }
    }
  }

  return [];
}

/** Normalize a validated upstream item into a `JobRaw`. Returns null if required fields are missing. */
function normalize(item: HimalayasJob): JobRaw | null {
  const url =
    item.application_link ?? item.job_url ?? item.url ?? undefined;
  const title = item.title;
  const company = item.company_name ?? item.company;
  const description = item.description ?? item.excerpt ?? "";
  const externalIdRaw =
    item.guid ?? (item.id !== undefined ? String(item.id) : item.slug);
  const postedAtRaw =
    item.pub_date ?? item.published_at ?? item.posted_at ?? undefined;

  if (
    url === undefined ||
    title === undefined ||
    company === undefined ||
    externalIdRaw === undefined
  ) {
    return null;
  }

  const postedAt = postedAtRaw ?? new Date().toISOString();

  return {
    source: "himalayas",
    externalId: externalIdRaw,
    url,
    title,
    company,
    description,
    postedAt,
    raw: item,
  };
}
