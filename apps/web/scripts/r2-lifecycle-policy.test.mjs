import { describe, expect, it } from "vitest";
import {
  LifecyclePolicyError,
  PROCESSING_LIFECYCLE_POLICY,
  main,
  provisionAndVerifyLifecycle,
  validateProcessingBucketBinding,
  validateLifecyclePolicy,
} from "./r2-lifecycle-policy.mjs";

const apiResponse = (result, status = 200) => new globalThis.Response(JSON.stringify({ success: status >= 200 && status < 300, result }), {
  status,
  headers: { "content-type": "application/json" },
});

const streamedApiResponse = (result, status = 200) => {
  const body = new globalThis.TextEncoder().encode(JSON.stringify({ success: status >= 200 && status < 300, result }));
  return {
    ok: status >= 200 && status < 300,
    headers: new globalThis.Headers({ "content-type": "application/json" }),
    body: new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
};

describe("CueBench R2 lifecycle deployment policy", () => {
  it("declares enabled processing and prepared deletion plus processing multipart-abort transitions at no more than 24 hours", () => {
    expect(validateLifecyclePolicy(PROCESSING_LIFECYCLE_POLICY)).toEqual(PROCESSING_LIFECYCLE_POLICY);
    expect(() => validateLifecyclePolicy({
      ...PROCESSING_LIFECYCLE_POLICY,
      rules: PROCESSING_LIFECYCLE_POLICY.rules.map((rule) => rule.id === "cuebench-processing-expire-24h"
        ? { ...rule, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_401 } } }
        : rule),
    })).toThrow(LifecyclePolicyError);
    expect(() => validateLifecyclePolicy({
      ...PROCESSING_LIFECYCLE_POLICY,
      rules: PROCESSING_LIFECYCLE_POLICY.rules.filter((rule) => rule.id !== "cuebench-prepared-expire-24h"),
    })).toThrow(/prepared/);
  });

  it("preflights the checked-in declarative policy without credentials or network access", async () => {
    const noNetwork = async () => { throw new Error("preflight must not call the lifecycle API"); };
    await expect(main({ argv: ["--dry-run"], env: {}, fetcher: noNetwork })).resolves.toEqual(PROCESSING_LIFECYCLE_POLICY);
  });

  it("fails closed if the declarative lifecycle bucket is not the Wrangler PROCESSING_BUCKET binding", () => {
    expect(validateProcessingBucketBinding(PROCESSING_LIFECYCLE_POLICY, {
      r2_buckets: [{ binding: "PROCESSING_BUCKET", bucket_name: "cuebench-processing-local" }],
    })).toEqual(PROCESSING_LIFECYCLE_POLICY);
    expect(() => validateProcessingBucketBinding(PROCESSING_LIFECYCLE_POLICY, {
      r2_buckets: [{ binding: "PROCESSING_BUCKET", bucket_name: "different-private-bucket" }],
    })).toThrow(/does not match the Wrangler PROCESSING_BUCKET binding/);
  });

  it("puts the declarative policy then fetches it again and fails closed unless both retention rules match", async () => {
    const calls = [];
    const fetcher = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      if (init.method === "PUT") return apiResponse({});
      return apiResponse({ rules: PROCESSING_LIFECYCLE_POLICY.rules });
    };

    await expect(provisionAndVerifyLifecycle({
      policy: PROCESSING_LIFECYCLE_POLICY,
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "fixture-token",
      fetcher,
    })).resolves.toEqual(PROCESSING_LIFECYCLE_POLICY);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls[1].input).toContain("/accounts/0123456789abcdef0123456789abcdef/r2/buckets/cuebench-processing-local/lifecycle");
    expect(calls[1].init.headers).toMatchObject({ authorization: "Bearer fixture-token" });
    expect(JSON.parse(calls[1].init.body)).toEqual({ rules: PROCESSING_LIFECYCLE_POLICY.rules });
  });

  it("reads lifecycle responses through a bounded stream instead of materializing an unbounded response", async () => {
    const fetcher = async (_input, init = {}) => init.method === "PUT"
      ? streamedApiResponse({})
      : streamedApiResponse({ rules: PROCESSING_LIFECYCLE_POLICY.rules });

    await expect(provisionAndVerifyLifecycle({
      policy: PROCESSING_LIFECYCLE_POLICY,
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "fixture-token",
      fetcher,
    })).resolves.toEqual(PROCESSING_LIFECYCLE_POLICY);
  });

  it("fails closed for missing credentials and when the post-provision API response does not contain the required policy", async () => {
    const neverFetch = async () => { throw new Error("must not call API"); };
    await expect(provisionAndVerifyLifecycle({
      policy: PROCESSING_LIFECYCLE_POLICY,
      accountId: "",
      apiToken: "",
      fetcher: neverFetch,
    })).rejects.toThrow(LifecyclePolicyError);

    let request = 0;
    const mismatchedFetcher = async (_input, init = {}) => {
      request += 1;
      if (init.method === "PUT") return apiResponse({});
      return apiResponse({ rules: request === 1 ? [] : [] });
    };
    await expect(provisionAndVerifyLifecycle({
      policy: PROCESSING_LIFECYCLE_POLICY,
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "fixture-token",
      fetcher: mismatchedFetcher,
    })).rejects.toThrow(/does not contain the required CueBench retention policy/);
  });
});
