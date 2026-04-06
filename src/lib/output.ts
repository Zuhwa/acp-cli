import type { Command } from "commander";

export function isJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function outputResult(
  json: boolean,
  data: Record<string, unknown>
): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    for (const [key, value] of Object.entries(data)) {
      const display =
        typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
      console.log(`${key}: ${display}`);
    }
  }
}

export function outputError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }) + "\n");
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

export function maskAddress(address: string): string {
  try {
    return address.slice(0, 6) + "..." + address.slice(-4);
  } catch (err) {
    return address;
  }
}

export function isTTY(): boolean {
  if ("NO_COLOR" in process.env) return false;
  if ("FORCE_COLOR" in process.env) return process.env.FORCE_COLOR !== "0";
  if (process.env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}
