/**
 * Agent Network Protocol (`did:wba`) identity primitives, consolidated into
 * one file: Ed25519 key management, DID document construction, RFC 9421
 * HTTP message-signature verification + signing, RFC 7519 JWT issuance and
 * verification, and the Express middleware that ties them together.
 *
 * Public surface mirrors the previous `src/identity/index.ts`.
 */

import "express";

import { getPublicKeyAsync, signAsync, utils, verifyAsync } from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58btc } from "multiformats/bases/base58";
import { SignJWT, jwtVerify, importJWK, type JWK, type CryptoKey } from "jose";
import { z } from "zod";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { PublicError } from "./errors.js";
import { logger } from "../shared/logger.js";

// Express type augmentation — preserved verbatim from the prior
// `src/identity/types.d.ts`. TypeScript merges ambient module declarations
// across files, so co-locating it here keeps the public-surface flat.
declare module "express-serve-static-core" {
  interface Request {
    /** DID of the authenticated agent, set by didWbaAuthMiddleware. */
    didSubject?: string;
  }
}

// ─────────────────────────── keys.ts ────────────────────────────────────────

/**
 * Multicodec prefix bytes for Ed25519 public keys per the multicodec table:
 * 0xed (varint) + 0x01.
 */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Strict hex parser for 64-char hex strings (32-byte keys).
 */
function hexToBytes32(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error("Expected 32-byte (64 hex char) Ed25519 private key");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode a byte buffer as unpadded base64url (RFC 4648 §5).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate a fresh Ed25519 keypair using a CSPRNG.
 */
export async function generateEd25519KeyPair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

/**
 * Load an Ed25519 keypair from the `DIDWBA_PRIVATE_KEY_HEX` env var.
 *
 * @returns The keypair, or `null` if the env var is unset/empty.
 */
export async function loadKeyPairFromEnv(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} | null> {
  const raw = process.env["DIDWBA_PRIVATE_KEY_HEX"];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const privateKey = hexToBytes32(raw.trim());
  const publicKey = await getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

/**
 * Load a persistent keypair from env, or generate an ephemeral one.
 *
 * Ephemeral keys do NOT survive process restarts; signed JWTs and DID
 * documents tied to an ephemeral key will become unverifiable after
 * the process exits. A warning is logged when this happens.
 */
export async function loadOrGenerateKeyPair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  isEphemeral: boolean;
}> {
  const fromEnv = await loadKeyPairFromEnv();
  if (fromEnv !== null) {
    return { ...fromEnv, isEphemeral: false };
  }
  logger.warn(
    "DIDWBA_PRIVATE_KEY_HEX not set; generated ephemeral Ed25519 key. Signatures will not persist across restarts.",
  );
  const generated = await generateEd25519KeyPair();
  return { ...generated, isEphemeral: true };
}

/**
 * Encode an Ed25519 public key as a W3C `Multikey` value.
 */
export function publicKeyMultibase(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  const buf = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  buf.set(ED25519_MULTICODEC_PREFIX, 0);
  buf.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return base58btc.encode(buf);
}

/**
 * Compute the RFC 7638 JWK thumbprint of an Ed25519 public key.
 */
export function jwkThumbprint(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  const x = base64UrlEncode(publicKey);
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  const digest = sha256(new TextEncoder().encode(canonical));
  return base64UrlEncode(digest);
}

/**
 * Build the `e1_<thumbprint>` identifier component used in path-style
 * `did:wba` identifiers per ANP §3.
 */
export function e1Identifier(publicKey: Uint8Array): string {
  return `e1_${jwkThumbprint(publicKey)}`;
}

// ─────────────────────────── did.ts ─────────────────────────────────────────

/** Domain segment validator: lowercase host, optional port. */
const DID_WBA_DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;

/** Path segments are unreserved per RFC 3986 plus `_`/`-`. */
const DID_WBA_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Build a `did:wba` identifier.
 */
export function buildDidIdentifier(opts: {
  domain: string;
  pathSegments?: string[];
  publicKey?: Uint8Array;
}): string {
  const { domain, pathSegments, publicKey } = opts;
  const lowerDomain = domain.toLowerCase();
  if (!DID_WBA_DOMAIN_RE.test(lowerDomain)) {
    throw new Error(`Invalid did:wba domain: ${domain}`);
  }

  if (pathSegments === undefined || pathSegments.length === 0) {
    return `did:wba:${lowerDomain}`;
  }

  if (publicKey === undefined) {
    throw new Error("publicKey is required for path-style did:wba identifiers");
  }
  for (const seg of pathSegments) {
    if (!DID_WBA_PATH_SEGMENT_RE.test(seg)) {
      throw new Error(`Invalid did:wba path segment: ${seg}`);
    }
  }
  return `did:wba:${lowerDomain}:${pathSegments.join(":")}:${e1Identifier(publicKey)}`;
}

/** Zod schema for the DID document shape we emit. */
export const DidDocumentSchema = z.object({
  "@context": z.array(z.string()),
  id: z.string().startsWith("did:wba:"),
  verificationMethod: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("Multikey"),
        controller: z.string(),
        publicKeyMultibase: z.string(),
      }),
    )
    .min(1),
  authentication: z.array(z.string()).min(1),
  assertionMethod: z.array(z.string()).min(1),
  service: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        serviceEndpoint: z.string().url(),
      }),
    )
    .optional(),
});

