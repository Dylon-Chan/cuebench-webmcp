import { canonicalHash } from "@cuebench/domain";
import type { R2Bucket, R2Conditional } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { wavDurationMs } from "../src/shared/wav";
import { resolveWorkerSettings, type WorkerEnv, type WorkerSettings } from "./env";
import { OpenAIProviderError } from "./openai/client";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_RESPONSE_FORMAT,
  DEFAULT_TTS_VOICE,
  createNarrationTtsProvider,
  type NarrationTtsProvider,
  type NarrationTtsRequest,
} from "./openai/tts";
import { saltedLedgerKey, type QuotaLedgerPort } from "./quota-ledger";
import { SignedTokenError, verifyAnonymousSession } from "./session";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_TTS_TEXT_CHARS = 4_096;
const MAX_TTS_INSTRUCTIONS_CHARS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/iu;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Bindings = { readonly Bindings: WorkerEnv };
export type NarrationPreviewState = "ready" | "calling" | "completed" | "accepted-unknown";

/**
 * This record intentionally contains no narration text, media, audio, object
 * URL, or project aggregate. It is a short-lived private recovery receipt
 * only. Local IndexedDB owns the actual disposable preview Blob and project
 * deletion clears it with the rest of the narration cache.
 */
export interface NarrationPreviewClaims {
  readonly version: 1;
  readonly sessionKey: string;
  readonly ownerKey: string;
  readonly projectKey: string;
  readonly beatKey: string;
  readonly itemRevision: number;
  readonly operationKey: string;
  readonly cacheKey: string;
  readonly requestHash: string;
  readonly expiresAtMs: number;
}

export interface NarrationPreviewRecord {
  readonly version: 1;
  readonly claims: NarrationPreviewClaims;
  readonly state: NarrationPreviewState;
  /** A validated WAV duration is metadata, never a certification/evidence record. */
  readonly durationMs?: number;
  readonly updatedAtMs: number;
}

export type NarrationPreviewEnsureResult =
  | { readonly kind: "created" | "existing"; readonly record: NarrationPreviewRecord }
  | { readonly kind: "conflict" | "expired"; readonly record: NarrationPreviewRecord };

export type NarrationPreviewClaimResult =
  | { readonly kind: "claimed"; readonly record: NarrationPreviewRecord }
  | { readonly kind: "ready" | "calling" | "completed" | "accepted-unknown" | "conflict" | "missing"; readonly record?: NarrationPreviewRecord };

/**
 * A compare-and-swap receipt provides the pre-call write-ahead record that
 * prevents a browser retry from issuing another billable Audio speech request.
 */
export interface NarrationPreviewRecordStore {
  readonly ensure: (input: { readonly claims: NarrationPreviewClaims; readonly nowMs: number }) => Promise<NarrationPreviewEnsureResult>;
  readonly claimProviderCall: (claims: NarrationPreviewClaims) => Promise<NarrationPreviewClaimResult>;
  readonly markRetrySafe: (claims: NarrationPreviewClaims, nowMs: number) => Promise<void>;
  readonly markAcceptedUnknown: (claims: NarrationPreviewClaims, nowMs: number) => Promise<void>;
  readonly complete: (input: { readonly claims: NarrationPreviewClaims; readonly durationMs: number; readonly nowMs: number }) => Promise<NarrationPreviewRecord | null>;
}

const clone = <Value>(value: Value): Value => structuredClone(value);
const onlyIfAbsent = (): R2Conditional => new Headers({ "if-none-match": "*" }) as unknown as R2Conditional;

const sameClaims = (left: NarrationPreviewClaims, right: NarrationPreviewClaims): boolean => (
  left.version === right.version
  && left.sessionKey === right.sessionKey
  && left.ownerKey === right.ownerKey
  && left.projectKey === right.projectKey
  && left.beatKey === right.beatKey
  && left.itemRevision === right.itemRevision
  && left.operationKey === right.operationKey
  && left.cacheKey === right.cacheKey
  && left.requestHash === right.requestHash
);

