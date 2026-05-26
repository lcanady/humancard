/**
 * ATS (applicant-tracking system) job-board source. Polls public Greenhouse,
 * Lever, and Ashby boards — all expose unauthenticated JSON — and normalizes
 * to `JobRaw`. This is where modern AI/web3 startups publish job postings.
 *
 * Failure isolation: any per-board fetch/parse error is logged and that
 * board's results drop to zero. A single bad board never poisons the cycle.
 *
 * Board identifier shape (env-supplied, comma-separated):
 *   greenhouse:anthropic   →  https://boards-api.greenhouse.io/v1/boards/anthropic/jobs
 *   lever:<org>            →  https://api.lever.co/v0/postings/<org>?mode=json
 *   ashby:openai           →  https://api.ashbyhq.com/posting-api/job-board/openai
 */

import { z } from "zod";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

const GreenhouseJobSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    absolute_url: z.string().url(),
    updated_at: z.string().optional(),
    content: z.string().optional(),
    location: z.object({ name: z.string() }).partial().optional(),
  })
  .passthrough();

const GreenhouseListSchema = z
  .object({ jobs: z.array(GreenhouseJobSchema) })
  .passthrough();

const LeverJobSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string().url(),
    createdAt: z.number().optional(),
    descriptionPlain: z.string().optional(),
    description: z.string().optional(),
    categories: z
      .object({ location: z.string().optional() })
      .partial()
      .optional(),
  })
  .passthrough();

const AshbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    jobUrl: z.string().url().optional(),
    applyUrl: z.string().url().optional(),
    publishedAt: z.string().optional(),
    descriptionPlain: z.string().optional(),
    descriptionHtml: z.string().optional(),
    location: z.string().optional(),
    isListed: z.boolean().optional(),
  })
  .passthrough();

const AshbyListSchema = z
  .object({ jobs: z.array(AshbyJobSchema) })
  .passthrough();

/** Options accepted by {@link fetchAtsJobs}. */
export interface FetchAtsJobsOptions {
  /**
   * Board identifiers in `<provider>:<slug>` form. Supported providers:
   * `greenhouse`, `lever`, `ashby`. Empty list disables the source.
   */
  boards: string[];
  /**
   * Case-insensitive keyword set. A job is kept only if at least one keyword
   * appears in its title or description. Empty/undefined disables filtering
   * (returns the full board, which can be hundreds of postings).
   */
  keywords?: string[];
  /** Per-board cap after keyword filtering. Default 50. */
  perBoardLimit?: number;
}

/**
 * Fetch and normalize postings across all configured ATS boards.
 *
 * @param opts Board identifiers.
 * @returns `JobRaw[]` across all successful boards. Failing boards yield
 *          zero items but never throw.
 */
export async function fetchAtsJobs(
  opts: FetchAtsJobsOptions,
): Promise<JobRaw[]> {
  if (opts.boards.length === 0) return [];

  const settled = await Promise.allSettled(
    opts.boards.map((board) => fetchBoard(board)),
  );

  const kw =
    opts.keywords !== undefined && opts.keywords.length > 0
      ? opts.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0)
      : null;
  const perBoardLimit = opts.perBoardLimit ?? 50;

  const out: JobRaw[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r === undefined) continue;
    const board = opts.boards[i];
    if (r.status === "fulfilled") {
      let items = r.value;
      if (kw !== null) {
        items = items.filter((j) => {
          const hay = `${j.title}\n${j.description}`.toLowerCase();
          return kw.some((k) => hay.includes(k));
        });
      }
      if (items.length > perBoardLimit) items = items.slice(0, perBoardLimit);
      logger.info("ats: board ok", {
        board,
        kept: items.length,
        fetched: r.value.length,
      });
      out.push(...items);
    } else {
      logger.error("ats: board failed", {
        board,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  return out;
}

async function fetchBoard(board: string): Promise<JobRaw[]> {
  const colon = board.indexOf(":");
  if (colon <= 0) {
    logger.warn("ats: malformed board id (expected <provider>:<slug>)", {
      board,
    });
    return [];
  }
  const provider = board.slice(0, colon).toLowerCase();
  const slug = board.slice(colon + 1).trim();
  if (slug.length === 0) return [];

  if (provider === "greenhouse") return fetchGreenhouse(slug);
  if (provider === "lever") return fetchLever(slug);
  if (provider === "ashby") return fetchAshby(slug);
  logger.warn("ats: unsupported provider (expected greenhouse|lever|ashby)", {
    provider,
  });
  return [];
}

async function fetchGreenhouse(slug: string): Promise<JobRaw[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  const parsed = GreenhouseListSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`greenhouse ${slug}: schema mismatch`);
  }
  const out: JobRaw[] = [];
  for (const job of parsed.data.jobs) {
    out.push({
      source: "greenhouse",
      externalId: `${slug}/${job.id}`,
      url: job.absolute_url,
      title: job.title,
      company: slug,
      description: stripHtml(job.content ?? ""),
      postedAt: job.updated_at ?? new Date().toISOString(),
      raw: job,
    });
  }
  return out;
}

async function fetchLever(slug: string): Promise<JobRaw[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`lever ${slug}: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`lever ${slug}: expected array, got ${typeof json}`);
  }
  const out: JobRaw[] = [];
  for (const item of json) {
    const parsed = LeverJobSchema.safeParse(item);
    if (!parsed.success) {
      logger.warn("ats: lever item skipped", {
        slug,
        issues: parsed.error.issues.slice(0, 3),
      });
      continue;
    }
    const j = parsed.data;
    out.push({
      source: "lever",
      externalId: `${slug}/${j.id}`,
      url: j.hostedUrl,
      title: j.text,
      company: slug,
      description: j.descriptionPlain ?? stripHtml(j.description ?? ""),
      postedAt:
        j.createdAt !== undefined
          ? new Date(j.createdAt).toISOString()
          : new Date().toISOString(),
      raw: j,
    });
  }
  return out;
}

async function fetchAshby(slug: string): Promise<JobRaw[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ashby ${slug}: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  const parsed = AshbyListSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`ashby ${slug}: schema mismatch`);
  }
  const out: JobRaw[] = [];
  for (const job of parsed.data.jobs) {
    // Skip unlisted/internal postings — Ashby flags these explicitly.
    if (job.isListed === false) continue;
    const url2 = job.jobUrl ?? job.applyUrl;
    if (url2 === undefined) continue;
    out.push({
      source: "ashby",
      externalId: `${slug}/${job.id}`,
      url: url2,
      title: job.title,
      company: slug,
      description:
        job.descriptionPlain ?? stripHtml(job.descriptionHtml ?? ""),
      postedAt: job.publishedAt ?? new Date().toISOString(),
      raw: job,
    });
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
