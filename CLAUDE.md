# humancard — project guide for Claude Code

Open standard for human-representative Agent Cards. Two surfaces:

- **Beacon** — MCP Streamable HTTP + A2A JSON-RPC/SSE server. Publishes the
  candidate's Agent Card, exposes tools (`humancard_score_opportunity` is the
  premium one, x402-gated), serves did:wba identity, x402 payments.
- **Hunter** — cron-driven loop. Fans out across job-signal sources, dedupes,
  filters by dealbreakers, scores via Claude, dispatches webhook alerts for
  both scored jobs and company-level funding signals.

The Agent Card IS the resume.

## Commit / authorship policy

**No AI attribution anywhere.** When committing in this repo:

- **Do not** append `Co-Authored-By: Claude ...` trailers.
- **Do not** add `🤖 Generated with Claude Code` lines or similar footers.
- **Do not** mention AI assistance in commit messages, code comments, or docs.

This project is published under the author's name (Lemuel Canady). Attribution
to AI tooling undermines the positioning. If a Claude Code skill or template
auto-injects an attribution trailer, strip it before finalizing the commit.

## Stack (locked)

- Node 20+, TypeScript (strict), Express 5
- MCP Streamable HTTP transport, A2A JSON-RPC + SSE
- Zod at every cross-process JSON boundary (config, profile, tools, sources)
- Anthropic SDK for scoring — defaults to Haiku 4.5 for cost
- x402 payments on Base (Sepolia for dev, mainnet for prod)
- did:wba identity (Ed25519 via @noble)
- vitest for tests; tsc for build

## Layout

```
src/
  beacon/      Beacon HTTP server, config, x402 gating, identity
  hunter/      Orchestrator + sources + alert dispatch
    sources/   himalayas, hn-rss (Algolia), ats (Greenhouse/Lever), crunchbase
  scoring/     Dealbreaker scan + Claude-backed weighted scorer
  cli/         generate-card and friends
  shared/      Cross-cutting types (JobRaw, CompanySignal), logger
profile.json   Candidate profile — preferences, weights, dealbreakers
SPEC.md        humancard specification
```

## Hunter behavior

One cycle = fetch all sources in parallel → dedupe by `source:externalId` →
drop jobs that match `profile.preferences.dealbreakers` (substring) → score
the rest with Claude → keep `score >= 40` (SCORE_FLOOR) → sort → POST top N
to webhook. Funding signals get a parallel webhook of their own.

Score tiers: `>= 70` pursue, `>= 40` consider, else skip.

## Dev defaults

- `npm run build` → `tsc`
- `npm run start:hunter` → daemon (one immediate cycle, then cron)
- `HUNTER_ALLOW_INSECURE_WEBHOOK=true` is a DEV-ONLY escape hatch for the
  SSRF guard in `src/hunter/alert.ts`. Never enable in production.
- `.env.example` is the canonical config surface. Keep it in sync when adding
  env vars; values in `.env` are gitignored.

## Things worth knowing

- Greenhouse boards return *every* open role (Anthropic ~ 400). The ATS source
  applies a keyword pre-filter and a per-board cap so scoring costs stay sane.
- HN comments without `Company | Role | ...` shape are dropped — they're
  replies, not job posts.
- `lever:openai` and `lever:huggingface` 404. Those orgs aren't on Lever
  (Ashby or other ATS). Update `HUNTER_ATS_BOARDS` accordingly.
- The dedup state file (`.hunter-state.json`) carries `source:externalId →
  ISO timestamp` and suppresses anything within `DEDUP_WINDOW_MS` (24h).
