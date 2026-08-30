import { describe, expect, it, vi } from "vitest";
import {
  handleMediaStorageBridge,
  MEDIA_CONTAINER_OUTBOUND_POLICY,
  MEDIA_STORAGE_BRIDGE_HOST,
  type MediaBridgeBucket,
} from "./media-bridge";
import {
  isMediaCapabilityAuthorized,
  mediaCapabilityFingerprint,
  mediaContainerRequestDisposition,
  settleMediaContainerResponse,
} from "./media-container";
import { signMediaJob } from "./probe";

const operationKey = "a".repeat(64);
const sessionKey = "b".repeat(64);
const inputKey = `processing/${sessionKey}/${operationKey}`;
const outputPrefix = `prepared/${operationKey}/`;
const keyRing = { current: { id: "media-current", secret: "media-current-container-bridge-secret-123456" } };
const now = 1_700_000_000_000;

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

class FixtureBridgeBucket implements MediaBridgeBucket {
  public readonly objects = new Map<string, StoredObject>();
  public readonly puts: Array<{ readonly key: string; readonly options: Record<string, unknown> }> = [];

  public async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : {
        body: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(value.bytes); controller.close(); } }),
        size: value.bytes.byteLength,
        httpMetadata: { contentType: value.contentType },
        customMetadata: { sha256: value.sha256 },
        httpEtag: '"fixture-etag"',
      };
  }

  public async head(key: string) {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : {
        size: value.bytes.byteLength,
        httpMetadata: { contentType: value.contentType },
        customMetadata: { sha256: value.sha256 },
        httpEtag: '"fixture-etag"',
      };
  }

  public async put(key: string, value: ReadableStream<Uint8Array>, options: Record<string, unknown>) {
    this.puts.push({ key, options });
    if (this.objects.has(key)) return null;
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const metadata = options.customMetadata as { readonly sha256: string };
    const httpMetadata = options.httpMetadata as { readonly contentType: string };
    this.objects.set(key, { bytes, sha256: metadata.sha256, contentType: httpMetadata.contentType });
    return { size: bytes.byteLength, customMetadata: metadata, httpMetadata, httpEtag: '"fixture-etag"' };
  }
}

const sha256 = async (value: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", value as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const job = async (action: "probe" | "prepare") => signMediaJob({
  action,
  operationId: "container_fixture",
  operationKey,
  objectKey: inputKey,
  inputByteLength: 14,
  inputContentType: "video/webm",
  operationReceipt: "container-fixture-receipt",
  receiptExpiresAtMs: now + 60_000,
  idempotencyKey: `${action}:${operationKey}`,
  issuedAtMs: now,
  expiresAtMs: now + 60_000,
}, keyRing);

