/**
 * Singleton Anthropic SDK client + retrying message helper.
 *
 * Centralizes Claude access so every subsystem (Beacon scoring, Hunter
 * inference) uses the same key, model defaults, and retry policy. The
 * client is lazily constructed on first use and memoized for the life of
 * the process; if `ANTHROPIC_API_KEY` is unset, {@link getClaudeClient}
 * returns null and {@link claudeMessage} throws a `PublicError` with code
 * `UPSTREAM_FAILURE`.
 */

import Anthropic from "@anthropic-ai/sdk";

import { config } from "../beacon/config.js";
import { PublicError } from "../beacon/errors.js";
import { logger } from "./logger.js";

let cached: Anthropic | null | undefined;

/**
 * Return the process-wide Anthropic client, or null when no API key is
 * configured. The result is memoized — calling repeatedly is cheap.
 */
export function getClaudeClient(): Anthropic | null {
  if (cached !== undefined) return cached;
  if (config.ANTHROPIC_API_KEY === undefined) {
    cached = null;
    return null;
  }
  cached = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return cached;
}

/** Options accepted by {@link claudeMessage}. */
export interface ClaudeMessageOptions {
  /** Optional system prompt. */
  system?: string;
  /** User prompt content (single text turn). */
  user: string;
  /** Maximum response tokens. Defaults to 1024. */
  maxTokens?: number;
  /** Optional model override. Defaults to {@link config.ANTHROPIC_MODEL}. */
  model?: string;
}

/** Pause for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff schedule (ms) for the three retry attempts. */
const RETRY_BACKOFF_MS: ReadonlyArray<number> = [250, 500, 1000];

/**
 * Determine whether an error is worth retrying. We retry on HTTP 429 and
 * 5xx; everything else (4xx, validation, malformed responses) is fatal.
 */
function isRetryable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Send a single user message to Claude and return the concatenated text of
 * the response.
 *
 * Retries up to three times on HTTP 429 / 5xx with exponential-ish backoff
 * (250ms, 500ms, 1000ms). Permanent failures and missing-API-key cases
 * throw `PublicError("UPSTREAM_FAILURE", …)`.
 */
export async function claudeMessage(opts: ClaudeMessageOptions): Promise<string> {
  const client = getClaudeClient();
  if (client === null) {
    throw new PublicError(
      "UPSTREAM_FAILURE",
      "Claude API key not configured.",
    );
  }

  const model = opts.model ?? config.ANTHROPIC_MODEL;
  const maxTokens = opts.maxTokens ?? 1024;

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.user }],
      });
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      return text;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === RETRY_BACKOFF_MS.length) {
        break;
      }
      const delay = RETRY_BACKOFF_MS[attempt] ?? 1000;
      logger.warn("claude retry", { attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
    }
  }

  logger.error("claude permanent failure", {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw new PublicError("UPSTREAM_FAILURE", "Claude API call failed.");
}
