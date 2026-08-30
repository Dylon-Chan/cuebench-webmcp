import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  verifyMediaJob,
  type MediaJobSigningSettings,
  type VerifiedMediaJob,
} from "./probe";

/** The sole virtual hostname available to the uncredentialed media Container. */
export const MEDIA_STORAGE_BRIDGE_HOST = "cuebench-r2.internal";
export const MEDIA_STORAGE_HEALTH_PATH = "/healthz";
export const MEDIA_CONTAINER_OUTBOUND_POLICY = {
  enableInternet: false,
  allowedHosts: [MEDIA_STORAGE_BRIDGE_HOST],
} as const;

export const MAX_MEDIA_JOB_BYTES = 8 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const MAX_WEBP_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export interface MediaBridgeObject {
  readonly body?: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;
  readonly httpEtag?: string;
}

/** The narrow R2 surface made available to the outbound Container bridge. */
export interface MediaBridgeBucket {
  get: (key: string) => Promise<MediaBridgeObject | null>;
  head: (key: string) => Promise<MediaBridgeObject | null>;
  put: (key: string, value: ReadableStream<Uint8Array>, options: Record<string, unknown>) => Promise<MediaBridgeObject | null>;
}

export interface MediaContainerEnv {
  readonly PROCESSING_BUCKET?: MediaBridgeBucket;
  readonly MEDIA_PREPARER?: DurableObjectNamespace;
  readonly MEDIA_JOB_HMAC_CURRENT_KEY_ID?: string;
  readonly MEDIA_JOB_HMAC_CURRENT_KEY?: string;
  readonly MEDIA_JOB_HMAC_PREVIOUS_KEY_ID?: string;
  readonly MEDIA_JOB_HMAC_PREVIOUS_KEY?: string;
}

export const unavailable = (): Response => new Response("CueBench media storage is unavailable.", { status: 503 });
export const forbidden = (): Response => new Response("CueBench rejected this private media storage request.", { status: 403 });
const invalidArtifact = (): Response => new Response("CueBench rejected this prepared media artifact.", { status: 422 });

/** Reads the Worker-only HMAC configuration without ever serializing it to a response. */
export const signingFromEnvironment = (env: MediaContainerEnv): MediaJobSigningSettings | null => {
  const currentId = env.MEDIA_JOB_HMAC_CURRENT_KEY_ID?.trim();
  const currentSecret = env.MEDIA_JOB_HMAC_CURRENT_KEY;
  const previousId = env.MEDIA_JOB_HMAC_PREVIOUS_KEY_ID?.trim();
  const previousSecret = env.MEDIA_JOB_HMAC_PREVIOUS_KEY;
  if (!currentId || !currentSecret || (Boolean(previousId) !== Boolean(previousSecret))) return null;
  if (previousId === currentId) return null;
  return {
    keyRing: {
      current: { id: currentId, secret: currentSecret },
      ...(previousId === undefined || previousSecret === undefined ? {} : { previous: { id: previousId, secret: previousSecret } }),
    },
    ttlMs: 15 * 60_000,
  };
};

const keyFromPath = (url: URL): string | null => {
  if (!url.pathname.startsWith("/") || url.pathname === "/") return null;
  const encodedSegments = url.pathname.slice(1).split("/");
  if (encodedSegments.some((segment) => segment.length === 0 || /%2f|%5c/i.test(segment))) return null;
  try {
    const segments = encodedSegments.map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..")) return null;
    return segments.join("/");
  } catch {
    return null;
  }
};

interface MediaOutputKind {
  readonly contentType: string;
  readonly maximumBytes: number;
  /** Cache pointers have a deterministic identity rather than a body digest. */
  readonly contentAddressed: boolean;
}

const mediaOutputKind = (key: string, job: VerifiedMediaJob): MediaOutputKind | null => {
  const escaped = job.operationKey;
  const matchingHash = "[a-f0-9]{64}";
  if (new RegExp(`^prepared/${escaped}/audio/${matchingHash}\\.wav$`).test(key)) return { contentType: "audio/wav", maximumBytes: MAX_AUDIO_BYTES, contentAddressed: true };
  if (new RegExp(`^prepared/${escaped}/waveforms/${matchingHash}\\.json$`).test(key)) return { contentType: "application/json", maximumBytes: MAX_JSON_BYTES, contentAddressed: true };
  if (new RegExp(`^prepared/${escaped}/thumbnails/${matchingHash}\\.webp$`).test(key)) return { contentType: "image/webp", maximumBytes: MAX_WEBP_BYTES, contentAddressed: true };
  if (new RegExp(`^prepared/${escaped}/manifests/${matchingHash}\\.json$`).test(key)) return { contentType: "application/json", maximumBytes: MAX_JSON_BYTES, contentAddressed: true };
  if (new RegExp(`^prepared/${escaped}/indexes/${matchingHash}\\.json$`).test(key)) return { contentType: "application/json", maximumBytes: MAX_JSON_BYTES, contentAddressed: false };
  return null;
};

