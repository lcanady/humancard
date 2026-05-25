/**
 * Cross-cutting shared types used by multiple subsystems (Beacon, Hunter,
 * Scoring). Every cross-process JSON boundary has a Zod schema here; the
 * exported TypeScript types are inferred from the schemas so static and
 * runtime checks can never drift.
 */

import { z } from "zod";

/**
 * Zod schema for a raw job posting collected by the Hunter agent before any
 * scoring is applied. The `raw` field carries the source-specific payload
 * verbatim so downstream consumers can re-parse if the canonical fields
 * lose information.
 */
export const JobRawSchema = z
  .object({
    /** Origin of the job posting. */
    source: z.enum([
      "himalayas",
      "hn-rss",
      "greenhouse",
      "lever",
      "crunchbase",
    ]),
    /** Stable identifier within the source system (used for dedup). */
    externalId: z.string(),
    /** Canonical URL of the posting. */
    url: z.string().url(),
    /** Job title (post-cleanup). */
    title: z.string(),
    /** Hiring company display name. */
    company: z.string(),
    /** Plain-text job description. */
    description: z.string(),
    /** ISO 8601 timestamp the posting was published. */
    postedAt: z.string(),
    /** Source-native payload, preserved verbatim. */
    raw: z.unknown(),
  })
  .strict();

/** A single raw job posting prior to scoring. */
export type JobRaw = z.infer<typeof JobRawSchema>;

/**
 * Zod schema for a company-level signal (funding round, product launch,
 * news item). Used by Hunter to surface companies worth proactively
 * targeting beyond their open-listing surface.
 */
export const CompanySignalSchema = z
  .object({
    /** Origin of the signal. */
    source: z.enum(["crunchbase", "techcrunch", "sec-edgar"]),
    /** Stable identifier within the source system (used for dedup). */
    externalId: z.string(),
    /** Canonical URL of the signal article/filing. */
    url: z.string().url(),
    /** Company display name. */
    company: z.string(),
    /** Coarse classification of the signal. */
    signalType: z.enum(["funding", "launch", "news"]),
    /** Optional dollar amount (e.g. funding round size in USD). */
    amountUsd: z.number().optional(),
    /** ISO 8601 timestamp the signal occurred / was published. */
    occurredAt: z.string(),
    /** Source-native payload, preserved verbatim. */
    raw: z.unknown(),
  })
  .strict();

/** A single company-level signal worth a hiring-intent inference. */
export type CompanySignal = z.infer<typeof CompanySignalSchema>;