const validHash = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const validClaims = (value: unknown): value is NarrationPreviewClaims => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Readonly<Record<string, unknown>>;
  return claims.version === 1
    && validHash(claims.sessionKey)
    && validHash(claims.ownerKey)
    && validHash(claims.projectKey)
    && validHash(claims.beatKey)
    && validHash(claims.operationKey)
    && validHash(claims.cacheKey)
    && validHash(claims.requestHash)
    && Number.isSafeInteger(claims.itemRevision) && (claims.itemRevision as number) > 0
    && Number.isSafeInteger(claims.expiresAtMs) && (claims.expiresAtMs as number) >= 0;
};

const parseRecord = (value: unknown): NarrationPreviewRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== 1
    || !validClaims(record.claims)
    || (record.state !== "ready" && record.state !== "calling" && record.state !== "completed" && record.state !== "accepted-unknown")
    || !Number.isSafeInteger(record.updatedAtMs)
    || (record.updatedAtMs as number) < 0
    || (record.durationMs !== undefined && (!Number.isSafeInteger(record.durationMs) || (record.durationMs as number) <= 0 || (record.durationMs as number) > 60_000))
    || (record.state === "completed" && record.durationMs === undefined)
    || (record.state !== "completed" && record.durationMs !== undefined)
  ) return null;
  const claims = record.claims as NarrationPreviewClaims;
  return {
    version: 1,
    claims: {
      ...claims,
      sessionKey: claims.sessionKey.toLowerCase(),
      ownerKey: claims.ownerKey.toLowerCase(),
      projectKey: claims.projectKey.toLowerCase(),
      beatKey: claims.beatKey.toLowerCase(),
      operationKey: claims.operationKey.toLowerCase(),
      cacheKey: claims.cacheKey.toLowerCase(),
      requestHash: claims.requestHash.toLowerCase(),
    },
    state: record.state,
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs as number }),
    updatedAtMs: record.updatedAtMs as number,
  };
};

const freshRecord = (claims: NarrationPreviewClaims, nowMs: number): NarrationPreviewRecord => ({
  version: 1,
  claims,
  state: "ready",
  updatedAtMs: nowMs,
});

export class InMemoryNarrationPreviewRecordStore implements NarrationPreviewRecordStore {
  private readonly records = new Map<string, NarrationPreviewRecord>();

  public async ensure(input: { readonly claims: NarrationPreviewClaims; readonly nowMs: number }): Promise<NarrationPreviewEnsureResult> {
    const existing = this.records.get(input.claims.operationKey);
    if (existing === undefined) {
      const record = freshRecord(input.claims, input.nowMs);
      this.records.set(input.claims.operationKey, clone(record));
      return { kind: "created", record: clone(record) };
    }
    if (!sameClaims(existing.claims, input.claims)) return { kind: "conflict", record: clone(existing) };
    if (existing.claims.expiresAtMs <= input.nowMs) return { kind: "expired", record: clone(existing) };
    return { kind: "existing", record: clone(existing) };
  }

  public async claimProviderCall(claims: NarrationPreviewClaims): Promise<NarrationPreviewClaimResult> {
    const existing = this.records.get(claims.operationKey);
    if (existing === undefined) return { kind: "missing" };
    if (!sameClaims(existing.claims, claims)) return { kind: "conflict", record: clone(existing) };
    if (existing.state !== "ready") return { kind: existing.state, record: clone(existing) };
    const claimed: NarrationPreviewRecord = { ...existing, state: "calling" };
    this.records.set(claims.operationKey, clone(claimed));
    return { kind: "claimed", record: clone(claimed) };
  }

  public async markRetrySafe(claims: NarrationPreviewClaims, nowMs: number): Promise<void> {
    const existing = this.records.get(claims.operationKey);
    if (existing !== undefined && sameClaims(existing.claims, claims) && existing.state === "calling") {
      this.records.set(claims.operationKey, { ...existing, state: "ready", updatedAtMs: Math.max(existing.updatedAtMs, nowMs) });
    }
  }

