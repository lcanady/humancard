/**
 * Project Ideator — inverse of the job scorer.
 *
 * Given a recent funding/launch signal (a company that just raised money,
 * shipped something, or filed a Form D), ask Claude to generate concrete
 * project ideas the candidate could build, pitch, or sell into that company.
 * Each idea gets a self-assigned fit score so downstream alerting can keep
 * only the strong ones.
 *
 * Failure isolation: per-signal errors are logged and yield no ideas for
 * that signal; the function never throws.
 */

import { z } from "zod";

import { PublicError } from "../beacon/errors.js";
import { claudeMessage } from "../shared/claude-client.js";
import { logger } from "../shared/logger.js";
import type { CompanySignal } from "../shared/types.js";
import type { RawProfile } from "../profile.js";

/** A single AI-generated project lead anchored to one funding/launch signal. */
export interface ProjectIdea {
  /** Short pitchable headline, e.g. "MCP server for case-law lookup". */
  title: string;
  /** One-to-two sentence elevator pitch. */
  pitch: string;
  /** Why the candidate, specifically, is a strong fit. */
  whyFit: string;
  /** Self-assigned 0..100 fit score from the LLM. */
  fitScore: number;
  /** Signal that anchored the idea. */
  signal: CompanySignal;
}

const IdeaSchema = z
  .object({
    title: z.string().min(1),
    pitch: z.string().min(1),
    whyFit: z.string().min(1),
    fitScore: z.number().min(0).max(100),
  })
  .strict();

const LlmResponseSchema = z
  .object({ ideas: z.array(IdeaSchema) })
  .strict();

/** Default number of ideas requested per signal. */
const DEFAULT_IDEAS_PER_SIGNAL = 2;
/** Concurrency cap when fanning out the LLM calls. */
const IDEATE_CONCURRENCY = 3;

/** Pull a readable headline + snippet from the heterogeneous raw payload. */
function signalContext(signal: CompanySignal): {
  headline: string;
  snippet: string;
} {
  const raw =
    typeof signal.raw === "object" && signal.raw !== null
      ? (signal.raw as Record<string, unknown>)
      : {};
  const headline =
    typeof raw["title"] === "string" ? (raw["title"] as string) : signal.company;
  const snippet =
    (typeof raw["contentSnippet"] === "string"
      ? (raw["contentSnippet"] as string)
      : typeof raw["content"] === "string"
        ? (raw["content"] as string)
        : "") ?? "";
  return { headline, snippet };
}

function buildPrompt(
  profile: RawProfile,
  signal: CompanySignal,
  ideasPerSignal: number,
): string {
  const { headline, snippet } = signalContext(signal);
  const profileSummary = {
    name: profile.identity.name,
    title: profile.identity.title,
    summary: profile.identity.summary,
    sectors: profile.preferences.sectors,
    stack_tier1: profile.stack.tier1,
    stack_tier2: profile.stack.tier2,
    stack_crypto: profile.stack.crypto,
  };

  return `You are generating concrete, ship-able project ideas for an independent technologist who hunts for wedge opportunities in companies that just raised money or shipped something.

CANDIDATE PROFILE:
${JSON.stringify(profileSummary, null, 2)}

FUNDING / LAUNCH SIGNAL:
- Company: ${signal.company}
- Type: ${signal.signalType}
- Source: ${signal.source}
- Headline: ${headline}
- Snippet: ${snippet.slice(0, 600)}

Generate ${ideasPerSignal} distinct project ideas the CANDIDATE could build, prototype, or pitch into THIS company within ~1–4 weeks of focused work. Prefer ideas that:
- Lean on the candidate's actual stack (MCP, A2A, agentic CLIs, Solidity, DePIN).
- Address a real friction that company likely has post-funding (scaling, agent integrations, on-chain settlement, internal tooling).
- Are concrete enough to write a one-pager about — no generic "AI strategy consulting".

For each idea, self-assign a fitScore (0–100) reflecting how strongly the idea leverages the candidate's specific strengths vs the company's likely needs.

Respond with STRICT JSON ONLY (no markdown, no code fences). Schema:
{
  "ideas": [
    { "title": "...", "pitch": "1-2 sentences", "whyFit": "1 sentence", "fitScore": 0-100 }
  ]
}

The "ideas" array MUST contain exactly ${ideasPerSignal} entries.`;
}

/** Strip a code fence if present, then JSON.parse. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced && fenced[1] !== undefined ? fenced[1] : trimmed;
  return JSON.parse(body);
}

async function ideateOne(
  profile: RawProfile,
  signal: CompanySignal,
  ideasPerSignal: number,
): Promise<ProjectIdea[]> {
  let text: string;
  try {
    text = await claudeMessage({
      user: buildPrompt(profile, signal, ideasPerSignal),
      maxTokens: 1024,
    });
  } catch (err) {
    if (err instanceof PublicError && err.code === "UPSTREAM_FAILURE") {
      return [];
    }
    throw err;
  }

  let parsed: z.infer<typeof LlmResponseSchema>;
  try {
    const raw = extractJson(text);
    const validated = LlmResponseSchema.safeParse(raw);
    if (!validated.success) {
      logger.warn("ideator: llm response schema mismatch", {
        company: signal.company,
        issues: validated.error.issues.slice(0, 3),
      });
      return [];
    }
    parsed = validated.data;
  } catch (err) {
    logger.warn("ideator: llm response unparseable", {
      company: signal.company,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  return parsed.ideas.map((i) => ({
    title: i.title,
    pitch: i.pitch,
    whyFit: i.whyFit,
    fitScore: Math.round(i.fitScore * 10) / 10,
    signal,
  }));
}

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
            logger.error("ideator: task failed", {
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

/** Options accepted by {@link ideateFromSignals}. */
export interface IdeateFromSignalsOptions {
  /** Number of ideas to request per signal. Default 2. */
  ideasPerSignal?: number;
}

/**
 * Generate project ideas anchored to each funding/launch signal. Returns
 * an array sorted descending by fitScore.
 */
export async function ideateFromSignals(
  profile: RawProfile,
  signals: CompanySignal[],
  opts: IdeateFromSignalsOptions = {},
): Promise<ProjectIdea[]> {
  if (signals.length === 0) return [];
  const perSignal = opts.ideasPerSignal ?? DEFAULT_IDEAS_PER_SIGNAL;

  const results = await mapWithConcurrency(
    signals,
    IDEATE_CONCURRENCY,
    (signal) => ideateOne(profile, signal, perSignal),
  );

  const ideas: ProjectIdea[] = [];
  for (const r of results) {
    if (r === null) continue;
    ideas.push(...r);
  }
  ideas.sort((a, b) => b.fitScore - a.fitScore);
  return ideas;
}
