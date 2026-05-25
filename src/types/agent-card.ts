/**
 * Agent2Agent (A2A) v0.3 Agent Card type definitions plus the `humancard`
 * extension shape.
 *
 * The base types model the public A2A spec
 * (https://a2a-protocol.org/latest/specification/). We model the schema
 * explicitly here rather than depend on the official `@a2a-js/sdk` types
 * directly — this file IS part of the humancard spec and we want it to be
 * legible to implementers reading the repo as a reference. The runtime
 * server still uses `@a2a-js/sdk` for protocol mechanics; these types
 * describe the wire shape we emit.
 *
 * Human-specific fields live as the `params` of an {@link AgentExtension}
 * declared inside `capabilities.extensions[]`, identified by the URI
 * {@link HUMANCARD_EXTENSION_URI}. This is the A2A-sanctioned extension
 * mechanism — top-level custom fields are not allowed by the spec.
 */

/** Stable URI identifying the humancard extension across the network. */
export const HUMANCARD_EXTENSION_URI = "https://humancard.dev/ext/v1";

/** Transport protocols an A2A endpoint may speak. */
export type A2ATransportProtocol = "JSONRPC" | "HTTP+JSON" | "GRPC";

/** A single transport endpoint advertised by an agent. */
export interface AgentInterface {
  /** Endpoint URL for this transport. */
  url: string;
  /** Transport protocol spoken at `url`. */
  transport: A2ATransportProtocol;
}

/** Provider/operator metadata for an Agent Card. */
export interface AgentProvider {
  /** Display name of the operating organization or individual. */
  organization: string;
  /** Public URL for the provider. */
  url: string;
}

/**
 * Custom protocol extension declared on an Agent Card.
 *
 * The `params` payload is extension-defined. Clients that don't recognize
 * `uri` must ignore the extension (unless `required: true`).
 */
export interface AgentExtension {
  /** Stable identifier URI for the extension. */
  uri: string;
  /** Human-readable description of what the extension provides. */
  description?: string;
  /**
   * If true, clients that don't recognize this extension SHOULD refuse the
   * agent. Defaults to false.
   */
  required?: boolean;
  /** Extension-defined payload. */
  params?: Record<string, unknown>;
}

/** A2A capability surface advertised by an agent. */
export interface AgentCapabilities {
  /** Whether the agent supports `message/stream` SSE streaming. */
  streaming?: boolean;
  /** Whether the agent supports task push-notification webhooks. */
  pushNotifications?: boolean;
  /** Whether the agent reports historical task state transitions. */
  stateTransitionHistory?: boolean;
  /** Custom protocol extensions declared by this agent. */
  extensions?: AgentExtension[];
}

/**
 * OpenAPI 3.x-style security scheme. A2A reuses the OpenAPI definition
 * verbatim, so we model only the discriminant and pass through the rest as
 * unknown — the full OpenAPI shape is large and schema-validated upstream
 * by `@a2a-js/sdk`.
 */
export interface AgentSecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  /** OpenAPI security-scheme fields beyond `type` and `description`. */
  [extra: string]: unknown;
}

/** Optional cryptographic signature attached to an Agent Card. */
export interface AgentCardSignature {
  /** Compact JWS signing the card payload. */
  signature: string;
  /** JWS protected header (base64url JSON). */
  protected: string;
  /** Optional JWS unprotected header. */
  header?: Record<string, unknown>;
}

/** A discrete capability/skill the agent advertises. */
export interface AgentSkill {
  /** Stable identifier (kebab-case), unique within the card. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** One-paragraph description of what this skill does. */
  description: string;
  /** Free-form tags used for matching/filtering. Required (may be empty). */
  tags: string[];
  /** Concrete example prompts demonstrating the skill. */
  examples?: string[];
  /** Override of `defaultInputModes` for this skill. */
  inputModes?: string[];
  /** Override of `defaultOutputModes` for this skill. */
  outputModes?: string[];
  /** Per-skill security requirement (OpenAPI security-requirement list). */
  security?: Array<Record<string, string[]>>;
}

/**
 * The humancard extension payload — the open-standard portion of this
 * project. Surfaced as the `params` of an AgentExtension whose `uri`
 * is {@link HUMANCARD_EXTENSION_URI}.
 */
