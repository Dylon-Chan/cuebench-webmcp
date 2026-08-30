import { describe, expect, it } from "vitest";
import { createCueBenchWorker, type ProcessingWorkflow } from "./index";
import { InMemoryQuotaLedger } from "./quota-ledger";
import { redactTelemetryEvent } from "./telemetry";
import type { PrivateObjectStore, StoredPrivateObject } from "./uploads";
import type { WorkerEnv } from "./env";

const maxBytes = 500 * 1024 * 1024;

class FixtureObjectStore implements PrivateObjectStore {
  public readonly objects = new Map<string, StoredPrivateObject>();
  public putCalls = 0;
  public headCalls = 0;

  public constructor(private readonly beforePut?: (call: number) => Promise<void>) {}

  public async put(key: string, body: ArrayBuffer, options: { readonly contentType: string; readonly customMetadata: Readonly<Record<string, string>> }): Promise<void> {
    this.putCalls += 1;
    await this.beforePut?.(this.putCalls);
    this.objects.set(key, {
      byteLength: body.byteLength,
      contentType: options.contentType,
      customMetadata: options.customMetadata,
    });
  }

  public async head(key: string): Promise<StoredPrivateObject | null> {
    this.headCalls += 1;
    return this.objects.get(key) ?? null;
  }

  public async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  public changeStoredSize(key: string, byteLength: number): void {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error("Fixture object does not exist.");
    this.objects.set(key, { ...object, byteLength });
  }
}

class FixtureWorkflow implements ProcessingWorkflow {
  public readonly starts: Array<{ readonly receipt: string; readonly objectKey: string }> = [];

  public async start(input: { readonly receipt: string; readonly objectKey: string }): Promise<void> {
    this.starts.push(input);
  }
}

interface WorkerFixture {
  readonly app: ReturnType<typeof createCueBenchWorker>;
  readonly bucket: FixtureObjectStore;
  readonly ledger: InMemoryQuotaLedger;
  readonly workflow: FixtureWorkflow;
  readonly env: WorkerEnv;
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
  MAX_IP_MEDIA_MINUTES: "60",
  MAX_SESSION_GENERATIONS: "6",
  MAX_SESSION_TTS: "50",
  GLOBAL_SPEND_LIMIT_CENTS: "1000",
  GLOBAL_SPEND_BREAKER_OPEN: "false",
  TURNSTILE_SECRET: "fixture-turnstile-secret",
  PROCESSING_BUCKET: undefined as never,
  QUOTA_LEDGER: undefined as never,
  ...overrides,
});

const makeFixture = (options: {
  readonly now?: number;
  readonly validTurnstile?: boolean;
  readonly env?: Partial<WorkerEnv>;
  readonly ledger?: InMemoryQuotaLedger;
  readonly bucket?: FixtureObjectStore;
} = {}): WorkerFixture => {
  const bucket = options.bucket ?? new FixtureObjectStore();
  const ledger = options.ledger ?? new InMemoryQuotaLedger();
  const workflow = new FixtureWorkflow();
  const env = workerEnv(options.env);
  let identifier = 0;
  return {
    app: createCueBenchWorker(env, {
      clock: () => options.now ?? 1_700_000_000_000,
      createId: () => `fixture-${++identifier}`,
      verifyTurnstile: async ({ token }) => (options.validTurnstile ?? true) && token === "fixture-valid",
      quotaLedger: ledger,
      objectStore: bucket,
      workflow,
    }),
    bucket,
    ledger,
    workflow,
    env,
  };
};

const jsonRequest = (path: string, body: unknown, options: { readonly session?: string; readonly ip?: string } = {}): Request => new Request(
  `https://cuebench.test${path}`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": options.ip ?? "203.0.113.10",
      ...(options.session === undefined ? {} : { authorization: `Bearer ${options.session}` }),
    },
    body: JSON.stringify(body),
  },
);

const issueSession = async (app: ReturnType<typeof createCueBenchWorker>, ip = "203.0.113.10"): Promise<string> => {
  const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-valid" }, { ip }));
  expect(response.status).toBe(201);
  return (await response.json() as { readonly session: string }).session;
};

