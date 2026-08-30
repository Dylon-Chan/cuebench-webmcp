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

export interface MediaProbeBinding {
  fetch: (request: Request) => Promise<Response>;
}

/** The Worker-only HMAC material used for capabilities sent to the media Container. */
export interface MediaJobSigningSettings {
  readonly keyRing: HmacKeyRing;
  readonly ttlMs: number;
}

/** Authority the Worker already obtained by verifying the upload receipt. */
export interface MediaProbeRequest {
  readonly operationId: string;
  /** A one-way ledger key, never the browser-selected operation id. */
  readonly operationKey: string;
  readonly objectKey: string;
  /** The receipt remains inside the Worker; its digest is bound into the job. */
  readonly operationReceipt: string;
  readonly receiptExpiresAtMs: number;
  readonly idempotencyKey: string;
}

export const MEDIA_JOB_CONTRACT_VERSION = 1;
const MEDIA_JOB_TYPE = "cuebench-media-job";
const MAX_MEDIA_JOB_LIFETIME_MS = 15 * 60_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEDGER_KEY = /^[a-f0-9]{64}$/;
const RECEIPT = /^[A-Za-z0-9._-]{1,8192}$/;

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

const canonicalPayload = (input: MediaProbeRequest & { readonly issuedAtMs: number; readonly expiresAtMs: number }, keyId: string, receiptSha256: string): string => JSON.stringify({
  contract_version: MEDIA_JOB_CONTRACT_VERSION,
  expires_at_ms: input.expiresAtMs,
  idempotency_key: input.idempotencyKey,
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
  input: MediaProbeRequest & { readonly issuedAtMs: number; readonly expiresAtMs: number; readonly outputPrefix?: string },
  keyRing: HmacKeyRing,
): Promise<string> => {
  const expectedOutputPrefix = `prepared/${input.operationKey}/`;
  if (
    !OPAQUE_ID.test(input.operationId)
    || !LEDGER_KEY.test(input.operationKey)
    || !exactObjectKey(input.objectKey, input.operationKey)
    || !RECEIPT.test(input.operationReceipt)
    || input.idempotencyKey !== `probe:${input.operationKey}`
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
    const job = await signMediaJob({ ...input, issuedAtMs, expiresAtMs }, this.signing.keyRing);
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
