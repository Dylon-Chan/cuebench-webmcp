import { describe, expect, it, vi } from "vitest";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
import { createGenerationRoutes, InMemoryGenerationRunRecordStore, type GenerationWorkflowControl } from "./generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "./env";
import { InMemoryQuotaLedger, saltedLedgerKey } from "./quota-ledger";
import { issueAnonymousSession } from "./session";
import { issueUploadReceipt } from "./uploads";

const now = 1_700_000_000_000;
const digest = (character: string): string => character.repeat(64);
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
    media: { byteLength: 5, durationMs: 31_000, contentType: "video/webm" },
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
        qualityProfileRules: { caption: { maxLineLength: 36, maxLineCount: 2 } },
      }),
    }));

    expect(start.status).toBe(201);
    expect(persistedBeforeDispatch).toBe(true);
    expect((await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-run" }))?.qualityProfileRules).toEqual({
      caption: { maxLineLength: 36, maxLineCount: 2 },
    });
    const body = await start.json() as { readonly generationRunReceipt: string; readonly status: { readonly stage: string } };
    expect(body.status.stage).toBe("Queued");
    expect(body.generationRunReceipt).toMatch(/\./);
    expect(workflow.startCaptionGeneration).toHaveBeenCalledTimes(1);

    const status = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-run", {
      headers: { "x-cuebench-generation-receipt": body.generationRunReceipt },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: expect.objectContaining({ stage: "Queued", runId: "generation-run" }) });
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
      body: JSON.stringify({ projectId: fixture.projectId, runId: "generation-cancel", expectedProjectRevision: 2, expectedQualityProfileRevision: 1, mediaSha256: "a".repeat(64), qualityProfileRules: { caption: { maxLineLength: 36 } } }),
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
      headers: { "x-cuebench-generation-receipt": receipt },
    }));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ status: expect.objectContaining({ stage: "Cancelled" }) });
    expect(workflow.cancelCaptionGeneration).toHaveBeenCalledTimes(1);
    // Model an in-flight worker committing its stale, already-staged snapshot
    // after DELETE. The record store must let cancellation win permanently.
    await fixture.runs.save(staleWorkerSnapshot);
    expect(await fixture.runs.load({ operationKey: fixture.operationKey, runId: "generation-cancel" })).toMatchObject({
      cancelled: true,
      status: { stage: "Cancelled" },
    });
    const staged = await app.fetch(new Request("https://cuebench.test/api/generation-runs/generation-cancel/staged-result", {
      headers: { "x-cuebench-generation-receipt": receipt },
    }));
    expect(staged.status).toBe(409);
  });
});
