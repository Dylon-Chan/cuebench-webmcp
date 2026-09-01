import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lifecycleArgsFor, runDeploy, wranglerArgsFor } from "./deploy.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

describe("deploy wrapper argument isolation", () => {
  it("publishes the Cloudflare Vite client build instead of the server environment bundle", async () => {
    const config = JSON.parse(await readFile(resolve(scriptDirectory, "../wrangler.jsonc"), "utf8"));

    expect(config.assets.directory).toBe("./dist/client");
  });

  it("keeps wrapper-only preflight in the lifecycle policy and omits local from Wrangler", () => {
    expect(lifecycleArgsFor(["--preflight", "--dry-run", "--env", "local", "--name", "cuebench"])).toEqual([
      "--dry-run",
      "--preflight",
      "--env",
      "local",
    ]);
    expect(wranglerArgsFor(["--preflight", "--dry-run", "--env", "local", "--name", "cuebench"])).toEqual([
      "--dry-run",
      "--name",
      "cuebench",
    ]);
    expect(wranglerArgsFor(["--env=local", "--preflight"])).toEqual([]);
    expect(wranglerArgsFor(["--env=preview"])).toEqual(["--env=preview"]);
    expect(lifecycleArgsFor(["--dry-run", "--env=production"])).toEqual(["--dry-run", "--env=production"]);
  });

  it("rejects an argument terminator before either deployment runner can start", () => {
    const calls = [];
    const errors = [];
    const status = runDeploy({
      args: ["--", "--dry-run", "--env", "production"],
      nodePath: "node-test",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
      writeError: (message) => errors.push(message),
    });

    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
    expect(errors).toEqual([
      expect.stringContaining("literal `--` argument"),
    ]);
    expect(errors[0]).toContain("node scripts/deploy.mjs --dry-run --env production");
  });

  it("runs a real preflight only through the lifecycle script", () => {
    const calls = [];
    const status = runDeploy({
      args: ["--preflight", "--env", "local"],
      nodePath: "node-test",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining("r2-lifecycle-policy.mjs"), "--preflight", "--env", "local"]));
  });

  it("forwards only valid Wrangler arguments after a successful local lifecycle check", () => {
    const calls = [];
    const status = runDeploy({
      args: ["--dry-run", "--env", "local", "--tag", "candidate"],
      nodePath: "node-test",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toEqual(expect.arrayContaining(["deploy", "--config", "wrangler.jsonc", "--dry-run", "--tag", "candidate"]));
    expect(calls[1]?.[1]).not.toContain("--preflight");
    expect(calls[1]?.[1]).not.toContain("local");
  });

  it("routes a production dry run and emergency container rollout through both runners", () => {
    const calls = [];
    const status = runDeploy({
      args: ["--dry-run", "--env", "production", "--containers-rollout=none"],
      nodePath: "node-test",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual([
      expect.stringContaining("r2-lifecycle-policy.mjs"),
      "--dry-run",
      "--env",
      "production",
    ]);
    expect(calls[1]?.[1]).toEqual([
      expect.stringContaining("wrangler.js"),
      "deploy",
      "--config",
      "wrangler.jsonc",
      "--dry-run",
      "--env",
      "production",
      "--containers-rollout=none",
    ]);
  });
});