export interface HumancardExtensionParams {
  /** Spec version of the humancard extension itself. */
  specVersion: string;
  /** The person's identity block. */
  identity: {
    name: string;
    handle: string;
    title: string;
    location: string;
    /** Work-mode preference: e.g. "remote-first", "hybrid", "on-site". */
    workMode: string;
    /**
     * Relocation stance — free-form, but conventionally one of:
     * "open" | "no" | "sweet-deal-only" | string.
     */
    relocate: string;
    /** Availability — e.g. "immediately", "2026-Q3", "not-looking". */
    availability: string;
    /** Public profile links keyed by platform. */
    links: Readonly<Record<string, string>>;
    /** Long-form biographical summary. */
    summary: string;
  };
  /** Career/experience block. */
  experience: {
    years: number;
    /** Whether the person holds a formal CS (or equivalent) degree. */
    degree: boolean;
    roles: ReadonlyArray<HumancardRole>;
    projects: ReadonlyArray<HumancardProject>;
    /** Free-form origin/early-career narrative. */
    origin?: string;
  };
  /** Tech stack, tiered by depth. tier1 = strongest. */
  stack: HumancardStack;
  /** What this person is looking for. Used by Hunter for scoring. */
  preferences: HumancardPreferences;
  /**
   * Weighted criteria a Hunter (or any matcher) should apply when scoring
   * inbound opportunities. Sum of weights is conventionally 100.
   */
  scoringWeights: Readonly<Record<string, number>>;
}

/** A single role/job entry. */
export interface HumancardRole {
  title: string;
  company: string;
  url?: string;
  current: boolean;
  /** ISO date or YYYY-MM. Omitted when `current` is true and unknown. */
  start?: string;
  /** ISO date or YYYY-MM. Omitted when `current` is true. */
  end?: string;
  highlights: ReadonlyArray<string>;
}

/** A notable project (typically open-source or otherwise public). */
export interface HumancardProject {
  name: string;
  description: string;
  url?: string;
  /** Surface this prominently in summaries / agent responses. */
  highlight?: boolean;
}

/** Tiered tech-stack inventory. */
export interface HumancardStack {
  /** Strongest, daily-use technologies. */
  tier1: ReadonlyArray<string>;
  /** Strong working knowledge. */
  tier2: ReadonlyArray<string>;
  /** Familiar / emerging interests. */
  tier3: ReadonlyArray<string>;
  languages: ReadonlyArray<string>;
  infra: ReadonlyArray<string>;
  /** Crypto/Web3-specific stack, kept distinct from general infra. */
  crypto: ReadonlyArray<string>;
  frameworks: ReadonlyArray<string>;
  tools: ReadonlyArray<string>;
}

/** Preferences governing what kinds of opportunities are interesting. */
export interface HumancardPreferences {
  /** Minimum acceptable annual base salary in USD. */
  salaryFloorUsd: number;
  /** Whether equity is required as part of compensation. */
  equity: boolean;
  /** Acceptable role titles (loose match). */
  roles: ReadonlyArray<string>;
  /** Acceptable industry sectors. */
  sectors: ReadonlyArray<string>;
  /** Hard "no" filters — any match disqualifies an opportunity. */
  dealbreakers: ReadonlyArray<string>;
}

/**
 * The full Agent Card per A2A v0.3. Conformant clients that don't
 * understand the humancard extension still get a valid, useful card.
 */
export interface AgentCard {
  /** A2A protocol version this card conforms to (e.g. "0.3.0"). */
  protocolVersion: string;
  /** Display name of the agent. */
  name: string;
  /** One-line description of the agent. */
  description: string;
  /** Endpoint URL for `preferredTransport`. */
  url: string;
  /** Preferred transport protocol at `url`. */
  preferredTransport: A2ATransportProtocol;
  /** Additional transport endpoints (alternative URLs/protocols). */
  additionalInterfaces?: AgentInterface[];
  /** Optional icon URL for UIs. */
  iconUrl?: string;
  /** Operating provider. */
  provider?: AgentProvider;
  /** Semver of THIS agent (the deployed instance). */
  version: string;
  /** URL to human-readable docs for the agent. */
  documentationUrl?: string;
  /** Advertised protocol capabilities and extensions. */
  capabilities: AgentCapabilities;
  /** OpenAPI 3.x-style security scheme definitions, keyed by name. */
  securitySchemes?: Record<string, AgentSecurityScheme>;
  /** OpenAPI security requirement list (alternatives are OR-ed). */
  security?: Array<Record<string, string[]>>;
  /** Default supported input MIME types. Required, may be empty array. */
  defaultInputModes: string[];
  /** Default supported output MIME types. Required, may be empty array. */
  defaultOutputModes: string[];
  /** Discrete skills the agent advertises. Must be non-empty. */
  skills: AgentSkill[];
  /**
   * If true, this public card may omit private skills/extensions; the full
   * card is fetched via `agent/getAuthenticatedExtendedCard`.
   */
  supportsAuthenticatedExtendedCard?: boolean;
  /** Optional JWS signatures over the card payload. */
  signatures?: AgentCardSignature[];
}
