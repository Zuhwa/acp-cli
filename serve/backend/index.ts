/**
 * ACP Backend
 *
 * Centralized service that does ALL on-chain work.
 * Offering servers call this for payment verification and 8183 settlement.
 *
 * Endpoints:
 *   POST /verify  — verify x402 signature or MPP credential
 *   POST /settle  — full 8183 lifecycle (createJob → fund → submit → complete)
 *   POST /submit  — submit + complete for ACP native jobs
 *
 * Env vars:
 *   GATEWAY_PRIVATE_KEY  — wallet for gas + evaluator role
 *   GATEWAY_RPC_URL      — RPC endpoint
 *   ACP_CHAIN_ID         — chain ID (default 84532)
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { handleVerify } from "./routes/verify";
import { handleSettle, handleSubmit } from "./routes/settle";

export function startBackend(port: number = 4000): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/verify") {
      await handleVerify(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/settle") {
      await handleSettle(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      await handleSubmit(req, res);
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "acp-backend" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`\nACP Backend running on port ${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /verify  — payment verification`);
    console.log(`  POST /settle  — 8183 settlement`);
    console.log(`  POST /submit  — ACP native submit`);
    console.log(`  GET  /health  — health check\n`);
  });
}