/** Reads a stream with an enforced byte ceiling before it can reach R2 or parser code. */
export const readBoundedBody = async (body: ReadableStream<Uint8Array> | null, maximumBytes: number): Promise<Uint8Array | null> => {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const responseHeaders = (object: MediaBridgeObject): Headers => {
  const headers = new Headers();
  headers.set("content-length", String(object.size));
  if (object.httpMetadata?.contentType !== undefined) headers.set("content-type", object.httpMetadata.contentType);
  if (object.customMetadata?.sha256 !== undefined) headers.set("x-cuebench-sha256", object.customMetadata.sha256);
  if (object.httpEtag !== undefined) headers.set("etag", object.httpEtag);
  return headers;
};

const objectMatches = (object: MediaBridgeObject, expectedLength: number, sha256: string, contentType: string): boolean => (
  object.size === expectedLength
  && object.customMetadata?.sha256 === sha256
  && object.httpMetadata?.contentType === contentType
);

class InvalidArtifactStream extends Error {}

/**
 * Pipes a Python-produced artifact straight into R2 while maintaining only a
 * counter. R2 receives the exact body stream and verifies the supplied digest;
 * the Worker never aggregates an artifact in memory.
 */
const boundedArtifactStream = (
  body: ReadableStream<Uint8Array>,
  expectedLength: number,
  maximumBytes: number,
): ReadableStream<Uint8Array> => {
  let received = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > expectedLength || received > maximumBytes) throw new InvalidArtifactStream();
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== expectedLength) throw new InvalidArtifactStream();
    },
  }));
};

/**
 * The only private-storage endpoint reachable from a Container. It accepts no
 * browser-selected key, list, delete, or unscoped credential, and it verifies
 * conditional content-addressed writes after R2 acknowledges them.
 */
export const handleMediaStorageBridge = async (request: Request, env: MediaContainerEnv, nowMs: number = Date.now()): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === MEDIA_STORAGE_HEALTH_PATH) {
    if (request.method !== "HEAD" || env.PROCESSING_BUCKET === undefined) return unavailable();
    try {
      // A null result is healthy: the sentinel is deliberately never created.
      await env.PROCESSING_BUCKET.head("__cuebench_health__/readiness");
      return new Response(null, { status: 204 });
    } catch {
      return unavailable();
    }
  }
  const bucket = env.PROCESSING_BUCKET;
  const signing = signingFromEnvironment(env);
  const token = request.headers.get("x-cuebench-media-job");
  const key = keyFromPath(url);
  if (bucket === undefined || signing === null || token === null || key === null) return forbidden();
  let job: VerifiedMediaJob;
  try {
    job = await verifyMediaJob(token, signing.keyRing, nowMs);
  } catch {
    return forbidden();
  }
  const isInput = key === job.inputKey;
  const output = mediaOutputKind(key, job);
  if (request.method === "GET" || request.method === "HEAD") {
    if (!isInput && (job.action !== "prepare" || output === null)) return forbidden();
    const object = request.method === "GET" ? await bucket.get(key) : await bucket.head(key);
    if (object === null) return new Response("CueBench private media was not found.", { status: 404 });
    if (
      isInput
      && (object.size !== job.inputByteLength || object.httpMetadata?.contentType !== job.inputContentType)
    ) return invalidArtifact();
    if (
      output !== null
      && (
        object.size > output.maximumBytes
        || !HASH.test(object.customMetadata?.sha256 ?? "")
        || (output.contentAddressed && key.split("/").at(-1)?.split(".")[0] !== object.customMetadata?.sha256)
      )
    ) return invalidArtifact();
    return new Response(request.method === "GET" ? object.body ?? null : null, { status: 200, headers: responseHeaders(object) });
  }
  if (request.method !== "PUT" || job.action !== "prepare" || output === null) return forbidden();
  if (request.headers.get("if-none-match") !== "*") return forbidden();
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength === null
    || !/^[0-9]+$/.test(declaredLength)
    || !Number.isSafeInteger(Number(declaredLength))
    || Number(declaredLength) <= 0
    || Number(declaredLength) > output.maximumBytes
  ) return invalidArtifact();
  const expectedLength = Number(declaredLength);
  if (request.headers.get("content-type")?.toLowerCase() !== output.contentType) return invalidArtifact();
  // Only the job-authorized Python Container can provide this artifact digest.
  // R2 receives it as a checksum and the persisted metadata is checked below.
  const expectedSha256 = request.headers.get("x-content-sha256")?.toLowerCase();
  const expectedKeyHash = key.split("/").at(-1)?.split(".")[0];
  if (
    expectedSha256 === undefined
    || !HASH.test(expectedSha256)
    || (output.contentAddressed && expectedKeyHash !== expectedSha256)
  ) return invalidArtifact();
  if (request.body === null) return invalidArtifact();
  const headers = new Headers({ "if-none-match": "*" });
  let stored: MediaBridgeObject | null;
  try {
    stored = await bucket.put(key, boundedArtifactStream(request.body, expectedLength, output.maximumBytes), {
      onlyIf: headers,
      httpMetadata: { contentType: output.contentType },
      customMetadata: { sha256: expectedSha256, cuebench_preparation: "1" },
      sha256: expectedSha256,
    });
  } catch (error) {
    return error instanceof InvalidArtifactStream ? invalidArtifact() : unavailable();
  }
  if (stored === null) {
    try {
      const existing = await bucket.head(key);
      return existing !== null && objectMatches(existing, expectedLength, expectedSha256, output.contentType)
        ? new Response(null, { status: 200, headers: responseHeaders(existing) })
        : new Response("CueBench could not safely publish this media artifact.", { status: 409 });
    } catch {
      return unavailable();
    }
  }
  try {
    const persisted = await bucket.head(key);
    if (persisted === null || !objectMatches(persisted, expectedLength, expectedSha256, output.contentType)) {
      return new Response("CueBench could not verify this media artifact publication.", { status: 503 });
    }
    return new Response(null, { status: 201, headers: responseHeaders(persisted) });
  } catch {
    return unavailable();
  }
};

/** Parses the internal POST envelope without buffering an unbounded request. */
export const readJobEnvelope = async (request: Request): Promise<{ readonly job: string } | null> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_MEDIA_JOB_BYTES)) return null;
  const bytes = await readBoundedBody(request.body, MAX_MEDIA_JOB_BYTES);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record.job === "string" ? { job: record.job } : null;
  } catch {
    return null;
  }
};
