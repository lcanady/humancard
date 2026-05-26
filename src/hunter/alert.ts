/**
 * Webhook alert dispatcher with persistent dedup. Reads a JSON state file
 * mapping `<source>:<externalId>` -> ISO timestamp; suppresses any job
 * seen in the last 24 hours. Posts the survivors as a single
 * Discord/Slack-compatible `{ content }` markdown payload, then atomically
 * persists the updated state.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

import { config } from "../beacon/config.js";
import { logger } from "../shared/logger.js";
import type { ScoredJob } from "../scoring/types.js";
import type { CompanySignal } from "../shared/types.js";
import type { ProjectIdea } from "./ideator.js";

const DEFAULT_STATE_FILE = ".hunter-state.json";

/**
 * Reject SSRF-prone webhook targets: only `https:` allowed, no private/loopback
 * hostnames. Operator-supplied via env in normal use; this guard exists so an
 * accidental future code path that derives the URL from user input cannot
 * cause an outbound probe to internal services or cloud metadata endpoints.
 */
function assertSafeWebhookUrl(raw: string): URL {
  const url = new URL(raw);
  if (config.HUNTER_ALLOW_INSECURE_WEBHOOK) {
    return url;
  }
  if (url.protocol !== "https:") {
    throw new Error(`webhook url must use https: scheme (got ${url.protocol})`);
  }
  const host = url.hostname;
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./u.test(host) ||
    /^10\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./u.test(host) ||
    host === "169.254.169.254" || // AWS/GCP IMDS
    /^169\.254\./u.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]";
  if (blocked) {
    throw new Error(`webhook url host is blocked (SSRF guard): ${host}`);
  }
  return url;
}
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS_PER_POST = 10;
const MAX_POSTS_PER_CYCLE = 5;
const MAX_SIGNALS_PER_ALERT = 8;
const MAX_IDEAS_PER_ALERT = 8;
const IDEA_FLOOR = 60;
const MAX_CONTENT_LENGTH = 1900;
const MAX_JOBS_PER_CYCLE = MAX_JOBS_PER_POST * MAX_POSTS_PER_CYCLE;

/** Options accepted by {@link sendAlert}. */
export interface SendAlertOptions {
  /** Discord/Slack-compatible incoming webhook URL. */
  webhookUrl: string;
  /** Score-sorted scored jobs to consider for delivery. */
  jobs: ScoredJob[];
  /** Override path to the dedup state file. */
  stateFile?: string;
}

/** Result returned by {@link sendAlert}. */
export interface SendAlertResult {
  /** Count of jobs successfully posted to the webhook. */
  delivered: number;
  /** Count of jobs filtered out by dedup or webhook failure. */
  suppressed: number;
}

/**
 * Read the current seen-IDs map. Missing or unreadable file yields an
 * empty map — the dedup is best-effort by design.
 */
async function loadState(path: string): Promise<Map<string, string>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") map.set(k, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Atomically persist the seen-IDs map (write-then-rename). */
async function saveState(path: string, state: Map<string, string>): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [k, v] of state.entries()) obj[k] = v;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await rename(tmp, path);
}

/** Produce the dedup key used in the state file. */
function jobKey(job: ScoredJob): string {
  return `${job.source}:${job.externalId}`;
}

