/**
 * MPP Middleware (Hono)
 *
 * Returns a Hono handler that wraps a request with MPP payment gating.
 * Verification and settlement embedded in one process.
 */

import type { Context } from "hono";
import { Challenge, Receipt } from "mppx";
import type { DeployedOffering } from "../../types";
import type { LoadedHandlers } from "../../runtime/loader";
import { verifyMPPPayment } from "../facilitator/mpp";
import { settleVia8183 } from "../acp/job";
import { buildHandlerInput } from "./shared";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");

export function mppMiddleware(offering: DeployedOffering, handlers: LoadedHandlers) {
  return async (c: Context) => {
    const authHeader = c.req.header("authorization");

    // No auth → 402 with challenge
    if (!authHeader || !authHeader.startsWith("Payment ")) {
      const challenge = Challenge.from({
        id: `${offering.offeringId}-${Date.now()}`,
        realm: "acp-serve",
        method: "tempo",
        intent: "charge" as const,
        request: {
          amount: String(Math.round(offering.offering.priceValue * 1_000_000)),
          currency: "USDC",
          recipient: offering.providerWallet,
          methodDetails: { chainId: CHAIN_ID },
        },
      });

      return c.json({ error: "Payment required" }, 402, {
        "WWW-Authenticate": Challenge.serialize(challenge),
        "Cache-Control": "no-store",
      });
    }

    try {
      const credentialData = authHeader.replace("Payment ", "");

      // Verify (embedded)
      const verification = await verifyMPPPayment(credentialData);
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
      const input = buildHandlerInput(offering, requirements, verification.clientAddress, "mpp");
      const result = await handlers.handler(input);

      // Settle via 8183
      const settlement = await settleVia8183({
        providerAddress: offering.providerWallet,
        clientAddress: verification.clientAddress,
        paymentData: credentialData,
        deliverable: result.deliverable,
        description: `MPP: ${offering.offering.name}`,
        budget: offering.offering.priceValue,
        slaMinutes: offering.offering.slaMinutes,
      });

      // Return deliverable with receipt
      const receipt = Receipt.from({
        method: "tempo",
        reference: settlement.jobId,
        timestamp: new Date().toISOString(),
        status: "success",
      });

      return c.json({ deliverable: result.deliverable }, 200, {
        "Payment-Receipt": Receipt.serialize(receipt),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  };
}
