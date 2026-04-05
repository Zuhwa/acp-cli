/**
 * ACP Job Manager (Backend)
 *
 * Executes 8183 on-chain lifecycle. Called by the backend's /settle endpoint.
 * This is where ALL 8183 interactions happen — offering servers never touch 8183.
 *
 * For x402/MPP settle:
 *   createJob → fund (via PaymentHook: client→escrow) → submit → complete
 *
 * For ACP native submit:
 *   submit → complete
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

export interface SettleResult {
  jobId: string;
  txHash?: string;
}

/**
 * Full 8183 lifecycle for an x402/MPP payment.
 *
 * 1. createJob (gateway is evaluator, real client/provider addresses logged)
 * 2. fund (PaymentHook executes client's payment authorization → escrow)
 * 3. submit (deliverable from handler)
 * 4. complete (gateway as evaluator → escrow releases to provider)
 */
export async function settleVia8183(params: SettleParams): Promise<SettleResult> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    const gatewayAddress = await agent.getAddress();
    const expiredAt = Math.floor(Date.now() / 1000) + params.slaMinutes * 60;

    // Create job — gateway is evaluator, real addresses preserved
    const jobId = await agent.createJob(CHAIN_ID, {
      providerAddress: params.providerAddress,
      evaluatorAddress: gatewayAddress,
      expiredAt,
      description: params.description,
    });

    const session = agent.getSession(CHAIN_ID, jobId.toString());
    if (!session) throw new Error(`Failed to get session for job ${jobId}`);

    // Set budget
    await session.setBudget(AssetToken.usdc(params.budget, CHAIN_ID));

    // Fund — PaymentHook executes client's payment authorization
    // USDC flows: client → escrow directly (hook handles the transfer)
    // TODO: pass paymentData as optParams when SDK supports it
    await session.fetchJob();
    await session.fund(AssetToken.usdc(params.budget, CHAIN_ID));

    // Submit deliverable
    await session.submit(params.deliverable);

    // Complete as evaluator — releases escrow to provider
    await session.complete("Auto-completed by ACP Serve");

    return { jobId: jobId.toString() };
  } finally {
    await agent.stop();
  }
}

/**
 * Submit + complete for an ACP native job.
 * The job already exists and is funded — just submit and complete.
 */
export async function submitAndComplete(
  jobId: string,
  deliverable: string
): Promise<void> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    const session = agent.getSession(CHAIN_ID, jobId);
    if (!session) throw new Error(`No session found for job ${jobId}`);

    await session.submit(deliverable);
    await session.complete("Auto-completed by ACP Serve");
  } finally {
    await agent.stop();
  }
}
