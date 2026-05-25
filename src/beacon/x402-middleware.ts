import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  createPaymentWrapper,
  x402ResourceServer,
  type MCPToolCallback,
  type PaymentWrappedHandler,
} from "@x402/mcp";

import { config } from "./config.js";

/**
 * A function that wraps an MCP tool handler with x402 payment gating.
 *
 * Returned by {@link buildPaymentWrapper}. When payment is configured the
 * wrapper enforces an HTTP 402-equivalent flow over MCP's `_meta` channel
 * (per the `@x402/mcp` integration). When payment is NOT configured the
 * wrapper is a transparent identity function — the same code path runs in
 * dev without forcing every contributor to set up a wallet.
 */
export type PaymentWrap = <TArgs extends Record<string, unknown>>(
  handler: PaymentWrappedHandler<TArgs>,
) => MCPToolCallback<TArgs>;

/** Identity wrapper used when payment is disabled. */
const passthrough: PaymentWrap = (handler) =>
  handler as unknown as MCPToolCallback<Record<string, unknown>>;

/**
 * Build the payment wrapper for premium MCP tools.
 *
 * When `X402_PAY_TO` is set in the environment, returns a wrapper that
 * gates the wrapped tool behind a USDC payment on the configured network
 * (default: Base Sepolia). When unset, returns a no-op so local development
 * stays friction-free.
 *
 * The function is async because the underlying `x402ResourceServer.initialize()`
 * fetches scheme metadata from the facilitator on first use.
 *
 * @returns The wrapper plus a flag indicating whether gating is live.
 */
export async function buildPaymentWrapper(): Promise<{
  paid: PaymentWrap;
  enabled: boolean;
}> {
  if (config.X402_PAY_TO === undefined) {
    return { paid: passthrough, enabled: false };
  }

  const facilitator = new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator);
  resourceServer.register(config.X402_NETWORK, new ExactEvmScheme());
  await resourceServer.initialize();

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: config.X402_NETWORK,
    payTo: config.X402_PAY_TO,
    price: config.X402_SCORE_PRICE,
  });

  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      description:
        "humancard premium scoring — Claude-backed weighted match against the candidate's profile.",
      mimeType: "application/json",
    },
  }) as PaymentWrap;

  return { paid, enabled: true };
}
