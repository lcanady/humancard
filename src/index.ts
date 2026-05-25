/**
 * Public entry point for the `humancard` package.
 *
 * Re-exports the spec types, profile loader, and Agent Card generator so
 * downstream consumers (Beacon server, Hunter, third-party implementers)
 * can `import { generateAgentCard, loadProfile } from "humancard"`.
 */

export type {
  A2ATransportProtocol,
  AgentCard,
  AgentCapabilities,
  AgentCardSignature,
  AgentExtension,
  AgentInterface,
  AgentProvider,
  AgentSecurityScheme,
  AgentSkill,
  HumancardExtensionParams,
  HumancardPreferences,
  HumancardProject,
  HumancardRole,
  HumancardStack,
} from "./types/agent-card.js";

export { HUMANCARD_EXTENSION_URI } from "./types/agent-card.js";

export type { RawProfile, RawProfileProject, RawProfileRole } from "./profile.js";

export {
  RawProfileSchema,
  RawProfileRoleSchema,
  RawProfileProjectSchema,
  loadProfile,
  validateProfile,
  ProfileValidationError,
  DEFAULT_PROFILE_PATH,
} from "./profile.js";

export {
  generateAgentCard,
  buildHumancardExtensionParams,
  HUMANCARD_SPEC_VERSION,
  A2A_PROTOCOL_VERSION,
} from "./generator.js";

export type { GenerateAgentCardOptions } from "./generator.js";
