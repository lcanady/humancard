/**
 * Hunter orchestrator: cron-driven loop that fans out across configured
 * job-signal sources, dedupes, scores against the candidate profile, and
 * dispatches a webhook alert (when configured).
 *
 * Lifecycle entry points:
 *  - {@link runHuntCycle} for one-shot runs (tests, ad-hoc invocations).
 *  - {@link startHunter} for the long-running daemon, which schedules the
 *    cycle via `node-cron` and runs one immediately on boot.
 */

import cron from "node-cron";

import { config } from "../beacon/config.js";
import { loadProfile } from "../profile.js";
import type { RawProfile } from "../profile.js";
import { checkDealbreakers, scoreOpportunity } from "../scoring/engine.js";
import type { ScoredJob } from "../scoring/types.js";
import { logger } from "../shared/logger.js";
import type { CompanySignal, JobRaw } from "../shared/types.js";
import { sendAlert, sendFundingAlert } from "./alert.js";
import { fetchAtsJobs } from "./sources/ats.js";
import { fetchFundingSignals } from "./sources/crunchbase.js";
import { fetchHimalayasJobs } from "./sources/himalayas.js";
import { fetchHackerNewsJobs } from "./sources/hn-rss.js";

/** Concurrency cap for the LLM-backed scoring step. */
const SCORE_CONCURRENCY = 4;

/** Minimum score to keep a result (filters out "skip" recommendations). */
const SCORE_FLOOR = 40;

/** Render a `JobRaw` into the plain-text JD that the scorer consumes. */
function jobToJd(job: JobRaw): string {
  return `Title: ${job.title}\nCompany: ${job.company}\n\n${job.description}`;
}

/**
 * Run all `tasks` with at most `limit` in flight at a time. Returns results
 * in the original index order; rejections become `null`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array<R | null>(items.length).fill(null);
  let next = 0;
  let active = 0;

  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve(results);
      return;
    }
    const launch = (): void => {
      while (active < limit && next < items.length) {
        const idx = next++;
        active++;
        const item = items[idx] as T;
        worker(item, idx)
          .then((r) => {
            results[idx] = r;
          })
          .catch((err: unknown) => {
            logger.error("hunter: scoring task failed", {
              idx,
              error: err instanceof Error ? err.message : String(err),
            });
            results[idx] = null;
          })
          .finally(() => {
            active--;
            if (next >= items.length && active === 0) {
              resolve(results);
            } else {
              launch();
            }
          });
      }
    };
    launch();
  });
}

/**
 * Run a single Hunter cycle: fetch → dedupe → dealbreaker filter → score →
 * filter → sort → alert.
 */
