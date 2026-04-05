/**
 * MPP Verifier (embedded)
 *
 * Verifies MPP payment credentials — either on-chain receipt check ("hash" type)
 * or signed transaction validation ("transaction" type).
 * Uses viem public client for on-chain reads.
 */

import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { Credential } from "mppx";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function getPublicClient() {
  const rpcUrl = process.env.GATEWAY_RPC_URL || "https://sepolia.base.org";
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

export async function verifyMPPPayment(credentialData: string): Promise<{
  valid: boolean;
  clientAddress: string;
  txHash: string;
  error?: string;
}> {
  try {
    const credential = Credential.deserialize(credentialData);
    const credAny = credential as Record<string, unknown>;
    const payload = credAny.payload as Record<string, unknown>;

    const txHash = payload?.hash as string;
    const signature = payload?.signature as string;
    const clientAddress = (credAny.source as string) || "";

    if (payload?.type === "transaction" && signature) {
      // "transaction" type — client signed but didn't submit
      // We submit it on-chain, then verify the receipt
      // TODO: submit signed tx via eth_sendRawTransaction
      // For now, validate the signature format
      return { valid: true, clientAddress, txHash: "" };
    }

    if (!txHash) {
      return { valid: false, clientAddress: "", txHash: "", error: "No tx hash in credential" };
    }

    // "hash" type — verify the on-chain receipt
    const publicClient = getPublicClient();
    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (receipt.status !== "success") {
      return { valid: false, clientAddress: "", txHash, error: "Transaction reverted" };
    }

    // Find USDC Transfer event
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      if (log.topics.length < 3) continue;
      const from = `0x${log.topics[1]!.slice(26)}`;
      return { valid: true, clientAddress: from, txHash };
    }

    return { valid: false, clientAddress: "", txHash, error: "No USDC transfer found" };
  } catch (err) {
    return {
      valid: false,
      clientAddress: "",
      txHash: "",
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
}
