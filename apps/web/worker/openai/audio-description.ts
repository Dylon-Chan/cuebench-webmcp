import { z } from "zod";
import {
  OpenAIProviderError,
  type OpenAIFetch,
  type OpenAIProviderEnvironment,
  type ProviderResult,
  sha256Hex,
} from "./client";

/** The same configurable reasoning role as caption reconciliation by default. */
export const DEFAULT_AUDIO_DESCRIPTION_MODEL = "gpt-5.6-terra";
export const AUDIO_DESCRIPTION_PROMPT_VERSION = "cuebench-ad-proposal-v1";
export const AUDIO_DESCRIPTION_SCHEMA_VERSION = "cuebench-ad-proposal-schema-v1";
export const OPENAI_RESPONSES_PATH = "/v1/responses";
export const MAX_AUDIO_DESCRIPTION_FRAMES = 12;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSALS = 24;

export interface AudioDescriptionProviderWindow {
  readonly windowId: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface AudioDescriptionProviderCaption {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface AudioDescriptionProviderGap {
  readonly startMs: number;
  readonly endMs: number;
}

export interface AudioDescriptionProviderFrame {
  readonly evidenceId: string;
  readonly atMs: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface AudioDescriptionProviderRequest {
  readonly runId: string;
  readonly window: AudioDescriptionProviderWindow;
  readonly transcript: readonly AudioDescriptionProviderCaption[];
  readonly speechGaps: readonly AudioDescriptionProviderGap[];
  readonly sceneTimestamps: readonly number[];
  readonly frames: readonly AudioDescriptionProviderFrame[];
}

export interface AudioDescriptionProposalValue {
  readonly proposalId: string;
  readonly text: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  readonly placementIntent: { readonly anchorMs: number; readonly desiredDurationMs: number };
}

export interface AudioDescriptionProposalResponse {
  readonly proposals: readonly AudioDescriptionProposalValue[];
}

export interface AudioDescriptionProvider {
  readonly mode: "fixture" | "live";
  readonly model: string;
  propose: (input: AudioDescriptionProviderRequest) => Promise<ProviderResult<AudioDescriptionProposalResponse>>;
}

export interface AudioDescriptionProviderOptions {
  readonly fetch?: OpenAIFetch;
  readonly baseUrl?: string;
  readonly model?: string;
}

const AudioDescriptionResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: MAX_PROPOSALS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["proposal_id", "text", "rationale", "evidence_ids", "placement_intent"],
        properties: {
          proposal_id: { type: "string", minLength: 1, maxLength: 160 },
          text: { type: "string", minLength: 1, maxLength: 1_000 },
          rationale: { type: "string", minLength: 1, maxLength: 2_000 },
          evidence_ids: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 160 },
          },
          placement_intent: {
            type: "object",
            additionalProperties: false,
            required: ["anchor_ms", "desired_duration_ms"],
            properties: {
              anchor_ms: { type: "integer", minimum: 0 },
              desired_duration_ms: { type: "integer", minimum: 1, maximum: 10_000 },
            },
          },
        },
      },
    },
  },
} as const;

const ProposalResponseSchema = z.object({
  proposals: z.array(z.object({
    proposal_id: z.string().trim().min(1).max(160),
    text: z.string().trim().min(1).max(1_000),
    rationale: z.string().trim().min(1).max(2_000),
    evidence_ids: z.array(z.string().trim().min(1).max(160)).min(1).max(64),
    placement_intent: z.object({
      anchor_ms: z.number().int().nonnegative(),
      desired_duration_ms: z.number().int().positive().max(10_000),
    }).strict(),
  }).strict()).max(MAX_PROPOSALS),
}).strict();

const baseUrl = (value: string | undefined): string => {
  const candidate = value?.trim() || "https://api.openai.com";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OpenAIProviderError("CueBench OpenAI base URL is invalid.", false);
  }
  return url.toString().replace(/\/$/u, "");
};

const resolvedModel = (value: string | undefined): string => {
  const model = value?.trim() || DEFAULT_AUDIO_DESCRIPTION_MODEL;
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(model)) throw new OpenAIProviderError("CueBench audio-description model is invalid.", false);
  return model;
};

