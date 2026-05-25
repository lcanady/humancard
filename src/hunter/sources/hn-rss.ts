/**
 * Hacker News "Who is hiring?" RSS adapter.
 *
 * Source: `https://hnrss.org/whoishiring/jobs?q=<keyword>`. The HN comment
 * convention is `Company | Role | Location | Remote — description...`,
 * so we split on `|` for canonical title/company.
 *
 * Failure isolation: per-item parse errors are logged and skipped; per-
 * keyword fetch errors logged and skipped. The function never throws.
 */

import Parser from "rss-parser";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

/** Options accepted by {@link fetchHackerNewsJobs}. */
export interface FetchHackerNewsJobsOptions {
  /** Keywords to OR-search; one upstream fetch per keyword. */
  keywords: string[];
  /**
   * Which HN feed to query. `jobs` (default) is the
   * "Who is hiring?" thread, `freelance` is "Freelancer? Seeking freelancer?",
   * and `all` aggregates both.
   */
  feed?: "jobs" | "freelance" | "all";
}

const FEED_PATHS: Record<"jobs" | "freelance", string> = {
  jobs: "whoishiring/jobs",
  freelance: "whoishiring/jobfreelancer",
};

const parser: Parser = new Parser();

/**
 * Pull HN "who is hiring" comments matching any of the given keywords.
 * Items are deduped by GUID across keywords before return.
 */
export async function fetchHackerNewsJobs(
  opts: FetchHackerNewsJobsOptions,
): Promise<JobRaw[]> {
  const feeds: Array<"jobs" | "freelance"> =
    opts.feed === "all" || opts.feed === undefined
      ? opts.feed === "all"
        ? ["jobs", "freelance"]
        : ["jobs"]
      : [opts.feed];

  const seen = new Map<string, JobRaw>();

  for (const feedKey of feeds) {
    for (const keyword of opts.keywords) {
      const url = `https://hnrss.org/${FEED_PATHS[feedKey]}?q=${encodeURIComponent(keyword)}`;
      try {
        const feed = await parser.parseURL(url);
        for (const item of feed.items) {
          try {
            const normalized = normalizeItem(item);
            if (normalized !== null && !seen.has(normalized.externalId)) {
              seen.set(normalized.externalId, normalized);
            }
          } catch (err) {
            logger.warn("hn-rss: skipping unparseable item", {
              error: err instanceof Error ? err.message : String(err),
              guid: item.guid,
            });
          }
        }
      } catch (err) {
        logger.error("hn-rss: feed fetch failed", {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return Array.from(seen.values());
}

/** Convert one rss-parser item to a `JobRaw`, or null if required fields missing. */
function normalizeItem(item: Parser.Item): JobRaw | null {
  const guid = item.guid ?? item.link;
  const link = item.link;
  if (guid === undefined || link === undefined) return null;

  const text = stripHtml(item.contentSnippet ?? item.content ?? "");
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const parts = firstLine
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  let company: string;
  let title: string;
  if (parts.length >= 2) {
    company = parts[0] ?? "Unknown";
    title = parts[1] ?? item.title ?? "Untitled";
  } else if (parts.length === 1) {
    company = parts[0] ?? "Unknown";
    title = item.title ?? "Untitled";
  } else {
    company = "Unknown";
    title = item.title ?? "Untitled";
  }

  const postedAt = item.isoDate ?? item.pubDate ?? new Date().toISOString();

  return {
    source: "hn-rss",
    externalId: guid,
    url: link,
    title,
    company,
    description: text,
    postedAt,
    raw: item,
  };
}

/** Minimal HTML stripper — sufficient for HN comment bodies. */
function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/\s+/gu, " ")
    .trim();
}
