# On-chain identity layer

Solidity contracts on Base that anchor third-party verifiable claims to
a humancard candidate's DID. Past employers, colleagues, clients, and
collaborators sign attestations through the Ethereum Attestation Service
(EAS); the candidate retains a permanent, cryptographically verifiable
record of their professional history that any agent or human can
independently audit on-chain.

This is **Phase 4** of humancard. The Beacon (Phase 2) and Hunter
(Phase 3) reason over self-asserted profile data; the on-chain layer
adds *external* assertions with the same machine-readable shape.

## Architecture

```
   Past employer / colleague / client
                │
                │ signs an attestation
                ▼
   ┌──────────────────────────────────┐
   │      HumancardAttestor.sol       │ ◀── humancard wrapper:
   │  (this repo, deployed on Base)   │     adds DID-keyed events and
   │                                  │     per-attestation authorization
   └──────────────┬───────────────────┘
                  │ delegates to
                  ▼
   ┌──────────────────────────────────┐
   │             EAS                  │ ◀── canonical attestation store
   │  (Ethereum Attestation Service)  │     (events, view, revocation)
   └──────────────────────────────────┘
```

The wrapper exists so that humancard can:

- Emit a `HumancardAttestationCreated` event with the subject DID hash
  indexed, so off-chain indexers can subscribe by candidate.
- Enforce that only the original humancard-level attestor can revoke
  (EAS sees the wrapper as the attester and would otherwise let anyone
  call through).
- Validate non-empty subject / claim type and a sane validity window at
  the wrapper boundary, before paying EAS gas.

## Schema

Registered once in EAS's `SchemaRegistry`. The resulting UID is wired
into the deployed wrapper as an immutable.

```
string subjectDid       full humancard DID URI, e.g. did:wba:lcanady
string claimType        taxonomy bucket: employment, skill, endorsement, education, project
string claimData        free-form claim payload (JSON or markdown)
string evidenceUri      IPFS or HTTPS URL with supporting evidence
uint64 validFrom        unix seconds the claim becomes valid
uint64 validUntil       unix seconds the claim expires (0 = open-ended)
```

`claimType` is a small enum-like surface so off-chain indexers can
build a `(subject, claimType) → attestation[]` view efficiently.

## Live deployments

| Network | Contract | Address |
|---|---|---|
| Base Sepolia (84532) | HumancardAttestor | [`0xAA7fbE3A5a7d4c2C75F8B6aB3e72797937860238`](https://sepolia.basescan.org/address/0xAA7fbE3A5a7d4c2C75F8B6aB3e72797937860238) |
| Base Sepolia | EAS (predeploy) | `0x4200000000000000000000000000000000000021` |
| Base Sepolia | SchemaRegistry (predeploy) | `0x4200000000000000000000000000000000000020` |

Schema UID:
`0x7543b38f17b9438f5d619a5599670d783efeadb718c3f4dc9360bc81e0ee9f9b`

## Reading attestations

The Beacon and Hunter both consume the TypeScript SDK in
[`src/onchain/attestor.ts`](../src/onchain/attestor.ts). Construct a
read-only client by omitting the private key:

```ts
import { createHumancardAttestorClient } from "humancard/onchain";

const client = createHumancardAttestorClient({
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL!,
  attestorAddress: process.env.HUMANCARD_ATTESTOR_ADDRESS! as `0x${string}`,
  easAddress: process.env.EAS_ADDRESS! as `0x${string}`,
});

const record = await client.getAttestation("0x..." as `0x${string}`);
if (record !== null) {
  console.log(record.claim.claimType, record.claim.claimData);
  console.log("Attested by", record.humancardAttestor);
  if (record.revocationTime > 0n) console.log("(revoked)");
}
```

Each record carries:

- `claim` — the decoded humancard payload (subject DID, claim type, data,
  evidence URI, validity window).
- `humancardAttestor` — the real human/org address that originally
  attested. (`easAttester` is always the wrapper contract.)
- `time`, `expirationTime`, `revocationTime` — EAS bookkeeping.
- `revocable` — always `true` for v1.

Off-chain indexing is via the `HumancardAttestationCreated` event,
indexed on `subjectDidHash` (keccak256 of the DID URI), `attestor`, and
`uid`. Build a subject → attestations map by filtering on
`subjectDidHash = keccak256(<candidate DID>)`.

## Writing attestations

A signing-capable client is the same shape with a `privateKey` field.
Anyone with a funded address on the target chain can attest about
anyone — humancard does not gate the write side. The trust model
relies on attestor reputation (who they are, what they've previously
signed), surfaced in the off-chain indexer.

```ts
const writer = createHumancardAttestorClient({
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL!,
  attestorAddress: process.env.HUMANCARD_ATTESTOR_ADDRESS! as `0x${string}`,
  easAddress: process.env.EAS_ADDRESS! as `0x${string}`,
  privateKey: process.env.DEPLOYER_PRIVATE_KEY! as `0x${string}`,
});

const { uid, txHash } = await writer.attest({
  subjectDid: "did:wba:lcanady",
  claimType: "employment",
  claimData: "Lead Blockchain Developer, 2022-04 to 2024-12",
  evidenceUri: "ipfs://Qm...",
  validFrom: 1648771200n,
  validUntil: 1735603200n,
});
```

`validFrom` defaults to "now" and `validUntil` defaults to `0n`
(open-ended) when omitted.

## Revoking

Only the original humancard-level attestor (the address that signed the
`attest` tx) may revoke:

```ts
await writer.revoke(uid);
```

Revoked attestations remain on-chain forever; the record's
`revocationTime` becomes non-zero, and downstream consumers SHOULD treat
those records as historical-only rather than current.

## Local development

```sh
cd contracts
forge install --no-git foundry-rs/forge-std
forge install --no-git ethereum-attestation-service/eas-contracts
forge install --no-git OpenZeppelin/openzeppelin-contracts
forge build
forge test -vvv
```

`lib/` is gitignored — re-run `forge install` after cloning. 8/8
Foundry tests cover the happy path, argument validation, abi-encode
round-trip, and revoke authorization.

## Deploying

Defaults target Base Sepolia. The deploy script reads
`EAS_ADDRESS` / `SCHEMA_REGISTRY_ADDRESS` from env if set, otherwise
falls back to the Base/Base-Sepolia predeploy addresses.

```sh
cd contracts
forge script script/DeployAttestor.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

The script registers the humancard schema (one-time) and deploys the
wrapper bound to the resulting UID. Both addresses + the schema UID
are printed at the end; copy them into your `.env` as
`HUMANCARD_ATTESTOR_ADDRESS` / `HUMANCARD_SCHEMA_UID`.

> **Note:** `SchemaRegistry.register()` reverts on a duplicate schema
> string. If you re-deploy on a chain where the schema is already
> registered, fetch the existing UID first rather than re-registering.
> A follow-up will make the deploy script idempotent.

## Roadmap

The attestation layer is **Feature 1 of 4** in the on-chain plan:

1. ✅ On-chain credential attestations (this doc)
2. ⏳ Soulbound reputation NFT — non-transferable ERC-721 aggregating
   attestations into a single identity artifact bound to the
   candidate's DID.
3. ⏳ Token-gated access tiers — gate premium MCP tools (and Hunter
   endorsement visibility) by ERC-20 / NFT holdings, beyond the
   per-call x402 micropayment.
4. ⏳ Staking for signal quality — recruiters lock tokens to surface
   opportunities; slashing logic for spam or misrepresentation creates
   skin-in-the-game filtering on the inbound side.
