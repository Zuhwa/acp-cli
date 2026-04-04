/**
 * ACP Native Provider
 *
 * Handles the provider side for native ACP jobs (not x402/MPP).
 * Listens for events via the ACP SDK and automatically runs the
 * developer's handler hooks.
 *
 * Event flow:
 *   job.created + requirement message → validate.ts → price.ts → setBudget
 *   job.funded → handler.ts → submit
 *   Evaluator (client) calls complete/reject → done
 *
 * For native ACP, the CLIENT is the evaluator (not the gateway).
 * The gateway only acts as the provider — it sets budget and submits.
 */

import type { JobSession, JobRoomEntry } from "acp-node-v2";
import { AssetToken } from "acp-node-v2";
import { createAgentFromConfig } from "../../src/lib/agentFactory";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import { buildHandlerInput } from "./job";

interface JobState {
  jobId: string;
  chainId: number;
  requirements?: Record<string, unknown> | string;
}

export async function startACPProvider(
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<{ stop: () => Promise<void> }> {
  const agent = await createAgentFromConfig();
  const jobStates = new Map<string, JobState>();

  agent.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    const jobId = session.jobId;
    const status = session.status;
    const entryAny = entry as Record<string, unknown>;

    // Track job state
    let state = jobStates.get(jobId);

    // Capture requirements from requirement messages
    if (entryAny.contentType === "requirement" && entryAny.content) {
      if (!state) {
        state = { jobId, chainId: session.chainId };
        jobStates.set(jobId, state);
      }
      try {
        state.requirements = JSON.parse(entryAny.content as string);
      } catch {
        state.requirements = entryAny.content as string;
      }
    }

    // Job created — validate and set budget
    if (status === "open" && state?.requirements) {
      const input = buildHandlerInput(
        offering.offering,
        state.requirements,
        (entryAny.from as string) || "unknown",
        "acp",
        jobId
      );

      // Run validator if exists
      if (handlers.validator) {
        const validation = await handlers.validator(input);
        if (!validation.accept) {
          console.log(`[ACP] Job ${jobId}: rejected — ${validation.reason}`);
          // Can't reject as provider in 8183 — just ignore the job
          jobStates.delete(jobId);
          return;
        }
      }

      // Determine price
      let amount = offering.offering.priceValue;
      if (handlers.pricer) {
        const pricing = await handlers.pricer(input);
        amount = pricing.amount;
      }

      // Set budget
      console.log(`[ACP] Job ${jobId}: setting budget ${amount} USDC`);
      await session.setBudget(AssetToken.usdc(amount, session.chainId));
    }

    // Job funded — run handler and submit
    if (status === "funded" && state) {
      const requirements = state.requirements || "";
      const input = buildHandlerInput(
        offering.offering,
        requirements,
        (entryAny.from as string) || "unknown",
        "acp",
        jobId
      );

      console.log(`[ACP] Job ${jobId}: running handler...`);
      const result = await handlers.handler(input);

      console.log(`[ACP] Job ${jobId}: submitting deliverable`);
      await session.submit(result.deliverable);
      // Client (as evaluator) will call complete() or reject()
    }

    // Terminal states — clean up
    if (status === "completed" || status === "rejected" || status === "expired") {
      console.log(`[ACP] Job ${jobId}: ${status}`);
      jobStates.delete(jobId);
    }
  });

  await agent.start();
  console.log(`[ACP] Provider listening for jobs: ${offering.offering.name}`);

  return {
    stop: async () => {
      await agent.stop();
      console.log("[ACP] Provider stopped");
    },
  };
}
