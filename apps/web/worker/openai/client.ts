import { z } from "zod";

/** The only model role used for bounded transcript reconciliation. */
export const DEFAULT_RECONCILIATION_MODEL = "gpt-5.6-terra";
export const RECONCILIATION_PROMPT_VERSION = "cuebench-reconciliation-v1";
export const RECONCILIATION_SCHEMA_VERSION = "cuebench-reconciliation-schema-v1";
export const OPENAI_TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
export const OPENAI_RESPONSES_PATH = "/v1/responses";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEMS = 100_000;
const MAX_RECONCILIATION_REPLACEMENTS = 48;
/** OpenAI rejects a transcription file part larger than 25 MiB. */
export const MAX_OPENAI_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
/** Leave multipart/provider accounting margin below the documented file cap. */
export const OPENAI_TRANSCRIPTION_CHUNK_HEADROOM_BYTES = 64 * 1024;
/** Adjacent PCM windows overlap so speech cut at a frame split can be reconciled. */
export const OPENAI_TRANSCRIPTION_CHUNK_OVERLAP_MS = 1_000;
const encoder = new TextEncoder();

export type OpenAIProviderMode = "fixture" | "live";

/** Worker-only settings. `live` is intentionally never inferred from a key alone. */
export interface OpenAIProviderEnvironment {
  readonly CUEBENCH_OPENAI_MODE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly CUEBENCH_OPENAI_BASE_URL?: string;
  readonly CUEBENCH_RECONCILIATION_MODEL?: string;
}

/** A narrow fetch port keeps fixture tests and local replay completely offline. */
export type OpenAIFetch = (request: Request) => Promise<Response>;

export interface NormalizedAudioInput {
  /** Private normalized audio bytes read only by the Workflow. */
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly contentType: string;
  readonly durationMs: number;
  readonly fileName: string;
}

export interface DiarizedSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string;
  readonly text: string;
}

export interface DiarizedTranscript {
  readonly text: string;
  readonly durationMs: number;
  readonly segments: readonly DiarizedSegment[];
}

export interface TimestampedWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** A deterministic chunk-seam disagreement survives to a visible uncertainty span. */
  readonly chunkSeamConflict?: boolean;
}

export interface WordTimestampTranscript {
  readonly text: string;
  readonly words: readonly TimestampedWord[];
}

export interface ReconciliationInputWord {
  readonly id: string;
  readonly text: string;
  readonly normalizedText: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string | null;
  readonly diarizationSegmentIds: readonly string[];
}

/** One bounded, source-linked window; only these IDs can be changed. */
export interface ReconciliationRequest {
  readonly windowId: string;
  readonly allowedWordIds: readonly string[];
  readonly words: readonly ReconciliationInputWord[];
}

export interface ReconciliationReplacement {
  readonly wordId: string;
  readonly text: string;
}

export interface ReconciliationResponse {
  readonly replacements: readonly ReconciliationReplacement[];
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly audioSeconds: number | null;
}

/**
 * This is persisted in generation provenance, never the raw provider body.
 * Audio endpoints do not expose a `store`/`background` switch, so they record
 * null rather than falsely asserting a Responses API data-control setting.
 */
export interface ProviderCallProvenance {
  readonly provider: "fixture" | "openai";
  readonly model: string;
  readonly requestHash: string;
  readonly responseHash: string;
  /** Compatibility name that makes the raw-response provenance explicit. */
  readonly rawResponseSha256: string;
  readonly store: false | null;
  readonly background: false | null;
  readonly usage: ProviderUsage | null;
  readonly providerResponseId: string | null;
  /** Bounded resolved request metadata; prompts/schemas are recorded by hash. */
  readonly requestMetadata?: Readonly<Record<string, string>>;
  /** Provider warnings are review evidence, never executable instructions. */
  readonly warnings?: readonly string[];
}

export interface ProviderResult<Value> extends ProviderCallProvenance {
  readonly value: Value;
}

/** Required by the durable Workflow for the two transcription passes. */
export interface OpenAITranscriptionProvider {
  readonly mode: OpenAIProviderMode;
  diarize(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>>;
  wordTimestamps(input: NormalizedAudioInput): Promise<ProviderResult<WordTimestampTranscript>>;
}

/** Separate port so reconciliation can be faked without any HTTP emulation. */
export interface OpenAIReconciliationProvider {
  reconcile(input: ReconciliationRequest): Promise<ProviderResult<ReconciliationResponse>>;
}

export type OpenAIProvider = OpenAITranscriptionProvider & OpenAIReconciliationProvider;

/** Strict Structured Outputs contract sent to the Responses API. */
export const ReconciliationResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["replacements"],
  properties: {
    replacements: {
      type: "array",
      maxItems: MAX_RECONCILIATION_REPLACEMENTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["wordId", "text"],
        properties: {
          wordId: { type: "string", minLength: 1, maxLength: 160 },
          text: { type: "string", minLength: 1, maxLength: 400 },
        },
      },
    },
  },
} as const;

const ReconciliationResponseSchema = z.object({
  replacements: z.array(z.object({
    wordId: z.string().trim().min(1).max(160),
    text: z.string().trim().min(1).max(400),
  }).strict()).max(MAX_RECONCILIATION_REPLACEMENTS),
}).strict();

const RawDiarizedTranscriptSchema = z.object({
  text: z.string().max(1_000_000),
  duration: z.number().finite().nonnegative().optional(),
  segments: z.array(z.object({
    id: z.string().trim().min(1).max(160),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    speaker: z.string().trim().min(1).max(160),
    text: z.string().max(16_000),
  }).passthrough()).max(MAX_TRANSCRIPT_ITEMS),
}).passthrough();

