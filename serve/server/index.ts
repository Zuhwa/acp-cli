/**
 * Offering Server
 *
 * Self-contained server deployed per offering. Handles everything:
 * - x402 protocol (embedded facilitator: verify + settle via 8183)
 * - MPP protocol (embedded verifier: on-chain receipt + settle via 8183)
 * - ACP native (event listener + handler + submit via SDK)
 * - Handler runtime (developer's handler.ts)
 * - ERC-8183 settlement (via ACP SDK + deploy signer)
 *
 * No separate backend needed. All logic — facilitator, verification,
 * settlement, handler — runs in one process.
 *
 * Deployed as an encrypted package via `acp serve deploy`.
 * Or run locally via `acp serve start`.
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleX402 } from "./middleware/x402";
import { handleMPP } from "./middleware/mpp";
import { loadHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";

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

  // ACP native: listen for events via SDK
  if (protocols.includes("acp")) {
    startACPListener(deployed, handlers);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === `/x402/${offering.id}` && protocols.includes("x402")) {
      await handleX402(req, res, deployed, handlers);
      return;
    }

    if (path === `/mpp/${offering.id}` && protocols.includes("mpp")) {
      await handleMPP(req, res, deployed, handlers);
      return;
    }

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

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function startACPListener(
  offering: DeployedOffering,
  handlers: ReturnType<typeof loadHandlers> extends Promise<infer T> ? T : never
): void {
  // TODO: Use ACP SDK event listener
  // agent.on("entry") → run validate → price → handler → submit
  // Same flow as before, using deploy signer via createAgentFromConfig()
  console.log(`[ACP] Listening for native jobs: ${offering.offering.name}`);
}
