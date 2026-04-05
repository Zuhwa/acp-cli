/**
 * x402 Middleware (Hono)
 *
 * Returns a Hono handler that wraps a request with x402 payment gating.
 * Facilitator logic embedded — verify + settle all in one process.
 */

import type { Context } from "hono";
import type { DeployedOffering } from "../../types";
import type { LoadedHandlers } from "../../runtime/loader";
import { verifyX402Payment } from "../facilitator/x402";
import { settleVia8183 } from "../acp/job";
import { buildHandlerInput } from "./shared";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function buildPaymentRequiredHeader(offering: DeployedOffering): string {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CHAIN_ID}`,
        maxAmountRequired: String(Math.round(offering.offering.priceValue * 1_000_000)),
        resource: `/x402/${offering.offeringId}`,
        description: offering.offering.description,
        payTo: offering.providerWallet,
        asset: USDC_ADDRESS,
        maxTimeoutSeconds: offering.offering.slaMinutes * 60,
      },
    ],
    error: "Payment required",
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function x402Middleware(offering: DeployedOffering, handlers: LoadedHandlers) {
  return async (c: Context) => {
    const paymentSignature = c.req.header("payment-signature");

    // No payment → 402
    if (!paymentSignature) {
      return c.json({ error: "Payment required" }, 402, {
        "Payment-Required": buildPaymentRequiredHeader(offering),
      });
    }

    try {
      // Verify (embedded facilitator)
      const verification = await verifyX402Payment(paymentSignature);
      if (!verification.valid) {
        return c.json({ error: verification.error || "Payment verification failed" }, 402);
      }

      // Parse requirements
      let requirements: Record<string, unknown> | string = {};
      if (c.req.method === "POST") {
        try { requirements = await c.req.json(); } catch { requirements = await c.req.text(); }
      } else {
        const params: Record<string, string> = {};
        new URL(c.req.url).searchParams.forEach((v, k) => (params[k] = v));
        if (Object.keys(params).length > 0) requirements = params;
      }

      // Run handler
      const input = buildHandlerInput(offering, requirements, verification.clientAddress, "x402");
      const result = await handlers.handler(input);

      // Settle via 8183
      const settlement = await settleVia8183({
        providerAddress: offering.providerWallet,
        clientAddress: verification.clientAddress,
        paymentData: paymentSignature,
        deliverable: result.deliverable,
        description: `x402: ${offering.offering.name}`,
        budget: offering.offering.priceValue,
        slaMinutes: offering.offering.slaMinutes,
      });

      // Return deliverable
      const paymentResponse = Buffer.from(
        JSON.stringify({
          success: true,
          network: `eip155:${CHAIN_ID}`,
          payer: verification.clientAddress,
          jobId: settlement.jobId,
        })
      ).toString("base64");

      return c.json({ deliverable: result.deliverable }, 200, {
        "Payment-Response": paymentResponse,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  };
}
