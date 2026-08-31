import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const appDirectory = resolve(scriptDirectory, "..");
const runtime = globalThis.process;

/** Arguments consumed by the checked-in lifecycle policy wrapper. */
export const lifecycleArgsFor = (args) => {
  const lifecycleArgs = [];
  if (args.includes("--dry-run")) lifecycleArgs.push("--dry-run");
  if (args.includes("--preflight")) lifecycleArgs.push("--preflight");
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") {
      lifecycleArgs.push("--env", ...(args[index + 1] === undefined ? [] : [args[index + 1]]));
      index += 1;
    } else if (typeof args[index] === "string" && args[index].startsWith("--env=")) {
      lifecycleArgs.push(args[index]);
    }
  }
  return lifecycleArgs;
};

/**
 * Wrangler has no `[env.local]` namespace: local bindings are the top-level
 * bindings. `--preflight` belongs only to this wrapper and must never become
 * an unknown Wrangler flag (or accidentally deploy after a validation run).
 */
export const wranglerArgsFor = (args) => {
  const wranglerArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--preflight") continue;
    if (argument === "--env") {
      const environment = args[index + 1];
      if (environment !== undefined) {
        if (environment !== "local") wranglerArgs.push("--env", environment);
        index += 1;
      } else {
        // Preserve malformed input so Wrangler can produce its normal error.
        wranglerArgs.push(argument);
      }
      continue;
    }
    if (typeof argument === "string" && argument.startsWith("--env=")) {
      if (argument.slice("--env=".length) !== "local") wranglerArgs.push(argument);
      continue;
    }
    wranglerArgs.push(argument);
  }
  return wranglerArgs;
};

/** Injectable runner keeps deployment argument routing deterministic in tests. */
export const runDeploy = ({
  args = [],
  run = (command, commandArgs) => spawnSync(command, commandArgs, {
    cwd: appDirectory,
    env: runtime.env,
    stdio: "inherit",
  }),
  nodePath = runtime.execPath,
} = {}) => {
  const lifecycle = run(nodePath, [resolve(scriptDirectory, "r2-lifecycle-policy.mjs"), ...lifecycleArgsFor(args)]);
  if (lifecycle.status !== 0) return lifecycle.status ?? 1;
  // A preflight validates the exact lifecycle configuration and stops. It is
  // intentionally not a deploy alias and never invokes Wrangler.
  if (args.includes("--preflight")) return 0;

  // The Vite plugin's generated deploy manifest intentionally contains only
  // its browser bundle view. Deploying the Worker directly is required so
  // Wrangler validates and publishes the Container DO binding, migration,
  // and image.
  const deploy = run(nodePath, [
    resolve(appDirectory, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--config",
    "wrangler.jsonc",
    ...wranglerArgsFor(args),
  ]);
  return deploy.status ?? 1;
};

if (runtime.argv[1] === scriptPath) runtime.exitCode = runDeploy({ args: runtime.argv.slice(2) });
