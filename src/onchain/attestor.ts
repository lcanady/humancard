/**
 * TypeScript SDK for the HumancardAttestor contract.
 *
 * Wraps viem's public + wallet clients with a domain-specific surface:
 * encode the humancard claim payload, call attest/revoke, decode
 * results, and expose strongly-typed events. Beacon (read-only) and
 * Hunter (read+write) both consume this.
 *
 * No on-chain state lives here — every call is a thin pass-through to
 * the deployed contracts. Configuration comes from {@link config}.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { logger } from "../shared/logger.js";

/**
 * Minimal ABI for HumancardAttestor. Hand-written rather than imported
 * from forge artifacts so the npm package isn't coupled to the Foundry
 * build output and so consumers don't pull megabytes of build noise.
 */
export const HUMANCARD_ATTESTOR_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "subjectDid", type: "string" },
      { name: "claimType", type: "string" },
      { name: "claimData", type: "string" },
      { name: "evidenceUri", type: "string" },
      { name: "validFrom", type: "uint64" },
      { name: "validUntil", type: "uint64" },
    ],
    outputs: [{ name: "uid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "attestorOf",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "SCHEMA_UID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "HumancardAttestationCreated",
    inputs: [
      { name: "subjectDidHash", type: "bytes32", indexed: true },
      { name: "attestor", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: true },
      { name: "claimType", type: "string", indexed: false },
      { name: "subjectDid", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "HumancardAttestationRevoked",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "attestor", type: "address", indexed: true },
    ],
  },
] as const;

/** Minimal IEAS surface — just the view we need to read attestation data. */
export const EAS_ABI = [
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** Decoded humancard claim payload, identical shape to the on-chain schema. */
export interface HumancardClaim {
  subjectDid: string;
  claimType: string;
  claimData: string;
  evidenceUri: string;
  validFrom: bigint;
  validUntil: bigint;
}

/** Full attestation record as returned by EAS, plus the decoded claim. */
export interface HumancardAttestationRecord {
  uid: Hex;
  schema: Hex;
  /** Unix-second timestamps. */
  time: bigint;
  expirationTime: bigint;
  /** Non-zero iff the attestation has been revoked. */
  revocationTime: bigint;
  refUID: Hex;
  /** EAS-level attester — the wrapper contract for humancard. */
  easAttester: Address;
  /** Original humancard attestor (real human, from attestorOf mapping). */
  humancardAttestor: Address;
  revocable: boolean;
  /** Decoded humancard claim payload. */
  claim: HumancardClaim;
}

/** Inputs accepted by {@link HumancardAttestorClient.attest}. */
export interface AttestInput {
  subjectDid: string;
  claimType: string;
  claimData: string;
  evidenceUri: string;
  /** Unix seconds. Defaults to now. */
  validFrom?: bigint;
  /** Unix seconds. 0n = open-ended. Defaults to 0n. */
  validUntil?: bigint;
}

/** Options for {@link createHumancardAttestorClient}. */
export interface HumancardAttestorClientOptions {
  /** RPC URL for the target chain (Base Sepolia by default). */
  rpcUrl: string;
  /** Deployed HumancardAttestor address. */
  attestorAddress: Address;
  /** Deployed EAS address (for read-only attestation lookups). */
  easAddress: Address;
  /** Optional signing key. Read-only client when omitted. */
  privateKey?: Hex;
}

/**
 * Typed client wrapping the HumancardAttestor contract. Read-only when
 * constructed without a private key; read+write when one is supplied.
 */
export class HumancardAttestorClient {
  public readonly publicClient;
  public readonly walletClient;
  public readonly account: Address | null;
  private readonly attestorAddress: Address;
  private readonly easAddress: Address;

  constructor(opts: HumancardAttestorClientOptions) {
    this.attestorAddress = opts.attestorAddress;
    this.easAddress = opts.easAddress;

    this.publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(opts.rpcUrl),
    });

    if (opts.privateKey !== undefined) {
      const account = privateKeyToAccount(opts.privateKey);
      this.walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(opts.rpcUrl),
      });
      this.account = account.address;
    } else {
      this.walletClient = null;
      this.account = null;
    }
  }

  /** True when the client can sign — i.e. was constructed with a private key. */
  canWrite(): boolean {
    return this.walletClient !== null;
  }

  /** Create a humancard attestation. Throws if the client is read-only. */
  async attest(input: AttestInput): Promise<{ txHash: Hash; uid: Hex }> {
    if (this.walletClient === null || this.account === null) {
      throw new Error("attest() requires a signing key — client is read-only");
    }
    const validFrom = input.validFrom ?? BigInt(Math.floor(Date.now() / 1000));
    const validUntil = input.validUntil ?? 0n;

    const { request, result } = await this.publicClient.simulateContract({
      address: this.attestorAddress,
      abi: HUMANCARD_ATTESTOR_ABI,
      functionName: "attest",
      args: [
        input.subjectDid,
        input.claimType,
        input.claimData,
        input.evidenceUri,
        validFrom,
        validUntil,
      ],
      account: this.account,
    });
    const txHash = await this.walletClient.writeContract(request);
    logger.info("attestor: attest tx submitted", {
      txHash,
      uid: result,
      subjectDid: input.subjectDid,
    });
    return { txHash, uid: result as Hex };
  }

  /** Revoke a previously created attestation. Throws if read-only. */
  async revoke(uid: Hex): Promise<Hash> {
    if (this.walletClient === null || this.account === null) {
      throw new Error("revoke() requires a signing key — client is read-only");
    }
    const { request } = await this.publicClient.simulateContract({
      address: this.attestorAddress,
      abi: HUMANCARD_ATTESTOR_ABI,
      functionName: "revoke",
      args: [uid],
      account: this.account,
    });
    return this.walletClient.writeContract(request);
  }

  /** Fetch the schema UID this attestor was wired to at deploy time. */
  async schemaUid(): Promise<Hex> {
    const uid = await this.publicClient.readContract({
      address: this.attestorAddress,
      abi: HUMANCARD_ATTESTOR_ABI,
      functionName: "SCHEMA_UID",
    });
    return uid as Hex;
  }

  /**
   * Read a full attestation record (EAS metadata + decoded humancard claim
   * + original humancard attestor). Returns null when the attestation
   * doesn't exist.
   */
  async getAttestation(uid: Hex): Promise<HumancardAttestationRecord | null> {
    const [att, humancardAttestor] = await Promise.all([
      this.publicClient.readContract({
        address: this.easAddress,
        abi: EAS_ABI,
        functionName: "getAttestation",
        args: [uid],
      }),
      this.publicClient.readContract({
        address: this.attestorAddress,
        abi: HUMANCARD_ATTESTOR_ABI,
        functionName: "attestorOf",
        args: [uid],
      }),
    ]);
    if ((att.uid as Hex) === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      return null;
    }
    const claim = decodeClaim(att.data as Hex);
    return {
      uid: att.uid as Hex,
      schema: att.schema as Hex,
      time: att.time,
      expirationTime: att.expirationTime,
      revocationTime: att.revocationTime,
      refUID: att.refUID as Hex,
      easAttester: att.attester as Address,
      humancardAttestor: humancardAttestor as Address,
      revocable: att.revocable,
      claim,
    };
  }
}

