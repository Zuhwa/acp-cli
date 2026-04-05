/**
 * MPP Middleware
 *
 * Wraps a handler with MPP payment gating.
 * Verification and settlement all in one process.
 *
 * Flow:
 * 1. No auth → 402 + WWW-Authenticate challenge
 * 2. Credential present → verify (on-chain receipt) → run handler
 *    → settle via 8183 → 200 + deliverable + Payment-Receipt
 */

import type { IncomingMessage, ServerResponse } from "http";
import { Challenge, Receipt } from "mppx";
import type { DeployedOffering } from "../../types";
import type { LoadedHandlers } from "../../runtime/loader";
import { verifyMPPPayment } from "../facilitator/mpp";
import { settleVia8183 } from "../acp/job";
import { buildHandlerInput } from "./shared";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");

export async function handleMPP(
  req: IncomingMessage,
  res: ServerResponse,
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<void> {
  const authHeader = req.headers["authorization"] as string | undefined;

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

    res.writeHead(402, {
      "Content-Type": "application/json",
      "WWW-Authenticate": Challenge.serialize(challenge),
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  try {
    const credentialData = authHeader.replace("Payment ", "");

    // Verify payment (embedded)
    const verification = await verifyMPPPayment(credentialData);
    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error || "Payment verification failed" }));
      return;
    }

    // Run handler
    const requirements = await parseRequirements(req);
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

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Payment-Receipt": Receipt.serialize(receipt),
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