const responseOutputText = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.output)) return null;
  const text: string[] = [];
  for (const item of record.output) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const content = (item as Readonly<Record<string, unknown>>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const candidate = part as Readonly<Record<string, unknown>>;
      if (candidate.type === "output_text" && typeof candidate.text === "string") text.push(candidate.text);
    }
  }
  return text.length === 1 ? text[0]! : null;
};

const responseUsage = (value: unknown): { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly totalTokens: number | null; readonly audioSeconds: null } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const usage = (value as Readonly<Record<string, unknown>>).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Readonly<Record<string, unknown>>;
  const field = (name: string): number | null => typeof record[name] === "number" && Number.isFinite(record[name]) && record[name] >= 0
    ? record[name] as number
    : null;
  return { inputTokens: field("input_tokens"), outputTokens: field("output_tokens"), totalTokens: field("total_tokens"), audioSeconds: null };
};

const resultId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Readonly<Record<string, unknown>>).id;
  return typeof candidate === "string" ? candidate : null;
};

const responseWarnings = (value: unknown): readonly string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const warnings = (value as Readonly<Record<string, unknown>>).warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === "string").map((warning) => warning.trim()).filter(Boolean).slice(0, 32)
    : [];
};

const responseCompletedWithoutRefusal = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.status !== "completed") return false;
  if (!Array.isArray(record.output)) return true;
  return !record.output.some((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const content = (item as Readonly<Record<string, unknown>>).content;
    return Array.isArray(content) && content.some((part) => (
      typeof part === "object" && part !== null && !Array.isArray(part)
      && (part as Readonly<Record<string, unknown>>).type === "refusal"
    ));
  });
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.byteLength)));
  }
  return btoa(binary);
};

const assertRequest = (input: AudioDescriptionProviderRequest): void => {
  if (
    !input.runId.trim()
    || !input.window.windowId.trim()
    || !Number.isSafeInteger(input.window.startMs)
    || !Number.isSafeInteger(input.window.endMs)
    || input.window.startMs < 0
    || input.window.endMs <= input.window.startMs
    || input.frames.length > MAX_AUDIO_DESCRIPTION_FRAMES
    || input.transcript.length > 500
    || input.speechGaps.length > 512
    || input.sceneTimestamps.length > 512
  ) throw new OpenAIProviderError("CueBench received an invalid bounded audio-description request.", false);
  const ids = new Set<string>();
  for (const frame of input.frames) {
    if (
      !frame.evidenceId.trim()
      || ids.has(frame.evidenceId)
      || !Number.isSafeInteger(frame.atMs)
      || frame.atMs < input.window.startMs
      || frame.atMs > input.window.endMs
      || !/^image\/(?:webp|jpeg|png)$/iu.test(frame.mimeType)
      || !/^[0-9a-f]{64}$/iu.test(frame.sha256)
      || frame.bytes.byteLength <= 0
      || frame.bytes.byteLength > MAX_FRAME_BYTES
    ) throw new OpenAIProviderError("CueBench received invalid bounded visual evidence.", false);
    ids.add(frame.evidenceId);
  }
};

/**
 * Captions, scene boundaries, and speech gaps guide the model, but only
 * retained frame IDs may become adoption-facing evidence. That preserves the
 * staged AD contract: every proposed beat and extended-description
 * requirement has a compact visual artifact a reviewer can inspect.
 */
const allowedEvidenceIds = (input: AudioDescriptionProviderRequest): ReadonlySet<string> => new Set(
  input.frames.map((frame) => frame.evidenceId),
);

const normalizeResponse = (value: unknown, input: AudioDescriptionProviderRequest): AudioDescriptionProposalResponse => {
  const parsed = ProposalResponseSchema.safeParse(value);
  if (!parsed.success) throw new OpenAIProviderError("CueBench received invalid structured audio-description output.", false, "accepted-unknown");
  const allowed = allowedEvidenceIds(input);
  const seenIds = new Set<string>();
  const proposals = parsed.data.proposals.map((proposal) => {
    if (seenIds.has(proposal.proposal_id)) throw new OpenAIProviderError("CueBench received duplicate audio-description proposal ids.", false, "accepted-unknown");
    seenIds.add(proposal.proposal_id);
    const evidenceIds = [...new Set(proposal.evidence_ids)].sort();
    if (evidenceIds.some((evidenceId) => !allowed.has(evidenceId))) {
      throw new OpenAIProviderError("CueBench rejected audio-description output that cites unavailable evidence.", false, "accepted-unknown");
    }
    return {
      proposalId: proposal.proposal_id,
      text: proposal.text,
      rationale: proposal.rationale,
      evidenceIds,
      placementIntent: {
        anchorMs: proposal.placement_intent.anchor_ms,
        desiredDurationMs: proposal.placement_intent.desired_duration_ms,
      },
    };
  });
  return { proposals };
};

