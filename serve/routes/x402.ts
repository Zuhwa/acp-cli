/**
 * x402 Route Handler
 *
 * Implements x402 protocol with 8183 settlement.
 *
 * The client's signed payment is verified by the x402 SDK (real signature
 * check, balance check, on-chain simulation). Instead of settling via bare
 * transfer, the payment is routed through 8183 escrow.
 *
 * Flow:
 * 1. Client → GET /x402/<offering-id> → 402 + payment requirements
 * 2. Client signs payment, retries with PAYMENT-SIGNATURE header
 * 3. x402 SDK verifies signature + balance + simulates tx
 * 4. 8183: createJob + fund (payment routed through escrow)
 * 5. Handler runs → deliverable
 * 6. 8183: submit + complete → provider paid
 * 7. 200 + deliverable + PAYMENT-RESPONSE
 */

import type { IncomingMessage, ServerResponse } from "http";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
// PaymentPayload and PaymentRequirements types from x402
// Using Record for flexibility since exact types vary by scheme version
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import { getFacilitatorSigner } from "../facilitator/index";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";
import { getGatewayAddress } from "../gateway";

const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Build payment requirements for the 402 response.
 */
function buildPaymentRequirements(offering: DeployedOffering): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: String(
      Math.round(offering.offering.priceValue * 1_000_000)
    ),
    amount: String(Math.round(offering.offering.priceValue * 1_000_000)),
    resource: `/x402/${offering.offeringId}`,
    description: offering.offering.description,
    payTo: getGatewayAddress(), // Gateway receives payment, hook routes to 8183 escrow atomically
    asset: USDC_ADDRESS,
    maxTimeoutSeconds: offering.offering.slaMinutes * 60,
    extra: {},
  };
}

/**
 * Build the PAYMENT-REQUIRED header for the 402 response.
 */
function buildPaymentRequiredHeader(offering: DeployedOffering): string {
  const payload = {
    x402Version: 2,
    accepts: [buildPaymentRequirements(offering)],
    error: "Payment required",
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
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

  // Step 1: No payment → return 402
  if (!paymentSignature) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "Payment-Required": buildPaymentRequiredHeader(offering),
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  // Step 2: Payment present → verify → 8183 → handler → complete
  try {
    // Decode payment signature
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(
        Buffer.from(paymentSignature, "base64").toString()
      );
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid payment signature encoding" }));
      return;
    }

    // Verify using x402 SDK — checks signature, balance, simulates tx
    const signer = getFacilitatorSigner();
    const facilitatorScheme = new ExactEvmScheme(signer);
    const requirements = buildPaymentRequirements(offering);
    const verifyResult = await facilitatorScheme.verify(payload as any, requirements as any);

    if (!verifyResult.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: verifyResult.invalidReason || "Payment verification failed",
        })
      );
      return;
    }

    // Extract client address from payment payload
    const payloadAny = payload as Record<string, unknown>;
    const authPayload = payloadAny.payload as Record<string, unknown>;
    const clientAddress =
      (authPayload?.authorization as Record<string, unknown>)?.from as string ||
      authPayload?.from as string ||
      "0xUnknownClient";

    // Parse requirements from request
    const requirements_data = await parseRequirements(req);

    // Route payment through 8183: createJob + fund
    // The client's EIP-3009 authorization is passed as paymentAuth.
    // PaymentHook executes it during fund(): client → gateway → escrow (atomic)
    const job = await createAndFundJob({
      providerAddress: offering.providerWallet,
      clientAddress,
      chainId: CHAIN_ID,
      description: `x402: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
      paymentAuth: JSON.stringify(payload),
    });

    // Run handler
    const input = buildHandlerInput(
      offering.offering,
      requirements_data,
      clientAddress,
      "x402",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: submit + complete
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // No separate settle() needed — the PaymentHook already executed the
    // client's authorization atomically during fund(). USDC already moved:
    //   client → gateway → escrow → provider (on complete)

    // Return deliverable with payment response
    const paymentResponse = Buffer.from(
      JSON.stringify({
        success: true,
        network: NETWORK,
        payer: clientAddress,
        jobId: job.jobId,
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

async function parseRequirements(
  req: IncomingMessage
): Promise<Record<string, unknown> | string> {
  if (req.method === "POST") {
    const body = await readBody(req);
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
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
