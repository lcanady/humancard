import {
  HUMANCARD_EXTENSION_URI,
  type AgentCard,
  type AgentExtension,
  type AgentSkill,
  type HumancardExtensionParams,
  type HumancardProject,
  type HumancardRole,
} from "./types/agent-card.js";
import type { RawProfile, RawProfileRole, RawProfileProject } from "./profile.js";

/**
 * Spec version of the humancard extension payload emitted by this generator.
 *
 * Bump on any breaking change to the {@link HumancardExtensionParams} shape.
 */
export const HUMANCARD_SPEC_VERSION = "0.1.0";

/**
 * A2A protocol version we conform to. Tracks
 * https://a2a-protocol.org/latest/specification/.
 */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Options that control how a profile is rendered into an Agent Card. */
export interface GenerateAgentCardOptions {
  /**
   * Canonical URL where the live agent's preferred transport is reachable.
   * For Beacon this is the JSON-RPC endpoint, e.g.
   * `https://humancard.dev/a2a`.
   */
  url: string;
  /** Semver of the deployed agent instance (NOT the spec). */
  agentVersion: string;
  /**
   * Provider organization name. Defaults to the profile's identity.name —
   * appropriate when a person represents themselves.
   */
  providerOrganization?: string;
  /** Provider URL. Defaults to GitHub link if present, else `url`. */
  providerUrl?: string;
  /**
   * URL to human-readable docs for this agent (the spec site, typically).
   */
  documentationUrl?: string;
  /** Additional transport endpoints to advertise alongside the primary. */
  additionalInterfaces?: AgentCard["additionalInterfaces"];
  /**
   * If true, the public card omits the heavy humancard extension payload —
   * authenticated callers retrieve it via `agent/getAuthenticatedExtendedCard`.
   * Defaults to false (everything public).
   */
  authenticatedExtendedOnly?: boolean;
  /**
   * OpenAPI-style security schemes to advertise. The Beacon attaches its
   * `didwba` scheme here at deploy time.
   */
  securitySchemes?: AgentCard["securitySchemes"];
  /** OpenAPI security requirement list (alternatives are OR-ed). */
  security?: AgentCard["security"];
}

/**
 * Render a {@link RawProfile} as a fully-formed A2A v0.3 {@link AgentCard}.
 *
 * Pure function: no I/O, no clocks, no randomness. Same profile + options
 * always produces a byte-identical card, which is what we want for
 * deterministic static deploys and diff-friendly review.
 *
 * @param profile Validated profile (typically from {@link loadProfile}).
 * @param options Deploy-time identity for the agent.
 * @returns A complete Agent Card ready to be JSON-serialized at
 *          `/.well-known/agent-card.json` (A2A v0.3 discovery convention).
 */
export function generateAgentCard(
  profile: RawProfile,
  options: GenerateAgentCardOptions,
): AgentCard {
  const providerUrl =
    options.providerUrl ?? profile.identity.links["github"] ?? options.url;

  const humancardParams = buildHumancardExtensionParams(profile);

  // The heavy extension payload is the bulk of the card. When the operator
  // wants the public card kept minimal it's stripped here and re-attached
  // by the authenticated-extended-card handler.
  const includeFullPayload = !options.authenticatedExtendedOnly;
  const humancardExtension: AgentExtension = {
    uri: HUMANCARD_EXTENSION_URI,
    description:
      "Human candidate metadata: identity, experience, stack, preferences, scoring weights.",
    required: false,
    ...(includeFullPayload
      ? { params: humancardParams as unknown as Record<string, unknown> }
      : {}),
  };

  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: `${profile.identity.name} — Agent Card`,
    description: buildDescription(profile),
    url: options.url,
    preferredTransport: "JSONRPC",
    version: options.agentVersion,
    provider: {
      organization: options.providerOrganization ?? profile.identity.name,
      url: providerUrl,
    },
    capabilities: {
      // Phase 2a emits a static card; capability flags flip on as Beacon
      // transports land in 2b–2e.
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [humancardExtension],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: deriveSkills(profile),
    ...(options.additionalInterfaces !== undefined
      ? { additionalInterfaces: options.additionalInterfaces }
      : {}),
    ...(options.documentationUrl !== undefined
      ? { documentationUrl: options.documentationUrl }
      : {}),
    ...(options.securitySchemes !== undefined
      ? { securitySchemes: options.securitySchemes }
      : {}),
    ...(options.security !== undefined ? { security: options.security } : {}),
    ...(options.authenticatedExtendedOnly === true
      ? { supportsAuthenticatedExtendedCard: true }
      : {}),
  };

  return card;
}

