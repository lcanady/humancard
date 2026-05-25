/**
 * GitHub-org event watcher. Polls `GET /orgs/{org}/events` with conditional
 * `If-None-Match` requests so cycles after the first cost zero rate-budget
 * when nothing has changed. Filters the public event stream for hiring
 * signals: new repos named like `hiring`/`jobs`/`careers`, or pushes that
 * touch `HIRING.md` / `JOBS.md` / `CAREERS.md`-style files.
 *
 * The caller-owned `etags` map is mutated in place; the orchestrator
 * persists it across cycles in memory.
 */

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";

import { logger } from "../../shared/logger.js";
import type { JobRaw } from "../../shared/types.js";

const ThrottledOctokit = Octokit.plugin(throttling, retry);

/** Options accepted by {@link fetchGitHubHiringSignals}. */
export interface FetchGitHubHiringSignalsOptions {
  /** GitHub org slugs to poll. */
  orgs: string[];
  /**
   * Per-org ETag cache. Mutated in place: on success the latest ETag is
   * stored under the org key. Pass an empty Map on the first cycle.
   */
  etags?: Map<string, string>;
}

const REPO_NAME_RE = /hir(?:e|ing)|jobs|careers/iu;
const FILE_NAME_RE = /HIRING|JOBS|CAREERS/u;

/** Build a configured Octokit client (auth optional). */
function buildOctokit(): Octokit {
  const auth = process.env["GITHUB_TOKEN"];
  return new ThrottledOctokit({
    ...(auth !== undefined ? { auth } : {}),
    throttle: {
      onRateLimit: (
        retryAfter: number,
        options: { method?: string; url?: string },
        _o: unknown,
        retryCount: number,
      ): boolean => {
        logger.warn("github: rate limited", {
          method: options.method,
          url: options.url,
          retryAfter,
          retryCount,
        });
        return retryCount < 1;
      },
      onSecondaryRateLimit: (
        _retryAfter: number,
        options: { method?: string; url?: string },
      ): boolean => {
        logger.warn("github: secondary rate limit", {
          method: options.method,
          url: options.url,
        });
        return false;
      },
    },
  });
}

/**
 * Poll the configured orgs and synthesize a `JobRaw` for every hiring-shaped
 * event since the last cycle.
 */
export async function fetchGitHubHiringSignals(
  opts: FetchGitHubHiringSignalsOptions,
): Promise<JobRaw[]> {
  if (opts.orgs.length === 0) return [];

  const octokit = buildOctokit();
  const etagMap = opts.etags ?? new Map<string, string>();
  const out: JobRaw[] = [];

  for (const org of opts.orgs) {
    try {
      const headers: Record<string, string> = {};
      const prev = etagMap.get(org);
      if (prev !== undefined) headers["if-none-match"] = prev;

      const response = await octokit.request("GET /orgs/{org}/events", {
        org,
        headers,
        per_page: 100,
      });

      const newEtag = response.headers.etag;
      if (typeof newEtag === "string" && newEtag.length > 0) {
        etagMap.set(org, newEtag);
      }

      for (const event of response.data) {
        const synthesized = synthesizeJob(org, event);
        if (synthesized !== null) out.push(synthesized);
      }
    } catch (err) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      // 304 Not Modified is *expected* — Octokit surfaces it as a thrown error
      // because the body is empty; treat it as "no new events".
      if (status === 304) continue;
      logger.error("github: org poll failed", {
        org,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}

/**
 * Structural shape of the GitHub event payloads we care about. We only
 * read fields, so loose typing is sufficient and avoids a hard dep on the
 * Octokit response types (which vary by endpoint generic).
 */
interface GHEvent {
  id?: string;
  type?: string;
  created_at?: string | null;
  actor?: { login?: string } | null;
  repo?: { name?: string; url?: string } | null;
  payload?: Record<string, unknown>;
}

/** Map a single event into a `JobRaw` if it matches a hiring heuristic. */
function synthesizeJob(org: string, eventInput: unknown): JobRaw | null {
  if (typeof eventInput !== "object" || eventInput === null) return null;
  const event = eventInput as GHEvent;
  const id = event.id;
  if (id === undefined) return null;

  const repoName = event.repo?.name ?? "";
  const repoShort = repoName.split("/").slice(-1)[0] ?? "";
  const createdAt = event.created_at ?? new Date().toISOString();
  const actor = event.actor?.login ?? org;

  if (event.type === "CreateEvent") {
    const refType =
      typeof event.payload?.["ref_type"] === "string"
        ? (event.payload["ref_type"] as string)
        : "";
    if (refType === "repository" && REPO_NAME_RE.test(repoShort)) {
      return {
        source: "github",
        externalId: id,
        url: `https://github.com/${repoName}`,
        title: `New hiring-themed repo: ${repoShort}`,
        company: org,
        description: `${actor} created repo ${repoName} in org ${org}.`,
        postedAt: createdAt,
        raw: event,
      };
    }
  }

  if (event.type === "PushEvent") {
    const commitsRaw = event.payload?.["commits"];
    const commits = Array.isArray(commitsRaw) ? commitsRaw : [];
    const messages: string[] = [];
    let touched = false;
    for (const c of commits) {
      if (typeof c === "object" && c !== null) {
        const msg = (c as Record<string, unknown>)["message"];
        if (typeof msg === "string") {
          messages.push(msg);
          if (FILE_NAME_RE.test(msg)) touched = true;
        }
      }
    }
    // PushEvent payloads on /events don't include filenames; we approximate
    // via the commit messages, which conventionally reference the touched files.
    if (touched) {
      return {
        source: "github",
        externalId: id,
        url: `https://github.com/${repoName}`,
        title: `Hiring-file change in ${repoName}`,
        company: org,
        description: messages.join("\n").slice(0, 2000),
        postedAt: createdAt,
        raw: event,
      };
    }
  }

  return null;
}
