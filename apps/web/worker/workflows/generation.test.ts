import { describe, expect, it, vi } from "vitest";
import {
  CaptionGenerationRunner,
  InMemoryGenerationRunStore,
  alignSpeakerSegmentsToWords,
  segmentEducationCaptions,
  type CaptionGenerationDependencies,
  type GenerationStartRequest,
  type GenerationRunStore,
} from "./generation";

const digest = (character: string) => character.repeat(64);

const request: GenerationStartRequest = {
  runId: "run-caption-1",
  projectId: "project-caption-1",
  expectedProjectRevision: 4,
  expectedQualityProfileRevision: 2,
  targetTrack: "Captions",
  mediaSha256: digest("a"),
  sourceByteLength: 100,
  sourceDurationMs: 31_000,
  operation: {
    operationId: "operation-caption-1",
    operationKey: digest("a"),
    objectKey: `processing/${digest("b")}/${digest("a")}`,
    inputByteLength: 100,
    inputContentType: "video/webm",
    operationReceipt: "receipt-caption-1",
    receiptExpiresAtMs: 1_700_000_060_000,
  },
};

const dependencies = (prepare = vi.fn(async () => ({
  key: `prepared/${request.operation.operationKey}/manifests/${digest("c")}.json`,
  sha256: digest("c"),
}))): CaptionGenerationDependencies => ({
  preparation: { prepare },
  artifacts: {
    readManifest: async () => ({
      source: {
        sha256: digest("a"),
        byteLength: 100,
        durationMs: 31_000,
      },
      normalizedAudio: {
        key: `prepared/${request.operation.operationKey}/audio/${digest("d")}.wav`,
        sha256: digest("d"),
        byteLength: 128,
        durationMs: 31_000,
        contentType: "audio/wav",
      },
    }),
  },
  transcription: {
    diarize: async () => ({
      speakerSegments: [{ startMs: 0, endMs: 1_000, speaker: "Speaker 1", text: "Welcome back" }],
      provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("e"), responseHash: digest("f") },
    }),
    wordTimestamps: async () => ({
      words: [
        { startMs: 0, endMs: 450, text: "Welcome" },
        { startMs: 500, endMs: 1_000, text: "back" },
      ],
      provenance: { model: "whisper-1", requestHash: digest("1"), responseHash: digest("2") },
    }),
  },
  reconciliation: {
    reconcile: async ({ alignedWords }) => ({
      words: alignedWords,
      provenance: {
        model: "gpt-5.6-terra",
        requestHash: digest("3"),
        responseHash: digest("4"),
        store: false,
        requestMetadata: { structuredOutputSchemaSha256: digest("5"), instructionsSha256: digest("6") },
        warnings: ["fixture reconciliation warning"],
      },
    }),
  },
  clock: () => 1_700_000_000_000,
});

