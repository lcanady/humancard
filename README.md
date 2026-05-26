# humancard

The open standard for human-representative Agent Cards.

humancard treats a person the same way A2A treats an agent: as a discoverable,
queryable endpoint advertising a stable identity, a capability surface, and a
machine-readable preference set. The Agent Card IS the resume. Agentic hiring
pipelines (or anything else that needs to reason about a candidate) talk to a
person's beacon over MCP and A2A instead of scraping a PDF.

This repo is the v0.1 reference implementation: a TypeScript Beacon (the
public-facing server), a Hunter (the private signal monitor that consumes
other people's beacons), and an on-chain identity layer (Solidity
contracts on Base anchoring third-party attestations to the candidate's
DID).

## How it works

**Beacon.** A small Node service that publishes an A2A v0.3 Agent Card at
`/.well-known/agent-card.json`, attaches the rich `humancard` payload via the
A2A `capabilities.extensions[]` mechanism, exposes five `humancard_*` MCP
tools over a Streamable HTTP transport at `/mcp`, and speaks A2A JSON-RPC at
`/a2a`. Identity is optionally bound to a `did:wba` document at
`/.well-known/did.json`. Premium tools may be gated behind x402 micropayments
when an EVM payout address is configured.

**Hunter.** A private cron-driven companion that pulls job listings and
company signals from public sources (Himalayas MCP, HN "Who's Hiring" via
Algolia, ATS boards on Greenhouse/Lever/Ashby, TechCrunch + SEC EDGAR for
funding signals), runs them through the same scoring engine the Beacon
exposes via MCP, paginates the top matches across multiple webhook posts,
and — for each funding signal — uses Claude to generate scored project
**leads** the candidate could build, prototype, or pitch into the funded
company. Hunter never publishes anything; it is the candidate-side reader
of other people's beacons (and of the noisy non-beacon job market).

**On-chain identity layer.** Solidity contracts on Base that anchor
third-party verifiable claims to the candidate's DID via the Ethereum
Attestation Service. Past employers, colleagues, and clients sign
attestations; the candidate retains a permanent, cryptographically
verifiable record of their professional history. See
[`docs/onchain.md`](./docs/onchain.md) for the contract surface and SDK.

## Quickstart

### Deploy your beacon

```sh
git clone https://github.com/lcanady/humancard.git
cd humancard
$EDITOR profile.json          # your identity, experience, stack, preferences
npm install
npm run build
npm run start:beacon
```

The beacon listens on `PORT` (default `3000`). Once it's behind your domain,
the canonical discovery URL is:

```
https://your-domain.example/.well-known/agent-card.json
```

The legacy A2A path `/.well-known/agent.json` is also served for older
clients.

### Generate a static card

If you don't want to run a live server, you can emit a snapshot of the card
to stdout and host it as a static file:

```sh
npm run generate:card > agent-card.json
```

The output is byte-stable for a given `profile.json` — diff-friendly for PR
review of personal data changes.

### Query someone else's beacon

Pure HTTP, no client library required:

```sh
curl https://lemcanady.com/.well-known/agent-card.json | jq .
```

Or via MCP, using any client SDK (TypeScript shown):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://lemcanady.com/mcp"),
);
const client = new Client({ name: "my-recruiter", version: "0.1.0" });
await client.connect(transport);

const result = await client.callTool({
  name: "humancard_get_profile",
  arguments: { response_format: "json" },
});
console.log(result.structuredContent);
```

## Architecture

```
                  ┌──────────────────────────────────────────┐
                  │                  Beacon                  │
                  │  (public, you operate one for yourself)  │
                  ├──────────────────────────────────────────┤
                  │                                          │
   /.well-known/  │  agent-card.json   ◀── A2A v0.3 + ext    │
                  │  did.json          ◀── did:wba doc       │
                  │                                          │
        /mcp      │  StreamableHTTP    ◀── 5 humancard_* tools
        /a2a      │  JSON-RPC          ◀── A2A protocol      │
                  │                                          │
                  └─────────────┬────────────────────────────┘
                            ▲   │            ▲
                            │   │ reads      │
                            │   ▼            │ MCP / A2A
                  ┌─────────┴───────────┐    │
                  │   On-chain layer    │    │
                  │   (Base Sepolia)    │    │
                  │  HumancardAttestor  │    │
                  │  + EAS              │    │
                  └─────────────────────┘    │
                            ▲                │
                            │ signs          │
                  ┌─────────┴────────┐  ┌────┴─────────────────┐
                  │   Other agents   │  │       Hunter         │
                  │  (recruiters,    │  │  (private companion, │
                  │   matchers, ANP  │  │  scores jobs, ideates │
                  │   crawlers,      │  │  off funding signals,│
                  │   attestors)     │  │  posts to webhook)   │
                  └──────────────────┘  └──────────────────────┘