const bridgeRequest = (method: string, key: string, token: string, body?: BodyInit, headers: HeadersInit = {}): Request => {
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: {
      "x-cuebench-media-job": token,
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(`http://cuebench-r2.internal/${key}`, init);
};

class StreamingBridgeBucket implements MediaBridgeBucket {
  public receivedBytes = 0;
  public largestChunk = 0;
  public putCalls = 0;
  private readonly stored = new Map<string, { readonly size: number; readonly contentType: string; readonly sha256: string }>();

  public async get(): Promise<null> {
    return null;
  }

  public async head(key: string) {
    const value = this.stored.get(key);
    return value === undefined ? null : {
      size: value.size,
      httpMetadata: { contentType: value.contentType },
      customMetadata: { sha256: value.sha256 },
    };
  }

  public async put(key: string, stream: ReadableStream<Uint8Array>, options: Record<string, unknown>) {
    this.putCalls += 1;
    if (this.stored.has(key)) return null;
    const reader = stream.getReader();
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        this.receivedBytes += next.value.byteLength;
        this.largestChunk = Math.max(this.largestChunk, next.value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
    const metadata = options.customMetadata as { readonly sha256: string };
    const httpMetadata = options.httpMetadata as { readonly contentType: string };
    this.stored.set(key, { size, sha256: metadata.sha256, contentType: httpMetadata.contentType });
    return { size, customMetadata: metadata, httpMetadata };
  }
}

describe("operation-keyed media Container bridge", () => {
  it("declares a deny-by-default outbound policy with only the private R2 host", () => {
    expect(MEDIA_CONTAINER_OUTBOUND_POLICY).toEqual({ enableInternet: false, allowedHosts: [MEDIA_STORAGE_BRIDGE_HOST] });
  });

  it("permits only a signed probe read of that job's private processing object", async () => {
    const bucket = new FixtureBridgeBucket();
    const source = new TextEncoder().encode("private source");
    bucket.objects.set(inputKey, { bytes: source, contentType: "video/webm", sha256: await sha256(source) });

    const response = await handleMediaStorageBridge(
      bridgeRequest("GET", inputKey, await job("probe")),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...source]);
    expect(response.headers.get("x-cuebench-sha256")).toBe(await sha256(source));
  });

  it("rejects a processing object whose authoritative R2 type or size differs from the signed job", async () => {
    const bucket = new FixtureBridgeBucket();
    const source = new TextEncoder().encode("private source");
    bucket.objects.set(inputKey, { bytes: source, contentType: "video/mp4", sha256: await sha256(source) });

    const response = await handleMediaStorageBridge(
      bridgeRequest("GET", inputKey, await job("probe")),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );

    expect(response.status).toBe(422);
  });

  it("rejects arbitrary keys and every probe write, even with a valid signed capability", async () => {
    const bucket = new FixtureBridgeBucket();
    const token = await job("probe");
    const body = new TextEncoder().encode("not allowed");

    await expect(handleMediaStorageBridge(
      bridgeRequest("GET", `processing/${sessionKey}/${"c".repeat(64)}`, token),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    )).resolves.toMatchObject({ status: 403 });
    await expect(handleMediaStorageBridge(
      bridgeRequest("PUT", `${outputPrefix}manifests/${"d".repeat(64)}.json`, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-content-sha256": await sha256(body),
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    )).resolves.toMatchObject({ status: 403 });
    expect(bucket.puts).toHaveLength(0);
  });

  it("conditionally publishes only hash-addressed prepare artifacts with matching metadata", async () => {
    const bucket = new FixtureBridgeBucket();
    const token = await job("prepare");
    const body = new TextEncoder().encode('{"manifest":true}');
    const digest = await sha256(body);
    const key = `${outputPrefix}manifests/${digest}.json`;

    const first = await handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );
    const repeat = await handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );

    expect(first.status).toBe(201);
    expect(repeat.status).toBe(200);
    expect(bucket.puts).toHaveLength(2);
    expect(bucket.puts[0]?.options).toMatchObject({
      onlyIf: expect.any(Headers),
      customMetadata: { sha256: digest },
      sha256: digest,
    });
  });

  it("allows a deterministic cache-pointer name while still verifying its body hash", async () => {
    const bucket = new FixtureBridgeBucket();
    const token = await job("prepare");
    const body = new TextEncoder().encode('{"key":"manifest","sha256":"a"}');
    const digest = await sha256(body);
    const cacheIdentity = "e".repeat(64);

    const response = await handleMediaStorageBridge(
      bridgeRequest("PUT", `${outputPrefix}indexes/${cacheIdentity}.json`, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );

    expect(response.status).toBe(201);
    expect(bucket.objects.get(`${outputPrefix}indexes/${cacheIdentity}.json`)?.sha256).toBe(digest);
  });

  it("streams a bounded artifact into R2 without materializing a Worker-sized body", async () => {
    const bucket = new StreamingBridgeBucket();
    const token = await job("prepare");
    const chunkBytes = 1024 * 1024;
    const chunks = 30;
    const expectedLength = chunkBytes * chunks;
    const digest = "f".repeat(64);
    const key = `${outputPrefix}audio/${digest}.wav`;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === chunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });

    const response = await handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "audio/wav",
        "content-length": String(expectedLength),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: bucket, MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret },
      now + 1,
    );

    expect(response.status).toBe(201);
    expect(bucket.putCalls).toBe(1);
    expect(bucket.receivedBytes).toBe(expectedLength);
    expect(bucket.largestChunk).toBe(chunkBytes);
    expect(expectedLength).toBeLessThan(128 * 1024 * 1024);
  });

  it("rejects missing trusted digest and stream length overrun or underrun before publication", async () => {
    const token = await job("prepare");
    const body = new TextEncoder().encode("manifest");
    const digest = await sha256(body);
    const key = `${outputPrefix}manifests/${digest}.json`;
    const env = { MEDIA_JOB_HMAC_CURRENT_KEY_ID: keyRing.current.id, MEDIA_JOB_HMAC_CURRENT_KEY: keyRing.current.secret };

    await expect(handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: new StreamingBridgeBucket(), ...env },
      now + 1,
    )).resolves.toMatchObject({ status: 422 });
    await expect(handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-content-sha256": "not-a-digest",
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: new StreamingBridgeBucket(), ...env },
      now + 1,
    )).resolves.toMatchObject({ status: 422 });
    await expect(handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength - 1),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: new StreamingBridgeBucket(), ...env },
      now + 1,
    )).resolves.toMatchObject({ status: 422 });
    await expect(handleMediaStorageBridge(
      bridgeRequest("PUT", key, token, body, {
        "content-type": "application/json",
        "content-length": String(body.byteLength + 1),
        "x-content-sha256": digest,
        "if-none-match": "*",
      }),
      { PROCESSING_BUCKET: new StreamingBridgeBucket(), ...env },
      now + 1,
    )).resolves.toMatchObject({ status: 422 });
  });

  it("uses a harmless R2 head for bridge readiness and never creates an object", async () => {
    const bucket = new FixtureBridgeBucket();
    const head = vi.spyOn(bucket, "head");
    const response = await handleMediaStorageBridge(
      new Request("http://cuebench-r2.internal/healthz", { method: "HEAD" }),
      { PROCESSING_BUCKET: bucket },
      now + 1,
    );

    expect(response.status).toBe(204);
    expect(head).toHaveBeenCalledWith("__cuebench_health__/readiness");
    expect(bucket.puts).toHaveLength(0);
  });

  it("reports unavailable when the harmless readiness head cannot reach R2", async () => {
    const bucket: MediaBridgeBucket = {
      get: async () => null,
      head: async () => { throw new Error("R2 unavailable"); },
      put: async () => null,
    };
    const response = await handleMediaStorageBridge(
      new Request("http://cuebench-r2.internal/healthz", { method: "HEAD" }),
      { PROCESSING_BUCKET: bucket },
      now + 1,
    );

    expect(response.status).toBe(503);
  });

  it("fences bridge access to the exact active capability, not merely its operation key", async () => {
    const probeToken = await job("probe");
    const prepareToken = await job("prepare");
    const probeFingerprint = await mediaCapabilityFingerprint(probeToken);
    const prepareFingerprint = await mediaCapabilityFingerprint(prepareToken);
    const fence = {
      operationKey,
      inFlight: {
        action: "probe" as const,
        idempotencyKey: `probe:${operationKey}`,
        capabilityFingerprint: probeFingerprint,
        expiresAtMs: now + 60_000,
      },
      results: {},
    };

    expect(isMediaCapabilityAuthorized(fence, {
      action: "probe",
      operationKey,
      idempotencyKey: `probe:${operationKey}`,
      capabilityFingerprint: probeFingerprint,
    }, now + 1)).toBe(true);
    expect(isMediaCapabilityAuthorized(fence, {
      action: "prepare",
      operationKey,
      idempotencyKey: `prepare:${operationKey}`,
      capabilityFingerprint: prepareFingerprint,
    }, now + 1)).toBe(false);
  });

  it("releases transient Container responses for retry while caching deterministic terminal and successful results", async () => {
    const token = await job("prepare");
    const fingerprint = await mediaCapabilityFingerprint(token);
    const capability = {
      action: "prepare" as const,
      operationKey,
      idempotencyKey: `prepare:${operationKey}`,
      capabilityFingerprint: fingerprint,
    };
    const inFlight = {
      operationKey,
      inFlight: { ...capability, expiresAtMs: now + 60_000 },
      results: {},
    };
    const result = (status: number) => ({
      ...capability,
      status,
      contentType: "application/json",
      body: "{}",
      expiresAtMs: now + 60_000,
    });

    expect(mediaContainerRequestDisposition(inFlight, capability, now + 1)).toEqual({ kind: "in-flight" });
    const transient = settleMediaContainerResponse(inFlight, result(503));
    expect(transient.inFlight).toBeUndefined();
    expect(transient.results).toEqual({});
    expect(mediaContainerRequestDisposition(transient, capability, now + 1)).toEqual({ kind: "new" });

    const terminal = settleMediaContainerResponse(inFlight, result(415));
    expect(terminal.inFlight).toBeUndefined();
    expect(mediaContainerRequestDisposition(terminal, capability, now + 1)).toMatchObject({ kind: "cached", result: { status: 415 } });

    const success = settleMediaContainerResponse(inFlight, result(200));
    expect(mediaContainerRequestDisposition(success, capability, now + 1)).toMatchObject({ kind: "cached", result: { status: 200 } });
    for (const status of [408, 409, 425, 429, 500]) {
      expect(settleMediaContainerResponse(inFlight, result(status)).results).toEqual({});
    }
  });
});