/**
 * Build the rich humancard extension payload independent of card emission.
 *
 * Exported so the authenticated-extended-card handler in Beacon can attach
 * the same payload to its private response without re-running
 * `generateAgentCard`.
 */
export function buildHumancardExtensionParams(
  profile: RawProfile,
): HumancardExtensionParams {
  return {
    specVersion: HUMANCARD_SPEC_VERSION,
    identity: {
      name: profile.identity.name,
      handle: profile.identity.handle,
      title: profile.identity.title,
      location: profile.identity.location,
      workMode: profile.identity.remote,
      relocate: profile.identity.relocate,
      availability: profile.identity.available,
      links: { ...profile.identity.links },
      summary: profile.identity.summary,
    },
    experience: {
      years: profile.experience.years,
      degree: profile.experience.degree,
      roles: profile.experience.roles.map(toHumancardRole),
      projects: profile.experience.projects.map(toHumancardProject),
      ...(profile.experience.origin !== undefined
        ? { origin: profile.experience.origin }
        : {}),
    },
    stack: {
      tier1: [...profile.stack.tier1],
      tier2: [...profile.stack.tier2],
      tier3: [...profile.stack.tier3],
      languages: [...profile.stack.languages],
      infra: [...profile.stack.infra],
      crypto: [...profile.stack.crypto],
      frameworks: [...profile.stack.frameworks],
      tools: [...profile.stack.tools],
    },
    preferences: {
      salaryFloorUsd: profile.preferences.salary_floor_usd,
      equity: profile.preferences.equity,
      roles: [...profile.preferences.roles],
      sectors: [...profile.preferences.sectors],
      dealbreakers: [...profile.preferences.dealbreakers],
    },
    scoringWeights: { ...profile.scoring_weights },
  };
}

/**
 * Compose a one-line description suitable for both A2A discovery and
 * search-engine snippets.
 */
function buildDescription(profile: RawProfile): string {
  const { title, location } = profile.identity;
  const years = profile.experience.years;
  return `${title} · ${years}+ years · ${location}. Queryable Agent Card representing a human candidate (humancard spec).`;
}

/**
 * Derive the public A2A `skills[]` list from the profile's tier1/tier2
 * stack. We expose the strongest tiers as discrete, machine-matchable skills
 * — that's what hiring agents will filter on.
 *
 * Tier1 entries become skills; tier2 entries are aggregated as tags on a
 * single "adjacent" skill so the card doesn't explode in size.
 */
function deriveSkills(profile: RawProfile): AgentSkill[] {
  const skills: AgentSkill[] = profile.stack.tier1.map((entry) => ({
    id: slugify(entry),
    name: entry,
    description: `Tier-1 (daily-use) capability: ${entry}.`,
    tags: [entry, ...inferTagsFor(entry, profile)],
  }));

  if (profile.stack.tier2.length > 0) {
    skills.push({
      id: "adjacent-strengths",
      name: "Adjacent strengths",
      description:
        "Tier-2 capabilities with strong working knowledge — production-ready when the role calls for them.",
      tags: [...profile.stack.tier2],
    });
  }

  return skills;
}

/**
 * Infer a small set of supplementary tags for a tier-1 skill by looking it
 * up in the language/framework/infra inventories. Keeps tags useful for
 * keyword search without manual duplication.
 */
function inferTagsFor(entry: string, profile: RawProfile): string[] {
  const lower = entry.toLowerCase();
  const tags: string[] = [];
  for (const lang of profile.stack.languages) {
    if (lang.toLowerCase() === lower) tags.push("language");
  }
  for (const fw of profile.stack.frameworks) {
    if (fw.toLowerCase() === lower) tags.push("framework");
  }
  for (const infra of profile.stack.infra) {
    if (infra.toLowerCase() === lower) tags.push("infra");
  }
  return tags;
}

function toHumancardRole(role: RawProfileRole): HumancardRole {
  // `exactOptionalPropertyTypes` requires us to omit absent optional fields
  // entirely rather than assigning `undefined`. Build the object in two steps.
  const base: HumancardRole = {
    title: role.title,
    company: role.company,
    current: role.current,
    highlights: [...role.highlights],
  };
  return {
    ...base,
    ...(role.url !== undefined ? { url: role.url } : {}),
    ...(role.start !== undefined ? { start: role.start } : {}),
    ...(role.end !== undefined ? { end: role.end } : {}),
  };
}

function toHumancardProject(project: RawProfileProject): HumancardProject {
  const base: HumancardProject = {
    name: project.name,
    description: project.description,
  };
  return {
    ...base,
    ...(project.url !== undefined ? { url: project.url } : {}),
    ...(project.highlight !== undefined ? { highlight: project.highlight } : {}),
  };
}

/** Convert an arbitrary label into a kebab-case identifier suitable for `id` fields. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
