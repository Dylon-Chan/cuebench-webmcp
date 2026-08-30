/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issueAnonymousSession } from "./session";
import { verifyUploadReceipt } from "./uploads";

const session = async (): Promise<string> => {
  const currentNow = Date.now();
  return issueAnonymousSession({
    sessionId: "workerd-session",
    issuedAtMs: currentNow,
    expiresAtMs: currentNow + 60 * 60_000,
    keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } },
  });
};

const post = (path: string, body: unknown, anonymousSession: string): Request => new Request(`https://cuebench.test${path}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${anonymousSession}`,
    "cf-connecting-ip": "203.0.113.10",
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

describe("workerd hosted upload boundary", () => {
  it("serializes duplicate operation creation in a real Durable Object, uses actual R2 multipart replay, and sets security headers", async () => {
    const anonymousSession = await session();
    const request = () => post("/api/uploads", {
      projectId: "workerd-project",
      operationId: "workerd-operation",
      media: { byteLength: 5, durationMs: 60_000, contentType: "video/webm" },
      disclosureAccepted: true,
    }, anonymousSession);

    const [first, duplicate] = await Promise.all([SELF.fetch(request()), SELF.fetch(request())]);
    const bodies = await Promise.all([first.json(), duplicate.json()]) as Array<{ readonly operationReceipt: string; readonly uploadCapability: string }>;
    const statuses = [first.status, duplicate.status].sort((left, right) => left - right);

    expect(statuses).toEqual([200, 201]);
    expect(bodies[0]?.operationReceipt).toBe(bodies[1]?.operationReceipt);
    expect(first.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");

    const capability = bodies[0]!.uploadCapability;
    const part = () => SELF.fetch(new Request("https://cuebench.test/api/uploads/workerd-operation/parts/1", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "video/webm",
        "x-cuebench-upload-capability": capability,
      },
      body: "hello",
    }));
    const firstPart = await part();
    const repeatedPart = await part();
    expect([firstPart.status, repeatedPart.status]).toEqual([201, 200]);

    const receipt = bodies[0]!.operationReceipt;
    const completion = await SELF.fetch(post("/api/uploads/workerd-operation/complete", {}, anonymousSession,));
    // Completion needs the signed receipt in addition to its normal auth headers.
    expect(completion.status).toBe(401);
    const completed = await SELF.fetch(new Request("https://cuebench.test/api/uploads/workerd-operation/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": receipt,
      },
      body: "{}",
    }));
    expect(completed.status).toBe(503);
    expect((await completed.json() as { error: { code: string } }).error.code).toBe("MEDIA_PROBE_UNAVAILABLE");
    // The runtime path refuses absent authoritative probing before multipart
    // completion, so no completed R2 object survives the response.
    expect((await env.PROCESSING_BUCKET.list()).objects).toHaveLength(0);
  });

  it("runs a real Durable Object alarm that deletes a queued private-object lifecycle before retaining terminal state", async () => {
    const anonymousSession = await session();
    const created = await SELF.fetch(post("/api/uploads", {
      projectId: "workerd-alarm-project",
      operationId: "workerd-alarm-operation",
      media: { byteLength: 5, durationMs: 60_000, contentType: "video/webm" },
      disclosureAccepted: true,
    }, anonymousSession));
    expect(created.status).toBe(201);
    const { operationReceipt } = await created.json() as { readonly operationReceipt: string };
    const receipt = await verifyUploadReceipt(operationReceipt, { keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } } }, Date.now());
    await env.PROCESSING_BUCKET.put(receipt.objectKey, "queued-private-media");
    const stub = env.UPLOAD_COORDINATOR.get(env.UPLOAD_COORDINATOR.idFromName(receipt.operationKey));

    await runInDurableObject(stub, async (_instance, state) => {
      const key = "cuebench-upload-coordinator-v2";
      const record = await state.storage.get<Record<string, unknown>>(key);
      if (record === undefined) throw new Error("expected persisted upload coordinator record");
      await state.storage.put(key, {
        ...record,
        state: "queued",
        expiresAtMs: Date.now() - 1,
        completionLease: null,
        probeLease: null,
        workflowLease: null,
        cancellationLease: null,
        cleanupTarget: null,
      });
      // Keep it in the future so Miniflare does not naturally fire it before
      // `runDurableObjectAlarm` exercises the real alarm handler explicitly.
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const reconciled = await stub.fetch(new Request("https://upload-coordinator.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get", nowMs: Date.now() }),
    }));
    expect((await reconciled.json() as { readonly state: string }).state).toBe("cancelled");
    expect(await env.PROCESSING_BUCKET.head(receipt.objectKey)).toBeNull();
  });
});
