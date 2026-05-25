/**
 * Security regression suite. Each `describe` block corresponds to one finding
 * in the audit report. Tests are written RED-first; each is expected to fail
 * against the un-patched code and pass after the targeted remediation lands.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

// Ensure beacon config loads with sane test defaults BEFORE importing buildApp.
process.env["PORT"] = "3999";
process.env["BEACON_BASE_URL"] = process.env["BEACON_BASE_URL"] ?? "http://localhost";
process.env["ALLOWED_HOSTS"] = process.env["ALLOWED_HOSTS"] ?? "localhost,127.0.0.1";
// Guarantee the SSRF guard is active for the webhook test — the dev escape
// hatch must never bypass security regression coverage.
process.env["HUNTER_ALLOW_INSECURE_WEBHOOK"] = "false";
// No ANTHROPIC_API_KEY -> scoring falls back to offline; no X402_PAY_TO -> payment disabled.

let app: Express;

beforeAll(async () => {
  const mod = await import("../../src/beacon/server.js");
  app = await mod.buildApp();
});

const JSONRPC = (method: string, params: unknown, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("[HIGH] A2A score path enforces request size cap", () => {
  it("rejects oversized job_description on /a2a", async () => {
    const huge = "a".repeat(20_000);
    const res = await request(app)
      .post("/a2a")
      .set("Content-Type", "application/json")
      .send(
        JSONRPC("message/send", {
          message: {
            kind: "message",
            role: "user",
            messageId: "test",
            parts: [{ kind: "text", text: `score: ${huge}` }],
          },
        }),
      );
    // Beacon must NOT happily forward 20KB to Claude — surfaces a refusal.
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/too long|exceeds|BAD_REQUEST|Error/i);
  });
});

describe("[HIGH] MCP score tool enforces job_description size cap", () => {
  it("registers a max-length constraint on the MCP score tool", async () => {
    // Source-level check: the inline Zod schema in mcp-server.ts must impose
    // an upper bound on job_description (prevents unbounded forwarding to the
    // LLM). A full MCP transport handshake test is intentionally avoided —
    // it would couple this suite to the SDK's evolving session semantics.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../src/beacon/mcp-server.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/job_description:\s*z\.string\(\)[^,]*\.max\(/);
  });
});

describe("[HIGH] Rate limit on /a2a and /mcp", () => {
  it("returns 429 after rapid burst on /a2a", async () => {
    const fire = () =>
      request(app)
        .post("/a2a")
        .set("Content-Type", "application/json")
        .send(JSONRPC("tasks/get", { id: "x" }));
    let saw429 = false;
    for (let i = 0; i < 120; i++) {
      const r = await fire();
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

describe("[MEDIUM] Security headers present", () => {
  it("/healthz advertises common helmet headers", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
  });
});

describe("[MEDIUM] /healthz does not leak network/chain detail", () => {
  it("omits payment.network when payment is disabled", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.payment).toEqual({ enabled: false });
  });
});

describe("[MEDIUM] CORS policy is explicit (not wildcard)", () => {
  it("does not echo wildcard origin", async () => {
    const res = await request(app)
      .options("/a2a")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    // Either CORS is locked down (no ACAO header / specific origin), or it is
    // explicit. Wildcard is forbidden.
    const acao = res.headers["access-control-allow-origin"];
    expect(acao).not.toBe("*");
  });
});

describe("[MEDIUM] Hunter alert webhook rejects SSRF targets", () => {
  it("refuses http:// and private-IP webhook URLs", async () => {
    const { sendAlert } = await import("../../src/hunter/alert.js");
    await expect(
      sendAlert({
        webhookUrl: "http://169.254.169.254/latest/meta-data/",
        jobs: [
          {
            source: "test",
            externalId: "1",
            title: "t",
            company: "c",
            url: "https://example.com",
            postedAt: new Date().toISOString(),
            description: "",
            raw: {},
            score: 80,
            recommendation: "pursue",
            breakdown: {},
            summary: "",
            dealbreakers: { passed: true, hits: [] },
          } as never,
        ],
      }),
    ).rejects.toThrow(/webhook|url|scheme|host/i);
  });
});

describe("[LOW] Express JSON body cap tightened", () => {
  it("rejects > 64KB POST body to /a2a", async () => {
    const payload = { junk: "x".repeat(80_000) };
    const res = await request(app)
      .post("/a2a")
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
