/**
 * ACP Serve — Type definitions
 *
 * These types define the contract between the developer's handler code
 * and the ACP Serve runtime. The developer implements Handler (required)
 * and optionally Validator and Pricer.
 */

/** Input passed to all handler hooks */
export interface HandlerInput {
  /** Client's requirements data (validated against offering schema) */
  requirements: Record<string, unknown> | string;
  /** Offering metadata */
  offering: {
    id: string;
    name: string;
    description: string;
    priceType: string;
    priceValue: number;
    slaMinutes: number;
    requirements: Record<string, unknown> | string;
    deliverable: Record<string, unknown> | string;
  };
  /** The 8183 job ID (set after job creation) */
  jobId?: string;
  /** Client info */
  client: {
    address: string;
  };
  /** Which protocol the request came through */
  protocol: "x402" | "mpp" | "acp";
}

/** Output from the handler — the deliverable */
export interface HandlerOutput {
  /** The deliverable content (URL, text, JSON string, etc.) */
  deliverable: string;
}

/** Output from the validator — accept or reject the job */
export interface ValidateOutput {
  accept: boolean;
  reason?: string;
}

/** Output from the pricer — dynamic pricing */
export interface PriceOutput {
  /** USDC amount to charge */
  amount: number;
}

/**
 * The main handler function — REQUIRED.
 * Takes requirements, does the work, returns deliverable.
 */
export type Handler = (input: HandlerInput) => Promise<HandlerOutput>;

/**
 * Validator function — OPTIONAL.
 * Decides whether to accept an incoming job before pricing.
 * Only called for ACP native flow (x402/MPP use schema validation only).
 */
export type Validator = (input: HandlerInput) => Promise<ValidateOutput>;

/**
 * Pricer function — OPTIONAL.
 * Returns dynamic pricing based on requirements.
 * Only called for ACP native flow (x402/MPP use offering's fixed price).
 */
export type Pricer = (input: HandlerInput) => Promise<PriceOutput>;

/** Configuration file (serve.json) */
export interface ServeConfig {
  offeringId: string;
  protocols: ("x402" | "mpp" | "acp")[];
  evaluator?: string; // "default" or a custom evaluator contract address
  port?: number;
}

/** Registry entry for a deployed offering */
export interface DeployedOffering {
  offeringId: string;
  providerWallet: string;
  offering: HandlerInput["offering"];
  hasValidator: boolean;
  hasPricer: boolean;
  protocols: ("x402" | "mpp" | "acp")[];
  evaluator: string;
}
