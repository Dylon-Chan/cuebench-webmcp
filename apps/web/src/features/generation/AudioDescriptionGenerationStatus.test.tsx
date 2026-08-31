import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalCaptionEvidencePackage } from "@cuebench/contracts";
import { applyCommand, createProject, type CaptionProject } from "@cuebench/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioDescriptionGenerationClientPort, AudioDescriptionGenerationProjectStore, AudioDescriptionGenerationReceipt } from "./ad-generation-client";
import { AudioDescriptionGenerationStatus } from "./AudioDescriptionGenerationStatus";

const ai = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const human = { type: "Human" as const, id: "teacher" };
const now = 1_700_000_000_000;

const projectWithEvidenceAndAnAiProposal = (): CaptionProject => {
  const initial = createProject({
    projectId: "ad-status-project",
    title: "AD status fixture",
    media: { sourceId: "source", sha256: "a".repeat(64), durationMs: 30_000, relinkState: "Linked" },
    captions: [{ kind: "CaptionCue", itemId: "caption-1", state: "Sustained", startMs: 1_000, endMs: 3_000, text: "The teacher introduces the diagram.", speaker: "Teacher", actor: human, cause: "fixture" }],
    audioDescriptions: [{ kind: "AudioDescriptionBeat", itemId: "ad-old", state: "Proposed", startMs: 5_000, endMs: 6_000, description: "Earlier AI proposal.", actor: ai, cause: "fixture" }],
    evidence: [{ evidenceId: "word-1", projectId: "ad-status-project", mediaSha256: "a".repeat(64), itemId: "caption-1", itemRevision: 1 }],
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
  const evidenced = { ...initial, localEvidencePackages: [retained] };
  return applyCommand(evidenced, {
    type: "StartGenerationRun",
    actor: ai,
    runId: "ad-run-1",
    targetTrack: "AudioDescriptions",
    expectedProjectRevision: evidenced.projectRevision,
  }).project;
};

const receiptFor = (project: CaptionProject): AudioDescriptionGenerationReceipt => {
  const base = project.activeGenerationRun?.base;
  if (base?.targetTrack !== "AudioDescriptions") throw new Error("Fixture needs an AD lease.");
  return {
    version: 1,
    runId: "ad-run-1",
    projectId: project.projectId,
    signedAudioDescriptionGenerationReceipt: "opaque-ad-receipt",
    session: "anonymous-session",
    expectedProjectRevision: base.expectedProjectRevision,
    expectedQualityProfileRevision: base.qualityProfileRevision,
    mediaSha256: project.media.sha256,
    captionEvidenceHash: base.captionEvidenceHash,
    sourceByteLength: 4,
    sourceDurationMs: project.media.durationMs,
    projectOwnerCapability: "1".repeat(64),
    savedAtMs: now,
    retentionExpiresAtMs: now + 86_400_000,
  };
};

afterEach(() => cleanup());

describe("AudioDescriptionGenerationStatus", () => {
  it("blocks hosted visual review until the current project retains bounded caption evidence", () => {
    const project = createProject({
      projectId: "ad-status-bare-project",
      title: "No caption evidence",
      media: { sourceId: "source", sha256: "a".repeat(64), durationMs: 30_000, relinkState: "Linked" },
      captions: [{ kind: "CaptionCue", itemId: "caption-1", state: "Proposed", startMs: 1_000, endMs: 2_000, text: "A caption without retained evidence.", speaker: null, actor: ai, cause: "fixture" }],
    });
    const store = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    } as unknown as AudioDescriptionGenerationProjectStore;
    const client = {
      start: vi.fn(), status: vi.fn(), cancel: vi.fn(), adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(), retryCancellationCleanup: vi.fn(), loadStoredReceipt: vi.fn(async () => null),
    } as unknown as AudioDescriptionGenerationClientPort;

    render(<AudioDescriptionGenerationStatus project={project} store={store} client={client} uploadRecovery={null} />);

    expect(screen.getByText(/AD review is deliberately blocked without a bounded caption-evidence base/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Propose audio descriptions" })).toBeDisabled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it("requires an explicit human confirmation before it adopts over earlier AI Proposed beats", async () => {
    const project = projectWithEvidenceAndAnAiProposal();
    const receipt = receiptFor(project);
    const adopt = vi.fn(async () => ({ project, command: {} }));
    const store = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    } as unknown as AudioDescriptionGenerationProjectStore;
    const client = {
      start: vi.fn(),
      status: vi.fn(async () => ({
        contractVersion: 1,
        runId: receipt.runId,
        projectId: project.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "AwaitingAdoption",
      })),
      cancel: vi.fn(),
      adopt,
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => receipt),
    } as unknown as AudioDescriptionGenerationClientPort;

    render(<AudioDescriptionGenerationStatus project={project} store={store} client={client} uploadRecovery={null} />);

    await screen.findByRole("button", { name: "Review replacement" });
    expect(adopt).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Review replacement" }));
    expect(await screen.findByText(/manual work and every Sustained beat remain untouched/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sustain/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Confirm replacement of AI proposals" }));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ confirmedProposedReplacement: true })));
  });

  it("offers a retry for a retryable AD failure without creating a new run identity", async () => {
    const project = projectWithEvidenceAndAnAiProposal();
    const receipt = receiptFor(project);
    const retry = vi.fn(async () => ({
      contractVersion: 1 as const,
      runId: receipt.runId,
      projectId: project.projectId,
      targetTrack: "AudioDescriptions" as const,
      expectedProjectRevision: receipt.expectedProjectRevision,
      stage: "Queued" as const,
    }));
    const store = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    } as unknown as AudioDescriptionGenerationProjectStore;
    const client = {
      start: vi.fn(),
      retry,
      status: vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: project.projectId,
        targetTrack: "AudioDescriptions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Failed" as const,
        retryable: true,
      })),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => receipt),
    } as unknown as AudioDescriptionGenerationClientPort;

    render(
      <AudioDescriptionGenerationStatus
        project={project}
        store={store}
        client={client}
        uploadRecovery={null}
      />,
    );

    const retryButton = await screen.findByRole("button", { name: "Retry AD review" });
    await userEvent.click(retryButton);
    await waitFor(() => expect(retry).toHaveBeenCalledWith(receipt));
    expect(client.start).not.toHaveBeenCalled();
  });

  it("does not offer an impossible retry after the bounded AD retry is exhausted", async () => {
    const project = projectWithEvidenceAndAnAiProposal();
    const receipt = receiptFor(project);
    const retry = vi.fn();
    const store = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    } as unknown as AudioDescriptionGenerationProjectStore;
    const client = {
      start: vi.fn(),
      retry,
      status: vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: project.projectId,
        targetTrack: "AudioDescriptions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Failed" as const,
        retryable: false,
      })),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => receipt),
    } as unknown as AudioDescriptionGenerationClientPort;

    render(<AudioDescriptionGenerationStatus project={project} store={store} client={client} uploadRecovery={null} />);

    await screen.findByText("Terminal recovery");
    expect(screen.queryByRole("button", { name: "Retry AD review" })).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps a lease-CAS-pending cancellation visible and retryable instead of treating it as completed", async () => {
    const project = projectWithEvidenceAndAnAiProposal();
    const receipt: AudioDescriptionGenerationReceipt = {
      ...receiptFor(project),
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: "pending",
        localLeaseRelease: "pending",
      },
    };
    const retryCancellationCleanup = vi.fn(async () => undefined);
    const store = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistAudioDescriptionGenerationReceipt: vi.fn(),
      loadAudioDescriptionGenerationReceipt: vi.fn(),
      adoptStagedAudioDescriptionGenerationResult: vi.fn(),
    } as unknown as AudioDescriptionGenerationProjectStore;
    const client = {
      start: vi.fn(),
      retry: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup,
      loadStoredReceipt: vi.fn(async () => receipt),
    } as unknown as AudioDescriptionGenerationClientPort;

    render(<AudioDescriptionGenerationStatus project={project} store={store} client={client} uploadRecovery={null} />);

    const retryCleanup = await screen.findByRole("button", { name: "Retry private cleanup" });
    expect(screen.getByText("Private cleanup pending")).toBeInTheDocument();
    await userEvent.click(retryCleanup);
    await waitFor(() => expect(retryCancellationCleanup).toHaveBeenCalledWith(expect.objectContaining({
      project,
      store,
      receipt,
    })));
  });
});
