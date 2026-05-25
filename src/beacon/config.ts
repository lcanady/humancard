import "dotenv/config";

import { z } from "zod";

/**
 * Beacon runtime configuration, sourced from environment variables (and an
 * optional `.env` file via `dotenv/config`).
 *
 * Every variable goes through Zod here so that a misconfigured deployment
 * crashes loudly at boot rather than silently emitting broken cards or
 * leaking defaults.
 */
const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    BEACON_BASE_URL: z.string().url().default("http://localhost:3000"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
    ALLOWED_HOSTS: z
      .string()
      .default("localhost,127.0.0.1")
      .transform((raw) =>
        raw
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    /**
     * Recipient EVM address for x402 payments (must be `0x` + 40 hex chars).
     * When absent, premium tools are NOT gated — they run free. This keeps
     * `npm run start:beacon` zero-config friendly for local dev.
     */
    X402_PAY_TO: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/u, "must be a 0x-prefixed 20-byte EVM address")
      .optional(),
    /** CAIP-2 network for x402 (defaults to Base Sepolia testnet). */
    X402_NETWORK: z
      .enum(["eip155:84532", "eip155:8453"])
      .default("eip155:84532"),
    /** Public hosted facilitator URL. */
    X402_FACILITATOR_URL: z
      .string()
      .url()
      .default("https://x402.org/facilitator"),
    /** Price string per call to the gated tool, e.g. "$0.01". */
    X402_SCORE_PRICE: z.string().min(1).default("$0.01"),
    /** Cron schedule for the Hunter run loop. Default: every 2 hours. */
    HUNTER_CRON_SCHEDULE: z.string().min(1).default("0 */2 * * *"),
    /**
     * Comma-separated keyword list used to filter inbound job-board listings.
     * Empties are dropped post-split.
     */
    HUNTER_KEYWORDS: z
      .string()
      .default("agentic,ai,mcp,langchain")
      .transform((raw) =>
        raw
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    /**
     * Comma-separated GitHub org slugs to watch for hiring-signal events.
     * Empty default disables the GitHub source.
     */
    HUNTER_GITHUB_ORGS: z
      .string()
      .default("")
      .transform((raw) =>
        raw
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    /** Outbound webhook for scored job alerts (Discord/Slack-compatible). */
    WEBHOOK_URL: z.string().url().optional(),
    /** Path for Hunter dedup state file. Default: `.hunter-state.json`. */
    HUNTER_STATE_FILE: z.string().min(1).optional(),
    /** GitHub API token (optional — bumps rate limit from 60 to 5000/hr). */
    GITHUB_TOKEN: z.string().min(1).optional(),
  })
  .strict();

/** Public type for the resolved Beacon config singleton. */
export type BeaconConfig = z.infer<typeof ConfigSchema>;

/**
 * Parse the current `process.env` into a {@link BeaconConfig}.
 *
 * Exported for tests; the production code path uses the {@link config}
 * singleton below.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BeaconConfig {
  const result = ConfigSchema.safeParse({
    PORT: env["PORT"],
    BEACON_BASE_URL: env["BEACON_BASE_URL"],
    ANTHROPIC_API_KEY: env["ANTHROPIC_API_KEY"],
    ANTHROPIC_MODEL: env["ANTHROPIC_MODEL"],
    ALLOWED_HOSTS: env["ALLOWED_HOSTS"],
    X402_PAY_TO: env["X402_PAY_TO"],
    X402_NETWORK: env["X402_NETWORK"],
    X402_FACILITATOR_URL: env["X402_FACILITATOR_URL"],
    X402_SCORE_PRICE: env["X402_SCORE_PRICE"],
    HUNTER_CRON_SCHEDULE: env["HUNTER_CRON_SCHEDULE"],
    HUNTER_KEYWORDS: env["HUNTER_KEYWORDS"],
    HUNTER_GITHUB_ORGS: env["HUNTER_GITHUB_ORGS"],
    WEBHOOK_URL: env["WEBHOOK_URL"],
    HUNTER_STATE_FILE: env["HUNTER_STATE_FILE"],
    GITHUB_TOKEN: env["GITHUB_TOKEN"],
  });
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Beacon configuration: ${summary}`);
  }
  return result.data;
}

/**
 * Process-wide singleton config. Loaded once at module import time so all
 * downstream modules (transports, scoring, handlers) see a consistent view.
 */
export const config: BeaconConfig = loadConfig();
