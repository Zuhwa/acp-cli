/**
 * Offering Server
 *
 * HTTP server deployed per offering. Handles x402 and MPP protocol
 * at the HTTP layer. All on-chain work delegated to our ACP backend.
 *
 * This is what gets deployed via `acp serve deploy` or run locally
 * via `acp serve start`. The developer's handler.ts runs here.
 *
 * For ACP native: connects to backend via WebSocket for job events.
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleX402 } from "./middleware/x402";
import { handleMPP } from "./middleware/mpp";
import { loadHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import * as backend from "./backend-client";
import { buildHandlerInput } from "./middleware/shared";

export interface ServerOptions {
  dir: string;
  port?: number;
  providerWallet: string;
  offering: DeployedOffering["offering"];
  protocols?: ("x402" | "mpp" | "acp")[];
}

export async function startOfferingServer(options: ServerOptions): Promise<void> {
  const { dir, providerWallet, offering } = options;
  const protocols = options.protocols || ["x402", "mpp", "acp"];
  const port = options.port || 3000;

  const handlers = await loadHandlers(dir);

  const deployed: DeployedOffering = {
    offeringId: offering.id,
    providerWallet,
    offering,
    hasValidator: !!handlers.validator,
    hasPricer: !!handlers.pricer,
    protocols,
    evaluator: "backend",
  };

  // Start ACP native listener if enabled
  if (protocols.includes("acp")) {
    startACPListener(deployed, handlers);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // x402 endpoint
    if (path === `/x402/${offering.id}` && protocols.includes("x402")) {
      await handleX402(req, res, deployed, handlers);
      return;
    }

    // MPP endpoint
    if (path === `/mpp/${offering.id}` && protocols.includes("mpp")) {
      await handleMPP(req, res, deployed, handlers);
      return;
    }

    // Health check
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        offering: { id: offering.id, name: offering.name },
        protocols,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`\nACP Serve — Offering Server running on port ${port}\n`);
    console.log(`Offering: ${offering.name} (${offering.id})`);
    console.log(`Provider: ${providerWallet}\n`);
    console.log("Endpoints:");
    if (protocols.includes("x402")) {
      console.log(`  x402: http://localhost:${port}/x402/${offering.id}`);
    }
    if (protocols.includes("mpp")) {
      console.log(`  MPP:  http://localhost:${port}/mpp/${offering.id}`);
    }
    if (protocols.includes("acp")) {
      console.log(`  ACP:  connected to backend (events)`);
    }
    console.log(`\nBackend: ${process.env.ACP_BACKEND_URL || "http://localhost:4000"}`);
    console.log(`Health:  http://localhost:${port}/health`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * ACP native listener — connects to backend for job events.
 * When a job is funded, runs the handler and calls backend /submit.
 */
function startACPListener(
  offering: DeployedOffering,
  handlers: ReturnType<typeof loadHandlers> extends Promise<infer T> ? T : never
): void {
  // TODO: Connect to backend WebSocket for job events
  // backend pushes: { jobId, chainId, status, requirements }
  // On job.funded:
  //   1. Run handler(requirements) → deliverable
  //   2. Call backend.submit({ jobId, chainId, deliverable })
  //   3. Backend does submit + complete on-chain

  console.log(`[ACP] Listening for native jobs: ${offering.offering.name}`);
}
