import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { z } from "zod";

/**
 * Zod schema for the on-disk `profile.json` source-of-truth document.
 *
 * Per project convention every JSON crossing a boundary in this codebase is
 * validated by Zod. The schema here is the canonical definition; the
 * exported `RawProfile` type is *inferred* from it, so the type and runtime
 * checks can never drift.
 *
 * Field naming follows the on-disk convention (snake_case for some keys
 * like `salary_floor_usd`); the generator in `src/generator.ts` is the
 * single point of translation to the camelCase wire format emitted in the
 * humancard extension payload.
 */
export const RawProfileRoleSchema = z
  .object({
    title: z.string().min(1),
    company: z.string().min(1),
    url: z.string().url().optional(),
    current: z.boolean(),
    start: z.string().optional(),
    end: z.string().optional(),
    highlights: z.array(z.string()),
  })
  .strict();

export const RawProfileProjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    url: z.string().url().optional(),
    highlight: z.boolean().optional(),
  })
  .strict();

export const RawProfileSchema = z
  .object({
    version: z.string().min(1),
    identity: z
      .object({
        name: z.string().min(1),
        handle: z.string().min(1),
        title: z.string().min(1),
        location: z.string().min(1),
        remote: z.string().min(1),
        relocate: z.string().min(1),
        available: z.string().min(1),
        links: z.record(z.string(), z.string().url()),
        summary: z.string().min(1),
      })
      .strict(),
    experience: z
      .object({
        years: z.number().int().nonnegative(),
        degree: z.boolean(),
        roles: z.array(RawProfileRoleSchema),
        projects: z.array(RawProfileProjectSchema),
        origin: z.string().optional(),
      })
      .strict(),
    stack: z
      .object({
        tier1: z.array(z.string()),
        tier2: z.array(z.string()),
        tier3: z.array(z.string()),
        languages: z.array(z.string()),
        infra: z.array(z.string()),
        crypto: z.array(z.string()),
        frameworks: z.array(z.string()),
        tools: z.array(z.string()),
      })
      .strict(),
    preferences: z
      .object({
        salary_floor_usd: z.number().nonnegative(),
        equity: z.boolean(),
        roles: z.array(z.string()),
        sectors: z.array(z.string()),
        dealbreakers: z.array(z.string()),
      })
      .strict(),
    scoring_weights: z.record(z.string(), z.number()),
  })
  .strict();

/** Inferred type for a fully-validated profile document. */
export type RawProfile = z.infer<typeof RawProfileSchema>;
/** Inferred type for a single role entry. */
export type RawProfileRole = z.infer<typeof RawProfileRoleSchema>;
/** Inferred type for a project entry. */
export type RawProfileProject = z.infer<typeof RawProfileProjectSchema>;

/**
 * Error thrown when `profile.json` fails Zod validation.
 *
 * Wraps the underlying ZodError so callers can render a precise diagnostic
 * (the `issues` array carries path + message) without needing to import
 * Zod themselves.
 */
export class ProfileValidationError extends Error {
  public readonly issues: ReadonlyArray<z.core.$ZodIssue>;

  public constructor(error: z.ZodError) {
    const summary = error.issues
      .map((issue) => `/${issue.path.join("/")}: ${issue.message}`)
      .join("; ");
    super(`profile.json validation failed: ${summary}`);
    this.name = "ProfileValidationError";
    this.issues = error.issues;
  }
}

/** Default location of profile.json relative to the package root. */
export const DEFAULT_PROFILE_PATH: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "profile.json",
);

/**
 * Load and validate `profile.json` from the given path.
 *
 * @param path Absolute path to a profile.json file. Defaults to the copy
 *             shipped with this package.
 * @returns Parsed, structurally-validated profile.
 * @throws {ProfileValidationError} When the JSON is missing required fields
 *         or has fields of the wrong type.
 */
export async function loadProfile(path: string = DEFAULT_PROFILE_PATH): Promise<RawProfile> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return validateProfile(parsed);
}

/**
 * Synchronously validate an unknown value as a {@link RawProfile}.
 *
 * Exported so callers that already hold the parsed JSON (e.g. an HTTP server
 * receiving an upload) can validate without re-reading from disk.
 */
export function validateProfile(input: unknown): RawProfile {
  const result = RawProfileSchema.safeParse(input);
  if (!result.success) throw new ProfileValidationError(result.error);
  return result.data;
}
