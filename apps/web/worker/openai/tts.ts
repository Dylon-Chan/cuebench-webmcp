import {
  OpenAIProviderError,
  type OpenAIFetch,
  type OpenAIProviderEnvironment,
  sha256Hex,
} from "./client";

/** Official Audio speech endpoint defaults for CueBench narration preview. */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_TTS_VOICE = "marin";
export const DEFAULT_TTS_RESPONSE_FORMAT = "wav";
export const OPENAI_AUDIO_SPEECH_PATH = "/v1/audio/speech";
export const MAX_TTS_INPUT_CHARS = 4_096;
const MAX_TTS_RESPONSE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type NarrationTtsFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface NarrationTtsRequest {
  readonly input: string;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly responseFormat: NarrationTtsFormat;
  readonly speed: number;
}

export interface NarrationTtsResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly model: string;
  readonly voice: string;
  readonly responseFormat: NarrationTtsFormat;
  /** `/v1/audio/speech` exposes no `store` parameter; null is truthful provenance. */
  readonly store: null;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly warnings: readonly string[];
}

export interface NarrationTtsProvider {
  readonly mode: "fixture" | "live";
  synthesize: (input: NarrationTtsRequest) => Promise<NarrationTtsResult>;
}

export interface NarrationTtsProviderOptions {
  readonly fetch?: OpenAIFetch;
  readonly baseUrl?: string;
}

const assertRequest = (input: NarrationTtsRequest): void => {
  if (
    !input.input.trim()
    || input.input.length > MAX_TTS_INPUT_CHARS
    // CueBench intentionally pins this preview profile. Letting browser input
    // select arbitrary models/voices/formats turns a bounded accessibility
    // preview into an unbounded spend and privacy surface.
    || input.model.trim() !== DEFAULT_TTS_MODEL
    || input.voice.trim() !== DEFAULT_TTS_VOICE
    || !input.instructions.trim()
    || input.instructions.length > 2_000
    || input.responseFormat !== DEFAULT_TTS_RESPONSE_FORMAT
    || input.speed !== 1
  ) throw new OpenAIProviderError("CueBench received invalid bounded narration-preview inputs.", false);
};

const normalizedInput = (input: NarrationTtsRequest): NarrationTtsRequest => ({
  ...input,
  input: input.input.trim(),
  model: input.model.trim(),
  voice: input.voice.trim(),
  instructions: input.instructions.trim(),
  speed: Number(input.speed),
});

const baseUrl = (value: string | undefined): string => {
  const candidate = value?.trim() || "https://api.openai.com";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  return parsed.toString().replace(/\/$/u, "");
};

const contentTypeFor = (format: NarrationTtsFormat): string => ({
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
})[format];

const makeFixtureWav = (input: NarrationTtsRequest): Uint8Array => {
  // A valid tiny 24kHz mono PCM WAV gives browsers a reliable metadata
  // duration in fixture mode without pretending it is human narration.
  const durationMs = Math.max(250, Math.min(3_000, Math.ceil((input.input.length / 14 / input.speed) * 1_000)));
  const sampleRate = 24_000;
  const samples = Math.max(1, Math.floor((durationMs * sampleRate) / 1_000));
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(encoder.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(encoder.encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
};

const readBoundedAudio = async (response: Response): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  const safety = response.status === 429 ? "safe-to-replay" as const : "accepted-unknown" as const;
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_TTS_RESPONSE_BYTES)) {
    throw new OpenAIProviderError("CueBench received an oversized narration-preview response.", response.status === 429, safety);
  }
  if (!response.ok) {
    throw new OpenAIProviderError(
      "CueBench's narration-preview provider is unavailable.",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? "safe-to-replay" : response.status >= 500 ? "accepted-unknown" : "terminal",
    );
  }
  if (response.body === null) throw new OpenAIProviderError("CueBench received an empty narration-preview response.", false, "accepted-unknown");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > MAX_TTS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIProviderError("CueBench received an oversized narration-preview response.", false, "accepted-unknown");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) throw new OpenAIProviderError("CueBench received an empty narration-preview response.", false, "accepted-unknown");
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

class FixtureNarrationTtsProvider implements NarrationTtsProvider {
  public readonly mode = "fixture" as const;

  public async synthesize(value: NarrationTtsRequest): Promise<NarrationTtsResult> {
    assertRequest(value);
    const input = normalizedInput(value);
    // Fixture waveform is intentionally WAV so it remains browser-measurable.
    const bytes = makeFixtureWav({ ...input, responseFormat: "wav" });
    const requestHash = await sha256Hex(JSON.stringify(input));
    const responseHash = await sha256Hex(bytes);
    return {
      bytes,
      contentType: "audio/wav",
      model: input.model,
      voice: input.voice,
      responseFormat: "wav",
      store: null,
      requestHash,
      responseHash,
      warnings: ["fixture-narration-preview"],
    };
  }
}

class LiveNarrationTtsProvider implements NarrationTtsProvider {
  public readonly mode = "live" as const;

  public constructor(private readonly settings: { readonly apiKey: string; readonly baseUrl: string; readonly fetch: OpenAIFetch }) {}

  public async synthesize(value: NarrationTtsRequest): Promise<NarrationTtsResult> {
    assertRequest(value);
    const input = normalizedInput(value);
    const body = {
      model: input.model,
      input: input.input,
      voice: input.voice,
      instructions: input.instructions,
      response_format: input.responseFormat,
      speed: input.speed,
      // Deliberately no `store`: the official /v1/audio/speech contract does
      // not expose it. Provenance below records null rather than inventing a
      // privacy control the endpoint cannot honour.
    } as const;
    const serialized = JSON.stringify(body);
    const requestHash = await sha256Hex(serialized);
    const response = await this.settings.fetch(new Request(`${this.settings.baseUrl}${OPENAI_AUDIO_SPEECH_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": "application/json" },
      body: serialized,
    }));
    const bytes = await readBoundedAudio(response);
    return {
      bytes,
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || contentTypeFor(input.responseFormat),
      model: input.model,
      voice: input.voice,
      responseFormat: input.responseFormat,
      store: null,
      requestHash,
      responseHash: await sha256Hex(bytes),
      warnings: ["audio-speech-endpoint-has-no-store-parameter"],
    };
  }
}

/**
 * Server-side-only TTS boundary. Browser code can request CueBench's hosted
 * preview route but never receives an OpenAI credential or an SDK capability.
 */
export const createNarrationTtsProvider = (
  environment: OpenAIProviderEnvironment,
  options: NarrationTtsProviderOptions = {},
): NarrationTtsProvider => {
  const mode = environment.CUEBENCH_OPENAI_MODE?.trim();
  if (mode === undefined || mode === "" || mode === "fixture") return new FixtureNarrationTtsProvider();
  if (mode !== "live") throw new OpenAIProviderError("CueBench OpenAI mode must be fixture or live.", false);
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") throw new OpenAIProviderError("CueBench live OpenAI mode requires server-side credentials.", false);
  return new LiveNarrationTtsProvider({
    apiKey,
    baseUrl: baseUrl(options.baseUrl ?? environment.CUEBENCH_OPENAI_BASE_URL),
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
};
