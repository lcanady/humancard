# humancard Specification v0.1

## Status

**Draft.** This document defines wire format v0.1 of the humancard
extension to the A2A Agent Card protocol. The reference implementation is
the [`humancard`](https://www.npmjs.com/package/humancard) npm package in
this repository. Breaking changes to the wire format bump
`HUMANCARD_SPEC_VERSION` (see `src/generator.ts`) and update this document.

## Goals & non-goals

### Goals

- Make a human candidate addressable by agentic systems the same way A2A
  agents are: discoverable URL, capability surface, queryable tool set.
- Layer cleanly on top of A2A v0.3 — no fork, no replacement. A conformant
  A2A client that has never heard of humancard MUST still get a valid,
  useful Agent Card.
- Preserve operator control: candidates run their own beacon at their own
  domain, with their own identity material, optionally monetizing premium
  tools.
- Define a wire format precise enough that a non-Node implementation can be
  written from this spec alone.

### Non-goals

- A central registry. Discovery is DNS plus `.well-known/`. There is no
  humancard.dev directory of people.
- A standardized resume taxonomy. Skill names are free-form strings; the
  spec defines structure, not vocabulary.
- A matching algorithm. Scoring is implementation-defined; the spec only
  defines the inputs (weighted criteria) and the output schema of
  `humancard_score_opportunity`.

## Conformance requirements

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted
as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A conformant **humancard beacon**:

1. MUST emit a valid A2A v0.3 Agent Card at the discovery URL defined in
   [§A2A integration](#a2a-integration).
2. MUST attach the humancard payload as an entry in
   `capabilities.extensions[]` whose `uri` is exactly
   `https://humancard.dev/ext/v1`.
3. The extension's `params` object MUST conform to the
   `HumancardExtensionParams` schema in [§The humancard extension payload](#the-humancard-extension-payload).
4. If MCP is offered, the beacon MUST register all five tools defined in
   [§Required MCP tools](#required-mcp-tools).
5. The beacon SHOULD include the candidate's tier-1 stack as discrete A2A
   skills (see [§Required A2A skills](#required-a2a-skills)).
6. If `did:wba` is used, the beacon MUST follow [§Identity (DID-WBA)](#identity-did-wba).
7. Free tools MUST remain free. Premium gating (x402) is permitted only on
   `humancard_score_opportunity` and any implementation-defined extra
   tools.

## A2A integration

humancard does not modify the A2A protocol. It uses two A2A-sanctioned
extension points:

1. **`capabilities.extensions[]`** — for the rich payload.
2. **`skills[]`** — for the tier-1 stack as discrete skills.

### Discovery

A conformant beacon MUST serve its Agent Card at:

- `/.well-known/agent-card.json` — canonical (A2A v0.3).

A beacon SHOULD also serve:

- `/.well-known/agent.json` — legacy alias for older A2A clients.

Both endpoints MUST return identical JSON (or HTTP 308 from the legacy path
to the canonical path).

### Transports

A2A v0.3 supports `JSONRPC`, `HTTP+JSON`, and `GRPC`. The reference beacon
emits `preferredTransport: "JSONRPC"` at `/a2a` and advertises an MCP
transport at `/mcp` via `additionalInterfaces` with `transport: "HTTP+JSON"`.

### Versioning fields

- `protocolVersion` on the card MUST be the A2A version
  (`"0.3.0"` for this spec).
- `version` on the card is the deployed agent instance's semver — orthogonal
  to both A2A and humancard versioning.
- `specVersion` inside the humancard extension `params` is the humancard
  wire format version (`"0.1.0"` for this spec).

## The humancard extension payload

URI: `https://humancard.dev/ext/v1`

The complete schema in JSON Schema form is
[`humancard.spec.json`](./humancard.spec.json). Below is the field-by-field
contract.

### `HumancardExtensionParams`

| Field | Type | Required | Description |
|---|---|---|---|
| `specVersion` | string (semver) | yes | Wire format version. `"0.1.0"` for this spec. |
| `identity` | object | yes | Identity block — see below. |
| `experience` | object | yes | Career block — see below. |
| `stack` | object | yes | Tiered tech-stack inventory. |
| `preferences` | object | yes | What kinds of opportunities are interesting. |
| `scoringWeights` | object (string → number) | yes | Weighted criteria. Sum SHOULD be 100. |

### `identity`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name. |
| `handle` | string | yes | Stable handle (no `@` prefix). |
| `title` | string | yes | Self-described role/title. |
| `location` | string | yes | Free-form city/region. |
| `workMode` | string | yes | Conventionally `"remote-first"`, `"hybrid"`, `"on-site"`. |
| `relocate` | string | yes | Conventionally `"open"`, `"no"`, `"sweet-deal-only"`. |
| `availability` | string | yes | Conventionally `"immediately"`, `"YYYY-Qn"`, `"not-looking"`. |
| `links` | object (string → URL string) | yes | Public profile links keyed by platform (e.g. `"github"`, `"linkedin"`). |
| `summary` | string | yes | Long-form bio paragraph. |

### `experience`

| Field | Type | Required | Description |
|---|---|---|---|
| `years` | number (integer ≥ 0) | yes | Years of professional experience. |
| `degree` | boolean | yes | Holds a formal CS-or-equivalent degree. |
| `roles` | array of `HumancardRole` | yes | Roles held (see below). |
| `projects` | array of `HumancardProject` | yes | Notable projects (see below). |
| `origin` | string | no | Free-form origin/early-career narrative. |

### `HumancardRole`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Role title. |
| `company` | string | yes | Hiring entity. |
| `url` | URL string | no | Link to the company or role. |
| `current` | boolean | yes | Whether this is the present role. |
| `start` | string | no | ISO date or `YYYY-MM`. |
| `end` | string | no | ISO date or `YYYY-MM`. Omitted when `current` is true. |
| `highlights` | array of string | yes | Bullet-point achievements (may be empty). |

### `HumancardProject`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Project name. |
| `description` | string | yes | One-line description. |
| `url` | URL string | no | Public link (typically GitHub). |
| `highlight` | boolean | no | Surface prominently in summaries. |

### `stack`

All fields are arrays of strings. All are required (may be empty).

| Field | Description |
|---|---|
| `tier1` | Strongest, daily-use technologies. |
| `tier2` | Strong working knowledge. |
| `tier3` | Familiar / emerging interests. |
| `languages` | Programming languages. |
| `infra` | Infrastructure technologies (general). |
| `crypto` | Crypto/Web3-specific stack, distinct from `infra`. |
| `frameworks` | Frameworks/libraries. |
| `tools` | Tooling (editors, CI, etc.). |

### `preferences`

| Field | Type | Required | Description |
|---|---|---|---|
| `salaryFloorUsd` | number | yes | Minimum acceptable annual base in USD. |
| `equity` | boolean | yes | Whether equity is required. |
| `roles` | array of string | yes | Acceptable role titles (loose match). |
| `sectors` | array of string | yes | Acceptable industry sectors. |
| `dealbreakers` | array of string | yes | Hard-no phrases. Any match disqualifies. |

### `scoringWeights`

A `Record<string, number>`. Keys are criterion names; values are integer
weights. The sum SHOULD be 100. The reference engine multiplies each weight
by an awarded fraction in `[0, 1]` to produce a 0–100 total.

## Required MCP tools

If MCP is offered, the following five tools MUST be registered. Tool names
are case-sensitive. Implementations MAY register additional tools.

Every tool accepts an optional `response_format` argument: `"json"` (default)
or `"markdown"`. The text content of the MCP result MUST reflect the
requested format; the `structuredContent` is always JSON.

### `humancard_get_profile`

- **Input:** `{ response_format?: "json" | "markdown" }`
- **Output:** `{ profile: <full RawProfile>, response_format: "json" | "markdown" }`

### `humancard_get_card`

- **Input:** `{ response_format?: "json" | "markdown" }`
- **Output:** `{ card: <full AgentCard>, response_format: "json" | "markdown" }`

### `humancard_list_skills`

- **Input:** `{ response_format?: "json" | "markdown" }`
- **Output:** `{ skills: AgentSkill[], tier1: string[], tier2: string[], response_format: "json" | "markdown" }`

### `humancard_check_dealbreakers`

- **Input:** `{ job_description: string, response_format?: "json" | "markdown" }`
- **Output:** `{ passed: boolean, hits: string[], response_format: "json" | "markdown" }`
- **Semantics:** Deterministic substring/phrase scan against
  `preferences.dealbreakers`. No LLM. MUST NOT make network calls.

### `humancard_score_opportunity`

- **Input:** `{ job_description: string, response_format?: "json" | "markdown" }`
- **Output:**
  ```ts
  {
    totalScore: number,                     // 0..100
    breakdown: Record<string, {
      weight: number,                       // from scoringWeights
      awarded: number,                      // [0, 1]
      reason: string,
    }>,
    recommendation: "pursue" | "consider" | "skip",
    summary: string,
    response_format: "json" | "markdown",
  }
  ```
- **Semantics:** Implementation-defined scoring. The reference impl uses
  Claude. This tool MAY be x402-gated.

The exact runtime Zod schemas are in
`src/beacon/mcp-server.ts`. Other-language implementations MUST emit JSON
that round-trips against equivalent schemas.

## Required A2A skills

The beacon's A2A `skills[]` array MUST include each `stack.tier1` entry as a
discrete `AgentSkill`. The reference impl produces:

```json
{
  "id": "<slug-of-entry>",
  "name": "<entry>",
  "description": "Tier-1 (daily-use) capability: <entry>.",
  "tags": ["<entry>", "...inferred"]
}
```

Tier-2 entries MAY be aggregated into a single skill with id
`adjacent-strengths` whose `tags` is the full tier-2 list. Tier-3 entries
SHOULD NOT appear as A2A skills (they live in the extension payload).

## Identity (DID-WBA)

A beacon MAY identify itself with a `did:wba` (Web-Bound Agent) DID
document, served at `/.well-known/did.json`. When present:

- The DID document MUST contain at least one `Ed25519VerificationKey2020`
  (or equivalent) verification method.
- HTTP signatures over A2A requests MUST conform to
  [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) (HTTP Message
  Signatures).
- The Agent Card SHOULD declare a `securitySchemes` entry named `didwba`
  referencing the DID document URL.
- `agent/getAuthenticatedExtendedCard` MUST require a valid signed request
  before returning fields the operator has marked sensitive.

The reference implementation lives at `src/beacon/anp-identity.ts` and
follows the [ANP](https://github.com/agent-network-protocol/AgentNetworkProtocol)
identity profile.

## Premium tools (x402)

A beacon MAY gate `humancard_score_opportunity` (or any custom premium
tool) behind [x402](https://www.x402.org/) micropayments. Free tools — the
first four — MUST remain free.

When `X402_PAY_TO` (or the equivalent operator setting) is unset, all tools
MUST be served free. When set:

- The beacon advertises the price (e.g. `"$0.01"`) and network (CAIP-2,
  e.g. `eip155:84532`) per the x402 spec.
- Unpaid calls receive HTTP 402 with the x402 challenge headers.
- A facilitator URL (default `https://x402.org/facilitator`) verifies and
  settles.

## Versioning

`specVersion` follows [semver](https://semver.org/):

- **Major bump** — any breaking change to a required field's name, type,
  or semantics.
- **Minor bump** — new optional fields, new tools, new tool inputs that
  default safely.
- **Patch bump** — clarifications, documentation, non-semantic fixes.

Implementations SHOULD reject payloads whose `specVersion` major exceeds
their own.

## Security considerations

- The public Agent Card is, by definition, public. Operators MUST NOT put
  data there they wouldn't put on a homepage.
- For sensitive material (private contact info, salary specifics,
  pre-arranged dealbreakers), use the authenticated extended card flow
  (`supportsAuthenticatedExtendedCard: true` plus a did:wba challenge).
- `humancard_score_opportunity` invokes an LLM on caller-supplied text.
  Implementations MUST treat the job description as untrusted input — no
  prompt-injection-driven exfiltration of profile fields beyond what
  `humancard_get_profile` already returns publicly.
- Dealbreaker matching is deterministic by design — it MUST NOT use an LLM
  in the conformant path, so it cannot be socially engineered around.

## References

- [A2A v0.3 Specification](https://a2a-protocol.org/latest/specification/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)
- [RFC 2119 — Key words for use in RFCs](https://www.rfc-editor.org/rfc/rfc2119)
- [x402 — HTTP 402 micropayments](https://www.x402.org/)
- [did:wba method](https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [Agent Network Protocol (ANP)](https://github.com/agent-network-protocol/AgentNetworkProtocol)
