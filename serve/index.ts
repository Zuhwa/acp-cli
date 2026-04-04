/**
 * ACP Serve — Server Entry Point
 *
 * HTTP server exposing x402 and MPP endpoints for deployed offerings,
 * backed by ERC-8183 escrow via the ACP SDK.
 *
 * Three protocol paths, same handler, same 8183 settlement:
 *   /x402/<offering-id>  → x402 protocol (facilitator model)
 *   /mpp/<offering-id>   → MPP protocol (direct verification)
 *   ACP native           → event-driven (provider agent loop)
 *
 * Started via `acp serve start`
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleX402Request } from "./routes/x402";
import { handleMPPRequest } from "./routes/mpp";
import { startACPProvider } from "./acp/provider";
import { loadHandlers } from "./runtime/loader";
import * as registry from "./registry/store";
import type { DeployedOffering } from "./types";

export interface ServeOptions {
  /** Path to the offering directory containing handler.ts */
  dir: string;
  /** Port to listen on */
  port?: number;
  /** Provider wallet address */
  providerWallet: string;
  /** Offering data from ACP API */
  offering: DeployedOffering["offering"];
  /** Which protocols to enable */
  protocols?: ("x402" | "mpp" | "acp")[];
}

export async function startServer(options: ServeOptions): Promise<void> {
  const { dir, providerWallet, offering } = options;
  const protocols = options.protocols || ["x402", "mpp", "acp"];
  const port = options.port || 3000;

  // Load developer's handlers from the offering directory
  const handlers = await loadHandlers(dir);

  // Build deployed offering entry
  const deployed: DeployedOffering = {
    offeringId: offering.id,
    providerWallet,
    offering,
    hasValidator: !!handlers.validator,
    hasPricer: !!handlers.pricer,
    protocols,
    evaluator: "gateway", // gateway acts as evaluator for x402/MPP
  };

  // Register in local registry
  registry.register(offering.id, deployed, handlers);

  // Start ACP native provider if enabled
  let acpProvider: { stop: () => Promise<void> } | undefined;
  if (protocols.includes("acp")) {
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
      if (!entry || !entry.deployed.protocols.includes("x402")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Offering not found or x402 not enabled" }));
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
      if (!entry || !entry.deployed.protocols.includes("mpp")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Offering not found or MPP not enabled" }));
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
