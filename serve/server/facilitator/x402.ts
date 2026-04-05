/**
 * x402 Facilitator (embedded)
 *
 * Verifies x402 payment signatures using the @x402/evm SDK.
 * Runs in the same process as the offering server — no separate service.
 * Uses the deploy signer's wallet for signature verification (on-chain simulation).
 */

import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

let scheme: ExactEvmScheme | null = null;

function getScheme(): ExactEvmScheme {
  if (!scheme) {
    const privateKey = process.env.DEPLOY_SIGNER_KEY || process.env.GATEWAY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("No signer key available for x402 facilitator.");
    }

    const rpcUrl = process.env.GATEWAY_RPC_URL || "https://sepolia.base.org";
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const client = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    }).extend(publicActions);

    const signer = toFacilitatorEvmSigner(client as any);
    scheme = new ExactEvmScheme(signer);
  }
  return scheme;
}

export async function verifyX402Payment(paymentSignature: string): Promise<{
  valid: boolean;
  clientAddress: string;
  payload: Record<string, unknown>;
  error?: string;
}> {
  try {
    const payload = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString()
    );

    const requirements = {
      scheme: "exact",
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_ADDRESS,
    };

    const result = await getScheme().verify(payload as any, requirements as any);

    if (!result.isValid) {
      return { valid: false, clientAddress: "", payload, error: result.invalidReason };
    }

    const auth = payload.payload?.authorization || payload.payload;
    const clientAddress = auth?.from || "0xUnknownClient";

    return { valid: true, clientAddress, payload };
  } catch (err) {
    return {
      valid: false,
      clientAddress: "",
      payload: {},
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
}
