/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  generationWorkflowInstanceId,
  issueGenerationRunReceipt,
  R2GenerationRunRecordStore,
  verifyGenerationRunReceipt,
  type GenerationRunRecord,
} from "./generation-routes";
import { resolveWorkerSettings } from "./env";
import { saltedLedgerKey } from "./quota-ledger";
import { issueAnonymousSession } from "./session";
import { issueUploadReceipt, verifyUploadReceipt } from "./uploads";
import { sha256Hex } from "./openai/client";
import { fixtureMediaPreparationEnabled, fixtureMediaPreparationResponse } from "./media-preparation-fixture";
import { generationCleanupMarkerKey, generationPreparationWriteLeaseKey } from "./generation-cleanup";
import { signMediaJob } from "./probe";

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
    const [sessionKey, ipKey, projectKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
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

    await vi.waitFor(async () => expect((await records.load(first.claims))?.status.stage).toBe("AwaitingAdoption"), { timeout: 15_000, interval: 100 });
    const adopted = await SELF.fetch(new Request(`https://cuebench.test/api/generation-runs/${first.claims.runId}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anonymousSession}`,
        "content-type": "application/json",
        "x-cuebench-generation-receipt": first.receipt,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision: 3 }),
    }));
    expect(adopted.status).toBe(200);
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
    const [sessionKey, ipKey, operationKey, projectKey, reservationKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.10"),
      saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project", projectId),
      saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
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
      expect.objectContaining({ role: "reconciliation", store: false, model: "gpt-5.6-terra" }),
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
      captions: words.map((word, index) => ({ cueId: `caption-${index + 1}`, startMs: word.startMs, endMs: word.endMs, text: `Caption ${index + 1}`, speaker: "A", evidenceIds: [word.evidenceId] })),
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
    // A later durable checkpoint must retain the earlier immutable state
    // reference for exact cleanup rather than leaving it to lifecycle expiry.
    const firstCheckpoint = await store.load(claims);
    if (firstCheckpoint?.workflowState === undefined) throw new Error("expected first private workflow checkpoint");
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
    // A timestamp cannot prove an unabortable R2 writer drained. Even well
    // after the former lease expiry, this must remain a durable pending
    // tombstone rather than claim an exact cleanup that a late PUT can undo.
    const stillPendingCleanup = await store.cleanup({ claims, action: "discarded", nowMs: currentNow + 60_001 });
    expect(stillPendingCleanup).toMatchObject({ cleanup: { state: "pending", action: "discarded" } });
    expect(await env.PROCESSING_BUCKET.head(writeLease)).not.toBeNull();

    // The bridge's normal completion path removes its own lease only after
    // its R2 write and terminal-marker checks settle. A retry can now rescan,
    // persist every exact output key, delete them, and complete cleanup.
    await env.PROCESSING_BUCKET.delete(writeLease);
    const resumedCleanup = await store.cleanup({ claims, action: "discarded", nowMs: currentNow + 60_002 });
    expect(resumedCleanup).toMatchObject({
      cleanup: { state: "completed", action: "discarded" },
    });
    expect(resumedCleanup?.cleanup?.artifactKeys).toEqual(expect.arrayContaining(cleanupKeys));
    await expect(env.PROCESSING_BUCKET.head(writeLease)).resolves.toBeNull();
    expect(resumedCleanup?.stagedResult).toBeUndefined();
    expect(resumedCleanup?.workflowState).toBeUndefined();
    await Promise.all(references.map(async (reference) => expect(await env.PROCESSING_BUCKET.head(reference.key)).toBeNull()));
    await Promise.all(temporaryMediaKeys.map(async (key) => expect(await env.PROCESSING_BUCKET.head(key)).toBeNull()));
    await expect(store.cleanup({ claims, action: "discarded", nowMs: currentNow + 3 })).resolves.toMatchObject({
      cleanup: { state: "completed", action: "discarded" },
    });

    const objects = await env.PROCESSING_BUCKET.list({ prefix: `prepared/${operationKey}/generation-runs/${runId}` });
    await env.PROCESSING_BUCKET.delete(objects.objects.map((object: { readonly key: string }) => object.key));
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
    // completion, so this operation's completed media object never survives.
    // Other contract tests intentionally retain independent private records.
    const completedReceipt = await verifyUploadReceipt(receipt, { keyRing: { current: { id: "v1", secret: env.SESSION_HMAC_CURRENT_KEY } } }, Date.now());
    expect(await env.PROCESSING_BUCKET.head(completedReceipt.objectKey)).toBeNull();
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
