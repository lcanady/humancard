/**
 * Scoring engine: deterministic dealbreaker scan plus LLM-backed weighted
 * scoring against the candidate's `scoring_weights`. Uses the shared
 * Claude client so retries and key-handling are uniform across the codebase.
 */

import { z } from "zod";

import type { RawProfile } from "../profile.js";
import { PublicError } from "../beacon/errors.js";
import { claudeMessage } from "../shared/claude-client.js";
import { logger } from "../shared/logger.js";
import type {
  DealbreakerCheck,
  Recommendation,
  ScoreBreakdown,
  ScoreResult,
} from "./types.js";

/**
 * Run the deterministic dealbreaker check.
 *
 * Pure function: case-insensitive substring match of every
 * `preferences.dealbreakers` entry against the JD. No LLM calls.
 *
 * @param profile Validated candidate profile.
 * @param jobDescription Free-form JD text from the caller.
 */
export function checkDealbreakers(
  profile: RawProfile,
  jobDescription: string,
): DealbreakerCheck {
  const hay = jobDescription.toLowerCase();
  const hits: string[] = [];
  for (const phrase of profile.preferences.dealbreakers) {
    if (phrase.length === 0) continue;
    if (hay.includes(phrase.toLowerCase())) hits.push(phrase);
  }
  return { hits, passed: hits.length === 0 };
}

/**
 * Zod schema for the LLM's expected JSON response. Every cross-process JSON
 * boundary in this codebase goes through Zod.
 */
const LlmResponseSchema = z
  .object({
    breakdown: z.record(
      z.string(),
      z
        .object({
          awarded: z.number().min(0).max(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    summary: z.string().min(1),
  })
  .strict();

/**
 * Prompt template instructing Claude to score every weighted criterion in
 * `[0, 1]` and respond with strict JSON.
 */
function buildScoringPrompt(
  weights: Record<string, number>,
  jobDescription: string,
): string {
  return `You are scoring a job opportunity for a software engineer. The candidate has provided a weighted list of criteria they care about. For each criterion, judge — based ONLY on the job description below — how well the role satisfies it, on a continuous scale from 0.0 (not at all) to 1.0 (perfect match).

CRITERIA (with weights, for context only — do not score the weight itself):
${JSON.stringify(weights, null, 2)}

JOB DESCRIPTION:
"""
${jobDescription}
"""

Respond with STRICT JSON ONLY (no markdown, no code fences, no commentary). Schema:
{
  "breakdown": {
    "<criterion_name>": { "awarded": <0..1>, "reason": "<1-2 sentence justification>" },
    ...
  },
  "summary": "<one-paragraph overall take>"
}

Every key in CRITERIA above MUST appear once in "breakdown".`;
}

/** Convert a fractional 0..100 score into a recommendation tier. */
function recommendationFor(totalScore: number): Recommendation {
  if (totalScore >= 70) return "pursue";
  if (totalScore >= 40) return "consider";
  return "skip";
}

/**
 * Deterministic fallback used when the Claude client is unavailable
 * (no API key) or the upstream call fails. Never throws; preserves the
 * public schema so callers don't need to special-case the offline path.
 */
function offlineFallback(profile: RawProfile, summary: string): ScoreResult {
  const breakdown: Record<string, ScoreBreakdown> = {};
  for (const [name, weight] of Object.entries(profile.scoring_weights)) {
    breakdown[name] = {
      weight,
      awarded: 0,
      reason: "Scoring disabled: ANTHROPIC_API_KEY not configured.",
    };
  }
  return {
    totalScore: 0,
    breakdown,
    recommendation: "skip",
    summary,
  };
}

/**
 * Extract the first JSON object from a possibly-noisy LLM response. The
 * prompt asks for strict JSON, but real-world LLMs occasionally wrap output
 * in code fences regardless — this strips the most common variants before
 * delegating to `JSON.parse`.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced && fenced[1] !== undefined ? fenced[1] : trimmed;
  return JSON.parse(body);
}

/**
 * Score a job opportunity against the profile's weighted criteria using
 * Claude.
 *
 * @param profile Validated candidate profile.
 * @param jobDescription Free-form JD text.
 * @returns Structured score result. When `ANTHROPIC_API_KEY` is missing
 *          the result is the deterministic fallback (zeros + explanation).
 * @throws {PublicError} `UPSTREAM_FAILURE` when the LLM returns an
 *         unparseable / schema-invalid response.
 */
export async function scoreOpportunity(
  profile: RawProfile,
  jobDescription: string,
): Promise<ScoreResult> {
  const prompt = buildScoringPrompt(profile.scoring_weights, jobDescription);

  let text: string;
  try {
    text = await claudeMessage({ user: prompt, maxTokens: 1024 });
  } catch (err) {
    if (err instanceof PublicError && err.code === "UPSTREAM_FAILURE") {
      return offlineFallback(
        profile,
        "Scoring requires ANTHROPIC_API_KEY env var. Set it on the Beacon process to enable LLM-backed opportunity scoring.",
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    logger.error("scoring: JSON parse failed", {
      error: err instanceof Error ? err.message : String(err),
      rawLength: text.length,
      rawPreview: text.slice(0, 200),
    });
    throw new PublicError(
      "UPSTREAM_FAILURE",
      "Scoring service returned an unparseable response.",
    );
  }

  const validated = LlmResponseSchema.safeParse(parsed);
  if (!validated.success) {
    logger.error("scoring: schema validation failed", {
      issues: validated.error.issues,
    });
    throw new PublicError(
      "UPSTREAM_FAILURE",
      "Scoring service returned an unparseable response.",
    );
  }

  const breakdown: Record<string, ScoreBreakdown> = {};
  let totalScore = 0;
  for (const [criterion, weight] of Object.entries(profile.scoring_weights)) {
    const entry = validated.data.breakdown[criterion];
    if (entry === undefined) {
      breakdown[criterion] = {
        weight,
        awarded: 0,
        reason: "Scorer did not return a value for this criterion.",
      };
      continue;
    }
    breakdown[criterion] = {
      weight,
      awarded: entry.awarded,
      reason: entry.reason,
    };
    totalScore += weight * entry.awarded;
  }

  const rounded = Math.round(totalScore * 10) / 10;

  return {
    totalScore: rounded,
    breakdown,
    recommendation: recommendationFor(rounded),
    summary: validated.data.summary,
  };
}