const RawWordTimestampTranscriptSchema = z.object({
  text: z.string().max(1_000_000),
  words: z.array(z.object({
    word: z.string().trim().min(1).max(400),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  }).passthrough()).max(MAX_TRANSCRIPT_ITEMS),
}).passthrough();

/**
 * Retryability describes whether the caller may eventually recover; it is
 * deliberately not evidence that OpenAI did not accept a billable request.
 * Automatic replay is allowed only for an explicit pre-acceptance response
 * (currently HTTP 429). Every transport, 5xx, or successful-HTTP protocol
 * ambiguity remains accepted-unknown and is failed closed by the Workflow.
 */
export type OpenAIProviderReplaySafety = "safe-to-replay" | "accepted-unknown" | "terminal";

export class OpenAIProviderError extends Error {
  public readonly name = "OpenAIProviderError";

  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly replaySafety: OpenAIProviderReplaySafety = retryable ? "accepted-unknown" : "terminal",
  ) {
    super(message);
  }

  public get safeToReplay(): boolean {
    return this.replaySafety === "safe-to-replay";
  }
}

export interface FixtureOpenAIResponses {
  readonly diarization?: DiarizedTranscript;
  readonly wordTimestamps?: WordTimestampTranscript;
  readonly reconciliation?: ReconciliationResponse;
}

export interface OpenAIProviderOptions {
  readonly fetch?: OpenAIFetch;
  readonly baseUrl?: string;
  readonly fixture?: FixtureOpenAIResponses;
}

/**
 * Explicit provider boundary. Missing/empty mode is a deterministic fixture;
 * an API key by itself can never activate network access.
 */
export const createOpenAIProvider = (
  environment: OpenAIProviderEnvironment,
  options: OpenAIProviderOptions = {},
): OpenAIProvider => {
  const configuredMode = environment.CUEBENCH_OPENAI_MODE?.trim();
  if (configuredMode === undefined || configuredMode === "" || configuredMode === "fixture") {
    return new FixtureOpenAIProvider(options.fixture);
  }
  if (configuredMode !== "live") {
    throw new OpenAIProviderError("CueBench OpenAI mode must be fixture or live.", false);
  }
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new OpenAIProviderError("CueBench live OpenAI mode requires server-side credentials.", false);
  }
  const fetch = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  return new LiveOpenAIProvider({
    apiKey,
    baseUrl: normalizeBaseUrl(options.baseUrl ?? environment.CUEBENCH_OPENAI_BASE_URL),
    reconciliationModel: resolvedReconciliationModel(environment.CUEBENCH_RECONCILIATION_MODEL),
    fetch,
  });
};

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizedAudioBytes = (value: Uint8Array | ArrayBuffer): Uint8Array => (
  value instanceof Uint8Array ? value : new Uint8Array(value)
);

const assertNormalizedAudio = (input: NormalizedAudioInput): Uint8Array => {
  const bytes = normalizedAudioBytes(input.bytes);
  if (
    bytes.byteLength === 0
    || !Number.isSafeInteger(input.durationMs)
    || input.durationMs <= 0
    || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(input.contentType)
    || !/^[A-Za-z0-9._-]{1,160}$/u.test(input.fileName)
  ) throw new OpenAIProviderError("CueBench cannot transcribe an invalid private audio artifact.", false);
  return bytes;
};

