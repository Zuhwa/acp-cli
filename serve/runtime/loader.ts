/**
 * Runtime Loader
 *
 * Loads the developer's handler, validator, and pricer from a serve directory.
 * All are loaded dynamically so optional files (validate.ts, price.ts) are
 * simply skipped if they don't exist.
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type {
  Handler,
  Validator,
  Pricer,
  ServeConfig,
} from "../types";

export interface LoadedHandlers {
  handler: Handler;
  validator?: Validator;
  pricer?: Pricer;
  config: ServeConfig;
}

export async function loadHandlers(dir: string): Promise<LoadedHandlers> {
  const configPath = resolve(dir, "serve.json");
  if (!existsSync(configPath)) {
    throw new Error(`serve.json not found in ${dir}. Run \`acp serve init\` first.`);
  }

  const configContent = (await import("fs")).readFileSync(configPath, "utf-8");
  const config = JSON.parse(configContent) as ServeConfig;

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

  return { handler, validator, pricer, config };
}
