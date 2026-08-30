import { describe, expect, it } from "vitest";
import { createCueBenchWorker, type ProcessingWorkflow } from "./index";
import { InMemoryQuotaLedger } from "./quota-ledger";
import { InMemoryUploadCoordinator } from "./upload-operations";
import { redactTelemetryEvent } from "./telemetry";
import type { WorkerEnv } from "./env";
import type { MediaProbe } from "./probe";
import type { MultipartPrivateObjectStore } from "./uploads";

class FixtureObjectStore implements MultipartPrivateObjectStore {
  public createCalls = 0;
  public partCalls = 0;
  public completeCalls = 0;
  public abortCalls = 0;
  public deleteCalls = 0;
  public readonly completed = new Map<string, number>();
  private readonly uploads = new Map<string, Map<number, { readonly etag: string; readonly byteLength: number }>>();

  public constructor(private readonly beforePart?: (call: number) => Promise<void>) {}

  public async createMultipart(): Promise<{ readonly uploadId: string }> {
    this.createCalls += 1;
    const uploadId = `upload-${this.createCalls}`;
    this.uploads.set(uploadId, new Map());
    return { uploadId };
  }

  public async uploadPart(input: { readonly uploadId: string; readonly partNumber: number; readonly body: ArrayBuffer }): Promise<{ readonly etag: string }> {
    this.partCalls += 1;
    await this.beforePart?.(this.partCalls);
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) throw new Error("multipart upload missing");
    const etag = `etag-${input.partNumber}-${input.body.byteLength}`;
    upload.set(input.partNumber, { etag, byteLength: input.body.byteLength });
    return { etag };
  }

  public async completeMultipart(input: { readonly key: string; readonly uploadId: string; readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }> }): Promise<void> {
    this.completeCalls += 1;
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) throw new Error("multipart upload missing");
    this.completed.set(input.key, input.parts.reduce((total, part) => total + (upload.get(part.partNumber)?.byteLength ?? 0), 0));
  }

  public async abortMultipart(input: { readonly uploadId: string }): Promise<void> {
    this.abortCalls += 1;
    this.uploads.delete(input.uploadId);
  }

  public async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    this.completed.delete(key);
  }
}

class FixtureWorkflow implements ProcessingWorkflow {
  public readonly starts: Array<{ readonly receipt: string; readonly objectKey: string }> = [];

  public async start(input: { readonly receipt: string; readonly objectKey: string }): Promise<void> {
    this.starts.push(input);
  }
}

const workerEnv = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-fixture-only",
  SESSION_HMAC_PREVIOUS_KEY_ID: "previous",
  SESSION_HMAC_PREVIOUS_KEY: "previous-key-for-fixture-only",
  QUOTA_SALT: "fixture-ledger-salt",
  SESSION_TTL_SECONDS: "3600",
  UPLOAD_CAPABILITY_TTL_SECONDS: "600",
  RECOVERY_TTL_SECONDS: "86400",
  MAX_SESSION_MEDIA_MINUTES: "30",
  MAX_IP_MEDIA_MINUTES: "90",
  MAX_SESSION_GENERATIONS: "6",
  MAX_SESSION_TTS: "50",
  MAX_IP_GENERATIONS: "18",
  MAX_IP_TTS: "150",
  MAX_PENDING_SESSION_BYTES: "10485760",
  MAX_PENDING_IP_BYTES: "20971520",
  MAX_PENDING_SESSION_OPERATIONS: "2",
  MAX_PENDING_IP_OPERATIONS: "8",
  GLOBAL_SPEND_LIMIT_CENTS: "1000",
  GLOBAL_SPEND_BREAKER_OPEN: "false",
  TURNSTILE_SECRET: "fixture-turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAME: "cuebench.test",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
  PROCESSING_BUCKET: undefined as never,
  QUOTA_LEDGER: undefined as never,
  UPLOAD_COORDINATOR: undefined as never,
  ...overrides,
});

const probeFor = (options: Partial<Awaited<ReturnType<MediaProbe["probe"]>>> = {}): MediaProbe => ({
  probe: async () => ({
    container: "webm",
    mimeType: "video/webm",
    codec: "vp9",
    durationMs: 60_000,
    byteLength: 5,
    sha256: "a".repeat(64),
    ...options,
  }),
});

interface WorkerFixture {
  readonly app: ReturnType<typeof createCueBenchWorker>;
  readonly bucket: FixtureObjectStore;
  readonly ledger: InMemoryQuotaLedger;
  readonly workflow: FixtureWorkflow;
}

