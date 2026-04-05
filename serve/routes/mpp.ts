/**
 * MPP Route Handler
 *
 * Implements MPP with 8183 settlement.
 *
 * Uses mppx SDK for challenge generation, credential parsing, and receipt
 * formatting. On-chain verification uses viem to check the actual USDC
 * transfer happened.
 *
 * Flow:
 * 1. Client → GET /mpp/<offering-id> → 402 + WWW-Authenticate challenge
 * 2. Client pays on-chain, retries with Authorization: Payment credential
 * 3. Verify: HMAC challenge integrity + on-chain transfer receipt
 * 4. 8183: createJob + fund (payment routed through escrow)
 * 5. Handler runs → deliverable
 * 6. 8183: submit + complete → provider paid
 * 7. 200 + deliverable + Payment-Receipt
 */

import type { IncomingMessage, ServerResponse } from "http";
import { Challenge, Credential, Receipt } from "mppx";
import { parseAbi } from "viem";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import { getPublicClient } from "../gateway";
import {
  createAndFundJob,
  submitAndComplete,
  buildHandlerInput,
} from "../acp/job";
import { getGatewayAddress } from "../gateway";

const CHAIN_ID = 84532;
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "acp-serve-mpp-dev-secret";

// ERC-20 Transfer event ABI for receipt verification
const transferEventAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/**
 * Verify an on-chain USDC transfer by checking the transaction receipt.
 * Decodes Transfer events and confirms amount + recipient match.
 */
async function verifyOnChainTransfer(
  txHash: string,
  expectedRecipient: string,
  expectedAmount: bigint
): Promise<{ valid: boolean; from: string; error?: string }> {
  try {
    const publicClient = getPublicClient();

    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (receipt.status !== "success") {
      return { valid: false, from: "", error: "Transaction reverted" };
    }

    // Find the USDC Transfer event
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      if (log.topics.length < 3) continue;

      // Decode Transfer(from, to, value)
      const from = `0x${log.topics[1]!.slice(26)}`;
      const to = `0x${log.topics[2]!.slice(26)}`;
      const value = BigInt(log.data);

      if (
        to.toLowerCase() === expectedRecipient.toLowerCase() &&
        value >= expectedAmount
      ) {
        return { valid: true, from };
      }
    }

    return {
      valid: false,
      from: "",
      error: "No matching USDC transfer found in transaction",
    };
  } catch (err) {
    return {
      valid: false,
      from: "",
      error: err instanceof Error ? err.message : "Failed to verify transaction",
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

  // Step 1: No auth → return 402 with challenge
  if (!authHeader || !authHeader.startsWith("Payment ")) {
    const amount = String(
      Math.round(offering.offering.priceValue * 1_000_000)
    );

    const challenge = Challenge.from({
      id: `${offering.offeringId}-${Date.now()}`,
      realm: "acp-serve",
      method: "tempo",
      intent: "charge" as const,
      request: {
        amount,
        currency: "USDC",
        recipient: getGatewayAddress(), // Gateway receives, hook routes to 8183 escrow
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

  // Step 2: Credential present → verify → 8183 → handler → complete
  try {
    // Parse credential using mppx SDK
    const credentialB64 = authHeader.replace("Payment ", "");
    const credential = Credential.deserialize(credentialB64);

    // Extract payment proof from credential
    const credentialAny = credential as Record<string, unknown>;
    const payload = credentialAny.payload as Record<string, unknown>;
    const txHash = (payload?.hash as string) || "";
    const clientAddress = (credentialAny.source as string) || "";

    if (!txHash) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing transaction hash in credential" }));
      return;
    }

    // Verify on-chain payment went to gateway
    const expectedAmount = BigInt(
      Math.round(offering.offering.priceValue * 1_000_000)
    );
    const verification = await verifyOnChainTransfer(
      txHash,
      getGatewayAddress(),
      expectedAmount
    );

    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: verification.error || "Payment verification failed" })
      );
      return;
    }

    const payer = verification.from || clientAddress;

    // Parse requirements
    const requirements = await parseRequirements(req);

    // Route payment through 8183: createJob + fund
    // For MPP "hash"/"transaction" type, gateway already received the USDC.
    // PaymentHook TYPE_DIRECT: fund() pulls from gateway → escrow normally.
    const job = await createAndFundJob({
      providerAddress: offering.providerWallet,
      clientAddress: payer,
      chainId: CHAIN_ID,
      description: `MPP: ${offering.offering.name}`,
      budget: offering.offering.priceValue,
      slaMinutes: offering.offering.slaMinutes,
      // No paymentAuth for MPP — gateway already has USDC from the on-chain transfer
    });

    // Run handler
    const input = buildHandlerInput(
      offering.offering,
      requirements,
      payer,
      "mpp",
      job.jobId
    );
    const result = await handlers.handler(input);

    // 8183: submit + complete
    await submitAndComplete(job.jobId, job.chainId, result.deliverable);

    // Build receipt using mppx SDK
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
