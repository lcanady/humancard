# Security policy

## Reporting a vulnerability

Email **lem@dailycaller.com** with a clear reproduction. Please do not open a
public GitHub issue for anything that could be weaponized against a running
beacon. You will get an acknowledgement within 72 hours.

If the issue affects the on-the-wire `humancard` extension format (i.e. the
protocol itself, not just this reference implementation), say so — those
findings drive `SPEC.md` revisions and get cross-posted to other implementers.

## Supported versions

The protocol is at **v0.1**. Only the current `main` branch of this reference
implementation is patched. There is no LTS — operators are expected to track
`main` and rebuild from source.

## Hardening baseline

Every release of the reference beacon must satisfy:

| Control | Where |
|---|---|
| Helmet headers on all responses | `src/beacon/server.ts` |
| Per-IP rate limit on `/mcp` and `/a2a` | `src/beacon/server.ts` |
| JSON body cap (64 KB) | `src/beacon/server.ts` |
| Zod max-length on every user-string input | `src/beacon/mcp-server.ts`, `src/beacon/a2a-server.ts` |
| Explicit (non-wildcard) CORS allowlist | `src/beacon/server.ts` |
| SSRF guard on outbound webhook URLs | `src/hunter/alert.ts` |
| Wire errors funnel through `toPublicError` | `src/beacon/errors.ts` |
| `npm audit --audit-level=high` clean | CI |
| `gitleaks` clean | CI / local |

Regression tests for each of the controls above live in
[`tests/security/`](./tests/security/). A removed control without a matching
test deletion is a CI failure.

## Threat model (in scope)

- Anonymous internet callers hitting `/mcp`, `/a2a`, `/.well-known/*`, and
  `/healthz`.
- Operator-supplied configuration that may be slightly wrong (typo'd URLs,
  missing env vars).
- Compromised or malicious upstream LLM responses.

## Threat model (out of scope)

- Compromise of the operator's machine, environment, or API keys.
- Compromise of upstream registries (`npm`, GitHub) — mitigated separately by
  pinning Actions to SHAs and running `npm audit` on every CI run.
- Quantum-future attacks on `did:wba` Ed25519 identities.