const makeFixture = (options: {
  readonly now?: number;
  readonly turnstile?: { readonly success: boolean; readonly hostname?: string; readonly action?: string };
  readonly env?: Partial<WorkerEnv>;
  readonly bucket?: FixtureObjectStore;
  readonly ledger?: InMemoryQuotaLedger;
  readonly probe?: MediaProbe | undefined;
} = {}): WorkerFixture => {
  const bucket = options.bucket ?? new FixtureObjectStore();
  const ledger = options.ledger ?? new InMemoryQuotaLedger();
  const workflow = new FixtureWorkflow();
  let identifier = 0;
  return {
    app: createCueBenchWorker(workerEnv(options.env), {
      clock: () => options.now ?? 1_700_000_000_000,
      createId: () => `fixture-${++identifier}`,
      verifyTurnstile: async () => options.turnstile ?? { success: true, hostname: "cuebench.test", action: "cuebench-upload" },
      quotaLedger: ledger,
      uploadCoordinator: new InMemoryUploadCoordinator(),
      objectStore: bucket,
      ...(options.probe === undefined ? {} : { mediaProbe: options.probe }),
      workflow,
    }),
    bucket,
    ledger,
    workflow,
  };
};

const jsonRequest = (path: string, body: unknown, options: { readonly method?: "POST"; readonly session?: string; readonly ip?: string; readonly receipt?: string } = {}): Request => new Request(`https://cuebench.test${path}`, {
  method: options.method ?? "POST",
  headers: {
    "content-type": "application/json",
    "cf-connecting-ip": options.ip ?? "203.0.113.10",
    ...(options.session === undefined ? {} : { authorization: `Bearer ${options.session}` }),
    ...(options.receipt === undefined ? {} : { "x-cuebench-operation-receipt": options.receipt }),
  },
  body: JSON.stringify(body),
});

const issueSession = async (app: ReturnType<typeof createCueBenchWorker>, ip = "203.0.113.10"): Promise<string> => {
  const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-valid", idempotencyKey: "session-idempotency" }, { ip }));
  expect(response.status).toBe(201);
  return (await response.json() as { readonly session: string }).session;
};

const requestUpload = (app: ReturnType<typeof createCueBenchWorker>, session: string, options: {
  readonly operationId?: string;
  readonly byteLength?: number;
  readonly durationMs?: number;
  readonly contentType?: string;
  readonly disclosureAccepted?: boolean;
  readonly ip?: string;
} = {}): Promise<Response> => Promise.resolve(app.fetch(jsonRequest("/api/uploads", {
  projectId: "project-fixture",
  operationId: options.operationId ?? "operation-fixture",
  media: {
    byteLength: options.byteLength ?? 5,
    durationMs: options.durationMs ?? 60_000,
    contentType: options.contentType ?? "video/webm",
  },
  disclosureAccepted: options.disclosureAccepted ?? true,
}, { session, ...(options.ip === undefined ? {} : { ip: options.ip }) })));

const partRequest = (session: string, capability: string, body = "hello", ip = "203.0.113.10"): Request => new Request("https://cuebench.test/api/uploads/operation-fixture/parts/1", {
  method: "PUT",
  headers: {
    authorization: `Bearer ${session}`,
    "cf-connecting-ip": ip,
    "content-type": "video/webm",
    "x-cuebench-upload-capability": capability,
  },
  body,
});

