import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAudioDescriptionGenerationRunRecordStore,
  createAudioDescriptionGenerationRoutes,
  type AudioDescriptionGenerationWorkflowControl,
} from "./ad-generation-routes";
import { InMemoryGenerationRunRecordStore } from "./generation-routes";
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
  return { app, request, dispatch, ledger, runs, leases, sessionKey, ownerKey, projectKey, operationKey, projectId };
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
});