  public async markAcceptedUnknown(claims: NarrationPreviewClaims, nowMs: number): Promise<void> {
    const existing = this.records.get(claims.operationKey);
    if (existing !== undefined && sameClaims(existing.claims, claims) && (existing.state === "calling" || existing.state === "ready")) {
      this.records.set(claims.operationKey, { ...existing, state: "accepted-unknown", updatedAtMs: Math.max(existing.updatedAtMs, nowMs) });
    }
  }

  public async complete(input: { readonly claims: NarrationPreviewClaims; readonly durationMs: number; readonly nowMs: number }): Promise<NarrationPreviewRecord | null> {
    const existing = this.records.get(input.claims.operationKey);
    if (existing === undefined || !sameClaims(existing.claims, input.claims)) return null;
    if (existing.state === "completed") return clone(existing);
    if (existing.state !== "calling") return null;
    const completed: NarrationPreviewRecord = {
      ...existing,
      state: "completed",
      durationMs: input.durationMs,
      updatedAtMs: Math.max(existing.updatedAtMs, input.nowMs),
    };
    this.records.set(input.claims.operationKey, clone(completed));
    return clone(completed);
  }
}

const recordKey = (operationKey: string): string => `processing/narration-preview-receipts/${operationKey}.json`;

/**
 * R2 stores small salted receipts only. It never stores provider audio, so
 * neither backup, certification, evidence, nor cloud cleanup can surface a
 * narration preview as a project artifact.
 */
export class R2NarrationPreviewRecordStore implements NarrationPreviewRecordStore {
  public constructor(private readonly bucket: R2Bucket) {}

  private async read(operationKey: string): Promise<{ readonly record: NarrationPreviewRecord; readonly etag: string } | null> {
    const object = await this.bucket.get(recordKey(operationKey));
    if (object === null || object.size <= 0 || object.size > MAX_RECORD_BYTES) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(await object.text()); } catch { return null; }
    const record = parseRecord(parsed);
    return record === null ? null : { record, etag: object.etag };
  }

  private async write(record: NarrationPreviewRecord, conditional: R2Conditional): Promise<boolean> {
    const bytes = encoder.encode(JSON.stringify(record));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECORD_BYTES) throw new Error("CueBench narration preview receipt exceeds its private recovery bound.");
    const stored = await this.bucket.put(recordKey(record.claims.operationKey), bytes, {
      onlyIf: conditional,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cuebench_narration_preview_receipt: "1" },
    });
    return stored !== null;
  }

  public async ensure(input: { readonly claims: NarrationPreviewClaims; readonly nowMs: number }): Promise<NarrationPreviewEnsureResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.read(input.claims.operationKey);
      if (current === null) {
        const record = freshRecord(input.claims, input.nowMs);
        if (await this.write(record, onlyIfAbsent())) return { kind: "created", record };
        continue;
      }
      if (!sameClaims(current.record.claims, input.claims)) return { kind: "conflict", record: current.record };
      if (current.record.claims.expiresAtMs <= input.nowMs) return { kind: "expired", record: current.record };
      return { kind: "existing", record: current.record };
    }
    throw new Error("CueBench could not establish a private narration-preview recovery receipt.");
  }

  public async claimProviderCall(claims: NarrationPreviewClaims): Promise<NarrationPreviewClaimResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.read(claims.operationKey);
      if (current === null) return { kind: "missing" };
      if (!sameClaims(current.record.claims, claims)) return { kind: "conflict", record: current.record };
      if (current.record.state !== "ready") return { kind: current.record.state, record: current.record };
      const claimed: NarrationPreviewRecord = { ...current.record, state: "calling" };
      if (await this.write(claimed, { etagMatches: current.etag })) return { kind: "claimed", record: claimed };
    }
    throw new Error("CueBench could not claim its private narration-preview provider call.");
  }

  private async transition(
    claims: NarrationPreviewClaims,
    expected: NarrationPreviewState,
    next: NarrationPreviewState,
    nowMs: number,
    durationMs?: number,
  ): Promise<NarrationPreviewRecord | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.read(claims.operationKey);
      if (current === null || !sameClaims(current.record.claims, claims)) return null;
      if (current.record.state === next) return current.record;
      if (current.record.state !== expected) return null;
      const record: NarrationPreviewRecord = {
        ...current.record,
        state: next,
        ...(durationMs === undefined ? {} : { durationMs }),
        updatedAtMs: Math.max(current.record.updatedAtMs, nowMs),
      };
      if (await this.write(record, { etagMatches: current.etag })) return record;
    }
    throw new Error("CueBench could not settle its private narration-preview recovery receipt.");
  }

  public async markRetrySafe(claims: NarrationPreviewClaims, nowMs: number): Promise<void> {
    await this.transition(claims, "calling", "ready", nowMs);
  }

  public async markAcceptedUnknown(claims: NarrationPreviewClaims, nowMs: number): Promise<void> {
    await this.transition(claims, "calling", "accepted-unknown", nowMs);
  }

  public complete(input: { readonly claims: NarrationPreviewClaims; readonly durationMs: number; readonly nowMs: number }): Promise<NarrationPreviewRecord | null> {
    return this.transition(input.claims, "calling", "completed", input.nowMs, input.durationMs);
  }
}

