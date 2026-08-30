import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptDirectory, "..");
const runtime = globalThis.process;
const args = runtime.argv.slice(2);
const lifecycleArgs = args.includes("--dry-run") ? ["--dry-run"] : [];

const run = (command, commandArgs) => spawnSync(command, commandArgs, {
  cwd: appDirectory,
  env: runtime.env,
  stdio: "inherit",
});

const lifecycle = run(runtime.execPath, [resolve(scriptDirectory, "r2-lifecycle-policy.mjs"), ...lifecycleArgs]);
if (lifecycle.status !== 0) runtime.exit(lifecycle.status ?? 1);

const deploy = run(runtime.execPath, [resolve(appDirectory, "node_modules/wrangler/bin/wrangler.js"), "deploy", ...args]);
runtime.exit(deploy.status ?? 1);
