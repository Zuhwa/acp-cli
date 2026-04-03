import type { Command } from "commander";
import { AssetToken } from "acp-node-v2";
import { createAgentFromConfig } from "../lib/agentFactory";
import { isJson, outputResult, outputError, maskAddress } from "../lib/output";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";

export function registerProviderCommands(program: Command): void {
  const provider = program
    .command("provider")
    .description("Provider-side commands (set budget, submit deliverable)");

  provider
    .command("set-budget")
    .description("Propose a budget for a job (USDC)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC amount to propose")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const session = agent.getSession(Number(opts.chainId), opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          await session.setBudget(AssetToken.usdc(Number(opts.amount), Number(opts.chainId)));
          if (json) {
            outputResult(json, {
              success: true,
              action: "set-budget",
              jobId: opts.jobId,
              amount: opts.amount,
            });
          } else {
            console.log(`\n${c.green(`Budget of ${opts.amount} USDC proposed for Job #${opts.jobId}`)}`);
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  provider
    .command("set-budget-with-fund-request")
    .description(
      "Propose a budget and request a fund transfer. The budget (--amount) is " +
        "your service fee (USDC). The fund transfer (--transfer-amount) is " +
        "capital the client provides for job execution (e.g., tokens for trades, " +
        "gas for on-chain ops). These are separate: the budget pays you, the " +
        "fund transfer gives you working capital."
    )
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC service fee")
    .requiredOption("--transfer-amount <usdc>", "Amount of capital to request from client")
    .requiredOption("--destination <address>", "Recipient address for the working capital")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const chainId = Number(opts.chainId);
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(Number(opts.amount), chainId),
            AssetToken.usdc(Number(opts.transferAmount), chainId),
            opts.destination
          );
          if (json) {
            outputResult(json, {
              success: true,
              action: "set-budget-with-fund-request",
              jobId: opts.jobId,
              amount: opts.amount,
              transferAmount: opts.transferAmount,
              destination: opts.destination,
            });
          } else {
            console.log(`\n${c.green(`Budget of ${opts.amount} USDC proposed for Job #${opts.jobId}`)}`);
            console.log(`  Fund transfer: ${opts.transferAmount} USDC → ${maskAddress(opts.destination)}`);
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  provider
    .command("submit")
    .description("Submit a deliverable for a job")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--deliverable <text>", "Deliverable content or reference")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--transfer-amount <usdc>", "USDC amount to transfer on submit")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const chainId = Number(opts.chainId);
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          const transferAmount = opts.transferAmount
            ? AssetToken.usdc(Number(opts.transferAmount), chainId)
            : undefined;
          await session.submit(opts.deliverable, transferAmount);
          if (json) {
            outputResult(json, {
              success: true,
              action: "submit",
              jobId: opts.jobId,
              deliverable: opts.deliverable,
              ...(transferAmount && { transferAmount: opts.transferAmount }),
            });
          } else {
            console.log(`\n${c.green(`Deliverable submitted for Job #${opts.jobId}`)}`);
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