interface NarrationPreviewRequest extends NarrationTtsRequest {
  readonly projectId: string;
  readonly operationId: string;
  readonly beatId: string;
  readonly itemRevision: number;
  readonly cacheKey: string;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null => typeof value === "object" && value !== null && !Array.isArray(value)
  ? value as Readonly<Record<string, unknown>>
  : null;

const readBoundedJson = async (request: Request): Promise<unknown | null> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) return null;
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(decoder.decode(bytes)); } catch { return null; }
};

const expectedCacheKey = (input: Pick<NarrationPreviewRequest, "beatId" | "itemRevision" | "input" | "model" | "voice" | "instructions" | "responseFormat" | "speed">): string => canonicalHash("cuebench.narration-preview.cache.v1", {
  beatId: input.beatId,
  itemRevision: input.itemRevision,
  text: input.input,
  model: input.model,
  voice: input.voice,
  instructions: input.instructions,
  responseFormat: input.responseFormat,
  speed: input.speed,
}).slice("sha256:".length);

const parseRequest = (value: unknown): NarrationPreviewRequest | null => {
  const input = record(value);
  const fields = ["projectId", "operationId", "beatId", "itemRevision", "text", "model", "voice", "instructions", "responseFormat", "speed", "cacheKey"];
  if (input === null || Object.keys(input).some((key) => !fields.includes(key))) return null;
  if (
    !OPAQUE_ID.test(input.projectId as string)
    || !OPAQUE_ID.test(input.operationId as string)
    || !OPAQUE_ID.test(input.beatId as string)
    || !Number.isSafeInteger(input.itemRevision) || (input.itemRevision as number) <= 0
    || typeof input.text !== "string"
    || typeof input.model !== "string" || input.model.trim() !== DEFAULT_TTS_MODEL
    || typeof input.voice !== "string" || input.voice.trim() !== DEFAULT_TTS_VOICE
    || typeof input.instructions !== "string"
    || input.responseFormat !== DEFAULT_TTS_RESPONSE_FORMAT
    || input.speed !== 1
    || !validHash(input.cacheKey)
  ) return null;
  const text = input.text.trim();
  const instructions = input.instructions.trim();
  if (text.length === 0 || text.length > MAX_TTS_TEXT_CHARS || instructions.length === 0 || instructions.length > MAX_TTS_INSTRUCTIONS_CHARS) return null;
  const parsed: NarrationPreviewRequest = {
    projectId: input.projectId as string,
    operationId: input.operationId as string,
    beatId: input.beatId as string,
    itemRevision: input.itemRevision as number,
    input: text,
    model: input.model.trim(),
    voice: input.voice.trim(),
    instructions,
    responseFormat: DEFAULT_TTS_RESPONSE_FORMAT,
    speed: 1,
    cacheKey: (input.cacheKey as string).toLowerCase(),
  };
  return parsed.cacheKey === expectedCacheKey(parsed) ? parsed : null;
};

