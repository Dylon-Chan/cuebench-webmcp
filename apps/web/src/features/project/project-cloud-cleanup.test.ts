import "fake-indexeddb/auto";
import type { LocalCaptionEvidencePackage } from "@cuebench/contracts";
import { createProject } from "@cuebench/domain";
import { CueBenchDatabase, initializeProject } from "@cuebench/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectUrlLease } from "./local-media";
import { cleanupProjectCloudArtifacts } from "./project-cloud-cleanup";
import { ProjectStore } from "./project-store";
import { CaptionGenerationClient } from "../generation/generation-client";
import { AudioDescriptionGenerationClient, type AudioDescriptionGenerationReceipt } from "../generation/ad-generation-client";

const browserStorage = () => ({
  estimate: async () => ({ quota: 100_000_000, usage: 0 }),
  persist: async () => true,
});

const bundledFile = (): File => Object.assign(new Blob(["fixture-media"], { type: "video/mp4" }), {
  name: "fixture.mp4",
  lastModified: 0,
}) as File;

/** Installs the smallest retained caption-evidence package required by an AD lease. */
const adReadyProject = (project: ReturnType<typeof createProject>) => {
  const retainedEvidence: LocalCaptionEvidencePackage = {
    packageId: "late-start-caption-evidence",
    runId: "late-start-caption-run",
    projectId: project.projectId,
    mediaSha256: project.media.sha256,
    expectedProjectRevision: 1,
    expectedQualityProfileRevision: 1,
    retainedAtMs: 1_700_000_000_000,
    evidence: {
      contractVersion: 1,
      runId: "late-start-caption-run",
      projectId: project.projectId,
      mediaSha256: project.media.sha256,
      preparedManifest: { key: "prepared/manifest.json", sha256: "b".repeat(64) },
      normalizedAudio: { key: "prepared/audio.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: project.media.durationMs, contentType: "audio/wav" },
      words: [{ evidenceId: "late-start-word", sourceWordIndex: 0, startMs: 100, endMs: 300, text: "The", speaker: "Teacher", speakerSegmentIds: ["late-start-speaker"] }],
      speakerSegments: [{ id: "late-start-speaker", startMs: 100, endMs: 300, speaker: "Teacher", text: "The" }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: "late-start-caption", itemId: "late-start-caption", itemRevision: 1, evidenceIds: ["late-start-word"] }],
  };
  return createProject({
    projectId: project.projectId,
    title: project.title,
    media: project.media,
    captions: [{
      kind: "CaptionCue",
      itemId: "late-start-caption",
      state: "Sustained",
      startMs: 100,
      endMs: 600,
      text: "The teacher introduces the diagram.",
      speaker: "Teacher",
      actor: { type: "Human", id: "teacher" },
      cause: "fixture",
    }],
    evidence: [{ evidenceId: "late-start-word", projectId: project.projectId, mediaSha256: project.media.sha256, itemId: "late-start-caption", itemRevision: 1 }],
    localEvidencePackages: [retainedEvidence],
  });
};

/**
 * This is deliberately a real durable store, rather than an in-memory
 * generation-port double. Terminal browser recovery must release the same
 * IndexedDB project lease that prevents a competing caption/AD run.
 */
const openAdReadyProjectStore = async (databaseName: string): Promise<{
  readonly database: CueBenchDatabase;
  readonly store: ProjectStore;
  readonly project: ReturnType<typeof createProject>;
  readonly owner: string;
}> => {
  const database = new CueBenchDatabase(databaseName);
  const bootstrap = new ProjectStore({
    database,
    browserStorage: browserStorage(),
    objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:ad-terminal-bootstrap"), revokeObjectURL: vi.fn() }),
    bundledSampleLoader: bundledFile,
    mediaDurationProbe: async () => 90_000,
  });
  await bootstrap.openSample();
  const initial = bootstrap.getSnapshot().project;
  if (initial === null) throw new Error("Expected durable bootstrap project.");
  const evidenced = adReadyProject(initial);
  await database.transaction("rw", [
    database.projectHeaders,
    database.items,
    database.revisions,
    database.findings,
    database.evidence,
    database.courtRecord,
    database.certifications,
  ], async () => {
    await Promise.all([
      database.projectHeaders.delete(initial.projectId),
      database.items.where("projectId").equals(initial.projectId).delete(),
      database.revisions.where("projectId").equals(initial.projectId).delete(),
      database.findings.where("projectId").equals(initial.projectId).delete(),
      database.evidence.where("projectId").equals(initial.projectId).delete(),
      database.courtRecord.where("projectId").equals(initial.projectId).delete(),
      database.certifications.where("projectId").equals(initial.projectId).delete(),
    ]);
  });
  await initializeProject(database, evidenced);
  bootstrap.dispose();
  const store = new ProjectStore({
    database,
    browserStorage: browserStorage(),
    objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:ad-terminal"), revokeObjectURL: vi.fn() }),
  });
  await store.restoreLastDurableProject();
  const project = store.getSnapshot().project;
  if (project === null) throw new Error("Expected durable audio-description project.");
  const owner = await store.getCloudProjectOwnerCapability(project.projectId);
  if (owner === null) throw new Error("Expected durable browser-project owner.");
  return { database, store, project, owner };
};

const terminalAudioDescriptionResponse = (
  input: {
    readonly runId: string;
    readonly projectId: string;
    readonly expectedProjectRevision: number;
    readonly cleanup: "pending" | "completed";
    readonly atMs: number;
  },
): Response => Response.json({
  status: {
    contractVersion: 1,
    runId: input.runId,
    projectId: input.projectId,
    targetTrack: "AudioDescriptions",
    expectedProjectRevision: input.expectedProjectRevision,
    stage: "Cancelled",
  },
  cleanup: {
    version: 1,
    state: input.cleanup,
    action: "cancelled",
    artifactKeys: [],
    requestedAtMs: input.atMs,
    ...(input.cleanup === "completed" ? { completedAtMs: input.atMs + 1 } : {}),
  },
});

afterEach(() => vi.unstubAllGlobals());

const authorization = {
  version: 1 as const,
  ownerCapability: "a".repeat(64),
  expiresAtMs: 20_000,
  run: {
    targetTrack: "Captions" as const,
    runId: "caption-run-1",
    signedRunReceipt: "opaque-caption-receipt",
    session: "opaque-session",
  },
};

describe("project cloud cleanup", () => {
  it("uses the active run's exact receipt route and reports deleted only after the tombstone is complete", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: "caption-run-1",
      authorization,
      nowMs: 1_000,
      fetcher,
    })).resolves.toEqual({ status: "deleted", message: "CueBench confirmed private cloud cleanup." });
    expect(fetcher).toHaveBeenCalledWith("/api/generation-runs/caption-run-1", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer opaque-session",
        "x-cuebench-generation-receipt": "opaque-caption-receipt",
        "x-cuebench-project-owner": "a".repeat(64),
      }),
    }));
  });

  it("keeps a successful cancellation lifecycle-pending when exact cleanup is not yet acknowledged", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ cleanup: { state: "pending" } }), { status: 200 }));

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: "caption-run-1",
      authorization,
      nowMs: 1_000,
      fetcher,
    })).resolves.toEqual({
      status: "pending",
      message: "CueBench is waiting for a private cleanup acknowledgement. The 24-hour lifecycle backstop remains in effect.",
    });
  });

  it("uses the audio-description exact receipt route rather than a caption or broad cleanup endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({ cleanup: { state: "completed" } }));

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: "ad-run-1",
      authorization: {
        ...authorization,
        run: {
          targetTrack: "AudioDescriptions",
          runId: "ad-run-1",
          signedRunReceipt: "opaque-ad-receipt",
          session: "opaque-ad-session",
        },
      },
      nowMs: 1_000,
      fetcher,
    })).resolves.toEqual({ status: "deleted", message: "CueBench confirmed private cloud cleanup." });
    expect(fetcher).toHaveBeenCalledWith("/api/audio-description-runs/ad-run-1", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer opaque-ad-session",
        "x-cuebench-audio-description-receipt": "opaque-ad-receipt",
      }),
    }));
  });

  it.each([
    {
      targetTrack: "Captions" as const,
      runId: "terminal-caption-run",
      receiptHeader: "x-cuebench-generation-receipt",
      path: "/api/generation-runs/terminal-caption-run/acknowledge",
      action: "adopted" as const,
      adoptedProjectRevision: 9,
    },
    {
      targetTrack: "AudioDescriptions" as const,
      runId: "terminal-ad-run",
      receiptHeader: "x-cuebench-audio-description-receipt",
      path: "/api/audio-description-runs/terminal-ad-run/acknowledge",
      action: "discarded" as const,
    },
  ])("uses the retained $targetTrack terminal acknowledgement after its local lease is gone", async (terminal) => {
    const fetcher = vi.fn(async () => Response.json({ cleanup: { state: "completed" } }));
    const terminalAction = terminal.action === "adopted"
      ? { kind: "acknowledge" as const, action: terminal.action, adoptedProjectRevision: terminal.adoptedProjectRevision }
      : { kind: "acknowledge" as const, action: terminal.action };

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: null,
      authorization: {
        ...authorization,
        run: {
          targetTrack: terminal.targetTrack,
          runId: terminal.runId,
          signedRunReceipt: "opaque-terminal-receipt",
          session: "opaque-terminal-session",
          terminalAction,
        },
        upload: {
          operationId: "must-not-be-used",
          operationReceipt: "opaque-upload-receipt",
          session: "opaque-upload-session",
        },
      },
      nowMs: 1_000,
      fetcher,
    })).resolves.toEqual({ status: "deleted", message: "CueBench confirmed private cloud cleanup." });

    expect(fetcher).toHaveBeenCalledWith(terminal.path, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer opaque-terminal-session",
        [terminal.receiptHeader]: "opaque-terminal-receipt",
        "content-type": "application/json",
      }),
      body: JSON.stringify({ action: terminal.action, ...(terminal.adoptedProjectRevision === undefined ? {} : { adoptedProjectRevision: terminal.adoptedProjectRevision }) }),
    }));
    expect(fetcher).not.toHaveBeenCalledWith("/api/uploads/must-not-be-used", expect.anything());
  });

  it("does not dispatch a stale detached-tab capability after its expiry", async () => {
    const fetcher = vi.fn();

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: "caption-run-1",
      authorization,
      nowMs: 20_000,
      fetcher,
    })).resolves.toEqual({
      status: "pending",
      message: "Private cleanup is lifecycle-pending because this browser recovery capability expired. The 24-hour lifecycle backstop remains in effect.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never upgrades an accepted-but-unacknowledged upload DELETE response into confirmed cleanup", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));

    await expect(cleanupProjectCloudArtifacts({
      projectId: "project-1",
      sourceId: "source-1",
      activeRunId: null,
      authorization: {
        version: 1,
        ownerCapability: "a".repeat(64),
        expiresAtMs: 20_000,
        upload: { operationId: "upload-1", operationReceipt: "opaque-upload-receipt", session: "opaque-upload-session" },
      },
      nowMs: 1_000,
      fetcher,
    })).resolves.toEqual({
      status: "pending",
      message: "CueBench is waiting for a private cleanup acknowledgement. The 24-hour lifecycle backstop remains in effect.",
    });
  });

  it("reuses the durable exact-run receipt when a project is deleted during a caption run", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => Response.json({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:project-cleanup"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected a durable project.");
    const started = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "project-delete-caption-run",
      targetTrack: "Captions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);
    const active = store.getSnapshot().project;
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (active === null || owner === null) throw new Error("Expected active durable cloud identity.");
    await store.persistCaptionGenerationReceipt("project-delete-caption-run", {
      version: 1,
      runId: "project-delete-caption-run",
      projectId: active.projectId,
      signedGenerationReceipt: "opaque-project-delete-receipt",
      session: "opaque-project-delete-session",
      expectedProjectRevision: active.projectRevision,
      expectedQualityProfileRevision: active.qualityProfile.revision,
      mediaSha256: active.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: active.media.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: Date.now(),
      retentionExpiresAtMs: Date.now() + 60_000,
    });

    const deletion = await store.deleteCurrentProject();
    expect(deletion.cloudCleanup.status).toBe("pending");
    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    expect(fetcher).toHaveBeenCalledWith("/api/generation-runs/project-delete-caption-run", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer opaque-project-delete-session",
        "x-cuebench-generation-receipt": "opaque-project-delete-receipt",
        "x-cuebench-project-owner": owner,
      }),
    }));
    await expect.poll(async () => (await store.listCloudCleanupReceipts())[0]?.state).toBe("deleted");
    const publicEntries = await store.listCloudCleanupReceipts();
    expect(JSON.stringify(publicEntries)).not.toContain("opaque-project-delete-receipt");
    expect(JSON.stringify(publicEntries)).not.toContain("opaque-project-delete-session");
    const rawReceipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(rawReceipt).toBeDefined();
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-project-delete-receipt");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-project-delete-session");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(owner);
    expect((rawReceipt?.value as Readonly<Record<string, unknown>>).authorization).toBeUndefined();
    await database.delete();
  });

  it("reuses the durable exact-run receipt when a project is deleted during an AD run", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-ad-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => Response.json({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const bootstrap = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:project-cleanup-ad"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await bootstrap.openSample();
    const bootstrapProject = bootstrap.getSnapshot().project;
    if (bootstrapProject === null) throw new Error("Expected a durable project.");
    const retainedEvidence: LocalCaptionEvidencePackage = {
      packageId: "ad-delete-caption-evidence",
      runId: "ad-delete-caption-run",
      projectId: bootstrapProject.projectId,
      mediaSha256: bootstrapProject.media.sha256,
      expectedProjectRevision: 1,
      expectedQualityProfileRevision: 1,
      retainedAtMs: 1_700_000_000_000,
      evidence: {
        contractVersion: 1,
        runId: "ad-delete-caption-run",
        projectId: bootstrapProject.projectId,
        mediaSha256: bootstrapProject.media.sha256,
        preparedManifest: { key: "prepared/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/audio.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: bootstrapProject.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: "ad-delete-word", sourceWordIndex: 0, startMs: 100, endMs: 300, text: "The", speaker: "Teacher", speakerSegmentIds: ["ad-delete-speaker"] }],
        speakerSegments: [{ id: "ad-delete-speaker", startMs: 100, endMs: 300, speaker: "Teacher", text: "The" }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        ],
      },
      cueBindings: [{ cueId: "ad-delete-caption", itemId: "ad-delete-caption", itemRevision: 1, evidenceIds: ["ad-delete-word"] }],
    };
    const evidencedProject = createProject({
      projectId: bootstrapProject.projectId,
      title: bootstrapProject.title,
      media: bootstrapProject.media,
      captions: [{
        kind: "CaptionCue",
        itemId: "ad-delete-caption",
        state: "Sustained",
        startMs: 100,
        endMs: 600,
        text: "The teacher introduces the diagram.",
        speaker: "Teacher",
        actor: { type: "Human", id: "teacher" },
        cause: "fixture",
      }],
      evidence: [{ evidenceId: "ad-delete-word", projectId: bootstrapProject.projectId, mediaSha256: bootstrapProject.media.sha256, itemId: "ad-delete-caption", itemRevision: 1 }],
      localEvidencePackages: [retainedEvidence],
    });
    await database.transaction("rw", [
      database.projectHeaders,
      database.items,
      database.revisions,
      database.findings,
      database.evidence,
      database.courtRecord,
      database.certifications,
    ], async () => {
      await Promise.all([
        database.projectHeaders.delete(bootstrapProject.projectId),
        database.items.where("projectId").equals(bootstrapProject.projectId).delete(),
        database.revisions.where("projectId").equals(bootstrapProject.projectId).delete(),
        database.findings.where("projectId").equals(bootstrapProject.projectId).delete(),
        database.evidence.where("projectId").equals(bootstrapProject.projectId).delete(),
        database.courtRecord.where("projectId").equals(bootstrapProject.projectId).delete(),
        database.certifications.where("projectId").equals(bootstrapProject.projectId).delete(),
      ]);
    });
    await initializeProject(database, evidencedProject);
    bootstrap.dispose();

    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:project-cleanup-ad-restored"), revokeObjectURL: vi.fn() }),
    });
    await store.restoreLastDurableProject();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected the caption-evidenced durable project.");
    const started = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "project-delete-ad-run",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);
    const active = store.getSnapshot().project;
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    const base = active?.activeGenerationRun?.base;
    if (active === null || owner === null || base?.targetTrack !== "AudioDescriptions") {
      throw new Error("Expected an active durable AD cloud identity.");
    }
    await store.persistAudioDescriptionGenerationReceipt("project-delete-ad-run", {
      version: 1,
      runId: "project-delete-ad-run",
      projectId: active.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-project-delete-ad-receipt",
      session: "opaque-project-delete-ad-session",
      expectedProjectRevision: active.projectRevision,
      expectedQualityProfileRevision: active.qualityProfile.revision,
      mediaSha256: active.media.sha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: 12,
      sourceDurationMs: active.media.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: Date.now(),
      retentionExpiresAtMs: Date.now() + 60_000,
    });

    const deletion = await store.deleteCurrentProject();
    expect(deletion.cloudCleanup.status).toBe("pending");
    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    expect(fetcher).toHaveBeenCalledWith("/api/audio-description-runs/project-delete-ad-run", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer opaque-project-delete-ad-session",
        "x-cuebench-audio-description-receipt": "opaque-project-delete-ad-receipt",
        "x-cuebench-project-owner": owner,
      }),
    }));
    await expect.poll(async () => (await store.listCloudCleanupReceipts())[0]?.state).toBe("deleted");
    const rawReceipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-project-delete-ad-receipt");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-project-delete-ad-session");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(owner);
    await database.delete();
  });

  it.each([
    {
      targetTrack: "Captions" as const,
      runId: "late-caption-start",
      operationId: "late-caption-operation",
      receiptField: "signedGenerationReceipt" as const,
      receiptValue: "opaque-late-caption-receipt",
      session: "opaque-late-caption-session",
      path: "/api/generation-runs/late-caption-start",
      receiptHeader: "x-cuebench-generation-receipt",
    },
    {
      targetTrack: "AudioDescriptions" as const,
      runId: "late-ad-start",
      operationId: "late-ad-operation",
      receiptField: "signedAudioDescriptionGenerationReceipt" as const,
      receiptValue: "opaque-late-ad-receipt",
      session: "opaque-late-ad-session",
      path: "/api/audio-description-runs/late-ad-start",
      receiptHeader: "x-cuebench-audio-description-receipt",
    },
  ])("captures a late $targetTrack start receipt after project deletion for exact cleanup without restoring the project", async (target) => {
    const database = new CueBenchDatabase(`task-18-late-start-delete-${target.targetTrack}-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => Response.json({
      status: { stage: "Cancelled" },
      cleanup: { state: "completed" },
    }));
    vi.stubGlobal("fetch", fetcher);
    let store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:late-start"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    let project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    if (target.targetTrack === "AudioDescriptions") {
      const evidenced = adReadyProject(project);
      await database.transaction("rw", [
        database.projectHeaders,
        database.items,
        database.revisions,
        database.findings,
        database.evidence,
        database.courtRecord,
        database.certifications,
      ], async () => {
        await Promise.all([
          database.projectHeaders.delete(project!.projectId),
          database.items.where("projectId").equals(project!.projectId).delete(),
          database.revisions.where("projectId").equals(project!.projectId).delete(),
          database.findings.where("projectId").equals(project!.projectId).delete(),
          database.evidence.where("projectId").equals(project!.projectId).delete(),
          database.courtRecord.where("projectId").equals(project!.projectId).delete(),
          database.certifications.where("projectId").equals(project!.projectId).delete(),
        ]);
      });
      await initializeProject(database, evidenced);
      store.dispose();
      store = new ProjectStore({
        database,
        browserStorage: browserStorage(),
        objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:late-start-restored"), revokeObjectURL: vi.fn() }),
      });
      await store.restoreLastDurableProject();
      project = store.getSnapshot().project;
      if (project === null) throw new Error("Expected durable AD-ready project.");
    }
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    const reservation = {
      projectId: project.projectId,
      operationId: target.operationId,
      runId: target.runId,
      targetTrack: target.targetTrack,
      projectOwnerCapability: owner,
      mediaSha256: project.media.sha256,
      sourceDurationMs: project.media.durationMs,
    };
    if (target.targetTrack === "Captions") {
      await store.reserveCaptionGenerationReceipt(target.runId, reservation);
    } else {
      await store.reserveAudioDescriptionGenerationReceipt(target.runId, reservation);
    }
    const leased = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: target.runId,
      targetTrack: target.targetTrack,
      expectedProjectRevision: project.projectRevision,
    });
    if (leased.error !== undefined) throw new Error(leased.error.message);

    const deletion = await store.deleteCurrentProject();
    expect(store.getSnapshot().project).toBeNull();
    const beforeLateReceipt = (await database.settings.toArray()).find((setting) => (
      setting.key === `pending-generation-start:${project.projectId}:${target.operationId}:${target.runId}`
    ));
    expect(beforeLateReceipt?.value).toMatchObject({ deletionReceiptId: deletion.receiptId });
    const lateReceipt = {
      version: 1 as const,
      runId: target.runId,
      projectId: project.projectId,
      [target.receiptField]: target.receiptValue,
      session: target.session,
      expectedProjectRevision: leased.project.projectRevision,
      expectedQualityProfileRevision: leased.project.qualityProfile.revision,
      mediaSha256: project.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: project.media.durationMs,
      projectOwnerCapability: owner,
      retentionExpiresAtMs: Date.now() + 60_000,
      savedAtMs: Date.now(),
      ...(target.targetTrack === "AudioDescriptions" ? { captionEvidenceHash: "c".repeat(64) } : {}),
    };
    const recovery = {
      projectId: project.projectId,
      operationId: target.operationId,
      runId: target.runId,
      targetTrack: target.targetTrack,
      projectOwnerCapability: owner,
      receipt: lateReceipt,
    };
    const handled = target.targetTrack === "Captions"
      ? await store.reconcileDeletedCaptionGenerationStart(recovery)
      : await store.reconcileDeletedAudioDescriptionGenerationStart(recovery);
    expect(handled).toBe(true);
    expect(store.getSnapshot().project).toBeNull();

    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(target.path, expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: `Bearer ${target.session}`,
        [target.receiptHeader]: target.receiptValue,
        "x-cuebench-project-owner": owner,
      }),
    }));
    await expect.poll(async () => (await store.listCloudCleanupReceipts())[0]?.state).toBe("deleted");
    expect(await database.projectHeaders.get(project.projectId)).toBeUndefined();
    const rawSettings = await database.settings.toArray();
    expect(rawSettings.some((setting) => setting.key.startsWith(`pending-generation-start:${project.projectId}:`))).toBe(false);
    const rawReceipt = rawSettings.find((setting) => setting.key.includes(deletion.receiptId));
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(target.receiptValue);
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(target.session);
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(owner);
    await database.delete();
  });

  it("scrubs unmatched pre-start and peer-tab private intents when deletion preserves only the canonical active start", async () => {
    const database = new CueBenchDatabase(`task-18-unmatched-start-intents-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const primary = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:unmatched-primary"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await primary.openSample();
    const project = primary.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const owner = await primary.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    const canonicalRunId = "canonical-pending-start";
    const canonicalOperationId = "canonical-pending-operation";
    await primary.reserveCaptionGenerationReceipt(canonicalRunId, {
      projectId: project.projectId,
      operationId: canonicalOperationId,
      runId: canonicalRunId,
      targetTrack: "Captions",
      projectOwnerCapability: owner,
      mediaSha256: project.media.sha256,
      sourceDurationMs: project.media.durationMs,
    });
    await primary.reserveCaptionGenerationReceipt("pre-start-orphan", {
      projectId: project.projectId,
      operationId: "pre-start-orphan-operation",
      runId: "pre-start-orphan",
      targetTrack: "Captions",
      projectOwnerCapability: "b".repeat(64),
      mediaSha256: "c".repeat(64),
      sourceDurationMs: project.media.durationMs,
    });
    const started = await primary.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: canonicalRunId,
      targetTrack: "Captions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);

    // A peer tab can retain a private pre-POST reservation after the active
    // run has been selected. Its different owner/media data must not survive
    // the canonical deletion transaction.
    const peer = new ProjectStore({ database, browserStorage: browserStorage() });
    await peer.restoreLastDurableProject();
    await peer.reserveCaptionGenerationReceipt("peer-orphan", {
      projectId: project.projectId,
      operationId: "peer-orphan-operation",
      runId: "peer-orphan",
      targetTrack: "Captions",
      projectOwnerCapability: "d".repeat(64),
      mediaSha256: "e".repeat(64),
      sourceDurationMs: project.media.durationMs,
    });

    const deletion = await primary.deleteCurrentProject();
    const pending = (await database.settings.toArray()).filter((setting) => setting.key.startsWith(`pending-generation-start:${project.projectId}:`));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.key).toBe(`pending-generation-start:${project.projectId}:${canonicalOperationId}:${canonicalRunId}`);
    expect(pending[0]?.value).toMatchObject({ deletionReceiptId: deletion.receiptId, ownerCapability: owner });
    const raw = JSON.stringify(await database.settings.toArray());
    expect(raw).not.toContain("pre-start-orphan-operation");
    expect(raw).not.toContain("peer-orphan-operation");
    expect(raw).not.toContain("b".repeat(64));
    expect(raw).not.toContain("d".repeat(64));
    await database.delete();
  });

  it("sweeps a private pending-start intent after a failed release reaches its 24-hour recovery bound", async () => {
    const database = new CueBenchDatabase(`task-18-expired-start-intent-${crypto.randomUUID()}`);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:expired-intent"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    const fence = store.getProjectInstanceFence();
    const owner = project === null ? null : await store.getCloudProjectOwnerCapability(project.projectId);
    if (project === null || fence === null || owner === null) throw new Error("Expected durable project identity.");
    const runId = "failed-release-pending-start";
    const operationId = "failed-release-operation";
    await store.reserveCaptionGenerationReceipt(runId, {
      projectId: project.projectId,
      operationId,
      runId,
      targetTrack: "Captions",
      projectOwnerCapability: owner,
      mediaSha256: project.media.sha256,
      sourceDurationMs: project.media.durationMs,
    });
    // A stale page fence makes the normal release fail before it can delete
    // the write-ahead row. The bounded sweep must scrub that retained private
    // owner/media metadata even if no project deletion follows.
    await expect(store.releaseCaptionGenerationReceiptReservation(runId, {
      ...fence,
      projectInstanceEpoch: fence.projectInstanceEpoch + 1,
    })).rejects.toThrow(/project instance changed/i);
    const key = `pending-generation-start:${project.projectId}:${operationId}:${runId}`;
    const before = await database.settings.get(key);
    expect(JSON.stringify(before?.value)).toContain(owner);
    const createdAtMs = before?.value && typeof before.value === "object" && before.value !== null
      ? (before.value as { readonly createdAtMs?: unknown }).createdAtMs
      : undefined;
    if (typeof createdAtMs !== "number") throw new Error("Expected private intent creation timestamp.");
    await store.listCloudCleanupReceipts(createdAtMs + 24 * 60 * 60 * 1_000);
    expect(await database.settings.get(key)).toBeUndefined();
    await database.delete();
  });

  it("holds a caption start POST across deletion, then cleans the exact late run without restoring the project", async () => {
    const database = new CueBenchDatabase(`task-18-held-caption-start-${crypto.randomUUID()}`);
    const cleanupFetcher = vi.fn(async () => Response.json({ status: { stage: "Cancelled" }, cleanup: { state: "completed" } }));
    vi.stubGlobal("fetch", cleanupFetcher);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:held-caption"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable caption project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    let resolveStart: (response: Response) => void = () => { throw new Error("Caption start POST was never called."); };
    const startFetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveStart = resolve; }));
    const runId = "held-caption-start";
    const client = new CaptionGenerationClient({ fetcher: startFetcher, createRunId: () => runId });
    const pending = client.start({
      project,
      store,
      upload: {
        operationId: "held-caption-operation",
        session: "held-caption-session",
        operationReceipt: "held-caption-upload-receipt",
        sourceByteLength: 12,
        sourceSha256: project.media.sha256,
        durationMs: project.media.durationMs,
        projectOwnerCapability: owner,
      },
    });
    await expect.poll(() => startFetcher.mock.calls.length).toBe(1);
    const leased = store.getSnapshot().project;
    const base = leased?.activeGenerationRun?.base;
    if (leased === null || base?.targetTrack !== "Captions") throw new Error("Expected held caption lease.");

    const deletion = await store.deleteCurrentProject();
    expect(store.getSnapshot().project).toBeNull();
    resolveStart(Response.json({
      generationRunReceipt: "opaque-held-caption-receipt",
      retentionExpiresAtMs: Date.now() + 60_000,
      status: {
        contractVersion: 1,
        runId,
        projectId: project.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: base.expectedProjectRevision,
        stage: "Queued",
      },
    }, { status: 201 }));

    await expect(pending).rejects.toMatchObject({ details: { code: "PROJECT_DELETED_DURING_START" } });
    const capturedBeforeCleanup = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(capturedBeforeCleanup?.value).toMatchObject({
      authorization: { run: { runId, targetTrack: "Captions", signedRunReceipt: "opaque-held-caption-receipt" } },
    });
    await expect.poll(() => cleanupFetcher.mock.calls.length).toBe(1);
    expect(cleanupFetcher).toHaveBeenCalledWith(`/api/generation-runs/${runId}`, expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer held-caption-session",
        "x-cuebench-generation-receipt": "opaque-held-caption-receipt",
        "x-cuebench-project-owner": owner,
      }),
    }));
    expect(store.getSnapshot().project).toBeNull();
    expect(await database.projectHeaders.get(project.projectId)).toBeUndefined();
    await expect.poll(async () => (await store.listCloudCleanupReceipts())[0]?.state).toBe("deleted");
    const raw = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(JSON.stringify(raw?.value)).not.toContain("opaque-held-caption-receipt");
    await database.delete();
  });

  it("holds an AD start POST across deletion, then cleans the exact late run without restoring the project", async () => {
    const database = new CueBenchDatabase(`task-18-held-ad-start-${crypto.randomUUID()}`);
    const cleanupFetcher = vi.fn(async () => Response.json({ status: { stage: "Cancelled" }, cleanup: { state: "completed" } }));
    vi.stubGlobal("fetch", cleanupFetcher);
    const bootstrap = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:held-ad-bootstrap"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await bootstrap.openSample();
    const initial = bootstrap.getSnapshot().project;
    if (initial === null) throw new Error("Expected durable bootstrap project.");
    const evidenced = adReadyProject(initial);
    await database.transaction("rw", [
      database.projectHeaders,
      database.items,
      database.revisions,
      database.findings,
      database.evidence,
      database.courtRecord,
      database.certifications,
    ], async () => {
      await Promise.all([
        database.projectHeaders.delete(initial.projectId),
        database.items.where("projectId").equals(initial.projectId).delete(),
        database.revisions.where("projectId").equals(initial.projectId).delete(),
        database.findings.where("projectId").equals(initial.projectId).delete(),
        database.evidence.where("projectId").equals(initial.projectId).delete(),
        database.courtRecord.where("projectId").equals(initial.projectId).delete(),
        database.certifications.where("projectId").equals(initial.projectId).delete(),
      ]);
    });
    await initializeProject(database, evidenced);
    bootstrap.dispose();
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:held-ad"), revokeObjectURL: vi.fn() }),
    });
    await store.restoreLastDurableProject();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable AD-ready project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    let resolveStart: (response: Response) => void = () => { throw new Error("AD start POST was never called."); };
    const startFetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveStart = resolve; }));
    const runId = "held-ad-start";
    const client = new AudioDescriptionGenerationClient({ fetcher: startFetcher, createRunId: () => runId });
    const pending = client.start({
      project,
      store,
      upload: {
        operationId: "held-ad-operation",
        session: "held-ad-session",
        operationReceipt: "held-ad-upload-receipt",
        sourceByteLength: 12,
        sourceSha256: project.media.sha256,
        durationMs: project.media.durationMs,
        projectOwnerCapability: owner,
      },
    });
    await expect.poll(() => startFetcher.mock.calls.length).toBe(1);
    const leased = store.getSnapshot().project;
    const base = leased?.activeGenerationRun?.base;
    if (leased === null || base?.targetTrack !== "AudioDescriptions") throw new Error("Expected held AD lease.");

    const deletion = await store.deleteCurrentProject();
    expect(store.getSnapshot().project).toBeNull();
    resolveStart(Response.json({
      audioDescriptionGenerationReceipt: "opaque-held-ad-receipt",
      retentionExpiresAtMs: Date.now() + 60_000,
      status: {
        contractVersion: 1,
        runId,
        projectId: project.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: base.expectedProjectRevision,
        stage: "Queued",
      },
    }, { status: 201 }));

    await expect(pending).rejects.toMatchObject({ details: { code: "PROJECT_DELETED_DURING_START" } });
    const capturedBeforeCleanup = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(capturedBeforeCleanup?.value).toMatchObject({
      authorization: { run: { runId, targetTrack: "AudioDescriptions", signedRunReceipt: "opaque-held-ad-receipt" } },
    });
    await expect.poll(() => cleanupFetcher.mock.calls.length).toBe(1);
    expect(cleanupFetcher).toHaveBeenCalledWith(`/api/audio-description-runs/${runId}`, expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer held-ad-session",
        "x-cuebench-audio-description-receipt": "opaque-held-ad-receipt",
        "x-cuebench-project-owner": owner,
      }),
    }));
    expect(store.getSnapshot().project).toBeNull();
    expect(await database.projectHeaders.get(project.projectId)).toBeUndefined();
    await expect.poll(async () => (await store.listCloudCleanupReceipts())[0]?.state).toBe("deleted");
    const raw = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(JSON.stringify(raw?.value)).not.toContain("opaque-held-ad-receipt");
    await database.delete();
  });

  it("keeps a real local AD lease until the idempotent DELETE confirms a GET-reconciled terminal cleanup", async () => {
    const currentNow = Date.now();
    const { database, store, project, owner } = await openAdReadyProjectStore(`task-18-ad-get-delete-${crypto.randomUUID()}`);
    try {
      const runId = "ad-get-then-delete";
      const started = await store.executeCommand({
        type: "StartGenerationRun",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: project.projectRevision,
      });
      if (started.error !== undefined) throw new Error(started.error.message);
      const leased = store.getSnapshot().project;
      const base = leased?.activeGenerationRun?.base;
      if (leased === null || base?.targetTrack !== "AudioDescriptions") throw new Error("Expected an active durable AD lease.");
      const receipt = {
        version: 1 as const,
        runId,
        projectId: leased.projectId,
        signedAudioDescriptionGenerationReceipt: "opaque-ad-get-delete-receipt",
        session: "opaque-ad-get-delete-session",
        expectedProjectRevision: base.expectedProjectRevision,
        expectedQualityProfileRevision: base.qualityProfileRevision,
        mediaSha256: leased.media.sha256,
        captionEvidenceHash: base.captionEvidenceHash,
        sourceByteLength: 12,
        sourceDurationMs: leased.media.durationMs,
        projectOwnerCapability: owner,
        savedAtMs: currentNow,
        retentionExpiresAtMs: currentNow + 60_000,
      };
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // Retain the concrete fetcher signature so the assertion below also
        // proves the browser crossed GET before its exact DELETE.
        void input;
        void init;
        return terminalAudioDescriptionResponse({
          runId,
          projectId: leased.projectId,
          expectedProjectRevision: base.expectedProjectRevision,
          cleanup: "completed",
          atMs: currentNow,
        });
      });
      const client = new AudioDescriptionGenerationClient({ fetcher, clock: () => currentNow });

      // A reconnect GET can settle/redact the hosted tombstone, but it must
      // not release the browser's project lease: only the idempotent exact
      // DELETE acknowledgement owns that local transition.
      await expect(client.status(receipt)).resolves.toMatchObject({ stage: "Cancelled" });
      expect(store.getSnapshot().project?.activeGenerationRun).toMatchObject({ runId, targetTrack: "AudioDescriptions" });

      await expect(client.cancel({ project: leased, store, receipt })).resolves.toMatchObject({ stage: "Cancelled" });
      expect(store.getSnapshot().project?.activeGenerationRun).toBeNull();
      // A settled terminal receipt has no remaining recovery purpose, so the
      // bounded store intentionally prunes its private capability after the
      // local ReleaseGenerationRun commit.
      await expect(store.loadAudioDescriptionGenerationReceipt(runId)).resolves.toBeNull();
      expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "DELETE"]);
    } finally {
      await database.delete();
    }
  });

  it("keeps the durable AD lease and repair receipt after a pending DELETE, then releases both only after the retry settles", async () => {
    const currentNow = Date.now();
    const { database, store, project, owner } = await openAdReadyProjectStore(`task-18-ad-delete-repair-${crypto.randomUUID()}`);
    try {
      const runId = "ad-delete-repair";
      const started = await store.executeCommand({
        type: "StartGenerationRun",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: project.projectRevision,
      });
      if (started.error !== undefined) throw new Error(started.error.message);
      const leased = store.getSnapshot().project;
      const base = leased?.activeGenerationRun?.base;
      if (leased === null || base?.targetTrack !== "AudioDescriptions") throw new Error("Expected an active durable AD lease.");
      const receipt = {
        version: 1 as const,
        runId,
        projectId: leased.projectId,
        signedAudioDescriptionGenerationReceipt: "opaque-ad-delete-repair-receipt",
        session: "opaque-ad-delete-repair-session",
        expectedProjectRevision: base.expectedProjectRevision,
        expectedQualityProfileRevision: base.qualityProfileRevision,
        mediaSha256: leased.media.sha256,
        captionEvidenceHash: base.captionEvidenceHash,
        sourceByteLength: 12,
        sourceDurationMs: leased.media.durationMs,
        projectOwnerCapability: owner,
        savedAtMs: currentNow,
        retentionExpiresAtMs: currentNow + 60_000,
      };
      let deleteCalls = 0;
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        deleteCalls += 1;
        return terminalAudioDescriptionResponse({
          runId,
          projectId: leased.projectId,
          expectedProjectRevision: base.expectedProjectRevision,
          cleanup: deleteCalls === 1 ? "pending" : "completed",
          atMs: currentNow,
        });
      });
      const client = new AudioDescriptionGenerationClient({ fetcher, clock: () => currentNow });

      await expect(client.cancel({ project: leased, store, receipt })).resolves.toMatchObject({ stage: "Cancelled" });
      expect(store.getSnapshot().project?.activeGenerationRun).toMatchObject({ runId, targetTrack: "AudioDescriptions" });
      const pendingReceipt = await store.loadAudioDescriptionGenerationReceipt(runId);
      expect(pendingReceipt).toMatchObject({
        terminalCleanup: { action: "cancelled", cleanupAcknowledgement: "pending", localLeaseRelease: "pending" },
      });
      const blocked = await store.executeCommand({
        type: "StartGenerationRun",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId: "caption-must-wait-for-ad-cleanup",
        targetTrack: "Captions",
        expectedProjectRevision: store.getSnapshot().project!.projectRevision,
      });
      expect(blocked.error?.code).toBe("TARGET_TRACK_LEASE_CONFLICT");

      await expect(client.retryCancellationCleanup({
        project: store.getSnapshot().project!,
        store,
        receipt: pendingReceipt as AudioDescriptionGenerationReceipt,
      })).resolves.toBeUndefined();
      expect(deleteCalls).toBe(2);
      expect(store.getSnapshot().project?.activeGenerationRun).toBeNull();
      await expect(store.loadAudioDescriptionGenerationReceipt(runId)).resolves.toBeNull();
    } finally {
      await database.delete();
    }
  });

  it("moves a captured upload authorization out of localStorage only after the durable deletion receipt exists", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-upload-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:upload-cleanup"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected project owner.");
    const localKey = `cuebench-cloud-upload:${project.projectId}`;
    localStorage.setItem(localKey, JSON.stringify({
      version: 1,
      projectId: project.projectId,
      operationId: "upload-delete-operation",
      sourceByteLength: 12,
      sourceSha256: project.media.sha256,
      sourceContentType: "video/mp4",
      durationMs: project.media.durationMs,
      projectOwnerCapability: owner,
      session: "opaque-upload-session",
      sessionExpiresAtMs: Date.now() + 60_000,
      operationReceipt: "opaque-upload-receipt",
      uploadCapability: "opaque-upload-capability",
      partSize: 12,
      partCount: 1,
      partReceipts: {},
    }));

    const deletion = await store.deleteCurrentProject();
    expect(localStorage.getItem(localKey)).toBeNull();
    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    expect(fetcher).toHaveBeenCalledWith("/api/uploads/upload-delete-operation", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer opaque-upload-session",
        "x-cuebench-operation-receipt": "opaque-upload-receipt",
        "x-cuebench-project-owner": owner,
      }),
    }));
    const rawReceipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-upload-session");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-upload-receipt");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-upload-capability");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain(owner);
    await database.delete();
  });

  it("clears duplicate local upload recovery after a committed deletion receipt even when exact run cleanup owns the deletion", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-run-local-storage-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "not surfaced" }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:run-local-storage"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    const started = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-local-storage-caption",
      targetTrack: "Captions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);
    const active = store.getSnapshot().project;
    if (active === null) throw new Error("Expected active project.");
    await store.persistCaptionGenerationReceipt("run-local-storage-caption", {
      version: 1,
      runId: "run-local-storage-caption",
      projectId: active.projectId,
      signedGenerationReceipt: "opaque-run-local-storage-receipt",
      session: "opaque-run-local-storage-session",
      expectedProjectRevision: active.projectRevision,
      expectedQualityProfileRevision: active.qualityProfile.revision,
      mediaSha256: active.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: active.media.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: Date.now(),
      retentionExpiresAtMs: Date.now() + 60_000,
    });
    const localKey = `cuebench-cloud-upload:${active.projectId}`;
    localStorage.setItem(localKey, JSON.stringify({
      version: 1,
      projectId: active.projectId,
      operationReceipt: "duplicate-private-upload-receipt",
      session: "duplicate-private-session",
    }));

    await store.deleteCurrentProject();

    expect(localStorage.getItem(localKey)).toBeNull();
    await database.delete();
  });

  it("clears a project-scoped local upload remnant after a committed deletion receipt with no browser authority", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-no-authority-local-storage-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "not surfaced" }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:no-authority-local-storage"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const localKey = `cuebench-cloud-upload:${project.projectId}`;
    // This stale row intentionally cannot be captured as browser authority.
    // A deletion receipt still commits, so it must remove the duplicate key.
    localStorage.setItem(localKey, JSON.stringify({ projectId: project.projectId, stale: "opaque-local-remnant" }));

    await store.deleteCurrentProject();

    expect(localStorage.getItem(localKey)).toBeNull();
    await database.delete();
  });

  it("caps a deletion receipt at its inner run authority and atomically turns it lifecycle-pending when that authority expires", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-inner-expiry-${crypto.randomUUID()}`);
    const initialNow = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "not surfaced" }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:inner-expiry"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    const started = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "inner-expiry-caption",
      targetTrack: "Captions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);
    const active = store.getSnapshot().project;
    if (active === null) throw new Error("Expected active project.");
    const innerExpiry = initialNow + 1_000;
    await store.persistCaptionGenerationReceipt("inner-expiry-caption", {
      version: 1,
      runId: "inner-expiry-caption",
      projectId: active.projectId,
      signedGenerationReceipt: "opaque-inner-expiry-receipt",
      session: "opaque-inner-expiry-session",
      expectedProjectRevision: active.projectRevision,
      expectedQualityProfileRevision: active.qualityProfile.revision,
      mediaSha256: active.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: active.media.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: initialNow,
      retentionExpiresAtMs: innerExpiry,
    });

    const deletion = await store.deleteCurrentProject();
    await expect.poll(() => cloudCleanup.mock.calls.length).toBe(1);
    const beforeExpiry = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(beforeExpiry?.value).toMatchObject({ expiresAtMs: innerExpiry });
    expect(JSON.stringify(beforeExpiry?.value)).toContain("opaque-inner-expiry-receipt");

    dateNow.mockReturnValue(innerExpiry + 1);
    await expect(store.listCloudCleanupReceipts(innerExpiry + 1)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: deletion.receiptId, state: "lifecycle-pending" }),
    ]));
    const expired = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(expired?.value).toMatchObject({ state: "lifecycle-pending" });
    expect(JSON.stringify(expired?.value)).not.toContain("opaque-inner-expiry-receipt");
    expect(JSON.stringify(expired?.value)).not.toContain("opaque-inner-expiry-session");
    expect(JSON.stringify(expired?.value)).not.toContain(owner);
    await expect(store.retryCloudCleanup(deletion.receiptId)).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    expect(cloudCleanup).toHaveBeenCalledTimes(1);
    dateNow.mockRestore();
    await database.delete();
  });

  it("caps a deletion receipt at its inner upload authority and scrubs that local recovery material on expiry", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-upload-inner-expiry-${crypto.randomUUID()}`);
    const initialNow = 1_700_000_100_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "not surfaced" }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:upload-inner-expiry"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected durable browser-project owner.");
    const innerExpiry = initialNow + 1_000;
    localStorage.setItem(`cuebench-cloud-upload:${project.projectId}`, JSON.stringify({
      version: 1,
      projectId: project.projectId,
      operationId: "upload-inner-expiry-operation",
      sourceByteLength: 12,
      sourceSha256: project.media.sha256,
      sourceContentType: "video/mp4",
      durationMs: project.media.durationMs,
      projectOwnerCapability: owner,
      session: "opaque-upload-inner-expiry-session",
      sessionExpiresAtMs: innerExpiry,
      operationReceipt: "opaque-upload-inner-expiry-receipt",
      uploadCapability: "opaque-upload-inner-expiry-capability",
      partSize: 12,
      partCount: 1,
      partReceipts: {},
    }));

    const deletion = await store.deleteCurrentProject();
    await expect.poll(() => cloudCleanup.mock.calls.length).toBe(1);
    const beforeExpiry = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(beforeExpiry?.value).toMatchObject({ expiresAtMs: innerExpiry });
    expect(JSON.stringify(beforeExpiry?.value)).toContain("opaque-upload-inner-expiry-receipt");

    dateNow.mockReturnValue(innerExpiry + 1);
    await expect(store.listCloudCleanupReceipts(innerExpiry + 1)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: deletion.receiptId, state: "lifecycle-pending" }),
    ]));
    const expired = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(expired?.value).toMatchObject({ state: "lifecycle-pending" });
    expect(JSON.stringify(expired?.value)).not.toContain("opaque-upload-inner-expiry-receipt");
    expect(JSON.stringify(expired?.value)).not.toContain("opaque-upload-inner-expiry-session");
    expect(JSON.stringify(expired?.value)).not.toContain("opaque-upload-inner-expiry-capability");
    expect(JSON.stringify(expired?.value)).not.toContain(owner);
    await expect(store.retryCloudCleanup(deletion.receiptId)).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    expect(cloudCleanup).toHaveBeenCalledTimes(1);
    dateNow.mockRestore();
    await database.delete();
  });

  it.each([
    { targetTrack: "Captions" as const, runId: "retained-caption-adoption", path: "/api/generation-runs/retained-caption-adoption/acknowledge", receiptHeader: "x-cuebench-generation-receipt", receiptField: "signedGenerationReceipt" as const },
    { targetTrack: "AudioDescriptions" as const, runId: "retained-ad-adoption", path: "/api/audio-description-runs/retained-ad-adoption/acknowledge", receiptHeader: "x-cuebench-audio-description-receipt", receiptField: "signedAudioDescriptionGenerationReceipt" as const },
  ])("acknowledges a locally adopted $targetTrack run before considering an upload fallback during project deletion", async (target) => {
    const database = new CueBenchDatabase(`task-18-terminal-receipt-${target.targetTrack}-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => Response.json({ cleanup: { state: "completed" } }));
    vi.stubGlobal("fetch", fetcher);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:terminal-receipt"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null || project.activeGenerationRun !== null) throw new Error("Expected an idle durable project.");
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    if (owner === null) throw new Error("Expected owner capability.");
    const receipt = {
      version: 1 as const,
      runId: target.runId,
      projectId: project.projectId,
      [target.receiptField]: `opaque-${target.targetTrack}-terminal-receipt`,
      session: `opaque-${target.targetTrack}-terminal-session`,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      mediaSha256: project.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: project.media.durationMs,
      projectOwnerCapability: owner,
      retentionExpiresAtMs: Date.now() + 60_000,
      savedAtMs: Date.now(),
      adoption: {
        status: "adopted" as const,
        adoptedProjectRevision: project.projectRevision + 1,
        localEvidencePackageId: `local-${target.runId}`,
        cleanupAcknowledgement: "pending" as const,
      },
      ...(target.targetTrack === "AudioDescriptions" ? { captionEvidenceHash: "c".repeat(64) } : {}),
    };
    if (target.targetTrack === "Captions") {
      await store.persistCaptionGenerationReceipt(target.runId, receipt);
    } else {
      await store.persistAudioDescriptionGenerationReceipt(target.runId, receipt);
    }

    await store.deleteCurrentProject();
    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(target.path, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: `Bearer opaque-${target.targetTrack}-terminal-session`,
        [target.receiptHeader]: `opaque-${target.targetTrack}-terminal-receipt`,
        "x-cuebench-project-owner": owner,
      }),
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision: project.projectRevision + 1 }),
    }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("/api/uploads/");
    await database.delete();
  });

  it("never reuses a run receipt whose owner belongs to a different browser project instance", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-owner-mismatch-${crypto.randomUUID()}`);
    const fetcher = vi.fn(async () => Response.json({ cleanup: { state: "completed" } }));
    vi.stubGlobal("fetch", fetcher);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:owner-mismatch"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected a durable project.");
    const started = await store.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "owner-mismatch-caption-run",
      targetTrack: "Captions",
      expectedProjectRevision: project.projectRevision,
    });
    if (started.error !== undefined) throw new Error(started.error.message);
    const active = store.getSnapshot().project;
    if (active === null) throw new Error("Expected active project.");
    await store.persistCaptionGenerationReceipt("owner-mismatch-caption-run", {
      version: 1,
      runId: "owner-mismatch-caption-run",
      projectId: active.projectId,
      signedGenerationReceipt: "foreign-owner-receipt",
      session: "foreign-owner-session",
      expectedProjectRevision: active.projectRevision,
      expectedQualityProfileRevision: active.qualityProfile.revision,
      mediaSha256: active.media.sha256,
      sourceByteLength: 12,
      sourceDurationMs: active.media.durationMs,
      projectOwnerCapability: "f".repeat(64),
      savedAtMs: Date.now(),
      retentionExpiresAtMs: Date.now() + 60_000,
    });

    const deletion = await store.deleteCurrentProject();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(fetcher).not.toHaveBeenCalled();
    await expect(store.listCloudCleanupReceipts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: deletion.receiptId, state: "deleting" }),
    ]));
    await database.delete();
  });

  it("does not invoke a retained cleanup hook after the one-day recovery capability expires", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-expired-hook-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn(async () => ({
      status: "pending" as const,
      message: "A private provider response that must never reach the UI.",
    }));
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:expired-hook"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await first.openSample();
    const deletion = await first.deleteCurrentProject();
    await expect.poll(() => cloudCleanup.mock.calls.length).toBe(1);
    await expect.poll(async () => (await first.listCloudCleanupReceipts())[0]?.attempts).toBe(1);

    const setting = (await database.settings.toArray()).find((candidate) => candidate.key.includes(deletion.receiptId));
    if (setting === undefined || typeof setting.value !== "object" || setting.value === null) {
      throw new Error("Expected retained deletion receipt.");
    }
    await database.settings.put({
      ...setting,
      value: { ...setting.value as Record<string, unknown>, expiresAtMs: Date.now() - 1 },
      updatedAtMs: Date.now(),
    });

    // A new detached-tab store has no in-memory operation to deduplicate the
    // retry. The durable expiry fence itself must suppress the private hook.
    const detached = new ProjectStore({ database, browserStorage: browserStorage(), cloudCleanup });
    await expect(detached.retryCloudCleanup(deletion.receiptId)).resolves.toEqual({
      status: "pending",
      message: "Private cleanup is lifecycle-pending because this browser recovery capability expired. The 24-hour lifecycle backstop remains in effect.",
    });
    expect(cloudCleanup).toHaveBeenCalledTimes(1);
    await expect(detached.listCloudCleanupReceipts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: deletion.receiptId, state: "lifecycle-pending", attempts: 1 }),
    ]));
    await database.delete();
  });

  it("atomically scrubs expired owner and run authorization before showing lifecycle-pending", async () => {
    const database = new CueBenchDatabase(`task-18-project-cleanup-expired-private-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "not surfaced" }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:expired-private"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const project = store.getSnapshot().project;
    if (project === null) throw new Error("Expected durable project.");
    const deletion = await store.deleteCurrentProject();
    await expect.poll(() => cloudCleanup.mock.calls.length).toBe(1);
    const setting = (await database.settings.toArray()).find((candidate) => candidate.key.includes(deletion.receiptId));
    if (setting === undefined || typeof setting.value !== "object" || setting.value === null) throw new Error("Expected retained deletion receipt.");
    await database.settings.put({
      ...setting,
      value: {
        ...setting.value as Record<string, unknown>,
        expiresAtMs: Date.now() - 1,
        authorization: {
          version: 1,
          ownerCapability: "b".repeat(64),
          expiresAtMs: Date.now() - 1,
          run: {
            targetTrack: "Captions",
            runId: "expired-caption-run",
            signedRunReceipt: "opaque-expired-run-receipt",
            session: "opaque-expired-session",
          },
        },
      },
      updatedAtMs: Date.now(),
    });

    // Simply reopening the cleanup panel must atomically strip expired
    // capabilities; it cannot wait for a person to press Retry.
    await expect(store.listCloudCleanupReceipts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: deletion.receiptId, state: "lifecycle-pending" }),
    ]));
    const rawReceipt = (await database.settings.toArray()).find((candidate) => candidate.key.includes(deletion.receiptId));
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-expired-run-receipt");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("opaque-expired-session");
    expect(JSON.stringify(rawReceipt?.value)).not.toContain("b".repeat(64));
    expect(rawReceipt?.value).toMatchObject({ state: "lifecycle-pending" });
    await expect(store.retryCloudCleanup(deletion.receiptId)).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    expect(cloudCleanup).toHaveBeenCalledTimes(1);
    await database.delete();
  });
});
