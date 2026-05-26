/**
 * Himalayas remote-jobs MCP client. Connects to the public Himalayas MCP
 * endpoint (`https://mcp.himalayas.app/mcp`, no auth) and invokes their
 * `search_jobs` tool once per keyword, normalizing the prose-formatted
 * response into `JobRaw`.
 *
 * Wire format note: the Himalayas server returns emoji-tagged prose
 * (NOT JSON) in its text content blocks. Blocks are separated by
 * `\n---\n` and each block carries 🚀 title, 🏢 company, 🔗 apply URL,
 * etc. We regex-extract those fields rather than trying to JSON.parse.
 *
 * Failure isolation: any transport, parse, or schema error is logged and
 * an empty array returned — the orchestrator must never let a single
 * source crash the cycle.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

/** Options accepted by {@link fetchHimalayasJobs}. */
export interface FetchHimalayasJobsOptions {
  /** Keywords; one upstream tool call per keyword, deduped by job URL. */
  keywords: string[];
  /** Page number passed to the upstream tool. Default 1. */
  page?: number;
}

/**
 * Pull jobs from the Himalayas MCP server.
 *
 * @param opts Search keywords and optional page override.
 * @returns Validated `JobRaw[]`. Empty on any failure.
 */
export async function fetchHimalayasJobs(
  opts: FetchHimalayasJobsOptions,
): Promise<JobRaw[]> {
  const keywords = opts.keywords.filter((k) => k.length > 0);
  if (keywords.length === 0) return [];

  let client: Client | undefined;
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.himalayas.app/mcp"),
    );
    client = new Client(
      { name: "humancard-hunter", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(
      transport as unknown as Parameters<Client["connect"]>[0],
    );

    const seen = new Map<string, JobRaw>();
    for (const keyword of keywords) {
      const args: Record<string, unknown> = {
        keyword,
        page: opts.page ?? 1,
      };
      try {
        const result = await client.callTool({
          name: "search_jobs",
          arguments: args,
        });
        const text = extractText(result);
        for (const job of parseBlocks(text)) {
          if (!seen.has(job.externalId)) seen.set(job.externalId, job);
        }
      } catch (err) {
        logger.warn("himalayas: search_jobs failed for keyword", {
          keyword,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return Array.from(seen.values());
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

/** Concatenate every `text`-type content block from an MCP tool result. */
function extractText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const obj = result as Record<string, unknown>;
  const content = obj["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      parts.push(b["text"]);
    }
  }
  return parts.join("\n");
}

const APPLY_RE = /🔗\s*\*\*Apply on Himalayas:\*\*\s*(\S+)/u;
const TITLE_RE = /🚀\s*\*\*(.+?)\*\*/u;
const COMPANY_RE = /🏢\s*([^\n]+)/u;

/** Strip the upstream's UTM tracking params from a URL. */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of Array.from(u.searchParams.keys())) {
      if (key.startsWith("utm_")) u.searchParams.delete(key);
    }
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

/** Stable ID from the apply URL pathname (drops query/host noise). */
function externalIdFor(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return url;
  }
}

/** Parse the prose response into one `JobRaw` per `---`-separated block. */
function parseBlocks(text: string): JobRaw[] {
  if (text.length === 0) return [];
  const blocks = text.split(/\n-{3,}\n/u);
  const out: JobRaw[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    const applyMatch = APPLY_RE.exec(trimmed);
    const titleMatch = TITLE_RE.exec(trimmed);
    const companyMatch = COMPANY_RE.exec(trimmed);
    if (applyMatch === null || titleMatch === null || companyMatch === null) {
      continue;
    }
    const url = cleanUrl(applyMatch[1] ?? "");
    const title = (titleMatch[1] ?? "").trim();
    const company = (companyMatch[1] ?? "").trim();
    if (url.length === 0 || title.length === 0 || company.length === 0) {
      continue;
    }
    out.push({
      source: "himalayas",
      externalId: externalIdFor(url),
      url,
      title,
      company,
      description: trimmed,
      postedAt: new Date().toISOString(),
      raw: { block: trimmed },
    });
  }
  return out;
}
