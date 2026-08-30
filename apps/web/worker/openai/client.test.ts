import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "./client";

const audio = {
  bytes: new TextEncoder().encode("private normalized audio"),
  contentType: "audio/wav",
  durationMs: 31_001,
  fileName: "normalized.wav",
} as const;

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
            }
          : {
              text: "Hello",
              words: [{ word: "Hello", start: 0, end: 1 }],
            }), { headers: { "content-type": "application/json" } });
      },
    });

    await provider.diarize(audio);
    await provider.wordTimestamps(audio);

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
