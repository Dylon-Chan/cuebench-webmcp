import { describe, expect, it, vi } from "vitest";
import {
  MAX_OPENAI_TRANSCRIPTION_BYTES,
  OpenAIProviderError,
  OPENAI_TRANSCRIPTION_CHUNK_HEADROOM_BYTES,
  createOpenAIProvider,
  reconcileChunkSeamWords,
  splitWavForOpenAITranscription,
} from "./client";

const audio = {
  bytes: new TextEncoder().encode("private normalized audio"),
  contentType: "audio/wav",
  durationMs: 31_001,
  fileName: "normalized.wav",
} as const;

const pcmWav = (durationMs: number, sampleRate = 16_000): Uint8Array => {
  const frames = Math.floor((durationMs * sampleRate) / 1_000);
  const dataBytes = frames * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
};

describe("CueBench OpenAI provider boundary", () => {
  it("fails closed when live mode lacks a server-side credential", () => {
    expect(() => createOpenAIProvider({ CUEBENCH_OPENAI_MODE: "live" })).toThrow(/server-side credentials/i);
  });

  it("defaults to deterministic fixtures and never reaches a network binding", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createOpenAIProvider({}, { fetch });

    const result = await provider.diarize(audio);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.model).toBe("fixture");
    expect(result.rawResponseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.segments).not.toHaveLength(0);
  });

  it("uses the exact two-pass transcription contracts only after explicit live opt-in", async () => {
    const requests: Request[] = [];
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async (request) => {
        requests.push(request);
        const model = (await request.clone().formData()).get("model");
        return new Response(JSON.stringify(model === "gpt-4o-transcribe-diarize"
          ? {
              duration: 31.001,
              segments: [{ id: "segment-a", start: 0, end: 1, speaker: "A", text: "Hello" }],
              text: "Hello",
              usage: { seconds: 31.001, type: "duration" },
            }
          : {
              text: "Hello",
              words: [{ word: "Hello", start: 0, end: 1 }],
              usage: { seconds: 31.001, type: "duration" },
            }), { headers: { "content-type": "application/json" } });
      },
    });

    const diarization = await provider.diarize(audio);
    const wordTimestamps = await provider.wordTimestamps(audio);

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.openai.com/v1/audio/transcriptions",
      "https://api.openai.com/v1/audio/transcriptions",
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer server-only-test-key",
      "Bearer server-only-test-key",
    ]);

    const diarizationForm = await requests[0]!.formData();
    expect(diarizationForm.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(diarizationForm.get("response_format")).toBe("diarized_json");
    expect(diarizationForm.get("chunking_strategy")).toBe("auto");
    expect(diarizationForm.getAll("timestamp_granularities[]")).toEqual([]);

    const wordForm = await requests[1]!.formData();
    expect(wordForm.get("model")).toBe("whisper-1");
    expect(wordForm.get("response_format")).toBe("verbose_json");
    expect(wordForm.getAll("timestamp_granularities[]")).toEqual(["word"]);
    expect(wordForm.get("chunking_strategy")).toBeNull();
    expect(diarization).toMatchObject({ store: null, background: null, usage: { audioSeconds: 31.001 } });
    expect(wordTimestamps).toMatchObject({ store: null, background: null, usage: { audioSeconds: 31.001 } });
  });

  it("marks an HTTP-200 oversized transcription body accepted-unknown rather than replayable", async () => {
    const fetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    }));
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, { fetch });

    await expect(provider.diarize(audio)).rejects.toMatchObject({
      name: "OpenAIProviderError",
      retryable: false,
      replaySafety: "accepted-unknown",
      safeToReplay: false,
    } satisfies Partial<OpenAIProviderError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks an incomplete foreground Responses result accepted-unknown rather than replayable", async () => {
    const fetch = vi.fn(async () => Response.json({
      id: "resp_accepted_but_incomplete",
      status: "in_progress",
      model: "gpt-5.6-terra",
    }));
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, { fetch });

    await expect(provider.reconcile({
      windowId: "reconcile-incomplete",
      allowedWordIds: ["word-1"],
      words: [{
        id: "word-1",
        text: "Hello",
        normalizedText: "hello",
        startMs: 0,
        endMs: 500,
        speaker: "A",
        diarizationSegmentIds: ["speaker-1"],
      }],
    })).rejects.toMatchObject({
      name: "OpenAIProviderError",
      retryable: false,
      replaySafety: "accepted-unknown",
      safeToReplay: false,
    } satisfies Partial<OpenAIProviderError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a generic HTTP-5xx response accepted-unknown and reserves automatic replay for explicit 429", async () => {
    const fiveHundredFetch = vi.fn(async () => Response.json({ error: { message: "gateway" } }, { status: 503 }));
    const fiveHundredProvider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, { fetch: fiveHundredFetch });
    await expect(fiveHundredProvider.diarize(audio)).rejects.toMatchObject({
      name: "OpenAIProviderError",
      retryable: true,
      replaySafety: "accepted-unknown",
      safeToReplay: false,
    } satisfies Partial<OpenAIProviderError>);
    expect(fiveHundredFetch).toHaveBeenCalledTimes(1);

    const tooManyRequestsFetch = vi.fn(async () => Response.json({ error: { message: "limited" } }, { status: 429 }));
    const tooManyRequestsProvider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, { fetch: tooManyRequestsFetch });
    await expect(tooManyRequestsProvider.diarize(audio)).rejects.toMatchObject({
      name: "OpenAIProviderError",
      retryable: true,
      replaySafety: "safe-to-replay",
      safeToReplay: true,
    } satisfies Partial<OpenAIProviderError>);
    expect(tooManyRequestsFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps every live OpenAI file below the 25 MiB cap and overlap-splits a 15-minute prepared WAV with authoritative offsets", async () => {
    const fifteenMinutes = {
      bytes: pcmWav(15 * 60_000),
      contentType: "audio/wav",
      durationMs: 15 * 60_000,
      fileName: "normalized.wav",
    } as const;
    const chunks = splitWavForOpenAITranscription(fifteenMinutes);
    expect(fifteenMinutes.bytes.byteLength).toBeGreaterThan(MAX_OPENAI_TRANSCRIPTION_BYTES);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => (chunk.input.bytes as Uint8Array).byteLength <= MAX_OPENAI_TRANSCRIPTION_BYTES - OPENAI_TRANSCRIPTION_CHUNK_HEADROOM_BYTES)).toBe(true);
    expect(chunks.map((chunk) => chunk.offsetMs)).toEqual([0, expect.any(Number)]);
    expect(chunks[1]!.offsetMs).toBeGreaterThan(0);
    expect(chunks[0]!.endMs).toBeGreaterThan(chunks[1]!.offsetMs);
    expect(chunks[1]!.overlapWithPreviousMs).toBeGreaterThan(0);
    expect(chunks.at(-1)!.endMs).toBe(fifteenMinutes.durationMs);

    const uploadedSizes: number[] = [];
    let sequence = 0;
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async (request) => {
        const form = await request.clone().formData();
        uploadedSizes.push((form.get("file") as File).size);
        const model = form.get("model");
        const chunkNumber = sequence++;
        return Response.json(model === "gpt-4o-transcribe-diarize"
          ? { text: `segment ${chunkNumber}`, segments: [{ id: "segment", start: 0, end: 1, speaker: "A", text: "chunk" }] }
          : { text: `word ${chunkNumber}`, words: [{ word: "chunk", start: 0, end: 1 }] });
      },
    });

    const diarization = await provider.diarize(fifteenMinutes);
    const words = await provider.wordTimestamps(fifteenMinutes);
    expect(uploadedSizes).toHaveLength(4);
    expect(uploadedSizes.every((size) => size <= MAX_OPENAI_TRANSCRIPTION_BYTES - OPENAI_TRANSCRIPTION_CHUNK_HEADROOM_BYTES)).toBe(true);
    expect(diarization).toMatchObject({
      requestMetadata: { sourceAudioChunking: "wav-overlap-frame-aligned", sourceAudioChunkCount: "2" },
      value: { durationMs: fifteenMinutes.durationMs },
    });
    expect(diarization.value.segments.map((segment) => segment.startMs)).toEqual([0, chunks[1]!.offsetMs]);
    expect(diarization.value.segments.map((segment) => segment.speaker)).toEqual(["chunk-1:A", "chunk-2:A"]);
    expect(words.value.words.map((word) => word.startMs)).toEqual([0, chunks[1]!.offsetMs]);
  });

  it("deduplicates matching seam words and records a visible uncertainty when the overlapped requests disagree", async () => {
    const fifteenMinutes = {
      bytes: pcmWav(15 * 60_000),
      contentType: "audio/wav",
      durationMs: 15 * 60_000,
      fileName: "normalized.wav",
    } as const;
    const chunks = splitWavForOpenAITranscription(fifteenMinutes);
    const seamStartMs = chunks[1]!.offsetMs + Math.floor(chunks[1]!.overlapWithPreviousMs / 3);
    const seamEndMs = seamStartMs + 300;
    let requestIndex = 0;
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async (request) => {
        const model = (await request.clone().formData()).get("model");
        const chunkIndex = requestIndex++;
        const chunk = chunks[chunkIndex]!;
        const localStart = (seamStartMs - chunk.offsetMs) / 1_000;
        const localEnd = (seamEndMs - chunk.offsetMs) / 1_000;
        return Response.json(model === "gpt-4o-transcribe-diarize"
          ? { text: "seam", segments: [{ id: "speaker", start: localStart, end: localEnd, speaker: "A", text: "seam" }] }
          : { text: chunkIndex === 0 ? "seam" : "seem", words: [{ word: chunkIndex === 0 ? "seam" : "seem", start: localStart, end: localEnd }] });
      },
    });

    // Word timestamps are independently chunked. A disagreement must retain
    // both source candidates (rather than silently choosing one) and make the
    // ambiguity visible to downstream evidence alignment.
    const words = await provider.wordTimestamps(fifteenMinutes);
    expect(words.value.words).toEqual([
      expect.objectContaining({ text: "seam", chunkSeamConflict: true }),
      expect.objectContaining({ text: "seem", chunkSeamConflict: true }),
    ]);
    expect(words.warnings).toContain("chunk-seam-word-disagreement");

    // Fresh provider instance so diarization uses the same two source chunks
    // but proves that raw speaker labels are never treated as global ids.
    requestIndex = 0;
    const diarization = await provider.diarize(fifteenMinutes);
    expect(diarization.value.segments.map((segment) => segment.speaker)).toEqual(["chunk-1:A", "chunk-2:A"]);
    expect(diarization.warnings).toContain("speaker-identities-are-chunk-local");
  });

  it("uses ordered one-to-one seam alignment so multiplicity matches but insertions, deletions, and reordering remain visible", () => {
    const chunks = [
      { input: audio, offsetMs: 0, endMs: 1_000, overlapWithPreviousMs: 0 },
      { input: audio, offsetMs: 500, endMs: 1_500, overlapWithPreviousMs: 500 },
    ] as const;
    const words = reconcileChunkSeamWords(chunks, [
      [
        { text: "again", startMs: 600, endMs: 650 },
        { text: "again", startMs: 660, endMs: 710 },
        // These wide intervals make the token order, not a timestamp tie,
        // decide the match. The second chunk reverses the pair below.
        { text: "first", startMs: 720, endMs: 940 },
        { text: "second", startMs: 730, endMs: 950 },
        // The second source deletes this word entirely.
        { text: "deleted", startMs: 800, endMs: 850 },
      ],
      [
        { text: "again", startMs: 600, endMs: 650 },
        { text: "again", startMs: 660, endMs: 710 },
        { text: "second", startMs: 720, endMs: 940 },
        { text: "first", startMs: 730, endMs: 950 },
        // This adjacent but temporally-overlapping word is an insertion; it
        // must not be dropped merely because a previous word overlaps it.
        { text: "inserted", startMs: 810, endMs: 860 },
      ],
    ]);

    // Both repeated occurrences are matched exactly once, never collapsed by
    // a token Set. The reordered/insertion/deletion witnesses all survive.
    expect(words.filter((word) => word.text === "again")).toHaveLength(2);
    expect(words.filter((word) => word.text === "inserted")).toEqual([
      expect.objectContaining({ chunkSeamConflict: true }),
    ]);
    expect(words.filter((word) => word.text === "deleted")).toEqual([
      expect.objectContaining({ chunkSeamConflict: true }),
    ]);
    expect(words.filter((word) => word.text === "first" || word.text === "second")).toHaveLength(3);
    expect(words.filter((word) => (word.text === "first" || word.text === "second") && word.chunkSeamConflict)).toHaveLength(2);
  });

  it("accepts the exact 25 MiB boundary but rejects a larger unchunkable live artifact before fetch", async () => {
    const fetch = vi.fn(async () => Response.json({ text: "Hello", words: [{ word: "Hello", start: 0, end: 1 }] }));
    const provider = createOpenAIProvider({ CUEBENCH_OPENAI_MODE: "live", OPENAI_API_KEY: "server-only-test-key" }, { fetch });
    await provider.wordTimestamps({
      bytes: new Uint8Array(MAX_OPENAI_TRANSCRIPTION_BYTES),
      contentType: "audio/wav",
      durationMs: 1_000,
      fileName: "boundary.wav",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.wordTimestamps({
      bytes: new Uint8Array(MAX_OPENAI_TRANSCRIPTION_BYTES + 1),
      contentType: "audio/wav",
      durationMs: 1_000,
      fileName: "oversized.wav",
    })).rejects.toThrow(/split|25 MiB|normalized WAV/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses a foreground, non-retained strict Responses request for bounded reconciliation", async () => {
    let request: Request | undefined;
    const provider = createOpenAIProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
      CUEBENCH_RECONCILIATION_MODEL: "gpt-5.6-terra-configured",
    }, {
      fetch: async (candidate) => {
        request = candidate;
        return new Response(JSON.stringify({
          id: "resp_fixture",
          status: "completed",
          model: "gpt-5.6-terra",
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
          output: [{
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify({
              replacements: [{ wordId: "word:0:500:0", text: "Gibbs" }],
            }) }],
          }],
        }), { headers: { "content-type": "application/json" } });
      },
    });

    const result = await provider.reconcile({
      windowId: "reconcile:0",
      allowedWordIds: ["word:0:500:0"],
      words: [{
        id: "word:0:500:0",
        text: "Gibbs",
        normalizedText: "gibbs",
        startMs: 0,
        endMs: 500,
        speaker: "A",
        diarizationSegmentIds: ["segment-a"],
      }],
    });

    expect(request?.url).toBe("https://api.openai.com/v1/responses");
    const body = await request?.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-terra-configured",
      background: false,
      store: false,
      stream: false,
      tools: [],
      tool_choice: "none",
      parallel_tool_calls: false,
      text: {
        format: {
          type: "json_schema",
          name: "cuebench_transcript_reconciliation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
          },
        },
      },
    });
    expect(result).toMatchObject({
      model: "gpt-5.6-terra",
      store: false,
      background: false,
      providerResponseId: "resp_fixture",
      rawResponseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestMetadata: expect.objectContaining({
        requestedModel: "gpt-5.6-terra-configured",
        background: "false",
        store: "false",
        structuredOutputStrict: "true",
        structuredOutputSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        instructionsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      warnings: [],
      value: { replacements: [{ wordId: "word:0:500:0", text: "Gibbs" }] },
    });
  });
});
