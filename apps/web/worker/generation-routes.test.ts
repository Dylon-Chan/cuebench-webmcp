import { describe, expect, it, vi } from "vitest";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
import {
  createGenerationRoutes,
  InMemoryGenerationRunRecordStore,
  type GenerationRunRecord,
  type GenerationRunRecordStore,
  type GenerationWorkflowControl,
} from "./generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "./env";
import { InMemoryQuotaLedger, saltedLedgerKey } from "./quota-ledger";
import { issueAnonymousSession } from "./session";
import { issueUploadReceipt } from "./uploads";

const now = 1_700_000_000_000;
const digest = (character: string): string => character.repeat(64);
const sourceByteLength = 5;
const sourceDurationMs = 31_000;
const env: WorkerEnv = {
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-generation-routes-fixture-32-bytes",
  QUOTA_SALT: "generation-routes-quota-salt-fixture-32-bytes",
  TURNSTILE_SECRET: "generation-routes-turnstile-secret-fixture-32-bytes",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
};

const setup = async () => {
  const settings = resolveWorkerSettings(env);
  const sessionId = "generation-session";
  const projectId = "generation-project";
  const operationId = "generation-operation";
  const [projectKey, sessionKey, ipKey, operationKey, reservationKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "project", projectId),
    saltedLedgerKey(settings.quotaSalt, "session", sessionId),
    saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.8"),
    saltedLedgerKey(settings.quotaSalt, "operation", `${sessionId}:${operationId}`),
    saltedLedgerKey(settings.quotaSalt, "reservation", `${sessionId}:${operationId}`),
  ]);
  const session = await issueAnonymousSession({ sessionId, issuedAtMs: now, expiresAtMs: now + 60 * 60_000, keyRing: settings.keyRing });
  const uploadReceipt = await issueUploadReceipt({
    sessionId,
    sessionKey,
    ipKey,
    operationId,
    operationKey,
    projectKey,
    reservationKey,
    metadataHash: "f".repeat(64),
    objectKey: `processing/${sessionKey}/${operationKey}`,
    media: { byteLength: sourceByteLength, durationMs: sourceDurationMs, contentType: "video/webm" },
    partSize: 5,
    partCount: 1,
    issuedAtMs: now,
    receiptExpiresAtMs: now + 60 * 60_000,
    settings,
  });
  const runs = new InMemoryGenerationRunRecordStore();
  const ledger = new InMemoryQuotaLedger();
  return { settings, session, uploadReceipt, projectId, operationKey, runs, ledger };
};

const stagedResult = (input: {
  readonly runId: string;
  readonly projectId: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
}) => StagedGenerationResultSchema.parse({
  contractVersion: 1,
  ...input,
  targetTrack: "Captions",
  evidence: {
    contractVersion: 1,
    runId: input.runId,
    projectId: input.projectId,
    mediaSha256: digest("a"),
    preparedManifest: { key: "prepared/fixture/manifest.json", sha256: digest("b") },
    normalizedAudio: {
      key: "prepared/fixture/audio.wav",
      sha256: digest("c"),
      byteLength: 1,
      durationMs: 1_000,
      contentType: "audio/wav",
    },
    words: [{
      evidenceId: "word-fixture-1",
      startMs: 0,
      endMs: 1_000,
      text: "Fixture",
      speaker: "A",
      speakerSegmentIds: ["speaker-fixture-1"],
      sourceWordIndex: 0,
    }],
    uncertaintySpans: [],
    provenance: [
      { role: "diarization", model: "fixture", requestHash: digest("d"), responseHash: digest("e"), store: false },
      { role: "word-timestamps", model: "fixture", requestHash: digest("f"), responseHash: digest("0"), store: false },
    ],
  },
  captions: [{ cueId: "caption-fixture-1", startMs: 0, endMs: 1_000, text: "Fixture", speaker: "A", evidenceIds: ["word-fixture-1"] }],
  createdAtMs: now,
  expiresAtMs: now + 60_000,
});

