const DEFAULT_CHAIN_ID = "84532";

export function getDefaultChainId(): string {
  return process.env.ACP_CHAIN_ID || DEFAULT_CHAIN_ID;
}