/** Render one page of the markdown payload (truncated to Discord-safe length). */
function renderMarkdown(
  jobs: ScoredJob[],
  page: number,
  totalPages: number,
  totalJobs: number,
): string {
  const suffix = totalPages > 1 ? ` (page ${page}/${totalPages})` : "";
  const noun = totalJobs === 1 ? "opportunity" : "opportunities";
  const header = `**${totalJobs} new ${noun}${suffix}**\n`;
  const lines = jobs.map((j) => {
    const score = j.score.toFixed(1);
    return `- [${j.title} @ ${j.company}](${j.url}) — score **${score}** (${j.recommendation})`;
  });
  let content = header + lines.join("\n");
  if (content.length > MAX_CONTENT_LENGTH) {
    content = `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
  }
  return content;
}

/**
 * Dispatch a webhook alert for the supplied scored jobs.
 *
 * @param opts Webhook URL, candidate jobs, optional state-file override.
 * @returns Counts of delivered vs suppressed jobs.
 */
export async function sendAlert(opts: SendAlertOptions): Promise<SendAlertResult> {
  assertSafeWebhookUrl(opts.webhookUrl);
  const stateFile =
    opts.stateFile ?? process.env["HUNTER_STATE_FILE"] ?? DEFAULT_STATE_FILE;
  const state = await loadState(stateFile);
  const now = Date.now();

  const fresh: ScoredJob[] = [];
  let suppressed = 0;
  for (const job of opts.jobs) {
    const key = jobKey(job);
    const seen = state.get(key);
    if (seen !== undefined) {
      const seenMs = Date.parse(seen);
      if (Number.isFinite(seenMs) && now - seenMs < DEDUP_WINDOW_MS) {
        suppressed += 1;
        continue;
      }
    }
    fresh.push(job);
  }

  if (fresh.length === 0) {
    return { delivered: 0, suppressed };
  }

  // Cap total jobs delivered this cycle. Anything beyond is suppressed.
  const deliverable = fresh.slice(0, MAX_JOBS_PER_CYCLE);
  if (fresh.length > deliverable.length) {
    suppressed += fresh.length - deliverable.length;
  }

  const totalPages = Math.ceil(deliverable.length / MAX_JOBS_PER_POST);
  const ts = new Date(now).toISOString();
  let delivered = 0;

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * MAX_JOBS_PER_POST;
    const chunk = deliverable.slice(start, start + MAX_JOBS_PER_POST);
    const content = renderMarkdown(chunk, page, totalPages, deliverable.length);

    try {
      const res = await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        logger.error("alert: webhook returned non-2xx", {
          status: res.status,
          page,
          totalPages,
        });
        suppressed += chunk.length;
        // Stop further pages — webhook target is unhealthy.
        break;
      }
      delivered += chunk.length;
      for (const job of chunk) state.set(jobKey(job), ts);
    } catch (err) {
      logger.error("alert: webhook POST failed", {
        error: err instanceof Error ? err.message : String(err),
        page,
        totalPages,
      });
      suppressed += chunk.length;
      break;
    }
  }

  if (delivered > 0) {
    try {
      await saveState(stateFile, state);
    } catch (err) {
      logger.error("alert: state save failed", {
        stateFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { delivered, suppressed };
}

/** Options accepted by {@link sendFundingAlert}. */
export interface SendFundingAlertOptions {
  /** Discord/Slack-compatible incoming webhook URL. */
  webhookUrl: string;
  /** Company-level funding/launch signals to consider. */
  signals: CompanySignal[];
  /** Override path to the dedup state file. */
  stateFile?: string;
}

function signalKey(s: CompanySignal): string {
  return `${s.source}:${s.externalId}`;
}

/** Render funding signals as a Discord/Slack-safe markdown payload. */
function renderFundingMarkdown(signals: CompanySignal[]): string {
  const header = `**${signals.length} hiring-intent signal${signals.length === 1 ? "" : "s"}** (recent funding / launches)\n`;
  const lines = signals.map((s) => {
    const tag = s.signalType;
    return `- [${s.company}](${s.url}) — ${tag} (${s.source})`;
  });
  let content = header + lines.join("\n");
  if (content.length > MAX_CONTENT_LENGTH) {
    content = `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
  }
  return content;
}

/**
 * Dispatch a webhook alert for company-level funding signals. Shares the
 * dedup state file with {@link sendAlert} — keys are prefixed by source so
 * job keys (`greenhouse:...`) never collide with signal keys (`techcrunch:...`).
 */