const boundedJson = async (response: Response): Promise<{ readonly value: unknown; readonly responseHash: string }> => {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new OpenAIProviderError("CueBench received an oversized audio-description provider response.", response.status === 429, response.status === 429 ? "safe-to-replay" : "accepted-unknown");
  }
  const body = response.body;
  if (body === null) throw new OpenAIProviderError("CueBench received an empty audio-description provider response.", false, "accepted-unknown");
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let lengthRead = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      lengthRead += part.value.byteLength;
      if (lengthRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIProviderError("CueBench received an oversized audio-description provider response.", response.status === 429, response.status === 429 ? "safe-to-replay" : "accepted-unknown");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(lengthRead);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  const raw = new TextDecoder().decode(combined);
  const responseHash = await sha256Hex(raw);
  if (!response.ok) {
    throw new OpenAIProviderError(
      "CueBench's audio-description provider is unavailable.",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? "safe-to-replay" : response.status >= 500 ? "accepted-unknown" : "terminal",
    );
  }
  try {
    return { value: JSON.parse(raw) as unknown, responseHash };
  } catch {
    throw new OpenAIProviderError("CueBench received malformed audio-description provider output.", false, "accepted-unknown");
  }
};

const requestBody = (input: AudioDescriptionProviderRequest, model: string) => {
  const evidence = {
    run_id: input.runId,
    window: { window_id: input.window.windowId, start_ms: input.window.startMs, end_ms: input.window.endMs },
    transcript: input.transcript.map((caption) => ({
      evidence_id: caption.itemId,
      item_revision: caption.itemRevision,
      start_ms: caption.startMs,
      end_ms: caption.endMs,
      text: caption.text,
    })),
    speech_gaps: input.speechGaps.map((gap) => ({
      evidence_id: `gap-${gap.startMs}-${gap.endMs}`,
      start_ms: gap.startMs,
      end_ms: gap.endMs,
    })),
    scene_boundaries: input.sceneTimestamps.map((timestamp) => ({ evidence_id: `scene-${timestamp}`, at_ms: timestamp })),
    frames: input.frames.map((frame) => ({ evidence_id: frame.evidenceId, at_ms: frame.atMs, sha256: frame.sha256 })),
  };
  return {
    model,
    background: false,
    // This endpoint supports Responses data controls, unlike /audio/speech.
    store: false,
    stream: false,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    max_output_tokens: 1_600,
    instructions: "Propose only essential audio descriptions supported by the supplied evidence. Never narrate dialogue, invent unseen details, or choose final timings. Return an empty proposal list when the visual information is not essential. Cite only evidence_ids supplied in this window.",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: JSON.stringify(evidence) },
        ...input.frames.map((frame) => ({
          type: "input_image" as const,
          image_url: `data:${frame.mimeType};base64,${bytesToBase64(frame.bytes)}`,
          detail: "low" as const,
        })),
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "cuebench_audio_description_proposals",
        strict: true,
        schema: AudioDescriptionResponseJsonSchema,
      },
    },
  } as const;
};

class FixtureAudioDescriptionProvider implements AudioDescriptionProvider {
  public readonly mode = "fixture" as const;
  public readonly model = "fixture";

