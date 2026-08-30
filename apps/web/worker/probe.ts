import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { HmacKeyRing } from "./session";

/** Authoritative media facts come from the private preparation service, never browser or R2 metadata. */
export interface AuthoritativeMediaFacts {
  readonly container: string;
  readonly mimeType: string;
  readonly codec: string;
  readonly durationMs: number;
  readonly byteLength: number;
  readonly sha256: string;
  /** Optional authoritative provider settlement for a paid media-probe call. */
  readonly providerSpendCents?: number;
}

export interface MediaProbe {
  probe: (input: MediaProbeRequest) => Promise<AuthoritativeMediaFacts>;
}

/**
 * Task 13's server-only contract for prepared media evidence. It intentionally
 * returns just the verified, private manifest reference rather than an inline
 * waveform, audio, or thumbnail collection.
 */
export interface MediaPreparation {
  prepare: (input: MediaPreparationRequest) => Promise<PreparedMediaManifest>;
}

export interface PreparedMediaManifest {
  readonly key: string;
  readonly sha256: string;
}

export interface MediaProbeBinding {
  fetch: (request: Request) => Promise<Response>;
}

/** The Worker-only HMAC material used for capabilities sent to the media Container. */
export interface MediaJobSigningSettings {
  readonly keyRing: HmacKeyRing;
  readonly ttlMs: number;
}

/** Authority the Worker already obtained by verifying the upload receipt. */
export interface MediaJobRequest {
  readonly operationId: string;
  /** A one-way ledger key, never the browser-selected operation id. */
  readonly operationKey: string;
  readonly objectKey: string;
  /** Receipt-bound R2 facts used to scope the private bridge before FFprobe. */
  readonly inputByteLength: number;
  readonly inputContentType: "video/mp4" | "video/webm";
  /** The receipt remains inside the Worker; its digest is bound into the job. */
  readonly operationReceipt: string;
  readonly receiptExpiresAtMs: number;
  readonly idempotencyKey: string;
}

export type MediaProbeRequest = MediaJobRequest;
export type MediaPreparationRequest = MediaJobRequest;

export type MediaJobAction = "probe" | "prepare";

export interface VerifiedMediaJob {
  readonly action: MediaJobAction;
  readonly operationId: string;
  readonly operationKey: string;
  readonly inputKey: string;
  readonly inputByteLength: number;
  readonly inputContentType: "video/mp4" | "video/webm";
  readonly outputPrefix: string;
  readonly receiptSha256: string;
  readonly idempotencyKey: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly keyId: string;
}

export const MEDIA_JOB_CONTRACT_VERSION = 1;
const MEDIA_JOB_TYPE = "cuebench-media-job";
const MAX_MEDIA_JOB_LIFETIME_MS = 15 * 60_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEDGER_KEY = /^[a-f0-9]{64}$/;
const RECEIPT = /^[A-Za-z0-9._-]{1,8192}$/;
const MAX_INPUT_BYTES = 500 * 1024 * 1024;

const encoder = new TextEncoder();

const subtle = (): SubtleCrypto => {
  if (globalThis.crypto?.subtle === undefined) throw new Error("CueBench cannot mint an internal media job.");
  return globalThis.crypto.subtle;
};

const toBase64Url = (value: Uint8Array): string => btoa(String.fromCharCode(...value))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

const hmac = async (value: string, secret: string): Promise<string> => {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await subtle().sign("HMAC", key, encoder.encode(value))));
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await subtle().digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const invalidMediaJob = (): Error => new Error("CueBench cannot mint an internal media job.");

const exactObjectKey = (objectKey: string, operationKey: string): boolean => (
  new RegExp(`^processing/[a-f0-9]{64}/${operationKey}$`).test(objectKey)
);

const canonicalPayload = (input: MediaJobRequest & { readonly action: MediaJobAction; readonly issuedAtMs: number; readonly expiresAtMs: number }, keyId: string, receiptSha256: string): string => JSON.stringify({
  action: input.action,
  contract_version: MEDIA_JOB_CONTRACT_VERSION,
  expires_at_ms: input.expiresAtMs,
  idempotency_key: input.idempotencyKey,
  input_byte_length: input.inputByteLength,
  input_content_type: input.inputContentType,
  input_key: input.objectKey,
  issued_at_ms: input.issuedAtMs,
  key_id: keyId,
  operation_id: input.operationId,
  operation_key: input.operationKey,
  output_prefix: `prepared/${input.operationKey}/`,
  receipt_sha256: receiptSha256,
  type: MEDIA_JOB_TYPE,
});

