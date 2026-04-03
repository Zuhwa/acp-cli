/**
 * Registry Store
 *
 * Maps offering IDs to their deployed configuration and handler references.
 * For local mode (acp serve start), this is in-memory.
 * For hosted mode (acp serve deploy), this would be backed by a database.
 */

import type { DeployedOffering } from "../types";
import type { LoadedHandlers } from "../runtime/loader";

export interface RegisteredOffering {
  deployed: DeployedOffering;
  handlers: LoadedHandlers;
}

const offerings = new Map<string, RegisteredOffering>();

export function register(
  offeringId: string,
  deployed: DeployedOffering,
  handlers: LoadedHandlers
): void {
  offerings.set(offeringId, { deployed, handlers });
}

export function get(offeringId: string): RegisteredOffering | undefined {
  return offerings.get(offeringId);
}

export function remove(offeringId: string): boolean {
  return offerings.delete(offeringId);
}

export function list(): RegisteredOffering[] {
  return Array.from(offerings.values());
}
