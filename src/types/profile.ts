/**
 * Re-exports the Zod-inferred profile types from `src/profile.ts` so callers
 * can `import type { RawProfile } from "humancard/types"` without pulling in
 * the loader's I/O surface.
 *
 * The Zod schema in `profile.ts` is the canonical source of truth — these
 * types are derived, not declared.
 */

export type {
  RawProfile,
  RawProfileRole,
  RawProfileProject,
} from "../profile.js";
