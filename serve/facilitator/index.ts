/**
 * x402 Facilitator
 *
 * Sets up the x402 facilitator EVM signer using the gateway's wallet.
 * toFacilitatorEvmSigner() needs a combined client with both wallet
 * (write) and public (read) capabilities.
 */

import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { toFacilitatorEvmSigner } from "@x402/evm";

let facilitatorSigner: ReturnType<typeof toFacilitatorEvmSigner> | null = null;

export function getFacilitatorSigner() {
  if (!facilitatorSigner) {
    const privateKey = process.env.GATEWAY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("GATEWAY_PRIVATE_KEY is required for x402 facilitator.");
    }

    const rpcUrl = process.env.GATEWAY_RPC_URL || "https://sepolia.base.org";
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    // Combined client with both wallet + public actions
    const client = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    }).extend(publicActions);

    facilitatorSigner = toFacilitatorEvmSigner(client as any);
  }
  return facilitatorSigner;
}