const bearer = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
};

const ownerCapability = (request: Request): string | null => {
  const value = request.headers.get("x-cuebench-project-owner")?.trim() ?? "";
  return SHA256.test(value) ? value.toLowerCase() : null;
};

const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";
const apiError = (status: number, code: string, message: string, retrySafe = false): Response => Response.json({
  error: { version: 1, code, message, retrySafe, stateChanged: false, nextAction: retrySafe ? "retry" : "wait-for-status" },
}, { status });

const errorForState = (state: NarrationPreviewState): Response => {
  if (state === "completed") return apiError(409, "TTS_PREVIEW_COMPLETED", "CueBench already completed this narration preview. It will not replay a billable call; this browser can use its cached preview for this exact revision.");
  if (state === "accepted-unknown") return apiError(409, "TTS_PREVIEW_ACCEPTED_UNKNOWN", "CueBench cannot prove whether the provider accepted this narration request, so it will not replay a billable call.");
  return apiError(409, "TTS_PREVIEW_IN_PROGRESS", "CueBench is already preparing this narration preview. It will not start a second provider call.");
};

const claimFor = async (
  settings: WorkerSettings,
  sessionId: string,
  owner: string,
  input: NarrationPreviewRequest,
  currentNow: number,
): Promise<NarrationPreviewClaims> => {
  const [sessionKey, ownerKey, projectKey] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "session", sessionId),
    saltedLedgerKey(settings.quotaSalt, "project-owner", owner),
    saltedLedgerKey(settings.quotaSalt, "project", input.projectId),
  ]);
  const [beatKey, operationKey, requestHash] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "narration-beat", `${projectKey}:${input.beatId}:${input.itemRevision}`),
    saltedLedgerKey(settings.quotaSalt, "narration-preview-operation", `${sessionKey}:${ownerKey}:${input.operationId}`),
    Promise.resolve(canonicalHash("cuebench.narration-preview.request.v1", {
      projectId: input.projectId,
      beatId: input.beatId,
      itemRevision: input.itemRevision,
      cacheKey: input.cacheKey,
      model: input.model,
      voice: input.voice,
      instructions: input.instructions,
      responseFormat: input.responseFormat,
      speed: input.speed,
      text: input.input,
    }).slice("sha256:".length)),
  ]);
  return {
      version: 1,
      sessionKey,
      ownerKey,
      projectKey,
      beatKey,
      itemRevision: input.itemRevision,
      operationKey,
      cacheKey: input.cacheKey,
      requestHash,
      expiresAtMs: currentNow + Math.min(settings.recoveryTtlMs, DAY_MS),
  };
};

export interface NarrationPreviewRouteDependencies {
  readonly clock?: () => number;
  readonly quotaLedger?: QuotaLedgerPort;
  readonly previews?: NarrationPreviewRecordStore;
  readonly tts?: NarrationTtsProvider;
}

/**
 * Same-origin hosted TTS. It has a write-ahead receipt and never accepts an
 * automatic retry after a possibly accepted provider request.
 */
