import { describe, expect, it } from "vitest";
import { lifecycleArgsFor, runDeploy, wranglerArgsFor } from "./deploy.mjs";

describe("deploy wrapper argument isolation", () => {
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
});