export async function runHuntCycle(): Promise<void> {
  const startedAt = Date.now();
  let profile: RawProfile;
  try {
    profile = await loadProfile();
  } catch (err) {
    logger.error("hunter: profile load failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const settled = await Promise.allSettled([
    fetchHimalayasJobs({ keywords: config.HUNTER_KEYWORDS }),
    fetchHackerNewsJobs({ keywords: config.HUNTER_KEYWORDS }),
    fetchAtsJobs({
      boards: config.HUNTER_ATS_BOARDS,
      keywords: config.HUNTER_KEYWORDS,
    }),
    fetchFundingSignals(),
  ]);

  const sourceNames = ["himalayas", "hn-rss", "ats", "funding"] as const;
  const collected: JobRaw[] = [];
  let fundingSignals: CompanySignal[] = [];
  const sourceCounts: Record<string, number> = {};
  for (let i = 0; i < settled.length; i++) {
    const name = sourceNames[i] ?? `source-${i}`;
    const r = settled[i];
    if (r === undefined) continue;
    if (r.status === "fulfilled") {
      if (i === 3) {
        const sigs = Array.isArray(r.value) ? (r.value as CompanySignal[]) : [];
        fundingSignals = sigs;
        sourceCounts[name] = sigs.length;
        continue;
      }
      const items = r.value as JobRaw[];
      sourceCounts[name] = items.length;
      collected.push(...items);
    } else {
      sourceCounts[name] = 0;
      logger.error("hunter: source rejected", {
        source: name,
        error:
          r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // Dedup by `${source}:${externalId}`.
  const dedup = new Map<string, JobRaw>();
  for (const job of collected) {
    const key = `${job.source}:${job.externalId}`;
    if (!dedup.has(key)) dedup.set(key, job);
  }
  const deduped = Array.from(dedup.values());

  // Drop jobs whose JD trips a dealbreaker.
  const survivors: JobRaw[] = [];
  for (const job of deduped) {
    const jd = jobToJd(job);
    const check = checkDealbreakers(profile, jd);
    if (check.passed) survivors.push(job);
  }

  // Score with bounded concurrency.
  const scoreResults = await mapWithConcurrency(
    survivors,
    SCORE_CONCURRENCY,
    async (job) => scoreOpportunity(profile, jobToJd(job)),
  );

  const scored: ScoredJob[] = [];
  for (let i = 0; i < survivors.length; i++) {
    const job = survivors[i];
    const score = scoreResults[i];
    if (job === undefined || score === null || score === undefined) continue;
    scored.push({
      ...job,
      score: score.totalScore,
      recommendation: score.recommendation,
      summary: score.summary,
    });
  }

  const filtered = scored
    .filter((j) => j.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score);

  let delivered = 0;
  let suppressed = 0;
  if (config.WEBHOOK_URL !== undefined && filtered.length > 0) {
    const alertOpts: Parameters<typeof sendAlert>[0] = {
      webhookUrl: config.WEBHOOK_URL,
      jobs: filtered,
    };
    if (config.HUNTER_STATE_FILE !== undefined) {
      alertOpts.stateFile = config.HUNTER_STATE_FILE;
    }
    const result = await sendAlert(alertOpts);
    delivered = result.delivered;
    suppressed = result.suppressed;
  }

  let signalDelivered = 0;
  let signalSuppressed = 0;
  if (config.WEBHOOK_URL !== undefined && fundingSignals.length > 0) {
    const fOpts: Parameters<typeof sendFundingAlert>[0] = {
      webhookUrl: config.WEBHOOK_URL,
      signals: fundingSignals,
    };
    if (config.HUNTER_STATE_FILE !== undefined) {
      fOpts.stateFile = config.HUNTER_STATE_FILE;
    }
    const fr = await sendFundingAlert(fOpts);
    signalDelivered = fr.delivered;
    signalSuppressed = fr.suppressed;
  }

  if (config.WEBHOOK_URL === undefined && filtered.length > 0) {
    logger.info("hunter: matches (no webhook configured)", {
      count: filtered.length,
      top: filtered.slice(0, 5).map((j) => ({
        title: j.title,
        company: j.company,
        score: j.score,
        url: j.url,
      })),
    });
  }

  logger.info("hunter: cycle complete", {
    durationMs: Date.now() - startedAt,
    sourceCounts,
    deduped: deduped.length,
    afterDealbreakers: survivors.length,
    scored: scored.length,
    alertable: filtered.length,
    delivered,
    suppressed,
    signalDelivered,
    signalSuppressed,
  });
}

/**
 * Start the long-running Hunter daemon. Runs one cycle immediately, then
 * schedules subsequent cycles via `node-cron` per `HUNTER_CRON_SCHEDULE`.
 *
 * Top-level errors are logged and the process exits non-zero so a process
 * supervisor (systemd, pm2, fly machines) can restart it.
 */
export async function startHunter(): Promise<void> {
  try {
    if (!cron.validate(config.HUNTER_CRON_SCHEDULE)) {
      throw new Error(
        `Invalid HUNTER_CRON_SCHEDULE: ${config.HUNTER_CRON_SCHEDULE}`,
      );
    }
    logger.info("hunter: starting", {
      schedule: config.HUNTER_CRON_SCHEDULE,
      keywords: config.HUNTER_KEYWORDS,
      atsBoards: config.HUNTER_ATS_BOARDS,
      webhook: config.WEBHOOK_URL !== undefined,
    });

    await runHuntCycle();

    cron.schedule(config.HUNTER_CRON_SCHEDULE, () => {
      runHuntCycle().catch((err: unknown) => {
        logger.error("hunter: scheduled cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  } catch (err) {
    logger.error("hunter: fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Auto-start when invoked directly (e.g. `node dist/hunter/orchestrator.js`).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  process.argv[1]?.endsWith("/hunter/orchestrator.js") === true;
if (invokedDirectly) {
  void startHunter();
}