export const createNarrationPreviewRoutes = (env: WorkerEnv, dependencies: NarrationPreviewRouteDependencies = {}) => {
  const app = new Hono<Bindings>();

  app.post("/api/narration-preview", async (context) => {
    const currentNow = dependencies.clock?.() ?? Date.now();
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench narration preview is not configured for this environment.", true); }
    const token = bearer(context.req.raw);
    const owner = ownerCapability(context.req.raw);
    if (token === null || owner === null) return apiError(401, "SESSION_REQUIRED", "A signed anonymous session and matching browser-project owner capability are required for narration preview.");
    let session: Awaited<ReturnType<typeof verifyAnonymousSession>>;
    try {
      session = await verifyAnonymousSession(token, settings.keyRing, currentNow);
      if (session.purpose === "cleanup") return apiError(403, "SESSION_CLEANUP_ONLY", "This session can only clean up private CueBench data.");
    } catch (error) {
      return error instanceof SignedTokenError && error.code === "expired"
        ? apiError(410, "SESSION_EXPIRED", "This anonymous session expired before narration preview could start.")
        : apiError(401, "SESSION_INVALID", "CueBench could not verify this anonymous session.");
    }
    const input = parseRequest(await readBoundedJson(context.req.raw));
    if (input === null) return apiError(400, "TTS_REQUEST_INVALID", "CueBench could not read a bounded narration-preview request with a matching cache identity.");
    const previews = dependencies.previews ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2NarrationPreviewRecordStore(env.PROCESSING_BUCKET));
    const ledger = dependencies.quotaLedger;
    if (previews === undefined || ledger === undefined) return apiError(503, "TTS_COORDINATION_UNAVAILABLE", "CueBench cannot safely coordinate this narration preview right now.", true);
    const claims = await claimFor(settings, session.sessionId, owner, input, currentNow);
    const ipKey = await saltedLedgerKey(settings.quotaSalt, "network", clientIp(context.req.raw));
    let ensured: NarrationPreviewEnsureResult;
    try { ensured = await previews.ensure({ claims, nowMs: currentNow }); } catch { return apiError(503, "TTS_RECEIPT_UNAVAILABLE", "CueBench could not durably establish this narration-preview receipt. No provider call was made.", true); }
    if (ensured.kind === "conflict") return apiError(409, "TTS_IDEMPOTENCY_CONFLICT", "This narration operation id is already bound to different signed project, beat, revision, or synthesis inputs.");
    if (ensured.kind === "expired") return apiError(410, "TTS_RECEIPT_EXPIRED", "This narration-preview recovery receipt expired. Start a fresh operation for the current beat revision.");
    if (ensured.record.state !== "ready") return errorForState(ensured.record.state);

    try {
      if (settings.globalSpendBreakerOpen || await ledger.isGlobalBreakerOpen({ nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents })) {
        return apiError(429, "GLOBAL_BREAKER", "CueBench narration preview is temporarily unavailable while the public-use spend limit is active.", true);
      }
    } catch {
      return apiError(503, "GLOBAL_BREAKER_UNAVAILABLE", "CueBench cannot safely check its public-use spend limit right now.", true);
    }
    let quota;
    try {
      quota = await ledger.reserveTtsOutcome({
        sessionKey: claims.sessionKey,
        ipKey,
        usageKey: await saltedLedgerKey(settings.quotaSalt, "narration-tts-usage", claims.operationKey),
        nowMs: currentNow,
        quotas: settings.quotas,
      });
    } catch {
      return apiError(503, "TTS_QUOTA_UNAVAILABLE", "CueBench cannot safely reserve anonymous narration-preview quota right now.", true);
    }
    if (!quota.accepted) return apiError(429, "TTS_QUOTA", "CueBench's anonymous narration-preview quota has been reached.", true);

    let spend;
    try {
      spend = await ledger.reserveSpend({
        spendKey: `tts:${claims.operationKey}`,
        maxCents: settings.maxTtsProviderCostCents,
        nowMs: currentNow,
        globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
      });
    } catch {
      return apiError(503, "TTS_SPEND_UNAVAILABLE", "CueBench cannot safely reserve narration-preview provider spend right now. No provider call was made.", true);
    }
    if (!spend.accepted) return apiError(429, "GLOBAL_BREAKER", "CueBench narration preview is temporarily unavailable while the public-use spend limit is active.", true);

    const claimed = await previews.claimProviderCall(claims).catch(() => null);
    if (claimed === null) return apiError(503, "TTS_RECEIPT_UNAVAILABLE", "CueBench cannot safely claim this narration-preview provider call. No provider call was made.", true);
    if (claimed.kind === "conflict") return apiError(409, "TTS_IDEMPOTENCY_CONFLICT", "This narration operation id is already bound to different signed project, beat, revision, or synthesis inputs.");
    if (claimed.kind !== "claimed") {
      if (claimed.kind === "missing") return apiError(503, "TTS_RECEIPT_UNAVAILABLE", "CueBench could not find its narration-preview recovery receipt. No provider call was made.", true);
      return errorForState(claimed.kind);
    }

    const provider = dependencies.tts ?? createNarrationTtsProvider(env);
    try {
      const result = await provider.synthesize(input);
      // Treat an adapter's returned profile as untrusted too. The request is
      // pinned above, but a server-only provider integration must never pass
      // through audio from a different model, voice, format, or retention
      // contract merely because its request happened to be well formed.
      if (
        result.model !== DEFAULT_TTS_MODEL
        || result.voice !== DEFAULT_TTS_VOICE
        || result.responseFormat !== DEFAULT_TTS_RESPONSE_FORMAT
        || result.contentType.trim().toLowerCase() !== "audio/wav"
        || result.store !== null
      ) throw new OpenAIProviderError("CueBench rejected narration audio outside its pinned preview profile.", false, "accepted-unknown");
      // A server validates the exact WAV body before it is sent. The browser
      // independently measures it again before putting a Blob in IndexedDB.
      const durationMs = wavDurationMs(result.bytes);
      if (durationMs === null) throw new OpenAIProviderError("CueBench received an invalid WAV narration preview.", false, "accepted-unknown");
      const completed = await previews.complete({ claims, durationMs, nowMs: currentNow });
      if (completed === null || completed.state !== "completed") {
        // The provider call may have completed while durable settlement was
        // lost, so the preceding write-ahead `calling` receipt remains a
        // conservative no-replay fence.
        return apiError(503, "TTS_PREVIEW_ACCEPTED_UNKNOWN", "CueBench cannot durably prove this narration preview result, so it will not replay a billable call.");
      }
      const audioBody = new Uint8Array(result.bytes.byteLength);
      audioBody.set(result.bytes);
      return new Response(audioBody.buffer, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(result.bytes.byteLength),
          "content-type": "audio/wav",
          "x-content-type-options": "nosniff",
          "x-cuebench-narration-duration-ms": String(durationMs),
          // `/v1/audio/speech` has no supported `store` input. Do not assert
          // a fictitious retention control in a browser-visible contract.
          "x-cuebench-narration-store": "not-applicable",
        },
      });
    } catch (error) {
      const ambiguous = !(error instanceof OpenAIProviderError && error.safeToReplay);
      try {
        if (ambiguous) await previews.markAcceptedUnknown(claims, currentNow);
        else await previews.markRetrySafe(claims, currentNow);
      } catch {
        // The durable `calling` receipt was written before the provider call.
        // If this settlement write is unavailable, fail closed rather than
        // risking an unknown duplicate bill on a later browser retry.
      }
      if (!ambiguous) {
        await ledger.finalizeSpend({
          spendKey: `tts:${claims.operationKey}`,
          actualCents: 0,
          nowMs: currentNow,
          globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
        }).catch(() => undefined);
        return apiError(503, "TTS_PROVIDER_UNAVAILABLE", "CueBench's narration provider rejected this request before accepting it. Retry the same operation.", true);
      }
      return apiError(503, "TTS_PREVIEW_ACCEPTED_UNKNOWN", "CueBench cannot prove whether the narration provider accepted this request, so it will not replay a billable call.");
    }
  });

  return app;
};
