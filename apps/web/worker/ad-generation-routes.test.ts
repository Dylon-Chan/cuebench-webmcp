import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAudioDescriptionGenerationRunRecordStore,
  createAudioDescriptionGenerationRoutes,
  issueAudioDescriptionGenerationRunReceipt,
  type AudioDescriptionGenerationWorkflowControl,
} from "./ad-generation-routes";
import { createGenerationRoutes, InMemoryGenerationRunRecordStore } from "./generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "./env";
import { InMemoryQuotaLedger, saltedLedgerKey } from "./quota-ledger";
import { canonicalHash } from "@cuebench/domain";
import { issueAnonymousSession } from "./session";
import { issueUploadReceipt } from "./uploads";
import { reserveAudioDescriptionWindowSpend } from "./workflows/audio-description-generation";

const now = 1_700_000_000_000;
const digest = (character: string): string => character.repeat(64);
const sourceByteLength = 5;
const sourceDurationMs = 31_000;
const ownerCapability = "a".repeat(64);
const env: WorkerEnv = {
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-ad-generation-routes-fixture-32-bytes",
  QUOTA_SALT: "ad-generation-routes-quota-salt-fixture-32-bytes",
  TURNSTILE_SECRET: "ad-generation-routes-turnstile-secret-fixture-32-bytes",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
};

const projection = (projectId: string) => ({
  contractVersion: 1 as const,
  projectId,
  expectedProjectRevision: 2,
  expectedQualityProfileRevision: 1,
  mediaSha256: digest("a"),
  localEvidencePackageIds: ["generation-caption-run-1"],
  captions: [{
    itemId: "c01",
    itemRevision: 1,
    state: "Sustained" as const,
    startMs: 1_000,
    endMs: 3_000,
    text: "Dr. Nguyen introduces the energy diagram.",
    evidenceIds: ["word-1"],
  }],
  evidence: [{ evidenceId: "word-1", itemId: "c01", itemRevision: 1, startMs: 1_000, endMs: 1_500 }],
});

const projectionHash = (value: ReturnType<typeof projection>): string =>
  canonicalHash("cuebench.audio-description.caption-evidence.v1", value).slice("sha256:".length);

const setup = async () => {
  const settings = resolveWorkerSettings(env);
  const projectId = "ad-generation-project";
  const sessionId = "ad-generation-session";
  const operationId = "ad-generation-operation";
  const [sessionKey, ownerKey, projectKey, ipKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "session", sessionId),
    saltedLedgerKey(settings.quotaSalt, "project-owner", ownerCapability),
    saltedLedgerKey(settings.quotaSalt, "project", projectId),
    saltedLedgerKey(settings.quotaSalt, "network", "203.0.113.8"),
  ]);
  const [operationKey, reservationKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "operation", `${ownerKey}:${operationId}`),
    saltedLedgerKey(settings.quotaSalt, "reservation", `${ownerKey}:${operationId}`),
  ]);
  const session = await issueAnonymousSession({ sessionId, issuedAtMs: now, expiresAtMs: now + 60 * 60_000, keyRing: settings.keyRing });
  const uploadReceipt = await issueUploadReceipt({
    sessionId,
    sessionKey,
    ownerKey,
    ipKey,
    operationId,
    operationKey,
    projectKey,
    reservationKey,
    metadataHash: digest("f"),
    objectKey: `processing/${ownerKey}/${operationKey}`,
    media: { byteLength: sourceByteLength, durationMs: sourceDurationMs, contentType: "video/webm" },
    partSize: 5,
    partCount: 1,
    issuedAtMs: now,
    receiptExpiresAtMs: now + 60 * 60_000,
    settings,
  });
  const runs = new InMemoryAudioDescriptionGenerationRunRecordStore();
  const leases = new InMemoryGenerationRunRecordStore();
  const ledger = new InMemoryQuotaLedger();
  const dispatch = vi.fn<AudioDescriptionGenerationWorkflowControl["startAudioDescriptionGeneration"]>(async () => undefined);
  const app = createAudioDescriptionGenerationRoutes(env, {
    clock: () => now,
    quotaLedger: ledger,
    runs,
    leases,
    workflow: { startAudioDescriptionGeneration: dispatch, cancelAudioDescriptionGeneration: async () => undefined },
  });
  const request = (overrides: Record<string, unknown> = {}) => {
    const evidence = projection(projectId);
    return new Request("https://cuebench.test/api/audio-description-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": uploadReceipt,
        "x-cuebench-project-owner": ownerCapability,
      },
      body: JSON.stringify({
        projectId,
        runId: "ad-generation-run",
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
        captionEvidenceProjection: evidence,
        captionEvidenceHash: projectionHash(evidence),
        ...overrides,
      }),
    });
  };
  return { app, request, dispatch, ledger, runs, leases, session, uploadReceipt, sessionKey, ownerKey, projectKey, operationKey, projectId };
};