export async function sendFundingAlert(
  opts: SendFundingAlertOptions,
): Promise<SendAlertResult> {
  assertSafeWebhookUrl(opts.webhookUrl);
  const stateFile =
    opts.stateFile ?? process.env["HUNTER_STATE_FILE"] ?? DEFAULT_STATE_FILE;
  const state = await loadState(stateFile);
  const now = Date.now();

  const fresh: CompanySignal[] = [];
  let suppressed = 0;
  for (const sig of opts.signals) {
    const key = signalKey(sig);
    const seen = state.get(key);
    if (seen !== undefined) {
      const seenMs = Date.parse(seen);
      if (Number.isFinite(seenMs) && now - seenMs < DEDUP_WINDOW_MS) {
        suppressed += 1;
        continue;
      }
    }
    fresh.push(sig);
  }

  if (fresh.length === 0) {
    return { delivered: 0, suppressed };
  }

  const top = fresh.slice(0, MAX_SIGNALS_PER_ALERT);
  const content = renderFundingMarkdown(top);

  let delivered = 0;
  try {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.error("funding-alert: webhook returned non-2xx", {
        status: res.status,
      });
      suppressed += top.length;
    } else {
      delivered = top.length;
      const ts = new Date(now).toISOString();
      for (const sig of top) state.set(signalKey(sig), ts);
      try {
        await saveState(stateFile, state);
      } catch (err) {
        logger.error("funding-alert: state save failed", {
          stateFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("funding-alert: webhook POST failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    suppressed += top.length;
  }

  if (fresh.length > top.length) suppressed += fresh.length - top.length;

  return { delivered, suppressed };
}

/** Options accepted by {@link sendIdeasAlert}. */
export interface SendIdeasAlertOptions {
  /** Discord/Slack-compatible incoming webhook URL. */
  webhookUrl: string;
  /** Generated project ideas to consider. */
  ideas: ProjectIdea[];
  /** Override path to the dedup state file. */
  stateFile?: string;
}

/**
 * Dedup key for an idea. Anchored to the source signal + idea title so
 * the same idea against the same signal isn't re-fired within the
 * dedup window, but a new signal about the same company still alerts.
 */
function ideaKey(idea: ProjectIdea): string {
  const sigKey = `${idea.signal.source}:${idea.signal.externalId}`;
  const titleSlug = idea.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `idea:${sigKey}:${titleSlug}`;
}

function renderIdeasMarkdown(ideas: ProjectIdea[]): string {
  const noun = ideas.length === 1 ? "lead" : "leads";
  const header = `**${ideas.length} project ${noun}** (from recent funding/launch signals)\n`;
  const lines = ideas.map((i) => {
    const score = i.fitScore.toFixed(0);
    return `- [**${i.title}** · ${i.signal.company}](${i.signal.url}) — fit **${score}**\n  ${i.pitch}\n  _Why:_ ${i.whyFit}`;
  });
  let content = header + lines.join("\n");
  if (content.length > MAX_CONTENT_LENGTH) {
    content = `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
  }
  return content;
}

/**
 * Dispatch a webhook alert for AI-generated project ideas. Filters out ideas
 * below {@link IDEA_FLOOR}, dedupes via the shared state file using a
 * `idea:<source>:<id>:<slug>` key, and caps the post at
 * {@link MAX_IDEAS_PER_ALERT}.
 */
export async function sendIdeasAlert(
  opts: SendIdeasAlertOptions,
): Promise<SendAlertResult> {
  assertSafeWebhookUrl(opts.webhookUrl);
  const stateFile =
    opts.stateFile ?? process.env["HUNTER_STATE_FILE"] ?? DEFAULT_STATE_FILE;
  const state = await loadState(stateFile);
  const now = Date.now();

  const above = opts.ideas.filter((i) => i.fitScore >= IDEA_FLOOR);

  const fresh: ProjectIdea[] = [];
  let suppressed = 0;
  for (const idea of above) {
    const key = ideaKey(idea);
    const seen = state.get(key);
    if (seen !== undefined) {
      const seenMs = Date.parse(seen);
      if (Number.isFinite(seenMs) && now - seenMs < DEDUP_WINDOW_MS) {
        suppressed += 1;
        continue;
      }
    }
    fresh.push(idea);
  }

  if (fresh.length === 0) {
    return { delivered: 0, suppressed };
  }

  const top = fresh.slice(0, MAX_IDEAS_PER_ALERT);
  const content = renderIdeasMarkdown(top);

  let delivered = 0;
  try {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.error("ideas-alert: webhook returned non-2xx", {
        status: res.status,
      });
      suppressed += top.length;
    } else {
      delivered = top.length;
      const ts = new Date(now).toISOString();
      for (const idea of top) state.set(ideaKey(idea), ts);
      try {
        await saveState(stateFile, state);
      } catch (err) {
        logger.error("ideas-alert: state save failed", {
          stateFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("ideas-alert: webhook POST failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    suppressed += top.length;
  }

  if (fresh.length > top.length) suppressed += fresh.length - top.length;

  return { delivered, suppressed };
}
