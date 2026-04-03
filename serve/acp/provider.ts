/**
 * ACP Native Provider
 *
 * Handles the provider side for native ACP jobs (not x402/MPP).
 * Listens for events via the ACP SDK event system and automatically:
 *
 * 1. job.created → run validate.ts (if exists), accept or reject
 * 2. job.created → run price.ts (if exists), call setBudget with dynamic price
 * 3. job.funded  → run handler.ts, call submit with deliverable
 * 4. DefaultEvaluator auto-completes → done
 *
 * This replaces the old `acp serve start` daemon from v1.
 * The developer writes handler.ts (and optionally validate.ts, price.ts).
 * This module handles the event loop and 8183 interactions.
 */

import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput } from "../types";
import { buildHandlerInput } from "./job";

interface JobState {
  jobId: string;
  chainId: number;
  requirements?: Record<string, unknown> | string;
  status: string;
}

/**
 * Start the ACP native provider event loop.
 *
 * This uses the same event system as `acp events listen` — subscribes
 * to job events for the provider's agent and dispatches to handler hooks.
 */
export async function startACPProvider(
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<{ stop: () => Promise<void> }> {
  // TODO: Wire to real ACP SDK event system
  // 1. const agent = await createAgentFromConfig()
  // 2. agent.on("entry", async (session, entry) => { ... })
  // 3. await agent.start()
  //
  // For each event:
  //   job.created → check if it's for our offering
  //     → run validate.ts if exists
  //     → if rejected: session.reject(reason)
  //     → wait for requirement message (contentType: "requirement")
  //     → store requirements in job state
  //
  //   requirement message arrived → run price.ts if exists
  //     → session.setBudget(amount)
  //     → (if no pricer, use offering.priceValue)
  //
  //   job.funded → run handler.ts
  //     → session.submit(deliverable)
  //     → DefaultEvaluator auto-completes
  //
  //   job.completed / job.rejected → clean up job state

  const jobStates = new Map<string, JobState>();

  console.log(`[ACP] Provider listening for jobs on offering: ${offering.offering.name}`);

  // Placeholder event handler — will be wired to SDK
  async function handleEvent(
    jobId: string,
    chainId: number,
    status: string,
    entry: Record<string, unknown>
  ): Promise<void> {
    let state = jobStates.get(jobId);

    if (status === "open" && !state) {
      // New job created
      state = { jobId, chainId, status };
      jobStates.set(jobId, state);

      // Check for requirement in entry
      const content = entry.content as string | undefined;
      const contentType = entry.contentType as string | undefined;
      if (contentType === "requirement" && content) {
        try {
          state.requirements = JSON.parse(content);
        } catch {
          state.requirements = content;
        }
      }

      // Run validator if exists
      if (handlers.validator && state.requirements) {
        const input = buildHandlerInput(
          offering.offering,
          state.requirements,
          (entry.from as string) || "unknown",
          "acp",
          jobId
        );
        const validation = await handlers.validator(input);
        if (!validation.accept) {
          console.log(`[ACP] Job ${jobId}: rejected — ${validation.reason}`);
          // TODO: session.reject(validation.reason)
          jobStates.delete(jobId);
          return;
        }
      }

      // Run pricer and set budget
      let amount = offering.offering.priceValue;
      if (handlers.pricer && state.requirements) {
        const input = buildHandlerInput(
          offering.offering,
          state.requirements,
          (entry.from as string) || "unknown",
          "acp",
          jobId
        );
        const pricing = await handlers.pricer(input);
        amount = pricing.amount;
      }

      console.log(`[ACP] Job ${jobId}: setting budget ${amount} USDC`);
      // TODO: session.setBudget(AssetToken.usdc(amount, chainId))
    }

    if (status === "funded" && state) {
      // Job funded — run handler
      const requirements = state.requirements || "";
      const input = buildHandlerInput(
        offering.offering,
        requirements,
        (entry.from as string) || "unknown",
        "acp",
        jobId
      );

      console.log(`[ACP] Job ${jobId}: running handler...`);
      const result = await handlers.handler(input);

      console.log(`[ACP] Job ${jobId}: submitting deliverable`);
      // TODO: session.submit(result.deliverable)
    }

    if (status === "completed" || status === "rejected" || status === "expired") {
      console.log(`[ACP] Job ${jobId}: ${status}`);
      jobStates.delete(jobId);
    }
  }

  return {
    stop: async () => {
      console.log("[ACP] Provider stopped");
      // TODO: await agent.stop()
    },
  };
}
