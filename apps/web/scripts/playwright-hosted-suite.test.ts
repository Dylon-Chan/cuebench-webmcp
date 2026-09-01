import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_SAFE_SPECS, LOOPBACK_FAKE_WORKER_SPECS } from "../e2e/hosted-suite";

describe("hosted Playwright release suite", () => {
  it("includes every browser spec except the explicitly loopback-fake Worker contract", () => {
    const discovered = readdirSync(resolve(import.meta.dirname, "../e2e"))
      .filter((name) => name.endsWith(".spec.ts"))
      .sort();
    expect([...HOSTED_SAFE_SPECS, ...LOOPBACK_FAKE_WORKER_SPECS].sort()).toEqual(discovered);
    expect(LOOPBACK_FAKE_WORKER_SPECS).toEqual(["upload-recovery.spec.ts"]);
  });

  it("cannot silently drop the complete Human, Browser Agent, accessibility, export, and hosted-runtime evidence", () => {
    expect(HOSTED_SAFE_SPECS).toEqual(expect.arrayContaining([
      "human-sample.spec.ts",
      "webmcp-collaboration.spec.ts",
      "accessibility.spec.ts",
      "export-roundtrip.spec.ts",
      "smoke.spec.ts",
      "hosted-smoke.spec.ts",
      "hosted-processing-smoke.spec.ts",
    ]));
  });

  it("requires real Human Turnstile interaction for every hosted processing smoke", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../e2e/hosted-processing-smoke.spec.ts"), "utf8");
    expect(source).not.toContain("preview-test");
    expect(source).toContain('expect(turnstileMode).toBe("human")');
  });
});
