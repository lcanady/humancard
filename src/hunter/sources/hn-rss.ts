/**
 * Hacker News "Who is hiring?" source — Algolia-backed.
 *
 * The old `hnrss.org` feed was unreliable (frequent 429/502s on a public
 * unauthenticated endpoint). Algolia's HN Search API is operator-supported,
 * rate-limit-friendly, and the canonical lookup path for HN comments.
 *
 * Flow:
 *   1. Resolve the latest "Ask HN: Who is hiring?" story via Algolia
 *      (`author_whoishiring` + `story` tag, title starts with "Ask HN: Who").
 *   2. For each keyword, search comments under that story id.
 *   3. Normalize each comment using the `Company | Role | ...` convention.
 *
 * Failure isolation: per-keyword fetch errors are logged and skipped;
 * the function never throws.
 */

import { z } from "zod";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1";

/** Options accepted by {@link fetchHackerNewsJobs}. */
export interface FetchHackerNewsJobsOptions {
  /** Keywords; one upstream search per keyword (OR'd in the result set). */
  keywords: string[];
  /** Max results per keyword. Default 30. */
  hitsPerKeyword?: number;
}

const StorySchema = z
  .object({
    objectID: z.string(),
    title: z.string().optional(),
    created_at_i: z.number().optional(),
  })
  .passthrough();

const StoryListSchema = z
  .object({ hits: z.array(StorySchema) })
  .passthrough();

const CommentSchema = z
  .object({
    objectID: z.string(),
    comment_text: z.string().optional(),
    created_at: z.string().optional(),
    created_at_i: z.number().optional(),
    author: z.string().optional(),
  })
  .passthrough();

const CommentListSchema = z
  .object({ hits: z.array(CommentSchema) })
  .passthrough();

/** Resolve the most recent "Ask HN: Who is hiring?" story id, or null. */
async function findLatestWhoIsHiring(): Promise<string | null> {
  const url = `${ALGOLIA_BASE}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`algolia stories: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  const parsed = StoryListSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("algolia stories: schema mismatch");
  }
  for (const story of parsed.data.hits) {
    const t = story.title ?? "";
    if (/^Ask HN:\s*Who is hiring\?/iu.test(t)) {
      return story.objectID;
    }
  }
  return null;
}

/**
 * Pull HN "who is hiring" comments matching any of the given keywords from
 * the current month's thread. Items are deduped by Algolia objectID.
 */
export async function fetchHackerNewsJobs(
  opts: FetchHackerNewsJobsOptions,
): Promise<JobRaw[]> {
  if (opts.keywords.length === 0) return [];

  let storyId: string | null;
  try {
    storyId = await findLatestWhoIsHiring();
  } catch (err) {
    logger.error("hn-algolia: story lookup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (storyId === null) {
    logger.warn("hn-algolia: no whoishiring story in latest batch");
    return [];
  }

  const hits = opts.hitsPerKeyword ?? 30;
  const seen = new Map<string, JobRaw>();

  for (const keyword of opts.keywords) {
    const url = `${ALGOLIA_BASE}/search?tags=comment,story_${storyId}&query=${encodeURIComponent(
      keyword,
    )}&hitsPerPage=${hits}`;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: unknown = await res.json();
      const parsed = CommentListSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn("hn-algolia: comment payload schema mismatch", {
          keyword,
        });
        continue;
      }
      for (const c of parsed.data.hits) {
        if (seen.has(c.objectID)) continue;
        const normalized = normalize(c, storyId);
        if (normalized !== null) seen.set(c.objectID, normalized);
      }
    } catch (err) {
      logger.error("hn-algolia: keyword search failed", {
        keyword,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Array.from(seen.values());
}

function normalize(
  c: z.infer<typeof CommentSchema>,
  storyId: string,
): JobRaw | null {
  const text = stripHtml(c.comment_text ?? "");
  if (text.length === 0) return null;

  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const parts = firstLine
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // The "Who is hiring?" thread convention is `Company | Role | Location |
  // Remote — ...`. Top-level comments that don't follow this shape are
  // replies/reactions, not job posts — drop them rather than polluting alerts
  // with `Untitled @ <paragraph of prose>` entries.
  if (parts.length < 2) return null;
  const company = parts[0] ?? "Unknown";
  const title = parts[1] ?? "Untitled";

  const postedAt =
    c.created_at ??
    (c.created_at_i !== undefined
      ? new Date(c.created_at_i * 1000).toISOString()
      : new Date().toISOString());

  return {
    source: "hn-rss",
    externalId: c.objectID,
    url: `https://news.ycombinator.com/item?id=${c.objectID}`,
    title,
    company,
    description: text,
    postedAt,
    raw: { ...c, storyId },
  };
}

function stripHtml(input: string): string {
  return input
    .replace(/<p>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#x2F;/giu, "/")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#x27;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
}
