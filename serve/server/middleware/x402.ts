/**
 * x402 Middleware
 *
 * Wraps a handler with x402 payment gating.
 * Facilitator logic is embedded — verify + settle all in one process.
 *
 * Flow:
 * 1. No payment → 402 + PAYMENT-REQUIRED
 * 2. Payment present → verify (embedded facilitator) → run handler
 *    → settle via 8183 → 200 + deliverable
 */

import type { IncomingMessage, ServerResponse } from "http";
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
        maxAmountRequired: String(
          Math.round(offering.offering.priceValue * 1_000_000)
        ),
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

export async function handleX402(
  req: IncomingMessage,
  res: ServerResponse,
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<void> {
  const paymentSignature = req.headers["payment-signature"] as string | undefined;

  if (!paymentSignature) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "Payment-Required": buildPaymentRequiredHeader(offering),
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  try {
    // Verify payment (embedded facilitator)
    const verification = await verifyX402Payment(paymentSignature);
    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error || "Payment verification failed" }));
      return;
    }

    // Run handler
    const requirements = await parseRequirements(req);
    const input = buildHandlerInput(offering, requirements, verification.clientAddress, "x402");
    const result = await handlers.handler(input);

    // Settle via 8183 (createJob → fund → submit → complete)
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

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Payment-Response": paymentResponse,
    });
    res.end(JSON.stringify({ deliverable: result.deliverable }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
  }
}

async function parseRequirements(req: IncomingMessage): Promise<Record<string, unknown> | string> {
  if (req.method === "POST") {
    const body = await readBody(req);
    try { return JSON.parse(body); } catch { return body; }
  }
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (params[k] = v));
  return Object.keys(params).length > 0 ? params : {};
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
