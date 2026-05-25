# Contributing to humancard

## What we're building

humancard is an open standard for representing a human candidate as an A2A
v0.3 Agent Card, plus a TypeScript reference implementation (Beacon +
Hunter). The goal is a wire format precise enough that anyone can build a
conformant beacon in any language, run it on their own domain, and be
queried directly by agentic hiring pipelines.

This repository is both the spec home and the canonical Node implementation.
PRs that improve either are welcome.

## Repo layout

```
src/
  profile.ts                  # profile.json loader + zod schema
  generator.ts                # AgentCard emission (HUMANCARD_SPEC_VERSION lives here)
  index.ts                    # public package entrypoint
  cli/generate-card.ts        # static-card CLI
  types/
    agent-card.ts             # A2A + humancard extension types
    profile.ts                # profile-internal types
  scoring/
    types.ts
    engine.ts                 # dealbreaker + score logic
  beacon/
    config.ts                 # env var inventory
    errors.ts
    mcp-server.ts             # the five humancard_* tools
    a2a-server.ts
    anp-identity.ts           # did:wba
    x402-middleware.ts
    server.ts                 # Express entry
  hunter/                     # private signal monitor (Phase 3)
  shared/
    claude-client.ts
    logger.ts
    types.ts                  # JobRaw, CompanySignal
SPEC.md                       # the protocol spec
humancard.spec.json           # JSON Schema for HumancardExtensionParams
README.md
LICENSE
.env.example
agents.json                   # ANP discovery doc
```

## Spec changes

A change to the wire format is any change that alters the JSON shape an
existing client would observe. That includes renaming, retyping, or removing
a field, tightening validation, or changing the semantics of an existing
field. New optional fields are not breaking.

Every wire-format change MUST come in a single PR that updates all three:

1. `HUMANCARD_SPEC_VERSION` in `src/generator.ts` (semver per
   [SPEC.md §Versioning](./SPEC.md#versioning)).
2. `humancard.spec.json` (JSON Schema).
3. `SPEC.md` — including a dated changelog entry at the bottom describing
   the change and migration path.

CI will reject mismatches between the constant, the schema, and the spec
once the linter is in place.

## Code style

- TypeScript strict mode, including `exactOptionalPropertyTypes`.
- No `any`. If you genuinely need an escape hatch, use `unknown` and narrow
  with Zod at the boundary.
- JSDoc on every exported symbol. The types file IS part of the spec — its
  comments are read by implementers.
- Zod for every cross-process JSON boundary. Static and runtime validation
  are derived from the same schema so they cannot drift.
- No `console.log`. Use the structured logger in `src/shared/logger.ts`.
- No emoji in source, docs, or commits.

## Tests

`npm run build` is the gate today — strict TypeScript catches the bulk of
shape regressions. A test framework proposal (vitest is the obvious
default) is welcome; please open an issue first to align on conventions
before adding the dependency.

Manual verification for spec-affecting PRs:

```sh
npm run build
npm run generate:card | jq .capabilities.extensions
node -e "JSON.parse(require('fs').readFileSync('humancard.spec.json'))"
```

## Open governance

- Substantive spec changes require a PR with at least one non-author
  approving review.
- Implementation-only changes (bug fixes, perf, docs) can be merged with
  a single approving review or by the author after a 48-hour cooling
  window if no objections.
- Reference implementations in other languages (Go, Rust, Python, Elixir,
  Ruby — pick one) are explicitly encouraged. Open an issue to claim a
  language; we'll link it from the README once it passes a basic
  conformance check.

## Code of conduct

Be kind. Disagree about technical decisions, never about people. No
harassment, dog-whistling, or bad-faith argument. If you experience or
witness behavior that crosses that line, escalate to the maintainer email
listed in `package.json`. Maintainers act on reports privately and quickly.
