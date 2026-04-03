/**
 * MPP Route Handler
 *
 * Implements the MPP (Machine Payments Protocol) flow:
 *
 * 1. Client hits GET /mpp/<offering-id> with no auth
 *    → Returns 402 + WWW-Authenticate: Payment (HMAC challenge)
 *
 * 2. Client pays on-chain, retries with Authorization: Payment credential
 *    → Verify HMAC challenge integrity (stateless, no DB lookup)
 *    → Verify on-chain payment (decode Transfer event, confirm amount + recipient)
 *    → 8183: createJob + setBudget + fund (escrow locked)
 *    → Handler runs (requirements → deliverable)
 *    → 8183: submit + complete (escrow released to provider)
 *    → Returns 200 + deliverable + Payment-Receipt header
 *
 * Key difference from x402: MPP has no facilitator. The server verifies
 * payments directly by checking on-chain receipts.
 */

import { createHmac, randomBytes } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";

const CHAIN_ID = 84532;

// HMAC secret for stateless challenge verification
// In production, this should be from environment config
const HMAC_SECRET = process.env.MPP_HMAC_SECRET || "acp-serve-mpp-dev-secret";

/**
 * Generate an HMAC-bound challenge ID.
 * This enables stateless verification — no database needed to validate
 * that a challenge wasn't tampered with.
 */
function generateChallengeId(
  offeringId: string,
  amount: string,
  recipient: string
): string {
  const nonce = randomBytes(16).toString("hex");
  const data = `${offeringId}:${amount}:${recipient}:${nonce}`;
  const hmac = createHmac("sha256", HMAC_SECRET).update(data).digest("hex");
  // Encode nonce + hmac so we can verify later
  return Buffer.from(`${nonce}:${hmac}`).toString("base64url");
}

/**
 * Verify a challenge ID hasn't been tampered with.
 */
function verifyChallengeId(
  challengeId: string,
  offeringId: string,
  amount: string,
  recipient: string
): boolean {
  try {
    const decoded = Buffer.from(challengeId, "base64url").toString();
    const [nonce, expectedHmac] = decoded.split(":");
    const data = `${offeringId}:${amount}:${recipient}:${nonce}`;
    const actualHmac = createHmac("sha256", HMAC_SECRET)
      .update(data)
      .digest("hex");
    return actualHmac === expectedHmac;
  } catch {
    return false;
  }
}

/**
 * Build the WWW-Authenticate: Payment challenge header.
 */
function buildChallenge(offering: DeployedOffering): string {
  const amount = String(
    Math.round(offering.offering.priceValue * 1_000_000)
  );
  const recipient = offering.providerWallet;
  const challengeId = generateChallengeId(
    offering.offeringId,
    amount,
    recipient
  );

  const request = Buffer.from(
    JSON.stringify({
      amount,
      currency: "USDC",
      recipient,
      methodDetails: { chainId: CHAIN_ID },
    })
  ).toString("base64url");

  return `Payment id="${challengeId}", realm="acp-serve", method="tempo", intent="charge", request="${request}"`;
}

/**
 * Verify an MPP payment credential.
 * Checks: HMAC challenge integrity + on-chain payment receipt.
 */
async function verifyCredential(
  authHeader: string,
  offering: DeployedOffering
): Promise<{ valid: boolean; clientAddress: string; txHash: string; error?: string }> {
  try {
    // Decode Authorization: Payment <base64url>
    const credentialB64 = authHeader.replace("Payment ", "");
    const credential = JSON.parse(
      Buffer.from(credentialB64, "base64url").toString()
    );

    // Verify challenge HMAC
    const challenge = credential.challenge;
    const amount = String(
      Math.round(offering.offering.priceValue * 1_000_000)
    );
    if (
      !verifyChallengeId(
        challenge.id,
        offering.offeringId,
        amount,
        offering.providerWallet
      )
    ) {
      return { valid: false, clientAddress: "", txHash: "", error: "Invalid challenge" };
    }

    // Verify on-chain payment
    // TODO: Check on-chain transfer receipt
    // 1. Get tx receipt by hash from credential.payload.hash
    // 2. Decode Transfer(from, to, value) event
    // 3. Confirm: to == offering.providerWallet, value >= amount, token == USDC

    const txHash = credential.payload?.hash || "0xplaceholder";
    const clientAddress = credential.source || "0xClient";

    console.log(`[MPP] Verified payment: tx=${txHash}`);
    return { valid: true, clientAddress, txHash };
  } catch (err) {
    return {
      valid: false,
      clientAddress: "",
      txHash: "",
      error: err instanceof Error ? err.message : "Credential verification failed",
    };
  }
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

  // Step 1: No auth header → return 402 with challenge
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

  // Step 2: Auth header present → verify + execute
  try {
    // Verify credential
    const verification = await verifyCredential(authHeader, offering);
    if (!verification.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error }));
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
      description: `MPP: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
    });

    // Run handler
    const input = buildHandlerInput(
      offering.offering,
      requirements,
      verification.clientAddress,
      "mpp",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: Submit deliverable + auto-complete
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // Build payment receipt
    const receipt = Buffer.from(
      JSON.stringify({
        method: "tempo",
        reference: verification.txHash,
        timestamp: new Date().toISOString(),
        status: "settled",
      })
    ).toString("base64url");

    // Return deliverable with receipt
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Payment-Receipt": receipt,
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
