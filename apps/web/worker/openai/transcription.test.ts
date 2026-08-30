import { describe, expect, it } from "vitest";
import {
  alignCaptionEvidence,
  normalizeForAlignment,
  transcribeCaptionEvidence,
  type CaptionEvidenceProvider,
} from "./transcription";

describe("two-pass caption evidence alignment", () => {
  it("normalizes text and deterministically retains both source-pass links", () => {
    const evidence = alignCaptionEvidence({
      text: "Gibbs free energy",
      durationMs: 1_000,
      segments: [
        { id: "speaker-a", startMs: 0, endMs: 500, speaker: "A", text: "Gibbs-free" },
        { id: "speaker-b", startMs: 500, endMs: 1_000, speaker: "B", text: "energy" },
      ],
    }, {
      text: "Gibbs free energy",
      words: [
        { text: "Gibbs", startMs: 0, endMs: 250 },
        { text: "free", startMs: 250, endMs: 500 },
        { text: "energy", startMs: 500, endMs: 1_000 },
      ],
    });

    expect(normalizeForAlignment("  GIBBS—free  ")).toBe("gibbs free");
    expect(evidence.words.map((word) => ({
      text: word.text,
      speaker: word.speaker,
      segmentIds: word.diarizationSegmentIds,
      normalizedText: word.normalizedText,
    }))).toEqual([
      { text: "Gibbs", speaker: "A", segmentIds: ["speaker-a"], normalizedText: "gibbs" },
      { text: "free", speaker: "A", segmentIds: ["speaker-a"], normalizedText: "free" },
      { text: "energy", speaker: "B", segmentIds: ["speaker-b"], normalizedText: "energy" },
    ]);
    expect(evidence.uncertaintySpans).toEqual([]);
  });

  it("creates deterministic uncertainty spans instead of inventing a speaker or transcript match", () => {
    const evidence = alignCaptionEvidence({
      text: "Alpha other",
      durationMs: 1_000,
      segments: [
        { id: "speaker-a", startMs: 0, endMs: 500, speaker: "A", text: "Alpha" },
        { id: "speaker-b", startMs: 500, endMs: 1_000, speaker: "B", text: "Other" },
      ],
    }, {
      text: "Alpha beta outside",
      words: [
        { text: "Alpha", startMs: 0, endMs: 500 },
        { text: "beta", startMs: 250, endMs: 750 },
        { text: "outside", startMs: 1_000, endMs: 1_100 },
      ],
    });

    expect(evidence.words[1]).toMatchObject({
      speaker: "A",
      diarizationSegmentIds: ["speaker-a", "speaker-b"],
    });
    expect(evidence.uncertaintySpans.map((span) => ({
      reason: span.reason,
      wordIds: span.wordIds,
      diarizationSegmentIds: span.diarizationSegmentIds,
    }))).toEqual([
      {
        reason: "AmbiguousSpeakerEvidence",
        wordIds: [evidence.words[1]!.id],
        diarizationSegmentIds: ["speaker-a", "speaker-b"],
      },
      {
        reason: "TranscriptDisagreement",
        wordIds: [evidence.words[1]!.id],
        diarizationSegmentIds: ["speaker-a", "speaker-b"],
      },
      {
        reason: "NoSpeakerEvidence",
        wordIds: [evidence.words[2]!.id],
        diarizationSegmentIds: [],
      },
    ]);
  });

  it("does not mark equal-overlap segments as a conflict when they agree on the same speaker", () => {
    const evidence = alignCaptionEvidence({
      text: "Hello",
      durationMs: 1_000,
      segments: [
        { id: "speaker-a-1", startMs: 0, endMs: 750, speaker: "A", text: "Hello" },
        { id: "speaker-a-2", startMs: 250, endMs: 1_000, speaker: "A", text: "Hello" },
      ],
    }, {
      text: "Hello",
      words: [{ text: "Hello", startMs: 250, endMs: 750 }],
    });

    expect(evidence.words[0]).toMatchObject({ speaker: "A", diarizationSegmentIds: ["speaker-a-1", "speaker-a-2"] });
    expect(evidence.uncertaintySpans).toEqual([]);
  });

  it("preserves raw response hashes and runs both provider passes as typed ports", async () => {
    const provider: CaptionEvidenceProvider = {
      diarize: async () => ({
        provider: "fixture",
        model: "diarize-fixture",
        requestHash: "0".repeat(64),
        responseHash: "a".repeat(64),
        rawResponseSha256: "a".repeat(64),
        store: null,
        background: null,
        usage: null,
        providerResponseId: null,
        value: {
          text: "Hello",
          durationMs: 1_000,
          segments: [{ id: "a", startMs: 0, endMs: 1_000, speaker: "A", text: "Hello" }],
        },
      }),
      wordTimestamps: async () => ({
        provider: "fixture",
        model: "words-fixture",
        requestHash: "1".repeat(64),
        responseHash: "b".repeat(64),
        rawResponseSha256: "b".repeat(64),
        store: null,
        background: null,
        usage: null,
        providerResponseId: null,
        value: {
          text: "Hello",
          words: [{ text: "Hello", startMs: 0, endMs: 1_000 }],
        },
      }),
    };

    const result = await transcribeCaptionEvidence(provider, {
      bytes: new Uint8Array([1]),
      contentType: "audio/wav",
      durationMs: 1_000,
      fileName: "normalized.wav",
    });

    expect(result.diarization.rawResponseSha256).toBe("a".repeat(64));
    expect(result.wordTimestamps.rawResponseSha256).toBe("b".repeat(64));
    expect(result.words).toHaveLength(1);
  });
});
