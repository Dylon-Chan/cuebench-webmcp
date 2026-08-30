import { describe, expect, it } from "vitest";
import { createCueBenchWorker, type ProcessingWorkflow } from "./index";
import { InMemoryQuotaLedger } from "./quota-ledger";
import { InMemoryUploadCoordinator, type UploadCoordinatorPort } from "./upload-operations";
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

  public constructor(private readonly beforePart?: (call: number) => Promise<void>, private readonly throwAfterComplete = false, private readonly throwOnDelete = false) {}

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
    if (this.throwAfterComplete) throw new Error("response lost after R2 complete");
  }

  public async abortMultipart(input: { readonly uploadId: string }): Promise<void> {
    this.abortCalls += 1;
    this.uploads.delete(input.uploadId);
  }

  public async head(key: string): Promise<{ readonly exists: boolean }> {
    return { exists: this.completed.has(key) };
  }

  public async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    if (this.throwOnDelete) throw new Error("delete acknowledgement unavailable");
    this.completed.delete(key);
  }
}

class FixtureWorkflow implements ProcessingWorkflow {
  public readonly starts: Array<{ readonly id: string; readonly receipt: string; readonly objectKey: string }> = [];

  public constructor(private readonly throwAfterStart = false, private readonly reportedSpendCents = 0) {}

  public async start(input: { readonly id: string; readonly receipt: string; readonly objectKey: string }): Promise<{ readonly spendCents: number }> {
    this.starts.push(input);
    if (this.throwAfterStart) throw new Error("workflow response lost after create");
    return { spendCents: this.reportedSpendCents };
  }

  public async get(input: { readonly id: string }): Promise<"started" | "missing"> {
    return this.starts.some((start) => start.id === input.id) ? "started" : "missing";
  }
}

class AttachAmbiguousCoordinator extends InMemoryUploadCoordinator {
  private firstAttach = true;

  public override async attachMultipart(input: { readonly uploadId: string; readonly nowMs: number }) {
    if (this.firstAttach) {
      this.firstAttach = false;
      return null;
    }
    return super.attachMultipart(input);
  }
}

/** Simulates R2 completing while the coordinator response is lost. */
class ProbeTransitionAmbiguousCoordinator extends InMemoryUploadCoordinator {
  private firstProbeTransition = true;

  public override async markProbing(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }) {
    if (this.firstProbeTransition) {
      this.firstProbeTransition = false;
      return super.get(input.nowMs);
    }
    return super.markProbing(input);
  }
}

