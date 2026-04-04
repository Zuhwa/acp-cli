/**
 * Runtime Loader
 *
 * Loads the developer's handler, validator, and pricer from an offering directory.
 * Optional files (validate.ts, price.ts) are skipped if they don't exist.
 *
 * Directory structure:
 *   offerings/logo-design/
 *     handler.ts    — REQUIRED
 *     validate.ts   — OPTIONAL
 *     price.ts      — OPTIONAL
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type { Handler, Validator, Pricer } from "../types";

export interface LoadedHandlers {
  handler: Handler;
  validator?: Validator;
  pricer?: Pricer;
}

export async function loadHandlers(dir: string): Promise<LoadedHandlers> {
  // Handler is required
  const handlerPath = resolve(dir, "handler.ts");
  if (!existsSync(handlerPath)) {
    throw new Error(`handler.ts not found in ${dir}. This file is required.`);
  }
  const handlerModule = await import(handlerPath);
  const handler: Handler = handlerModule.default;

  // Validator is optional
  let validator: Validator | undefined;
  const validatePath = resolve(dir, "validate.ts");
  if (existsSync(validatePath)) {
    const validateModule = await import(validatePath);
    validator = validateModule.default;
  }

  // Pricer is optional
  let pricer: Pricer | undefined;
  const pricePath = resolve(dir, "price.ts");
  if (existsSync(pricePath)) {
    const priceModule = await import(pricePath);
    pricer = priceModule.default;
  }

  return { handler, validator, pricer };
}