```

## The five MCP tools

Every conformant beacon MUST expose these five tools when MCP is offered. The
first four are free; `humancard_score_opportunity` MAY be x402-gated when
`X402_PAY_TO` is configured.

| Tool | Description | Gated |
|---|---|---|
| `humancard_get_profile` | Returns the full validated candidate profile (identity, experience, stack, preferences, scoring weights). | free |
| `humancard_get_card` | Returns the live A2A v0.3 Agent Card, including the humancard extension payload. | free |
| `humancard_list_skills` | Returns A2A skill cards plus tier1/tier2 stack with depth tags. | free |
| `humancard_check_dealbreakers` | Deterministically scans a job description for the candidate's dealbreaker phrases. | free |
| `humancard_score_opportunity` | Claude-backed weighted scoring of a job description against the candidate's criteria; returns a 0–100 score, per-criterion breakdown, and a pursue/consider/skip recommendation. | x402 when `X402_PAY_TO` is set |

All tools accept a `response_format` argument (`"json"` or `"markdown"`).

## Configuration

Every environment variable consumed by the beacon, hunter, identity, and
logger subsystems is documented in [`.env.example`](./.env.example). Quick
reference:

- `PORT`, `BEACON_BASE_URL`, `ALLOWED_HOSTS` — beacon HTTP transport.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — Claude credentials for scoring (default: Haiku 4.5).
- `X402_PAY_TO`, `X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_SCORE_PRICE` — premium tool gating.
- `DIDWBA_PRIVATE_KEY_HEX` — Ed25519 key for the beacon's did:wba identity.
- `HUNTER_CRON_SCHEDULE`, `HUNTER_KEYWORDS`, `HUNTER_ATS_BOARDS`, `HUNTER_STATE_FILE`, `WEBHOOK_URL` — hunter loop.
- `HUNTER_ALLOW_INSECURE_WEBHOOK` — DEV-ONLY escape hatch for the SSRF guard.
- `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `DEPLOYER_ADDRESS` — on-chain signing for the attestation layer (testnet).
- `HUMANCARD_ATTESTOR_ADDRESS`, `HUMANCARD_SCHEMA_UID`, `EAS_ADDRESS`, `SCHEMA_REGISTRY_ADDRESS` — deployed contract references.
- `LOG_LEVEL` — logger verbosity.

## The humancard extension

A2A v0.3 forbids top-level custom fields on an Agent Card; instead it offers
a sanctioned extension mechanism — `capabilities.extensions[]`, each entry
identified by a stable URI. humancard claims the URI:

```
https://humancard.dev/ext/v1
```

The `params` field of that extension carries the rich payload: `identity`,
`experience`, `stack`, `preferences`, `scoringWeights`, plus `specVersion`.
Clients that don't recognize the URI ignore the extension and still receive a
valid, useful A2A card.

The full wire format is defined in [`SPEC.md`](./SPEC.md) and the JSON Schema
lives in [`humancard.spec.json`](./humancard.spec.json).

## Security & testing

The beacon is hardened for unauthenticated public exposure:

- **Helmet** sets HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and
  `Referrer-Policy` on every response.
- **Rate limiting** — 60 req / IP / min on both `/mcp` and `/a2a`.
- **Body limit** — JSON payloads capped at 64 KB; job-description inputs to
  scoring tools capped at 8 KB at the Zod-schema layer.
- **CORS** — explicit allowlist via `BEACON_CORS_ORIGINS` (comma-separated).
  Wildcard is never used.
- **SSRF guard** on Hunter's webhook target: `https://` only, no loopback,
  RFC1918, link-local, or cloud-metadata hosts.
- **Error redaction** — every wire-facing error is funneled through
  `toPublicError` which collapses unknown failures to opaque `INTERNAL`.

Regression suite lives in [`tests/security/`](./tests/security/) and runs on
every push via [`.github/workflows/ci.yml`](./.github/workflows/ci.yml), which
also runs `npm audit --audit-level=high`.

```sh
npm test        # vitest run
npm audit       # dependency vulns
```

Reporting policy: see [`SECURITY.md`](./SECURITY.md).

## Status

- **Phase 1 (foundation):** done — types, profile loader, generator, static
  card CLI.
- **Phase 2 (beacon):** done — Express server, MCP transport, A2A transport,
  did:wba identity, x402 middleware, scoring engine, security hardening.
- **Phase 3 (hunter):** done — Himalayas MCP, Algolia HN search, ATS
  (Greenhouse/Lever/Ashby), TechCrunch + SEC EDGAR funding signals,
  keyword filtering, dedup state, scoring loop, paginated webhook
  delivery, and a Claude-backed **Ideator** that turns each funding
  signal into scored project leads.
- **Phase 4 (on-chain):** in progress — HumancardAttestor (EAS-backed
  credential attestations) deployed on Base Sepolia. Soulbound reputation
  NFT, token-gated tiers, and recruiter staking are the next milestones.

### Live deployments

| Contract | Address | Chain |
|---|---|---|
| HumancardAttestor | [`0xAA7f...0238`](https://sepolia.basescan.org/address/0xAA7fbE3A5a7d4c2C75F8B6aB3e72797937860238) | Base Sepolia (84532) |
| EAS (predeploy) | `0x4200...0021` | Base Sepolia |
| SchemaRegistry (predeploy) | `0x4200...0020` | Base Sepolia |

Schema UID: `0x7543b38f17b9438f5d619a5599670d783efeadb718c3f4dc9360bc81e0ee9f9b`

This is **v0.1 of the protocol**. The shape will change. Implementers in
other languages are welcome and encouraged — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for governance.

## License

MIT — see [`LICENSE`](./LICENSE).
