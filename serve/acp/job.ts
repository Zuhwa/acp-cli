/**
 * ACP Job Manager
 *
 * Wraps the ACP SDK (acp-node-v2) to create and manage ERC-8183 jobs.
 * Used by all three protocol paths (x402, MPP, ACP native).
 *
 * The 8183 lifecycle for x402/MPP (gateway acts as both client AND evaluator):
 *   createJob(evaluator=gateway) → setBudget → fund → [handler] → submit → complete
 *
 * The gateway is the evaluator so it can call complete() after the handler
 * returns. The provider can't call complete() — only the evaluator can.
 */

import { AssetToken } from "acp-node-v2";
import { createAgentFromConfig, getWalletAddress } from "../../src/lib/agentFactory";
import type { HandlerInput } from "../types";

export interface CreateJobParams {
  providerAddress: string;
  clientAddress: string;
  chainId: number;
  description: string;
  budget: number;
  slaMinutes: number;
}

export interface JobResult {
  jobId: string;
  chainId: number;
}

/**
 * Create and fund an 8183 job for an x402/MPP payment.
 *
 * The gateway's active agent acts as both the client (creates + funds)
 * and the evaluator (will call complete after handler returns).
 *
 * Flow: createJob → setBudget → fund → return jobId
 */
export async function createAndFundJob(params: CreateJobParams): Promise<JobResult> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    // Gateway is the evaluator — so it can call complete() later
    const gatewayAddress = await agent.getAddress();
    const expiredAt = Math.floor(Date.now() / 1000) + params.slaMinutes * 60;

    const jobId = await agent.createJob(params.chainId, {
      providerAddress: params.providerAddress,
      evaluatorAddress: gatewayAddress,
      expiredAt,
      description: params.description,
    });

    // Get the session to set budget and fund
    const session = agent.getSession(params.chainId, jobId.toString());
    if (!session) {
      throw new Error(`Failed to get session for job ${jobId}`);
    }

    await session.setBudget(AssetToken.usdc(params.budget, params.chainId));
    await session.fetchJob();
    await session.fund(AssetToken.usdc(params.budget, params.chainId));

    return {
      jobId: jobId.toString(),
      chainId: params.chainId,
    };
  } finally {
    await agent.stop();
  }
}

/**
 * Submit deliverable and complete the job.
 *
 * Called after the handler returns. The gateway calls submit() as the
 * provider, then complete() as the evaluator (since the gateway set
 * itself as evaluator at createJob time).
 */
export async function submitAndComplete(
  jobId: string,
  chainId: number,
  deliverable: string
): Promise<void> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    const session = agent.getSession(chainId, jobId);
    if (!session) {
      throw new Error(`No session found for job ${jobId}`);
    }

    // Submit the deliverable (as provider)
    await session.submit(deliverable);

    // Complete the job (as evaluator — the gateway set itself as evaluator)
    await session.complete("Auto-completed by ACP Serve");
  } finally {
    await agent.stop();
  }
}

/**
 * Build HandlerInput from offering data and client requirements.
 */
export function buildHandlerInput(
  offering: HandlerInput["offering"],
  requirements: Record<string, unknown> | string,
  clientAddress: string,
  protocol: HandlerInput["protocol"],
  jobId?: string
): HandlerInput {
  return {
    requirements,
    offering,
    jobId,
    client: { address: clientAddress },
    protocol,
  };
}
