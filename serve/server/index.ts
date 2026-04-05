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
    evaluator: "self",
  };

  const app = new Hono();

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

function startACPListener(
  offering: DeployedOffering,
  handlers: LoadedHandlers
): void {
  // TODO: Wire ACP SDK event listener
  // agent.on("entry") → validate → price → handler → submit
  console.log(`[ACP] Listening for native jobs: ${offering.offering.name}`);
}

/** PID file path for a given offering — used by stop/status commands */
export function getPidFilePath(offeringId: string): string {
  const { resolve } = require("path");
  const { homedir } = require("os");
  return resolve(homedir(), ".acp", "serve", `${offeringId}.pid`);
}
