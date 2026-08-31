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
import { OpenAIProviderError } from "../openai/client";

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
  qualityProfileRules: { caption: { maxLineLength: 36, maxLineCount: 2 } },
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

  it("turns an OpenAI overlap-seam disagreement into retained timestamp uncertainty", () => {
    const aligned = alignSpeakerSegmentsToWords({
      runId: "shared-alignment-seam",
      speakerSegments: [{ id: "speaker-a", startMs: 4_000, endMs: 5_000, speaker: "chunk-1:A", text: "Seam" }],
      words: [{ startMs: 4_200, endMs: 4_500, text: "Seam", chunkSeamConflict: true }],
    });
    expect(aligned.words[0]).toMatchObject({ sourceText: "Seam" });
    expect(aligned.uncertaintySpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "timestamp-gap", evidenceIds: [aligned.words[0]!.evidenceId] }),
    ]));
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
    const staged = await store.stagedResult(request.runId);
    expect(staged?.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged).toMatchObject({
      runId: request.runId,
      expectedProjectRevision: request.expectedProjectRevision,
      expectedQualityProfileRevision: request.expectedQualityProfileRevision,
      targetTrack: "Captions",
      evidence: {
        preparedManifest: { sha256: digest("c") },
        provenance: expect.arrayContaining([
          expect.objectContaining({
            role: "reconciliation",
            provenanceVersion: 2,
            disposition: "executed",
            provider: "fixture",
            mode: "fixture",
            endpoint: expect.objectContaining({ method: "FIXTURE" }),
            qualityProfile: expect.objectContaining({ revision: request.expectedQualityProfileRevision, rulesSha256: expect.any(String) }),
            timing: expect.objectContaining({ durationMs: 0 }),
            usage: { kind: "unavailable", reason: "provider-usage-not-reported" },
            cost: { kind: "unavailable", reason: "provider-pricing-not-resolved" },
            sourceMediaSha256: request.mediaSha256,
            requestMetadata: expect.objectContaining({ structuredOutputSchemaSha256: digest("5") }),
            warnings: ["fixture reconciliation warning"],
          }),
        ]),
      },
    });
    expect(staged?.evidence.provenance.find((entry) => entry.role === "reconciliation")?.qualityProfile?.rulesSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records skipped reconciliation as an explicit no-provider disposition rather than synthetic provider provenance", async () => {
    const store = new InMemoryGenerationRunStore();
    const skipped = { ...request, runId: "run-caption-skipped-reconciliation" };
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      reconciliation: {
        reconcile: async ({ alignedWords }) => ({
          words: alignedWords,
          provenance: {
            model: "not-invoked",
            requestHash: digest("7"),
            responseHash: digest("8"),
            store: false,
            requestMetadata: { disposition: "skipped-no-uncertainty" },
            warnings: [],
            disposition: "skipped",
            skippedReason: "no-uncertainty",
          },
        }),
      },
    });

    await runner.run(skipped);

    expect((await store.stagedResult(skipped.runId))?.evidence.provenance.find((entry) => entry.role === "reconciliation")).toMatchObject({
      disposition: "skipped",
      skippedReason: "no-uncertainty",
      provider: null,
      mode: null,
      endpoint: null,
      timing: null,
      usage: { kind: "unavailable", reason: "provider-not-invoked" },
      cost: { kind: "unavailable", reason: "provider-not-invoked" },
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

  it("fails before staging when a contract-valid multibyte package exceeds the exact 6 MiB canonical UTF-8 budget", async () => {
    const store = new InMemoryGenerationRunStore();
    const longText = "é".repeat(1_000);
    const words = Array.from({ length: 2_700 }, (_unused, index) => ({
      startMs: index * 10,
      endMs: index * 10 + 5,
      // 1,000 UTF-16 code units but 2,000 UTF-8 bytes. The normal retained
      // sourceText makes this a realistic worst-case canonical package.
      text: longText,
    }));
    const runner = new CaptionGenerationRunner(store, {
      ...dependencies(),
      transcription: {
        diarize: async () => ({
          speakerSegments: words.map((word, index) => ({
            id: `speaker-${index}`,
            startMs: word.startMs,
            endMs: word.endMs,
            speaker: "Speaker 1",
            text: longText,
          })),
          provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("e"), responseHash: digest("f") },
        }),
        wordTimestamps: async () => ({
          words,
          provenance: { model: "whisper-1", requestHash: digest("1"), responseHash: digest("2") },
        }),
      },
      reconciliation: {
        reconcile: async ({ alignedWords }) => ({
          words: alignedWords.map((word) => ({ ...word, text: "w" })),
          provenance: {
            model: "gpt-5.6-terra",
            requestHash: digest("3"),
            responseHash: digest("4"),
            store: false,
          },
        }),
      },
    });
    const oversized = { ...request, runId: "run-caption-multibyte-package" };

    await runner.run(oversized);

    expect(store.stageHistory(oversized.runId).at(-1)).toMatchObject({
      stage: "Failed",
      message: expect.stringContaining("6 MiB"),
    });
    await expect(store.stagedResult(oversized.runId)).resolves.toBeNull();
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

  it("fails before provider work when a prepared manifest points at a non-canonical audio object", async () => {
    const store = new InMemoryGenerationRunStore();
    const source = dependencies();
    const diarize = vi.fn(source.transcription.diarize);
    const wordTimestamps = vi.fn(source.transcription.wordTimestamps);
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      artifacts: {
        readManifest: async () => ({
          source: { sha256: digest("a"), byteLength: request.sourceByteLength, durationMs: request.sourceDurationMs },
          normalizedAudio: {
            // The content hash in the path must be exactly the manifest's
            // audio digest; a sibling prepared object is not interchangeable.
            key: `prepared/${request.operation.operationKey}/audio/${digest("e")}.wav`,
            sha256: digest("d"),
            byteLength: 128,
            durationMs: request.sourceDurationMs,
            contentType: "audio/wav",
          },
        }),
      },
      transcription: { diarize, wordTimestamps },
    });

    await runner.run({ ...request, runId: "run-caption-audio-key-mismatch" });

    expect(store.stageHistory("run-caption-audio-key-mismatch").at(-1)).toMatchObject({ stage: "Failed" });
    expect(diarize).not.toHaveBeenCalled();
    expect(wordTimestamps).not.toHaveBeenCalled();
  });

  it("fails closed rather than replaying a word-timestamp call with an unknown outcome", async () => {
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

    await runner.run({ ...request, runId: "run-caption-pass-resume" });
    await runner.run({ ...request, runId: "run-caption-pass-resume" });

    expect(diarize).toHaveBeenCalledTimes(1);
    expect(wordTimestamps).toHaveBeenCalledTimes(1);
    expect(store.stageHistory("run-caption-pass-resume").at(-1)).toMatchObject({
      stage: "Failed",
      retryable: false,
      message: expect.stringContaining("cannot safely replay"),
    });
    await expect(store.stagedResult("run-caption-pass-resume")).resolves.toBeNull();
    await expect(store.read("run-caption-pass-resume")).resolves.toMatchObject({
      providerAttempts: expect.arrayContaining([
        expect.objectContaining({ pass: "word-timestamps", state: "accepted-unknown" }),
      ]),
    });
  });

  it.each([
    ["an HTTP-200 oversized body", new OpenAIProviderError("oversized 200 response", false, "accepted-unknown")],
    ["an incomplete Responses status", new OpenAIProviderError("Responses still in progress", false, "accepted-unknown")],
    ["a generic HTTP-5xx", new OpenAIProviderError("gateway 503 after possible acceptance", true, "accepted-unknown")],
  ] as const)("makes exactly one provider call for %s", async (_description, providerFailure) => {
    const store = new InMemoryGenerationRunStore();
    const source = dependencies();
    const wordTimestamps = vi.fn()
      .mockRejectedValueOnce(providerFailure)
      .mockResolvedValue(source.transcription.wordTimestamps);
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      transcription: { diarize: source.transcription.diarize, wordTimestamps },
    });
    const runId = `run-caption-no-replay-${providerFailure.message.replace(/[^a-z]+/giu, "-")}`;

    await runner.run({ ...request, runId });
    await runner.run({ ...request, runId });

    expect(wordTimestamps).toHaveBeenCalledTimes(1);
    await expect(store.read(runId)).resolves.toMatchObject({
      providerAttempts: expect.arrayContaining([
        expect.objectContaining({ pass: "word-timestamps", state: "accepted-unknown" }),
      ]),
    });
    expect(store.stageHistory(runId).at(-1)).toMatchObject({ stage: "Failed", retryable: false });
  });

  it("journals each actual WAV chunk and resumes at a retryable second chunk without replaying chunk one", async () => {
    const store = new InMemoryGenerationRunStore();
    const source = dependencies();
    const chunkRequests = [
      { requestKey: "chunk-1", index: 0, offsetMs: 0, endMs: 15_500, overlapWithPreviousMs: 0 },
      { requestKey: "chunk-2", index: 1, offsetMs: 14_500, endMs: 31_000, overlapWithPreviousMs: 1_000 },
    ] as const;
    const diarizationCalls: string[] = [];
    const wordCalls: string[] = [];
    let secondDiarizationAttempt = 0;
    const stepKeys: string[] = [];
    const resumable = {
      requests: async () => chunkRequests,
      diarizeRequest: async ({ request: chunk }: { readonly request: { readonly requestKey: string; readonly index: number; readonly offsetMs: number; readonly endMs: number; readonly overlapWithPreviousMs: number } }) => {
        diarizationCalls.push(chunk.requestKey);
        if (chunk.requestKey === "chunk-2" && secondDiarizationAttempt++ === 0) {
          throw new OpenAIProviderError("known OpenAI 429 before diarization acceptance", true, "safe-to-replay");
        }
        return {
          speakerSegments: [{
            id: `segment-${chunk.index + 1}`,
            startMs: chunk.offsetMs,
            endMs: Math.min(chunk.endMs, chunk.offsetMs + 1_000),
            speaker: "Speaker 1",
            text: `chunk ${chunk.index + 1}`,
          }],
          provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest(String(chunk.index + 3)), responseHash: digest(String(chunk.index + 5)) },
        };
      },
      wordTimestampRequest: async ({ request: chunk }: { readonly request: { readonly requestKey: string; readonly index: number; readonly offsetMs: number; readonly endMs: number; readonly overlapWithPreviousMs: number } }) => {
        wordCalls.push(chunk.requestKey);
        return {
          words: [{ startMs: chunk.offsetMs, endMs: Math.min(chunk.endMs, chunk.offsetMs + 450), text: `word-${chunk.index + 1}` }],
          provenance: { model: "whisper-1", requestHash: digest(chunk.index === 0 ? "7" : "8"), responseHash: digest(chunk.index === 0 ? "9" : "a") },
        };
      },
      aggregateDiarization: async ({ results }: { readonly results: readonly { readonly requestKey: string; readonly value: { readonly speakerSegments: readonly { readonly id?: string; readonly startMs: number; readonly endMs: number; readonly speaker: string; readonly text: string }[] } }[] }) => ({
        speakerSegments: results.flatMap((result) => result.value.speakerSegments),
        provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("d"), responseHash: digest("e") },
      }),
      aggregateWordTimestamps: async ({ results }: { readonly results: readonly { readonly requestKey: string; readonly value: { readonly words: readonly { readonly startMs: number; readonly endMs: number; readonly text: string }[] } }[] }) => ({
        words: results.flatMap((result) => result.value.words),
        provenance: { model: "whisper-1", requestHash: digest("f"), responseHash: digest("0") },
      }),
    };
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      transcription: { ...source.transcription, resumable },
    }, {
      run: async (_pass, requestKey, work) => {
        stepKeys.push(requestKey);
        return work();
      },
    });
    const resumableRequest = { ...request, runId: "run-caption-two-wav-chunks" };

    await expect(runner.run(resumableRequest)).rejects.toMatchObject({ retryable: true });
    expect(diarizationCalls).toEqual(["chunk-1", "chunk-2"]);
    await expect(store.read(resumableRequest.runId)).resolves.toMatchObject({
      diarizationChunks: [expect.objectContaining({ requestKey: "chunk-1" })],
      providerAttempts: expect.arrayContaining([
        expect.objectContaining({ pass: "diarization", requestKey: "chunk-1", state: "completed" }),
        expect.objectContaining({ pass: "diarization", requestKey: "chunk-2", state: "retryable-failed" }),
      ]),
    });

    await runner.run(resumableRequest);

    expect(diarizationCalls).toEqual(["chunk-1", "chunk-2", "chunk-2"]);
    expect(wordCalls).toEqual(["chunk-1", "chunk-2"]);
    expect(stepKeys).toEqual(expect.arrayContaining(["chunk-1", "chunk-2"]));
    const completed = await store.read(resumableRequest.runId);
    expect(completed).toMatchObject({ stageHistory: expect.arrayContaining([expect.objectContaining({ stage: "AwaitingAdoption" })]) });
    expect(completed).not.toHaveProperty("diarizationChunks");
    expect(completed).not.toHaveProperty("wordTimestampChunks");
  });

  it("journals every reconciliation window and resumes with only the retryable incomplete window", async () => {
    const store = new InMemoryGenerationRunStore();
    const resumableRequest = { ...request, runId: "run-caption-two-reconciliation-windows" };
    const initial = await store.initialise(resumableRequest);
    const words = Array.from({ length: 100 }, (_unused, index) => ({
      evidenceId: `word-${index + 1}`,
      sourceWordIndex: index,
      startMs: index * 200,
      endMs: index * 200 + 150,
      text: `word-${index + 1}`,
      sourceText: `word-${index + 1}`,
      speaker: "Speaker 1",
      speakerSegmentIds: ["speaker-1"],
    }));
    await store.save({
      ...initial,
      preparedManifest: { key: `prepared/${resumableRequest.operation.operationKey}/manifests/${digest("c")}.json`, sha256: digest("c") },
      manifest: {
        source: { sha256: resumableRequest.mediaSha256, byteLength: resumableRequest.sourceByteLength, durationMs: resumableRequest.sourceDurationMs },
        normalizedAudio: { key: `prepared/${resumableRequest.operation.operationKey}/audio/${digest("d")}.wav`, sha256: digest("d"), byteLength: 128, durationMs: resumableRequest.sourceDurationMs, contentType: "audio/wav" },
      },
      diarization: {
        speakerSegments: [{ id: "speaker-1", startMs: 0, endMs: resumableRequest.sourceDurationMs, speaker: "Speaker 1", text: "all words" }],
        provenance: { model: "gpt-4o-transcribe-diarize", requestHash: digest("1"), responseHash: digest("2") },
      },
      wordTimestamps: { words, provenance: { model: "whisper-1", requestHash: digest("3"), responseHash: digest("4") } },
      aligned: {
        words,
        uncertaintySpans: [
          { uncertaintyId: "uncertainty-1", startMs: 0, endMs: 150, reason: "text-conflict", evidenceIds: ["word-1"] },
          { uncertaintyId: "uncertainty-2", startMs: 12_000, endMs: 12_150, reason: "text-conflict", evidenceIds: ["word-61"] },
        ],
      },
    });
    const source = dependencies();
    const reconciliationCalls: string[] = [];
    let secondWindowAttempt = 0;
    const windows = [
      { requestKey: "window-1", window: { windowId: "window-one", allowedWordIds: ["word-1"], words: [] } },
      { requestKey: "window-2", window: { windowId: "window-two", allowedWordIds: ["word-61"], words: [] } },
    ] as const;
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      reconciliation: {
        ...source.reconciliation,
        resumable: {
          requests: async () => windows,
          reconcileRequest: async ({ request: window }) => {
            reconciliationCalls.push(window.requestKey);
            if (window.requestKey === "window-2" && secondWindowAttempt++ === 0) {
              throw new OpenAIProviderError("known Responses API 429 before acceptance", true, "safe-to-replay");
            }
            return {
              requestKey: window.requestKey,
              windowId: window.window.windowId,
              replacements: [],
              provenance: { provider: "fixture", model: "gpt-5.6-terra", requestHash: digest(window.requestKey === "window-1" ? "5" : "6"), responseHash: digest(window.requestKey === "window-1" ? "7" : "8"), rawResponseSha256: digest(window.requestKey === "window-1" ? "7" : "8"), store: false, background: false, usage: null, providerResponseId: null },
            };
          },
          aggregate: async ({ alignedWords, results }) => ({
            words: alignedWords,
            provenance: {
              model: "gpt-5.6-terra",
              requestHash: digest("9"),
              responseHash: digest("a"),
              store: false,
              requestMetadata: { windowCount: String(results.length) },
            },
          }),
        },
      },
    });

    await expect(runner.run(resumableRequest)).rejects.toMatchObject({ retryable: true });
    expect(reconciliationCalls).toEqual(["window-1", "window-2"]);
    await expect(store.read(resumableRequest.runId)).resolves.toMatchObject({
      reconciliationWindows: [expect.objectContaining({ requestKey: "window-1" })],
      providerAttempts: expect.arrayContaining([
        expect.objectContaining({ pass: "reconciliation", requestKey: "window-1", state: "completed" }),
        expect.objectContaining({ pass: "reconciliation", requestKey: "window-2", state: "retryable-failed" }),
      ]),
    });

    await runner.run(resumableRequest);

    expect(reconciliationCalls).toEqual(["window-1", "window-2", "window-2"]);
    const completed = await store.read(resumableRequest.runId);
    expect(completed).toMatchObject({ stageHistory: expect.arrayContaining([expect.objectContaining({ stage: "AwaitingAdoption" })]) });
    expect(completed).not.toHaveProperty("reconciliationWindows");
  });

  it("uses a durable Workflow step result to finish a checkpoint that crashed after provider acceptance", async () => {
    const durable = new InMemoryGenerationRunStore();
    let failCheckpointOnce = true;
    const store: GenerationRunStore = {
      initialise: (input) => durable.initialise(input),
      read: (runId) => durable.read(runId),
      cancel: (runId) => durable.cancel(runId),
      save: async (run) => {
        if (
          failCheckpointOnce
          && run.diarization !== undefined
          && run.providerAttempts?.find((attempt) => attempt.pass === "diarization")?.state === "completed"
        ) {
          failCheckpointOnce = false;
          throw new Error("simulated crash after provider acceptance before local checkpoint");
        }
        await durable.save(run);
      },
    };
    const source = dependencies();
    const diarize = vi.fn(source.transcription.diarize);
    const cache = new Map<string, unknown>();
    const workflowSteps = {
      run: async <Value>(pass: string, requestKey: string, work: () => Promise<Value>): Promise<Value> => {
        const cacheKey = `${pass}:${requestKey}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey) as Value;
        const result = await work();
        cache.set(cacheKey, result);
        return result;
      },
    };
    const runner = new CaptionGenerationRunner(store, {
      ...source,
      transcription: { ...source.transcription, diarize },
    }, workflowSteps);
    const crashed = { ...request, runId: "run-caption-step-checkpoint-recovery" };

    await runner.run(crashed);
    expect((await durable.read(crashed.runId))?.stageHistory.at(-1)).toMatchObject({ stage: "Failed" });
    expect(diarize).toHaveBeenCalledTimes(1);
    await expect(durable.stagedResult(crashed.runId)).resolves.toBeNull();

    await runner.run(crashed);
    expect(diarize).toHaveBeenCalledTimes(1);
    expect(await durable.stagedResult(crashed.runId)).not.toBeNull();
    await expect(durable.read(crashed.runId)).resolves.toMatchObject({
      providerAttempts: expect.arrayContaining([
        expect.objectContaining({ pass: "diarization", state: "completed" }),
      ]),
      stageHistory: expect.arrayContaining([expect.objectContaining({ stage: "AwaitingAdoption" })]),
    });
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