describe("generation routes", () => {
  it("persists the signed receipt before dispatch, then exposes only its visible stage", async () => {
    const fixture = await setup();
    let persistedBeforeDispatch = false;
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async ({ operationKey, receipt }) => {
        persistedBeforeDispatch = (await fixture.runs.load({ operationKey, runId: "generation-run" }))?.receipt === receipt;
      }),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = await app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "generation-run",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: "a".repeat(64),
        sourceByteLength,
        sourceDurationMs,
        qualityProfileRules: { caption: { maxLineLength: 36, maxLineCount: 2 } },
      }),
    }));

    expect(start.status).toBe(201);
    expect(persistedBeforeDispatch).toBe(true);
    expect((await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-run" }))?.qualityProfileRules).toEqual({
      caption: { maxLineLength: 36, maxLineCount: 2 },
    });
    const body = await start.json() as { readonly generationRunReceipt: string; readonly retentionExpiresAtMs: number; readonly status: { readonly stage: string } };
    expect(body.status.stage).toBe("Queued");
    expect(body.generationRunReceipt).toMatch(/\./);
    expect(body.retentionExpiresAtMs).toBe(now + 60 * 60_000);
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);

    const status = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-run", {
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": body.generationRunReceipt },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: expect.objectContaining({ stage: "Queued", runId: "generation-run" }) });
  });

  it("binds generation to the exact anonymous upload owner and source facts", async () => {
    const fixture = await setup();
    const otherSession = await issueAnonymousSession({
      sessionId: "different-generation-session",
      issuedAtMs: now,
      expiresAtMs: now + 60 * 60_000,
      keyRing: fixture.settings.keyRing,
    });
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const request = (session: string, overrides: Record<string, unknown> = {}) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "generation-owner-bound",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
        ...overrides,
      }),
    }));

    await expect(request(otherSession)).resolves.toMatchObject({ status: 403 });
    await expect(request(fixture.session, { sourceDurationMs: sourceDurationMs + 1 })).resolves.toMatchObject({ status: 409 });
    const accepted = await request(fixture.session);
    expect(accepted.status).toBe(201);
    const stored = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-owner-bound" });
    expect(stored?.claims).toMatchObject({
      sourceByteLength,
      sourceDurationMs,
    });
    expect(stored?.claims.sessionKey).toHaveLength(64);
  });

  it("makes cancellation durable and idempotent without returning private staged artifacts", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: async () => undefined,
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = await app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.session}`, "cf-connecting-ip": "203.0.113.8", "content-type": "application/json", "x-cuebench-operation-receipt": fixture.uploadReceipt },
      body: JSON.stringify({ projectId: fixture.projectId, runId: "generation-cancel", expectedProjectRevision: 2, expectedQualityProfileRevision: 1, mediaSha256: "a".repeat(64), sourceByteLength, sourceDurationMs, qualityProfileRules: { caption: { maxLineLength: 36 } } }),
    }));
    const receipt = (await start.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    const initial = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-cancel" });
    if (initial === null) throw new Error("expected durable generation record");
    const awaiting = {
      contractVersion: 1 as const,
      runId: initial.claims.runId,
      projectId: initial.claims.projectId,
      targetTrack: "Captions" as const,
      expectedProjectRevision: initial.claims.expectedProjectRevision,
      stage: "AwaitingAdoption" as const,
    };
    const staleWorkerSnapshot = {
      ...initial,
      status: awaiting,
      stagedResult: stagedResult({
        runId: initial.claims.runId,
        projectId: initial.claims.projectId,
        expectedProjectRevision: initial.claims.expectedProjectRevision,
        expectedQualityProfileRevision: initial.claims.expectedQualityProfileRevision,
      }),
    };
    await fixture.runs.save(staleWorkerSnapshot);

    const cancelled = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-cancel", {
      method: "DELETE",
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": receipt },
    }));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: expect.objectContaining({ stage: "Cancelled" }),
      cleanup: expect.objectContaining({ state: "completed", action: "cancelled" }),
    });
    expect(workflow.cancelCaptionGeneration).toHaveBeenCalledTimes(1);
    // Model an in-flight worker committing its stale, already-staged snapshot
    // after DELETE. The record store must let cancellation win permanently.
    await fixture.runs.save(staleWorkerSnapshot);
    expect(await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-cancel" })).toMatchObject({
      cancelled: true,
      status: { stage: "Cancelled" },
    });
    const staged = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-cancel/staged-result", {
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": receipt },
    }));
    expect(staged.status).toBe(409);
  });

  it("retries a durable pending cancellation cleanup instead of falsely treating it as complete", async () => {
    const fixture = await setup();
    let stored: GenerationRunRecord | null = null;
    const cleanup = vi.fn(async ({ nowMs }: { readonly nowMs: number }) => {
      if (stored === null || stored.cleanup === undefined) return stored;
      stored = {
        ...stored,
        cleanup: { ...stored.cleanup, state: "completed", completedAtMs: nowMs },
        updatedAtMs: nowMs,
      };
      return stored;
    });
    const runs: GenerationRunRecordStore = {
      load: async () => stored,
      save: async (record) => { stored = record; },
      cleanup,
    };
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: async () => undefined,
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs, workflow });
    const start = await app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.session}`, "cf-connecting-ip": "203.0.113.8", "content-type": "application/json", "x-cuebench-operation-receipt": fixture.uploadReceipt },
      body: JSON.stringify({ projectId: fixture.projectId, runId: "generation-cancel-pending", expectedProjectRevision: 2, expectedQualityProfileRevision: 1, mediaSha256: "a".repeat(64), sourceByteLength, sourceDurationMs }),
    }));
    const receipt = (await start.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    const existing = await runs.load({ operationKey: fixture.operationKey, runId: "generation-cancel-pending" });
    if (existing === null) throw new Error("expected generation record");
    stored = {
      ...existing,
      cancelled: true,
      status: { ...existing.status, stage: "Cancelled" },
      cleanup: { version: 1, state: "pending", action: "cancelled", artifactKeys: [], requestedAtMs: now },
    };

    const retried = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-cancel-pending", {
      method: "DELETE",
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": receipt },
    }));
    expect(retried.status).toBe(200);
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ action: "cancelled" }));
    expect(await retried.json()).toEqual({
      status: expect.objectContaining({ stage: "Cancelled" }),
      cleanup: expect.objectContaining({ state: "completed", action: "cancelled" }),
    });
  });

  it("authenticates idempotent adoption or discard acknowledgement and leaves exact cleanup durable", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: async () => undefined,
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = async (runId: string): Promise<string> => {
      const response = await app.fetch(new Request("https://cuebench.test/api/generation-runs", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.session}`, "cf-connecting-ip": "203.0.113.8", "content-type": "application/json", "x-cuebench-operation-receipt": fixture.uploadReceipt },
        body: JSON.stringify({ projectId: fixture.projectId, runId, expectedProjectRevision: 2, expectedQualityProfileRevision: 1, mediaSha256: "a".repeat(64), sourceByteLength, sourceDurationMs }),
      }));
      expect(response.status).toBe(201);
      return (await response.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    };
    const markAwaiting = async (runId: string) => {
      const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId });
      if (record === null) throw new Error("expected generation record");
      await fixture.runs.save({
        ...record,
        status: { contractVersion: 1, runId, projectId: fixture.projectId, targetTrack: "Captions", expectedProjectRevision: 2, stage: "AwaitingAdoption" },
        workflowState: {
          request: { runId, projectId: fixture.projectId },
          stageHistory: [record.status, { contractVersion: 1, runId, projectId: fixture.projectId, targetTrack: "Captions", expectedProjectRevision: 2, stage: "AwaitingAdoption" }],
          cancelled: false,
        },
        stagedResult: stagedResult({ runId, projectId: fixture.projectId, expectedProjectRevision: 2, expectedQualityProfileRevision: 1 }),
        updatedAtMs: now + 1,
      });
    };

    const adoptedReceipt = await start("generation-acknowledged-adoption");
    await markAwaiting("generation-acknowledged-adoption");
    const acknowledge = (receipt: string, runId: string, body: unknown) => app.fetch(new Request(`https://cuebench.test/api/generation-runs/${runId}/acknowledge`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.session}`, "content-type": "application/json", "x-cuebench-generation-receipt": receipt },
      body: JSON.stringify(body),
    }));
    const adopted = await acknowledge(adoptedReceipt, "generation-acknowledged-adoption", { action: "adopted", adoptedProjectRevision: 3 });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({
      status: expect.objectContaining({ stage: "Completed", adoptedProjectRevision: 3 }),
      cleanup: expect.objectContaining({ state: "completed", action: "adopted" }),
    });
    await expect(acknowledge(adoptedReceipt, "generation-acknowledged-adoption", { action: "adopted", adoptedProjectRevision: 3 })).resolves.toMatchObject({ status: 200 });
    await expect(acknowledge(adoptedReceipt, "generation-acknowledged-adoption", { action: "adopted", adoptedProjectRevision: 4 })).resolves.toMatchObject({ status: 409 });

    const discardReceipt = await start("generation-acknowledged-discard");
    await markAwaiting("generation-acknowledged-discard");
    const discarded = await acknowledge(discardReceipt, "generation-acknowledged-discard", { action: "discarded" });
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toEqual({
      status: expect.objectContaining({ stage: "Cancelled" }),
      cleanup: expect.objectContaining({ state: "completed", action: "discarded" }),
    });
    await expect(acknowledge(discardReceipt, "generation-acknowledged-discard", { action: "discarded" })).resolves.toMatchObject({ status: 200 });
    expect(await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-acknowledged-discard" })).toMatchObject({
      cancelled: true,
      cleanup: { state: "completed", action: "discarded" },
    });
  });
});
