import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(scriptDirectory, "..");
const runtime = globalThis.process;
const args = runtime.argv.slice(2);
const target = args[0] === "deploy"
  ? [runtime.execPath, resolve(scriptDirectory, "deploy.mjs"), ...args.slice(1)]
  : [runtime.execPath, resolve(appDirectory, "node_modules/wrangler/bin/wrangler.js"), ...args];
const result = spawnSync(target[0], target.slice(1), {
  cwd: appDirectory,
  env: runtime.env,
  stdio: "inherit",
});
runtime.exit(result.status ?? 1);
