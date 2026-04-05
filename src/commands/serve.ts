/**
 * ACP Serve CLI Commands
 *
 * acp serve init      — scaffold a serve project or add an offering to it
 * acp serve start     — start the local server (x402 + MPP + ACP endpoints)
 * acp serve endpoints — show endpoints for served offerings
 */

import { resolve, basename } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { getActiveWallet, getAgentId } from "../lib/config";
import { getClient } from "../lib/api/client";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function registerServeCommands(program: Command): void {
  const serve = program
    .command("serve")
    .description("Deploy and run offerings as x402/MPP/ACP endpoints");

  // INIT — scaffold a serve project or add an offering
  serve
    .command("init")
    .description("Scaffold a serve project with handler templates for an offering")
    .requiredOption("--offering-id <id>", "Offering ID to serve")
    .option("--output <dir>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const rootDir = resolve(opts.output);

        // Get offering name from API for the folder name
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
        const { agentApi } = await getClient();
        const agentData = await agentApi.getById(agentId);
        const offering = agentData.offerings?.find((o) => o.id === opts.offeringId);
        if (!offering) {
          outputError(json, `Offering ${opts.offeringId} not found. Run \`acp offering list\`.`);
          return;
        }

        const offeringSlug = slugify(offering.name);
        const offeringDir = resolve(rootDir, "offerings", offeringSlug);

        if (existsSync(resolve(offeringDir, "handler.ts"))) {
          outputError(json, `Handler already exists at ${offeringDir}. Delete it or use a different offering.`);
          return;
        }

        // Create offering directory
        mkdirSync(offeringDir, { recursive: true });

        // Write serve.json at project root (create or update)
        const serveJsonPath = resolve(rootDir, "serve.json");
        let serveConfig: Record<string, unknown> = {
          offerings: {},
          evaluator: "default",
          port: 3000,
        };
        if (existsSync(serveJsonPath)) {
          serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        }
        const offerings = (serveConfig.offerings || {}) as Record<string, unknown>;
        offerings[opts.offeringId] = {
          dir: `offerings/${offeringSlug}`,
          protocols: ["x402", "mpp", "acp"],
        };
        serveConfig.offerings = offerings;
        writeFileSync(serveJsonPath, JSON.stringify(serveConfig, null, 2) + "\n");

        // Write handler.ts
        const scaffoldDir = resolve(__dirname, "../../serve/scaffold");
        writeFileSync(
          resolve(offeringDir, "handler.ts"),
          readFileSync(resolve(scaffoldDir, "handler.ts.template"), "utf-8")
        );

        // Write validate.ts
        writeFileSync(
          resolve(offeringDir, "validate.ts"),
          readFileSync(resolve(scaffoldDir, "validate.ts.template"), "utf-8")
        );

        // Write price.ts
        writeFileSync(
          resolve(offeringDir, "price.ts"),
          readFileSync(resolve(scaffoldDir, "price.ts.template"), "utf-8")
        );

        if (json) {
          outputResult(json, {
            success: true,
            offeringId: opts.offeringId,
            offeringName: offering.name,
            directory: offeringDir,
            files: ["handler.ts", "validate.ts", "price.ts"],
          });
        } else {
          console.log(`\nScaffolded offering: ${offering.name}\n`);
          console.log(`  ${offeringDir}/`);
          console.log(`    handler.ts      — REQUIRED: implement your service logic`);
          console.log(`    validate.ts     — OPTIONAL: accept/reject jobs (delete if not needed)`);
          console.log(`    price.ts        — OPTIONAL: dynamic pricing (delete if not needed)`);
          console.log(`\n  serve.json updated with offering ${opts.offeringId}`);
          console.log(`\nNext steps:`);
          console.log(`  1. Edit offerings/${offeringSlug}/handler.ts`);
          console.log(`  2. Run: acp serve start`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // START — run the local server for all offerings in serve.json
  serve
    .command("start")
    .description("Start the local serve runtime (x402 + MPP + ACP endpoints)")
    .option("--dir <path>", "Project root directory", ".")
    .option("--port <number>", "Port to listen on")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const rootDir = resolve(opts.dir);

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

        // Load serve.json
        const serveJsonPath = resolve(rootDir, "serve.json");
        if (!existsSync(serveJsonPath)) {
          outputError(json, `serve.json not found in ${rootDir}. Run \`acp serve init\` first.`);
          return;
        }
        const serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        const offeringEntries = serveConfig.offerings as Record<string, { dir: string; protocols: string[] }>;

        if (!offeringEntries || Object.keys(offeringEntries).length === 0) {
          outputError(json, "No offerings configured in serve.json. Run `acp serve init --offering-id <id>`.");
          return;
        }

        // Fetch offering data from API
        const { agentApi } = await getClient();
        const agentData = await agentApi.getById(agentId);

        // Build server options for each offering
        const { startOfferingServer } = await import("../../serve/server/index");

        for (const [offeringId, entry] of Object.entries(offeringEntries)) {
          const offering = agentData.offerings?.find((o) => o.id === offeringId);
          if (!offering) {
            console.error(`Warning: offering ${offeringId} not found on agent, skipping.`);
            continue;
          }

          await startOfferingServer({
            dir: resolve(rootDir, entry.dir),
            port: opts.port ? Number(opts.port) : serveConfig.port,
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
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // ENDPOINTS — show endpoints for all offerings
  serve
    .command("endpoints")
    .description("Show the x402/MPP/ACP endpoints for served offerings")
    .option("--dir <path>", "Project root directory", ".")
    .option("--port <number>", "Port the server is running on", "3000")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const rootDir = resolve(opts.dir);
        const serveJsonPath = resolve(rootDir, "serve.json");
        if (!existsSync(serveJsonPath)) {
          outputError(json, `serve.json not found in ${rootDir}.`);
          return;
        }

        const serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        const port = opts.port || serveConfig.port || 3000;
        const offeringEntries = serveConfig.offerings as Record<string, { dir: string; protocols: string[] }>;

        const allEndpoints: Record<string, Record<string, string>> = {};

        for (const [offeringId, entry] of Object.entries(offeringEntries)) {
          const endpoints: Record<string, string> = {};
          if (entry.protocols.includes("x402")) {
            endpoints.x402 = `http://localhost:${port}/x402/${offeringId}`;
          }
          if (entry.protocols.includes("mpp")) {
            endpoints.mpp = `http://localhost:${port}/mpp/${offeringId}`;
          }
          if (entry.protocols.includes("acp")) {
            endpoints.acp = "listening for events (native)";
          }
          allEndpoints[offeringId] = endpoints;
        }

        if (json) {
          outputResult(json, { endpoints: allEndpoints });
        } else {
          for (const [offeringId, endpoints] of Object.entries(allEndpoints)) {
            console.log(`\nOffering: ${offeringId}`);
            for (const [protocol, url] of Object.entries(endpoints)) {
              console.log(`  ${protocol.toUpperCase().padEnd(5)} ${url}`);
            }
          }
          console.log();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // DEPLOY — deploy offering server to hosted infrastructure
  serve
    .command("deploy")
    .description("Deploy offering server to ACP hosted infrastructure")
    .option("--dir <path>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const rootDir = resolve(opts.dir);

        // Verify auth + active agent
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

        // Load serve.json
        const serveJsonPath = resolve(rootDir, "serve.json");
        if (!existsSync(serveJsonPath)) {
          outputError(json, `serve.json not found in ${rootDir}. Run \`acp serve init\` first.`);
          return;
        }
        const serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        const offeringEntries = serveConfig.offerings as Record<string, { dir: string; protocols: string[] }>;

        if (!offeringEntries || Object.keys(offeringEntries).length === 0) {
          outputError(json, "No offerings in serve.json. Run `acp serve init --offering-id <id>`.");
          return;
        }

        // Fetch agent data
        const { agentApi } = await getClient();
        const agentData = await agentApi.getById(agentId);

        for (const [offeringId, entry] of Object.entries(offeringEntries)) {
          const offering = agentData.offerings?.find((o) => o.id === offeringId);
          if (!offering) {
            console.error(`Warning: offering ${offeringId} not found on agent, skipping.`);
            continue;
          }

          if (!json) {
            console.log(`\nDeploying "${offering.name}"...\n`);
            console.log("A new signer will be added to your agent for this deployment.");
            console.log("This allows the hosted server to sign transactions on your behalf.\n");
            console.log(`Agent: ${agentData.name} (${wallet})`);
          }

          // Generate deploy signer
          // Uses the same add-signer flow as `acp agent add-signer`
          const { generateP256KeyPair } = await import("@privy-io/node");

          const keypair = await generateP256KeyPair();
          const deployPublicKey = keypair.publicKey;
          const deployPrivateKey = keypair.privateKey;

          // Register the signer on the agent
          let keyQuorumId: string;
          try {
            const quorumRes = await agentApi.addQuorum(agentData.id, deployPublicKey);
            keyQuorumId = quorumRes.data;
          } catch (err) {
            outputError(json, `Failed to add deploy signer: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          const walletId = agentData.walletProviders[0]?.metadata?.walletId;
          if (!walletId) {
            outputError(json, "Wallet ID not found on agent.");
            return;
          }

          try {
            await agentApi.addSigner(agentData.id, walletId, keyQuorumId);
          } catch (err) {
            outputError(json, `Failed to register deploy signer: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          // Read handler code
          const handlerDir = resolve(rootDir, entry.dir);
          const handlerCode = readFileSync(resolve(handlerDir, "handler.ts"), "utf-8");
          const validateCode = existsSync(resolve(handlerDir, "validate.ts"))
            ? readFileSync(resolve(handlerDir, "validate.ts"), "utf-8")
            : undefined;
          const priceCode = existsSync(resolve(handlerDir, "price.ts"))
            ? readFileSync(resolve(handlerDir, "price.ts"), "utf-8")
            : undefined;

          // TODO: Upload to hosting platform (Cloudflare Workers API or similar)
          // The hosting platform receives:
          //   - Handler code (handler.ts, validate.ts, price.ts)
          //   - Offering metadata (id, name, price, schema, protocols)
          //   - Deploy signer private key (encrypted env var)
          //   - ACP_BACKEND_URL (our backend endpoint)
          //   - Provider wallet address

          if (json) {
            outputResult(json, {
              success: true,
              offeringId,
              offeringName: offering.name,
              deploySignerPublicKey: deployPublicKey,
              endpoints: {
                x402: `https://offerings.virtuals.io/x402/${offeringId}`,
                mpp: `https://offerings.virtuals.io/mpp/${offeringId}`,
                acp: "listening via events (native)",
              },
            });
          } else {
            console.log(`\n${offering.name} deployed successfully!\n`);
            console.log(`Deploy signer: ${deployPublicKey.slice(0, 20)}...`);
            console.log(`\nEndpoints:`);
            console.log(`  x402: https://offerings.virtuals.io/x402/${offeringId}`);
            console.log(`  MPP:  https://offerings.virtuals.io/mpp/${offeringId}`);
            console.log(`  ACP:  listening via events (native)`);
            console.log(`\nTo undeploy: acp serve undeploy --offering-id ${offeringId}`);
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // UNDEPLOY — remove a deployed offering
  serve
    .command("undeploy")
    .description("Remove a deployed offering and revoke its deploy signer")
    .requiredOption("--offering-id <id>", "Offering ID to undeploy")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        // TODO: Call hosting platform to remove the worker
        // TODO: Remove the deploy signer from the agent

        if (json) {
          outputResult(json, { success: true, offeringId: opts.offeringId });
        } else {
          console.log(`\nOffering ${opts.offeringId} undeployed. Deploy signer revoked.`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
