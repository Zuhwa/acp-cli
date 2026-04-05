/**
 * Runtime Loader
 *
 * Loads the developer's handler, validator, and pricer from an offering directory.
 * Used by the offering server to run handler.ts on each request.
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
  const handlerPath = resolve(dir, "handler.ts");
  if (!existsSync(handlerPath)) {
    throw new Error(`handler.ts not found in ${dir}. This file is required.`);
  }
  const handlerModule = await import(handlerPath);
  const handler: Handler = handlerModule.default;

  let validator: Validator | undefined;
  const validatePath = resolve(dir, "validate.ts");
  if (existsSync(validatePath)) {
    const validateModule = await import(validatePath);
    validator = validateModule.default;
  }

  let pricer: Pricer | undefined;
  const pricePath = resolve(dir, "price.ts");
  if (existsSync(pricePath)) {
    const priceModule = await import(pricePath);
    pricer = priceModule.default;
  }

  return { handler, validator, pricer };
}