const readFourCC = (bytes: Uint8Array, offset: number): string => new TextDecoder().decode(bytes.slice(offset, offset + 4));
const readU16LE = (bytes: Uint8Array, offset: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
const readU32LE = (bytes: Uint8Array, offset: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const writeU32LE = (bytes: Uint8Array, offset: number, value: number): void => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);

interface WavLayout {
  readonly fmt: Uint8Array;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly blockAlign: number;
}

/**
 * Task 12 emits canonical PCM WAV. For an artifact over OpenAI's file bound,
 * retain the exact samples but frame-split it into self-contained WAV files.
 */
const wavLayout = (bytes: Uint8Array): WavLayout => {
  if (bytes.byteLength < 44 || readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WAVE") {
    throw new OpenAIProviderError("CueBench cannot safely split a non-WAV private audio artifact for OpenAI.", false);
  }
  let offset = 12;
  let fmt: Uint8Array | null = null;
  let dataOffset = -1;
  let dataLength = -1;
  while (offset + 8 <= bytes.byteLength) {
    const kind = readFourCC(bytes, offset);
    const size = readU32LE(bytes, offset + 4);
    const contentOffset = offset + 8;
    const next = contentOffset + size + (size % 2);
    if (next > bytes.byteLength || next < contentOffset) break;
    if (kind === "fmt ") fmt = bytes.slice(contentOffset, contentOffset + size);
    if (kind === "data" && dataOffset === -1) {
      dataOffset = contentOffset;
      dataLength = size;
    }
    offset = next;
  }
  if (
    fmt === null
    || fmt.byteLength < 16
    || dataOffset < 0
    || dataLength <= 0
    || dataOffset + dataLength > bytes.byteLength
  ) throw new OpenAIProviderError("CueBench cannot safely split this normalized WAV artifact.", false);
  const format = readU16LE(fmt, 0);
  const blockAlign = readU16LE(fmt, 12);
  // PCM and IEEE float WAV layouts are frame-addressable; compressed codec
  // frames require a container-aware splitter and are rejected instead.
  if ((format !== 1 && format !== 3) || !Number.isSafeInteger(blockAlign) || blockAlign <= 0 || dataLength % blockAlign !== 0) {
    throw new OpenAIProviderError("CueBench normalized WAV is not frame-addressable for safe OpenAI chunking.", false);
  }
  return { fmt, dataOffset, dataLength, blockAlign };
};

const wavWithData = (fmt: Uint8Array, data: Uint8Array): Uint8Array => {
  const fmtPadding = fmt.byteLength % 2;
  const dataPadding = data.byteLength % 2;
  const total = 12 + 8 + fmt.byteLength + fmtPadding + 8 + data.byteLength + dataPadding;
  const bytes = new Uint8Array(total);
  bytes.set(encoder.encode("RIFF"), 0);
  writeU32LE(bytes, 4, total - 8);
  bytes.set(encoder.encode("WAVEfmt "), 8);
  writeU32LE(bytes, 16, fmt.byteLength);
  bytes.set(fmt, 20);
  const dataHeader = 20 + fmt.byteLength + fmtPadding;
  bytes.set(encoder.encode("data"), dataHeader);
  writeU32LE(bytes, dataHeader + 4, data.byteLength);
  bytes.set(data, dataHeader + 8);
  return bytes;
};

export interface OpenAITranscriptionChunk {
  readonly input: NormalizedAudioInput;
  /** Authoritative offset in the original prepared media timeline. */
  readonly offsetMs: number;
  /** Authoritative exclusive end in the original prepared media timeline. */
  readonly endMs: number;
  /** The repeated prefix with the immediately preceding chunk, if any. */
  readonly overlapWithPreviousMs: number;
}

/** Exposed for exact-boundary tests and the Workflow's provider provenance. */
export const splitWavForOpenAITranscription = (input: NormalizedAudioInput): readonly OpenAITranscriptionChunk[] => {
  const bytes = assertNormalizedAudio(input);
  if (bytes.byteLength <= MAX_OPENAI_TRANSCRIPTION_BYTES) {
    return [{ input, offsetMs: 0, endMs: input.durationMs, overlapWithPreviousMs: 0 }];
  }
  if (!/^audio\/(?:wav|x-wav)$/iu.test(input.contentType)) {
    throw new OpenAIProviderError("CueBench cannot safely chunk a non-WAV normalized audio artifact for OpenAI.", false);
  }
  const layout = wavLayout(bytes);
  const headerBytes = wavWithData(layout.fmt, new Uint8Array(0)).byteLength;
  const maximumDataBytes = Math.floor((MAX_OPENAI_TRANSCRIPTION_BYTES - OPENAI_TRANSCRIPTION_CHUNK_HEADROOM_BYTES - headerBytes) / layout.blockAlign) * layout.blockAlign;
  if (maximumDataBytes <= 0) throw new OpenAIProviderError("CueBench cannot allocate a valid bounded OpenAI WAV chunk.", false);
  const requestedOverlapBytes = Math.ceil((layout.dataLength * Math.min(OPENAI_TRANSCRIPTION_CHUNK_OVERLAP_MS, input.durationMs)) / input.durationMs / layout.blockAlign) * layout.blockAlign;
  const overlapDataBytes = Math.min(
    Math.max(layout.blockAlign, requestedOverlapBytes),
    maximumDataBytes - layout.blockAlign,
  );
  if (overlapDataBytes <= 0 || overlapDataBytes >= maximumDataBytes) {
    throw new OpenAIProviderError("CueBench cannot allocate an overlap-safe bounded OpenAI WAV chunk.", false);
  }
  const chunks: OpenAITranscriptionChunk[] = [];
  for (let dataStart = 0; dataStart < layout.dataLength;) {
    const dataEnd = Math.min(layout.dataLength, dataStart + maximumDataBytes);
    const chunkBytes = wavWithData(layout.fmt, bytes.slice(layout.dataOffset + dataStart, layout.dataOffset + dataEnd));
    if (chunkBytes.byteLength > MAX_OPENAI_TRANSCRIPTION_BYTES) {
      throw new OpenAIProviderError("CueBench generated an oversized OpenAI transcription chunk.", false);
    }
    const index = chunks.length;
    const offsetMs = Math.floor((dataStart * input.durationMs) / layout.dataLength);
    const endMs = dataEnd === layout.dataLength
      ? input.durationMs
      : Math.floor((dataEnd * input.durationMs) / layout.dataLength);
    if (endMs <= offsetMs) throw new OpenAIProviderError("CueBench generated an invalid OpenAI chunk timeline.", false);
    const previous = chunks.at(-1);
    chunks.push({
      input: {
        bytes: chunkBytes,
        contentType: input.contentType,
        // Scale on the authoritative manifest duration rather than trusting
        // mutable WAV metadata. Windows deliberately overlap at a frame
        // boundary, so a spoken seam word is never silently cut in half.
        durationMs: endMs - offsetMs,
        fileName: input.fileName.replace(/\.wav$/iu, `-chunk-${index + 1}.wav`),
      },
      offsetMs,
      endMs,
      overlapWithPreviousMs: previous === undefined ? 0 : Math.max(0, previous.endMs - offsetMs),
    });
    if (dataEnd === layout.dataLength) break;
    dataStart = dataEnd - overlapDataBytes;
  }
  return chunks;
};

const audioRequestHash = async (kind: "diarize" | "word_timestamps", input: NormalizedAudioInput): Promise<string> => {
  const bytes = assertNormalizedAudio(input);
  return sha256Hex(JSON.stringify({
    kind,
    audioSha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    contentType: input.contentType,
    durationMs: input.durationMs,
    fileName: input.fileName,
  }));
};

const toMilliseconds = (seconds: number, message: string): number => {
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new OpenAIProviderError(message, false);
  }
  return milliseconds;
};

