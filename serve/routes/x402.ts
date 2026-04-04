/**
 * x402 Route Handler
 *
 * Implements x402 protocol with 8183 settlement.
 *
 * Key difference from vanilla x402: instead of the facilitator doing a bare
 * ERC-20 transfer on settle, we route the payment through 8183 escrow.
 * The client's signed payment authorization funds the 8183 job.
 *
 * Flow:
 * 1. Client → GET /x402/<offering-id> → 402 + payment requirements
 * 2. Client signs payment, retries with PAYMENT-SIGNATURE header
 * 3. Facilitator verifies signature (x402 SDK)
 * 4. Settlement: createJob + fund via 8183 (instead of bare transfer)
 * 5. Handler runs → deliverable returned
 * 6. 8183: submit + complete → escrow released to provider
 * 7. 200 + deliverable + PAYMENT-RESPONSE
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";

// x402 SDK imports
// The facilitator verify/settle will be wired here once we set up
// the viem client + signer for the gateway's wallet.
//
// import { x402Facilitator } from "@x402/core/facilitator";
// import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
// import { toFacilitatorEvmSigner } from "@x402/evm";
//
// For the server (402 response building):
// import { x402ResourceServer } from "@x402/core/server";
// import { registerExactEvmScheme as registerServerScheme } from "@x402/evm/exact/server";

const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

/**
 * Build the PAYMENT-REQUIRED header for a 402 response.
 *
 * In production, this would use x402ResourceServer.buildPaymentRequirements()
 * which handles network detection, asset resolution, and facilitator capabilities.
 */
function buildPaymentRequired(offering: DeployedOffering): string {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
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

/**
 * Verify and settle an x402 payment through 8183.
 *
 * This is where we diverge from vanilla x402:
 * - verify() uses the x402 SDK to check the signature is valid
 * - Instead of calling facilitator.settle() (bare transfer),
 *   we call createAndFundJob() to route funds through 8183
 *
 * TODO: Wire x402 facilitator SDK for real signature verification.
 * Requires a viem WalletClient + PublicClient for the gateway's wallet:
 *
 *   const signer = toFacilitatorEvmSigner(walletClient, publicClient);
 *   const facilitator = new x402Facilitator();
 *   registerExactEvmScheme(facilitator, { signer, networks: NETWORK });
 *   const verifyResult = await facilitator.verify(payload, requirements);
 */
async function verifyAndSettle(
  paymentSignature: string,
  offering: DeployedOffering
): Promise<{ valid: boolean; clientAddress: string; error?: string }> {
  try {
    // Decode the payment signature
    const decoded = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString()
    );

    // TODO: Replace with real x402 SDK verification:
    // const verifyResult = await facilitator.verify(decoded, paymentRequirements);
    // if (!verifyResult.isValid) return { valid: false, error: verifyResult.invalidReason };

    // Extract client address from the payment payload
    const clientAddress =
      decoded.payload?.authorization?.from ||
      decoded.payload?.from ||
      "0xUnknownClient";

    // Settlement happens via 8183 (createAndFundJob), not here.
    // The x402 payment authorization will be used to fund the 8183 escrow.

    return { valid: true, clientAddress };
  } catch (err) {
    return {
      valid: false,
      clientAddress: "",
      error: err instanceof Error ? err.message : "Payment verification failed",
    };
  }
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

  // Step 1: No payment → return 402 with price
  if (!paymentSignature) {
    const paymentRequired = buildPaymentRequired(offering);
    res.writeHead(402, {
      "Content-Type": "application/json",
      "Payment-Required": paymentRequired,
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  // Step 2: Payment present → verify, settle via 8183, run handler
  try {
    // Verify the x402 payment signature
    const verification = await verifyAndSettle(paymentSignature, offering);
    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error || "Payment verification failed" }));
      return;
    }

    // Parse requirements from request
    const requirements = await parseRequirements(req);

    // Route payment through 8183: createJob + fund
    const job = await createAndFundJob({
      providerAddress: offering.providerWallet,
      clientAddress: verification.clientAddress,
      chainId: CHAIN_ID,
      description: `x402: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
    });

    // Run the developer's handler
    const input = buildHandlerInput(
      offering.offering,
      requirements,
      verification.clientAddress,
      "x402",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: submit deliverable + complete (gateway is evaluator)
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // Return deliverable with x402 payment response
    const paymentResponse = Buffer.from(
      JSON.stringify({
        success: true,
        network: NETWORK,
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
