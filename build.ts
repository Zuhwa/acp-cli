/**
 * ACP CLI Build Script
 *
 * Compiles the TypeScript source into a single bundled JavaScript file
 * or an encrypted native binary.
 *
 * Usage:
 *   bun run build.ts                    # Bundle to dist/cli.js
 *   bun run build.ts --compile          # Compile to native binary (dist/acp)
 *   bun run build.ts --compile --minify # Compile + minify (smaller binary)
 *
 * The bundled output includes all dependencies (commander, viem, etc.)
 * in a single file. No node_modules needed at runtime.
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);
const shouldCompile = args.includes("--compile");
const shouldMinify = args.includes("--minify");

const entrypoint = resolve("bin/acp.ts");
const outdir = resolve("dist");

// Clean dist
if (existsSync(outdir)) {
  rmSync(outdir, { recursive: true });
}
mkdirSync(outdir, { recursive: true });

if (shouldCompile) {
  // Step 1: Bundle to JS first (with plugins for TS packages)
  console.log("Step 1: Bundling...");

  const bundleResult = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    minify: shouldMinify,
    packages: "bundle",
    external: ["cross-keychain"],
    plugins: [
      {
        name: "resolve-ts-packages",
        setup(build) {
          build.onResolve({ filter: /^acp-node-v2/ }, (args) => {
            const subpath = args.path.replace("acp-node-v2", "");
            const resolved = subpath
              ? resolve("node_modules/acp-node-v2/src", subpath)
              : resolve("node_modules/acp-node-v2/src/index.ts");
            return { path: resolved };
          });
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  if (!bundleResult.success) {
    console.error("Bundle step failed:");
    for (const log of bundleResult.logs) console.error(log);
    process.exit(1);
  }

  // Step 2: Compile the bundled JS to native binary
  console.log("Step 2: Compiling to native binary...");

  const compileResult = Bun.spawnSync([
    "bun",
    "build",
    resolve(outdir, "acp.js"),
    "--compile",
    "--outfile",
    resolve(outdir, "acp"),
  ]);

  if (compileResult.exitCode !== 0) {
    console.error("Compile failed:");
    console.error(new TextDecoder().decode(compileResult.stderr));
    process.exit(1);
  }

  console.log("Compiled binary: dist/acp");
  console.log("Run with: ./dist/acp [command]");
} else {
  // Bundle to single JS file
  console.log("Bundling to single JS file...");

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "node",
    format: "esm",
    minify: shouldMinify,
    sourcemap: "external",
    packages: "bundle",
    external: [
      // Native addons that require .node binaries
      "cross-keychain",
    ],
    plugins: [
      {
        name: "resolve-ts-packages",
        setup(build) {
          // Resolve acp-node-v2 from source (no compiled dist/)
          build.onResolve({ filter: /^acp-node-v2/ }, (args) => {
            const subpath = args.path.replace("acp-node-v2", "");
            const resolved = subpath
              ? resolve("node_modules/acp-node-v2/src", subpath)
              : resolve("node_modules/acp-node-v2/src/index.ts");
            return { path: resolved };
          });
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Rename output to cli.js
  const outputFiles = result.outputs.map((o) => o.path);
  console.log(`Bundled: ${outputFiles.join(", ")}`);
  console.log("Run with: node dist/acp.js [command]");
}
