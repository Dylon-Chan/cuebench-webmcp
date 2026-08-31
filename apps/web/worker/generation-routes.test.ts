import { describe, expect, it, vi } from "vitest";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
import {
  createGenerationRoutes,
  bindingWorkflow,
  GenerationWorkflowInstanceTerminalError,
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

const setup = async (identity: {
  readonly sessionId?: string;
  readonly projectId?: string;
  /** A stable, browser-local owner capability that survives anonymous-session renewal. */
  readonly projectOwnerCapability?: string;
} = {}) => {
  const settings = resolveWorkerSettings(env);
  const sessionId = identity.sessionId ?? "generation-session";
  const projectId = identity.projectId ?? "generation-project";
  const operationId = "generation-operation";
  const [projectKey, sessionKey, ipKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "project", projectId),
    saltedLedgerKey(settings.quotaSalt, "session", sessionId),
    saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.8"),
  ]);
  // Old fixture receipts are deliberately session-owned. New owner-bound receipts
  // use an independent secret, allowing the same browser project to renew its
  // anonymous session without bypassing the active-generation fence.
  const ownerKey = identity.projectOwnerCapability === undefined
    ? sessionKey
    : await saltedLedgerKey(settings.quotaSalt, "project-owner", identity.projectOwnerCapability);
  const [operationKey, reservationKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "operation", `${ownerKey}:${operationId}`),
    saltedLedgerKey(settings.quotaSalt, "reservation", `${ownerKey}:${operationId}`),
  ]);
  const session = await issueAnonymousSession({ sessionId, issuedAtMs: now, expiresAtMs: now + 60 * 60_000, keyRing: settings.keyRing });
  const uploadReceipt = await issueUploadReceipt({
    sessionId,
    sessionKey,
    ...(identity.projectOwnerCapability === undefined ? {} : { ownerKey }),
    ipKey,
    operationId,
    operationKey,
    projectKey,
    reservationKey,
    metadataHash: "f".repeat(64),
    objectKey: `processing/${ownerKey}/${operationKey}`,
    media: { byteLength: sourceByteLength, durationMs: sourceDurationMs, contentType: "video/webm" },
    partSize: 5,
    partCount: 1,
    issuedAtMs: now,
    receiptExpiresAtMs: now + 60 * 60_000,
    settings,
  });
  const runs = new InMemoryGenerationRunRecordStore();
  const ledger = new InMemoryQuotaLedger();
  const uploadForOperation = async (nextOperationId: string): Promise<string> => {
    const [nextOperationKey, nextReservationKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "operation", `${ownerKey}:${nextOperationId}`),
      saltedLedgerKey(settings.quotaSalt, "reservation", `${ownerKey}:${nextOperationId}`),
    ]);
    return issueUploadReceipt({
      sessionId,
      sessionKey,
      ...(identity.projectOwnerCapability === undefined ? {} : { ownerKey }),
      ipKey,
      operationId: nextOperationId,
      operationKey: nextOperationKey,
      projectKey,
      reservationKey: nextReservationKey,
      metadataHash: "f".repeat(64),
      objectKey: `processing/${ownerKey}/${nextOperationKey}`,
      media: { byteLength: sourceByteLength, durationMs: sourceDurationMs, contentType: "video/webm" },
      partSize: 5,
      partCount: 1,
      issuedAtMs: now,
      receiptExpiresAtMs: now + 60 * 60_000,
      settings,
    });
  };
  return {
    settings,
    session,
    uploadReceipt,
    uploadForOperation,
    projectId,
    operationKey,
    ownerKey,
    projectOwnerCapability: identity.projectOwnerCapability,
    runs,
    ledger,
  };
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

  it("admits only one active billable generation for a signed project and upload operation", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = (runId: string) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    const [first, competing] = await Promise.all([
      start("generation-exclusive-a"),
      start("generation-exclusive-b"),
    ]);

    expect([first.status, competing.status].sort()).toEqual([201, 409]);
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);
    const acceptedRunId = first.status === 201
      ? "generation-exclusive-a"
      : "generation-exclusive-b";
    await expect(start(acceptedRunId)).resolves.toMatchObject({ status: 200 });
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);
  });

  it("keeps the active project fence across session renewal while isolating another browser with the same project id", async () => {
    const ownerCapability = "1".repeat(64);
    const otherOwnerCapability = "2".repeat(64);
    const firstSession = await setup({ sessionId: "owner-renewal-one", projectOwnerCapability: ownerCapability });
    const renewedSession = await setup({ sessionId: "owner-renewal-two", projectOwnerCapability: ownerCapability });
    const anotherBrowser = await setup({ sessionId: "owner-isolated", projectOwnerCapability: otherOwnerCapability });
    // All three fixtures intentionally use the same client-generated project id.
    const sharedRuns = firstSession.runs;
    const sharedLedger = firstSession.ledger;
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: sharedLedger, runs: sharedRuns, workflow });
    const start = (fixture: Awaited<ReturnType<typeof setup>>, runId: string) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
        "x-cuebench-project-owner": fixture.projectOwnerCapability ?? "",
      },
      body: JSON.stringify({
        projectId: "generation-project",
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    expect((await start(firstSession, "generation-owner-first")).status).toBe(201);
    // A renewed anonymous session with the same browser capability sees the
    // existing project lease rather than escaping it.
    expect((await start(renewedSession, "generation-owner-renewed")).status).toBe(409);
    // A different browser may legitimately generate for its independently
    // owned local project even when a malicious/accidental projectId collides.
    expect((await start(anotherBrowser, "generation-owner-isolated")).status).toBe(201);
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(2);
  });

  it("releases the project lease only after a durable terminal cancellation, while retaining same-run idempotency", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = (runId: string, uploadReceipt = fixture.uploadReceipt) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    const first = await start("generation-terminal-release-a");
    expect(first.status).toBe(201);
    const firstReceipt = (await first.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    // A same-run retry is a recovery read, not a second lease, quota entry,
    // or Workflow dispatch.
    await expect(start("generation-terminal-release-a")).resolves.toMatchObject({ status: 200 });
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);

    const cancelled = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-terminal-release-a", {
      method: "DELETE",
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": firstReceipt },
    }));
    expect(cancelled.status).toBe(200);

    // The original upload operation is terminal/cleaned. A new upload
    // operation for the same signed project may now own the one active lease.
    const nextUpload = await fixture.uploadForOperation("generation-operation-after-terminal");
    await expect(start("generation-terminal-release-b", nextUpload)).resolves.toMatchObject({ status: 201 });
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(2);
  });

  it("persists a replacement attempt for an errored Workflow and never treats a completed duplicate as live", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async ({ workflowAttempt }) => {
        if (workflowAttempt === 1) throw new GenerationWorkflowInstanceTerminalError("errored");
      }),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = async (runId: string) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    const replaced = await start("generation-workflow-replacement");
    expect(replaced.status).toBe(201);
    expect(workflow.startCaptionGeneration).toHaveBeenNthCalledWith(1, expect.objectContaining({ workflowAttempt: 1 }));
    expect(workflow.startCaptionGeneration).toHaveBeenNthCalledWith(2, expect.objectContaining({ workflowAttempt: 2 }));
    await expect(fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-workflow-replacement" })).resolves.toMatchObject({
      workflowAttempt: 2,
      dispatched: true,
      status: { stage: "Queued" },
    });

    const completeFixture = await setup();
    const completeWorkflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => { throw new GenerationWorkflowInstanceTerminalError("complete"); }),
      cancelCaptionGeneration: vi.fn(async () => undefined),
    };
    const completeApp = createGenerationRoutes(env, { clock: () => now, quotaLedger: completeFixture.ledger, runs: completeFixture.runs, workflow: completeWorkflow });
    const completedWithoutRecord = await completeApp.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${completeFixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": completeFixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: completeFixture.projectId,
        runId: "generation-workflow-complete-without-stage",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));
    expect(completedWithoutRecord.status).toBe(201);
    expect(await completedWithoutRecord.json()).toMatchObject({ status: { stage: "Failed", retryable: true } });
    await expect(completeFixture.runs.load({ operationKey: completeFixture.operationKey, runId: "generation-workflow-complete-without-stage" })).resolves.toMatchObject({
      dispatched: true,
      status: { stage: "Failed", code: "GENERATION_STAGE_FAILED", retryable: true },
    });
    const retry = await completeApp.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${completeFixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": completeFixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: completeFixture.projectId,
        runId: "generation-workflow-complete-without-stage",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));
    expect(retry.status).toBe(200);
    expect(completeWorkflow.startCaptionGeneration).toHaveBeenCalledTimes(2);
  });

  it("accepts a duplicate Workflow only while its binding reports a live status", async () => {
    const create = vi.fn(async () => { throw new Error("duplicate instance"); });
    for (const liveStatus of ["queued", "running", "waiting", "paused"]) {
      const binding = {
        create,
        get: vi.fn(async () => ({ status: async () => ({ status: liveStatus }) })),
      } as unknown as NonNullable<WorkerEnv["PROCESSING_WORKFLOW"]>;
      const workflow = bindingWorkflow(binding);
      if (workflow === undefined) throw new Error("expected Workflow binding adapter");
      await expect(workflow.startCaptionGeneration({
        operationKey: digest(liveStatus),
        runId: `generation-binding-live-${liveStatus}`,
        receipt: "receipt",
        uploadReceipt: "upload",
      })).resolves.toBeUndefined();
    }

    for (const terminalStatus of ["errored", "terminated", "complete", "unknown"]) {
      const binding = {
        create,
        get: vi.fn(async () => ({ status: async () => ({ status: terminalStatus }) })),
      } as unknown as NonNullable<WorkerEnv["PROCESSING_WORKFLOW"]>;
      const workflow = bindingWorkflow(binding);
      if (workflow === undefined) throw new Error("expected Workflow binding adapter");
      await expect(workflow.startCaptionGeneration({
        operationKey: digest(terminalStatus),
        runId: `generation-binding-terminal-${terminalStatus}`,
        receipt: "receipt",
        uploadReceipt: "upload",
      })).rejects.toMatchObject({ name: "GenerationWorkflowInstanceTerminalError", workflowStatus: terminalStatus });
    }
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
      // The route now takes a durable project lease before it reserves quota.
      // This deliberately tiny fixture models the same-run recovery path; the
      // CAS behavior itself is exercised against both the in-memory store and
      // real R2 below.
      acquireActiveLease: async ({ sessionKey, projectKey, operationKey, runId, expiresAtMs, nowMs }) => ({
        kind: "acquired",
        lease: { version: 1, sessionKey, projectKey, operationKey, runId, state: "active", expiresAtMs, updatedAtMs: nowMs },
      }),
      releaseActiveLease: async () => undefined,
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

  it("scopes the active project fence to the authenticated anonymous owner", async () => {
    const owner = await setup();
    const otherOwner = await setup({ sessionId: "generation-session-other" });
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: owner.ledger, runs: owner.runs, workflow });
    const request = (session: string, uploadReceipt: string, runId: string) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
      },
      body: JSON.stringify({
        projectId: owner.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    expect((await request(owner.session, owner.uploadReceipt, "generation-owner-fence-a")).status).toBe(201);
    // The same portable project id under a different anonymous owner must
    // have an independent server-side lease namespace.
    expect((await request(otherOwner.session, otherOwner.uploadReceipt, "generation-owner-fence-b")).status).toBe(201);
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(2);
  });

  it("preserves a staged AwaitingAdoption result when a dispatch-flag save response is lost", async () => {
    const fixture = await setup();
    const backing = new InMemoryGenerationRunRecordStore();
    let loseDispatchSave = true;
    const runs: GenerationRunRecordStore = {
      load: backing.load.bind(backing),
      save: async (record) => {
        if (loseDispatchSave && record.dispatched) {
          loseDispatchSave = false;
          throw new Error("lost dispatched save response");
        }
        await backing.save(record);
      },
      cleanup: backing.cleanup.bind(backing),
      acquireActiveLease: backing.acquireActiveLease.bind(backing),
      releaseActiveLease: backing.releaseActiveLease.bind(backing),
    };
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async ({ operationKey, runId }) => {
        const record = await backing.load({ operationKey, runId });
        if (record === null) throw new Error("expected durable record before Workflow dispatch");
        await backing.save({
          ...record,
          status: { ...record.status, stage: "AwaitingAdoption" },
          stagedResult: stagedResult({
            runId,
            projectId: record.claims.projectId,
            expectedProjectRevision: record.claims.expectedProjectRevision,
            expectedQualityProfileRevision: record.claims.expectedQualityProfileRevision,
          }),
          updatedAtMs: now + 1,
        });
      }),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs, workflow });
    const start = () => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "generation-lost-dispatch-save",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    expect((await start()).status).toBe(503);
    const recovered = await start();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(expect.objectContaining({ status: expect.objectContaining({ stage: "AwaitingAdoption" }) }));
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);
    await expect(backing.load({ operationKey: fixture.operationKey, runId: "generation-lost-dispatch-save" })).resolves.toMatchObject({
      status: { stage: "AwaitingAdoption" },
      stagedResult: expect.objectContaining({ runId: "generation-lost-dispatch-save" }),
    });
  });

  it("restarts a durable retryable workflow failure without releasing its project lease", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async ({ workflowAttempt }) => {
        if (workflowAttempt === 1) throw new GenerationWorkflowInstanceTerminalError("complete");
      }),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = (runId: string, uploadReceipt = fixture.uploadReceipt) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    const first = await start("generation-retryable-failure");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual(expect.objectContaining({ status: expect.objectContaining({ stage: "Failed", retryable: true }) }));
    const retry = await start("generation-retryable-failure");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(expect.objectContaining({ status: expect.objectContaining({ stage: "Queued" }) }));
    expect(workflow.startCaptionGeneration).toHaveBeenNthCalledWith(2, expect.objectContaining({ workflowAttempt: 2 }));
    const otherUpload = await fixture.uploadForOperation("generation-retryable-failure-other-operation");
    expect((await start("generation-retryable-failure-other", otherUpload)).status).toBe(409);
  });

  it("makes an exhausted retryable workflow failure terminal and releases its durable project lease", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => { throw new GenerationWorkflowInstanceTerminalError("complete"); }),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const start = (runId: string, uploadReceipt = fixture.uploadReceipt) => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId,
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await start("generation-exhausted-retry");
      expect(await response.json()).toEqual(expect.objectContaining({
        status: expect.objectContaining({ stage: "Failed", retryable: true }),
      }));
    }
    const exhausted = await start("generation-exhausted-retry");
    expect(exhausted.status).toBe(200);
    expect(await exhausted.json()).toEqual(expect.objectContaining({
      status: expect.objectContaining({ stage: "Failed", retryable: false }),
    }));

    const otherUpload = await fixture.uploadForOperation("generation-exhausted-retry-next-operation");
    expect((await start("generation-after-exhaustion", otherUpload)).status).toBe(201);
  });

  it("reconciles a dispatched nonterminal binding on status polling and exposes a retryable terminal failure", async () => {
    const fixture = await setup();
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      reconcileCaptionGeneration: vi.fn(async () => { throw new GenerationWorkflowInstanceTerminalError("complete"); }),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs: fixture.runs, workflow });
    const started = await app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "generation-polled-terminal-instance",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));
    const receipt = (await started.json() as { readonly generationRunReceipt: string }).generationRunReceipt;
    const polled = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-polled-terminal-instance", {
      headers: { authorization: `Bearer ${fixture.session}`, "x-cuebench-generation-receipt": receipt },
    }));

    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({ status: expect.objectContaining({ stage: "Failed", retryable: true }) });
    expect(workflow.reconcileCaptionGeneration).toHaveBeenCalledWith(expect.objectContaining({ runId: "generation-polled-terminal-instance", workflowAttempt: 1 }));
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);
  });

  it("releases an authoritatively absent initial record lease instead of claiming dispatch pending", async () => {
    const fixture = await setup();
    const backing = new InMemoryGenerationRunRecordStore();
    let rejectInitialSave = true;
    const releaseActiveLease = vi.fn(backing.releaseActiveLease.bind(backing));
    const runs: GenerationRunRecordStore = {
      load: backing.load.bind(backing),
      save: async (record) => {
        if (rejectInitialSave) {
          rejectInitialSave = false;
          throw new Error("initial persistence unavailable");
        }
        await backing.save(record);
      },
      cleanup: backing.cleanup.bind(backing),
      acquireActiveLease: backing.acquireActiveLease.bind(backing),
      releaseActiveLease,
    };
    const workflow: GenerationWorkflowControl = {
      startCaptionGeneration: vi.fn(async () => undefined),
      cancelCaptionGeneration: async () => undefined,
    };
    const app = createGenerationRoutes(env, { clock: () => now, quotaLedger: fixture.ledger, runs, workflow });
    const request = () => app.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "generation-initial-save-absence",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));

    const failed = await request();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: expect.objectContaining({ code: "GENERATION_RECORD_UNAVAILABLE" }) });
    expect(releaseActiveLease).toHaveBeenCalledWith(expect.objectContaining({ runId: "generation-initial-save-absence" }));
    expect(workflow.startCaptionGeneration).not.toHaveBeenCalled();
    expect((await request()).status).toBe(201);
  });
});