const parseDiarizedTranscript = (value: unknown): DiarizedTranscript => {
  const parsed = RawDiarizedTranscriptSchema.safeParse(value);
  if (!parsed.success) throw new OpenAIProviderError("CueBench received an invalid diarized transcription response.", false);
  const segments = parsed.data.segments.map((segment) => {
    const startMs = toMilliseconds(segment.start, "CueBench received an invalid diarized transcription response.");
    const endMs = toMilliseconds(segment.end, "CueBench received an invalid diarized transcription response.");
    if (endMs <= startMs) throw new OpenAIProviderError("CueBench received an invalid diarized transcription response.", false);
    return {
      id: segment.id,
      startMs,
      endMs,
      speaker: segment.speaker,
      text: segment.text,
    };
  });
  const durationMs = parsed.data.duration === undefined
    ? Math.max(0, ...segments.map((segment) => segment.endMs))
    : toMilliseconds(parsed.data.duration, "CueBench received an invalid diarized transcription response.");
  return { text: parsed.data.text, durationMs, segments };
};

const parseWordTimestampTranscript = (value: unknown): WordTimestampTranscript => {
  const parsed = RawWordTimestampTranscriptSchema.safeParse(value);
  if (!parsed.success) throw new OpenAIProviderError("CueBench received an invalid word-timestamp transcription response.", false);
  const words = parsed.data.words.map((word) => {
    const startMs = toMilliseconds(word.start, "CueBench received an invalid word-timestamp transcription response.");
    const endMs = toMilliseconds(word.end, "CueBench received an invalid word-timestamp transcription response.");
    if (endMs <= startMs) throw new OpenAIProviderError("CueBench received an invalid word-timestamp transcription response.", false);
    return { text: word.word, startMs, endMs };
  });
  return { text: parsed.data.text, words };
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
);

const finiteNonNegative = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
);

const parseUsage = (value: unknown): ProviderUsage | null => {
  const usage = asRecord(value);
  if (usage === null) return null;
  return {
    inputTokens: finiteNonNegative(usage.input_tokens),
    outputTokens: finiteNonNegative(usage.output_tokens),
    totalTokens: finiteNonNegative(usage.total_tokens),
    // The transcription endpoint’s duration usage object is `{ seconds,
    // type: "duration" }`; retain the older field only for fixture/backward
    // compatibility, never as the primary official contract.
    audioSeconds: finiteNonNegative(usage.seconds) ?? finiteNonNegative(usage.audio_seconds),
  };
};

const providerResponseId = (value: unknown): string | null => {
  const record = asRecord(value);
  return record !== null && typeof record.id === "string" && record.id.trim() !== "" ? record.id : null;
};

const providerWarnings = (value: unknown): readonly string[] => {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.warnings)) return [];
  return record.warnings
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => warning.trim())
    .filter((warning) => warning.length > 0 && warning.length <= 500)
    .slice(0, 32);
};

const resolvedModel = (value: unknown, fallback: string): string => {
  const record = asRecord(value);
  return record !== null && typeof record.model === "string" && record.model.trim() !== "" ? record.model : fallback;
};

const replaySafetyForHttpResponse = (response: Response): OpenAIProviderReplaySafety => (
  // A 429 is an explicit admission that the provider rejected the request
  // before accepting work. A generic 5xx is not: an upstream service may
  // have accepted audio/reasoning before its gateway lost the result.
  response.status === 429
    ? "safe-to-replay"
    : response.ok || response.status >= 500
      ? "accepted-unknown"
      : "terminal"
);

const retryableHttpResponse = (response: Response): boolean => (
  response.status === 429 || response.status >= 500
);

const readBoundedText = async (response: Response): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)) {
    throw new OpenAIProviderError("CueBench received an oversized provider response.", retryableHttpResponse(response), replaySafetyForHttpResponse(response));
  }
  if (response.body === null) throw new OpenAIProviderError("CueBench received an empty provider response.", retryableHttpResponse(response), replaySafetyForHttpResponse(response));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteLength += part.value.byteLength;
      if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIProviderError("CueBench received an oversized provider response.", retryableHttpResponse(response), replaySafetyForHttpResponse(response));
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
};

const readOpenAIJson = async (response: Response, unavailableMessage: string): Promise<{ readonly raw: string; readonly parsed: unknown; readonly responseHash: string }> => {
  const raw = await readBoundedText(response);
  const responseHash = await sha256Hex(raw);
  if (!response.ok) {
    throw new OpenAIProviderError(
      unavailableMessage,
      retryableHttpResponse(response),
      replaySafetyForHttpResponse(response),
    );
  }
  try {
    return { raw, parsed: JSON.parse(raw) as unknown, responseHash };
  } catch {
    // A 2xx response means the request may already have consumed billable
    // work even when its body is malformed or truncated.
    throw new OpenAIProviderError(unavailableMessage, false, "accepted-unknown");
  }
};

const normalizedReconciliationResponse = (value: unknown): ReconciliationResponse => {
  const parsed = ReconciliationResponseSchema.safeParse(value);
  if (!parsed.success) throw new OpenAIProviderError("CueBench received an invalid structured reconciliation response.", false);
  return { replacements: parsed.data.replacements.map((replacement) => ({ ...replacement })) };
};

const responseOutputText = (value: unknown): string | null => {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.output)) return null;
  const texts: string[] = [];
  for (const output of record.output) {
    const item = asRecord(output);
    if (item === null || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      const part = asRecord(content);
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.length === 1 ? texts[0]! : null;
};

const normalizeBaseUrl = (value: string | undefined): string => {
  const candidate = value?.trim() || DEFAULT_OPENAI_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  return url.toString().replace(/\/$/, "");
};

const resolvedReconciliationModel = (value: string | undefined): string => {
  const model = value?.trim() || DEFAULT_RECONCILIATION_MODEL;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(model)) {
    throw new OpenAIProviderError("CueBench reconciliation model is invalid.", false);
  }
  return model;
};

interface LiveOpenAIProviderSettings {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly reconciliationModel: string;
  readonly fetch: OpenAIFetch;
}

interface MultipartPayload {
  readonly contentType: string;
  readonly body: Uint8Array;
}

