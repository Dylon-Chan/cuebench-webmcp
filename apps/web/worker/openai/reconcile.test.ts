import { describe, expect, it, vi } from "vitest";
import { reconcileCaptionEvidence } from "./reconcile";
import { alignCaptionEvidence } from "./transcription";

const uncertainEvidence = () => alignCaptionEvidence({
  text: "Gibbs energy",
  durationMs: 1_500,
  segments: [
    { id: "a", startMs: 0, endMs: 1_500, speaker: "A", text: "Gibbs energy" },
  ],
}, {
  text: "Gibbs energee outside",
  words: [
    { text: "Gibbs", startMs: 0, endMs: 500 },
    { text: "energee", startMs: 500, endMs: 1_000 },
    { text: "outside", startMs: 1_500, endMs: 1_600 },
  ],
});

describe("bounded evidence reconciliation", () => {
  it("only permits replacements for evidence-linked ids in a bounded window", async () => {
    const evidence = uncertainEvidence();
    const reconcile = vi.fn(async (request) => ({
      provider: "fixture" as const,
      model: "gpt-5.6-terra",
      requestHash: "a".repeat(64),
      responseHash: "c".repeat(64),
      rawResponseSha256: "c".repeat(64),
      store: false as const,
      background: false as const,
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, audioSeconds: null },
      providerResponseId: "resp-test",
      requestMetadata: { structuredOutputSchemaSha256: "a".repeat(64) },
      warnings: ["provider fixture warning"],
      value: { replacements: [{ wordId: request.allowedWordIds[0]!, text: "energy" }] },
    }));

    const result = await reconcileCaptionEvidence({ reconcile }, evidence);

    expect(reconcile).toHaveBeenCalledTimes(1);
    const request = reconcile.mock.calls[0]![0];
    expect(request.words.length).toBeLessThanOrEqual(48);
    expect(request.allowedWordIds).toContain(evidence.words[1]!.id);
    expect(result.words[1]).toMatchObject({
      text: "energy",
      reconciledFrom: "energee",
      diarizationSegmentIds: ["a"],
    });
    expect(result.provenance[0]).toMatchObject({
      model: "gpt-5.6-terra",
      rawResponseSha256: "c".repeat(64),
      requestMetadata: { structuredOutputSchemaSha256: "a".repeat(64) },
      warnings: ["provider fixture warning"],
    });
  });

  it("rejects an output that tries to modify a word outside the supplied evidence window", async () => {
    const evidence = uncertainEvidence();

    await expect(reconcileCaptionEvidence({
      reconcile: async () => ({
        provider: "fixture",
        model: "gpt-5.6-terra",
        requestHash: "a".repeat(64),
        responseHash: "d".repeat(64),
        rawResponseSha256: "d".repeat(64),
        store: false,
        background: false,
        usage: null,
        providerResponseId: null,
        value: { replacements: [{ wordId: "foreign-word", text: "unsafe" }] },
      }),
    }, evidence)).rejects.toThrow(/evidence-linked/i);
  });

  it("does not call a reasoning provider when deterministic alignment has no uncertainty", async () => {
    const evidence = alignCaptionEvidence({
      text: "Hello",
      durationMs: 1_000,
      segments: [{ id: "a", startMs: 0, endMs: 1_000, speaker: "A", text: "Hello" }],
    }, {
      text: "Hello",
      words: [{ text: "Hello", startMs: 0, endMs: 1_000 }],
    });
    const reconcile = vi.fn();

    await expect(reconcileCaptionEvidence({ reconcile }, evidence)).resolves.toMatchObject({
      words: [{ text: "Hello", reconciledFrom: null }],
      provenance: [],
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