describe("CaptionGenerationRunner", () => {
  it("uses the shared two-pass alignment semantics for same-speaker overlap and disagreement", () => {
    const sameSpeaker = alignSpeakerSegmentsToWords({
      runId: "shared-alignment",
      speakerSegments: [
        { id: "speaker-a-1", startMs: 0, endMs: 750, speaker: "A", text: "Hello" },
        { id: "speaker-a-2", startMs: 250, endMs: 1_000, speaker: "A", text: "Hello" },
      ],
      words: [{ startMs: 250, endMs: 750, text: "Hello" }],
    });
    expect(sameSpeaker).toMatchObject({
      words: [{ speaker: "A", speakerSegmentIds: ["speaker-a-1", "speaker-a-2"] }],
      uncertaintySpans: [],
    });
    const disagreement = alignSpeakerSegmentsToWords({
      runId: "shared-alignment-disagreement",
      speakerSegments: [{ id: "speaker-a", startMs: 0, endMs: 1_000, speaker: "A", text: "Other" }],
      words: [{ startMs: 0, endMs: 1_000, text: "Hello" }],
    });
    expect(disagreement.uncertaintySpans).toMatchObject([{ reason: "text-conflict" }]);
  });

  it("clamps close and EOF caption boundaries to authoritative duration without overlap", () => {
    const words = [
      { evidenceId: "word-1", sourceWordIndex: 0, startMs: 8_700, endMs: 8_900, text: "One", speaker: "A", speakerSegmentIds: [] },
      { evidenceId: "word-2", sourceWordIndex: 1, startMs: 9_000, endMs: 9_800, text: "Two", speaker: "B", speakerSegmentIds: [] },
    ];
    const captions = segmentEducationCaptions({
      runId: "segmentation-eof",
      words,
      durationMs: 10_000,
      profileRules: { caption: { minDurationMs: 1_500, maxDurationMs: 5_000, maxLineLength: 36, maxLineCount: 2 } },
    });

    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatchObject({ startMs: 8_700, endMs: 9_000 });
    expect(captions[1]).toMatchObject({ startMs: 9_000, endMs: 10_000 });
    expect(captions[0]!.endMs).toBeLessThanOrEqual(captions[1]!.startMs);
  });

  it("repartitions overlapping source words instead of staging overlapping caption cues", () => {
    const captions = segmentEducationCaptions({
      runId: "segmentation-overlap",
      durationMs: 10_000,
      profileRules: { caption: { maxLineLength: 3, maxLineCount: 1 } },
      words: [
        { evidenceId: "word-1", sourceWordIndex: 0, startMs: 1_000, endMs: 2_000, text: "First", speaker: "A", speakerSegmentIds: [] },
        { evidenceId: "word-2", sourceWordIndex: 1, startMs: 1_500, endMs: 2_500, text: "Second", speaker: "B", speakerSegmentIds: [] },
      ],
    });

    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({ startMs: 1_000, endMs: 2_500, evidenceIds: ["word-1", "word-2"] });
  });

  it("persists every durable stage, prepares media only inside the run, and resumes without a second provider call", async () => {
    const store = new InMemoryGenerationRunStore();
    const prepare = vi.fn(async () => ({
      key: `prepared/${request.operation.operationKey}/manifests/${digest("c")}.json`,
      sha256: digest("c"),
    }));
    const runner = new CaptionGenerationRunner(store, dependencies(prepare));

    await runner.run(request);
    await runner.run(request);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(store.stageHistory(request.runId).map((entry) => entry.stage)).toEqual([
      "Queued",
      "PreparingMedia",
      "Transcribing",
      "AligningEvidence",
      "ReconcilingTranscript",
      "SegmentingCaptions",
      "AwaitingAdoption",
    ]);
    expect(await store.stagedResult(request.runId)).toMatchObject({
      runId: request.runId,
      expectedProjectRevision: request.expectedProjectRevision,
      expectedQualityProfileRevision: request.expectedQualityProfileRevision,
      targetTrack: "Captions",
      evidence: {
        preparedManifest: { sha256: digest("c") },
        provenance: expect.arrayContaining([
          expect.objectContaining({
            role: "reconciliation",
            requestMetadata: expect.objectContaining({ structuredOutputSchemaSha256: digest("5") }),
            warnings: ["fixture reconciliation warning"],
          }),
        ]),
      },
    });
  });

  it("cancels between durable stages and never writes a partial staged result", async () => {
    const store = new InMemoryGenerationRunStore();
    const cancelledRequest = { ...request, runId: "run-caption-cancelled" };
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      transcription: {
        diarize: async () => ({
          speakerSegments: [{ startMs: 0, endMs: 1_000, speaker: "Speaker 1", text: "Welcome back" }],
          provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("e"), responseHash: digest("f") },
        }),
        wordTimestamps: async () => {
          await store.cancel(cancelledRequest.runId);
          return {
            words: [],
            provenance: { model: "whisper-1", requestHash: digest("1"), responseHash: digest("2") },
          };
        },
      },
    });

    await runner.run(cancelledRequest);

    expect(store.stageHistory("run-caption-cancelled").at(-1)).toMatchObject({ stage: "Cancelled" });
    await expect(store.stagedResult("run-caption-cancelled")).resolves.toBeNull();
  });

  it("fails before staging when complete evidence would exceed the bounded Local Evidence Package", async () => {
    const store = new InMemoryGenerationRunStore();
    const oversizedWords = Array.from({ length: 5_001 }, (_unused, index) => ({
      startMs: index * 5,
      endMs: index * 5 + 4,
      text: "word",
    }));
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      transcription: {
        diarize: async () => ({
          speakerSegments: [{ startMs: 0, endMs: request.sourceDurationMs, speaker: "Speaker 1", text: "word" }],
          provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("e"), responseHash: digest("f") },
        }),
        wordTimestamps: async () => ({
          words: oversizedWords,
          provenance: { model: "whisper-1", requestHash: digest("1"), responseHash: digest("2") },
        }),
      },
    });

    await runner.run({ ...request, runId: "run-caption-oversized-evidence" });

    expect(store.stageHistory("run-caption-oversized-evidence").at(-1)).toMatchObject({
      stage: "Failed",
      message: expect.stringContaining("Local Evidence Package"),
    });
    await expect(store.stagedResult("run-caption-oversized-evidence")).resolves.toBeNull();
  });

  it("fails before either transcription provider call when the authoritative prepared manifest disagrees with signed media", async () => {
    const store = new InMemoryGenerationRunStore();
    const source = dependencies();
    const diarize = vi.fn(source.transcription.diarize);
    const wordTimestamps = vi.fn(source.transcription.wordTimestamps);
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      artifacts: {
        readManifest: async () => ({
          source: { sha256: digest("b"), byteLength: request.sourceByteLength, durationMs: request.sourceDurationMs },
          normalizedAudio: {
            key: `prepared/${request.operation.operationKey}/audio/${digest("d")}.wav`,
            sha256: digest("d"),
            byteLength: 128,
            durationMs: 31_000,
            contentType: "audio/wav",
          },
        }),
      },
      transcription: { diarize, wordTimestamps },
    });

    await runner.run({ ...request, runId: "run-caption-manifest-mismatch" });

    expect(store.stageHistory("run-caption-manifest-mismatch").at(-1)).toMatchObject({ stage: "Failed" });
    expect(diarize).not.toHaveBeenCalled();
    expect(wordTimestamps).not.toHaveBeenCalled();
    await expect(store.stagedResult("run-caption-manifest-mismatch")).resolves.toBeNull();
  });

  it("resumes the unfinished word-timestamp pass without repeating a persisted diarization call", async () => {
    const store = new InMemoryGenerationRunStore();
    const diarize = vi.fn(dependencies().transcription.diarize);
    const wordTimestamps = vi.fn();
    wordTimestamps
      .mockRejectedValueOnce(Object.assign(new Error("temporary word-timestamp provider failure"), { retryable: true }))
      .mockResolvedValue({
        words: [
          { startMs: 0, endMs: 450, text: "Welcome" },
          { startMs: 500, endMs: 1_000, text: "back" },
        ],
        provenance: { model: "whisper-1", requestHash: digest("1"), responseHash: digest("2") },
      });
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      transcription: { diarize, wordTimestamps },
    });

    await expect(runner.run({ ...request, runId: "run-caption-pass-resume" })).rejects.toThrow("temporary word-timestamp provider failure");
    await runner.run({ ...request, runId: "run-caption-pass-resume" });

    expect(diarize).toHaveBeenCalledTimes(1);
    expect(wordTimestamps).toHaveBeenCalledTimes(2);
    expect(await store.stagedResult("run-caption-pass-resume")).not.toBeNull();
  });

  it("atomically publishes staged evidence with AwaitingAdoption and promotes a pre-existing interrupted staged state on resume", async () => {
    const durable = new InMemoryGenerationRunStore();
    let simulateInterruptedLegacyWrite = true;
    const store: GenerationRunStore = {
      initialise: (input) => durable.initialise(input),
      read: (runId) => durable.read(runId),
      cancel: (runId) => durable.cancel(runId),
      save: async (run) => {
        if (simulateInterruptedLegacyWrite && run.staged !== undefined && run.stageHistory.at(-1)?.stage === "AwaitingAdoption") {
          simulateInterruptedLegacyWrite = false;
          // Simulate a record from the former two-write implementation: the
          // complete result persisted, but the adoption stage did not.
          await durable.save({ ...run, stageHistory: run.stageHistory.slice(0, -1) });
          return;
        }
        await durable.save(run);
      },
    };
    const source = dependencies();
    const diarize = vi.fn(source.transcription.diarize);
    const wordTimestamps = vi.fn(source.transcription.wordTimestamps);
    const reconcile = vi.fn(source.reconciliation.reconcile);
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      transcription: { diarize, wordTimestamps },
      reconciliation: { reconcile },
    });
    const interrupted = { ...request, runId: "run-caption-stage-recovery" };

    await runner.run(interrupted);
    expect((await durable.read(interrupted.runId))?.stageHistory.at(-1)?.stage).toBe("SegmentingCaptions");
    expect(await durable.stagedResult(interrupted.runId)).not.toBeNull();

    await runner.run(interrupted);
    expect((await durable.read(interrupted.runId))?.stageHistory.at(-1)?.stage).toBe("AwaitingAdoption");
    expect(diarize).toHaveBeenCalledTimes(1);
    expect(wordTimestamps).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("records a terminal failure without staging a partial result and uses the leased quality-profile snapshot for deterministic segmentation", async () => {
    const store = new InMemoryGenerationRunStore();
    const failedRequest = {
      ...request,
      runId: "run-caption-failed",
      qualityProfileRules: { caption: { maxLineLength: 3, maxLineCount: 1 } },
    };
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      reconciliation: {
        reconcile: async () => { throw new Error("fixture reconciliation failure"); },
      },
    });

    await runner.run(failedRequest);

    expect(store.stageHistory(failedRequest.runId).at(-1)).toMatchObject({
      stage: "Failed",
      code: "GENERATION_STAGE_FAILED",
    });
    await expect(store.stagedResult(failedRequest.runId)).resolves.toBeNull();

    const segmentedStore = new InMemoryGenerationRunStore();
    const snapshotRunner = new CaptionGenerationRunner(segmentedStore, dependencies());
    await snapshotRunner.run({ ...failedRequest, runId: "run-caption-profile" });
    expect((await segmentedStore.stagedResult("run-caption-profile"))?.captions).toHaveLength(2);
  });
});
