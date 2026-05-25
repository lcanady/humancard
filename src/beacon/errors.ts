/**
 * Public-facing error helpers for the Beacon server.
 *
 * The wire-facing surface (HTTP, JSON-RPC, MCP) must NEVER leak stack traces,
 * file paths, internal IDs, secrets, or arbitrary upstream error text. Every
 * error that crosses a transport boundary must be funneled through
 * {@link toPublicError} which strips internal detail and maps to a small, fixed
 * set of safe codes/messages.
 */

/**
 * Closed set of error codes that may appear on the wire.
 *
 * Adding a code here is a deliberate API decision — clients of the Beacon
 * surface key off these strings.
 */
export type PublicErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "UPSTREAM_FAILURE"
  | "INTERNAL";

/**
 * Error type intended to be thrown by handlers when they want a specific
 * public-facing code/message pair to be emitted. Anything that isn't a
 * `PublicError` is reduced to `INTERNAL` by {@link toPublicError}.
 */
export class PublicError extends Error {
  public readonly code: PublicErrorCode;

  /**
   * @param code Public error code from the closed set.
   * @param message Human-readable, end-user-safe message. Don't include
   *                stack frames or implementation details here.
   */
  public constructor(code: PublicErrorCode, message: string) {
    super(message);
    this.name = "PublicError";
    this.code = code;
  }
}

/**
 * Default messages per code. Used when an internal error reaches the wire
 * boundary without being wrapped in a `PublicError`.
 */
const DEFAULT_MESSAGES: Record<PublicErrorCode, string> = {
  BAD_REQUEST: "The request was malformed or missing required fields.",
  NOT_FOUND: "The requested resource was not found.",
  UNAUTHORIZED: "Authentication is required for this operation.",
  RATE_LIMITED: "Rate limit exceeded. Please retry later.",
  UPSTREAM_FAILURE: "An upstream service failed to respond as expected.",
  INTERNAL: "An internal server error occurred.",
};

/**
 * Reduce an arbitrary thrown value to a wire-safe `{code,message}` pair.
 *
 * - `PublicError` instances pass through unchanged.
 * - Everything else is logged via the structured logger (so operators can
 *   see the real failure) and reported externally as an opaque `INTERNAL`
 *   error.
 *
 * @param err Anything thrown — typed `unknown` since `catch` clauses are
 *            `unknown` under `useUnknownInCatchVariables`.
 * @returns Public-safe `{code, message}` ready to embed in a JSON-RPC error
 *          envelope or HTTP response body.
 */
import { logger } from "../shared/logger.js";

export function toPublicError(err: unknown): { code: PublicErrorCode; message: string } {
  if (err instanceof PublicError) {
    return { code: err.code, message: err.message };
  }
  logger.error("internal error", {
    error: err instanceof Error ? err.message : String(err),
  });
  return { code: "INTERNAL", message: DEFAULT_MESSAGES.INTERNAL };
}