/** Static type derived from {@link DidDocumentSchema}. */
export type DidDocument = z.infer<typeof DidDocumentSchema>;

/**
 * Build a DID document for a `did:wba` subject. Phase 3 will add an
 * `eddsa-jcs-2022` data-integrity proof; the v1 implementation deliberately
 * relies on TLS for document authentication.
 */
export function buildDidDocument(opts: {
  did: string;
  publicKey: Uint8Array;
  serviceEndpoint?: string;
}): DidDocument {
  const { did, publicKey, serviceEndpoint } = opts;
  if (!did.startsWith("did:wba:")) {
    throw new Error("did must start with did:wba:");
  }

  const verificationMethodId = `${did}#key-1`;

  const baseDoc: DidDocument = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/data-integrity/v2",
      "https://w3id.org/security/multikey/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: verificationMethodId,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: publicKeyMultibase(publicKey),
      },
    ],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
  };

  const doc: DidDocument =
    serviceEndpoint !== undefined
      ? {
          ...baseDoc,
          service: [
            {
              id: `${did}#agent`,
              type: "AgentDescription",
              serviceEndpoint,
            },
          ],
        }
      : baseDoc;

  return DidDocumentSchema.parse(doc);
}

// ─────────────────────────── signatures.ts ──────────────────────────────────

const MAX_CREATED_SKEW_SECONDS = 300;

const SUPPORTED_COMPONENTS = [
  "@method",
  "@target-uri",
  "@authority",
  "content-digest",
] as const;

type SupportedComponent = (typeof SUPPORTED_COMPONENTS)[number];

interface SignatureInput {
  label: string;
  components: SupportedComponent[];
  created: number;
  expires: number;
  nonce: string;
  keyId: string;
  paramsLine: string;
  rawComponentList: string;
}

function parseSignatureInput(value: string): SignatureInput | null {
  const trimmed = value.trim();
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const label = trimmed.slice(0, eq).trim();
  const rest = trimmed.slice(eq + 1);
  if (!rest.startsWith("(")) return null;
  const closeParen = rest.indexOf(")");
  if (closeParen === -1) return null;
  const inner = rest.slice(1, closeParen);
  const tail = rest.slice(closeParen + 1);
  const rawComponentList = rest.slice(0, closeParen + 1) + tail;

  const componentTokens = inner
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => {
      if (!(t.startsWith('"') && t.endsWith('"'))) {
        throw new Error("signature component must be a quoted string");
      }
      return t.slice(1, -1);
    });

  for (const c of componentTokens) {
    if (!(SUPPORTED_COMPONENTS as readonly string[]).includes(c)) {
      throw new Error(`unsupported signature component: ${c}`);
    }
  }
  const components = componentTokens as SupportedComponent[];

  const params: Record<string, string> = {};
  const paramsRaw = tail.startsWith(";") ? tail.slice(1) : tail;
  if (paramsRaw.length > 0) {
    const parts: string[] = [];
    let buf = "";
    let inQuotes = false;
    for (const ch of paramsRaw) {
      if (ch === '"') {
        inQuotes = !inQuotes;
        buf += ch;
      } else if (ch === ";" && !inQuotes) {
        parts.push(buf);
        buf = "";
      } else {
        buf += ch;
      }
    }
    if (buf.length > 0) parts.push(buf);
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      params[k] = v;
    }
  }

  const createdStr = params["created"];
  const expiresStr = params["expires"];
  const nonce = params["nonce"];
  const keyId = params["keyid"];
  if (
    createdStr === undefined ||
    expiresStr === undefined ||
    nonce === undefined ||
    keyId === undefined
  ) {
    throw new Error("signature parameters must include created, expires, nonce, keyid");
  }
  const created = Number.parseInt(createdStr, 10);
  const expires = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    throw new Error("created/expires must be integers");
  }

  return {
    label,
    components,
    created,
    expires,
    nonce,
    keyId,
    paramsLine: rawComponentList,
    rawComponentList,
  };
}

