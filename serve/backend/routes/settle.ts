/**
 * /settle endpoint
 *
 * Settles a payment via ERC-8183. This is where we diverge from vanilla
 * x402/MPP — instead of a bare ERC-20 transfer, we create a full 8183 job.
 *
 * Called by offering servers after the handler returns a deliverable.
 * Does the entire 8183 lifecycle: createJob → fund → submit → complete.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { settleVia8183, submitAndComplete } from "../acp/job";

export async function handleSettle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const params = JSON.parse(body);

  try {
    const result = await settleVia8183({
      providerAddress: params.providerAddress,
      clientAddress: params.clientAddress,
      paymentData: params.paymentData,
      deliverable: params.deliverable,
      description: params.description,
      budget: params.budget,
      slaMinutes: params.slaMinutes,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, jobId: result.jobId }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : "Settlement failed",
    }));
  }
}

export async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const { jobId, deliverable } = JSON.parse(body);

  try {
    await submitAndComplete(jobId, deliverable);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : "Submit failed",
    }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
