import { z } from "zod";

/** The only model role used for bounded transcript reconciliation. */
export const DEFAULT_RECONCILIATION_MODEL = "gpt-5.6-terra";
export const OPENAI_TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions";
export const OPENAI_RESPONSES_PATH = "/v1/responses";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ITEMS = 100_000;
const MAX_RECONCILIATION_REPLACEMENTS = 48;
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

export class OpenAIProviderError extends Error {
  public readonly name = "OpenAIProviderError";

  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
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

const readBoundedText = async (response: Response): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)) {
    throw new OpenAIProviderError("CueBench received an oversized provider response.", true);
  }
  if (response.body === null) throw new OpenAIProviderError("CueBench received an empty provider response.", true);
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
        throw new OpenAIProviderError("CueBench received an oversized provider response.", true);
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
    throw new OpenAIProviderError(unavailableMessage, response.status >= 500 || response.status === 429);
  }
  try {
    return { raw, parsed: JSON.parse(raw) as unknown, responseHash };
  } catch {
    throw new OpenAIProviderError(unavailableMessage, false);
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

/** Real HTTP adapter. It is unreachable unless `CUEBENCH_OPENAI_MODE=live`. */
export class LiveOpenAIProvider implements OpenAIProvider {
  public readonly mode = "live" as const;

  public constructor(private readonly settings: LiveOpenAIProviderSettings) {}

  public async diarize(input: NormalizedAudioInput): Promise<ProviderResult<DiarizedTranscript>> {
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
      throw new OpenAIProviderError("CueBench's reconciliation provider did not complete in the foreground.", true);
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
        instructionsSha256: await sha256Hex(body.instructions),
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