const workerEnv = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-fixture-only-32-byte-minimum",
  SESSION_HMAC_PREVIOUS_KEY_ID: "previous",
  SESSION_HMAC_PREVIOUS_KEY: "previous-key-for-fixture-only-32-byte-minimum",
  QUOTA_SALT: "fixture-ledger-salt-with-32-byte-minimum",
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
  TURNSTILE_SECRET: "fixture-turnstile-secret-with-32-byte-minimum",
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
  readonly workflow?: FixtureWorkflow;
  readonly withoutWorkflow?: boolean;
  readonly coordinator?: UploadCoordinatorPort;
  readonly verifyTurnstile?: (input: { readonly token: string; readonly ip: string; readonly idempotencyKey: string; readonly expectedHostname: string; readonly expectedAction: string }) => Promise<{ readonly success: boolean; readonly hostname?: string; readonly action?: string }>;
} = {}): WorkerFixture => {
  const bucket = options.bucket ?? new FixtureObjectStore();
  const ledger = options.ledger ?? new InMemoryQuotaLedger();
  const workflow = options.workflow ?? new FixtureWorkflow();
  let identifier = 0;
  return {
    app: createCueBenchWorker(workerEnv(options.env), {
      clock: () => options.now ?? 1_700_000_000_000,
      createId: () => `fixture-${++identifier}`,
      verifyTurnstile: options.verifyTurnstile ?? (async () => options.turnstile ?? { success: true, hostname: "cuebench.test", action: "cuebench-upload" }),
      quotaLedger: ledger,
      uploadCoordinator: options.coordinator ?? new InMemoryUploadCoordinator(),
      objectStore: bucket,
      ...(options.probe === undefined ? {} : { mediaProbe: options.probe }),
      ...(options.withoutWorkflow ? {} : { workflow }),
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
  const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: `fixture-valid-${ip}`, idempotencyKey: "session-idempotency" }, { ip }));
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

  it("replays one verified Turnstile challenge to the same anonymous session instead of minting new quota identities", async () => {
    const { app } = makeFixture();
    const request = () => jsonRequest("/api/session", { turnstileToken: "fixture-replay-token", idempotencyKey: "caller-controlled-value" });

    const first = await app.fetch(request());
    const second = await app.fetch(request());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await first.json() as { readonly session: string }).session).toBe((await second.json() as { readonly session: string }).session);
  });

  it("generates the Siteverify idempotency key on the server and never forwards a caller supplied value", async () => {
    const verifierCalls: string[] = [];
    const { app } = makeFixture({
      verifyTurnstile: async (input) => {
        verifierCalls.push(input.idempotencyKey);
        return { success: true, hostname: "cuebench.test", action: "cuebench-upload" };
      },
    });

    const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-siteverify", idempotencyKey: "caller-controlled" }));

    expect(response.status).toBe(201);
    expect(verifierCalls).toEqual(["fixture-2"]);
    expect(verifierCalls[0]).not.toBe("caller-controlled");
  });

  it("enforces a configured global spend breaker at the Worker boundary before it reserves a session or upload", async () => {
    const { app, bucket } = makeFixture({ env: { GLOBAL_SPEND_BREAKER_OPEN: "true" } });
    const response = await app.fetch(jsonRequest("/api/session", { turnstileToken: "fixture-static-breaker" }));

    expect(response.status).toBe(429);
    expect((await response.json() as { readonly error: { readonly code: string; readonly retrySafe: boolean; readonly stateChanged: boolean } }).error).toEqual(expect.objectContaining({ code: "GLOBAL_BREAKER", retrySafe: true, stateChanged: false }));
    expect(bucket.createCalls).toBe(0);
  });

  it("requires disclosure and validates proposed size/duration before it creates an R2 multipart upload", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app);

    expect((await requestUpload(app, session, { disclosureAccepted: false })).status).toBe(428);
    expect((await requestUpload(app, session, { operationId: "too-big", byteLength: 500 * 1024 * 1024 + 1 })).status).toBe(422);
    expect((await requestUpload(app, session, { operationId: "too-long", durationMs: 900_001 })).status).toBe(422);

    expect(bucket.createCalls).toBe(0);
  });

  it("records and compensates the exact multipart id when R2 create succeeds but coordinator attach is ambiguous", async () => {
    const bucket = new FixtureObjectStore();
    const { app } = makeFixture({ bucket, coordinator: new AttachAmbiguousCoordinator() });
    const session = await issueSession(app);

    const response = await requestUpload(app, session);
    const body = await response.json() as { readonly error: { readonly code: string; readonly message: string; readonly stateChanged: boolean } };

    expect(response.status).toBe(503);
    expect(body.error).toEqual(expect.objectContaining({ code: "MULTIPART_CREATE_RECONCILED", stateChanged: true }));
    expect(body.error.message).not.toMatch(/no private object was retained/i);
    expect(bucket.createCalls).toBe(1);
    expect(bucket.abortCalls).toBe(1);
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

  it("keeps quota accounting on the creation network without binding receipt recovery to a later network change", async () => {
    const { app, bucket } = makeFixture();
    const session = await issueSession(app, "203.0.113.10");
    const operation = await requestUpload(app, session, { ip: "203.0.113.10" });
    const { uploadCapability } = await operation.json() as { readonly uploadCapability: string };

    const response = await app.fetch(partRequest(session, uploadCapability, "hello", "203.0.113.11"));

    expect(response.status).toBe(201);
    expect(bucket.partCalls).toBe(1);
  });

  it("rebinding a recovery receipt after a new challenge permits same-browser resume without an IP ownership check", async () => {
    const { app, bucket } = makeFixture();
    const owner = await issueSession(app, "203.0.113.10");
    const operation = await requestUpload(app, owner, { ip: "203.0.113.10" });
    const { operationReceipt } = await operation.json() as { readonly operationReceipt: string };
    const renewed = await issueSession(app, "203.0.113.11");

    const status = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      headers: {
        authorization: `Bearer ${renewed}`,
        "cf-connecting-ip": "203.0.113.11",
        "x-cuebench-operation-receipt": operationReceipt,
      },
    }));
    const resumed = await status.json() as { readonly uploadCapability: string };
    const part = await app.fetch(partRequest(renewed, resumed.uploadCapability, "hello", "203.0.113.11"));

    expect(status.status).toBe(200);
    expect(part.status).toBe(201);
    expect(bucket.partCalls).toBe(1);
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

  it("fails closed before R2 completion when authoritative media inspection is unavailable", async () => {
    const { app, bucket, workflow } = makeFixture();
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const body = await response.json() as { readonly error: { readonly code: string; readonly retrySafe: boolean; readonly nextAction: string } };

    expect(response.status).toBe(503);
    expect(body.error).toEqual(expect.objectContaining({ code: "MEDIA_PROBE_UNAVAILABLE", retrySafe: false, stateChanged: true, nextAction: "start-new-operation" }));
    expect(bucket.abortCalls).toBe(1);
    expect(bucket.deleteCalls).toBe(0);
    expect(bucket.completeCalls).toBe(0);
    expect(bucket.completed.size).toBe(0);
    expect(workflow.starts).toHaveLength(0);
  });

  it("deletes an ambiguously completed private object when the media probe disappears before reconciliation", async () => {
    const bucket = new FixtureObjectStore();
    const ledger = new InMemoryQuotaLedger();
    const coordinator = new ProbeTransitionAmbiguousCoordinator();
    const { app: appWithProbe } = makeFixture({ bucket, ledger, coordinator, probe: probeFor() });
    const session = await issueSession(appWithProbe);
    const operation = await requestUpload(appWithProbe, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await appWithProbe.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const ambiguous = await appWithProbe.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    expect(ambiguous.status).toBe(503);
    expect(bucket.completed.size).toBe(1);

    const { app: appWithoutProbe } = makeFixture({ bucket, ledger, coordinator });
    const recovery = await appWithoutProbe.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(recovery.status).toBe(503);
    expect((await recovery.json() as { readonly error: { readonly code: string } }).error.code).toBe("MEDIA_PROBE_UNAVAILABLE");
    expect(bucket.deleteCalls).toBe(1);
    expect(bucket.completed.size).toBe(0);
  });

  it("returns a truthful retryable processing-unavailable error after authoritative quota is committed but before workflow start", async () => {
    const { app, bucket } = makeFixture({ probe: probeFor(), withoutWorkflow: true });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const body = await response.json() as { readonly error: { readonly code: string; readonly retrySafe: boolean; readonly stateChanged: boolean; readonly nextAction: string } };

    expect(response.status).toBe(503);
    expect(body.error).toEqual(expect.objectContaining({ code: "PROCESSING_UNAVAILABLE", retrySafe: true, stateChanged: true, nextAction: "retry" }));
    expect(bucket.completed.size).toBe(1);
  });

  it("retains a cleanup-pending recovery state when R2 deletion acknowledgement fails", async () => {
    const bucket = new FixtureObjectStore(undefined, false, true);
    const { app } = makeFixture({ bucket, probe: probeFor({ codec: "unsupported" }) });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const body = await response.json() as { readonly error: { readonly code: string; readonly retrySafe: boolean; readonly stateChanged: boolean; readonly nextAction: string } };

    expect(response.status).toBe(409);
    expect(body.error).toEqual(expect.objectContaining({ code: "AUTHORITATIVE_MEDIA_CLEANUP_PENDING", retrySafe: true, stateChanged: true, nextAction: "retry-cleanup" }));
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

  it("reconciles an ambiguous R2 multipart completion by object head without a duplicate complete", async () => {
    const bucket = new FixtureObjectStore(undefined, true);
    const { app, workflow } = makeFixture({ bucket, probe: probeFor() });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(response.status).toBe(202);
    expect(bucket.completeCalls).toBe(1);
    expect(workflow.starts).toHaveLength(1);
  });

  it("reconciles an ambiguous deterministic workflow create through its status port without duplicate start", async () => {
    const workflow = new FixtureWorkflow(true);
    const { app, bucket } = makeFixture({ workflow, probe: probeFor() });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));
    const replay = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(response.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(bucket.completeCalls).toBe(1);
    expect(workflow.starts).toHaveLength(1);
  });

  it("reconciles an ambiguous Cloudflare Workflow create through get(id).status()", async () => {
    const workflowIds: unknown[] = [];
    let statusCalls = 0;
    const binding: NonNullable<WorkerEnv["PROCESSING_WORKFLOW"]> = {
      create: async () => { throw new Error("create response lost"); },
      get: async (id: string) => {
        workflowIds.push(id);
        return {
          status: async () => {
            statusCalls += 1;
            return { status: "running" as const };
          },
        };
      },
    };
    const { app } = makeFixture({ probe: probeFor(), withoutWorkflow: true, env: { PROCESSING_WORKFLOW: binding } });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);

    const response = await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }));

    expect(response.status).toBe(202);
    expect(workflowIds).toEqual([expect.stringMatching(/^cuebench-/)]);
    expect(statusCalls).toBe(1);
  });

  it("records an idempotent provider-spend boundary and opens the dynamic breaker for later reservations", async () => {
    const workflow = new FixtureWorkflow(false, 5);
    const { app } = makeFixture({ workflow, probe: probeFor(), env: { GLOBAL_SPEND_LIMIT_CENTS: "5" } });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    expect((await app.fetch(partRequest(session, uploadCapability))).status).toBe(201);
    expect((await app.fetch(jsonRequest("/api/uploads/operation-fixture/complete", {}, { session, receipt: operationReceipt }))).status).toBe(202);

    const later = await app.fetch(jsonRequest("/api/session", { turnstileToken: "after-dynamic-breaker" }));
    expect(later.status).toBe(429);
  });

  it("atomically claims cancellation before R2 so a racing multipart body cannot revive the operation", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const bucket = new FixtureObjectStore(async () => {
      entered.resolve();
      await release.promise;
    });
    const { app } = makeFixture({ bucket });
    const session = await issueSession(app);
    const operation = await requestUpload(app, session);
    const { uploadCapability, operationReceipt } = await operation.json() as { readonly uploadCapability: string; readonly operationReceipt: string };
    const part = app.fetch(partRequest(session, uploadCapability));
    await entered.promise;

    const cancelled = await app.fetch(new Request("https://cuebench.test/api/uploads/operation-fixture", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${session}`,
        "cf-connecting-ip": "203.0.113.10",
        "x-cuebench-operation-receipt": operationReceipt,
      },
    }));
    release.resolve();

    expect(cancelled.status).toBe(204);
    expect((await part).status).toBe(502);
    expect(bucket.abortCalls).toBe(1);
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
