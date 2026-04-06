/**
 * Offering Server (Hono)
 *
 * Self-contained server deployed per offering.
 * Hono framework — works on Node.js (local), Cloudflare Workers (hosted), Deno, Bun.
 *
 * Routes:
 *   GET /x402/:offeringId  — x402 payment endpoint
 *   GET /mpp/:offeringId   — MPP payment endpoint
 *   GET /health            — health check
 *
 * ACP native runs as a background event listener in the same process.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadHandlers, type LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import { x402Middleware } from "./middleware/x402";
import { mppMiddleware } from "./middleware/mpp";

export interface ServerOptions {
  dir: string;
  port?: number;
  providerWallet: string;
  offering: DeployedOffering["offering"];
  protocols?: ("x402" | "mpp" | "acp")[];
  /** If true, run handlers in a sandboxed worker thread (no env access).
   *  Enabled automatically for hosted deployments to prevent handlers
   *  from accessing the deploy signer key. */
  sandbox?: boolean;
}

export async function startOfferingServer(options: ServerOptions): Promise<void> {
  const { dir, providerWallet, offering } = options;
  const protocols = options.protocols || ["x402", "mpp", "acp"];
  const port = options.port || 3000;

  let handlers = await loadHandlers(dir);

  // In sandbox mode, wrap the handler to run in an isolated worker thread.
  // The worker has NO access to process.env (no signer keys).
  // Enabled for hosted deployments to prevent handler code from stealing keys.
  if (options.sandbox) {
    const { runInSandbox } = await import("../runtime/sandbox");
    const { resolve } = await import("path");
    const handlerPath = resolve(dir, "handler.ts");
    const timeoutMs = (offering.slaMinutes || 5) * 60 * 1000;

    const originalHandler = handlers.handler;
    handlers = {
      ...handlers,
      handler: async (input) => {
        return runInSandbox(handlerPath, input, timeoutMs);
      },
    };
  }

  const deployed: DeployedOffering = {
    offeringId: offering.id,
    providerWallet,
    offering,
    hasBudgetHandler: !!handlers.budgetHandler,
    protocols,
    evaluator: "self",
  };

  // Replay protection — track processed payment signatures
  const processedPayments = new Set<string>();

  const app = new Hono();

  // Middleware: check for replay attacks
  app.use("*", async (c, next) => {
    const paymentSig = c.req.header("payment-signature") || c.req.header("authorization");
    if (paymentSig && processedPayments.has(paymentSig)) {
      return c.json({ error: "Payment already processed" }, 409);
    }
    await next();
    // Mark as processed after successful response
    if (paymentSig && c.res.status === 200) {
      processedPayments.add(paymentSig);
      // Prevent memory leak — evict old entries after 10 minutes
      setTimeout(() => processedPayments.delete(paymentSig), 10 * 60 * 1000);
    }
  });

  // x402 endpoint
  if (protocols.includes("x402")) {
    app.all(`/x402/${offering.id}`, x402Middleware(deployed, handlers));
  }

  // MPP endpoint
  if (protocols.includes("mpp")) {
    app.all(`/mpp/${offering.id}`, mppMiddleware(deployed, handlers));
  }

  // Health check
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      offering: { id: offering.id, name: offering.name },
      protocols,
      pid: process.pid,
    })
  );

  // 404
  app.all("*", (c) => c.json({ error: "Not found" }, 404));

  // Start ACP native listener
  if (protocols.includes("acp")) {
    startACPListener(deployed, handlers);
  }

  // Write PID file for serve stop/status
  const pidFile = getPidFilePath(offering.id);
  const { writeFileSync, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  // Start HTTP server
  serve({ fetch: app.fetch, port }, () => {
    console.log(`\nACP Serve running on port ${port}\n`);
    console.log(`Offering: ${offering.name} (${offering.id})`);
    console.log(`Provider: ${providerWallet}`);
    console.log(`PID: ${process.pid}\n`);
    console.log("Endpoints:");
    if (protocols.includes("x402")) {
      console.log(`  x402: http://localhost:${port}/x402/${offering.id}`);
    }
    if (protocols.includes("mpp")) {
      console.log(`  MPP:  http://localhost:${port}/mpp/${offering.id}`);
    }
    if (protocols.includes("acp")) {
      console.log(`  ACP:  listening for events (native)`);
    }
    console.log(`\nHealth: http://localhost:${port}/health`);
  });

  // Cleanup on shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startACPListener(
  offering: DeployedOffering,
  handlers: LoadedHandlers
): Promise<void> {
  const { createAgentFromConfig } = await import("../../src/lib/agentFactory");
  const { AssetToken } = await import("acp-node-v2");
  const { buildHandlerInput } = await import("./middleware/shared");

  const agent = await createAgentFromConfig();
  const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");

  // Track jobs we're handling
  const jobRequirements = new Map<string, Record<string, unknown> | string>();

  agent.on("entry", async (session: any, entry: any) => {
    const jobId = session.jobId;
    const status = session.status;

    // Capture requirements from requirement messages
    if (entry.contentType === "requirement" && entry.content) {
      try {
        jobRequirements.set(jobId, JSON.parse(entry.content));
      } catch {
        jobRequirements.set(jobId, entry.content);
      }
    }

    // Job created + requirements received → propose budget
    if (status === "open" && jobRequirements.has(jobId)) {
      const requirements = jobRequirements.get(jobId)!;
      const input = buildHandlerInput(
        offering, requirements, entry.from || "unknown", "acp", jobId
      );

      // Use budget handler if exists, otherwise offering's fixed price
      if (handlers.budgetHandler) {
        const budget = await handlers.budgetHandler(input);

        if (budget.fundRequest) {
          // Set budget with fund request (service fee + working capital)
          console.log(`[ACP] Job ${jobId}: setting budget ${budget.amount} USDC + fund request ${budget.fundRequest.transferAmount} USDC`);
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(budget.amount, CHAIN_ID),
            AssetToken.usdc(budget.fundRequest.transferAmount, CHAIN_ID),
            budget.fundRequest.destination
          );
        } else {
          // Set budget only (service fee)
          console.log(`[ACP] Job ${jobId}: setting budget ${budget.amount} USDC`);
          await session.setBudget(AssetToken.usdc(budget.amount, CHAIN_ID));
        }
      } else {
        // Default: use offering's fixed price
        const amount = offering.offering.priceValue;
        console.log(`[ACP] Job ${jobId}: setting budget ${amount} USDC (offering price)`);
        await session.setBudget(AssetToken.usdc(amount, CHAIN_ID));
      }
    }

    // Job funded → run handler + submit
    if (status === "funded" && jobRequirements.has(jobId)) {
      const requirements = jobRequirements.get(jobId)!;
      const input = buildHandlerInput(
        offering, requirements, entry.from || "unknown", "acp", jobId
      );

      console.log(`[ACP] Job ${jobId}: running handler...`);
      const result = await handlers.handler(input);

      console.log(`[ACP] Job ${jobId}: submitting deliverable`);
      await session.submit(result.deliverable);
    }

    // Terminal states — cleanup
    if (status === "completed" || status === "rejected" || status === "expired") {
      console.log(`[ACP] Job ${jobId}: ${status}`);
      jobRequirements.delete(jobId);
    }
  });

  await agent.start();
  console.log(`[ACP] Listening for native jobs: ${offering.offering.name}`);
}

/** PID file path for a given offering — used by stop/status commands */
export function getPidFilePath(offeringId: string): string {
  const { resolve } = require("path");
  const { homedir } = require("os");
  return resolve(homedir(), ".acp", "serve", `${offeringId}.pid`);
}