/** Convenience constructor matching the shape used by Beacon/Hunter. */
export function createHumancardAttestorClient(
  opts: HumancardAttestorClientOptions,
): HumancardAttestorClient {
  return new HumancardAttestorClient(opts);
}

/** Encode a claim payload exactly the way the contract expects. */
export function encodeClaim(claim: HumancardClaim): Hex {
  return encodeAbiParameters(
    [
      { name: "subjectDid", type: "string" },
      { name: "claimType", type: "string" },
      { name: "claimData", type: "string" },
      { name: "evidenceUri", type: "string" },
      { name: "validFrom", type: "uint64" },
      { name: "validUntil", type: "uint64" },
    ],
    [
      claim.subjectDid,
      claim.claimType,
      claim.claimData,
      claim.evidenceUri,
      claim.validFrom,
      claim.validUntil,
    ],
  );
}

/** Decode an EAS attestation `data` blob into a {@link HumancardClaim}. */
export function decodeClaim(data: Hex): HumancardClaim {
  const [subjectDid, claimType, claimData, evidenceUri, validFrom, validUntil] =
    decodeAbiParameters(
      [
        { name: "subjectDid", type: "string" },
        { name: "claimType", type: "string" },
        { name: "claimData", type: "string" },
        { name: "evidenceUri", type: "string" },
        { name: "validFrom", type: "uint64" },
        { name: "validUntil", type: "uint64" },
      ],
      data,
    );
  return { subjectDid, claimType, claimData, evidenceUri, validFrom, validUntil };
}
