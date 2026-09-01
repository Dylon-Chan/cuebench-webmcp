/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { R2Bucket } from "@cloudflare/workers-types";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
import { canonicalHash } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import {
  generationWorkflowInstanceId,
  issueGenerationRunReceipt,
  R2GenerationRunRecordStore,
  verifyGenerationRunReceipt,
  type GenerationRunRecord,
} from "./generation-routes";
import {
  audioDescriptionWorkflowInstanceId,
  createAudioDescriptionGenerationRoutes,
  issueAudioDescriptionGenerationRunReceipt,
  MAX_AUDIO_DESCRIPTION_WORKFLOW_ATTEMPTS,
  R2AudioDescriptionGenerationRunRecordStore,
  verifyAudioDescriptionGenerationRunReceipt,
  type AudioDescriptionGenerationRunRecord,
} from "./ad-generation-routes";
import { resolveWorkerSettings } from "./env";
import { reconcileWorkerPrivateLifecycle } from "./index";
import { lifecycleReconciliationKey } from "./lifecycle-reconciler";
import { InMemoryQuotaLedger, saltedLedgerKey } from "./quota-ledger";
import { issueAnonymousSession } from "./session";
import { issueUploadReceipt, verifyUploadReceipt } from "./uploads";
import { OpenAIProviderError, sha256Hex } from "./openai/client";
import { fixtureMediaPreparationEnabled, fixtureMediaPreparationResponse } from "./media-preparation-fixture";
import {
  generationArtifactWriteLeaseKey,
  generationCleanupMarkerKey,
  generationPreparationWriteLeaseKey,
} from "./generation-cleanup";
import { signMediaJob } from "./probe";
import {
  CaptionGenerationRunner,
  GenerationRunRecordBackedStore,
  MAX_BILLABLE_WORKFLOW_STEP_RESULT_BYTES,
  privateAudioBytes,
} from "./workflows/generation";

const session = async (): Promise<string> => {
  const currentNow = Date.now();
  return issueAnonymousSession({
    sessionId: "workerd-session",
    issuedAtMs: currentNow,
    expiresAtMs: currentNow + 60 * 60_000,
    keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } },
  });
};

/** Browser-local owner capability used by the real hosted-upload route tests. */
const workerdProjectOwnerCapability = "1".repeat(64);

const post = (path: string, body: unknown, anonymousSession: string): Request => new Request(`https://cuebench.test${path}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${anonymousSession}`,
    "cf-connecting-ip": "203.0.113.10",
    "content-type": "application/json",
    "x-cuebench-project-owner": workerdProjectOwnerCapability,
  },
  body: JSON.stringify(body),
});

