import type { Command } from "commander";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { getWalletAddress } from "../lib/agentFactory";
import { getClient } from "../lib/api/client";
import { formatUnits } from "viem";

export function registerJobCommands(program: Command): void {
  const job = program.command("job").description("Job queries (history, list)");

  job
    .command("list")
    .description("List active jobs (REST, no socket connection needed)")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();

        const { jobApi } = await getClient(wallet);
        const jobs = await jobApi.getActiveJobs();

        if (json) {
          outputResult(true, { jobs });
        } else {
          if (jobs.length === 0) {
            console.log("No active jobs.");
          } else if (isTTY()) {
            console.log(`Active jobs (${jobs.length}):\n`);
            for (const j of jobs) {
              console.log(`  Job ID:           ${j.onChainJobId}`);
              console.log(`  Chain ID:         ${j.chainId}`);
              console.log(`  Client:           ${j.clientAddress}`);
              console.log(`  Provider:         ${j.providerAddress}`);
              console.log(`  Evaluator:        ${j.evaluatorAddress}`);
              console.log(
                `  Budget:           ${formatUnits(BigInt(j.budget), 6)} USDC`
              );
              console.log(`  Status:           ${j.jobStatus}`);
              console.log(`  Expires At:       ${j.expiredAt}`);
              console.log();
            }
          } else {
            console.log("JOB_ID\tCHAIN\tCLIENT\tPROVIDER\tBUDGET\tSTATUS");
            for (const j of jobs) {
              console.log(
                `${j.onChainJobId}\t${j.chainId}\t${j.clientAddress}\t${j.providerAddress}\t${formatUnits(BigInt(j.budget), 6)}\t${j.jobStatus}`
              );
            }
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  job
    .command("history")
    .description(
      "Get full job history including status and all messages (REST, no socket connection needed)"
    )
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID", "84532")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();

        const { jobApi } = await getClient(wallet);
        const entries = await jobApi.getChatHistory(
          Number(opts.chainId),
          opts.jobId
        );

        const status = deriveStatus(entries);

        if (json) {
          outputResult(true, {
            jobId: opts.jobId,
            chainId: Number(opts.chainId),
            status,
            entryCount: entries.length,
            entries,
          });
        } else if (isTTY()) {
          console.log(`Job ${opts.jobId} (chain ${opts.chainId})`);
          console.log(`Status: ${status}`);
          console.log(`Entries: ${entries.length}\n`);
          for (const e of entries) {
            if (e.kind === "system") {
              console.log(`  [system] ${e.event.type}`);
            } else {
              console.log(`  [${e.from}] ${e.content}`);
            }
          }
        } else {
          console.log(`${opts.jobId}\t${status}\t${entries.length}`);
          for (const e of entries) {
            if (e.kind === "system") {
              console.log(`system\t${e.event.type}`);
            } else {
              console.log(`${e.from}\t${e.content}`);
            }
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}

type JobStatus =
  | "open"
  | "budget_set"
  | "funded"
  | "submitted"
  | "completed"
  | "rejected"
  | "expired";

const EVENT_TO_STATUS: Record<string, JobStatus> = {
  "job.created": "open",
  "budget.set": "budget_set",
  "job.funded": "funded",
  "job.submitted": "submitted",
  "job.completed": "completed",
  "job.rejected": "rejected",
  "job.expired": "expired",
};

function deriveStatus(
  entries: Array<{ kind: string; event?: { type: string } }>
): JobStatus {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "system" && entry.event) {
      const mapped = EVENT_TO_STATUS[entry.event.type];
      if (mapped) return mapped;
    }
  }
  return "open";
}
