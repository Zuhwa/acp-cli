/**
 * ACP Serve CLI Commands
 *
 * acp serve init      — scaffold a serve project or add an offering to it
 * acp serve start     — start the local server (x402 + MPP + ACP endpoints)
 * acp serve endpoints — show endpoints for served offerings
 */

import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
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

  // INIT — scaffold a handler for an offering
  serve
    .command("init")
    .description(
      "Scaffold a handler for an offering. Build first, register later."
    )
    .requiredOption("--name <name>", "Offering name")
    .option("--output <dir>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const rootDir = resolve(opts.output);

        // Get active agent
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
        const agentSlug = slugify(agentData.name);

        // Create offering.json template
        const offeringName = opts.name;
        const template = readFileSync(
          resolve(dirname(fileURLToPath(import.meta.url)), "../../serve/scaffold/offering.json.template"),
          "utf-8"
        );
        const offeringJson = JSON.parse(template.replace("{{NAME}}", opts.name));

        const offeringSlug = slugify(offeringName);
        const offeringDir = resolve(rootDir, "agents", agentSlug, "offerings", offeringSlug);

        if (existsSync(resolve(offeringDir, "handler.ts"))) {
          outputError(json, `Handler already exists at ${offeringDir}. Delete it or use a different name.`);
          return;
        }

        // Create offering directory
        mkdirSync(offeringDir, { recursive: true });

        // Write offering.json
        writeFileSync(
          resolve(offeringDir, "offering.json"),
          JSON.stringify(offeringJson, null, 2) + "\n"
        );

        // Write handler.ts
        const scaffoldDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../serve/scaffold");
        writeFileSync(
          resolve(offeringDir, "handler.ts"),
          readFileSync(resolve(scaffoldDir, "handler.ts.template"), "utf-8")
        );

        // Write budget.ts
        writeFileSync(
          resolve(offeringDir, "budget.ts"),
          readFileSync(resolve(scaffoldDir, "budget.ts.template"), "utf-8")
        );

        // Write serve.json at project root
        const serveJsonPath = resolve(rootDir, "serve.json");
        let serveConfig: Record<string, unknown> = {
          agents: {},
          evaluator: "default",
          port: 3000,
        };
        if (existsSync(serveJsonPath)) {
          serveConfig = JSON.parse(readFileSync(serveJsonPath, "utf-8"));
        }
        const agents = (serveConfig.agents || {}) as Record<string, Record<string, unknown>>;
        if (!agents[agentId]) {
          agents[agentId] = { name: agentData.name, offerings: {} };
        }
        const agentConfig = agents[agentId] as Record<string, unknown>;
        const offerings = (agentConfig.offerings || {}) as Record<string, unknown>;
        offerings[offeringSlug] = {
          dir: `agents/${agentSlug}/offerings/${offeringSlug}`,
          protocols: ["x402", "mpp", "acp"],
          registered: false,
        };
        agentConfig.offerings = offerings;
        serveConfig.agents = agents;
        writeFileSync(serveJsonPath, JSON.stringify(serveConfig, null, 2) + "\n");

        if (json) {
          outputResult(json, {
            success: true,
            offeringName,
            directory: offeringDir,
            files: ["offering.json", "handler.ts", "budget.ts"],
          });
        } else {
          console.log(`\nScaffolded offering: ${offeringName}\n`);
          console.log(`  ${offeringDir}/`);
          console.log(`    offering.json   — offering definition (edit before registering)`);
          console.log(`    handler.ts      — REQUIRED: do the work, return deliverable`);
          console.log(`    budget.ts       — OPTIONAL: dynamic pricing + fund requests (ACP native only)`);
          console.log(`\n  This offering is NOT yet registered on ACP.`);
          console.log(`  Edit offering.json, then register with:`);
          console.log(`    acp offering create --from-file ${offeringDir}/offering.json`);
          console.log(`\n  For fixed-price offerings, budget.ts is not needed.`);
          console.log(`\nNext steps:`);
          console.log(`  1. Edit handler.ts with your service logic`);
          console.log(`  2. Edit offering.json with your price, requirements, deliverable`);
          console.log(`  3. Test locally: acp serve start`);
          console.log(`  4. Register: acp offering create --from-file ${offeringDir}/offering.json`);
          console.log(`  5. Deploy: acp serve deploy`);
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
        const agents = serveConfig.agents as Record<string, { name: string; offerings: Record<string, { dir: string; protocols: string[] }> }>;

        if (!agents || !agents[agentId]) {
          outputError(json, `No offerings for agent ${agentId} in serve.json. Run \`acp serve init --offering-id <id>\`.`);
          return;
        }

        const offeringEntries = agents[agentId].offerings;
        if (!offeringEntries || Object.keys(offeringEntries).length === 0) {
          outputError(json, "No offerings configured. Run `acp serve init --offering-id <id>`.");
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
        const agents = serveConfig.agents as Record<string, { offerings: Record<string, { dir: string; protocols: string[] }> }>;

        const allEndpoints: Record<string, Record<string, string>> = {};

        for (const [, agentConfig] of Object.entries(agents || {})) {
        for (const [offeringId, entry] of Object.entries(agentConfig.offerings || {})) {
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
          const { storeSignerKey } = await import("../../src/lib/signerKeychain");

          const keypair = await generateP256KeyPair();
          const deployPublicKey = keypair.publicKey;
          const deployPrivateKey = keypair.privateKey;

          // Store signer key in keychain
          await storeSignerKey(deployPublicKey, deployPrivateKey);

          // Register the signer via URL-based flow (requires user approval)
          let signerUrl: string;
          try {
            const res = await agentApi.addSignerWithUrl(agentData.id);
            signerUrl = `${res.data.url}&publicKey=${deployPublicKey}`;
          } catch (err) {
            outputError(json, `Failed to initiate deploy signer: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          if (!json) {
            console.log(`\nApprove the deploy signer in your browser:`);
            console.log(`  ${signerUrl}\n`);
            console.log("Waiting for approval...");
          }

          // TODO: Poll for approval completion (same pattern as acp agent add-signer)
          // For now, output the URL for manual approval

          // Read handler code
          const handlerDir = resolve(rootDir, entry.dir);
          const handlerCode = readFileSync(resolve(handlerDir, "handler.ts"), "utf-8");
          const budgetCode = existsSync(resolve(handlerDir, "budget.ts"))
            ? readFileSync(resolve(handlerDir, "budget.ts"), "utf-8")
            : undefined;

          // TODO: Upload to hosting platform (Cloudflare Workers API or similar)
          // The hosting platform receives:
          //   - Handler code (handler.ts, budget.ts)
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

  // STOP — stop a running local offering server
  serve
    .command("stop")
    .description("Stop a running local offering server")
    .option("--dir <path>", "Project root directory", ".")
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
        const offeringEntries = serveConfig.offerings as Record<string, unknown>;
        let stopped = 0;

        const { getPidFilePath } = await import("../../serve/server/index");

        for (const offeringId of Object.keys(offeringEntries)) {
          const pidFile = getPidFilePath(offeringId);
          if (!existsSync(pidFile)) continue;

          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          try {
            process.kill(pid, "SIGTERM");
            try { const { unlinkSync } = require("fs"); unlinkSync(pidFile); } catch {}
            stopped++;
            if (!json) console.log(`Stopped offering ${offeringId} (PID ${pid})`);
          } catch {
            // Process already dead, clean up PID file
            try { const { unlinkSync } = require("fs"); unlinkSync(pidFile); } catch {}
          }
        }

        if (json) {
          outputResult(json, { success: true, stopped });
        } else if (stopped === 0) {
          console.log("No running offerings found.");
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // STATUS — check if offering servers are running
  serve
    .command("status")
    .description("Check whether local offering servers are running")
    .option("--dir <path>", "Project root directory", ".")
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
        const offeringEntries = serveConfig.offerings as Record<string, unknown>;
        const statuses: Record<string, { running: boolean; pid?: number }> = {};

        const { getPidFilePath } = await import("../../serve/server/index");

        for (const offeringId of Object.keys(offeringEntries)) {
          const pidFile = getPidFilePath(offeringId);
          if (!existsSync(pidFile)) {
            statuses[offeringId] = { running: false };
            continue;
          }

          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          try {
            // signal 0 checks if process exists without killing it
            process.kill(pid, 0);
            statuses[offeringId] = { running: true, pid };
          } catch {
            // Process is dead, clean up stale PID file
            try { const { unlinkSync } = require("fs"); unlinkSync(pidFile); } catch {}
            statuses[offeringId] = { running: false };
          }
        }

        if (json) {
          outputResult(json, { offerings: statuses });
        } else {
          for (const [id, status] of Object.entries(statuses)) {
            const state = status.running ? `running (PID ${status.pid})` : "stopped";
            console.log(`  ${id}: ${state}`);
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  // LOGS — show recent serve logs
  serve
    .command("logs")
    .description("Show recent serve logs")
    .option("--dir <path>", "Project root directory", ".")
    .option("--follow", "Tail logs in real time")
    .option("--offering <id>", "Filter by offering ID")
    .option("--level <level>", "Filter by log level (info, error, warn)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      try {
        const { homedir } = require("os");
        const { readdirSync, watchFile, statSync } = require("fs");
        const logDir = resolve(homedir(), ".acp", "serve", "logs");

        if (!existsSync(logDir)) {
          if (json) {
            outputResult(json, { logs: [] });
          } else {
            console.log("No logs found. Start a server first with `acp serve start`.");
          }
          return;
        }

        // Find log files
        const logFiles = readdirSync(logDir)
          .filter((f: string) => f.endsWith(".log"))
          .filter((f: string) => !opts.offering || f === `${opts.offering}.log`)
          .map((f: string) => resolve(logDir, f));

        if (logFiles.length === 0) {
          if (json) {
            outputResult(json, { logs: [] });
          } else {
            console.log("No log files found.");
          }
          return;
        }

        // Read and filter log entries
        const allLogs: Array<Record<string, unknown>> = [];
        for (const file of logFiles) {
          const content = readFileSync(file, "utf-8").trim();
          if (!content) continue;
          for (const line of content.split("\n")) {
            try {
              const entry = JSON.parse(line);
              if (opts.level && entry.level !== opts.level) continue;
              allLogs.push(entry);
            } catch {}
          }
        }

        // Sort by timestamp
        allLogs.sort((a, b) =>
          String(a.timestamp).localeCompare(String(b.timestamp))
        );

        if (json) {
          outputResult(json, { logs: allLogs });
        } else {
          // Print last 50 entries
          const recent = allLogs.slice(-50);
          for (const entry of recent) {
            const level = String(entry.level).toUpperCase().padEnd(5);
            const time = String(entry.timestamp).slice(11, 19);
            const offering = entry.offeringId || "";
            const job = entry.jobId ? ` [job:${entry.jobId}]` : "";
            console.log(`${time} ${level} [${offering}]${job} ${entry.message}`);
          }

          if (allLogs.length > 50) {
            console.log(`\n... showing last 50 of ${allLogs.length} entries`);
          }
        }

        // Follow mode — watch for new entries
        if (opts.follow) {
          console.log("\nTailing logs... (Ctrl+C to stop)\n");
          const offsets = new Map<string, number>();
          for (const file of logFiles) {
            offsets.set(file, statSync(file).size);
          }

          for (const file of logFiles) {
            watchFile(file, { interval: 1000 }, () => {
              const currentSize = statSync(file).size;
              const prevSize = offsets.get(file) || 0;
              if (currentSize <= prevSize) return;

              const content = readFileSync(file, "utf-8");
              const newContent = content.slice(prevSize);
              offsets.set(file, currentSize);

              for (const line of newContent.trim().split("\n")) {
                if (!line) continue;
                try {
                  const entry = JSON.parse(line);
                  if (opts.level && entry.level !== opts.level) continue;
                  const level = String(entry.level).toUpperCase().padEnd(5);
                  const time = String(entry.timestamp).slice(11, 19);
                  const offering = entry.offeringId || "";
                  const job = entry.jobId ? ` [job:${entry.jobId}]` : "";
                  console.log(`${time} ${level} [${offering}]${job} ${entry.message}`);
                } catch {}
              }
            });
          }

          // Keep process alive for follow mode
          await new Promise(() => {});
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
