/**
 * ACP Job Manager
 *
 * Wraps the ACP SDK to create and manage ERC-8183 jobs.
 * All three protocol paths (x402, MPP, ACP native) use this.
 *
 * Payment flow (x402/MPP):
 *   Gateway calls createJob → setBudget → fund(optParams=clientAuth)
 *   The PaymentHook executes the client's authorization during fund():
 *     client → gateway → escrow (atomic, one transaction)
 *   Handler runs → submit → complete → escrow released to provider
 *
 * The gateway is both client (creates job) and evaluator (calls complete).
 * The provider is the offering owner.
 */

import { AssetToken } from "acp-node-v2";
import { createAgentFromConfig } from "../../src/lib/agentFactory";
import type { HandlerInput } from "../types";

export interface CreateJobParams {
  providerAddress: string;
  clientAddress: string;
  chainId: number;
  description: string;
  budget: number;
  slaMinutes: number;
  /** Client's signed payment authorization (passed to fund() as optParams) */
  paymentAuth?: string;
}

export interface JobResult {
  jobId: string;
  chainId: number;
}

/**
 * Create and fund an 8183 job, using the client's payment authorization.
 *
 * The PaymentHook on the 8183 contract intercepts fund() and executes
 * the client's EIP-3009 authorization. USDC flows:
 *   client → gateway → escrow (atomic in one tx)
 */
export async function createAndFundJob(params: CreateJobParams): Promise<JobResult> {
  const agent = await createAgentFromConfig();
  await agent.start();

  try {
    const gatewayAddress = await agent.getAddress();
    const expiredAt = Math.floor(Date.now() / 1000) + params.slaMinutes * 60;

    // Create job: gateway is both client and evaluator
    const jobId = await agent.createJob(params.chainId, {
      providerAddress: params.providerAddress,
      evaluatorAddress: gatewayAddress,
      expiredAt,
      description: params.description,
    });

    const session = agent.getSession(params.chainId, jobId.toString());
    if (!session) {
      throw new Error(`Failed to get session for job ${jobId}`);
    }

    // Set budget
    await session.setBudget(AssetToken.usdc(params.budget, params.chainId));

    // Fund with client's payment authorization in optParams
    // The PaymentHook executes the authorization during fund():
    //   1. Hook: transferWithAuthorization(client → gateway)
    //   2. fund(): safeTransferFrom(gateway → escrow)
    await session.fetchJob();
    // Fund the escrow
    // TODO: SDK currently doesn't support optParams on fund().
    // When SDK adds optParams support, pass params.paymentAuth here
    // so the PaymentHook can execute the client's authorization atomically:
    //   await session.fund(amount, params.paymentAuth)
    //
    // For now, the gateway funds from its own balance. The x402/MPP payment
    // goes to the gateway (payTo=gateway), and the gateway forwards to escrow.
    // This is NOT the final architecture — the hook makes it atomic + trustless.
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
 * Gateway calls submit (as provider) then complete (as evaluator).
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

    await session.submit(deliverable);
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
