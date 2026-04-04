/**
 * Gateway Client
 *
 * Configures viem clients for the gateway wallet.
 * Used by the x402 facilitator and MPP on-chain verification.
 *
 * Environment variables:
 *   GATEWAY_PRIVATE_KEY  — private key for the gateway wallet
 *   GATEWAY_RPC_URL      — RPC endpoint (defaults to Base Sepolia public RPC)
 */

import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const DEFAULT_RPC_URL = "https://sepolia.base.org";

export function getPublicClient() {
  const rpcUrl = process.env.GATEWAY_RPC_URL || DEFAULT_RPC_URL;
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}

export function getGatewayAddress(): string {
  const privateKey = process.env.GATEWAY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("GATEWAY_PRIVATE_KEY environment variable is required.");
  }
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}