/**
 * Creates the exact Python-verifiable capability. The output location is
 * deliberately derived from the server-created operation key, never accepted
 * from a caller or the browser.
 */
export const signMediaJob = async (
  input: MediaJobRequest & { readonly action: MediaJobAction; readonly issuedAtMs: number; readonly expiresAtMs: number; readonly outputPrefix?: string },
  keyRing: HmacKeyRing,
): Promise<string> => {
  const expectedOutputPrefix = `prepared/${input.operationKey}/`;
  if (
    (input.action !== "probe" && input.action !== "prepare")
    || !OPAQUE_ID.test(input.operationId)
    || !LEDGER_KEY.test(input.operationKey)
    || !exactObjectKey(input.objectKey, input.operationKey)
    || !Number.isSafeInteger(input.inputByteLength)
    || input.inputByteLength <= 0
    || input.inputByteLength > MAX_INPUT_BYTES
    || (input.inputContentType !== "video/mp4" && input.inputContentType !== "video/webm")
    || !RECEIPT.test(input.operationReceipt)
    || input.idempotencyKey !== `${input.action}:${input.operationKey}`
    || (input.outputPrefix !== undefined && input.outputPrefix !== expectedOutputPrefix)
    || !Number.isSafeInteger(input.issuedAtMs)
    || !Number.isSafeInteger(input.expiresAtMs)
    || input.expiresAtMs <= input.issuedAtMs
    || input.expiresAtMs - input.issuedAtMs > MAX_MEDIA_JOB_LIFETIME_MS
    || !OPAQUE_ID.test(keyRing.current.id)
  ) throw invalidMediaJob();
  const receiptSha256 = await sha256(input.operationReceipt);
  const payload = canonicalPayload(input, keyRing.current.id, receiptSha256);
  const encodedPayload = toBase64Url(encoder.encode(payload));
  return `${encodedPayload}.${await hmac(encodedPayload, keyRing.current.secret)}`;
};

