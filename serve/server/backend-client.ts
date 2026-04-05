/**
 * Backend Client
 *
 * HTTP client used by the offering server to call our ACP backend.
 * The offering server is lightweight — no wallet, no blockchain access.
 * All on-chain work is delegated to the backend via this client.
 */

const BACKEND_URL = process.env.ACP_BACKEND_URL || "http://localhost:4000";

export interface VerifyRequest {
  protocol: "x402" | "mpp";
  offeringId: string;
  paymentData: string; // base64 encoded payment signature or credential
}

export interface VerifyResponse {
  valid: boolean;
  clientAddress: string;
  error?: string;
}

export interface SettleRequest {
  protocol: "x402" | "mpp";
  offeringId: string;
  providerAddress: string;
  clientAddress: string;
  paymentData: string;
  deliverable: string;
  description: string;
  budget: number;
  slaMinutes: number;
}

export interface SettleResponse {
  success: boolean;
  jobId: string;
  txHash?: string;
  error?: string;
}

export interface SubmitRequest {
  jobId: string;
  chainId: number;
  deliverable: string;
}

export interface SubmitResponse {
  success: boolean;
  error?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Verify a payment (x402 signature or MPP credential) */
export async function verify(req: VerifyRequest): Promise<VerifyResponse> {
  return post<VerifyResponse>("/verify", req);
}

/** Settle a payment — creates 8183 job, funds escrow, submits deliverable, completes */
export async function settle(req: SettleRequest): Promise<SettleResponse> {
  return post<SettleResponse>("/settle", req);
}

/** Submit a deliverable for an ACP native job (backend does submit + complete) */
export async function submit(req: SubmitRequest): Promise<SubmitResponse> {
  return post<SubmitResponse>("/submit", req);
}
