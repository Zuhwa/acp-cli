/**
 * Gateway Config
 *
 * viem clients for the backend's wallet.
 * Used for x402 facilitator verification and all 8183 on-chain calls.
 *
 * Env vars:
 *   GATEWAY_PRIVATE_KEY — wallet private key (for gas + evaluator role)
 *   GATEWAY_RPC_URL — RPC endpoint (defaults to Base Sepolia)
 */

import { createPublicClient, createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const DEFAULT_RPC_URL = "https://sepolia.base.org";

export function getGatewayWallet() {
  const privateKey = process.env.GATEWAY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("GATEWAY_PRIVATE_KEY environment variable is required.");
  }
  const rpcUrl = process.env.GATEWAY_RPC_URL || DEFAULT_RPC_URL;
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const client = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  }).extend(publicActions);

  return { client, account, address: account.address };
}

export function getPublicClient() {
  const rpcUrl = process.env.GATEWAY_RPC_URL || DEFAULT_RPC_URL;
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}
