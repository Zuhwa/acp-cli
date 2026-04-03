/**
 * ACP Job Manager
 *
 * Wraps the ACP SDK (acp-node-v2) to provide a simple interface for
 * creating and managing ERC-8183 jobs. Used by all three protocol paths
 * (x402, MPP, ACP native).
 *
 * The 8183 lifecycle for a served offering:
 *   createJob → setBudget → fund → [handler runs] → submit → complete
 *
 * For x402/MPP: the gateway calls all of these on behalf of client + provider.
 * For ACP native: the client creates/funds, the provider (this runtime) handles
 *   setBudget → submit, and the DefaultEvaluator handles complete.
 */

import type { HandlerInput } from "../types";

// Default evaluator address — auto-completes after submit()
const DEFAULT_EVALUATOR = "0x0000000000000000000000000000000000000000"; // TODO: deploy and set real address

export interface CreateJobParams {
  providerAddress: string;
  clientAddress: string;
  chainId: number;
  description: string;
  budget: number;
  evaluator?: string;
  slaMinutes: number;
}

export interface JobResult {
  jobId: string;
  chainId: number;
}

/**
 * Create a full 8183 job lifecycle for an x402/MPP payment.
 *
 * This handles the entire flow:
 * 1. createJob (client = gateway, provider = offering owner)
 * 2. setBudget (price from offering or pricer)
 * 3. fund (from the x402/MPP payment)
 * 4. Returns jobId — caller runs handler, then calls submitAndComplete()
 */
export async function createAndFundJob(params: CreateJobParams): Promise<JobResult> {
  // TODO: Use ACP SDK to:
  // 1. const agent = await createAgentFromConfig()
  // 2. await agent.start()
  // 3. const jobId = await agent.createJob(chainId, {
  //      providerAddress: params.providerAddress,
  //      evaluatorAddress: params.evaluator || DEFAULT_EVALUATOR,
  //      expiredAt: Math.floor(Date.now() / 1000) + params.slaMinutes * 60,
  //      description: params.description,
  //    })
  // 4. await session.setBudget(AssetToken.usdc(params.budget, chainId))
  // 5. await session.fund(AssetToken.usdc(params.budget, chainId))

  // Placeholder — will be wired to real SDK
  console.log(`[8183] Creating job: provider=${params.providerAddress}, budget=${params.budget} USDC`);

  return {
    jobId: "placeholder-job-id",
    chainId: params.chainId,
  };
}

/**
 * Submit deliverable and trigger completion for an x402/MPP job.
 *
 * Called after the handler returns a deliverable.
 * The DefaultEvaluator auto-completes, releasing escrow to the provider.
 */
export async function submitAndComplete(
  jobId: string,
  chainId: number,
  deliverable: string
): Promise<void> {
  // TODO: Use ACP SDK to:
  // 1. const agent = await createAgentFromConfig()
  // 2. await agent.start()
  // 3. const session = agent.getSession(chainId, jobId)
  // 4. await session.submit(deliverable)
  // 5. DefaultEvaluator auto-calls complete() — no action needed here
  //    (or if evaluator = self, call session.complete())

  console.log(`[8183] Job ${jobId}: submitted deliverable, awaiting completion`);
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
