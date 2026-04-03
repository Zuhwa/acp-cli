/**
 * ACP Serve CLI Commands
 *
 * acp serve init    — scaffold a serve directory with handler templates
 * acp serve start   — start the local server (x402 + MPP + ACP endpoints)
 * acp serve endpoints — show the endpoints for a running/deployed offering
 */

import { resolve } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { getActiveWallet, getAgentId } from "../lib/config";
import { getClient } from "../lib/api/client";

export function registerServeCommands(program: Command): void {
  const serve = program
    .command("serve")
    .description("Deploy and run offerings as x402/MPP/ACP endpoints");

  // INIT — scaffold a serve directory
  serve
    .command("init")
    .description("Scaffold a serve directory with handler templates")
    .requiredOption("--offering-id <id>", "Offering ID to serve")
    .option("--output <dir>", "Output directory", "./serve")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      const outDir = resolve(opts.output);

      if (existsSync(resolve(outDir, "serve.json"))) {
        outputError(json, `serve.json already exists in ${outDir}. Delete it or use a different --output directory.`);
        return;
      }

      // Create directory
      mkdirSync(outDir, { recursive: true });

      // Write serve.json
      const configTemplate = readFileSync(
        resolve(__dirname, "../../serve/scaffold/serve.json.template"),
        "utf-8"
      );
      writeFileSync(
        resolve(outDir, "serve.json"),
        configTemplate.replace("{{OFFERING_ID}}", opts.offeringId)
      );

      // Write handler.ts
      const handlerTemplate = readFileSync(
        resolve(__dirname, "../../serve/scaffold/handler.ts.template"),
        "utf-8"
      );
      writeFileSync(resolve(outDir, "handler.ts"), handlerTemplate);

      // Write validate.ts
      const validateTemplate = readFileSync(
        resolve(__dirname, "../../serve/scaffold/validate.ts.template"),
        "utf-8"
      );
      writeFileSync(resolve(outDir, "validate.ts"), validateTemplate);

      // Write price.ts
      const priceTemplate = readFileSync(
        resolve(__dirname, "../../serve/scaffold/price.ts.template"),
        "utf-8"
      );
      writeFileSync(resolve(outDir, "price.ts"), priceTemplate);

      if (json) {
        outputResult(json, {
          success: true,
          directory: outDir,
          files: ["serve.json", "handler.ts", "validate.ts", "price.ts"],
        });
      } else {
        console.log(`\nScaffolded serve directory: ${outDir}\n`);
        console.log("  serve.json      — configuration (offering ID, protocols)");
        console.log("  handler.ts      — REQUIRED: implement your service logic");
        console.log("  validate.ts     — OPTIONAL: accept/reject jobs (delete if not needed)");
        console.log("  price.ts        — OPTIONAL: dynamic pricing (delete if not needed)");
        console.log(`\nNext steps:`);
        console.log(`  1. Edit handler.ts with your service logic`);
        console.log(`  2. Run: acp serve start --dir ${opts.output}`);
      }
    });

  // START — run the local server
  serve
    .command("start")
    .description("Start the local serve runtime (x402 + MPP + ACP endpoints)")
    .requiredOption("--dir <path>", "Path to the serve directory")
    .option("--port <number>", "Port to listen on")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        // Get provider wallet
        const wallet = getActiveWallet();
        if (!wallet) {
          outputError(json, "No active agent set. Run `acp agent use` first.");
          return;
        }

        const agentId = getAgentId(wallet);
        if (!agentId) {
          outputError(json, "Agent ID not found. Run `acp agent list` or `acp agent use`.");
          return;
        }

        // Load serve.json to get offering ID
        const serveJsonPath = resolve(opts.dir, "serve.json");
        if (!existsSync(serveJsonPath)) {
          outputError(json, `serve.json not found in ${opts.dir}. Run \`acp serve init\` first.`);
          return;
        }
        const serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));

        // Fetch offering from ACP API
        const { agentApi } = await getClient();
        const agentData = await agentApi.getById(agentId);
        const offering = agentData.offerings?.find(
          (o) => o.id === serveConfig.offeringId
        );

        if (!offering) {
          outputError(
            json,
            `Offering ${serveConfig.offeringId} not found on agent ${agentData.name}. Run \`acp offering list\` to see available offerings.`
          );
          return;
        }

        // Start the server
        const { startServer } = await import("../../serve/index");
        await startServer({
          dir: resolve(opts.dir),
          port: opts.port ? Number(opts.port) : undefined,
          providerWallet: wallet,
          offering: {
            id: offering.id,
            name: offering.name,
            description: offering.description,
            priceType: offering.priceType,
            priceValue: Number(offering.priceValue),
            slaMinutes: offering.slaMinutes,
            requirements: offering.requirements,
            deliverable: offering.deliverable,
          },
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // ENDPOINTS — show endpoints for an offering
  serve
    .command("endpoints")
    .description("Show the x402/MPP/ACP endpoints for a served offering")
    .requiredOption("--dir <path>", "Path to the serve directory")
    .option("--port <number>", "Port the server is running on", "3000")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const serveJsonPath = resolve(opts.dir, "serve.json");
        if (!existsSync(serveJsonPath)) {
          outputError(json, `serve.json not found in ${opts.dir}.`);
          return;
        }

        const serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        const port = opts.port;
        const id = serveConfig.offeringId;

        const endpoints: Record<string, string> = {};
        if (serveConfig.protocols.includes("x402")) {
          endpoints.x402 = `http://localhost:${port}/x402/${id}`;
        }
        if (serveConfig.protocols.includes("mpp")) {
          endpoints.mpp = `http://localhost:${port}/mpp/${id}`;
        }
        if (serveConfig.protocols.includes("acp")) {
          endpoints.acp = "listening for events (native)";
        }

        if (json) {
          outputResult(json, { offeringId: id, endpoints });
        } else {
          console.log(`\nEndpoints for offering ${id}:\n`);
          for (const [protocol, url] of Object.entries(endpoints)) {
            console.log(`  ${protocol.toUpperCase().padEnd(5)} ${url}`);
          }
          console.log();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
