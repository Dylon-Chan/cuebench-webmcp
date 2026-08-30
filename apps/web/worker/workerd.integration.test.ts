/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  issueGenerationRunReceipt,
  R2GenerationRunRecordStore,
  verifyGenerationRunReceipt,
  type GenerationRunRecord,
} from "./generation-routes";
import { resolveWorkerSettings } from "./env";
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
  it("binds the caption-generation Workflow in actual workerd and leaves it dormant until an internal start event", async () => {
    const workflow = env.PROCESSING_WORKFLOW as unknown as {
      readonly create: (input: { readonly id: string; readonly params: { readonly receipt: string; readonly objectKey: string } }) => Promise<{
      readonly id: string;
      readonly status: () => Promise<{ readonly status: string }>;
      }>;
    };
    const id = `caption-generation-workerd-${Date.now()}`;
    const instance = await workflow.create({
      id,
      params: { receipt: "deliberately-unverified-upload-receipt", objectKey: "processing/workerd-contract" },
    });
    expect(instance.id).toBe(id);
    // The first Workflow action is waitForEvent. This proves no preparation
    // or provider work starts merely because an instance was created. Let the
    // isolated Miniflare test runtime dispose this intentionally waiting
    // instance; aborting a wait emits an engine-level diagnostic in workerd.
    expect(["queued", "running", "waiting"]).toContain((await instance.status()).status);
  });

  it("uses real R2 conditional writes so a stale workflow snapshot cannot resurrect a cancelled caption run", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "a".repeat(64);
    const runId = `generation-cas-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-generation-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "b".repeat(64),
      operationId: "workerd-generation-operation",
      operationKey,
      objectKey: `processing/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    const queued = {
      contractVersion: 1 as const,
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: claims.expectedProjectRevision,
      stage: "Queued" as const,
    };
    const store = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    const initial: GenerationRunRecord = {
      version: 1,
      receipt,
      claims,
      status: queued,
      cancelled: false,
      dispatched: true,
      updatedAtMs: currentNow,
    };
    await store.save(initial);
    const staleWorkerSnapshot = await store.load(claims);
    if (staleWorkerSnapshot === null) throw new Error("expected a private generation record in R2");
    const transcribing = { ...queued, stage: "Transcribing" as const, progress: 0 };
    // The Workflow may checkpoint before the POST handler's dispatch-flag
    // write resumes. That stale route snapshot must rebase, not erase this.
    await store.save({
      ...staleWorkerSnapshot,
      status: transcribing,
      workflowState: {
        request: { runId, projectId: claims.projectId },
        stageHistory: [queued, transcribing],
        cancelled: false,
        diarization: { persisted: true },
      },
      updatedAtMs: currentNow + 1,
    });
    await store.save({ ...staleWorkerSnapshot, dispatched: true, updatedAtMs: currentNow + 2 });
    await expect(store.load(claims)).resolves.toMatchObject({
      dispatched: true,
      status: { stage: "Transcribing" },
      workflowState: { diarization: { persisted: true } },
    });
    await store.save({
      ...staleWorkerSnapshot,
      cancelled: true,
      status: { ...queued, stage: "Cancelled" },
      updatedAtMs: currentNow + 3,
    });
    await store.save({
      ...staleWorkerSnapshot,
      status: { ...queued, stage: "AwaitingAdoption" },
      updatedAtMs: currentNow + 4,
    });
    await expect(store.load(claims)).resolves.toMatchObject({
      cancelled: true,
      status: { stage: "Cancelled" },
    });
    await env.PROCESSING_BUCKET.delete(`prepared/${operationKey}/generation-runs/${runId}.json`);
  });

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

  it("keeps an invalid multipart abort non-terminal when local workerd cannot identify it as NoSuchUpload", async () => {
    const anonymousSession = await session();
    const created = await SELF.fetch(post("/api/uploads", {
      projectId: "workerd-r2-abort-project",
      operationId: "workerd-r2-abort-operation",
      media: { byteLength: 5, durationMs: 60_000, contentType: "video/webm" },
      disclosureAccepted: true,
    }, anonymousSession));
    expect(created.status).toBe(201);
    const { operationReceipt } = await created.json() as { readonly operationReceipt: string };
    const receipt = await verifyUploadReceipt(operationReceipt, { keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } } }, Date.now());
    // This object makes a NoSuchUpload abort safety-relevant: a completed
    // object may exist even though the persisted multipart id no longer does.
    await env.PROCESSING_BUCKET.put(receipt.objectKey, "possibly-completed-private-media");
    const stub = env.UPLOAD_COORDINATOR.get(env.UPLOAD_COORDINATOR.idFromName(receipt.operationKey));

    await runInDurableObject(stub, async (_instance, state) => {
      const key = "cuebench-upload-coordinator-v2";
      const record = await state.storage.get<Record<string, unknown>>(key);
      if (record === undefined) throw new Error("expected persisted upload coordinator record");
      await state.storage.put(key, {
        ...record,
        state: "pending",
        multipartUploadId: "expired-no-such-upload",
        expiresAtMs: Date.now() - 1,
        completionLease: null,
        probeLease: null,
        workflowLease: null,
        cancellationLease: null,
        cleanupTarget: null,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const reconciled = await stub.fetch(new Request("https://upload-coordinator.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get", nowMs: Date.now() }),
    }));
    // Current Miniflare reports an unknown multipart with generic 10001,
    // not Workers R2's documented NoSuchUpload (10024). It must therefore
    // remain explicitly recoverable rather than falsely claim deletion.
    expect((await reconciled.json() as { readonly state: string }).state).toBe("cleanup-pending");
    expect(await env.PROCESSING_BUCKET.head(receipt.objectKey)).not.toBeNull();
  });
});