const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidMediaJob();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}${padding}`), (character) => character.charCodeAt(0));
};

const verifiedPayload = (value: unknown): VerifiedMediaJob | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(fields).length !== 14
    || fields.action !== "probe" && fields.action !== "prepare"
    || fields.contract_version !== MEDIA_JOB_CONTRACT_VERSION
    || typeof fields.expires_at_ms !== "number" || !Number.isSafeInteger(fields.expires_at_ms)
    || typeof fields.idempotency_key !== "string"
    || typeof fields.input_byte_length !== "number" || !Number.isSafeInteger(fields.input_byte_length) || fields.input_byte_length <= 0 || fields.input_byte_length > MAX_INPUT_BYTES
    || fields.input_content_type !== "video/mp4" && fields.input_content_type !== "video/webm"
    || typeof fields.input_key !== "string"
    || typeof fields.issued_at_ms !== "number" || !Number.isSafeInteger(fields.issued_at_ms)
    || typeof fields.key_id !== "string" || !OPAQUE_ID.test(fields.key_id)
    || typeof fields.operation_id !== "string" || !OPAQUE_ID.test(fields.operation_id)
    || typeof fields.operation_key !== "string" || !LEDGER_KEY.test(fields.operation_key)
    || typeof fields.output_prefix !== "string"
    || typeof fields.receipt_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.receipt_sha256)
    || fields.type !== MEDIA_JOB_TYPE
  ) return null;
  if (
    !exactObjectKey(fields.input_key, fields.operation_key)
    || fields.output_prefix !== `prepared/${fields.operation_key}/`
    || fields.idempotency_key !== `${fields.action}:${fields.operation_key}`
  ) return null;
  return {
    action: fields.action,
    operationId: fields.operation_id,
    operationKey: fields.operation_key,
    inputKey: fields.input_key,
    inputByteLength: fields.input_byte_length,
    inputContentType: fields.input_content_type,
    outputPrefix: fields.output_prefix,
    receiptSha256: fields.receipt_sha256,
    idempotencyKey: fields.idempotency_key,
    issuedAtMs: fields.issued_at_ms,
    expiresAtMs: fields.expires_at_ms,
    keyId: fields.key_id,
  };
};

/** Verifies the exact canonical capability before the Container bridge touches private storage. */
export const verifyMediaJob = async (
  token: string,
  keyRing: HmacKeyRing,
  nowMs: number,
  expectedAction?: MediaJobAction,
): Promise<VerifiedMediaJob> => {
  if (new TextEncoder().encode(token).byteLength > 8 * 1024) throw invalidMediaJob();
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) throw invalidMediaJob();
  const [encodedPayload, encodedSignature] = parts;
  let parsed: unknown;
  let signature: Uint8Array;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload)));
    signature = fromBase64Url(encodedSignature);
  } catch {
    throw invalidMediaJob();
  }
  const verified = verifiedPayload(parsed);
  if (verified === null || expectedAction !== undefined && verified.action !== expectedAction) throw invalidMediaJob();
  const canonical = canonicalPayload({
    action: verified.action,
    operationId: verified.operationId,
    operationKey: verified.operationKey,
    objectKey: verified.inputKey,
    inputByteLength: verified.inputByteLength,
    inputContentType: verified.inputContentType,
    operationReceipt: "",
    receiptExpiresAtMs: verified.expiresAtMs,
    idempotencyKey: verified.idempotencyKey,
    issuedAtMs: verified.issuedAtMs,
    expiresAtMs: verified.expiresAtMs,
  }, verified.keyId, verified.receiptSha256);
  if (encodedPayload !== toBase64Url(encoder.encode(canonical))) throw invalidMediaJob();
  const key = verified.keyId === keyRing.current.id
    ? keyRing.current
    : verified.keyId === keyRing.previous?.id ? keyRing.previous : undefined;
  if (key === undefined) throw invalidMediaJob();
  const cryptoKey = await subtle().importKey("raw", encoder.encode(key.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await subtle().verify(
    "HMAC",
    cryptoKey,
    signature as unknown as BufferSource,
    encoder.encode(encodedPayload) as unknown as BufferSource,
  )) throw invalidMediaJob();
  if (
    verified.expiresAtMs <= nowMs
    || verified.issuedAtMs > nowMs + 30_000
    || verified.issuedAtMs >= verified.expiresAtMs
    || verified.expiresAtMs - verified.issuedAtMs > MAX_MEDIA_JOB_LIFETIME_MS
  ) throw invalidMediaJob();
  return verified;
};

/** HTTP binding reserved for the media service; missing binding or media HMAC deliberately fails closed. */
export class MediaProbeServiceBinding implements MediaProbe {
  public constructor(
    private readonly binding: MediaProbeBinding,
    private readonly signing: MediaJobSigningSettings,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async probe(input: MediaProbeRequest): Promise<AuthoritativeMediaFacts> {
    const issuedAtMs = this.clock();
    const expiresAtMs = Math.min(issuedAtMs + this.signing.ttlMs, input.receiptExpiresAtMs);
    if (!Number.isSafeInteger(issuedAtMs) || expiresAtMs <= issuedAtMs) throw invalidMediaJob();
    const job = await signMediaJob({ ...input, action: "probe", issuedAtMs, expiresAtMs }, this.signing.keyRing);
    const response = await this.binding.fetch(new Request("https://cuebench-media.internal/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job }),
    }));
    if (!response.ok) throw new Error("CueBench's authoritative media probe is unavailable.");
    const value = await response.json() as unknown;
    if (!isAuthoritativeMediaFacts(value)) throw new Error("CueBench's authoritative media probe returned incomplete facts.");
    return value;
  }
}

const MAX_PREPARED_MANIFEST_ENVELOPE_BYTES = 4 * 1024;

const readBoundedJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("CueBench's prepared media manifest is unavailable.");
  }
  if (response.body === null) throw new Error("CueBench's prepared media manifest is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new Error("CueBench's prepared media manifest is unavailable.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  } catch {
    throw new Error("CueBench's prepared media manifest is unavailable.");
  }
};

const preparedManifest = (value: unknown, operationKey: string): PreparedMediaManifest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Readonly<Record<string, unknown>>;
  if (Object.keys(envelope).length !== 1 || typeof envelope.manifest !== "object" || envelope.manifest === null || Array.isArray(envelope.manifest)) return null;
  const manifest = envelope.manifest as Readonly<Record<string, unknown>>;
  if (Object.keys(manifest).length !== 2 || typeof manifest.key !== "string" || typeof manifest.sha256 !== "string") return null;
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) return null;
  if (manifest.key !== `prepared/${operationKey}/manifests/${manifest.sha256}.json`) return null;
  return { key: manifest.key, sha256: manifest.sha256 };
};

/**
 * Server-side adapter intended for the Task 13 Durable Workflow. It mints a
 * fresh `prepare` capability from a verified receipt and never becomes a
 * browser route or exposes the media HMAC.
 */
export class MediaPreparationServiceBinding implements MediaPreparation {
  public constructor(
    private readonly binding: MediaProbeBinding,
    private readonly signing: MediaJobSigningSettings,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async prepare(input: MediaPreparationRequest): Promise<PreparedMediaManifest> {
    const issuedAtMs = this.clock();
    const expiresAtMs = Math.min(issuedAtMs + this.signing.ttlMs, input.receiptExpiresAtMs);
    if (!Number.isSafeInteger(issuedAtMs) || expiresAtMs <= issuedAtMs) throw invalidMediaJob();
    const job = await signMediaJob({ ...input, action: "prepare", issuedAtMs, expiresAtMs }, this.signing.keyRing);
    const response = await this.binding.fetch(new Request("https://cuebench-media.internal/v1/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job }),
    }));
    if (!response.ok) throw new Error("CueBench's prepared media manifest is unavailable.");
    const result = preparedManifest(await readBoundedJson(response, MAX_PREPARED_MANIFEST_ENVELOPE_BYTES), input.operationKey);
    if (result === null) throw new Error("CueBench's prepared media manifest is unavailable.");
    return result;
  }
}

/**
 * Resolves one Cloudflare Container Durable Object from the Worker-derived
 * operation key. Browser `operation_id` values never select an instance.
 */
export class MediaContainerProbeService implements MediaProbe {
  public constructor(
    private readonly containers: DurableObjectNamespace,
    private readonly signing: MediaJobSigningSettings,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async probe(input: MediaProbeRequest): Promise<AuthoritativeMediaFacts> {
    if (!LEDGER_KEY.test(input.operationKey)) throw invalidMediaJob();
    const container = this.containers.get(this.containers.idFromName(input.operationKey));
    return new MediaProbeServiceBinding({
      fetch: async (request) => container.fetch(
        request as unknown as Parameters<typeof container.fetch>[0],
      ) as unknown as Promise<Response>,
    }, this.signing, this.clock).probe(input);
  }
}

/** Resolves Task 13 preparation onto the same operation-keyed Container DO. */
export class MediaContainerPreparationService implements MediaPreparation {
  public constructor(
    private readonly containers: DurableObjectNamespace,
    private readonly signing: MediaJobSigningSettings,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async prepare(input: MediaPreparationRequest): Promise<PreparedMediaManifest> {
    if (!LEDGER_KEY.test(input.operationKey)) throw invalidMediaJob();
    const container = this.containers.get(this.containers.idFromName(input.operationKey));
    return new MediaPreparationServiceBinding({
      fetch: async (request) => container.fetch(
        request as unknown as Parameters<typeof container.fetch>[0],
      ) as unknown as Promise<Response>,
    }, this.signing, this.clock).prepare(input);
  }
}

export const isAuthoritativeMediaFacts = (value: unknown): value is AuthoritativeMediaFacts => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const facts = value as Readonly<Record<string, unknown>>;
  return typeof facts.container === "string"
    && typeof facts.mimeType === "string"
    && typeof facts.codec === "string"
    && Number.isSafeInteger(facts.durationMs)
    && Number.isSafeInteger(facts.byteLength)
    && typeof facts.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(facts.sha256)
    && (facts.providerSpendCents === undefined || (Number.isSafeInteger(facts.providerSpendCents) && (facts.providerSpendCents as number) >= 0));
};

export const isSupportedAuthoritativeMedia = (facts: AuthoritativeMediaFacts, limits: { readonly maxBytes: number; readonly maxDurationMs: number }): boolean => (
  facts.byteLength > 0
  && facts.byteLength <= limits.maxBytes
  && facts.durationMs > 0
  && facts.durationMs <= limits.maxDurationMs
  && ((facts.container === "webm" && facts.mimeType === "video/webm" && ["vp8", "vp9", "av1"].includes(facts.codec.toLowerCase()))
    || (facts.container === "mp4" && facts.mimeType === "video/mp4" && ["h264", "avc1", "hevc"].includes(facts.codec.toLowerCase())))
);
