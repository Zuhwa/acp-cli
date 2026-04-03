/**
 * x402 Route Handler
 *
 * Implements the full x402 protocol flow:
 *
 * 1. Client hits GET /x402/<offering-id> with no payment
 *    → Returns 402 + PAYMENT-REQUIRED header (price, token, payTo)
 *
 * 2. Client signs payment off-chain, retries with PAYMENT-SIGNATURE header
 *    → Facilitator verifies signature + balance
 *    → 8183: createJob + setBudget + fund (escrow locked)
 *    → Handler runs (requirements → deliverable)
 *    → 8183: submit + complete (escrow released to provider)
 *    → Facilitator settles x402 payment on-chain
 *    → Returns 200 + deliverable + PAYMENT-RESPONSE header
 *
 * The developer's handler.ts is the only custom code. Everything else
 * (x402 protocol, 8183 escrow, payment settlement) is handled here.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput } from "../types";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CHAIN_ID = 84532;

/**
 * Build the PAYMENT-REQUIRED header value for a 402 response.
 * This tells the x402 client what to pay.
 */
function buildPaymentRequired(offering: DeployedOffering): string {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CHAIN_ID}`,
        maxAmountRequired: String(
          Math.round(offering.offering.priceValue * 1_000_000)
        ), // USDC 6 decimals
        resource: `/x402/${offering.offeringId}`,
        description: offering.offering.description,
        payTo: offering.providerWallet,
        asset: USDC_BASE_SEPOLIA,
        maxTimeoutSeconds: offering.offering.slaMinutes * 60,
      },
    ],
    error: "Payment required",
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Verify an x402 payment signature.
 * In production, this calls the facilitator's /verify endpoint.
 */
async function verifyPayment(
  paymentSignature: string,
  offering: DeployedOffering
): Promise<{ valid: boolean; clientAddress: string; error?: string }> {
  // TODO: Integrate with x402 facilitator
  // 1. Decode PAYMENT-SIGNATURE header (base64 → JSON)
  // 2. POST to facilitator /verify with payment payload + requirements
  // 3. Facilitator checks: signature valid, balance sufficient, simulates tx
  // 4. Return { isValid, invalidReason }

  // Placeholder — accepts all payments for development
  console.log("[x402] Verifying payment signature...");
  return { valid: true, clientAddress: "0xClient" };
}

/**
 * Settle an x402 payment on-chain.
 * In production, this calls the facilitator's /settle endpoint.
 */
async function settlePayment(
  paymentSignature: string,
  offering: DeployedOffering
): Promise<{ txHash: string }> {
  // TODO: Integrate with x402 facilitator
  // 1. POST to facilitator /settle with payment payload
  // 2. Facilitator submits transferWithAuthorization (EIP-3009) on-chain
  // 3. Returns { success, txHash, networkId }

  console.log("[x402] Settling payment on-chain...");
  return { txHash: "0xplaceholder" };
}

/**
 * Handle an x402 request for a specific offering.
 */
export async function handleX402Request(
  req: IncomingMessage,
  res: ServerResponse,
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<void> {
  const paymentSignature = req.headers["payment-signature"] as string | undefined;

  // Step 1: No payment header → return 402
  if (!paymentSignature) {
    const paymentRequired = buildPaymentRequired(offering);
    res.writeHead(402, {
      "Content-Type": "application/json",
      "Payment-Required": paymentRequired,
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  // Step 2: Payment header present → verify + execute + settle
  try {
    // Verify payment
    const verification = await verifyPayment(paymentSignature, offering);
    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error || "Payment verification failed" }));
      return;
    }

    // Parse requirements from request body or query
    let requirements: Record<string, unknown> | string = {};
    if (req.method === "POST") {
      const body = await readBody(req);
      try {
        requirements = JSON.parse(body);
      } catch {
        requirements = body;
      }
    } else {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (params[k] = v));
      if (Object.keys(params).length > 0) requirements = params;
    }

    // 8183: Create job + fund escrow
    const job = await createAndFundJob({
      providerAddress: offering.providerWallet,
      clientAddress: verification.clientAddress,
      chainId: CHAIN_ID,
      description: `x402: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
    });

    // Run handler
    const input = buildHandlerInput(
      offering.offering,
      requirements,
      verification.clientAddress,
      "x402",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: Submit deliverable + auto-complete
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // Settle x402 payment on-chain
    const settlement = await settlePayment(paymentSignature, offering);

    // Return deliverable with payment response
    const paymentResponse = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: settlement.txHash,
        network: `eip155:${CHAIN_ID}`,
        payer: verification.clientAddress,
      })
    ).toString("base64");

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Payment-Response": paymentResponse,
    });
    res.end(JSON.stringify({ deliverable: result.deliverable }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Internal error",
      })
    );
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
