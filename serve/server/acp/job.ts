/**
 * ACP Job Settlement
 *
 * Executes the ERC-8183 lifecycle using the ACP SDK.
 * Runs in the same process as the offering server.
 * Uses the deploy signer (hosted) or developer's wallet (self-hosted).
 *
 * Settlement flow:
 *   createJob → setBudget → fund (PaymentHook: client → escrow) → submit
 *   → DefaultEvaluator auto-completes on-chain
 */

import { AssetToken } from "acp-node-v2";
import { createAgentFromConfig } from "../../../src/lib/agentFactory";

const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");

export interface SettleParams {
  providerAddress: string;
  clientAddress: string;
  paymentData: string;
  deliverable: string;
  description: string;
  budget: number;
  slaMinutes: number;
}

/**
 * Full 8183 lifecycle for an x402/MPP payment.
 *
 * createJob → setBudget → fund (hook routes client payment to escrow)
 * → submit (deliverable from handler) → DefaultEvaluator auto-completes
 */
export async function settleVia8183(params: SettleParams): Promise<{ jobId: string }> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    const agentAddress = await agent.getAddress();
    const expiredAt = Math.floor(Date.now() / 1000) + params.slaMinutes * 60;

    const jobId = await agent.createJob(CHAIN_ID, {
      providerAddress: params.providerAddress,
      evaluatorAddress: agentAddress, // DefaultEvaluator or self-evaluation
      expiredAt,
      description: params.description,
    });

    const session = agent.getSession(CHAIN_ID, jobId.toString());
    if (!session) throw new Error(`Failed to get session for job ${jobId}`);

    await session.setBudget(AssetToken.usdc(params.budget, CHAIN_ID));

    // Fund — PaymentHook executes client's payment authorization → escrow
    // TODO: pass paymentData as optParams when SDK supports it
    await session.fetchJob();
    await session.fund(AssetToken.usdc(params.budget, CHAIN_ID));

    // Submit deliverable
    await session.submit(params.deliverable);

    // DefaultEvaluator auto-completes on-chain
    // If no DefaultEvaluator, self-evaluate:
    await session.complete("Auto-completed by ACP Serve");

    return { jobId: jobId.toString() };
  } finally {
    await agent.stop();
  }
}