const multipartBoundary = (): string => {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return `----cuebench-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * We build the small multipart body directly instead of relying on a browser
 * realm-specific FormData/Blob pair. Workers parse this as ordinary multipart,
 * and unit tests can still inspect it with Request.formData().
 */
const transcriptionMultipart = (
  input: NormalizedAudioInput,
  fields: readonly (readonly [name: string, value: string])[],
): MultipartPayload => {
  const bytes = assertNormalizedAudio(input);
  if (bytes.byteLength > MAX_OPENAI_TRANSCRIPTION_BYTES) {
    throw new OpenAIProviderError("CueBench refuses to send an OpenAI transcription file over the 25 MiB provider limit.", false);
  }
  const boundary = multipartBoundary();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of fields) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
  ));
  chunks.push(bytes, encoder.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
};

const aggregateUsage = (results: readonly ProviderResult<unknown>[]): ProviderUsage | null => {
  if (results.some((result) => result.usage === null)) return null;
  const sum = (field: keyof ProviderUsage): number | null => {
    const values = results.map((result) => result.usage?.[field] ?? null);
    return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    audioSeconds: sum("audioSeconds"),
  };
};

const overlapMs = (leftStartMs: number, leftEndMs: number, rightStartMs: number, rightEndMs: number): number => (
  Math.max(0, Math.min(leftEndMs, rightEndMs) - Math.max(leftStartMs, rightStartMs))
);

const normalizedChunkWord = (text: string): string => text
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/gu, " ");

interface ChunkWordCandidate extends TimestampedWord {
  readonly chunkIndex: number;
}

/**
 * Exact ordered matching avoids a token Set's false equivalence for repeated
 * words. A seam is normally short; cap the dynamic-programming matrix so a
 * malformed provider response cannot turn transcript recovery into an
 * unbounded allocation. The conservative overflow behavior retains every
 * candidate and makes it visibly uncertain instead of silently dropping it.
 */
const MAX_SEAM_ALIGNMENT_CELLS = 262_144;

interface IndexedSeamWord {
  readonly word: ChunkWordCandidate;
  readonly acceptedIndex: number;
}

const seamWordsMatch = (left: TimestampedWord, right: TimestampedWord): boolean => (
  normalizedChunkWord(left.text) === normalizedChunkWord(right.text)
  && overlapMs(left.startMs, left.endMs, right.startMs, right.endMs) > 0
);

/** Returns deterministic LCS pairs, preserving order and word multiplicity. */
const orderedSeamMatches = (
  previous: readonly IndexedSeamWord[],
  current: readonly ChunkWordCandidate[],
): readonly (readonly [previousIndex: number, currentIndex: number])[] => {
  const width = current.length + 1;
  const cells = (previous.length + 1) * width;
  if (cells > MAX_SEAM_ALIGNMENT_CELLS) return [];
  const scores = new Uint16Array(cells);
  const offset = (previousIndex: number, currentIndex: number): number => previousIndex * width + currentIndex;
  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
      scores[offset(previousIndex, currentIndex)] = seamWordsMatch(previous[previousIndex]!.word, current[currentIndex]!)
        ? scores[offset(previousIndex + 1, currentIndex + 1)]! + 1
        : Math.max(scores[offset(previousIndex + 1, currentIndex)]!, scores[offset(previousIndex, currentIndex + 1)]!);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  let previousIndex = 0;
  let currentIndex = 0;
  while (previousIndex < previous.length && currentIndex < current.length) {
    if (
      seamWordsMatch(previous[previousIndex]!.word, current[currentIndex]!)
      && scores[offset(previousIndex, currentIndex)] === scores[offset(previousIndex + 1, currentIndex + 1)]! + 1
    ) {
      pairs.push([previousIndex, currentIndex]);
      previousIndex += 1;
      currentIndex += 1;
      continue;
    }
    // Ties choose the earlier previous candidate. That deterministic choice
    // means an insertion/reordering remains represented by an unmatched word
    // rather than accidentally being swallowed by a Set-like comparison.
    if (scores[offset(previousIndex + 1, currentIndex)]! >= scores[offset(previousIndex, currentIndex + 1)]!) previousIndex += 1;
    else currentIndex += 1;
  }
  return pairs;
};

/**
 * Reconciles repeated, reordered, and conflicting word timestamps in
 * adjacent overlapped WAV windows. Only an ordered one-to-one content match
 * is a duplicate. Every insertion, deletion, or reordering remains in the
 * evidence stream with a seam uncertainty marker for later reconciliation.
 */
export const reconcileChunkSeamWords = (
  chunks: readonly Pick<OpenAITranscriptionChunk, "offsetMs" | "endMs" | "overlapWithPreviousMs">[],
  wordsByChunk: readonly (readonly TimestampedWord[])[],
): readonly TimestampedWord[] => {
  const accepted: ChunkWordCandidate[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const overlapStartMs = chunk.offsetMs;
    const overlapEndMs = chunk.offsetMs + chunk.overlapWithPreviousMs;
    const candidates = (wordsByChunk[chunkIndex] ?? []).map((word) => ({ ...word, chunkIndex }));
    if (chunk.overlapWithPreviousMs === 0) {
      accepted.push(...candidates);
      continue;
    }
    const seamCurrent = candidates
      .filter((word) => overlapMs(word.startMs, word.endMs, overlapStartMs, overlapEndMs) > 0)
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.text.localeCompare(right.text));
    const nonSeamCurrent = candidates.filter((word) => overlapMs(word.startMs, word.endMs, overlapStartMs, overlapEndMs) === 0);
    const seamPrevious = accepted
      .map((word, acceptedIndex) => ({ word, acceptedIndex }))
      .filter(({ word }) => word.chunkIndex === chunkIndex - 1 && overlapMs(word.startMs, word.endMs, overlapStartMs, overlapEndMs) > 0)
      .sort((left, right) => (
        left.word.startMs - right.word.startMs
        || left.word.endMs - right.word.endMs
        || left.word.text.localeCompare(right.word.text)
        || left.acceptedIndex - right.acceptedIndex
      ));
    const matches = orderedSeamMatches(seamPrevious, seamCurrent);
    const matchedPrevious = new Set(matches.map(([previousIndex]) => previousIndex));
    const matchedCurrent = new Set(matches.map(([, currentIndex]) => currentIndex));
    // A word present in one provider response but not the ordered shared
    // sequence is a deletion/reordering witness. Retain it and surface the
    // uncertainty rather than silently picking one chunk's transcript.
    for (const [previousIndex, previous] of seamPrevious.entries()) {
      if (!matchedPrevious.has(previousIndex)) {
        accepted[previous.acceptedIndex] = { ...previous.word, chunkSeamConflict: true };
      }
    }
    for (const [currentIndex, candidate] of seamCurrent.entries()) {
      if (matchedCurrent.has(currentIndex)) continue;
      accepted.push({ ...candidate, chunkSeamConflict: true });
    }
    accepted.push(...nonSeamCurrent);
  }
  return accepted
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.chunkIndex - right.chunkIndex || left.text.localeCompare(right.text))
    .map(({ chunkIndex, ...word }) => {
      void chunkIndex;
      return word;
    });
};

/** Real HTTP adapter. It is unreachable unless `CUEBENCH_OPENAI_MODE=live`. */
export class LiveOpenAIProvider implements OpenAIProvider {
  public readonly mode = "live" as const;

  public constructor(private readonly settings: LiveOpenAIProviderSettings) {}

  public async diarize(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>> {
    const chunks = splitWavForOpenAITranscription(input);
    if (chunks.length === 1) return this.diarizeChunk(chunks[0]!.input);
    const results: ProviderResult<DiarizedTranscript>[] = [];
    for (const chunk of chunks) results.push(await this.diarizeChunk(chunk.input));
    return this.aggregateDiarization(input, chunks, results);
  }

  private async diarizeChunk(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>> {
    const requestHash = await audioRequestHash("diarize", input);
    const multipart = this.transcriptionMultipart(input, "diarize");
    const response = await this.settings.fetch(new Request(`${this.settings.baseUrl}${OPENAI_TRANSCRIPTIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": multipart.contentType },
      body: multipart.body as unknown as BodyInit,
    }));
    const result = await readOpenAIJson(response, "CueBench's diarization provider is unavailable.");
    return {
      provider: "openai",
      model: resolvedModel(result.parsed, "gpt-4o-transcribe-diarize"),
      requestHash,
      responseHash: result.responseHash,
      rawResponseSha256: result.responseHash,
      store: null,
      background: null,
      usage: parseUsage(asRecord(result.parsed)?.usage),
      providerResponseId: providerResponseId(result.parsed),
      requestMetadata: {
        endpoint: OPENAI_TRANSCRIPTIONS_PATH,
        method: "POST",
        requestedModel: "gpt-4o-transcribe-diarize",
        responseFormat: "diarized_json",
        chunkingStrategy: input.durationMs > 30_000 ? "auto" : "not-required",
        timestampGranularities: "unsupported-by-gpt-4o-transcribe-diarize",
      },
      warnings: providerWarnings(result.parsed),
      value: parseDiarizedTranscript(result.parsed),
    };
  }

  public async wordTimestamps(input: NormalizedAudioInput): Promise<ProviderResult<WordTimestampTranscript>> {
    const chunks = splitWavForOpenAITranscription(input);
    if (chunks.length === 1) return this.wordTimestampsChunk(chunks[0]!.input);
    const results: ProviderResult<WordTimestampTranscript>[] = [];
    for (const chunk of chunks) results.push(await this.wordTimestampsChunk(chunk.input));
    return this.aggregateWordTimestamps(input, chunks, results);
  }

  private async wordTimestampsChunk(input: NormalizedAudioInput): Promise<ProviderResult<WordTimestampTranscript>> {
    const requestHash = await audioRequestHash("word_timestamps", input);
    const multipart = this.transcriptionMultipart(input, "word_timestamps");
    const response = await this.settings.fetch(new Request(`${this.settings.baseUrl}${OPENAI_TRANSCRIPTIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": multipart.contentType },
      body: multipart.body as unknown as BodyInit,
    }));
    const result = await readOpenAIJson(response, "CueBench's word-timestamp provider is unavailable.");
    return {
      provider: "openai",
      model: resolvedModel(result.parsed, "whisper-1"),
      requestHash,
      responseHash: result.responseHash,
      rawResponseSha256: result.responseHash,
      store: null,
      background: null,
      usage: parseUsage(asRecord(result.parsed)?.usage),
      providerResponseId: providerResponseId(result.parsed),
      requestMetadata: {
        endpoint: OPENAI_TRANSCRIPTIONS_PATH,
        method: "POST",
        requestedModel: "whisper-1",
        responseFormat: "verbose_json",
        timestampGranularities: "word",
      },
      warnings: providerWarnings(result.parsed),
      value: parseWordTimestampTranscript(result.parsed),
    };
  }

  private async aggregateTranscriptProvenance<Value>(
    input: NormalizedAudioInput,
    chunks: readonly OpenAITranscriptionChunk[],
    results: readonly ProviderResult<Value>[],
  ): Promise<Omit<ProviderResult<Value>, "value">> {
    const first = results[0];
    if (first === undefined || results.length !== chunks.length) {
      throw new OpenAIProviderError("CueBench cannot reconcile OpenAI transcription chunks.", false);
    }
    const chunkLayout = chunks.map((chunk) => ({
      offsetMs: chunk.offsetMs,
      endMs: chunk.endMs,
      durationMs: chunk.input.durationMs,
      overlapWithPreviousMs: chunk.overlapWithPreviousMs,
      byteLength: normalizedAudioBytes(chunk.input.bytes).byteLength,
    }));
    const chunkLayoutSha256 = await sha256Hex(JSON.stringify(chunkLayout));
    return {
      provider: "openai",
      model: first.model,
      requestHash: await sha256Hex(JSON.stringify({
        sourceAudioSha256: await sha256Hex(normalizedAudioBytes(input.bytes)),
        requestHashes: results.map((result) => result.requestHash),
        chunkLayoutSha256,
      })),
      responseHash: await sha256Hex(results.map((result) => result.responseHash).join(":")),
      rawResponseSha256: await sha256Hex(results.map((result) => result.rawResponseSha256).join(":")),
      store: null,
      background: null,
      usage: aggregateUsage(results),
      // There is no one upstream response id for a composite transcript.
      providerResponseId: null,
      requestMetadata: {
        ...(first.requestMetadata ?? {}),
        sourceAudioChunking: "wav-overlap-frame-aligned",
        sourceAudioChunkCount: String(chunks.length),
        sourceAudioChunkOverlapMs: String(Math.max(0, ...chunks.map((chunk) => chunk.overlapWithPreviousMs))),
        sourceAudioChunkLayoutSha256: chunkLayoutSha256,
      },
      warnings: [...new Set(results.flatMap((result) => result.warnings ?? []))].slice(0, 32),
    };
  }

  private async aggregateDiarization(
    input: NormalizedAudioInput,
    chunks: readonly OpenAITranscriptionChunk[],
    results: readonly ProviderResult<DiarizedTranscript>[],
  ): Promise<ProviderResult<DiarizedTranscript>> {
    const provenance = await this.aggregateTranscriptProvenance(input, chunks, results);
    const segments: DiarizedSegment[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const value = results[chunkIndex]!.value;
      for (const [segmentIndex, segment] of value.segments.entries()) {
        const startMs = chunk.offsetMs + segment.startMs;
        const endMs = chunk.offsetMs + segment.endMs;
        if (startMs < chunk.offsetMs || endMs <= startMs || endMs > chunk.endMs || endMs > input.durationMs) {
          throw new OpenAIProviderError("CueBench received a diarization timestamp outside its bounded OpenAI chunk.", false);
        }
        segments.push({
          // Chunking needs globally unique evidence identifiers; do not trust
          // an upstream segment id to be unique across independent requests.
          id: `speaker-chunk-${chunkIndex + 1}-${segmentIndex + 1}`,
          startMs,
          endMs,
          // Diarization labels are local to each independent request. Prefix
          // them rather than making a false cross-chunk speaker-identity
          // claim; the overlapped segments become visible uncertainty.
          speaker: `chunk-${chunkIndex + 1}:${segment.speaker}`,
          text: segment.text,
        });
      }
    }
    return {
      ...provenance,
      warnings: [...new Set([
        ...(provenance.warnings ?? []),
        "speaker-identities-are-chunk-local",
      ])].slice(0, 32),
      value: {
        text: results.map((result) => result.value.text.trim()).filter(Boolean).join(" "),
        durationMs: input.durationMs,
        segments,
      },
    };
  }

  private async aggregateWordTimestamps(
    input: NormalizedAudioInput,
    chunks: readonly OpenAITranscriptionChunk[],
    results: readonly ProviderResult<WordTimestampTranscript>[],
  ): Promise<ProviderResult<WordTimestampTranscript>> {
    const provenance = await this.aggregateTranscriptProvenance(input, chunks, results);
    const wordsByChunk: TimestampedWord[][] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const value = results[chunkIndex]!.value;
      const words: TimestampedWord[] = [];
      for (const word of value.words) {
        const startMs = chunk.offsetMs + word.startMs;
        const endMs = chunk.offsetMs + word.endMs;
        if (startMs < chunk.offsetMs || endMs <= startMs || endMs > chunk.endMs || endMs > input.durationMs) {
          throw new OpenAIProviderError("CueBench received a word timestamp outside its bounded OpenAI chunk.", false);
        }
        words.push({ ...word, startMs, endMs });
      }
      wordsByChunk.push(words);
    }
    const words = reconcileChunkSeamWords(chunks, wordsByChunk);
    return {
      ...provenance,
      warnings: [...new Set([
        ...(provenance.warnings ?? []),
        ...(words.some((word) => word.chunkSeamConflict) ? ["chunk-seam-word-disagreement"] : []),
      ])].slice(0, 32),
      value: {
        text: words.map((word) => word.text).join(" "),
        words,
      },
    };
  }

  public async reconcile(input: ReconciliationRequest): Promise<ProviderResult<ReconciliationResponse>> {
    const body = {
      model: this.settings.reconciliationModel,
      background: false,
      store: false,
      stream: false,
      tools: [],
      tool_choice: "none",
      parallel_tool_calls: false,
      max_output_tokens: 1_200,
      instructions: "Reconcile only the supplied evidence-linked transcript words. Return replacements only for allowed_word_ids. Do not infer a speaker, timestamp, or word that is not supported by this evidence.",
      input: JSON.stringify({
        window_id: input.windowId,
        allowed_word_ids: input.allowedWordIds,
        words: input.words.map((word) => ({
          word_id: word.id,
          text: word.text,
          normalized_text: word.normalizedText,
          start_ms: word.startMs,
          end_ms: word.endMs,
          speaker: word.speaker,
          diarization_segment_ids: word.diarizationSegmentIds,
        })),
      }),
      text: {
        format: {
          type: "json_schema",
          name: "cuebench_transcript_reconciliation",
          strict: true,
          schema: ReconciliationResponseJsonSchema,
        },
      },
    } as const;
    const response = await this.settings.fetch(new Request(`${this.settings.baseUrl}${OPENAI_RESPONSES_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));
    const result = await readOpenAIJson(response, "CueBench's reconciliation provider is unavailable.");
    const record = asRecord(result.parsed);
    if (record?.status !== undefined && record.status !== "completed") {
      throw new OpenAIProviderError(
        "CueBench's reconciliation provider did not complete in the foreground.",
        false,
        "accepted-unknown",
      );
    }
    const output = responseOutputText(result.parsed);
    if (output === null) throw new OpenAIProviderError("CueBench received an invalid structured reconciliation response.", false);
    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(output) as unknown;
    } catch {
      throw new OpenAIProviderError("CueBench received an invalid structured reconciliation response.", false);
    }
    return {
      provider: "openai",
      model: resolvedModel(result.parsed, this.settings.reconciliationModel),
      requestHash: await sha256Hex(JSON.stringify(body)),
      responseHash: result.responseHash,
      rawResponseSha256: result.responseHash,
      store: false,
      background: false,
      usage: parseUsage(record?.usage),
      providerResponseId: providerResponseId(result.parsed),
      requestMetadata: {
        endpoint: OPENAI_RESPONSES_PATH,
        method: "POST",
        requestedModel: body.model,
        background: "false",
        store: "false",
        stream: "false",
        tools: "none",
        parallelToolCalls: "false",
        maxOutputTokens: "1200",
        structuredOutput: "json_schema",
        structuredOutputName: "cuebench_transcript_reconciliation",
        structuredOutputStrict: "true",
        structuredOutputSchemaSha256: await sha256Hex(JSON.stringify(ReconciliationResponseJsonSchema)),
        structuredOutputSchemaVersion: RECONCILIATION_SCHEMA_VERSION,
        instructionsSha256: await sha256Hex(body.instructions),
        promptVersion: RECONCILIATION_PROMPT_VERSION,
        inputSha256: await sha256Hex(body.input),
      },
      warnings: providerWarnings(result.parsed),
      value: normalizedReconciliationResponse(parsedOutput),
    };
  }

  private transcriptionMultipart(input: NormalizedAudioInput, kind: "diarize" | "word_timestamps"): MultipartPayload {
    if (kind === "diarize") {
      const fields: Array<readonly [string, string]> = [
        ["model", "gpt-4o-transcribe-diarize"],
        ["response_format", "diarized_json"],
      ];
      // The diarization endpoint requires auto chunking beyond 30 seconds.
      if (input.durationMs > 30_000) fields.push(["chunking_strategy", "auto"]);
      // Deliberately do not send timestamp_granularities: this model rejects it.
      return transcriptionMultipart(input, fields);
    } else {
      return transcriptionMultipart(input, [
        ["model", "whisper-1"],
        ["response_format", "verbose_json"],
        ["timestamp_granularities[]", "word"],
      ]);
    }
  }
}

