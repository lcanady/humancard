/**
 * Scoring-subsystem type definitions. Decoupled from the engine so Hunter
 * (which only needs the result shape, not the LLM call) can import these
 * without pulling in the Anthropic client.
 */

import type { JobRaw } from "../shared/types.js";

/** Recommendation tier derived from the total weighted score. */
export type Recommendation = "pursue" | "consider" | "skip";

/** Per-criterion breakdown produced by the scorer. */
export interface ScoreBreakdown {
  /** Profile-supplied weight for this criterion. */
  weight: number;
  /**
   * 0..1 fractional credit awarded by the LLM for how well the JD satisfies
   * this criterion.
   */
  awarded: number;
  /** LLM-supplied 1-2 sentence justification. */
  reason: string;
}

/** Full scoring result returned to MCP and A2A callers. */
export interface ScoreResult {
  /** Sum of `weight * awarded` across all criteria, 0..100. */
  totalScore: number;
  /** Per-criterion details, keyed by the criterion name from `scoring_weights`. */
  breakdown: Record<string, ScoreBreakdown>;
  /** Pursue / consider / skip bucket derived from `totalScore`. */
  recommendation: Recommendation;
  /** One-paragraph human-facing summary. */
  summary: string;
}

/**
 * Result of running the deterministic dealbreaker check against a job
 * description.
 */
export interface DealbreakerCheck {
  /** The dealbreaker phrases (verbatim from the profile) that fired. */
  hits: string[];
  /** True iff zero dealbreakers fired. */
  passed: boolean;
}

/**
 * A {@link JobRaw} enriched with scoring output. Consumed by Hunter when
 * it persists scored results.
 */
export interface ScoredJob extends JobRaw {
  /** Total weighted score (0..100). */
  score: number;
  /** Pursue / consider / skip bucket. */
  recommendation: Recommendation;
  /** One-paragraph human-facing summary. */
  summary: string;
}
