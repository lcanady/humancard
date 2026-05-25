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
const MAX_JOBS_PER_ALERT = 10;
const MAX_SIGNALS_PER_ALERT = 8;
const MAX_CONTENT_LENGTH = 1900;

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

/** Render the markdown payload (truncated to Discord-safe length). */
function renderMarkdown(jobs: ScoredJob[]): string {
  const header = `**${jobs.length} new opportunit${jobs.length === 1 ? "y" : "ies"}**\n`;
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

  const top = fresh.slice(0, MAX_JOBS_PER_ALERT);
  const content = renderMarkdown(top);

  let delivered = 0;
  try {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.error("alert: webhook returned non-2xx", {
        status: res.status,
      });
      suppressed += top.length;
    } else {
      delivered = top.length;
      const ts = new Date(now).toISOString();
      for (const job of top) state.set(jobKey(job), ts);
      try {
        await saveState(stateFile, state);
      } catch (err) {
        logger.error("alert: state save failed", {
          stateFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("alert: webhook POST failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    suppressed += top.length;
  }

  // Anything beyond the top-N also counts as suppressed for this cycle.
  if (fresh.length > top.length) suppressed += fresh.length - top.length;

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
