import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  MAX_TTS_INPUT_CHARS,
  createNarrationTtsProvider,
  type NarrationTtsRequest,
} from "./tts";

const input: NarrationTtsRequest = {
  input: "A watershed map fills the screen.",
  model: DEFAULT_TTS_MODEL,
  voice: DEFAULT_TTS_VOICE,
  instructions: "Speak clearly and concisely for an accessibility preview.",
  responseFormat: "wav",
  speed: 1,
};

describe("Narration TTS provider", () => {
  it("uses an offline deterministic fixture unless live mode is explicitly enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createNarrationTtsProvider({}, { fetch });

    const result = await provider.synthesize(input);

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      model: DEFAULT_TTS_MODEL,
      voice: DEFAULT_TTS_VOICE,
      responseFormat: "wav",
      store: null,
      contentType: "audio/wav",
    });
    expect(result.bytes.byteLength).toBeGreaterThan(44);
  });

  it("uses the documented Audio speech request without an invented store parameter", async () => {
    const requests: Request[] = [];
    const provider = createNarrationTtsProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async (request) => {
        requests.push(request);
        return new Response(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]), {
          headers: { "content-type": "audio/wav" },
        });
      },
    });

    const result = await provider.synthesize(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer server-only-test-key");
    const body = await requests[0]?.clone().json() as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEFAULT_TTS_MODEL,
      voice: DEFAULT_TTS_VOICE,
      input: input.input,
      instructions: input.instructions,
      response_format: "wav",
      speed: 1,
    });
    expect(body).not.toHaveProperty("store");
    expect(result).toMatchObject({ store: null, contentType: "audio/wav" });
  });

  it("requires a server-side credential in live mode", () => {
    expect(() => createNarrationTtsProvider({ CUEBENCH_OPENAI_MODE: "live" })).toThrow(/server-side credentials/i);
  });

  it.each([
    ["over-cap text", { ...input, input: "x".repeat(MAX_TTS_INPUT_CHARS + 1) }],
    ["a model override", { ...input, model: "gpt-4o-tts" }],
    ["a voice override", { ...input, voice: "alloy" }],
    ["a format override", { ...input, responseFormat: "mp3" as const }],
    ["a speed override", { ...input, speed: 1.1 }],
  ])("rejects %s outside CueBench's pinned TTS preview profile", async (_name, request) => {
    const provider = createNarrationTtsProvider({});
    await expect(provider.synthesize(request)).rejects.toThrow(/bounded narration-preview/i);
  });
});
