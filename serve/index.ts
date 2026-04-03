/**
 * ACP Serve — Server Entry Point
 *
 * HTTP server that exposes x402 and MPP endpoints for deployed offerings,
 * backed by ERC-8183 escrow via the ACP SDK.
 *
 * Three protocol paths, same handler, same 8183 settlement:
 *
 *   /x402/<offering-id>  → x402 protocol (facilitator model)
 *   /mpp/<offering-id>   → MPP protocol (direct verification)
 *   ACP native           → event-driven (provider agent loop)
 *
 * Started via `acp serve start --dir ./my-offering/`
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleX402Request } from "./routes/x402";
import { handleMPPRequest } from "./routes/mpp";
import { startACPProvider } from "./acp/provider";
import { loadHandlers } from "./runtime/loader";
import * as registry from "./registry/store";
import type { DeployedOffering, ServeConfig } from "./types";

export interface ServeOptions {
  /** Path to the serve directory containing handler.ts + serve.json */
  dir: string;
  /** Port to listen on (overrides serve.json) */
  port?: number;
  /** Provider wallet address */
  providerWallet: string;
  /** Offering data from ACP API */
  offering: DeployedOffering["offering"];
}

export async function startServer(options: ServeOptions): Promise<void> {
  const { dir, providerWallet, offering } = options;

  // Load developer's handlers
  const handlers = await loadHandlers(dir);
  const config = handlers.config;
  const port = options.port || config.port || 3000;

  // Build deployed offering entry
  const deployed: DeployedOffering = {
    offeringId: config.offeringId,
    providerWallet,
    offering,
    hasValidator: !!handlers.validator,
    hasPricer: !!handlers.pricer,
    protocols: config.protocols,
    evaluator: config.evaluator || "default",
  };

  // Register in local registry
  registry.register(config.offeringId, deployed, handlers);

  // Start ACP native provider if enabled
  let acpProvider: { stop: () => Promise<void> } | undefined;
  if (config.protocols.includes("acp")) {
    acpProvider = await startACPProvider(deployed, handlers);
  }

  // Start HTTP server for x402/MPP
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Route: /x402/<offering-id>
    const x402Match = path.match(/^\/x402\/(.+)$/);
    if (x402Match) {
      const offeringId = x402Match[1];
      const entry = registry.get(offeringId);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Offering not found" }));
        return;
      }
      if (!entry.deployed.protocols.includes("x402")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "x402 not enabled for this offering" }));
        return;
      }
      await handleX402Request(req, res, entry.deployed, entry.handlers);
      return;
    }

    // Route: /mpp/<offering-id>
    const mppMatch = path.match(/^\/mpp\/(.+)$/);
    if (mppMatch) {
      const offeringId = mppMatch[1];
      const entry = registry.get(offeringId);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Offering not found" }));
        return;
      }
      if (!entry.deployed.protocols.includes("mpp")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MPP not enabled for this offering" }));
        return;
      }
      await handleMPPRequest(req, res, entry.deployed, entry.handlers);
      return;
    }

    // Route: /health
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          offerings: registry.list().map((o) => ({
            id: o.deployed.offeringId,
            name: o.deployed.offering.name,
            protocols: o.deployed.protocols,
          })),
        })
      );
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`\nACP Serve running on port ${port}\n`);
    console.log(`Offering: ${offering.name} (${config.offeringId})`);
    console.log(`Provider: ${providerWallet}\n`);
    console.log("Endpoints:");
    if (config.protocols.includes("x402")) {
      console.log(`  x402: http://localhost:${port}/x402/${config.offeringId}`);
    }
    if (config.protocols.includes("mpp")) {
      console.log(`  MPP:  http://localhost:${port}/mpp/${config.offeringId}`);
    }
    if (config.protocols.includes("acp")) {
      console.log(`  ACP:  listening for events (native)`);
    }
    console.log(`\nHealth: http://localhost:${port}/health`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    if (acpProvider) await acpProvider.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
