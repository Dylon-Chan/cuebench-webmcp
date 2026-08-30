import { describe, expect, it } from "vitest";
import { InMemoryUploadCoordinator, UploadCoordinator, cleanupTargetForLifecycle } from "./upload-operations";

const operation = {
  ownerSessionKey: "session-hash",
  ownerIpKey: "network-hash",
  metadataHash: "metadata-hash",
  reservationKey: "reservation-hash",
  objectKey: "processing/session-hash/operation-hash",
  byteLength: 8,
  partSize: 8,
  partCount: 1,
  nowMs: 0,
  expiresAtMs: 10_000,
  receiptExpiresAtMs: 10_000,
} as const;

const readyCoordinator = async (): Promise<InMemoryUploadCoordinator> => {
  const coordinator = new InMemoryUploadCoordinator();
  await coordinator.begin(operation);
  await coordinator.attachMultipart({ uploadId: "multipart-1", nowMs: 0 });
  return coordinator;
};

describe("UploadCoordinator reconciliation state machine", () => {
  it.each([
    ["creating", "uncertain"],
    ["pending", "multipart"],
    ["uploaded", "multipart"],
    ["completing", "uncertain"],
    ["failed-retryable", "uncertain"],
    ["probing", "completed"],
    ["ready", "completed"],
    ["workflow-starting", "completed"],
    ["queued", "completed"],
    ["completed", "completed"],
  ] as const)("derives a retention-safe cleanup target for %s", (state, objectState) => {
    expect(cleanupTargetForLifecycle({ state, multipartUploadId: "multipart-1" }, "expiry-alarm")).toMatchObject({
      objectState,
      multipartUploadId: "multipart-1",
    });
  });

  it("fences a stale part lease so its late R2 result cannot overwrite a newer receipt", async () => {
    const coordinator = await readyCoordinator();
    const first = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "first" });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("expected first claim");

    const second = await coordinator.claimPart({ partNumber: 1, nowMs: 11, leaseMs: 10, createId: () => "second" });
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") throw new Error("expected replacement claim");

    const stale = await coordinator.recordPart({
      partNumber: 1,
      claimId: first.claim.id,
      claimGeneration: first.claim.generation,
      etag: "late-etag",
      byteLength: 8,
      nowMs: 11,
    });
    expect(stale.kind).toBe("stale");
    expect((await coordinator.get(11))?.parts).toEqual({});

    const recorded = await coordinator.recordPart({
      partNumber: 1,
      claimId: second.claim.id,
      claimGeneration: second.claim.generation,
      etag: "current-etag",
      byteLength: 8,
      nowMs: 11,
    });
    expect(recorded.kind).toBe("recorded");
    expect((await coordinator.get(11))?.state).toBe("uploaded");
  });

  it("retains the exact cleanup target until both private storage and quota acknowledge cancellation", async () => {
    const coordinator = await readyCoordinator();
    const cancellation = await coordinator.claimCancellation({
      nowMs: 1,
      leaseMs: 10,
      createId: () => "cancel-1",
      target: { objectState: "multipart", multipartUploadId: "multipart-1", reason: "user-cancel" },
    });
    expect(cancellation.kind).toBe("claimed");
    if (cancellation.kind !== "claimed") throw new Error("expected cancellation lease");

    const pending = await coordinator.finishCleanup({
      claimId: cancellation.claim.id,
      claimGeneration: cancellation.claim.generation,
      r2Acknowledged: true,
      quotaAcknowledged: false,
      nowMs: 2,
    });
    expect(pending?.state).toBe("cleanup-pending");
    expect(pending?.cleanupTarget).toMatchObject({ objectState: "multipart", multipartUploadId: "multipart-1" });

    const retry = await coordinator.claimCancellation({
      nowMs: 12,
      leaseMs: 10,
      createId: () => "cancel-2",
      target: { objectState: "uncertain", multipartUploadId: null, reason: "ignored-by-persisted-target" },
    });
    expect(retry.kind).toBe("claimed");
    if (retry.kind !== "claimed") throw new Error("expected cleanup retry lease");
    const cancelled = await coordinator.finishCleanup({
      claimId: retry.claim.id,
      claimGeneration: retry.claim.generation,
      r2Acknowledged: true,
      quotaAcknowledged: true,
      nowMs: 12,
    });
    expect(cancelled?.state).toBe("cancelled");
  });

  it("moves abandoned multipart work into an explicit cleanup target instead of forgetting the upload id", async () => {
    const coordinator = await readyCoordinator();
    const expired = await coordinator.get(10_001);
    expect(expired?.state).toBe("cleanup-pending");
    expect(expired?.cleanupTarget).toEqual({ objectState: "multipart", multipartUploadId: "multipart-1", reason: "lease-expired" });
  });

  it("promotes a stale multipart cancellation target after completion may have produced an object", async () => {
    const coordinator = await readyCoordinator();
    const part = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "part" });
    if (part.kind !== "claimed") throw new Error("expected part claim");
    await coordinator.recordPart({ partNumber: 1, claimId: part.claim.id, claimGeneration: part.claim.generation, etag: "etag", byteLength: 8, nowMs: 0 });
    const completion = await coordinator.beginCompletion({ nowMs: 0, leaseMs: 10, createId: () => "complete" });
    if (completion.kind !== "claimed") throw new Error("expected completion claim");
    await coordinator.markProbing({ claimId: completion.claim.id, claimGeneration: completion.claim.generation, nowMs: 0 });

    const cancellation = await coordinator.claimCancellation({
      nowMs: 1,
      leaseMs: 10,
      createId: () => "cancel",
      target: { objectState: "multipart", multipartUploadId: "multipart-1", reason: "stale-part-retry" },
    });
    expect(cancellation.kind).toBe("claimed");
    if (cancellation.kind !== "claimed") throw new Error("expected cancellation claim");
    expect(cancellation.record.cleanupTarget).toMatchObject({ objectState: "completed", multipartUploadId: "multipart-1" });
  });

  it("fences a slow expired completion failure so it cannot overwrite a newer probing state", async () => {
    const coordinator = await readyCoordinator();
    const part = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "part" });
    if (part.kind !== "claimed") throw new Error("expected part claim");
    await coordinator.recordPart({ partNumber: 1, claimId: part.claim.id, claimGeneration: part.claim.generation, etag: "etag", byteLength: 8, nowMs: 0 });
    const first = await coordinator.beginCompletion({ nowMs: 0, leaseMs: 10, createId: () => "complete-1" });
    const replacement = await coordinator.beginCompletion({ nowMs: 11, leaseMs: 10, createId: () => "complete-2" });
    if (first.kind !== "claimed" || replacement.kind !== "claimed") throw new Error("expected completion claims");
    await coordinator.markProbing({ claimId: replacement.claim.id, claimGeneration: replacement.claim.generation, nowMs: 11 });

    await coordinator.markRetryableFailure({
      note: "late-complete-error",
      nowMs: 11,
      claimId: first.claim.id,
      claimGeneration: first.claim.generation,
    });
    expect((await coordinator.get(11))?.state).toBe("probing");
  });

  it("serializes probe work with a fenced lease and permits a bounded retry after expiry", async () => {
    const coordinator = await readyCoordinator();
    const part = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "part" });
    if (part.kind !== "claimed") throw new Error("expected part claim");
    await coordinator.recordPart({ partNumber: 1, claimId: part.claim.id, claimGeneration: part.claim.generation, etag: "etag", byteLength: 8, nowMs: 0 });
    const completion = await coordinator.beginCompletion({ nowMs: 0, leaseMs: 10, createId: () => "complete" });
    if (completion.kind !== "claimed") throw new Error("expected completion claim");
    await coordinator.markProbing({ claimId: completion.claim.id, claimGeneration: completion.claim.generation, nowMs: 0 });

    const first = await coordinator.claimProbe({ nowMs: 0, leaseMs: 10, createId: () => "probe-1" });
    expect(first.kind).toBe("claimed");
    expect((await coordinator.claimProbe({ nowMs: 1, leaseMs: 10, createId: () => "probe-2" })).kind).toBe("status");
    expect((await coordinator.claimProbe({ nowMs: 11, leaseMs: 10, createId: () => "probe-3" })).kind).toBe("claimed");
  });

  it("releases an expired workflow-start lease for deterministic status reconciliation instead of stranding", async () => {
    const coordinator = await readyCoordinator();
    const part = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "part" });
    if (part.kind !== "claimed") throw new Error("expected part claim");
    await coordinator.recordPart({ partNumber: 1, claimId: part.claim.id, claimGeneration: part.claim.generation, etag: "etag", byteLength: 8, nowMs: 0 });
    const completion = await coordinator.beginCompletion({ nowMs: 0, leaseMs: 10, createId: () => "complete" });
    if (completion.kind !== "claimed") throw new Error("expected completion claim");
    await coordinator.markProbing({ claimId: completion.claim.id, claimGeneration: completion.claim.generation, nowMs: 0 });
    const probe = await coordinator.claimProbe({ nowMs: 0, leaseMs: 10, createId: () => "probe" });
    if (probe.kind !== "claimed") throw new Error("expected probe claim");
    await coordinator.markReady({ claimId: probe.claim.id, claimGeneration: probe.claim.generation, nowMs: 0 });
    const first = await coordinator.claimWorkflowStart({ nowMs: 0, leaseMs: 10, createId: () => "workflow-1" });
    expect(first.kind).toBe("claimed");
    const replacement = await coordinator.claimWorkflowStart({ nowMs: 11, leaseMs: 10, createId: () => "workflow-2" });
    expect(replacement.kind).toBe("claimed");
    if (first.kind !== "claimed" || replacement.kind !== "claimed") throw new Error("expected workflow claims");
    expect(replacement.claim.generation).toBeGreaterThan(first.claim.generation);
  });

  it("keeps queued private media on the expiry cleanup schedule until R2 deletion is acknowledged", async () => {
    const coordinator = await readyCoordinator();
    const part = await coordinator.claimPart({ partNumber: 1, nowMs: 0, leaseMs: 10, createId: () => "part" });
    if (part.kind !== "claimed") throw new Error("expected part claim");
    await coordinator.recordPart({ partNumber: 1, claimId: part.claim.id, claimGeneration: part.claim.generation, etag: "etag", byteLength: 8, nowMs: 0 });
    const completion = await coordinator.beginCompletion({ nowMs: 0, leaseMs: 10, createId: () => "complete" });
    if (completion.kind !== "claimed") throw new Error("expected completion claim");
    await coordinator.markProbing({ claimId: completion.claim.id, claimGeneration: completion.claim.generation, nowMs: 0 });
    const probe = await coordinator.claimProbe({ nowMs: 0, leaseMs: 10, createId: () => "probe" });
    if (probe.kind !== "claimed") throw new Error("expected probe claim");
    await coordinator.markReady({ claimId: probe.claim.id, claimGeneration: probe.claim.generation, nowMs: 0 });
    const workflow = await coordinator.claimWorkflowStart({ nowMs: 0, leaseMs: 10, createId: () => "workflow" });
    if (workflow.kind !== "claimed") throw new Error("expected workflow claim");
    await coordinator.markQueued({ claimId: workflow.claim.id, claimGeneration: workflow.claim.generation, nowMs: 0 });

    const expired = await coordinator.get(10_001);
    expect(expired).toMatchObject({
      state: "cleanup-pending",
      cleanupTarget: { objectState: "completed", multipartUploadId: "multipart-1", reason: "lease-expired" },
    });
  });

  it("uses the Durable Object expiry alarm to abort an abandoned multipart upload and acknowledge quota release", async () => {
    const values = new Map<string, unknown>();
    const alarms: number[] = [];
    let aborts = 0;
    const state = {
      storage: {
        get: async <Value>(key: string): Promise<Value | undefined> => values.get(key) as Value | undefined,
        put: async (key: string, value: unknown): Promise<void> => { values.set(key, value); },
        setAlarm: async (at: number): Promise<void> => { alarms.push(at); },
      },
    };
    const coordinator = new UploadCoordinator(state, {
      PROCESSING_BUCKET: {
        resumeMultipartUpload: () => ({ abort: async () => { aborts += 1; } }),
        delete: async () => undefined,
      },
      QUOTA_LEDGER: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({ released: true }) }),
      },
    });
    const expiredAt = Date.now() - 1;
    const created = await coordinator.fetch(new Request("https://coordinator.test", {
      method: "POST",
      body: JSON.stringify({ type: "begin", nowMs: expiredAt - 1, input: { ...operation, nowMs: expiredAt - 1, expiresAtMs: expiredAt, receiptExpiresAtMs: expiredAt } }),
    }));
    expect(created.status).toBe(200);
    await coordinator.fetch(new Request("https://coordinator.test", {
      method: "POST",
      body: JSON.stringify({ type: "attach-multipart", nowMs: expiredAt - 1, uploadId: "multipart-alarm" }),
    }));

    await coordinator.alarm();
    const reconciled = await coordinator.fetch(new Request("https://coordinator.test", {
      method: "POST",
      body: JSON.stringify({ type: "get", nowMs: Date.now() }),
    }));

    expect(aborts).toBe(1);
    expect((await reconciled.json() as { state: string }).state).toBe("cancelled");
    expect(alarms.length).toBeGreaterThan(0);
  });

  it("upgrades an in-flight v2 record under the original storage key instead of dropping it on deploy", async () => {
    const values = new Map<string, unknown>();
    values.set("cuebench-upload-coordinator-v2", {
      ...operation,
      state: "pending",
      multipartUploadId: "legacy-multipart",
      parts: {},
      claims: {},
      reconciliationNote: null,
    });
    const coordinator = new UploadCoordinator({
      storage: {
        get: async <Value>(key: string): Promise<Value | undefined> => values.get(key) as Value | undefined,
        put: async (key: string, value: unknown): Promise<void> => { values.set(key, value); },
      },
    });

    const response = await coordinator.fetch(new Request("https://coordinator.test", {
      method: "POST",
      body: JSON.stringify({ type: "get", nowMs: 1 }),
    }));
    const record = await response.json() as { readonly state: string; readonly multipartUploadId: string; readonly partGenerations: unknown };

    expect(record).toMatchObject({ state: "pending", multipartUploadId: "legacy-multipart", partGenerations: {} });
  });
});
