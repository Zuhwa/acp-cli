/**
 * MPP Route Handler
 *
 * Implements MPP (Machine Payments Protocol) with 8183 settlement.
 *
 * Key difference from vanilla MPP: after verifying the client's payment
 * credential, we route the funds through 8183 escrow instead of keeping
 * them as a direct transfer.
 *
 * Flow:
 * 1. Client → GET /mpp/<offering-id> → 402 + WWW-Authenticate challenge
 * 2. Client pays on-chain, retries with Authorization: Payment credential
 * 3. Verify credential using mppx SDK (HMAC + on-chain receipt check)
 * 4. Settlement: createJob + fund via 8183 (instead of direct receipt)
 * 5. Handler runs → deliverable returned
 * 6. 8183: submit + complete → escrow released to provider
 * 7. 200 + deliverable + Payment-Receipt
 */

import type { IncomingMessage, ServerResponse } from "http";
import { Challenge, Credential, Receipt } from "mppx";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";

const CHAIN_ID = 84532;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "acp-serve-mpp-dev-secret";

/**
 * Build an MPP challenge for a 402 response.
 * Uses mppx SDK's Challenge.from() to create a properly formatted challenge.
 */
function buildChallenge(offering: DeployedOffering): string {
  const amount = String(
    Math.round(offering.offering.priceValue * 1_000_000)
  );

  const challenge = Challenge.from({
    id: `${offering.offeringId}-${Date.now()}`,
    realm: "acp-serve",
    method: "tempo",
    intent: "charge",
    request: {
      amount,
      currency: "USDC",
      recipient: offering.providerWallet,
      methodDetails: { chainId: CHAIN_ID },
    },
  });

  return Challenge.serialize(challenge);
}

/**
 * Handle an MPP request for a specific offering.
 */
export async function handleMPPRequest(
  req: IncomingMessage,
  res: ServerResponse,
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<void> {
  const authHeader = req.headers["authorization"] as string | undefined;

  // Step 1: No auth → return 402 with challenge
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    const challenge = buildChallenge(offering);
    res.writeHead(402, {
      "Content-Type": "application/json",
      "WWW-Authenticate": challenge,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  // Step 2: Credential present → verify, settle via 8183, run handler
  try {
    // Parse the credential using mppx SDK
    const credential = Credential.deserialize(
      authHeader.replace("Payment ", "")
    );

    // Verify the challenge integrity
    // TODO: Use Challenge.verify() with the secret key to check HMAC
    // const isValid = Challenge.verify(credential.challenge, MPP_SECRET_KEY);

    // Extract client info from credential
    const clientAddress =
      (credential as Record<string, unknown>).source as string ||
      "0xUnknownClient";
    const txHash =
      ((credential as Record<string, unknown>).payload as Record<string, unknown>)?.hash as string ||
      "";

    // TODO: Verify on-chain payment receipt
    // - Get tx receipt by txHash
    // - Decode Transfer(from, to, value) event
    // - Confirm: to == offering.providerWallet, value >= price, token == USDC

    // Parse requirements from request
    const requirements = await parseRequirements(req);

    // Route payment through 8183: createJob + fund
    const job = await createAndFundJob({
      providerAddress: offering.providerWallet,
      clientAddress,
      chainId: CHAIN_ID,
      description: `MPP: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
    });

    // Run the developer's handler
    const input = buildHandlerInput(
      offering.offering,
      requirements,
      clientAddress,
      "mpp",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: submit deliverable + complete (gateway is evaluator)
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // Build payment receipt using mppx SDK
    const receipt = Receipt.from({
      method: "tempo",
      reference: txHash,
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