const requestUpload = (
  app: ReturnType<typeof createCueBenchWorker>,
  session: string,
  options: {
    readonly operationId?: string;
    readonly projectId?: string;
    readonly byteLength?: number;
    readonly durationMs?: number;
    readonly contentType?: string;
    readonly disclosureAccepted?: boolean;
    readonly ip?: string;
  } = {},
): Promise<Response> => Promise.resolve(app.fetch(jsonRequest("/api/uploads", {
  projectId: options.projectId ?? "project-fixture",
  operationId: options.operationId ?? "operation-fixture",
  media: {
    byteLength: options.byteLength ?? 5,
    durationMs: options.durationMs ?? 60_000,
    contentType: options.contentType ?? "video/webm",
  },
  disclosureAccepted: options.disclosureAccepted ?? true,
}, {
  session,
  ...(options.ip === undefined ? {} : { ip: options.ip }),
})));

const deferred = <Value>() => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("CueBench anonymous upload Worker", () => {
  it("rejects an invalid Turnstile token before it signs a session", async () => {
    const { app, bucket } = makeFixture({ validTurnstile: false });

    const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-valid" }));

    expect(response.status).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects an expired signed session before it allocates an upload operation", async () => {
    const early = makeFixture({ now: 10, env: { SESSION_TTL_SECONDS: "60" } });
    const session = await issueSession(early.app);
    const late = makeFixture({ now: 60_011, env: early.env });

    const response = await requestUpload(late.app, session);

    expect(response.status).toBe(401);
    expect(late.bucket.objects.size).toBe(0);
  });

  it("keeps the previous HMAC key valid during a key rotation", async () => {
    const old = makeFixture({ env: { SESSION_HMAC_CURRENT_KEY_ID: "old", SESSION_HMAC_CURRENT_KEY: "old-hmac-key" } });
    const oldSession = await issueSession(old.app);
    const rotated = makeFixture({
      env: {
        SESSION_HMAC_CURRENT_KEY_ID: "new",
        SESSION_HMAC_CURRENT_KEY: "new-hmac-key",
        SESSION_HMAC_PREVIOUS_KEY_ID: "old",
        SESSION_HMAC_PREVIOUS_KEY: "old-hmac-key",
      },
    });

    const response = await requestUpload(rotated.app, oldSession);

    expect(response.status).toBe(201);
  });

  it("rejects a signed upload capability when another anonymous session presents it", async () => {
    const { app, bucket } = makeFixture();
    const owner = await issueSession(app, "203.0.113.10");
    const intruder = await issueSession(app, "203.0.113.11");
    const operation = await requestUpload(app, owner);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };

    const response = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${intruder}`,
        "cf-connecting-ip": "203.0.113.11",
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
      },
      body: "hello",
    }));

    expect(response.status).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });

  it("treats a duplicate operation id as idempotency-conflicted and creates no object", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);

    expect((await requestUpload(app, session)).status).toBe(201);
    const duplicate = await requestUpload(app, session);

    expect(duplicate.status).toBe(409);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects unsupported size and duration claims before R2 is touched", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);

    expect((await requestUpload(app, session, { byteLength: maxBytes + 1, operationId: "too-large" })).status).toBe(422);
    expect((await requestUpload(app, session, { durationMs: 900_001, operationId: "too-long" })).status).toBe(422);

    expect(bucket.objects.size).toBe(0);
  });

  it("enforces the signed session's media-minute quota before R2 is touched", async () => {
    const { app, bucket } = makeFixture({ env: { MAX_SESSION_MEDIA_MINUTES: "1" } });
    const session = await issueSession(app);

    const response = await requestUpload(app, session, { durationMs: 61_000 });

    expect(response.status).toBe(429);
    expect(bucket.objects.size).toBe(0);
  });

  it("enforces the salted network quota across independent sessions", async () => {
    const { app, bucket } = makeFixture({ env: { MAX_SESSION_MEDIA_MINUTES: "10", MAX_IP_MEDIA_MINUTES: "1" } });
    const firstSession = await issueSession(app);
    const secondSession = await issueSession(app);

    expect((await requestUpload(app, firstSession, { operationId: "first", durationMs: 60_000 })).status).toBe(201);
    const response = await requestUpload(app, secondSession, { operationId: "second", durationMs: 60_000 });

    expect(response.status).toBe(429);
    expect(bucket.objects.size).toBe(0);
  });

  it("fails closed when the global spend breaker is open", async () => {
    const ledger = new InMemoryQuotaLedger({ globalSpendCents: 1_000 });
    const { app, bucket } = makeFixture({ ledger });
    const session = await issueSession(app);

    const response = await requestUpload(app, session);

    expect(response.status).toBe(429);
    expect(bucket.objects.size).toBe(0);
  });

  it("refuses a cloud operation until the disclosure has been explicitly accepted", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);

    const response = await requestUpload(app, session, { disclosureAccepted: false });

    expect(response.status).toBe(428);
    expect(bucket.objects.size).toBe(0);
  });

  it("does not put an object when the direct-upload body fails its authoritative byte check", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };

    const response = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
      },
      body: "too-long",
    }));

    expect(response.status).toBe(422);
    expect(bucket.objects.size).toBe(0);
  });

  it("returns an opaque signed receipt, is PUT-idempotent, and rechecks R2 before starting work", async () => {
    const { app, bucket, workflow } = makeFixture();
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };
    const upload = () => app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
      },
      body: "hello",
    }));

    const first = await upload();
    const firstBody = await first.json() as { readonly receipt: string };
    const repeated = await upload();
    const repeatedBody = await repeated.json() as { readonly receipt: string };

    expect(first.status).toBe(201);
    expect(firstBody.receipt).not.toContain("https://");
    expect(firstBody.receipt).not.toContain("r2");
    expect(repeated.status).toBe(200);
    expect(repeatedBody.receipt).toBe(firstBody.receipt);
    expect(bucket.putCalls).toBe(1);

    const queued = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "application/json",
        "x-cuebench-operation-receipt": firstBody.receipt,
      },
      body: "{}",
    }));

    expect(queued.status).toBe(202);
    expect(bucket.headCalls).toBe(1);
    expect(workflow.starts).toHaveLength(1);
  });

  it("claims an upload operation atomically so a concurrent PUT cannot create a second R2 write", async () => {
    const firstPutEntered = deferred<void>();
    const releaseFirstPut = deferred<void>();
    const bucket = new FixtureObjectStore(async (call) => {
      if (call !== 1) return;
      firstPutEntered.resolve();
      await releaseFirstPut.promise;
    });
    const { app } = makeFixture({ bucket });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };
    const request = (): Request => new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
      },
      body: "hello",
    });

    const first = app.fetch(request());
    await firstPutEntered.promise;
    const concurrent = await app.fetch(request());

    expect(concurrent.status).toBe(409);
    expect(bucket.putCalls).toBe(1);
    releaseFirstPut.resolve();
    expect((await first).status).toBe(201);
  });

  it("does not start a Workflow when authoritative private-object metadata has changed", async () => {
    const { app, bucket, workflow } = makeFixture();
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };
    const uploaded = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "video/webm",
        "x-cuebench-upload-capability": uploadCapability,
      },
      body: "hello",
    }));
    const { receipt } = await uploaded.json() as { readonly receipt: string };
    const objectKey = [...bucket.objects.keys()][0];
    expect(objectKey).toBeDefined();
    bucket.changeStoredSize(objectKey!, 4);

    const response = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "application/json",
        "x-cuebench-operation-receipt": receipt,
      },
      body: "{}",
    }));

    expect(response.status).toBe(409);
    expect(workflow.starts).toHaveLength(0);
  });

  it("applies browser security headers at the Worker boundary", async () => {
    const { app } = makeFixture();

    const response = await app.fetch(new Request("https://cuebench.test/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("keeps operational telemetry on an allowlist even when sensitive fields are supplied", () => {
    const event = redactTelemetryEvent({
      durationMs: 60_000,
      byteSize: 512,
      stage: "upload",
      latencyMs: 42,
      usage: { inputTokens: 12, outputTokens: 8, captionText: "Dr. Nguyen" },
      costCents: 7,
      status: "rejected",
      errorCode: "UPLOAD_SIZE_MISMATCH",
      captionText: "do not retain this caption",
      speakerName: "Dr. Nguyen",
      filename: "lesson-with-a-name.webm",
      sourceUrl: "https://private.example/lesson.webm",
      frames: ["frame-bytes"],
    });

    expect(event).toEqual({
      durationMs: 60_000,
      byteSize: 512,
      stage: "upload",
      latencyMs: 42,
      usage: { inputTokens: 12, outputTokens: 8 },
      costCents: 7,
      status: "rejected",
      errorCode: "UPLOAD_SIZE_MISMATCH",
    });
    expect(JSON.stringify(event)).not.toContain("Nguyen");
    expect(JSON.stringify(event)).not.toContain("lesson-with-a-name");
    expect(JSON.stringify(event)).not.toContain("private.example");
    expect(JSON.stringify(event)).not.toContain("frame-bytes");
  });
});
