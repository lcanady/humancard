import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { loadProfile } from "../profile.js";
import { logger } from "../shared/logger.js";
import { mountA2A } from "./a2a-server.js";
import { config } from "./config.js";
import { mountMcp } from "./mcp-server.js";
import { buildPaymentWrapper } from "./x402-middleware.js";

/**
 * Build the fully-wired Beacon Express app.
 *
 * Exported separately from {@link main} so tests can `await buildApp()` and
 * exercise the surface without binding to a port.
 */
export async function buildApp(): Promise<Express> {
  const profile = await loadProfile();
  const { paid, enabled: paymentEnabled } = await buildPaymentWrapper();
  const app: Express = express();

  // Standard hardening headers (HSTS, nosniff, frame-options, referrer-policy).
  app.use(helmet());

  // Explicit CORS allowlist — never wildcard. CORS is disabled by default
  // (no `Access-Control-Allow-Origin` emitted); operators opt in via
  // BEACON_CORS_ORIGINS (comma-separated). The well-known JSON endpoints
  // remain publicly fetchable because cross-origin GETs without ACAO are
  // still permitted by browsers as opaque responses (server-to-server is
  // unaffected by CORS entirely).
  const corsOrigins = (process.env["BEACON_CORS_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: false }));
  }

  // Tight JSON body cap — JD payloads and JSON-RPC envelopes are all small.
  app.use(express.json({ limit: "64kb" }));

  // Per-IP rate limit on the RPC surfaces. Tuned for legitimate batched
  // clients (≈ 1 RPS sustained) while shutting down brute/abuse loops.
  const rpcLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests." } },
  });
  app.use("/a2a", rpcLimiter);
  app.use("/mcp", rpcLimiter);

  app.get("/healthz", (_req: Request, res: Response) => {
    // Intentionally minimal: do NOT leak network/chain identifiers from an
    // unauthenticated endpoint. Operators can introspect via logs.
    res.status(200).json({
      status: "ok",
      payment: { enabled: paymentEnabled },
    });
  });

  mountMcp(app, profile, paid);
  mountA2A(app, profile);

  return app;
}

/**
 * Boot the Beacon HTTP server and bind to `config.PORT`.
 */
async function main(): Promise<void> {
  const app = await buildApp();
  app.listen(config.PORT, () => {
    logger.info("beacon listening", {
      baseUrl: config.BEACON_BASE_URL,
      port: config.PORT,
      endpoints: [
        "/healthz",
        "/.well-known/agent-card.json",
        "/.well-known/agent.json",
        "/mcp",
        "/a2a",
      ],
    });
  });
}

// Only auto-start when invoked directly (not when imported by tests).
const isEntry = (() => {
  try {
    const argvHref = new URL(`file://${process.argv[1] ?? ""}`).href;
    return import.meta.url === argvHref;
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((err: unknown) => {
    logger.error("beacon fatal startup error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