describe("workerd hosted upload boundary", () => {
  it("uses a fresh upload operation for every post-cleanup run and dispatches each to its own actual Workflow instance", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-generation-session-${currentNow}`;
    const projectId = "workerd-generation-project";
    const anonymousSession = await issueAnonymousSession({
      sessionId,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60 * 60_000,
      keyRing: settings.keyRing,
    });
    const [sessionKey, ipKey, projectKey, ownerKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
    ]);
    const source = new TextEncoder().encode("hello");
    const sourceSha256 = await sha256Hex(source);
    const upload = async (label: string): Promise<{ readonly operationKey: string; readonly objectKey: string; readonly receipt: string }> => {
      const operationId = `workerd-generation-operation-${label}-${currentNow}`;
      const [operationKey, reservationKey] = await Promise.all([
        saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
        saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
      ]);
      const objectKey = `processing/${sessionKey}/${operationKey}`;
      await env.PROCESSING_BUCKET.put(objectKey, source, { httpMetadata: { contentType: "video/webm" } });
      const receipt = await issueUploadReceipt({
        sessionId,
        sessionKey,
        ownerKey,
        ipKey,
        operationId,
        operationKey,
        projectKey,
        reservationKey,
        metadataHash: "f".repeat(64),
        objectKey,
        media: { byteLength: source.byteLength, durationMs: 31_000, contentType: "video/webm" },
        partSize: source.byteLength,
        partCount: 1,
        issuedAtMs: currentNow,
        receiptExpiresAtMs: currentNow + 60 * 60_000,
        settings,
      });
      return { operationKey, objectKey, receipt };
    };
    const startRequest = (uploadReceipt: string, runId: string) => SELF.fetch(new Request("https://cuebench.test/api/generation-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${anonymousSession}`,
          "cf-connecting-ip": "203.0.113.10",
          "content-type": "application/json",
          "x-cuebench-operation-receipt": uploadReceipt,
          "x-cuebench-project-owner": workerdProjectOwnerCapability,
        },
        body: JSON.stringify({
          projectId,
          runId,
          expectedProjectRevision: 2,
          expectedQualityProfileRevision: 1,
          mediaSha256: sourceSha256,
          sourceByteLength: 5,
          sourceDurationMs: 31_000,
        }),
      }));
    const start = async (uploadReceipt: string, runId: string): Promise<{ readonly receipt: string; readonly claims: Awaited<ReturnType<typeof verifyGenerationRunReceipt>> }> => {
      const response = await startRequest(uploadReceipt, runId);
      expect(response.status).toBe(201);
      const receipt = (await response.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
      return { receipt, claims: await verifyGenerationRunReceipt(receipt, settings, Date.now()) };
    };
    const workflow = env.PROCESSING_WORKFLOW as NonNullable<typeof env.PROCESSING_WORKFLOW>;
    const instanceFor = async (claims: Awaited<ReturnType<typeof verifyGenerationRunReceipt>>) => {
      const instance = await workflow.get?.(await generationWorkflowInstanceId(claims.operationKey, claims.runId));
      expect(instance).toBeDefined();
      expect((await instance!.status()).status).not.toBe("unknown");
      return instance!;
    };
    const complete = async (claims: Awaited<ReturnType<typeof verifyGenerationRunReceipt>>) => {
      const instance = await instanceFor(claims);
      await vi.waitFor(async () => expect((await instance.status()).status).toBe("complete"), { timeout: 15_000, interval: 100 });
    };
    const records = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    const firstUpload = await upload("first");
    const first = await start(firstUpload.receipt, "workerd-generation-first");
    await instanceFor(first.claims);
    // Real R2 CAS keeps the private project lease singular even when a valid
    // upload receipt is replayed with another run id. The same run id is a
    // recovery read and must not create a second Workflow instance.
    const sameRun = await startRequest(firstUpload.receipt, first.claims.runId);
    expect(sameRun.status).toBe(200);
    const competing = await startRequest(firstUpload.receipt, "workerd-generation-competing");
    expect(competing.status).toBe(409);
    expect(await competing.json()).toEqual({ error: expect.objectContaining({ code: "GENERATION_LEASE_CONFLICT" }) });
    expect(await env.PROCESSING_BUCKET.head(`processing/generation-leases/${ownerKey}/${projectKey}.json`)).not.toBeNull();

    await vi.waitFor(async () => expect((await records.load(first.claims))?.status.stage).toBe("AwaitingAdoption"), { timeout: 15_000, interval: 100 });
    const adopted = await SELF.fetch(new Request(`https://cuebench.test/api/generation-runs/${first.claims.runId}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "content-type": "application/json",
        "x-cuebench-generation-receipt": first.receipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision: 3 }),
    }));
    expect(adopted.status).toBe(200);
    const releasedLease = await env.PROCESSING_BUCKET.get(`processing/generation-leases/${ownerKey}/${projectKey}.json`);
    if (releasedLease === null) throw new Error("expected retained terminal project lease tombstone");
    // Release is a retained tombstone, never a delete that an older run can
    // accidentally erase after a new operation obtains the lease.
    expect(JSON.parse(await releasedLease.text())).toMatchObject({
      state: "released",
      operationKey: first.claims.operationKey,
      runId: first.claims.runId,
    });
    await complete(first.claims);
    // Immediate private cleanup intentionally makes the old receipt unusable
    // before dispatch. A retry starts with a fresh upload/operation instead.
    const staleAfterAdoption = await startRequest(firstUpload.receipt, "workerd-generation-stale-after-adoption");
    expect(staleAfterAdoption.status).toBe(409);
    expect(await staleAfterAdoption.json()).toEqual({ error: expect.objectContaining({ code: "UPLOAD_MEDIA_CLEANED" }) });
    const afterAdoptionUpload = await upload("after-adoption");
    const afterAdoption = await start(afterAdoptionUpload.receipt, "workerd-generation-after-adoption");
    await instanceFor(afterAdoption.claims);

    const cancelled = await SELF.fetch(new Request(`https://cuebench.test/api/generation-runs/${afterAdoption.claims.runId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-generation-receipt": afterAdoption.receipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
    expect(cancelled.status).toBe(200);
    await expect(records.load(afterAdoption.claims)).resolves.toMatchObject({ cancelled: true, status: { stage: "Cancelled" }, cleanup: { action: "cancelled" } });
    await complete(afterAdoption.claims);

    const staleAfterCancellation = await startRequest(afterAdoptionUpload.receipt, "workerd-generation-stale-after-cancellation");
    expect(staleAfterCancellation.status).toBe(409);
    const afterCancellationUpload = await upload("after-cancellation");
    const afterCancellation = await start(afterCancellationUpload.receipt, "workerd-generation-after-cancellation");
    await instanceFor(afterCancellation.claims);
    expect(afterCancellation.claims.runId).not.toBe(afterAdoption.claims.runId);
    const finalCancellation = await SELF.fetch(new Request(`https://cuebench.test/api/generation-runs/${afterCancellation.claims.runId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-generation-receipt": afterCancellation.receipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
    expect(finalCancellation.status).toBe(200);
    await expect(records.load(afterCancellation.claims)).resolves.toMatchObject({ cancelled: true, status: { stage: "Cancelled" }, cleanup: { action: "cancelled" } });
    await complete(afterCancellation.claims);
  });

  it("runs the real Workerd prepare-to-fixture-provider-to-staged-result path", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-full-generation-session-${currentNow}`;
    const operationId = `workerd-full-generation-operation-${currentNow}`;
    const projectId = "workerd-full-generation-project";
    const runId = `workerd-full-generation-run-${currentNow}`;
    const anonymousSession = await issueAnonymousSession({
      sessionId,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60 * 60_000,
      keyRing: settings.keyRing,
    });
    const [sessionKey, ipKey, operationKey, projectKey, reservationKey, ownerKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
    ]);
    const source = new TextEncoder().encode("cuebench-workerd-fixture-source");
    const sourceSha256 = await sha256Hex(source);
    const objectKey = `processing/${sessionKey}/${operationKey}`;
    await env.PROCESSING_BUCKET.put(objectKey, source, {
      httpMetadata: { contentType: "video/webm" },
    });
    const uploadReceipt = await issueUploadReceipt({
      sessionId,
      sessionKey,
      ownerKey,
      ipKey,
      operationId,
      operationKey,
      projectKey,
      reservationKey,
      metadataHash: "f".repeat(64),
      objectKey,
      media: { byteLength: source.byteLength, durationMs: 31_000, contentType: "video/webm" },
      partSize: source.byteLength,
      partCount: 1,
      issuedAtMs: currentNow,
      receiptExpiresAtMs: currentNow + 60 * 60_000,
      settings,
    });
    expect(fixtureMediaPreparationEnabled(env)).toBe(true);
    if (settings.mediaJobSigning === undefined) throw new Error("expected explicit Workerd fixture signing");
    const signedPreparation = await signMediaJob({
      action: "prepare",
      operationId,
      operationKey,
      objectKey,
      inputByteLength: source.byteLength,
      inputContentType: "video/webm",
      operationReceipt: uploadReceipt,
      receiptExpiresAtMs: currentNow + 60 * 60_000,
      idempotencyKey: `prepare:${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings.mediaJobSigning.keyRing);
    const fixtureBoundary = await fixtureMediaPreparationResponse(env, settings.mediaJobSigning, new Request("https://cuebench-media.internal/v1/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: signedPreparation }),
    }));
    const fixtureBoundaryBody = await fixtureBoundary.text();
    expect({ status: fixtureBoundary.status, body: fixtureBoundaryBody }).toEqual({
      status: 200,
      body: expect.stringContaining("manifest"),
    });
    const started = await SELF.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({
        projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: sourceSha256,
        sourceByteLength: source.byteLength,
        sourceDurationMs: 31_000,
      }),
    }));
    expect(started.status).toBe(201);
    const generationRunReceipt = (await started.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    const claims = await verifyGenerationRunReceipt(generationRunReceipt, settings, Date.now());
    const records = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    try {
      await vi.waitFor(async () => {
        const record = await records.load(claims);
        expect(record?.status.stage).toBe("AwaitingAdoption");
        expect(record?.stagedResult).toBeDefined();
      }, { timeout: 15_000, interval: 100 });
    } catch {
      throw new Error(`fixture workflow terminal state: ${JSON.stringify((await records.load(claims))?.status)}`);
    }
    const fullWorkflow = await (env.PROCESSING_WORKFLOW as NonNullable<typeof env.PROCESSING_WORKFLOW>).get?.(await generationWorkflowInstanceId(operationKey, runId));
    if (fullWorkflow === undefined) throw new Error("expected real Workerd generation Workflow instance");
    await vi.waitFor(async () => expect((await fullWorkflow.status()).status).toBe("complete"), { timeout: 15_000, interval: 100 });

    const staged = (await records.load(claims))?.stagedResult;
    expect(staged?.evidence.mediaSha256).toBe(sourceSha256);
    expect(staged?.evidence.words.map((word) => word.text)).toEqual(["CueBench", "fixture"]);
    expect(staged?.evidence.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "diarization", store: null, model: "fixture" }),
      expect.objectContaining({ role: "word-timestamps", store: null, model: "fixture" }),
      expect.objectContaining({ role: "reconciliation", store: null, model: "not-invoked", disposition: "skipped", skippedReason: "no-uncertainty" }),
    ]));
    expect(await env.PROCESSING_BUCKET.head(staged!.evidence.preparedManifest.key)).not.toBeNull();
    expect(await env.PROCESSING_BUCKET.head(staged!.evidence.normalizedAudio.key)).not.toBeNull();
    const preparedBeforeAcknowledgement = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/` });
    const derivativeKeys = preparedBeforeAcknowledgement.objects
      .map((object: { readonly key: string }) => object.key)
      .filter((key: string) => /\/(?:waveforms|thumbnails|indexes)\//.test(key));
    expect(derivativeKeys).toHaveLength(3);
    const raw = await env.PROCESSING_BUCKET.get(`prepared/${operationKey}/generation-runs/${runId}.json`);
    expect(JSON.parse(await raw!.text())).toEqual(expect.objectContaining({
      workflowStateRef: expect.any(Object),
      stagedResultRef: expect.any(Object),
    }));
    const acknowledged = await SELF.fetch(new Request(`https://cuebench.test/api/generation-runs/${runId}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "content-type": "application/json",
        "x-cuebench-generation-receipt": generationRunReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision: 3 }),
    }));
    expect(acknowledged.status).toBe(200);
    await vi.waitFor(async () => expect((await records.load(claims))?.cleanup).toMatchObject({
      state: "completed",
      action: "adopted",
    }), { timeout: 15_000, interval: 100 });
    await expect(env.PROCESSING_BUCKET.head(objectKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(staged!.evidence.preparedManifest.key)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(staged!.evidence.normalizedAudio.key)).resolves.toBeNull();
    await Promise.all(derivativeKeys.map(async (key: string) => expect(await env.PROCESSING_BUCKET.head(key)).toBeNull()));
    expect(await env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(operationKey))).not.toBeNull();
    const remainingArtifacts = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/generation-runs/${runId}/artifacts/` });
    expect(remainingArtifacts.objects).toEqual([]);
  }, 20_000);

  it("uses the real R2 terminal marker to stop a late fixture preparation before any derivative is published", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "9".repeat(64);
    const sessionKey = "8".repeat(64);
    const objectKey = `processing/${sessionKey}/${operationKey}`;
    const source = new TextEncoder().encode("late fixture source");
    const sourceSha256 = await sha256Hex(source);
    await env.PROCESSING_BUCKET.put(objectKey, source, { httpMetadata: { contentType: "video/webm" } });
    if (settings.mediaJobSigning === undefined) throw new Error("expected explicit Workerd fixture signing");
    const signedPreparation = await signMediaJob({
      action: "prepare",
      operationId: "workerd-late-fixture",
      operationKey,
      objectKey,
      inputByteLength: source.byteLength,
      inputContentType: "video/webm",
      operationReceipt: "workerd-late-fixture-receipt",
      receiptExpiresAtMs: currentNow + 60_000,
      idempotencyKey: `prepare:${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings.mediaJobSigning.keyRing);
    await env.PROCESSING_BUCKET.put(generationCleanupMarkerKey(operationKey), JSON.stringify({ action: "cancelled" }));

    const response = await fixtureMediaPreparationResponse(env, settings.mediaJobSigning, new Request("https://cuebench-media.internal/v1/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: signedPreparation }),
    }));
    expect(response.status).toBe(403);
    const outputs = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/` });
    expect(outputs.objects.map((object: { readonly key: string }) => object.key)).toEqual([generationCleanupMarkerKey(operationKey)]);
    expect(await sha256Hex(source)).toBe(sourceSha256);
    await env.PROCESSING_BUCKET.delete([objectKey, generationCleanupMarkerKey(operationKey)]);
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
      sessionKey: "c".repeat(64),
      projectKey: "d".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
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
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: true,
      workflowAttempt: 1,
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

  it("keeps a checkpointed provider request/ref when the dispatch create-return save races it", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "1".repeat(64);
    const runId = `generation-create-return-race-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-generation-create-return-race",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "2".repeat(64),
      sessionKey: "3".repeat(64),
      projectKey: "4".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: "workerd-generation-create-return-race-operation",
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
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: false,
      updatedAtMs: currentNow,
    };
    await store.save(initial);
    const stalePreCreate = await store.load(claims);
    if (stalePreCreate === null) throw new Error("expected stale pre-create snapshot");

    const providerRef = await store.writeProviderCheckpoint({
      claims,
      value: { accepted: "paid request output" },
    });
    const transcribing = { ...queued, stage: "Transcribing" as const, progress: 0 };
    // The Workflow can write this checkpoint after create() accepts, but
    // before the route regains control and saves `dispatched: true` from its
    // stale pre-create snapshot.
    await store.save({
      ...stalePreCreate,
      status: transcribing,
      workflowState: {
        request: { runId, projectId: claims.projectId },
        stageHistory: [queued, transcribing],
        cancelled: false,
        providerAttempts: [{
          attemptId: "diarization:chunk-1:attempt-1",
          pass: "diarization",
          requestKey: "chunk-1",
          state: "completed",
          startedAtMs: currentNow + 1,
          responseHash: "5".repeat(64),
        }],
        diarizationChunks: [{ requestKey: "chunk-1", artifactRef: providerRef }],
      },
      updatedAtMs: currentNow + 1,
    });
    await store.save({ ...stalePreCreate, dispatched: true, updatedAtMs: currentNow + 2 });

    const recovered = await store.load(claims);
    expect(recovered).toMatchObject({
      dispatched: true,
      status: { stage: "Transcribing" },
      workflowState: {
        providerAttempts: [expect.objectContaining({ attemptId: "diarization:chunk-1:attempt-1", state: "completed" })],
        diarizationChunks: [expect.objectContaining({ requestKey: "chunk-1", artifactRef: providerRef })],
      },
      artifactRefs: expect.arrayContaining([providerRef]),
    });
    // The post-CAS reclaim only deletes superseded snapshots. It must never
    // see a newer request ref as stale merely because the route saved late.
    expect(await env.PROCESSING_BUCKET.head(providerRef.key)).not.toBeNull();

    const privateObjects = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/generation-runs/${runId}/` });
    await env.PROCESSING_BUCKET.delete([
      `prepared/${operationKey}/generation-runs/${runId}.json`,
      ...privateObjects.objects.map((object: { readonly key: string }) => object.key),
    ]);
  });

  it("reconciles a terminal lease release after the record PUT succeeds but its first lease CAS fails", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "e".repeat(64);
    const projectKey = "f".repeat(64);
    const sessionKey = "a".repeat(64);
    const runId = `generation-terminal-release-repair-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-terminal-release-repair",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "b".repeat(64),
      sessionKey,
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: "workerd-terminal-release-repair-operation",
      operationKey,
      objectKey: `processing/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    const leaseKey = `processing/generation-leases/${sessionKey}/${projectKey}.json`;
    let failedLeaseWrites = 0;
    const target = env.PROCESSING_BUCKET;
    const flakyBucket = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "put") {
          return async (key: string, value: unknown, options: unknown) => {
            if (key === leaseKey && failedLeaseWrites > 0) {
              failedLeaseWrites -= 1;
              throw new Error("injected terminal lease CAS failure");
            }
            return (source.put as unknown as (nextKey: string, nextValue: unknown, nextOptions: unknown) => Promise<unknown>)(key, value, options);
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as unknown as R2Bucket;
    const store = new R2GenerationRunRecordStore(flakyBucket);
    const queued = {
      contractVersion: 1 as const,
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: 2,
      stage: "Queued" as const,
    };
    const initial: GenerationRunRecord = {
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: true,
      workflowAttempt: 1,
      updatedAtMs: currentNow,
    };
    await store.acquireActiveLease({
      sessionKey,
      projectKey,
      operationKey,
      runId,
      targetTrack: "Captions",
      expiresAtMs: currentNow + 60_000,
      nowMs: currentNow,
    });
    await store.save(initial);

    // R2 commits the terminal record before the independent lease tombstone.
    // A transport fault on that first CAS must leave a durable repair marker.
    failedLeaseWrites = 1;
    await expect(store.save({
      ...initial,
      cancelled: true,
      status: { ...queued, stage: "Cancelled" },
      updatedAtMs: currentNow + 1,
    })).rejects.toThrow("injected terminal lease CAS failure");
    const raw = await target.get(`prepared/${operationKey}/generation-runs/${runId}.json`);
    if (raw === null) throw new Error("expected terminal R2 recovery record");
    expect(JSON.parse(await raw.text())).toEqual(expect.objectContaining({
      status: expect.objectContaining({ stage: "Cancelled" }),
      leaseReleasePending: true,
    }));
    const activeLease = await target.get(leaseKey);
    if (activeLease === null) throw new Error("expected active project lease after injected failure");
    expect(JSON.parse(await activeLease.text())).toMatchObject({ state: "active", runId });

    // A terminal read is a non-throwing repair point. Keep failures injected
    // for this first read, then let the authenticated cleanup retry settle it.
    failedLeaseWrites = 1;
    await expect(store.load(claims)).resolves.toMatchObject({ status: { stage: "Cancelled" }, leaseReleasePending: true });
    const cleaned = await store.cleanup({ claims, action: "cancelled", nowMs: currentNow + 2 });
    expect(cleaned?.cleanup).toMatchObject({ state: "completed", action: "cancelled" });
    const released = await target.get(leaseKey);
    if (released === null) throw new Error("expected retained released lease tombstone");
    expect(JSON.parse(await released.text())).toMatchObject({ state: "released", runId });

    await target.delete([
      `prepared/${operationKey}/generation-runs/${runId}.json`,
      `prepared/${operationKey}/generation-cleanup.json`,
      leaseKey,
    ]);
  });

  it("stores a legal >1 MiB provider response in R2 and returns only a bounded checkpoint ref from each Workflow step", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "c".repeat(64);
    const runId = `generation-large-provider-step-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-large-provider-step-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "d".repeat(64),
      sessionKey: "e".repeat(64),
      projectKey: "f".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: "workerd-large-provider-step-operation",
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
      expectedProjectRevision: 2,
      stage: "Queued" as const,
    };
    const records = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    await records.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: true,
      updatedAtMs: currentNow,
    });

    // The provider payload is legal at this boundary but well beyond the
    // 1 MiB Workflow step-result cap. Canonical project evidence keeps only
    // a bounded 1,000-character source excerpt per diarization segment.
    const segmentText = "x".repeat(1_100_000);
    const diarization = {
      speakerSegments: [
        ...Array.from({ length: 500 }, (_unused, index) => ({
        id: `large-speaker-${index + 1}`,
        startMs: index * 60,
        endMs: index * 60 + 50,
        speaker: "A",
          text: "word",
        })),
        // This is a legal diarization-only excerpt inside the authoritative
        // duration. It has no word-pass overlap, so it exercises response
        // retention rather than manufacturing a reconciliation disagreement.
        { id: "large-unassigned-speaker", startMs: 30_100, endMs: 30_900, speaker: "A", text: segmentText },
      ],
      provenance: { model: "fixture", requestHash: "1".repeat(64), responseHash: "2".repeat(64) },
    };
    expect(new TextEncoder().encode(JSON.stringify(diarization)).byteLength).toBeGreaterThan(1024 * 1024);
    const words = Array.from({ length: 500 }, (_unused, index) => ({
      startMs: index * 60,
      endMs: index * 60 + 50,
      text: "word",
    }));
    const returnedStepResults: unknown[] = [];
    const checkpointSizes: number[] = [];
    const cached = new Map<string, unknown>();
    const runner = new CaptionGenerationRunner(
      new GenerationRunRecordBackedStore(records, claims),
      {
        preparation: { prepare: async () => ({ key: `prepared/${operationKey}/manifests/${"a".repeat(64)}.json`, sha256: "a".repeat(64) }) },
        artifacts: {
          readManifest: async () => ({
            source: { sha256: claims.mediaSha256, byteLength: claims.sourceByteLength, durationMs: claims.sourceDurationMs },
            normalizedAudio: {
              key: `prepared/${operationKey}/audio/${"b".repeat(64)}.wav`,
              sha256: "b".repeat(64),
              byteLength: 128,
              durationMs: claims.sourceDurationMs,
              contentType: "audio/wav",
            },
          }),
        },
        transcription: {
          diarize: async () => diarization,
          wordTimestamps: async () => ({ words, provenance: { model: "fixture", requestHash: "3".repeat(64), responseHash: "4".repeat(64) } }),
          // This test intentionally enters the request-level production
          // shape: each rich result must be persisted under its own R2 ref
          // before the Workflow step returns its <=64 KiB value.
          resumable: {
            requests: async () => [{ requestKey: "chunk-1", index: 0, offsetMs: 0, endMs: claims.sourceDurationMs, overlapWithPreviousMs: 0 }],
            diarizeRequest: async () => diarization,
            wordTimestampRequest: async () => ({ words, provenance: { model: "fixture", requestHash: "3".repeat(64), responseHash: "4".repeat(64) } }),
            aggregateDiarization: async ({ results }) => results[0]!.value,
            aggregateWordTimestamps: async ({ results }) => results[0]!.value,
          },
        },
        reconciliation: {
          reconcile: async ({ alignedWords }) => ({
            words: alignedWords,
            provenance: { model: "fixture", requestHash: "5".repeat(64), responseHash: "6".repeat(64), store: false },
          }),
        },
        clock: () => currentNow,
      },
      {
        run: async (pass, requestKey, work) => {
          const cacheKey = `${pass}:${requestKey}`;
          const cachedResult = cached.get(cacheKey);
          const result = cachedResult === undefined ? await work() : cachedResult;
          cached.set(cacheKey, result);
          returnedStepResults.push(result);
          const stepResult = result as { readonly checkpoint?: { readonly key: string } };
          if (stepResult.checkpoint !== undefined) {
            const persistedCheckpoint = await env.PROCESSING_BUCKET.head(stepResult.checkpoint.key);
            if (persistedCheckpoint === null) throw new Error("expected provider step checkpoint in R2 before Workflow step completion");
            checkpointSizes.push(persistedCheckpoint.size);
          }
          return result as Awaited<ReturnType<typeof work>>;
        },
      },
    );
    await runner.run({
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: claims.mediaSha256,
      sourceByteLength: claims.sourceByteLength,
      sourceDurationMs: claims.sourceDurationMs,
      operation: {
        operationId: claims.operationId,
        operationKey,
        objectKey: claims.objectKey,
        inputByteLength: claims.sourceByteLength,
        inputContentType: "video/webm",
        operationReceipt: "private-upload-receipt",
        receiptExpiresAtMs: claims.expiresAtMs,
      },
    });

    expect(returnedStepResults).toHaveLength(3);
    for (const result of returnedStepResults) {
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(MAX_BILLABLE_WORKFLOW_STEP_RESULT_BYTES);
      expect(result).toEqual(expect.objectContaining({ checkpoint: expect.objectContaining({ key: expect.stringContaining(`/generation-runs/${runId}/artifacts/`) }) }));
    }
    expect(returnedStepResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkpoint: expect.objectContaining({ key: expect.stringContaining("provider-result-") }) }),
    ]));
    expect(checkpointSizes.some((size) => size > 1024 * 1024)).toBe(true);
    const persisted = await records.load(claims);
    expect(persisted?.status.stage).toBe("AwaitingAdoption");
    expect(persisted?.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringContaining("workflow-state-"), byteLength: expect.any(Number) }),
    ]));
    // Once the request aggregate is durable, only its compact current state
    // remains. Older rich request artifacts are reclaimed after the record
    // CAS and would still be found by exact-prefix cleanup if a delete lost
    // its response.
    expect((persisted?.artifactRefs ?? []).some((reference) => reference.byteLength > 1024 * 1024)).toBe(false);
    const privateObjects = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/` });
    await env.PROCESSING_BUCKET.delete(privateObjects.objects.map((object: { readonly key: string }) => object.key));
  });

  it("resumes real R2 request checkpoints after later chunk/window 503s without replaying accepted earlier requests", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "7".repeat(64);
    const runId = `generation-request-resume-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-request-resume-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "8".repeat(64),
      sessionKey: "9".repeat(64),
      projectKey: "a".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 4_000,
      operationId: "workerd-request-resume-operation",
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
      expectedProjectRevision: 2,
      stage: "Queued" as const,
    };
    const records = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    await records.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: true,
      updatedAtMs: currentNow,
    });

    const chunks = [
      { requestKey: "chunk-1", index: 0, offsetMs: 0, endMs: 2_000, overlapWithPreviousMs: 0 },
      { requestKey: "chunk-2", index: 1, offsetMs: 1_900, endMs: 4_000, overlapWithPreviousMs: 100 },
    ] as const;
    const calls: string[] = [];
    let chunkTwoFailures = 0;
    let windowTwoFailures = 0;
    const workflowCache = new Map<string, unknown>();
    const runner = new CaptionGenerationRunner(
      new GenerationRunRecordBackedStore(records, claims),
      {
        preparation: { prepare: async () => ({ key: `prepared/${operationKey}/manifests/${"b".repeat(64)}.json`, sha256: "b".repeat(64) }) },
        artifacts: {
          readManifest: async () => ({
            source: { sha256: claims.mediaSha256, byteLength: claims.sourceByteLength, durationMs: claims.sourceDurationMs },
            normalizedAudio: {
              key: `prepared/${operationKey}/audio/${"c".repeat(64)}.wav`,
              sha256: "c".repeat(64),
              byteLength: 128,
              durationMs: claims.sourceDurationMs,
              contentType: "audio/wav",
            },
          }),
        },
        transcription: {
          diarize: async () => { throw new Error("legacy transcription must not run"); },
          wordTimestamps: async () => { throw new Error("legacy transcription must not run"); },
          resumable: {
            requests: async () => chunks,
            diarizeRequest: async ({ request: chunk }) => {
              calls.push(`diarization:${chunk.requestKey}`);
              if (chunk.requestKey === "chunk-2" && chunkTwoFailures++ === 0) {
                throw new OpenAIProviderError("known diarization 429 before acceptance", true, "safe-to-replay");
              }
              return {
                speakerSegments: [{
                  id: `speaker-${chunk.index + 1}`,
                  startMs: chunk.offsetMs,
                  endMs: Math.min(chunk.endMs, chunk.offsetMs + 600),
                  speaker: "A",
                  text: `word-${chunk.index + 1}`,
                }],
                provenance: { model: "fixture-diarization", requestHash: (chunk.index === 0 ? "d" : "e").repeat(64), responseHash: (chunk.index === 0 ? "f" : "0").repeat(64) },
              };
            },
            wordTimestampRequest: async ({ request: chunk }) => {
              calls.push(`words:${chunk.requestKey}`);
              return {
                words: [{ startMs: chunk.offsetMs, endMs: Math.min(chunk.endMs, chunk.offsetMs + 500), text: `word-${chunk.index + 1}` }],
                provenance: { model: "fixture-words", requestHash: (chunk.index === 0 ? "1" : "2").repeat(64), responseHash: (chunk.index === 0 ? "3" : "4").repeat(64) },
              };
            },
            aggregateDiarization: async ({ results }) => ({
              speakerSegments: results.flatMap((result) => result.value.speakerSegments),
              provenance: { model: "fixture-diarization", requestHash: "5".repeat(64), responseHash: "6".repeat(64) },
            }),
            aggregateWordTimestamps: async ({ results }) => ({
              words: results.flatMap((result) => result.value.words),
              provenance: { model: "fixture-words", requestHash: "7".repeat(64), responseHash: "8".repeat(64) },
            }),
          },
        },
        reconciliation: {
          reconcile: async () => { throw new Error("legacy reconciliation must not run"); },
          resumable: {
            requests: async ({ alignedWords }) => alignedWords.map((word, index) => ({
              requestKey: `window-${index + 1}`,
              window: {
                windowId: `window-${index + 1}`,
                allowedWordIds: [word.evidenceId],
                words: [{
                  id: word.evidenceId,
                  startMs: word.startMs,
                  endMs: word.endMs,
                  text: word.text,
                  normalizedText: word.text.toLowerCase(),
                  speaker: word.speaker ?? "Unknown",
                  diarizationSegmentIds: word.speakerSegmentIds,
                }],
              },
            })),
            reconcileRequest: async ({ request: window }) => {
              calls.push(`reconciliation:${window.requestKey}`);
              if (window.requestKey === "window-2" && windowTwoFailures++ === 0) {
                throw new OpenAIProviderError("known reconciliation 429 before acceptance", true, "safe-to-replay");
              }
              const seed = window.requestKey === "window-1" ? "9" : "a";
              return {
                requestKey: window.requestKey,
                windowId: window.window.windowId,
                replacements: [],
                provenance: {
                  provider: "fixture",
                  model: "fixture-reconciliation",
                  requestHash: seed.repeat(64),
                  responseHash: (seed === "9" ? "b" : "c").repeat(64),
                  rawResponseSha256: (seed === "9" ? "b" : "c").repeat(64),
                  store: false,
                  background: false,
                  usage: null,
                  providerResponseId: null,
                },
              };
            },
            aggregate: async ({ alignedWords, results }) => ({
              words: alignedWords,
              provenance: {
                model: "fixture-reconciliation",
                requestHash: "d".repeat(64),
                responseHash: "e".repeat(64),
                store: false,
                requestMetadata: { windowCount: String(results.length) },
              },
            }),
          },
        },
        clock: () => currentNow,
      },
      {
        run: async (pass, requestKey, work) => {
          const key = `${pass}:${requestKey}`;
          const cached = workflowCache.get(key);
          if (cached !== undefined) return cached as Awaited<ReturnType<typeof work>>;
          const result = await work();
          workflowCache.set(key, result);
          return result;
        },
      },
    );
    const request = {
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: claims.mediaSha256,
      sourceByteLength: claims.sourceByteLength,
      sourceDurationMs: claims.sourceDurationMs,
      operation: {
        operationId: claims.operationId,
        operationKey,
        objectKey: claims.objectKey,
        inputByteLength: claims.sourceByteLength,
        inputContentType: "video/webm" as const,
        operationReceipt: "private-upload-receipt",
        receiptExpiresAtMs: claims.expiresAtMs,
      },
    };

    await expect(runner.run(request)).rejects.toMatchObject({ retryable: true });
    expect(calls).toEqual(["diarization:chunk-1", "diarization:chunk-2"]);
    const afterChunkFailure = await records.load(claims);
    expect(afterChunkFailure?.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringContaining("provider-result-") }),
    ]));

    await expect(runner.run(request)).rejects.toMatchObject({ retryable: true });
    expect(calls).toEqual([
      "diarization:chunk-1", "diarization:chunk-2", "diarization:chunk-2",
      "words:chunk-1", "words:chunk-2",
      "reconciliation:window-1", "reconciliation:window-2",
    ]);

    await runner.run(request);
    expect(calls).toEqual([
      "diarization:chunk-1", "diarization:chunk-2", "diarization:chunk-2",
      "words:chunk-1", "words:chunk-2",
      "reconciliation:window-1", "reconciliation:window-2", "reconciliation:window-2",
    ]);
    const completed = await records.load(claims);
    expect(completed).toMatchObject({ status: { stage: "AwaitingAdoption" } });
    expect((completed?.artifactRefs ?? []).some((reference) => reference.key.includes("provider-result-"))).toBe(false);
    const privateObjects = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/` });
    await env.PROCESSING_BUCKET.delete(privateObjects.objects.map((object: { readonly key: string }) => object.key));
  });

  it("reclaims a workflow artifact when terminal cleanup wins immediately after its R2 PUT", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "1".repeat(64);
    const projectKey = "2".repeat(64);
    const runId = `generation-artifact-fence-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-artifact-fence-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "3".repeat(64),
      sessionKey: "4".repeat(64),
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: "workerd-artifact-fence-operation",
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
      expectedProjectRevision: 2,
      stage: "Queued" as const,
    };
    const workflowState = { request: { runId, projectId: claims.projectId }, stageHistory: [queued], cancelled: false };
    const checkpointDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(workflowState)));
    const checkpointKey = `prepared/${operationKey}/generation-runs/${runId}/artifacts/workflow-state-${checkpointDigest}.json`;
    const marker = generationCleanupMarkerKey(operationKey);
    let markerInstalled = false;
    const target = env.PROCESSING_BUCKET;
    const racingBucket = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "put") {
          return async (key: string, value: unknown, options: unknown) => {
            const result = await (source.put as unknown as (nextKey: string, nextValue: unknown, nextOptions: unknown) => Promise<unknown>)(key, value, options);
            if (key === checkpointKey && !markerInstalled) {
              markerInstalled = true;
              await source.put(marker, JSON.stringify({ version: 1, action: "cancelled" }));
            }
            return result;
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as unknown as R2Bucket;
    const store = new R2GenerationRunRecordStore(racingBucket);
    await expect(store.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: queued,
      cancelled: false,
      dispatched: true,
      workflowState,
      updatedAtMs: currentNow,
    })).rejects.toThrow("terminal cleanup reclaimed");
    expect(markerInstalled).toBe(true);
    await expect(target.head(checkpointKey)).resolves.toBeNull();
    await expect(target.head(generationArtifactWriteLeaseKey(operationKey, runId, checkpointKey))).resolves.toBeNull();
    await expect(target.head(`prepared/${operationKey}/generation-runs/${runId}.json`)).resolves.toBeNull();
    await target.delete(marker);
  });

  it("keeps AD cleanup pending across a real-R2 artifact PUT that pauses after HEAD, then reclaims the crashed writer", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "5".repeat(64);
    const projectKey = "6".repeat(64);
    const ownerKey = "7".repeat(64);
    const runId = `ad-artifact-fence-${currentNow}`;
    const projectId = "workerd-ad-artifact-fence-project";
    const projection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "8".repeat(64),
      localEvidencePackageIds: ["caption-package-1"],
      captions: [{
        itemId: "caption-1",
        itemRevision: 1,
        state: "Sustained" as const,
        startMs: 1_000,
        endMs: 3_000,
        text: "The lecturer names the diagram.",
        evidenceIds: [],
      }],
      evidence: [],
    };
    const captionEvidenceHash = canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length);
    const receipt = await issueAudioDescriptionGenerationRunReceipt({
      runId,
      projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: projection.mediaSha256,
      captionEvidenceHash,
      sessionKey: "9".repeat(64),
      ownerKey,
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: `ad-artifact-fence-operation-${currentNow}`,
      operationKey,
      objectKey: `processing/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow);
    const targetStore = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    await targetStore.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "opaque-private-upload-receipt",
      captionEvidenceProjection: projection,
      status: {
        contractVersion: 1,
        runId,
        projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        stage: "Queued",
      },
      cancelled: false,
      dispatched: true,
      windowCheckpoints: {},
      artifactRefs: [],
      privateObjectKeys: [claims.objectKey],
      workflowAttempt: 1,
      updatedAtMs: currentNow,
    });
    const claim = await targetStore.claimWindowProviderCall({ claims, windowId: "ad-window-fence", nowMs: currentNow });
    if (claim.kind !== "claimed") throw new Error("expected a durable AD artifact writer claim");

    let artifactKey: string | undefined;
    let reachedPut!: () => void;
    const putReached = new Promise<void>((resolve) => { reachedPut = resolve; });
    let resumePut!: () => void;
    const putResume = new Promise<void>((resolve) => { resumePut = resolve; });
    const target = env.PROCESSING_BUCKET;
    const racingBucket = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "put") {
          return async (key: string, value: unknown, options: unknown) => {
            if (key.startsWith(`prepared/${operationKey}/audio-description-runs/${runId}/artifacts/window-`)) {
              artifactKey = key;
              // The store has already acquired its durable writer lease and
              // performed its pre-PUT HEAD. Hold exactly at the R2 PUT so a
              // terminal cleanup can inventory the lease before the writer
              // resumes and crashes before its record CAS.
              reachedPut();
              await putResume;
            }
            return (source.put as unknown as (nextKey: string, nextValue: unknown, nextOptions: unknown) => Promise<unknown>)(key, value, options);
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as unknown as R2Bucket;
    const racingStore = new R2AudioDescriptionGenerationRunRecordStore(racingBucket);
    const write = racingStore.completeWindow({
      claims,
      windowId: "ad-window-fence",
      attemptId: claim.attemptId,
      value: { version: 1, provider: { value: { proposals: [] } }, startedAtMs: currentNow, completedAtMs: currentNow + 1 },
      nowMs: currentNow + 1,
    });
    await putReached;

    await targetStore.terminal({ claims, action: "cancelled", nowMs: currentNow + 2 });
    const pending = await targetStore.cleanup({ claims, action: "cancelled", nowMs: currentNow + 2 });
    expect(pending?.cleanup).toMatchObject({ state: "pending", action: "cancelled" });
    expect(await target.head(generationCleanupMarkerKey(operationKey))).not.toBeNull();
    expect(artifactKey).toBeDefined();
    if (artifactKey === undefined) throw new Error("expected the paused AD artifact key");
    expect(await target.head(generationArtifactWriteLeaseKey(operationKey, runId, artifactKey))).not.toBeNull();

    resumePut();
    await expect(write).rejects.toThrow("terminal cleanup reclaimed");
    expect(await target.head(artifactKey)).toBeNull();
    expect(await target.head(generationArtifactWriteLeaseKey(operationKey, runId, artifactKey))).toBeNull();
    // The resumed writer must not CAS a completed checkpoint after cleanup
    // has fenced the operation. A retry performs a final exact inventory and
    // only then publishes the redacted terminal tombstone.
    expect((await targetStore.load(claims))?.windowCheckpoints["ad-window-fence"]?.checkpoint).toBeUndefined();
    await expect(targetStore.cleanup({ claims, action: "cancelled", nowMs: currentNow + 3 })).resolves.toMatchObject({
      cleanup: { state: "completed", action: "cancelled" },
      contentRedacted: true,
    });
    expect((await target.list({ prefix: `prepared/${operationKey}/audio-description-runs/${runId}/artifacts/` })).objects).toEqual([]);
  });

  it("terminally exhausts a second safe AD retry before exact cleanup releases its shared lease", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-ad-failed-owner-session-${currentNow}`;
    const projectId = "workerd-ad-failed-owner-project";
    const operationIdA = `workerd-ad-failed-owner-operation-a-${currentNow}`;
    const operationIdB = `workerd-ad-failed-owner-operation-b-${currentNow}`;
    const runIdA = `workerd-ad-failed-owner-run-a-${currentNow}`;
    const runIdB = `workerd-ad-failed-owner-run-b-${currentNow}`;
    const anonymousSession = await issueAnonymousSession({
      sessionId,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60 * 60_000,
      keyRing: settings.keyRing,
    });
    const [sessionKey, ipKey, ownerKey, projectKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
    ]);
    const source = new TextEncoder().encode("cuebench-workerd-failed-ad-source");
    const sourceSha256 = await sha256Hex(source);
    const upload = async (operationId: string) => {
      const [operationKey, reservationKey] = await Promise.all([
        saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
        saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
      ]);
      const objectKey = `processing/${sessionKey}/${operationKey}`;
      await env.PROCESSING_BUCKET.put(objectKey, source, { httpMetadata: { contentType: "video/webm" } });
      const receipt = await issueUploadReceipt({
        sessionId,
        sessionKey,
        ownerKey,
        ipKey,
        operationId,
        operationKey,
        projectKey,
        reservationKey,
        metadataHash: "a".repeat(64),
        objectKey,
        media: { byteLength: source.byteLength, durationMs: 31_000, contentType: "video/webm" },
        partSize: source.byteLength,
        partCount: 1,
        issuedAtMs: currentNow,
        receiptExpiresAtMs: currentNow + 60 * 60_000,
        settings,
      });
      return { operationKey, objectKey, receipt };
    };
    const uploadA = await upload(operationIdA);
    const projection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: sourceSha256,
      localEvidencePackageIds: ["caption-package-1"],
      captions: [{
        itemId: "caption-1",
        itemRevision: 1,
        state: "Sustained" as const,
        startMs: 1_000,
        endMs: 3_000,
        text: "The lecturer names the diagram.",
        evidenceIds: [],
      }],
      evidence: [],
    };
    const captionEvidenceHash = canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length);
    const receiptA = await issueAudioDescriptionGenerationRunReceipt({
      runId: runIdA,
      projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: sourceSha256,
      captionEvidenceHash,
      sessionKey,
      ownerKey,
      projectKey,
      sourceByteLength: source.byteLength,
      sourceDurationMs: 31_000,
      operationId: operationIdA,
      operationKey: uploadA.operationKey,
      objectKey: uploadA.objectKey,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claimsA = await verifyAudioDescriptionGenerationRunReceipt(receiptA, settings, currentNow);
    const records = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    const leases = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    await records.save({
      version: 1,
      receipt: receiptA,
      claims: claimsA,
      uploadReceipt: uploadA.receipt,
      captionEvidenceProjection: projection,
      status: {
        contractVersion: 1,
        runId: runIdA,
        projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "fixture known-safe second provider failure",
        // Simulate the durable state written by the second Workflow after a
        // provider failure known not to have been accepted. The authenticated
        // status route must normalize this legacy/in-flight retry marker to a
        // terminal failure before it can release the shared project lease.
        retryable: true,
      },
      cancelled: false,
      dispatched: true,
      windowCheckpoints: {
        "ad-window-safe": {
          state: "retryable-failed",
          attempt: 2,
          attemptId: "ad-window-safe-a2",
          updatedAtMs: currentNow,
        },
      },
      artifactRefs: [],
      privateObjectKeys: [uploadA.objectKey],
      workflowAttempt: MAX_AUDIO_DESCRIPTION_WORKFLOW_ATTEMPTS,
      leaseReleasePending: true,
      updatedAtMs: currentNow,
    });
    await leases.acquireActiveLease({
      sessionKey,
      ownerKey,
      projectKey,
      operationKey: uploadA.operationKey,
      runId: runIdA,
      targetTrack: "AudioDescriptions",
      expiresAtMs: currentNow + 60_000,
      nowMs: currentNow,
    });
    const statusA = await SELF.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runIdA}`, {
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-audio-description-receipt": receiptA,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
    expect(statusA.status).toBe(200);
    await expect(statusA.json()).resolves.toEqual(expect.objectContaining({
      status: expect.objectContaining({ stage: "Failed", retryable: false }),
    }));
    await vi.waitFor(async () => expect(await records.load(claimsA)).toMatchObject({
      cleanup: { state: "completed", action: "discarded" },
      contentRedacted: true,
      receipt: "redacted",
    }), { timeout: 5_000, interval: 50 });
    expect(await env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(uploadA.operationKey))).not.toBeNull();
    await expect(leases.ownsActiveLease({
      sessionKey,
      ownerKey,
      projectKey,
      operationKey: uploadA.operationKey,
      runId: runIdA,
      targetTrack: "AudioDescriptions",
      nowMs: currentNow,
    })).resolves.toBe(false);

    const requestStart = (uploadReceipt: string, runId: string) => SELF.fetch(new Request("https://cuebench.test/api/audio-description-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({
        projectId,
        runId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: sourceSha256,
        sourceByteLength: source.byteLength,
        sourceDurationMs: 31_000,
        captionEvidenceProjection: projection,
        captionEvidenceHash,
      }),
    }));
    const reused = await requestStart(uploadA.receipt, `${runIdA}-reuse`);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: expect.objectContaining({ code: "UPLOAD_MEDIA_CLEANED" }) });

    const uploadB = await upload(operationIdB);
    const fresh = await requestStart(uploadB.receipt, runIdB);
    expect(fresh.status).toBe(201);
    const receiptB = (await fresh.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    // The old receipt has been redacted and cannot re-enter a *different*
    // terminal action. More importantly, its operation namespace is distinct
    // from B's fresh source.
    const oldCancel = await SELF.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runIdA}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-audio-description-receipt": receiptA,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
    expect(oldCancel.status).toBe(409);
    expect(await env.PROCESSING_BUCKET.head(uploadB.objectKey)).not.toBeNull();
    // Avoid retaining this test's fresh private source. The deletion is
    // idempotent even if its fixture Workflow has already failed.
    await SELF.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runIdB}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-audio-description-receipt": receiptB,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
  }, 20_000);

  it("repairs a redacted terminal AD record after a transient real-R2 lease CAS failure", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-ad-redacted-lease-repair-session-${currentNow}`;
    const projectId = "workerd-ad-redacted-lease-repair-project";
    const operationId = `workerd-ad-redacted-lease-repair-operation-${currentNow}`;
    const runId = `workerd-ad-redacted-lease-repair-run-${currentNow}`;
    const [sessionKey, ownerKey, projectKey, operationKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
    ]);
    const anonymousSession = await issueAnonymousSession({
      sessionId,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
      keyRing: settings.keyRing,
    });
    const objectKey = `processing/${sessionKey}/${operationKey}`;
    const projection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "c".repeat(64),
      localEvidencePackageIds: ["caption-package-redacted-lease-repair"],
      captions: [{ itemId: "caption-redacted-lease-repair", itemRevision: 1, state: "Sustained" as const, startMs: 1_000, endMs: 2_000, text: "A bounded caption cue.", evidenceIds: [] }],
      evidence: [],
    };
    const receipt = await issueAudioDescriptionGenerationRunReceipt({
      runId,
      projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: projection.mediaSha256,
      captionEvidenceHash: canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length),
      sessionKey,
      ownerKey,
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId,
      operationKey,
      objectKey,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow);
    const records = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    const baseLeases = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    await env.PROCESSING_BUCKET.put(objectKey, "hello", { httpMetadata: { contentType: "video/webm" } });
    await records.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      captionEvidenceProjection: projection,
      status: {
        contractVersion: 1,
        runId,
        projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "static category only",
        retryable: false,
      },
      cancelled: false,
      dispatched: true,
      workflowAttempt: 1,
      windowCheckpoints: {},
      artifactRefs: [],
      privateObjectKeys: [objectKey],
      leaseReleasePending: true,
      updatedAtMs: currentNow,
    });
    await baseLeases.acquireActiveLease({
      sessionKey,
      ownerKey,
      projectKey,
      operationKey,
      runId,
      targetTrack: "AudioDescriptions",
      expiresAtMs: currentNow + 60_000,
      nowMs: currentNow,
    });
    // Model the durable point immediately after the exact R2 object cleanup
    // redacted this run but before its independent shared-lease CAS. The
    // route must keep the same signed cancellation usable for repair without
    // ever restoring bearer material to R2.
    const terminal = await records.terminal({ claims, action: "cancelled", nowMs: currentNow });
    if (terminal === null) throw new Error("Expected a durable AD terminal record.");
    const cleaned = await records.cleanup({ claims, action: "cancelled", nowMs: currentNow });
    if (cleaned === null) throw new Error("Expected a durable redacted AD cleanup record.");
    const activeLeaseKey = `processing/generation-leases/${ownerKey}/${projectKey}.json`;
    let failLeaseRelease = true;
    const flakyBucket = new Proxy(env.PROCESSING_BUCKET, {
      get(source, property, receiver) {
        if (property === "put") {
          return async (key: string, value: unknown, options: unknown) => {
            if (key === activeLeaseKey && failLeaseRelease) {
              failLeaseRelease = false;
              throw new Error("injected AD terminal lease CAS failure");
            }
            return (source.put as unknown as (nextKey: string, nextValue: unknown, nextOptions: unknown) => Promise<unknown>)(key, value, options);
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as unknown as R2Bucket;
    const repairApp = createAudioDescriptionGenerationRoutes(env, {
      clock: () => currentNow,
      quotaLedger: new InMemoryQuotaLedger(),
      runs: records,
      leases: new R2GenerationRunRecordStore(flakyBucket),
      workflow: { startAudioDescriptionGeneration: async () => undefined, cancelAudioDescriptionGeneration: async () => undefined },
    });
    const headers = {
      authorization: `Bearer ${anonymousSession}`,
      "x-cuebench-audio-description-receipt": receipt,
      "x-cuebench-project-owner": workerdProjectOwnerCapability,
    };
    const cancellation = () => repairApp.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runId}`, {
      method: "DELETE",
      headers,
    }));
    const status = () => repairApp.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runId}`, {
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-audio-description-receipt": receipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));

    const first = await cancellation();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      status: { stage: "Cancelled" },
      cleanup: { state: "pending", action: "cancelled" },
    });
    await expect(records.load(claims)).resolves.toMatchObject({
      receipt: "redacted",
      uploadReceipt: "redacted",
      contentRedacted: true,
      cleanup: { state: "completed", action: "cancelled" },
      leaseReleasePending: true,
    });
    await expect(baseLeases.ownsActiveLease({ sessionKey, ownerKey, projectKey, operationKey, runId, targetTrack: "AudioDescriptions", nowMs: currentNow })).resolves.toBe(true);

    // A reconnect GET can repair the server lease. It never restores raw
    // capability data, and the same exact DELETE remains idempotent after
    // this GET clears the repair marker.
    const reconciled = await status();
    expect(reconciled.status).toBe(200);
    await expect(reconciled.json()).resolves.toMatchObject({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed", action: "cancelled" },
    });
    const repairedRecord = await records.load(claims);
    expect(repairedRecord).toMatchObject({ receipt: "redacted", uploadReceipt: "redacted", contentRedacted: true });
    expect(repairedRecord).not.toHaveProperty("leaseReleasePending");
    await expect(baseLeases.ownsActiveLease({ sessionKey, ownerKey, projectKey, operationKey, runId, targetTrack: "AudioDescriptions", nowMs: currentNow })).resolves.toBe(false);
    const idempotent = await cancellation();
    expect(idempotent.status).toBe(200);
    await expect(idempotent.json()).resolves.toMatchObject({ cleanup: { state: "completed", action: "cancelled" } });
    await expect(baseLeases.acquireActiveLease({
      sessionKey,
      ownerKey,
      projectKey,
      operationKey: "d".repeat(64),
      runId: `caption-after-ad-redacted-lease-repair-${currentNow}`,
      targetTrack: "Captions",
      expiresAtMs: currentNow + 60_000,
      nowMs: currentNow,
    })).resolves.toMatchObject({ kind: "acquired" });

    await env.PROCESSING_BUCKET.delete([
      `prepared/${operationKey}/audio-description-runs/${runId}.json`,
      `prepared/${operationKey}/generation-cleanup.json`,
      `processing/private-lifecycle/audio-descriptions/${operationKey}/${runId}.json`,
      activeLeaseKey,
    ]);
  }, 20_000);

  it("verifies normalized audio R2 metadata, exact size, and body digest before a provider can read it", async () => {
    const operationKey = "5".repeat(64);
    const bytes = new TextEncoder().encode("private normalized wav fixture");
    const digest = await sha256Hex(bytes);
    const key = `prepared/${operationKey}/audio/${digest}.wav`;
    await env.PROCESSING_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "audio/wav" },
      customMetadata: { sha256: digest },
    });
    await expect(privateAudioBytes(env.PROCESSING_BUCKET, {
      key,
      sha256: digest,
      byteLength: bytes.byteLength,
      durationMs: 1_000,
      contentType: "audio/wav",
    })).resolves.toEqual(bytes);

    const metadataMismatchKey = `prepared/${operationKey}/audio/${"6".repeat(64)}.wav`;
    await env.PROCESSING_BUCKET.put(metadataMismatchKey, bytes, {
      httpMetadata: { contentType: "audio/wav" },
      customMetadata: { sha256: "6".repeat(64) },
    });
    await expect(privateAudioBytes(env.PROCESSING_BUCKET, {
      key: metadataMismatchKey,
      sha256: digest,
      byteLength: bytes.byteLength,
      durationMs: 1_000,
      contentType: "audio/wav",
    })).rejects.toThrow("normalized private audio");
    const bodyMismatchKey = `prepared/${operationKey}/audio/${"7".repeat(64)}.wav`;
    const altered = new Uint8Array(bytes);
    altered[0] = altered[0] === 0 ? 1 : altered[0]! - 1;
    await env.PROCESSING_BUCKET.put(bodyMismatchKey, altered, {
      httpMetadata: { contentType: "audio/wav" },
      customMetadata: { sha256: digest },
    });
    await expect(privateAudioBytes(env.PROCESSING_BUCKET, {
      key: bodyMismatchKey,
      sha256: digest,
      byteLength: altered.byteLength,
      durationMs: 1_000,
      contentType: "audio/wav",
    })).rejects.toThrow("integrity check");
    await env.PROCESSING_BUCKET.delete([key, metadataMismatchKey, bodyMismatchKey]);
  });

  it("keeps a 15-minute, 2,700-word staged run under the R2 record bound with content-addressed artifacts", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = "d".repeat(64);
    const runId = `generation-artifacts-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-artifact-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "e".repeat(64),
      sessionKey: "f".repeat(64),
      projectKey: "0".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 15 * 60_000,
      operationId: "workerd-artifact-operation",
      operationKey,
      objectKey: `processing/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    const words = Array.from({ length: 2_700 }, (_unused, index) => ({
      evidenceId: `word-${index + 1}`,
      startMs: index * 300,
      endMs: index * 300 + 200,
      text: `word-${index + 1} ${"e".repeat(720)}`,
      speaker: "A",
      speakerSegmentIds: [`speaker-${Math.floor(index / 100) + 1}`],
      sourceWordIndex: index,
    }));
    const staged = StagedGenerationResultSchema.parse({
      contractVersion: 1,
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      evidence: {
        contractVersion: 1,
        runId,
        projectId: claims.projectId,
        mediaSha256: claims.mediaSha256,
        preparedManifest: { key: `prepared/${operationKey}/manifests/${"a".repeat(64)}.json`, sha256: "a".repeat(64) },
        normalizedAudio: { key: `prepared/${operationKey}/audio/${"b".repeat(64)}.wav`, sha256: "b".repeat(64), byteLength: 1, durationMs: 15 * 60_000, contentType: "audio/wav" },
        words,
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "c".repeat(64), responseHash: "d".repeat(64), store: null },
          { role: "word-timestamps", model: "fixture", requestHash: "e".repeat(64), responseHash: "f".repeat(64), store: null },
        ],
      },
      captions: Array.from({ length: Math.ceil(words.length / 128) }, (_unused, index) => {
        const cueWords = words.slice(index * 128, (index + 1) * 128);
        return {
          cueId: `caption-${index + 1}`,
          startMs: cueWords[0]!.startMs,
          endMs: cueWords.at(-1)!.endMs,
          text: `Caption ${index + 1}`,
          speaker: "A",
          evidenceIds: cueWords.map((word) => word.evidenceId),
        };
      }),
      createdAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    });
    const queued = {
      contractVersion: 1 as const,
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: 2,
      stage: "Queued" as const,
    };
    const store = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    const temporaryMediaKeys = [
      claims.objectKey,
      staged.evidence.preparedManifest.key,
      staged.evidence.normalizedAudio.key,
      `prepared/${operationKey}/waveforms/${"c".repeat(64)}.json`,
      `prepared/${operationKey}/thumbnails/${"d".repeat(64)}.webp`,
      `prepared/${operationKey}/indexes/${"e".repeat(64)}.json`,
    ];
    await env.PROCESSING_BUCKET.put(claims.objectKey, "private source media");
    await env.PROCESSING_BUCKET.put(staged.evidence.preparedManifest.key, "private manifest");
    await env.PROCESSING_BUCKET.put(staged.evidence.normalizedAudio.key, "private normalized audio");
    await env.PROCESSING_BUCKET.put(temporaryMediaKeys[3]!, "private waveform");
    await env.PROCESSING_BUCKET.put(temporaryMediaKeys[4]!, "private thumbnail");
    await env.PROCESSING_BUCKET.put(temporaryMediaKeys[5]!, "private manifest pointer");
    await store.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: { ...queued, stage: "AwaitingAdoption" },
      cancelled: false,
      dispatched: true,
      workflowState: {
        request: { runId, projectId: claims.projectId },
        stageHistory: [queued, { ...queued, stage: "AwaitingAdoption" }],
        cancelled: false,
        // Deliberately model the last runner snapshot: it has both rich
        // alignment output and a staged result before compaction.
        aligned: { words, uncertaintySpans: [] },
        staged,
      },
      stagedResult: staged,
      updatedAtMs: currentNow,
    });
    // A later durable checkpoint replaces its superseded whole-state snapshot
    // after the record CAS. Terminal cleanup still re-inventories the exact
    // namespace, so a failed post-CAS delete remains discoverable.
    const firstCheckpoint = await store.load(claims);
    if (firstCheckpoint?.workflowState === undefined) throw new Error("expected first private workflow checkpoint");
    const firstWorkflowStateRef = firstCheckpoint.workflowStateRef;
    await store.save({
      ...firstCheckpoint,
      workflowState: {
        ...firstCheckpoint.workflowState as Record<string, unknown>,
        stageHistory: [
          ...(firstCheckpoint.workflowState as { readonly stageHistory: readonly unknown[] }).stageHistory,
          { ...queued, stage: "SegmentingCaptions", progress: 1 },
          { ...queued, stage: "AwaitingAdoption" },
        ],
      },
      updatedAtMs: currentNow + 1,
    });
    if (firstWorkflowStateRef === undefined) throw new Error("expected first compact workflow-state ref");
    await expect(env.PROCESSING_BUCKET.head(firstWorkflowStateRef.key)).resolves.toBeNull();
    const raw = await env.PROCESSING_BUCKET.get(`prepared/${operationKey}/generation-runs/${runId}.json`);
    if (raw === null) throw new Error("expected bounded recovery record");
    expect(raw.size).toBeLessThan(2 * 1024 * 1024);
    const rawRecord = JSON.parse(await raw.text()) as Record<string, unknown>;
    expect(rawRecord.workflowState).toBeUndefined();
    expect(rawRecord.stagedResult).toBeUndefined();
    expect(rawRecord.workflowStateRef).toBeDefined();
    expect(rawRecord.stagedResultRef).toBeDefined();
    expect(rawRecord.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: expect.stringContaining("workflow-state-") }),
      expect.objectContaining({ key: expect.stringContaining("staged-result-") }),
    ]));
    const restored = await store.load(claims);
    expect(restored?.stagedResult?.evidence.words).toHaveLength(2_700);
    expect(restored?.workflowState).toEqual(expect.objectContaining({
      request: { runId, projectId: claims.projectId },
      stageHistory: expect.any(Array),
    }));
    expect(JSON.stringify(restored?.workflowState)).not.toContain("word-1");

    // Simulate a crash after the tombstone CAS but before R2 deletion. The
    // real store must resume every historical immutable checkpoint plus the
    // exact source/prepared-media keys; it must never delete a broad prefix.
    const references: Array<{ readonly key: string }> = [
      ...(rawRecord.artifactRefs as Array<{ readonly key: string }>),
      rawRecord.workflowStateRef as { readonly key: string },
      rawRecord.stagedResultRef as { readonly key: string },
    ].filter((reference, index, all) => all.findIndex((candidate) => candidate.key === reference.key) === index);
    // The interrupted tombstone only knew its source/audio/manifest and
    // historical workflow checkpoints. Derivative keys are deliberately
    // absent so retry must re-enumerate the exact Task12 output collections.
    const initialCleanupKeys = [...references.map((reference) => reference.key), ...temporaryMediaKeys.slice(0, 3)];
    const cleanupKeys = [...references.map((reference) => reference.key), ...temporaryMediaKeys];
    const pendingRaw: Record<string, unknown> = {
      ...rawRecord,
      cleanup: {
        version: 1,
        state: "pending",
        action: "discarded",
        artifactKeys: initialCleanupKeys,
        requestedAtMs: currentNow + 1,
      },
    };
    delete pendingRaw.workflowStateRef;
    delete pendingRaw.stagedResultRef;
    delete pendingRaw.artifactRefs;
    await env.PROCESSING_BUCKET.put(`prepared/${operationKey}/generation-runs/${runId}.json`, JSON.stringify(pendingRaw));
    // Simulate a bridge PUT that passed its first marker read, persisted an
    // output, then lost its post-PUT delete response. An R2 PUT has no abort
    // signal, so expiry is not proof that its writer cannot still commit.
    // The durable write lease must keep terminal cleanup pending until the
    // bridge has explicitly settled it (or the <=24h lifecycle backstop).
    const strandedOutput = temporaryMediaKeys[3]!;
    const writeLease = generationPreparationWriteLeaseKey(operationKey, strandedOutput);
    // Model a workflow checkpoint PUT that survived a process crash before
    // its compact record CAS. It is deliberately absent from `artifactRefs`;
    // terminal cleanup must drain the bounded namespace, not trust only the
    // last record inventory.
    const strandedCheckpointDigest = "9".repeat(64);
    const strandedCheckpoint = `prepared/${operationKey}/generation-runs/${runId}/artifacts/workflow-state-${strandedCheckpointDigest}.json`;
    const checkpointWriteLease = generationArtifactWriteLeaseKey(operationKey, runId, strandedCheckpoint);
    await env.PROCESSING_BUCKET.put(strandedCheckpoint, JSON.stringify({ crashed: true }));
    await env.PROCESSING_BUCKET.put(checkpointWriteLease, JSON.stringify({
      version: 1,
      artifactKey: strandedCheckpoint,
    }));
    await env.PROCESSING_BUCKET.put(writeLease, JSON.stringify({
      version: 1,
      outputKey: strandedOutput,
    }));
    const pendingCleanup = await store.cleanup({ claims, action: "discarded", nowMs: currentNow + 2 });
    expect(pendingCleanup).toMatchObject({
      cleanup: { state: "pending", action: "discarded", artifactKeys: initialCleanupKeys },
    });
    expect(await env.PROCESSING_BUCKET.head(strandedOutput)).not.toBeNull();
    expect(await env.PROCESSING_BUCKET.head(writeLease)).not.toBeNull();
    expect(await env.PROCESSING_BUCKET.head(strandedCheckpoint)).not.toBeNull();
    expect(await env.PROCESSING_BUCKET.head(checkpointWriteLease)).not.toBeNull();
    // A timestamp cannot prove an unabortable R2 writer drained. Even well
    // after the former lease expiry, this must remain a durable pending
    // tombstone rather than claim an exact cleanup that a late PUT can undo.
    const stillPendingCleanup = await store.cleanup({ claims, action: "discarded", nowMs: currentNow + 60_001 });
    expect(stillPendingCleanup).toMatchObject({ cleanup: { state: "pending", action: "discarded" } });
    expect(await env.PROCESSING_BUCKET.head(writeLease)).not.toBeNull();
    expect(await env.PROCESSING_BUCKET.head(checkpointWriteLease)).not.toBeNull();

    // The bridge's normal completion path removes its own lease only after
    // its R2 write and terminal-marker checks settle. A retry can now rescan,
    // persist every exact output key, delete them, and complete cleanup.
    await env.PROCESSING_BUCKET.delete(writeLease);
    await env.PROCESSING_BUCKET.delete(checkpointWriteLease);
    const resumedCleanup = await store.cleanup({ claims, action: "discarded", nowMs: currentNow + 60_002 });
    expect(resumedCleanup).toMatchObject({
      cleanup: { state: "completed", action: "discarded" },
    });
    expect(resumedCleanup?.cleanup?.artifactKeys).toEqual(expect.arrayContaining(cleanupKeys));
    expect(resumedCleanup?.cleanup?.artifactKeys).toContain(strandedCheckpoint);
    await expect(env.PROCESSING_BUCKET.head(writeLease)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(checkpointWriteLease)).resolves.toBeNull();
    expect(resumedCleanup?.stagedResult).toBeUndefined();
    expect(resumedCleanup?.workflowState).toBeUndefined();
    await Promise.all(references.map(async (reference) => expect(await env.PROCESSING_BUCKET.head(reference.key)).toBeNull()));
    await Promise.all(temporaryMediaKeys.map(async (key) => expect(await env.PROCESSING_BUCKET.head(key)).toBeNull()));
    await expect(env.PROCESSING_BUCKET.head(strandedCheckpoint)).resolves.toBeNull();
    await expect(store.cleanup({ claims, action: "discarded", nowMs: currentNow + 3 })).resolves.toMatchObject({
      cleanup: { state: "completed", action: "discarded" },
    });

    const objects = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/generation-runs/${runId}` });
    await env.PROCESSING_BUCKET.delete(objects.objects.map((object: { readonly key: string }) => object.key));
  });

  it("batches a >1,000-key real R2 cleanup and retains its pending tombstone when a later batch fails", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const operationKey = await sha256Hex(`workerd-cleanup-batches-${currentNow}`);
    const runId = `generation-cleanup-batches-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-cleanup-batches",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "1".repeat(64),
      sessionKey: "2".repeat(64),
      projectKey: "3".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: "workerd-cleanup-batches-operation",
      operationKey,
      objectKey: `processing/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    const target = env.PROCESSING_BUCKET;
    const artifactPrefix = `prepared/${operationKey}/generation-runs/${runId}/artifacts/`;
    const artifactKeys = Array.from({ length: 1_001 }, (_unused, index) => (
      `${artifactPrefix}provider-result-${index.toString(16).padStart(64, "0")}.json`
    ));
    // The recovery scanner validates keys rather than trusting a last record
    // snapshot, so use actual R2 objects to cross the provider-artifact page.
    await Promise.all(artifactKeys.map(async (artifactKey, index) => {
      await target.put(artifactKey, JSON.stringify({ index }));
    }));

    let failLaterBatch = true;
    const deleteBatches: number[] = [];
    const flakyBucket = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "delete") {
          return async (candidate: string | readonly string[]) => {
            const keys = typeof candidate === "string" ? [candidate] : [...candidate];
            const isRunArtifactBatch = keys.some((key) => key.startsWith(artifactPrefix));
            if (isRunArtifactBatch) {
              deleteBatches.push(keys.length);
              // This is the production R2 API contract; a future accidental
              // one-shot delete is caught even if Miniflare is permissive.
              expect(keys.length).toBeLessThanOrEqual(1_000);
              if (failLaterBatch && deleteBatches.length === 2) {
                failLaterBatch = false;
                throw new Error("injected second cleanup batch failure");
              }
            }
            return (source.delete as unknown as (input: string | readonly string[]) => Promise<void>)(candidate);
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    }) as unknown as R2Bucket;
    const store = new R2GenerationRunRecordStore(flakyBucket);
    const cancelled = {
      contractVersion: 1 as const,
      runId,
      projectId: claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: claims.expectedProjectRevision,
      stage: "Cancelled" as const,
    };
    await store.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: cancelled,
      cancelled: true,
      dispatched: true,
      cleanup: {
        version: 1,
        state: "pending",
        action: "cancelled",
        artifactKeys: [],
        requestedAtMs: currentNow,
      },
      updatedAtMs: currentNow,
    });

    const pending = await store.cleanup({ claims, action: "cancelled", nowMs: currentNow + 1 });
    expect(deleteBatches).toEqual([1_000, 1]);
    expect(pending).toMatchObject({
      cleanup: { state: "pending", action: "cancelled", artifactKeys: expect.arrayContaining(artifactKeys) },
    });
    expect(await target.head(artifactKeys[0]!)).toBeNull();
    expect(await target.head(artifactKeys.at(-1)!)).not.toBeNull();

    // Repeating the exact tombstone inventory is idempotent: already-deleted
    // first-batch keys are harmless, the stranded final key is drained, and
    // only then may the durable cleanup acknowledgement become completed.
    const completed = await store.cleanup({ claims, action: "cancelled", nowMs: currentNow + 2 });
    expect(deleteBatches).toEqual([1_000, 1, 1_000, 1]);
    expect(completed).toMatchObject({ cleanup: { state: "completed", action: "cancelled" } });
    const remaining = await target.list({ prefix: artifactPrefix });
    expect(remaining.objects).toEqual([]);

    await target.delete([
      `prepared/${operationKey}/generation-runs/${runId}.json`,
      generationCleanupMarkerKey(operationKey),
    ]);
  });

  it("serializes duplicate operation creation in a real Durable Object, uses actual R2 multipart replay, and sets security headers", async () => {
    const anonymousSession = await session();
    const request = () => post("/api/uploads", {
      projectId: "workerd-project",
      projectOwnerCapability: workerdProjectOwnerCapability,
      operationId: "workerd-operation",
      media: { byteLength: 5, durationMs: 60_000, contentType: "video/webm" },
      disclosureAccepted: true,
    }, anonymousSession);

    const [first, duplicate] = await Promise.all([SELF.fetch(request()), SELF.fetch(request())]);
    const bodies = await Promise.all([first.json(), duplicate.json()]) as Array<{ readonly operationReceipt: string; readonly uploadCapability: string }>;
    const statuses = [first.status, duplicate.status].sort((left, right) => left - right);

    expect(statuses).toEqual([200, 201]);
    expect(bodies[0]?.operationReceipt).toBe(bodies[1]?.operationReceipt);
    expect(first.headers.get("content-security-policy")).toBe("default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("strict-transport-security")).toBe("max-age=31536000");

    const capability = bodies[0]!.uploadCapability;
    const part = () => SELF.fetch(new Request("https://cuebench.test/api/uploads/workerd-operation/parts/1", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "video/webm",
        "x-cuebench-upload-capability": capability,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
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
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: "{}",
    }));
    expect(completed.status).toBe(503);
    expect((await completed.json() as { error: { code: string } }).error.code).toBe("MEDIA_PROBE_UNAVAILABLE");
    // The runtime path refuses absent authoritative probing before multipart
    // completion, so this operation's completed media object never survives.
    // Other contract tests intentionally retain independent private records.
    const completedReceipt = await verifyUploadReceipt(receipt, { keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } } }, Date.now());
    expect(await env.PROCESSING_BUCKET.head(completedReceipt.objectKey)).toBeNull();
  });

  it("runs the real Workerd bounded-visual-AD workflow, stages evidence, and exact-cleans it after human adoption", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-ad-session-${currentNow}`;
    const operationId = `workerd-ad-operation-${currentNow}`;
    const projectId = "workerd-ad-project";
    const runId = `workerd-ad-run-${currentNow}`;
    const anonymousSession = await issueAnonymousSession({
      sessionId,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60 * 60_000,
      keyRing: settings.keyRing,
    });
    const [sessionKey, ipKey, operationKey, projectKey, reservationKey, ownerKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
    ]);
    const source = new TextEncoder().encode("cuebench-workerd-ad-fixture-source");
    const sourceSha256 = await sha256Hex(source);
    const objectKey = `processing/${sessionKey}/${operationKey}`;
    await env.PROCESSING_BUCKET.put(objectKey, source, { httpMetadata: { contentType: "video/webm" } });
    const uploadReceipt = await issueUploadReceipt({
      sessionId,
      sessionKey,
      ownerKey,
      ipKey,
      operationId,
      operationKey,
      projectKey,
      reservationKey,
      metadataHash: "f".repeat(64),
      objectKey,
      media: { byteLength: source.byteLength, durationMs: 31_000, contentType: "video/webm" },
      partSize: source.byteLength,
      partCount: 1,
      issuedAtMs: currentNow,
      receiptExpiresAtMs: currentNow + 60 * 60_000,
      settings,
    });
    const captionEvidenceProjection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: sourceSha256,
      localEvidencePackageIds: ["caption-package-1"],
      captions: [{
        itemId: "caption-1",
        itemRevision: 1,
        state: "Sustained" as const,
        startMs: 1_000,
        endMs: 3_000,
        text: "Dr. Nguyen introduces the energy diagram.",
        evidenceIds: ["word-1"],
      }],
      evidence: [{ evidenceId: "word-1", itemId: "caption-1", itemRevision: 1, startMs: 1_000, endMs: 1_500 }],
    };
    const captionEvidenceHash = canonicalHash("cuebench.audio-description.caption-evidence.v1", captionEvidenceProjection).slice("sha256:".length);
    const started = await SELF.fetch(new Request("https://cuebench.test/api/audio-description-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "cf-connecting-ip": "203.0.113.10",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({
        projectId,
        runId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: sourceSha256,
        sourceByteLength: source.byteLength,
        sourceDurationMs: 31_000,
        captionEvidenceProjection,
        captionEvidenceHash,
      }),
    }));
    expect(started.status).toBe(201);
    const audioDescriptionGenerationReceipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const claims = await verifyAudioDescriptionGenerationRunReceipt(audioDescriptionGenerationReceipt, settings, Date.now());
    const records = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    try {
      await vi.waitFor(async () => {
        const record = await records.load(claims);
        expect(record?.status.stage).toBe("AwaitingAdoption");
        expect(record?.stagedResultRef).toBeDefined();
      }, { timeout: 15_000, interval: 100 });
    } catch {
      throw new Error(`fixture AD workflow terminal state: ${JSON.stringify((await records.load(claims))?.status)}`);
    }
    const workflow = await (env.AUDIO_DESCRIPTION_PROCESSING_WORKFLOW as NonNullable<typeof env.AUDIO_DESCRIPTION_PROCESSING_WORKFLOW>)
      .get?.(await audioDescriptionWorkflowInstanceId(operationKey, runId));
    if (workflow === undefined) throw new Error("expected real Workerd audio-description Workflow instance");
    await vi.waitFor(async () => expect((await workflow.status()).status).toBe("complete"), { timeout: 15_000, interval: 100 });

    const stagedResponse = await SELF.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runId}/staged-result`, {
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "x-cuebench-audio-description-receipt": audioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
    }));
    expect(stagedResponse.status).toBe(200);
    const staged = (await stagedResponse.json() as { readonly result: {
      readonly audioDescriptions: readonly { readonly beatId: string; readonly evidenceIds: readonly string[] }[];
      readonly evidence: {
        readonly provenance: readonly unknown[];
        readonly frames: readonly { readonly evidenceId: string }[];
        readonly preparedManifest: { readonly key: string };
      };
    } }).result;
    expect(staged.audioDescriptions).toHaveLength(1);
    expect(staged.evidence.frames).toHaveLength(1);
    expect(staged.audioDescriptions[0]?.beatId).toMatch(/^ad-beat-[a-f0-9]{48}$/);
    expect(staged.evidence.frames[0]?.evidenceId).toMatch(/^ad-frame-[a-f0-9]{48}$/);
    expect(staged.audioDescriptions[0]?.evidenceIds).toEqual([staged.evidence.frames[0]?.evidenceId]);
    expect(staged.evidence.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "audio-description", store: false, provider: "fixture", mode: "fixture" }),
    ]));

    const acknowledged = await SELF.fetch(new Request(`https://cuebench.test/api/audio-description-runs/${runId}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "content-type": "application/json",
        "x-cuebench-audio-description-receipt": audioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": workerdProjectOwnerCapability,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision: 3 }),
    }));
    expect(acknowledged.status).toBe(200);
    await vi.waitFor(async () => expect((await records.load(claims))).toMatchObject({
      cleanup: { state: "completed", action: "adopted" },
      contentRedacted: true,
      receipt: "redacted",
      uploadReceipt: "redacted",
    }), { timeout: 15_000, interval: 100 });
    const runArtifacts = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/audio-description-runs/${runId}/artifacts/` });
    expect(runArtifacts.objects).toEqual([]);
    expect(await env.PROCESSING_BUCKET.head(objectKey)).toBeNull();
    expect(await env.PROCESSING_BUCKET.head(staged.evidence.preparedManifest.key)).toBeNull();
    expect((await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/thumbnails/` })).objects).toEqual([]);
    expect((await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/audio/` })).objects).toEqual([]);
    expect((await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/waveforms/` })).objects).toEqual([]);
    expect((await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/indexes/` })).objects).toEqual([]);
  }, 20_000);

  it("uses immutable real-R2 attempts for a known 429 and never replays an accepted-unknown AD window", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const sessionId = `workerd-ad-retry-session-${currentNow}`;
    const operationId = `workerd-ad-retry-operation-${currentNow}`;
    const runId = `workerd-ad-retry-run-${currentNow}`;
    const projectId = "workerd-ad-retry-project";
    const [sessionKey, ownerKey, projectKey, operationKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "project-owner", workerdProjectOwnerCapability),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
    ]);
    const projection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "a".repeat(64),
      localEvidencePackageIds: ["caption-package-1"],
      captions: [{
        itemId: "caption-1",
        itemRevision: 1,
        state: "Sustained" as const,
        startMs: 1_000,
        endMs: 3_000,
        text: "The lecturer names the diagram.",
        evidenceIds: [],
      }],
      evidence: [],
    };
    const captionEvidenceHash = canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length);
    const receipt = await issueAudioDescriptionGenerationRunReceipt({
      runId,
      projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "a".repeat(64),
      captionEvidenceHash,
      sessionKey,
      ownerKey,
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId,
      operationKey,
      objectKey: `processing/${sessionKey}/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: currentNow + 60_000,
    }, settings);
    const claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow);
    const records = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    const record: AudioDescriptionGenerationRunRecord = {
      version: 1,
      receipt,
      claims,
      uploadReceipt: "opaque-private-upload-receipt",
      captionEvidenceProjection: projection,
      status: {
        contractVersion: 1,
        runId,
        projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        stage: "Queued",
      },
      cancelled: false,
      dispatched: false,
      workflowAttempt: 1,
      windowCheckpoints: {},
      artifactRefs: [],
      privateObjectKeys: [claims.objectKey],
      updatedAtMs: currentNow,
    };
    await records.save(record);
    // A crash may occur after the media preparer writes immutable evidence
    // but before the Workflow appends those keys to the recovery record.
    // Keep this unregistered pair inside the operation-scoped prep namespace
    // so cleanup must discover it by its bounded rescan.
    const orphanManifestKey = `prepared/${operationKey}/manifests/${"b".repeat(64)}.json`;
    const orphanThumbnailKey = `prepared/${operationKey}/thumbnails/${"c".repeat(64)}.webp`;
    await env.PROCESSING_BUCKET.put(orphanManifestKey, "orphan-prepared-manifest");
    await env.PROCESSING_BUCKET.put(orphanThumbnailKey, "orphan-prepared-thumbnail");

    // This transition is written only after a provider response proves the
    // call was safe to replay (for example, an HTTP 429 with no acceptance).
    const first = await records.claimWindowProviderCall({ claims, windowId: "ad-window-429", nowMs: currentNow });
    if (first.kind !== "claimed") throw new Error("Expected durable provider attempt one.");
    await records.markWindowRetryableFailure({
      claims,
      windowId: "ad-window-429",
      attemptId: first.attemptId,
      nowMs: currentNow + 1,
    });
    const second = await records.claimWindowProviderCall({ claims, windowId: "ad-window-429", nowMs: currentNow + 2 });
    if (second.kind !== "claimed") throw new Error("Known 429 must atomically create attempt two before replay.");
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await records.completeWindow({
      claims,
      windowId: "ad-window-429",
      attemptId: second.attemptId,
      value: { version: 1, provider: { value: { proposals: [] } }, startedAtMs: currentNow + 2, completedAtMs: currentNow + 3 },
      nowMs: currentNow + 3,
    })).not.toBeNull();
    // A late ambiguous report may never downgrade a completed window.
    await records.markWindowAcceptedUnknown({
      claims,
      windowId: "ad-window-429",
      attemptId: second.attemptId,
      nowMs: currentNow + 4,
    });
    expect((await records.load(claims))?.windowCheckpoints["ad-window-429"]).toMatchObject({
      state: "completed",
      attemptId: second.attemptId,
    });

    const ambiguous = await records.claimWindowProviderCall({ claims, windowId: "ad-window-ambiguous", nowMs: currentNow + 5 });
    if (ambiguous.kind !== "claimed") throw new Error("Expected one durable ambiguous-call attempt.");
    await records.markWindowAcceptedUnknown({
      claims,
      windowId: "ad-window-ambiguous",
      attemptId: ambiguous.attemptId,
      nowMs: currentNow + 6,
    });
    await expect(records.claimWindowProviderCall({ claims, windowId: "ad-window-ambiguous", nowMs: currentNow + 7 }))
      .resolves.toMatchObject({ kind: "accepted-unknown" });

    // Leave only the normal terminal tombstone, not a content-bearing test record.
    await records.terminal({ claims, action: "cancelled", nowMs: currentNow + 8 });
    await expect(records.cleanup({ claims, action: "cancelled", nowMs: currentNow + 8 })).resolves.toMatchObject({
      cleanup: { state: "completed", action: "cancelled" },
      contentRedacted: true,
    });
    expect(await env.PROCESSING_BUCKET.head(orphanManifestKey)).toBeNull();
    expect(await env.PROCESSING_BUCKET.head(orphanThumbnailKey)).toBeNull();
  }, 20_000);

  it("runs a real Durable Object alarm that deletes a queued private-object lifecycle before retaining terminal state", async () => {
    const anonymousSession = await session();
    const created = await SELF.fetch(post("/api/uploads", {
      projectId: "workerd-alarm-project",
      projectOwnerCapability: workerdProjectOwnerCapability,
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

  it("runs the authenticated scheduled exact-key sweep before the private 24-hour deadline", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const retentionExpiresAtMs = currentNow + 24 * 60 * 60 * 1_000;
    const operationKey = "c".repeat(64);
    const runId = `scheduled-cleanup-${currentNow}`;
    const receipt = await issueGenerationRunReceipt({
      runId,
      projectId: "workerd-scheduled-cleanup-project",
      targetTrack: "Captions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "d".repeat(64),
      sessionKey: "e".repeat(64),
      projectKey: "f".repeat(64),
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: `scheduled-cleanup-operation-${currentNow}`,
      operationKey,
      objectKey: `processing/${"e".repeat(64)}/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: retentionExpiresAtMs,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    const recordKey = `prepared/${operationKey}/generation-runs/${runId}.json`;
    const indexKey = lifecycleReconciliationKey({ targetTrack: "Captions", operationKey, runId });
    const records = new R2GenerationRunRecordStore(env.PROCESSING_BUCKET);
    await env.PROCESSING_BUCKET.put(claims.objectKey, "private source media");
    await records.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      status: {
        contractVersion: 1,
        runId,
        projectId: claims.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: claims.expectedProjectRevision,
        stage: "Queued",
      },
      cancelled: false,
      dispatched: true,
      workflowAttempt: 1,
      updatedAtMs: currentNow,
    });

    expect(await env.PROCESSING_BUCKET.head(indexKey)).not.toBeNull();
    const result = await reconcileWorkerPrivateLifecycle(env, retentionExpiresAtMs - 30 * 60 * 1_000);

    // The Workerd bucket intentionally persists other test operations too;
    // this asserts our run was included without assuming it was the only due
    // exact tombstone in the bounded scheduled batch.
    expect(result?.scanned).toBeGreaterThanOrEqual(1);
    expect(result?.due).toBeGreaterThanOrEqual(1);
    expect(result?.completed).toBeGreaterThanOrEqual(1);
    expect(result?.pending).toBe(0);
    await expect(env.PROCESSING_BUCKET.head(claims.objectKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(recordKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(indexKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(operationKey))).resolves.toBeNull();
  });

  it("uses the same bounded scheduled tombstone path for private audio-description recovery", async () => {
    const settings = resolveWorkerSettings(env);
    const currentNow = Date.now();
    const retentionExpiresAtMs = currentNow + 24 * 60 * 60 * 1_000;
    const operationKey = "8".repeat(64);
    const runId = `scheduled-ad-cleanup-${currentNow}`;
    const projectId = "workerd-scheduled-ad-cleanup-project";
    const sessionKey = "9".repeat(64);
    const ownerKey = "a".repeat(64);
    const projectKey = "b".repeat(64);
    const projection = {
      contractVersion: 1 as const,
      projectId,
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: "c".repeat(64),
      localEvidencePackageIds: ["scheduled-caption-package"],
      captions: [{
        itemId: "scheduled-caption-1",
        itemRevision: 1,
        state: "Sustained" as const,
        startMs: 1_000,
        endMs: 3_000,
        text: "The lecturer names the diagram.",
        evidenceIds: [],
      }],
      evidence: [],
    };
    const captionEvidenceHash = canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length);
    const receipt = await issueAudioDescriptionGenerationRunReceipt({
      runId,
      projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 2,
      expectedQualityProfileRevision: 1,
      mediaSha256: projection.mediaSha256,
      captionEvidenceHash,
      sessionKey,
      ownerKey,
      projectKey,
      sourceByteLength: 5,
      sourceDurationMs: 31_000,
      operationId: `scheduled-ad-cleanup-operation-${currentNow}`,
      operationKey,
      objectKey: `processing/${sessionKey}/${operationKey}`,
      issuedAtMs: currentNow,
      expiresAtMs: retentionExpiresAtMs,
    }, settings);
    const claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow);
    const recordKey = `prepared/${operationKey}/audio-description-runs/${runId}.json`;
    const indexKey = lifecycleReconciliationKey({ targetTrack: "AudioDescriptions", operationKey, runId });
    const records = new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET);
    await env.PROCESSING_BUCKET.put(claims.objectKey, "private source media");
    await records.save({
      version: 1,
      receipt,
      claims,
      uploadReceipt: "private-upload-receipt",
      captionEvidenceProjection: projection,
      status: {
        contractVersion: 1,
        runId,
        projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: claims.expectedProjectRevision,
        stage: "Queued",
      },
      cancelled: false,
      dispatched: true,
      workflowAttempt: 1,
      windowCheckpoints: {},
      artifactRefs: [],
      privateObjectKeys: [claims.objectKey],
      updatedAtMs: currentNow,
    });

    const result = await reconcileWorkerPrivateLifecycle(env, retentionExpiresAtMs - 30 * 60 * 1_000);

    expect(result?.completed).toBeGreaterThanOrEqual(1);
    expect(result?.pending).toBe(0);
    await expect(env.PROCESSING_BUCKET.head(claims.objectKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(recordKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(indexKey)).resolves.toBeNull();
    await expect(env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(operationKey))).resolves.toBeNull();
  });

  it("keeps an invalid multipart abort non-terminal when local workerd cannot identify it as NoSuchUpload", async () => {
    const anonymousSession = await session();
    const created = await SELF.fetch(post("/api/uploads", {
      projectId: "workerd-r2-abort-project",
      projectOwnerCapability: workerdProjectOwnerCapability,
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
