import { applyCommand, captionEvidenceProjectionForAudioDescription, createProject, type AudioDescriptionGenerationLeaseBase, type CaptionProject } from "@cuebench/domain";
import type { LocalCaptionEvidencePackage, StagedAudioDescriptionGenerationResult } from "@cuebench/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AudioDescriptionGenerationClient,
  type AudioDescriptionGenerationReceipt,
  type AudioDescriptionGenerationProjectStore,
} from "./ad-generation-client";

const ai = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const human = { type: "Human" as const, id: "teacher" };
const owner = "1".repeat(64);
const now = 1_700_000_000_000;

const projectFixture = (): CaptionProject => {
  const initial = createProject({
    projectId: "ad-browser-project",
    title: "AD browser fixture",
    media: { sourceId: "source", sha256: "a".repeat(64), durationMs: 30_000, relinkState: "Linked" },
    captions: [{
      kind: "CaptionCue",
      itemId: "caption-1",
      state: "Sustained",
      startMs: 1_000,
      endMs: 3_000,
      text: "The teacher introduces the diagram.",
      speaker: "Teacher",
      actor: human,
      cause: "fixture",
    }],
    evidence: [{
      evidenceId: "word-1",
      projectId: "ad-browser-project",
      mediaSha256: "a".repeat(64),
      itemId: "caption-1",
      itemRevision: 1,
    }],
  });
  const retained: LocalCaptionEvidencePackage = {
    packageId: "generation-caption-1",
    runId: "caption-1",
    projectId: initial.projectId,
    mediaSha256: initial.media.sha256,
    expectedProjectRevision: initial.projectRevision,
    expectedQualityProfileRevision: initial.qualityProfile.revision,
    retainedAtMs: now,
    evidence: {
      contractVersion: 1,
      runId: "caption-1",
      projectId: initial.projectId,
      mediaSha256: initial.media.sha256,
      preparedManifest: { key: "prepared/manifest.json", sha256: "b".repeat(64) },
      normalizedAudio: { key: "prepared/audio.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 30_000, contentType: "audio/wav" },
      words: [{ evidenceId: "word-1", sourceWordIndex: 0, startMs: 1_000, endMs: 1_300, text: "The", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
      speakerSegments: [{ id: "speaker-1", startMs: 1_000, endMs: 1_300, speaker: "Teacher", text: "The" }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: "caption-1", itemId: "caption-1", itemRevision: 1, evidenceIds: ["word-1"] }],
  };
  return { ...initial, localEvidencePackages: [retained] };
};

const upload = {
  operationId: "upload-1",
  session: "anonymous-session",
  operationReceipt: "opaque-upload-receipt",
  sourceByteLength: 4,
  sourceSha256: "a".repeat(64),
  durationMs: 30_000,
  projectOwnerCapability: owner,
};

const audioDescriptionBase = (project: CaptionProject): AudioDescriptionGenerationLeaseBase => {
  const base = project.activeGenerationRun?.base;
  if (base?.targetTrack !== "AudioDescriptions") throw new Error("Fixture must have an AD lease.");
  return base;
};

const stagedResult = (project: CaptionProject, runId: string): StagedAudioDescriptionGenerationResult => {
  const base = audioDescriptionBase(project);
  const evidence = captionEvidenceProjectionForAudioDescription(project, base.expectedProjectRevision);
  if (evidence === null) throw new Error("Fixture must retain caption evidence.");
  return {
    contractVersion: 1,
    runId,
    projectId: project.projectId,
    targetTrack: "AudioDescriptions",
    expectedProjectRevision: base.expectedProjectRevision,
    expectedQualityProfileRevision: project.qualityProfile.revision,
    mediaSha256: project.media.sha256,
    captionEvidenceHash: evidence.hash,
    evidence: {
      contractVersion: 1,
      runId,
      projectId: project.projectId,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: evidence.hash,
      preparedManifest: { key: "prepared/manifest.json", sha256: "b".repeat(64) },
      frames: [{ evidenceId: "frame-1", atMs: 8_000, sha256: "c".repeat(64), mimeType: "image/webp" }],
      sceneBoundaries: [8_000],
      provenance: [{ role: "audio-description", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] }],
    },
    audioDescriptions: [{ beatId: "ad-1", startMs: 8_000, endMs: 9_000, description: "A diagram appears.", evidenceIds: ["frame-1"] }],
    extendedDescriptionRequirements: [],
    createdAtMs: now,
    expiresAtMs: now + 86_400_000,
  };
};

describe("audio-description generation browser boundary", () => {
  it("uses the exact signed retry route without minting a new AD run or upload operation", async () => {
    const project = projectFixture();
    const receipt: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId: "ad-safe-retry",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-safe-retry",
      session: upload.session,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: "b".repeat(64),
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now,
      retentionExpiresAtMs: now + 60_000,
    };
    const fetcher = vi.fn(async () => Response.json({
      status: {
        contractVersion: 1,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Queued",
      },
    }));
    const client = new AudioDescriptionGenerationClient({ fetcher, clock: () => now });

    await expect(client.retry(receipt)).resolves.toMatchObject({ stage: "Queued", runId: receipt.runId });
    expect(fetcher).toHaveBeenCalledWith(`/api/audio-description-runs/${receipt.runId}/retry`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${upload.session}`,
        "x-cuebench-audio-description-receipt": receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": owner,
      },
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("/api/uploads");
  });

  it("honors an agent abort after an awaited reservation and before acquiring an AD lease", async () => {
    let project = projectFixture();
    let releaseReservation: () => void = () => { throw new Error("Reservation was not reached."); };
    const controller = new AbortController();
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn();
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      reserveAudioDescriptionGenerationReceipt: async () => new Promise<void>((resolve) => { releaseReservation = resolve; }),
      releaseAudioDescriptionGenerationReceiptReservation: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({ fetcher, createRunId: () => "aborted-ad-run" });
    const pending = client.start({ project, store, upload, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    releaseReservation();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(project.activeGenerationRun).toBeNull();
  });

  it("does not let the lease-driven WebMCP family replacement abort its own AD POST", async () => {
    let project = projectFixture();
    const groupController = new AbortController();
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      const base = audioDescriptionBase(project);
      return Response.json({
        audioDescriptionGenerationReceipt: "opaque-ad-receipt",
        retentionExpiresAtMs: now + 86_400_000,
        status: {
          contractVersion: 1,
          runId: "self-swap-ad-run",
          projectId: project.projectId,
          targetTrack: "AudioDescriptions",
          expectedProjectRevision: base.expectedProjectRevision,
          stage: "Queued",
        },
      }, { status: 201 });
    });
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({ fetcher, createRunId: () => "self-swap-ad-run", clock: () => now });

    await expect(client.start({
      project,
      store,
      signal: groupController.signal,
      upload,
      onLifecycleEvent: (event) => { if (event.phase === "lease-acquired") groupController.abort(); },
    })).resolves.toMatchObject({ status: { runId: "self-swap-ad-run", stage: "Queued" } });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("captures an AD start when deletion wins between the first recovery read and receipt persistence", async () => {
    let project: CaptionProject | null = projectFixture();
    const executeCommand = vi.fn(async (command) => {
      if (project === null) throw new Error("Project was deleted.");
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const reserveAudioDescriptionGenerationReceipt = vi.fn();
    const persistAudioDescriptionGenerationReceipt = vi.fn(async () => {
      project = null;
      throw new Error("Project was deleted before the AD receipt could persist.");
    });
    const reconcileDeletedAudioDescriptionGenerationStart = vi.fn(async () => {
      return project === null;
    });
    const fetcher = vi.fn(async () => {
      const current = project;
      const base = current?.activeGenerationRun?.base;
      if (current === null || base?.targetTrack !== "AudioDescriptions") throw new Error("Expected AD lease.");
      return Response.json({
        audioDescriptionGenerationReceipt: "opaque-deleted-ad-receipt",
        retentionExpiresAtMs: now + 86_400_000,
        status: {
          contractVersion: 1,
          runId: "deleted-during-ad-start",
          projectId: current.projectId,
          targetTrack: "AudioDescriptions",
          expectedProjectRevision: base.expectedProjectRevision,
          stage: "Queued",
        },
      }, { status: 201 });
    });
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      reserveAudioDescriptionGenerationReceipt,
      persistAudioDescriptionGenerationReceipt,
      reconcileDeletedAudioDescriptionGenerationStart,
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({ fetcher, createRunId: () => "deleted-during-ad-start", clock: () => now });

    await expect(client.start({ project: projectFixture(), store, upload })).rejects.toMatchObject({
      details: {
        code: "PROJECT_DELETED_DURING_START",
        lifecycleOutcome: expect.objectContaining({ runId: "deleted-during-ad-start", receiptState: "available" }),
      },
    });
    expect(reconcileDeletedAudioDescriptionGenerationStart).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "ad-browser-project",
      operationId: upload.operationId,
      runId: "deleted-during-ad-start",
      targetTrack: "AudioDescriptions",
    }));
    expect(reconcileDeletedAudioDescriptionGenerationStart).toHaveBeenCalledTimes(2);
    expect(persistAudioDescriptionGenerationReceipt).toHaveBeenCalledTimes(1);
    expect(reserveAudioDescriptionGenerationReceipt).toHaveBeenCalledWith("deleted-during-ad-start", expect.objectContaining({ targetTrack: "AudioDescriptions" }));
  });

  it("stops AD cancellation before its durable intent when the invocation is already aborted", async () => {
    const project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: ai,
      runId: "cancel-before-intent-ad",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 1,
    }).project;
    const base = audioDescriptionBase(project);
    const runReceipt: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId: "cancel-before-intent-ad",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
      session: upload.session,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now,
      retentionExpiresAtMs: now + 86_400_000,
    };
    const controller = new AbortController();
    controller.abort();
    const persistAudioDescriptionGenerationReceipt = vi.fn();
    const fetcher = vi.fn();
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt,
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({ fetcher });

    await expect(client.cancel({ project, store, receipt: runReceipt, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(persistAudioDescriptionGenerationReceipt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let the cancellation-intent family replacement abort its own AD DELETE", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: ai,
      runId: "self-swap-cancel-ad",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 1,
    }).project;
    const base = audioDescriptionBase(project);
    const runReceipt: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId: "self-swap-cancel-ad",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
      session: upload.session,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now,
      retentionExpiresAtMs: now + 86_400_000,
    };
    const groupController = new AbortController();
    const persistAudioDescriptionGenerationReceipt = vi.fn(async () => { groupController.abort(); });
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return Response.json({
        status: {
          contractVersion: 1,
          runId: runReceipt.runId,
          projectId: runReceipt.projectId,
          targetTrack: "AudioDescriptions",
          expectedProjectRevision: runReceipt.expectedProjectRevision,
          stage: "Cancelled",
        },
        cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: now, completedAtMs: now + 1 },
      });
    });
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistAudioDescriptionGenerationReceipt,
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({ fetcher });

    await expect(client.cancel({ project, store, receipt: runReceipt, signal: groupController.signal })).resolves.toMatchObject({ stage: "Cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("persists a signed receipt before status and sends only the canonical bounded caption projection", async () => {
    let project = projectFixture();
    const order: string[] = [];
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        order.push(command.type);
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistAudioDescriptionGenerationReceipt: async (_runId, value) => {
        order.push("persist-receipt");
        expect(value.signedAudioDescriptionGenerationReceipt).toBe("opaque-ad-receipt");
      },
      reserveAudioDescriptionGenerationReceipt: vi.fn(),
      releaseAudioDescriptionGenerationReceiptReservation: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    let payload: Record<string, unknown> | null = null;
    const client = new AudioDescriptionGenerationClient({
      createRunId: () => "ad-run-1",
      clock: () => now,
      fetcher: async (input, init) => {
        const path = String(input);
        order.push(path.endsWith("/ad-run-1") ? "status" : "start");
        if ((init?.method ?? "GET") === "POST") {
          payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            audioDescriptionGenerationReceipt: "opaque-ad-receipt",
            retentionExpiresAtMs: now + 86_400_000,
            status: {
              contractVersion: 1,
              runId: "ad-run-1",
              projectId: project.projectId,
              targetTrack: "AudioDescriptions",
              expectedProjectRevision: audioDescriptionBase(project).expectedProjectRevision,
              stage: "Queued",
            },
          }, { status: 201 });
        }
        return Response.json({ status: {
          contractVersion: 1,
          runId: "ad-run-1",
          projectId: project.projectId,
          targetTrack: "AudioDescriptions",
          expectedProjectRevision: audioDescriptionBase(project).expectedProjectRevision,
          stage: "AnalyzingVisuals",
          progress: 0.5,
        } });
      },
    });

    const started = await client.start({ project, store, upload });
    await client.status(started.receipt);

    expect(order).toEqual(["StartGenerationRun", "start", "persist-receipt", "status"]);
    expect(payload).toMatchObject({
      projectId: project.projectId,
      runId: "ad-run-1",
      captionEvidenceHash: audioDescriptionBase(project).captionEvidenceHash,
      captionEvidenceProjection: expect.objectContaining({ captions: [expect.objectContaining({ itemId: "caption-1" })] }),
    });
    expect(payload).not.toHaveProperty("video");
    expect(payload).not.toHaveProperty("providerApiKey");
  });

  it("retains and reports the exact AD run identity when hosted dispatch is ambiguous", async () => {
    let project = projectFixture();
    const events: string[] = [];
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({
      createRunId: () => "ambiguous-ad-run",
      fetcher: async () => { throw new Error("transport interrupted after dispatch"); },
      clock: () => now,
    });

    await expect(client.start({
      project,
      store,
      upload,
      onLifecycleEvent: (event) => events.push(event.phase),
    })).rejects.toMatchObject({
      details: { lifecycleOutcome: { runId: "ambiguous-ad-run", targetTrack: "AudioDescriptions", disposition: "accepted-unknown" } },
    });
    expect(project.activeGenerationRun).toMatchObject({ runId: "ambiguous-ad-run", targetTrack: "AudioDescriptions" });
    expect(events).toEqual(["lease-acquired", "dispatch-uncertain"]);
  });

  it("keeps a BrowserAgent-attributed AD cancellation recoverable when local lease release fails", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: ai,
      runId: "cancel-ad-run",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: 1,
    }).project;
    const base = audioDescriptionBase(project);
    const runReceipt: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId: "cancel-ad-run",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
      session: upload.session,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now,
      retentionExpiresAtMs: now + 86_400_000,
    };
    let stored = runReceipt;
    const executeCommand = vi.fn(async (command) => {
      if (command.type === "ReleaseGenerationRun") throw new Error("local release unavailable");
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistAudioDescriptionGenerationReceipt: async (_runId, value) => { stored = value; },
      loadAudioDescriptionGenerationReceipt: async () => stored,
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const events: string[] = [];
    const client = new AudioDescriptionGenerationClient({
      fetcher: async () => Response.json({
        status: { contractVersion: 1, runId: runReceipt.runId, projectId: runReceipt.projectId, targetTrack: "AudioDescriptions", expectedProjectRevision: runReceipt.expectedProjectRevision, stage: "Cancelled" },
        cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: now, completedAtMs: now + 1 },
      }),
      clock: () => now,
    });

    await expect(client.cancel({
      project,
      store,
      receipt: runReceipt,
      actor: { type: "BrowserAgent", id: "browser-agent" },
      onLifecycleEvent: (event) => events.push(event.phase),
    })).rejects.toMatchObject({
      details: { lifecycleOutcome: { runId: runReceipt.runId, targetTrack: "AudioDescriptions", disposition: "lifecycle-pending" } },
    });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
    }), project.projectId);
    expect(project.activeGenerationRun?.runId).toBe(runReceipt.runId);
    expect(stored.terminalCleanup).toMatchObject({ action: "cancelled", localLeaseRelease: "pending" });
    expect(events).toEqual(["cancellation-intent-persisted", "remote-cancelled"]);
  });

  it("refuses staged adoption when the result does not bind to the leased caption-evidence hash", async () => {
    let project = projectFixture();
    const start = applyCommand(project, {
      type: "StartGenerationRun", actor: ai, runId: "ad-run-1", targetTrack: "AudioDescriptions", expectedProjectRevision: project.projectRevision,
    });
    project = start.project;
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    };
    const client = new AudioDescriptionGenerationClient({
      fetcher: async () => {
        const staged = stagedResult(project, "ad-run-1");
        const staleHash = "f".repeat(64);
        return Response.json({ result: {
          ...staged,
          captionEvidenceHash: staleHash,
          evidence: { ...staged.evidence, captionEvidenceHash: staleHash },
        } });
      },
      clock: () => now,
    });
    await expect(client.adopt({
      project,
      store,
      confirmedProposedReplacement: true,
      receipt: {
        version: 1,
        runId: "ad-run-1",
        projectId: project.projectId,
        signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
        session: upload.session,
        expectedProjectRevision: audioDescriptionBase(project).expectedProjectRevision,
        expectedQualityProfileRevision: project.qualityProfile.revision,
        mediaSha256: project.media.sha256,
        captionEvidenceHash: audioDescriptionBase(project).captionEvidenceHash,
        sourceByteLength: upload.sourceByteLength,
        sourceDurationMs: upload.durationMs,
        projectOwnerCapability: owner,
        savedAtMs: now,
        retentionExpiresAtMs: now + 86_400_000,
      },
    })).rejects.toMatchObject({ details: { code: "STALE_PROJECT" } });
    expect(store.adoptStagedAudioDescriptionGenerationResult).not.toHaveBeenCalled();
  });

  it("settles an elapsed stored receipt through the durable atomic lease boundary", async () => {
    const project = projectFixture();
    const stored = {
      version: 1 as const,
      runId: "ad-expired-run",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
      session: upload.session,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: "b".repeat(64),
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now - 1_000,
      retentionExpiresAtMs: now - 1,
    };
    const settle = vi.fn(async () => ({
      ...stored,
      expirySettlement: {
        state: "lifecycle-pending" as const,
        disposition: "receipt-expired" as const,
        localLeaseRelease: "released" as const,
      },
    }));
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(async () => stored),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
      settleExpiredAudioDescriptionGenerationReceipt: settle,
    };
    const client = new AudioDescriptionGenerationClient({ clock: () => now });

    await expect(client.loadStoredReceipt(store, project, stored.runId)).resolves.toMatchObject({
      expirySettlement: { state: "lifecycle-pending", localLeaseRelease: "released" },
    });
    expect(settle).toHaveBeenCalledWith(stored.runId);
    expect(store.executeCommand).not.toHaveBeenCalled();
  });

  it("peeks an expired AD receipt without settling its lease or writing a recovery marker", async () => {
    const project = applyCommand(projectFixture(), {
      type: "StartGenerationRun", actor: ai, runId: "ad-peek-expired", targetTrack: "AudioDescriptions", expectedProjectRevision: 1,
    }).project;
    const base = audioDescriptionBase(project);
    const stored: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId: "ad-peek-expired",
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
      session: upload.session,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      mediaSha256: project.media.sha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: upload.sourceByteLength,
      sourceDurationMs: upload.durationMs,
      projectOwnerCapability: owner,
      savedAtMs: now - 1_000,
      retentionExpiresAtMs: now - 1,
    };
    const settle = vi.fn();
    const persist = vi.fn();
    const execute = vi.fn();
    const store: AudioDescriptionGenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: execute,
      persistAudioDescriptionGenerationReceipt: persist,
      loadAudioDescriptionGenerationReceipt: async () => stored,
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
      settleExpiredAudioDescriptionGenerationReceipt: settle,
    };
    const before = project;
    const client = new AudioDescriptionGenerationClient({ clock: () => now });

    await expect(client.peekStoredReceipt(store, project, stored.runId)).resolves.toMatchObject({ runId: stored.runId });
    expect(project).toBe(before);
    expect(settle).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