describe("audio-description generation routes", () => {
  it("reserves one idempotent conservative hold before a window provider call and fails closed on rejection", async () => {
    const ledger = new InMemoryQuotaLedger();
    const claims = { operationKey: "a".repeat(64), runId: "ad-run-spend" };
    const first = await reserveAudioDescriptionWindowSpend({
      ledger,
      claims,
      windowId: "ad-window-1",
      maxCents: 3,
      globalSpendLimitCents: 10,
      nowMs: now,
    });
    await expect(reserveAudioDescriptionWindowSpend({
      ledger,
      claims,
      windowId: "ad-window-1",
      maxCents: 3,
      globalSpendLimitCents: 10,
      nowMs: now + 1,
    })).resolves.toBe(first);
    await expect(reserveAudioDescriptionWindowSpend({
      ledger,
      claims,
      windowId: "ad-window-2",
      maxCents: 8,
      globalSpendLimitCents: 10,
      nowMs: now + 2,
    })).rejects.toThrow(/spend limit/i);
  });

  it("binds a bounded caption-evidence projection into a signed receipt and persists it before dispatch", async () => {
    const fixture = await setup();
    let persistedBeforeDispatch = false;
    fixture.dispatch.mockImplementationOnce(async ({ operationKey, runId }) => {
      persistedBeforeDispatch = (await fixture.runs.load({ operationKey, runId })) !== null;
    });

    const response = await fixture.app.fetch(fixture.request());

    expect(response.status).toBe(201);
    const body = await response.json() as { readonly audioDescriptionGenerationReceipt: string };
    expect(body.audioDescriptionGenerationReceipt).toEqual(expect.any(String));
    expect(persistedBeforeDispatch).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runId: "ad-generation-run" }));
  });

  it("uses a renewed current session for authorization without invalidating the upload receipt's stable ownership binding", async () => {
    const fixture = await setup();
    const settings = resolveWorkerSettings(env);
    const renewedSessionId = "ad-generation-renewed-session";
    const renewedSession = await issueAnonymousSession({
      sessionId: renewedSessionId,
      issuedAtMs: now,
      expiresAtMs: now + 60 * 60_000,
      keyRing: settings.keyRing,
    });
    const original = fixture.request();
    const headers = new Headers(original.headers);
    headers.set("authorization", `Bearer ${renewedSession}`);
    const renewedRequest = new Request(original.url, {
      method: original.method,
      headers,
      body: await original.text(),
    });

    const response = await fixture.app.fetch(renewedRequest);

    expect(response.status).toBe(201);
    const renewedSessionKey = await saltedLedgerKey(settings.quotaSalt, "session", renewedSessionId);
    expect((await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" }))?.claims.sessionKey)
      .toBe(renewedSessionKey);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbound caption-evidence projection before reserving anonymous generation quota", async () => {
    const fixture = await setup();
    const reserve = vi.spyOn(fixture.ledger, "reserveGeneration");
    const bad = await fixture.app.fetch(fixture.request({ captionEvidenceHash: digest("f") }));

    expect(bad.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("keeps one global project lease across caption and AD targets, without charging or dispatching a duplicate retry", async () => {
    const fixture = await setup();
    await fixture.leases.acquireActiveLease({
      sessionKey: fixture.sessionKey,
      ownerKey: fixture.ownerKey,
      projectKey: fixture.projectKey,
      operationKey: "b".repeat(64),
      runId: "caption-run",
      targetTrack: "Captions",
      expiresAtMs: now + 60_000,
      nowMs: now,
    });
    const conflict = await fixture.app.fetch(fixture.request());
    expect(conflict.status).toBe(409);
    expect(fixture.dispatch).not.toHaveBeenCalled();

    await fixture.leases.releaseActiveLease({
      sessionKey: fixture.sessionKey,
      ownerKey: fixture.ownerKey,
      projectKey: fixture.projectKey,
      operationKey: "b".repeat(64),
      runId: "caption-run",
      targetTrack: "Captions",
      nowMs: now,
    });
    expect((await fixture.app.fetch(fixture.request())).status).toBe(201);
    expect((await fixture.app.fetch(fixture.request())).status).toBe(200);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reopens only its exact cleanup inventory when a terminal race writes a late immutable checkpoint", async () => {
    const fixture = await setup();
    expect((await fixture.app.fetch(fixture.request())).status).toBe(201);
    const claims = (await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" }))!.claims;

    const firstClaim = await fixture.runs.claimWindowProviderCall({ claims, windowId: "ad-window-1", nowMs: now });
    expect(firstClaim.kind).toBe("claimed");
    if (firstClaim.kind !== "claimed") throw new Error("Fixture should claim its first provider attempt.");
    expect(await fixture.runs.completeWindow({
      claims,
      windowId: "ad-window-1",
      attemptId: firstClaim.attemptId,
      value: { version: 1, provider: { value: { proposals: [] } }, startedAtMs: now, completedAtMs: now + 1 },
      nowMs: now + 1,
    })).not.toBeNull();
    await fixture.runs.terminal({ claims, action: "cancelled", nowMs: now + 2 });
    const firstCleanup = await fixture.runs.cleanup({ claims, action: "cancelled", nowMs: now + 2 });
    expect(firstCleanup?.cleanup?.state).toBe("completed");
    expect(firstCleanup?.cleanup?.artifactKeys).toContain(claims.objectKey);
    expect(firstCleanup).toMatchObject({ contentRedacted: true, receipt: "redacted", uploadReceipt: "redacted" });

    // This simulates a provider response that was persisted just after the
    // user cancelled. It cannot revive the run, but its exact key must remain
    // visible to a bounded follow-up cleanup.
    expect(await fixture.runs.completeWindow({
      claims,
      windowId: "ad-window-2",
      attemptId: "ad-window-2-a1",
      value: { version: 1, provider: { value: { proposals: [] } }, startedAtMs: now, completedAtMs: now + 3 },
      nowMs: now + 3,
    })).toBeNull();
    const pending = await fixture.runs.load(claims);
    expect(pending?.cleanup).toMatchObject({ state: "pending", action: "cancelled" });
    // Source + first checkpoint + late checkpoint: each remains an exact
    // inventory entry, never a broad private-media prefix delete.
    expect(pending?.cleanup?.artifactKeys).toHaveLength(3);

    const completed = await fixture.runs.cleanup({ claims, action: "cancelled", nowMs: now + 4 });
    expect(completed?.cleanup).toMatchObject({ state: "completed", action: "cancelled" });
    expect(completed?.cleanup?.artifactKeys).toHaveLength(3);
    expect(completed?.contentRedacted).toBe(true);
  });

  it("atomically reclaims a known-429 window with a new attempt and never regresses completion", async () => {
    const fixture = await setup();
    expect((await fixture.app.fetch(fixture.request())).status).toBe(201);
    const claims = (await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" }))!.claims;
    const first = await fixture.runs.claimWindowProviderCall({ claims, windowId: "ad-window-retry", nowMs: now });
    if (first.kind !== "claimed") throw new Error("Fixture should claim attempt one.");
    await fixture.runs.markWindowRetryableFailure({
      claims,
      windowId: "ad-window-retry",
      attemptId: first.attemptId,
      nowMs: now + 1,
    });
    const second = await fixture.runs.claimWindowProviderCall({ claims, windowId: "ad-window-retry", nowMs: now + 2 });
    if (second.kind !== "claimed") throw new Error("Known 429 must durably claim attempt two before replay.");
    expect(second.attemptId).not.toBe(first.attemptId);
    await fixture.runs.markWindowAcceptedUnknown({
      claims,
      windowId: "ad-window-retry",
      attemptId: first.attemptId,
      nowMs: now + 3,
    });
    expect(await fixture.runs.completeWindow({
      claims,
      windowId: "ad-window-retry",
      attemptId: second.attemptId,
      value: { version: 1, provider: { value: { proposals: [] } }, startedAtMs: now + 2, completedAtMs: now + 4 },
      nowMs: now + 4,
    })).not.toBeNull();
    await fixture.runs.markWindowAcceptedUnknown({
      claims,
      windowId: "ad-window-retry",
      attemptId: second.attemptId,
      nowMs: now + 5,
    });
    expect((await fixture.runs.load(claims))?.windowCheckpoints["ad-window-retry"]).toMatchObject({
      state: "completed",
      attemptId: second.attemptId,
    });
  });

  it("starts one new Workflow attempt only for a retained safe AD provider failure", async () => {
    const fixture = await setup();
    const generationReservations = vi.spyOn(fixture.ledger, "reserveGeneration");
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "must be replaced by a static worker category",
        retryable: true,
      },
      dispatched: true,
      windowCheckpoints: {
        "ad-window-safe": { state: "retryable-failed", attempt: 2, attemptId: "ad-window-safe-a2", updatedAtMs: now + 1 },
      },
      updatedAtMs: now + 1,
    });
    const retry = () => fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run/retry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "x-cuebench-audio-description-receipt": receipt,
        "x-cuebench-project-owner": ownerCapability,
      },
    }));

    const response = await retry();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: expect.objectContaining({ stage: "Queued" }) });
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      runId: "ad-generation-run",
      workflowAttempt: 2,
    }));
    // Retrying a retained run does not reacquire anonymous generation quota;
    // provider-window spend is independently idempotent by run/window key.
    expect(generationReservations).toHaveBeenCalledTimes(1);
    expect((await fixture.runs.load(record.claims))?.workflowAttempt).toBe(2);

    // A lost response retry reads the same queued second attempt; it never
    // creates a third Workflow or replays a provider call.
    expect((await retry()).status).toBe(200);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);

    // A terminal cleanup that races a stale first Workflow can never be
    // regressed into a queued second attempt or dispatch a third instance.
    await fixture.runs.terminal({ claims: record.claims, action: "cancelled", nowMs: now + 2 });
    await fixture.runs.cleanup({ claims: record.claims, action: "cancelled", nowMs: now + 2 });
    await fixture.runs.save({
      ...record,
      status: { ...record.status, stage: "Queued" },
      workflowAttempt: 1,
      dispatched: true,
      updatedAtMs: now + 3,
    });
    const terminal = await fixture.runs.load(record.claims);
    expect(terminal).toMatchObject({
      cancelled: true,
      status: { stage: "Cancelled" },
      cleanup: { state: "completed", action: "cancelled" },
    });
    // The verified receipt can cross the marker-bound redacted repair path,
    // but terminal cleanup still never exposes another retry.
    expect((await retry()).status).toBe(409);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(generationReservations).toHaveBeenCalledTimes(1);
  });

  it("retains the shared project lease across a retryable AD status poll and verifies ownership before its one safe retry", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");

    // Model an interrupted retryable Workflow failure from the prior release:
    // a status poll must not turn this safe recovery state into a released
    // shared project lease before the person decides whether to retry.
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "static category only",
        retryable: true,
      },
      dispatched: true,
      leaseReleasePending: true,
      windowCheckpoints: {
        "ad-window-safe": { state: "retryable-failed", attempt: 1, attemptId: "ad-window-safe-a1", updatedAtMs: now + 1 },
      },
      updatedAtMs: now + 1,
    });

    const headers = {
      authorization: `Bearer ${fixture.session}`,
      "x-cuebench-audio-description-receipt": receipt,
      "x-cuebench-project-owner": ownerCapability,
    };
    expect((await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", { headers }))).status).toBe(200);
    expect((await fixture.runs.load(record.claims))?.leaseReleasePending).toBeUndefined();

    // Both target families must observe the same active lease after polling.
    expect((await fixture.app.fetch(fixture.request({ runId: "competing-ad-run" }))).status).toBe(409);
    const captionApp = createGenerationRoutes(env, {
      clock: () => now,
      quotaLedger: fixture.ledger,
      runs: fixture.leases,
      workflow: {
        startCaptionGeneration: async () => undefined,
        cancelCaptionGeneration: async () => undefined,
      },
    });
    const captionConflict = await captionApp.fetch(new Request("https://cuebench.test/api/generation-runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-operation-receipt": fixture.uploadReceipt,
        "x-cuebench-project-owner": ownerCapability,
      },
      body: JSON.stringify({
        projectId: fixture.projectId,
        runId: "competing-caption-run",
        expectedProjectRevision: 2,
        expectedQualityProfileRevision: 1,
        mediaSha256: digest("a"),
        sourceByteLength,
        sourceDurationMs,
      }),
    }));
    expect(captionConflict.status).toBe(409);

    const retry = await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run/retry", {
      method: "POST",
      headers,
    }));
    expect(retry.status).toBe(202);
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ workflowAttempt: 2 }));
  });

  it("turns an exhausted safe AD retry into terminal cleanup before releasing the shared lease", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");

    // This is the second Workflow instance failing before the provider can
    // accept a request. It is safe in isolation, but the one bounded retry
    // has already been consumed, so it must become terminal—not keep the
    // project lease and an impossible Retry UI forever.
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "static category only",
        retryable: true,
      },
      workflowAttempt: 2,
      dispatched: true,
      leaseReleasePending: true,
      windowCheckpoints: {
        "ad-window-safe": { state: "retryable-failed", attempt: 2, attemptId: "ad-window-safe-a2", updatedAtMs: now + 1 },
      },
      updatedAtMs: now + 1,
    });

    const headers = {
      authorization: `Bearer ${fixture.session}`,
      "x-cuebench-audio-description-receipt": receipt,
      "x-cuebench-project-owner": ownerCapability,
    };
    const status = await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", { headers }));
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual(expect.objectContaining({
      status: expect.objectContaining({ stage: "Failed", retryable: false }),
    }));

    const terminal = await fixture.runs.load(record.claims);
    expect(terminal).toMatchObject({
      status: { stage: "Failed", retryable: false },
      cleanup: { state: "completed", action: "discarded" },
    });
    expect(terminal?.leaseReleasePending).toBeUndefined();
    await expect(fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).resolves.toBe(false);

    const retry = await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run/retry", {
      method: "POST",
      headers,
    }));
    // Exact cleanup redacts bearer material but the same verified claims can
    // still be checked against its tombstone. It remains non-replayable;
    // returning a terminal conflict is more truthful than pretending the
    // already-settled private run never existed.
    expect(retry.status).toBe(409);
  });

  it("releases the shared project lease only after non-retryable AD cleanup is terminal", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "static category only",
        retryable: false,
      },
      dispatched: true,
      leaseReleasePending: true,
      updatedAtMs: now + 1,
    });
    expect((await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", {
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "x-cuebench-audio-description-receipt": receipt,
        "x-cuebench-project-owner": ownerCapability,
      },
    }))).status).toBe(200);

    expect(await fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).toBe(false);
    await expect(fixture.leases.acquireActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: "b".repeat(64),
      runId: "caption-after-terminal-ad",
      targetTrack: "Captions",
      expiresAtMs: now + 60_000,
      nowMs: now,
    })).resolves.toMatchObject({ kind: "acquired" });
  });

  it("repairs a redacted terminal AD record after one transient shared-lease release failure", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "static category only",
        retryable: false,
      },
      leaseReleasePending: true,
      updatedAtMs: now + 1,
    });

    let releaseFailuresRemaining = 1;
    const repairApp = createAudioDescriptionGenerationRoutes(env, {
      clock: () => now,
      quotaLedger: fixture.ledger,
      runs: fixture.runs,
      leases: {
        acquireActiveLease: (input) => fixture.leases.acquireActiveLease(input),
        ownsActiveLease: (input) => fixture.leases.ownsActiveLease(input),
        releaseActiveLease: async (input) => {
          if (releaseFailuresRemaining > 0) {
            releaseFailuresRemaining -= 1;
            throw new Error("injected terminal lease release failure");
          }
          await fixture.leases.releaseActiveLease(input);
        },
      },
      workflow: {
        startAudioDescriptionGeneration: async () => undefined,
        cancelAudioDescriptionGeneration: async () => undefined,
      },
    });
    const headers = {
      authorization: `Bearer ${fixture.session}`,
      "x-cuebench-audio-description-receipt": receipt,
      "x-cuebench-project-owner": ownerCapability,
    };
    const status = () => repairApp.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", { headers }));

    // Exact cleanup commits and redacts the raw receipt before the separate
    // shared-lease CAS fails. The authenticated receipt must remain useful
    // only for this marker-bound repair, never be written back into storage.
    expect((await status()).status).toBe(200);
    expect(await fixture.runs.load(record.claims)).toMatchObject({
      receipt: "redacted",
      uploadReceipt: "redacted",
      contentRedacted: true,
      cleanup: { state: "completed", action: "discarded" },
      leaseReleasePending: true,
    });
    await expect(fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).resolves.toBe(true);

    expect((await status()).status).toBe(200);
    const repaired = await fixture.runs.load(record.claims);
    expect(repaired).toMatchObject({ receipt: "redacted", uploadReceipt: "redacted", contentRedacted: true });
    expect(repaired).not.toHaveProperty("leaseReleasePending");
    await expect(fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).resolves.toBe(false);
    await expect(fixture.leases.acquireActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: "f".repeat(64),
      runId: "caption-after-ad-lease-repair",
      targetTrack: "Captions",
      expiresAtMs: now + 60_000,
      nowMs: now,
    })).resolves.toMatchObject({ kind: "acquired" });
  });

  it("keeps a redacted cancellation idempotent and pending until its shared server lease settles", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");
    let releaseFailuresRemaining = 1;
    const repairApp = createAudioDescriptionGenerationRoutes(env, {
      clock: () => now,
      quotaLedger: fixture.ledger,
      runs: fixture.runs,
      leases: {
        acquireActiveLease: (input) => fixture.leases.acquireActiveLease(input),
        ownsActiveLease: (input) => fixture.leases.ownsActiveLease(input),
        releaseActiveLease: async (input) => {
          if (releaseFailuresRemaining > 0) {
            releaseFailuresRemaining -= 1;
            throw new Error("injected cancellation lease CAS failure");
          }
          await fixture.leases.releaseActiveLease(input);
        },
      },
      workflow: { startAudioDescriptionGeneration: async () => undefined, cancelAudioDescriptionGeneration: async () => undefined },
    });
    const headers = {
      authorization: `Bearer ${fixture.session}`,
      "x-cuebench-audio-description-receipt": receipt,
      "x-cuebench-project-owner": ownerCapability,
    };
    const cancellation = () => repairApp.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", { method: "DELETE", headers }));
    const status = () => repairApp.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", { headers }));

    const first = await cancellation();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      status: { stage: "Cancelled" },
      cleanup: { state: "pending", action: "cancelled" },
    });
    await expect(fixture.runs.load(record.claims)).resolves.toMatchObject({
      receipt: "redacted",
      contentRedacted: true,
      cleanup: { state: "completed", action: "cancelled" },
      leaseReleasePending: true,
    });
    await expect(fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).resolves.toBe(true);

    // A reconnect commonly polls status first. It settles the independent
    // server-side lease but must not erase the exact signed cancellation's
    // idempotent action path.
    const reconciledStatus = await status();
    expect(reconciledStatus.status).toBe(200);
    await expect(reconciledStatus.json()).resolves.toMatchObject({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed", action: "cancelled" },
    });
    const repairedCancellation = await fixture.runs.load(record.claims);
    expect(repairedCancellation).toMatchObject({ receipt: "redacted", uploadReceipt: "redacted", contentRedacted: true });
    expect(repairedCancellation).not.toHaveProperty("leaseReleasePending");
    await expect(fixture.leases.ownsActiveLease({
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      targetTrack: "AudioDescriptions",
      nowMs: now,
    })).resolves.toBe(false);

    // GET cleared the marker, then the browser repeats DELETE. The exact
    // signed claims/action still receive the same terminal answer without
    // re-persisting the private receipt.
    const second = await cancellation();
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed", action: "cancelled" },
    });
    const settings = resolveWorkerSettings(env);
    const wrongReceipt = await issueAudioDescriptionGenerationRunReceipt({
      runId: record.claims.runId,
      projectId: record.claims.projectId,
      targetTrack: record.claims.targetTrack,
      expectedProjectRevision: record.claims.expectedProjectRevision,
      expectedQualityProfileRevision: record.claims.expectedQualityProfileRevision,
      mediaSha256: record.claims.mediaSha256,
      captionEvidenceHash: record.claims.captionEvidenceHash,
      sessionKey: record.claims.sessionKey,
      ownerKey: record.claims.ownerKey,
      projectKey: record.claims.projectKey,
      sourceByteLength: record.claims.sourceByteLength,
      sourceDurationMs: record.claims.sourceDurationMs,
      operationId: "wrong-operation",
      operationKey: "f".repeat(64),
      objectKey: "processing/wrong-operation",
      issuedAtMs: record.claims.issuedAtMs,
      expiresAtMs: record.claims.expiresAtMs,
    }, settings);
    const wrong = await repairApp.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run", {
      method: "DELETE",
      headers: { ...headers, "x-cuebench-audio-description-receipt": wrongReceipt },
    }));
    expect(wrong.status).toBe(404);
  });

  it("refuses an accepted-unknown AD journal even when a stale status claims retryable", async () => {
    const fixture = await setup();
    const started = await fixture.app.fetch(fixture.request());
    const receipt = (await started.json() as { readonly audioDescriptionGenerationReceipt: string }).audioDescriptionGenerationReceipt;
    const record = await fixture.runs.load({ operationKey: fixture.operationKey, runId: "ad-generation-run" });
    if (record === null) throw new Error("Expected durable AD record.");
    await fixture.runs.save({
      ...record,
      status: {
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "GENERATION_STAGE_FAILED",
        message: "must be replaced by a static worker category",
        retryable: true,
      },
      dispatched: true,
      windowCheckpoints: {
        "ad-window-unknown": { state: "accepted-unknown", attempt: 1, attemptId: "ad-window-unknown-a1", updatedAtMs: now + 1 },
      },
      updatedAtMs: now + 1,
    });

    const response = await fixture.app.fetch(new Request("https://cuebench.test/api/audio-description-runs/ad-generation-run/retry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.session}`,
        "x-cuebench-audio-description-receipt": receipt,
        "x-cuebench-project-owner": ownerCapability,
      },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AD_GENERATION_RETRY_UNSAFE" } });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect((await fixture.runs.load(record.claims))?.workflowAttempt).toBe(1);
  });
});
