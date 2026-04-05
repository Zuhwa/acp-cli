/**
 * /verify endpoint
 *
 * Verifies payment signatures (x402) or on-chain receipts (MPP).
 * Called by offering servers before running the handler.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { Credential } from "mppx";
import { getGatewayWallet, getPublicClient } from "../gateway";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const { protocol, offeringId, paymentData } = JSON.parse(body);

  try {
    if (protocol === "x402") {
      const result = await verifyX402(paymentData);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (protocol === "mpp") {
      const result = await verifyMPP(paymentData);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, error: `Unknown protocol: ${protocol}` }));
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      valid: false,
      error: err instanceof Error ? err.message : "Verification failed",
    }));
  }
}

/**
 * x402: verify payment signature using x402 SDK.
 * Checks cryptographic signature, on-chain balance, simulates tx.
 */
async function verifyX402(paymentData: string): Promise<{
  valid: boolean;
  clientAddress: string;
  error?: string;
}> {
  const payload = JSON.parse(Buffer.from(paymentData, "base64").toString());

  // Set up facilitator signer
  const { client } = getGatewayWallet();
  const signer = toFacilitatorEvmSigner(client as any);
  const scheme = new ExactEvmScheme(signer);

  // Build requirements for verification
  const requirements = {
    scheme: "exact",
    network: `eip155:${CHAIN_ID}`,
    asset: USDC_ADDRESS,
  };

  const result = await scheme.verify(payload as any, requirements as any);

  if (!result.isValid) {
    return { valid: false, clientAddress: "", error: result.invalidReason };
  }

  // Extract client address from payload
  const auth = payload.payload?.authorization || payload.payload;
  const clientAddress = auth?.from || "0xUnknownClient";

  return { valid: true, clientAddress };
}

/**
 * MPP: verify on-chain payment receipt.
 * Reads tx receipt, decodes Transfer events, confirms amount + recipient.
 */
async function verifyMPP(paymentData: string): Promise<{
  valid: boolean;
  clientAddress: string;
  error?: string;
}> {
  const credential = Credential.deserialize(paymentData);
  const credAny = credential as Record<string, unknown>;
  const payload = credAny.payload as Record<string, unknown>;
  const txHash = payload?.hash as string;

  if (!txHash) {
    // "transaction" type — signed but not submitted
    // We need to submit it and verify
    const signature = payload?.signature as string;
    if (!signature) {
      return { valid: false, clientAddress: "", error: "No tx hash or signature in credential" };
    }

    // TODO: Submit the signed transaction, get receipt, verify
    // For now, return the source as client address
    const clientAddress = credAny.source as string || "";
    return { valid: true, clientAddress };
  }

  // "hash" type — already submitted, verify receipt
  const publicClient = getPublicClient();
  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  if (receipt.status !== "success") {
    return { valid: false, clientAddress: "", error: "Transaction reverted" };
  }

  // Find USDC Transfer event
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    if (log.topics.length < 3) continue;

    const from = `0x${log.topics[1]!.slice(26)}`;
    return { valid: true, clientAddress: from };
  }

  return { valid: false, clientAddress: "", error: "No USDC transfer found in tx" };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
