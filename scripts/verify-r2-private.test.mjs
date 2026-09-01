import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { privateBucketNames, verifyPrivateR2Buckets } from "./verify-r2-private.mjs";

const configPath = resolve(globalThis.process.cwd(), "wrangler.jsonc");
const apiResponse = (result, status = 200) => new globalThis.Response(JSON.stringify({
  success: status >= 200 && status < 300,
  errors: [],
  messages: [],
  result,
}), { status, headers: { "content-type": "application/json" } });

describe("authenticated R2 privacy preflight", () => {
  it("derives the exact isolated preview and production buckets from Wrangler", () => {
    expect(privateBucketNames(JSON.parse(readFileSync(configPath, "utf8")))).toEqual([
      "cuebench-processing-preview",
      "cuebench-processing-production",
    ]);
  });

  it("verifies bucket existence, disabled r2.dev, and no enabled custom domain without exposing the token", async () => {
    const calls = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: String(url), authorization: new globalThis.Headers(init?.headers).get("authorization") });
      const path = new globalThis.URL(String(url)).pathname;
      const bucket = path.includes("preview") ? "cuebench-processing-preview" : "cuebench-processing-production";
      if (path.endsWith("/domains/managed")) return apiResponse({ bucketId: "opaque", domain: `private-${bucket}.r2.dev`, enabled: false });
      if (path.endsWith("/domains/custom")) return apiResponse({ domains: [{ domain: "disabled.example", enabled: false }] });
      return apiResponse({ name: bucket, jurisdiction: "default", storage_class: "Standard" });
    });

    await expect(verifyPrivateR2Buckets({
      accountId: "a".repeat(32),
      apiToken: "fixture-token",
      configPath,
      fetcher,
    })).resolves.toEqual([
      { bucketName: "cuebench-processing-preview", managedPublicAccess: false, enabledCustomDomains: 0 },
      { bucketName: "cuebench-processing-production", managedPublicAccess: false, enabledCustomDomains: 0 },
    ]);
    expect(calls).toHaveLength(6);
    expect(JSON.stringify(calls.map((call) => call.url))).not.toContain("fixture-token");
    expect(calls.every((call) => call.authorization === "Bearer fixture-token")).toBe(true);
  });

  it.each([
    ["managed development URL", "/domains/managed", { bucketId: "opaque", domain: "public.r2.dev", enabled: true }],
    ["custom public domain", "/domains/custom", { domains: [{ domain: "public.example", enabled: true }] }],
  ])("fails closed for an enabled %s", async (_label, failingPath, failingResult) => {
    const fetcher = async (url) => {
      const path = new globalThis.URL(String(url)).pathname;
      const bucket = path.includes("preview") ? "cuebench-processing-preview" : "cuebench-processing-production";
      if (path.endsWith(failingPath)) return apiResponse(failingResult);
      if (path.endsWith("/domains/managed")) return apiResponse({ bucketId: "opaque", domain: "private.r2.dev", enabled: false });
      if (path.endsWith("/domains/custom")) return apiResponse({ domains: [] });
      return apiResponse({ name: bucket });
    };
    await expect(verifyPrivateR2Buckets({ accountId: "a".repeat(32), apiToken: "token", configPath, fetcher })).rejects.toThrow(/public access/i);
  });

  it("requires authenticated account input and bounded valid API envelopes", async () => {
    await expect(verifyPrivateR2Buckets({ accountId: "", apiToken: "", configPath, fetcher: vi.fn() })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    await expect(verifyPrivateR2Buckets({
      accountId: "a".repeat(32),
      apiToken: "token",
      configPath,
      fetcher: async () => new globalThis.Response("not json", { status: 200 }),
    })).rejects.toThrow(/valid JSON/);
  });
});
