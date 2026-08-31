import { applyCommand, captionEvidenceProjectionForAudioDescription, createProject, type AudioDescriptionGenerationLeaseBase, type CaptionProject } from "@cuebench/domain";
import type { LocalCaptionEvidencePackage, StagedAudioDescriptionGenerationResult } from "@cuebench/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AudioDescriptionGenerationClient,
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
});
