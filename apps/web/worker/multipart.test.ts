import { describe, expect, it } from "vitest";
import { createCueBenchWorker } from "./index";
import { InMemoryQuotaLedger } from "./quota-ledger";
import { InMemoryUploadCoordinator } from "./upload-operations";
import type { MediaProbe } from "./probe";
import { R2PrivateObjectStore, type MultipartPrivateObjectStore } from "./uploads";
import type { WorkerEnv } from "./env";

const partSize = 8 * 1024 * 1024;

class MultipartFixtureStore implements MultipartPrivateObjectStore {
  public createCalls = 0;
  public partCalls = 0;
  public readonly largestPartSizes: number[] = [];
  public readonly completed = new Map<string, { readonly size: number }>();
  private readonly uploads = new Map<string, Map<number, { readonly etag: string; readonly size: number }>>();

  public async createMultipart(): Promise<{ readonly uploadId: string }> {
    this.createCalls += 1;
    const uploadId = `upload-${this.createCalls}`;
    this.uploads.set(uploadId, new Map());
    return { uploadId };
  }

  public async uploadPart(input: { readonly uploadId: string; readonly partNumber: number; readonly body: ArrayBuffer }): Promise<{ readonly etag: string }> {
    this.partCalls += 1;
    this.largestPartSizes.push(input.body.byteLength);
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) throw new Error("missing multipart upload");
    const etag = `part-${input.partNumber}-${input.body.byteLength}`;
    upload.set(input.partNumber, { etag, size: input.body.byteLength });
    return { etag };
  }

  public async completeMultipart(input: { readonly key: string; readonly uploadId: string; readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }> }): Promise<void> {
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) throw new Error("missing multipart upload");
    const size = input.parts.reduce((total, part) => total + (upload.get(part.partNumber)?.size ?? 0), 0);
    this.completed.set(input.key, { size });
  }

  public async abortMultipart(input: { readonly uploadId: string }): Promise<void> {
    this.uploads.delete(input.uploadId);
  }

  public async head(key: string): Promise<{ readonly exists: boolean }> {
    return { exists: this.completed.has(key) };
  }

  public async delete(key: string): Promise<void> {
    this.completed.delete(key);
  }
}

const env = (): WorkerEnv => ({
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-fixture-only-32-byte-minimum",
  QUOTA_SALT: "fixture-ledger-salt-with-32-byte-minimum",
  SESSION_TTL_SECONDS: "3600",
  UPLOAD_CAPABILITY_TTL_SECONDS: "600",
  RECOVERY_TTL_SECONDS: "86400",
  MAX_SESSION_MEDIA_MINUTES: "30",
  MAX_IP_MEDIA_MINUTES: "90",
  MAX_SESSION_GENERATIONS: "6",
  MAX_SESSION_TTS: "50",
  GLOBAL_SPEND_LIMIT_CENTS: "1000",
  GLOBAL_SPEND_BREAKER_OPEN: "false",
  TURNSTILE_SECRET: "fixture-turnstile-secret-with-32-byte-minimum",
  TURNSTILE_EXPECTED_HOSTNAME: "cuebench.test",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
  PROCESSING_BUCKET: undefined as never,
  QUOTA_LEDGER: undefined as never,
  UPLOAD_COORDINATOR: undefined as never,
});

const probe: MediaProbe = {
  probe: async () => ({
    container: "webm",
    mimeType: "video/webm",
    codec: "vp9",
    durationMs: 60_000,
    byteLength: partSize + 1,
    sha256: "a".repeat(64),
  }),
};

const json = (path: string, body: unknown, session?: string): Request => new Request(`https://cuebench.test${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.10",
    ...(session === undefined ? {} : { authorization: `Bearer ${session}` }),
  },
  body: JSON.stringify(body),
});

const uploadRequest = (session: string): Request => json("/api/uploads", {
  projectId: "project-fixture",
  operationId: "operation-fixture",
  media: { byteLength: partSize + 1, durationMs: 60_000, contentType: "video/webm" },
  disclosureAccepted: true,
}, session);

describe("resumable multipart upload boundary", () => {
  it("returns immutable resumable operation state on an ambiguous duplicate POST without a second multipart upload", async () => {
    const bucket = new MultipartFixtureStore();
    const app = createCueBenchWorker(env(), {
      clock: () => 1_700_000_000_000,
      createId: () => "fixture-id",
      verifyTurnstile: async () => ({ success: true, hostname: "cuebench.test", action: "cuebench-upload" }),
      quotaLedger: new InMemoryQuotaLedger(),
      uploadCoordinator: new InMemoryUploadCoordinator(),
      objectStore: bucket,
      mediaProbe: probe,
    });
    const sessionResponse = await app.fetch(json("/api/session", { turnstileToken: "fixture-token", idempotencyKey: "session-idempotency" }));
    const { session } = await sessionResponse.json() as { readonly session: string };

    const first = await app.fetch(uploadRequest(session));
    const duplicate = await app.fetch(uploadRequest(session));
    const firstBody = await first.json() as { readonly operationReceipt: string; readonly uploadCapability: string; readonly partSize: number; readonly partCount: number };
    const duplicateBody = await duplicate.json() as { readonly operationReceipt: string; readonly uploadCapability: string; readonly partSize: number; readonly partCount: number };

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(firstBody.operationReceipt).toBe(duplicateBody.operationReceipt);
    expect(firstBody.partSize).toBe(partSize);
    expect(firstBody.partCount).toBe(2);
    expect(duplicateBody.uploadCapability).toBeTruthy();
    expect(bucket.createCalls).toBe(1);
  });

  it("treats only typed terminal R2 multipart codes as idempotent abort acknowledgement", async () => {
    const store = new R2PrivateObjectStore({
      resumeMultipartUpload: () => ({
        abort: async () => { throw { code: "NoSuchUpload" }; },
      }),
    } as never);

    await expect(store.abortMultipart({ key: "processing/opaque", uploadId: "opaque-upload" })).resolves.toBe("already-absent");
    const completed = new R2PrivateObjectStore({
      resumeMultipartUpload: () => ({
        abort: async () => { throw { code: "AlreadyCompleted" }; },
      }),
    } as never);
    await expect(completed.abortMultipart({ key: "processing/opaque", uploadId: "opaque-upload" })).resolves.toBe("already-completed");
    const unknown = new R2PrivateObjectStore({
      resumeMultipartUpload: () => ({
        abort: async () => { throw new Error("NoSuchUpload in text must not be trusted"); },
      }),
    } as never);
    await expect(unknown.abortMultipart({ key: "processing/opaque", uploadId: "opaque-upload" })).rejects.toThrow(/NoSuchUpload/);
  });
});