  public async propose(input: AudioDescriptionProviderRequest): Promise<ProviderResult<AudioDescriptionProposalResponse>> {
    assertRequest(input);
    const firstFrame = input.frames[0]?.evidenceId;
    const proposals = firstFrame === undefined ? [] : [{
      proposalId: `fixture-${input.window.windowId}`,
      text: "A visual reference appears beside the speaker.",
      rationale: "The visual provides context that is not fully available in the spoken transcript.",
      evidenceIds: [firstFrame],
      placementIntent: { anchorMs: input.window.startMs, desiredDurationMs: 1_500 },
    }];
    const requestHash = await sha256Hex(JSON.stringify({
      window: input.window,
      transcript: input.transcript,
      speechGaps: input.speechGaps,
      sceneTimestamps: input.sceneTimestamps,
      frameEvidence: input.frames.map((frame) => ({ evidenceId: frame.evidenceId, atMs: frame.atMs, sha256: frame.sha256 })),
      evidenceIds: [...allowedEvidenceIds(input)].sort(),
    }));
    const responseHash = await sha256Hex(JSON.stringify(proposals));
    return {
      provider: "fixture",
      model: this.model,
      requestHash,
      responseHash,
      rawResponseSha256: responseHash,
      store: false,
      background: false,
      usage: null,
      providerResponseId: null,
      requestMetadata: { endpoint: "fixture://cuebench/ad-proposals", method: "FIXTURE", promptVersion: AUDIO_DESCRIPTION_PROMPT_VERSION, structuredOutputSchemaVersion: AUDIO_DESCRIPTION_SCHEMA_VERSION },
      warnings: [],
      value: { proposals },
    };
  }
}

class LiveAudioDescriptionProvider implements AudioDescriptionProvider {
  public readonly mode = "live" as const;

  public constructor(
    private readonly settings: { readonly apiKey: string; readonly baseUrl: string; readonly model: string; readonly fetch: OpenAIFetch },
  ) {}

  public get model(): string {
    return this.settings.model;
  }

  public async propose(input: AudioDescriptionProviderRequest): Promise<ProviderResult<AudioDescriptionProposalResponse>> {
    assertRequest(input);
    const body = requestBody(input, this.settings.model);
    const serialized = JSON.stringify(body);
    const requestHash = await sha256Hex(serialized);
    const response = await this.settings.fetch(new Request(`${this.settings.baseUrl}${OPENAI_RESPONSES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": "application/json" },
      body: serialized,
    }));
    const received = await boundedJson(response);
    if (!responseCompletedWithoutRefusal(received.value)) {
      // A completed HTTP response is not proof that structured output is
      // available. Incomplete/failed/refusal Responses may already have been
      // accepted upstream, so retain the durable pre-call hold and never
      // replay them automatically.
      throw new OpenAIProviderError("CueBench received an incomplete or refused audio-description Responses result.", false, "accepted-unknown");
    }
    const output = responseOutputText(received.value);
    if (output === null) throw new OpenAIProviderError("CueBench received no structured audio-description output.", false, "accepted-unknown");
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      throw new OpenAIProviderError("CueBench received malformed structured audio-description output.", false, "accepted-unknown");
    }
    const value = normalizeResponse(parsed, input);
    const record = received.value as Readonly<Record<string, unknown>>;
    const model = typeof record.model === "string" && record.model.trim() ? record.model : this.settings.model;
    return {
      provider: "openai",
      model,
      requestHash,
      responseHash: received.responseHash,
      rawResponseSha256: received.responseHash,
      store: false,
      background: false,
      usage: responseUsage(received.value),
      providerResponseId: resultId(received.value),
      requestMetadata: {
        endpoint: OPENAI_RESPONSES_PATH,
        method: "POST",
        requestedModel: this.settings.model,
        promptVersion: AUDIO_DESCRIPTION_PROMPT_VERSION,
        structuredOutputSchemaVersion: AUDIO_DESCRIPTION_SCHEMA_VERSION,
        frameCount: String(input.frames.length),
      },
      warnings: responseWarnings(received.value),
      value,
    };
  }
}

/**
 * Live traffic requires explicit opt-in and a server-only API key, mirroring
 * the caption provider boundary. A key in a browser bundle cannot activate it.
 */
export const createAudioDescriptionProvider = (
  environment: OpenAIProviderEnvironment,
  options: AudioDescriptionProviderOptions = {},
): AudioDescriptionProvider => {
  const mode = environment.CUEBENCH_OPENAI_MODE?.trim();
  if (mode === undefined || mode === "" || mode === "fixture") return new FixtureAudioDescriptionProvider();
  if (mode !== "live") throw new OpenAIProviderError("CueBench OpenAI mode must be fixture or live.", false);
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") throw new OpenAIProviderError("CueBench live OpenAI mode requires server-side credentials.", false);
  return new LiveAudioDescriptionProvider({
    apiKey,
    baseUrl: baseUrl(options.baseUrl ?? environment.CUEBENCH_OPENAI_BASE_URL),
    model: resolvedModel(options.model),
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
};