const deferred = <Value>() => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe("CueBench anonymous multipart Worker", () => {
  it("verifies Turnstile success, hostname, action, and a request idempotency key before signing a session", async () => {
    const { app, bucket } = makeFixture({ turnstile: { success: true, hostname: "wrong.test", action: "cuebench-upload" } });

    const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-valid", idempotencyKey: "session-idempotency" }));

    expect(response.status).toBe(403);
    expect(bucket.createCalls).toBe(0);
    expect((await response.json() as { error: { version: number; retrySafe: boolean; nextAction: string } }).error).toMatchObject({ version: 1, retrySafe: false, nextAction: "complete-turnstile" });
  });

  it("requires disclosure and validates proposed size/duration before it creates an R2 multipart upload", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);

    expect((await requestUpload(app, session, { disclosureAccepted: false })).status).toBe(428);
    expect((await requestUpload(app, session, { operationId: "too-big", byteLength: 500 * 1024 * 1024 + 1 })).status).toBe(422);
    expect((await requestUpload(app, session, { operationId: "too-long", durationMs: 900_001 })).status).toBe(422);

    expect(bucket.createCalls).toBe(0);
  });

  it("claims a multipart part before reading it, retries an uploaded part idempotently, and never exposes an object URL", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);
    const created = await requestUpload(app, session);
    const operation = await created.json() as { readonly uploadCapability: string; readonly operationReceipt: string };

    const first = await app.fetch(partRequest(session, operation.uploadCapability));
    const firstBody = await first.json() as { readonly partReceipt: string };
    const repeated = await app.fetch(partRequest(session, operation.uploadCapability));
    const repeatedBody = await repeated.json() as { readonly partReceipt: string };

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(firstBody.partReceipt).toBe(repeatedBody.partReceipt);
    expect(firstBody.partReceipt).not.toContain("https://");
    expect(bucket.partCalls).toBe(1);
  });

  it("rejects a concurrent same-part claim without consuming it or issuing a second R2 part write", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const bucket = new FixtureObjectStore(async (call) => {
      if (call !== 1) return;
      entered.resolve();
      await release.promise;
    });
    const { app } = makeFixture({ bucket });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };

    const first = app.fetch(partRequest(session, uploadCapability));
    await entered.promise;
    const concurrent = await app.fetch(partRequest(session, uploadCapability));

    expect(concurrent.status).toBe(409);
    expect(bucket.partCalls).toBe(1);
    release.resolve();
    expect((await first).status).toBe(201);
  });

  it("enforces signed owner session and creation-network binding for a multipart capability", async () => {
    const { app, bucket } = makeFixture();
    const owner = await issueSession(app, "203.0.113.10");
    const intruder = await issueSession(app, "203.0.113.11");
    const operation = await requestUpload(app, owner);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };

    const response = await app.fetch(partRequest(intruder, uploadCapability, "hello", "203.0.113.11"));

    expect(response.status).toBe(403);
    expect(bucket.partCalls).toBe(0);
  });

  it("does not trust a caller-supplied forwarding header for the IP ownership boundary", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);
    const create = await app.fetch(new Request("https://cuebench.test/api/uploads", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.1",
      },
      body: JSON.stringify({
        projectId: "project-fixture",
        operationId: "forwarded-ip-fixture",
        media: { byteLength: 5, durationMs: 60_000, contentType: "video/webm" },
        disclosureAccepted: true,
      }),
    }));
    const { uploadCapability } = await create.json() as { readonly uploadCapability: string };

    const part = await app.fetch(new Request("https://cuebench.test/api/uploads/forwarded-ip-fixture/parts/1", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
        "x-forwarded-for": "198.51.100.2",
      },
      body: "hello",
    }));

    expect(part.status).toBe(201);
    expect(bucket.partCalls).toBe(1);
  });

  it("fails closed in a recoverable probing state when authoritative media inspection is unavailable", async () => {
    const { app, workflow } = makeFixture();
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const body = await response.json() as { readonly error: { readonly code: string; readonly retrySafe: boolean; readonly nextAction: string } };

    expect(response.status).toBe(503);
    expect(body.error).toEqual(expect.objectContaining({ code: "MEDIA_PROBE_UNAVAILABLE", retrySafe: true, nextAction: "retry-probe" }));
    expect(workflow.starts).toHaveLength(0);
  });

  it("probes, commits actual quota, and starts its deterministic workflow exactly once across completion replays", async () => {
    const { app, bucket, workflow } = makeFixture({ probe: probeFor() });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const first = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const replay = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(bucket.completeCalls).toBe(1);
    expect(workflow.starts).toHaveLength(1);
    expect(workflow.starts[0]?.receipt).toBe(operationReceipt);
  });

  it("rejects unsupported authoritative facts, releases reservation, and deletes the completed private object without starting workflow", async () => {
    const { app, bucket, workflow } = makeFixture({ probe: probeFor({ codec: "unsupported" }) });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(response.status).toBe(422);
    expect(bucket.deleteCalls).toBe(1);
    expect(workflow.starts).toHaveLength(0);
  });

  it("applies browser security headers at the Worker boundary", async () => {
    const { app } = makeFixture();

    const response = await app.fetch(new Request("https://cuebench.test/api/health"));

    expect(response.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
    expect(response.headers.get("content-security-policy")).toContain("frame-src");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("keeps telemetry on its strict allowlist", () => {
    const event = redactTelemetryEvent({
      durationMs: 60_000,
      byteSize: 512,
      stage: "upload",
      usage: { inputTokens: 12, outputTokens: 8, captionText: "Dr. Nguyen" },
      captionText: "do not retain this caption",
      speakerName: "Dr. Nguyen",
      filename: "lesson-with-a-name.webm",
      sourceUrl: "https://private.example/lesson.webm",
      frames: ["frame-bytes"],
    });

    expect(event).toEqual({ durationMs: 60_000, byteSize: 512, stage: "upload", usage: { inputTokens: 12, outputTokens: 8 } });
    expect(JSON.stringify(event)).not.toContain("Nguyen");
    expect(JSON.stringify(event)).not.toContain("lesson-with-a-name");
    expect(JSON.stringify(event)).not.toContain("private.example");
    expect(JSON.stringify(event)).not.toContain("frame-bytes");
  });
});