/** Deterministic fixture adapter for tests, local replay, and no-key development. */
export class FixtureOpenAIProvider implements OpenAIProvider {
  public readonly mode = "fixture" as const;

  public constructor(private readonly fixtures: FixtureOpenAIResponses = {}) {}

  public async diarize(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>> {
    const value = this.fixtures.diarization ?? fixtureDiarization(input);
    return this.fixtureResult("diarize", {
      durationMs: input.durationMs,
      fileName: input.fileName,
      byteLength: assertNormalizedAudio(input).byteLength,
    }, value, null, null);
  }

  public async wordTimestamps(input: NormalizedAudioInput): Promise<ProviderResult<WordTimestampTranscript>> {
    const value = this.fixtures.wordTimestamps ?? fixtureWordTimestamps(input);
    return this.fixtureResult("word_timestamps", {
      durationMs: input.durationMs,
      fileName: input.fileName,
      byteLength: assertNormalizedAudio(input).byteLength,
    }, value, null, null);
  }

  public async reconcile(input: ReconciliationRequest): Promise<ProviderResult<ReconciliationResponse>> {
    const value = this.fixtures.reconciliation ?? { replacements: [] };
    return this.fixtureResult("reconcile", input, normalizedReconciliationResponse(value), false, false);
  }

  private async fixtureResult<Value>(
    operation: string,
    request: unknown,
    value: Value,
    store: false | null,
    background: false | null,
  ): Promise<ProviderResult<Value>> {
    const raw = JSON.stringify(value);
    const responseHash = await sha256Hex(raw);
    return {
      provider: "fixture",
      model: "fixture",
      requestHash: await sha256Hex(JSON.stringify({ operation, request })),
      responseHash,
      rawResponseSha256: responseHash,
      store,
      background,
      usage: null,
      providerResponseId: null,
      requestMetadata: { mode: "fixture", operation },
      warnings: [],
      value,
    };
  }
}

const fixtureDiarization = (input: NormalizedAudioInput): DiarizedTranscript => ({
  text: "CueBench fixture",
  durationMs: input.durationMs,
  segments: [{
    id: "fixture-speaker-a-0",
    startMs: 0,
    endMs: input.durationMs,
    speaker: "A",
    text: "CueBench fixture",
  }],
});

const fixtureWordTimestamps = (input: NormalizedAudioInput): WordTimestampTranscript => {
  const split = Math.max(1, Math.floor(input.durationMs / 2));
  if (split >= input.durationMs) {
    return { text: "CueBench", words: [{ text: "CueBench", startMs: 0, endMs: input.durationMs }] };
  }
  return {
    text: "CueBench fixture",
    words: [
      { text: "CueBench", startMs: 0, endMs: split },
      { text: "fixture", startMs: split, endMs: input.durationMs },
    ],
  };
};