function parseSignatureHeader(value: string, label: string): Uint8Array | null {
  const trimmed = value.trim();
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const lbl = trimmed.slice(0, eq).trim();
  if (lbl !== label) return null;
  const inner = trimmed.slice(eq + 1).trim();
  if (!(inner.startsWith(":") && inner.endsWith(":"))) return null;
  const b64 = inner.slice(1, -1);
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Compute the RFC 9530 `Content-Digest` header value for a body.
 */
export function computeContentDigest(body: Uint8Array): string {
  const digest = sha256(body);
  const b64 = Buffer.from(digest).toString("base64");
  return `sha-256=:${b64}:`;
}

function buildSignatureBase(opts: {
  components: SupportedComponent[];
  method: string;
  targetUri: string;
  authority: string;
  contentDigest: string | null;
  paramsLine: string;
  label: string;
}): string {
  const lines: string[] = [];
  for (const c of opts.components) {
    let v: string;
    switch (c) {
      case "@method":
        v = opts.method.toUpperCase();
        break;
      case "@target-uri":
        v = opts.targetUri;
        break;
      case "@authority":
        v = opts.authority.toLowerCase();
        break;
      case "content-digest":
        if (opts.contentDigest === null) {
          throw new Error("content-digest covered but no body present");
        }
        v = opts.contentDigest;
        break;
    }
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${opts.paramsLine}`);
  return lines.join("\n");
}

/** Successful signature-verification result. */
export interface VerifySignatureOk {
  ok: true;
  keyId: string;
}

/** Failed signature-verification result. */
export interface VerifySignatureErr {
  ok: false;
  reason: string;
}

/**
 * Verify an inbound HTTP message signature per RFC 9421 + RFC 9530.
 */
export async function verifyHttpSignature(opts: {
  method: string;
  targetUri: string;
  authority: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  resolveKey: (keyId: string) => Promise<Uint8Array | null>;
}): Promise<VerifySignatureOk | VerifySignatureErr> {
  const sigInputHeader = opts.headers["signature-input"];
  const sigHeader = opts.headers["signature"];
  if (sigInputHeader === undefined || sigHeader === undefined) {
    return { ok: false, reason: "missing_signature" };
  }

  let parsed: SignatureInput;
  try {
    const p = parseSignatureInput(sigInputHeader);
    if (p === null) return { ok: false, reason: "malformed_signature_input" };
    parsed = p;
  } catch {
    return { ok: false, reason: "malformed_signature_input" };
  }

  const sigBytes = parseSignatureHeader(sigHeader, parsed.label);
  if (sigBytes === null) return { ok: false, reason: "malformed_signature" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.created) > MAX_CREATED_SKEW_SECONDS) {
    return { ok: false, reason: "stale_signature" };
  }
  if (parsed.expires <= nowSec) {
    return { ok: false, reason: "expired_signature" };
  }

  let contentDigest: string | null = null;
  if (parsed.components.includes("content-digest")) {
    if (opts.body === undefined) {
      return { ok: false, reason: "content_digest_required" };
    }
    const expected = computeContentDigest(opts.body);
    const received = opts.headers["content-digest"];
    if (received === undefined || received.trim() !== expected) {
      return { ok: false, reason: "content_digest_mismatch" };
    }
    contentDigest = expected;
  }

  const pubkey = await opts.resolveKey(parsed.keyId);
  if (pubkey === null) return { ok: false, reason: "unknown_key" };

  const base = buildSignatureBase({
    components: parsed.components,
    method: opts.method,
    targetUri: opts.targetUri,
    authority: opts.authority,
    contentDigest,
    paramsLine: parsed.paramsLine,
    label: parsed.label,
  });

  const ok = await verifyAsync(sigBytes, new TextEncoder().encode(base), pubkey);
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true, keyId: parsed.keyId };
}

/** Output of {@link signRequest}: ready-to-attach HTTP headers. */
export interface SignedRequestHeaders {
  "Signature-Input": string;
  Signature: string;
  "Content-Digest"?: string;
}

/**
 * Sign an outbound HTTP request per RFC 9421 with the supported component set.
 */
export async function signRequest(opts: {
  method: string;
  targetUri: string;
  authority: string;
  body?: Uint8Array;
  privateKey: Uint8Array;
  keyId: string;
  label?: string;
  ttlSeconds?: number;
}): Promise<SignedRequestHeaders> {
  const label = opts.label ?? "sig1";
  const ttl = opts.ttlSeconds ?? 300;
  const created = Math.floor(Date.now() / 1000);
  const expires = created + ttl;
  const nonceBytes = new Uint8Array(16);
  const { webcrypto } = await import("node:crypto");
  webcrypto.getRandomValues(nonceBytes);
  const nonce = base64UrlEncode(nonceBytes);

  const components: SupportedComponent[] = ["@method", "@target-uri", "@authority"];
  let contentDigest: string | null = null;
  if (opts.body !== undefined) {
    components.push("content-digest");
    contentDigest = computeContentDigest(opts.body);
  }

  const inner = components.map((c) => `"${c}"`).join(" ");
  const paramsLine = `(${inner});created=${created};expires=${expires};nonce="${nonce}";keyid="${opts.keyId}"`;

  const base = buildSignatureBase({
    components,
    method: opts.method,
    targetUri: opts.targetUri,
    authority: opts.authority,
    contentDigest,
    paramsLine,
    label,
  });

  const sig = await signAsync(new TextEncoder().encode(base), opts.privateKey);
  const sigB64 = Buffer.from(sig).toString("base64");

  const headers: SignedRequestHeaders = {
    "Signature-Input": `${label}=${paramsLine}`,
    Signature: `${label}=:${sigB64}:`,
  };
  if (contentDigest !== null) {
    headers["Content-Digest"] = contentDigest;
  }
  return headers;
}

// ─────────────────────────── jwt.ts ─────────────────────────────────────────

const DEFAULT_JWT_TTL_SECONDS = 3600;

function privateJwk(privateKey: Uint8Array, publicKey: Uint8Array): JWK {
  if (privateKey.length !== 32 || publicKey.length !== 32) {
    throw new Error("Ed25519 keys must be 32 bytes each");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    d: base64UrlEncode(privateKey),
    x: base64UrlEncode(publicKey),
  };
}

function publicJwk(publicKey: Uint8Array): JWK {
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: base64UrlEncode(publicKey),
  };
}

/**
 * Issue a short-lived Ed25519-signed JWT (`alg: EdDSA`).
 */
export async function issueAccessToken(opts: {
  subject: string;
  issuer: string;
  ttlSeconds?: number;
  privateKey: Uint8Array;
}): Promise<string> {
  const pub = await getPublicKeyAsync(opts.privateKey);
  const jwk = privateJwk(opts.privateKey, pub);
  const key = (await importJWK(jwk, "EdDSA")) as CryptoKey;
  const ttl = opts.ttlSeconds ?? DEFAULT_JWT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(opts.issuer)
    .setSubject(opts.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);
}

/**
 * Verify an Ed25519-signed access token. Throws `PublicError("UNAUTHORIZED")`
 * on any failure (signature, expiry, issuer mismatch, malformed claims).
 */
export async function verifyAccessToken(opts: {
  token: string;
  publicKey: Uint8Array;
  expectedIssuer: string;
}): Promise<{ subject: string }> {
  try {
    const jwk = publicJwk(opts.publicKey);
    const key = (await importJWK(jwk, "EdDSA")) as CryptoKey;
    const { payload } = await jwtVerify(opts.token, key, {
      issuer: opts.expectedIssuer,
      algorithms: ["EdDSA"],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new PublicError("UNAUTHORIZED", "Access token missing subject.");
    }
    return { subject: payload.sub };
  } catch (err) {
    if (err instanceof PublicError) throw err;
    throw new PublicError("UNAUTHORIZED", "Access token invalid or expired.");
  }
}

// ─────────────────────────── middleware.ts ──────────────────────────────────

/** Configuration for {@link didWbaAuthMiddleware}. */
export interface DidWbaMiddlewareOptions {
  /** Bare-domain DID of this server (e.g. `"did:wba:humancard.dev"`). */
  issuer: string;
  /** Server's Ed25519 private key (32 bytes) — used to mint JWTs. */
  privateKey: Uint8Array;
  /** Server's Ed25519 public key (32 bytes) — used to verify JWTs. */
  publicKey: Uint8Array;
  /**
   * Resolver from a verification-method id (e.g. `<did>#key-1`) to the
   * agent's 32-byte Ed25519 public key. Returns null for unknown keys.
   */
  resolveKey: (keyId: string) => Promise<Uint8Array | null>;
  /** Access-token TTL in seconds. Default 3600. */
  ttlSeconds?: number;
}

function getTargetUri(req: Request): string {
  const proto = req.protocol;
  const host = req.get("host") ?? "";
  return `${proto}://${host}${req.originalUrl}`;
}

function normaliseHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function generateChallengeNonce(): Promise<string> {
  const bytes = new Uint8Array(16);
  const { webcrypto } = await import("node:crypto");
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build a `did:wba` Express authentication middleware. */
export function didWbaAuthMiddleware(opts: DidWbaMiddlewareOptions): RequestHandler {
  const ttl = opts.ttlSeconds ?? 3600;

  return async function didWbaAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const authz = req.get("authorization");
      if (typeof authz === "string" && authz.toLowerCase().startsWith("bearer ")) {
        const token = authz.slice(7).trim();
        const { subject } = await verifyAccessToken({
          token,
          publicKey: opts.publicKey,
          expectedIssuer: opts.issuer,
        });
        req.didSubject = subject;
        next();
        return;
      }

      const sigInput = req.get("signature-input");
      const sig = req.get("signature");
      if (typeof sigInput === "string" && typeof sig === "string") {
        const headers = normaliseHeaders(req);
        const authority = req.get("host") ?? "";
        const targetUri = getTargetUri(req);
        const body = Buffer.isBuffer(req.body)
          ? new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength)
          : undefined;

        const result = await verifyHttpSignature({
          method: req.method,
          targetUri,
          authority,
          headers,
          ...(body !== undefined ? { body } : {}),
          resolveKey: opts.resolveKey,
        });
        if (result.ok === false) {
          challenge(res, authority, result.reason, await generateChallengeNonce(), ttl);
          return;
        }

        const hashIdx = result.keyId.indexOf("#");
        const subject =
          hashIdx === -1 ? result.keyId : result.keyId.slice(0, hashIdx);

        const token = await issueAccessToken({
          subject,
          issuer: opts.issuer,
          ttlSeconds: ttl,
          privateKey: opts.privateKey,
        });
        res.setHeader(
          "Authentication-Info",
          `access_token="${token}", token_type="Bearer", expires_in=${ttl}`,
        );
        req.didSubject = subject;
        next();
        return;
      }

      const authority = req.get("host") ?? "";
      challenge(res, authority, "missing_signature", await generateChallengeNonce(), ttl);
    } catch (err) {
      if (err instanceof PublicError && err.code === "UNAUTHORIZED") {
        const authority = req.get("host") ?? "";
        challenge(res, authority, "invalid_token", await generateChallengeNonce(), ttl);
        return;
      }
      next(err);
    }
  };
}

/** Emit a 401 challenge per ANP V0.2 §6.3. */
function challenge(
  res: Response,
  authority: string,
  errorCode: string,
  nonce: string,
  ttl: number,
): void {
  const created = Math.floor(Date.now() / 1000);
  const expires = created + ttl;
  res.setHeader(
    "WWW-Authenticate",
    `DIDWba realm="${authority}", error="${errorCode}", nonce="${nonce}"`,
  );
  res.setHeader(
    "Accept-Signature",
    `sig1=("@method" "@target-uri" "@authority" "content-digest");created=${created};expires=${expires};nonce="${nonce}"`,
  );
  res.status(401).json({ error: "unauthorized", reason: errorCode });
}
