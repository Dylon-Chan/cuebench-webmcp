import { Hono } from "hono";
import {
  WorkerConfigurationError,
  resolveWorkerSettings,
  type WorkerEnv,
  type WorkerSettings,
} from "./env";
import {
  DurableObjectQuotaLedger,
  saltedLedgerKey,
  type QuotaLedgerPort,
} from "./quota-ledger";
import {
  SignedTokenError,
  issueAnonymousSession,
  verifyAnonymousSession,
} from "./session";
import {
  R2PrivateObjectStore,
  UploadValidationError,
  isAuthoritativePrivateObject,
  issueUploadCapability,
  issueUploadReceipt,
  privateObjectMetadata,
  readExactUploadBody,
  validateUploadMetadata,
  verifyUploadCapability,
  verifyUploadReceipt,
  type PrivateObjectStore,
  type UploadMediaMetadata,
} from "./uploads";
import { recordTelemetry, type TelemetrySink } from "./telemetry";

export { QuotaLedger } from "./quota-ledger";

export interface TurnstileVerifier {
  verify: (input: { readonly token: string; readonly ip: string }) => Promise<boolean>;
}

export interface ProcessingWorkflow {
  start: (input: { readonly receipt: string; readonly objectKey: string }) => Promise<void>;
}

export interface WorkerDependencies {
  readonly clock?: () => number;
  readonly createId?: () => string;
  readonly verifyTurnstile?: TurnstileVerifier["verify"];
  readonly quotaLedger?: QuotaLedgerPort;
  readonly objectStore?: PrivateObjectStore;
  readonly workflow?: ProcessingWorkflow;
  readonly telemetry?: TelemetrySink;
}

type WorkerBindings = { readonly Bindings: WorkerEnv };

const apiError = (status: number, code: string, message: string): Response => Response.json({
  error: { code, message },
}, { status });

const securityHeaders = (headers: Headers): void => {
  headers.set("content-security-policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
};

const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip")
  ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
  ?? "unknown";

const bearerToken = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
};

const opaqueId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null => typeof value === "object" && value !== null && !Array.isArray(value)
  ? value as Readonly<Record<string, unknown>>
  : null;

const uploadRequest = (value: unknown): {
  readonly projectId: string;
  readonly operationId: string;
  readonly media: UploadMediaMetadata;
  readonly disclosureAccepted: boolean;
} | null => {
  const record = asRecord(value);
  const media = record === null ? null : asRecord(record.media);
  if (
    record === null
    || media === null
    || !opaqueId(record.projectId)
    || !opaqueId(record.operationId)
    || typeof media.byteLength !== "number"
    || typeof media.durationMs !== "number"
    || typeof media.contentType !== "string"
    || typeof record.disclosureAccepted !== "boolean"
  ) return null;
  return {
    projectId: record.projectId,
    operationId: record.operationId,
    media: { byteLength: media.byteLength, durationMs: media.durationMs, contentType: media.contentType },
    disclosureAccepted: record.disclosureAccepted,
  };
};

const turnstileVerifier = (settings: Pick<WorkerSettings, "turnstileSecret" | "turnstileVerifyUrl">): TurnstileVerifier["verify"] => async ({ token, ip }) => {
  const body = new URLSearchParams({ secret: settings.turnstileSecret, response: token, remoteip: ip });
  try {
    const response = await fetch(settings.turnstileVerifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return false;
    const result = await response.json() as { readonly success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
};

const workerWorkflow = (binding: WorkerEnv["PROCESSING_WORKFLOW"] | undefined): ProcessingWorkflow | undefined => {
  if (binding === undefined) return undefined;
  return {
    start: async ({ receipt, objectKey }) => {
      const operationSuffix = objectKey.split("/").at(-1) ?? "operation";
      await binding.create({
        id: `cuebench-${operationSuffix}`,
        params: { receipt, objectKey },
      });
    },
  };
};

const tokenFailure = (error: unknown): Response => {
  if (!(error instanceof SignedTokenError)) return apiError(401, "SESSION_INVALID", "CueBench could not verify this anonymous session.");
  if (error.code === "expired") return apiError(401, "SESSION_EXPIRED", "This anonymous CueBench session has expired. Complete Turnstile again to continue.");
  return apiError(401, "SESSION_INVALID", "CueBench could not verify this anonymous session.");
};

const quotaFailure = (code: string): Response => code === "DUPLICATE_OPERATION"
  ? apiError(409, code, "This anonymous upload operation already exists. Start a new operation instead of creating another private copy.")
  : code === "GLOBAL_BREAKER"
    ? apiError(429, code, "CueBench processing is temporarily unavailable while its public-use spend limit is active.")
    : apiError(429, code, "This anonymous session has reached its processing quota. Try again after the quota window resets.");

const now = (dependency: WorkerDependencies): number => dependency.clock?.() ?? Date.now();
const createId = (dependency: WorkerDependencies): string => dependency.createId?.() ?? globalThis.crypto.randomUUID();

/** Creates the same-origin Hono API. Tests inject fixture-only verification, storage, and workflow adapters. */
export const createCueBenchWorker = (env: WorkerEnv, dependencies: WorkerDependencies = {}) => {
  const app = new Hono<WorkerBindings>();

  app.use("*", async (context, next) => {
    securityHeaders(context.res.headers);
    await next();
    securityHeaders(context.res.headers);
  });

  app.onError(() => apiError(500, "WORKER_UNAVAILABLE", "CueBench could not complete that private processing request. No local project data changed."));

  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.post("/api/session", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch (error) {
      return error instanceof WorkerConfigurationError
        ? apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.")
        : apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.");
    }
    const body = asRecord(await context.req.json<unknown>().catch(() => null));
    const token = body?.turnstileToken;
    if (typeof token !== "string" || token.trim().length === 0) {
      return apiError(400, "TURNSTILE_REQUIRED", "Complete the anti-abuse verification before starting anonymous processing.");
    }
    const ip = clientIp(context.req.raw);
    const accepted = await (dependencies.verifyTurnstile ?? turnstileVerifier(settings))({ token, ip });
    if (!accepted) {
      recordTelemetry(dependencies.telemetry, { stage: "session", status: "rejected", errorCode: "TURNSTILE_REJECTED" });
      return apiError(403, "TURNSTILE_REJECTED", "CueBench could not verify the anti-abuse check. No anonymous session was created.");
    }
    const expiresAtMs = currentNow + settings.sessionTtlMs;
    const session = await issueAnonymousSession({
      sessionId: createId(dependencies),
      issuedAtMs: currentNow,
      expiresAtMs,
      keyRing: settings.keyRing,
    });
    recordTelemetry(dependencies.telemetry, { stage: "session", status: "accepted", latencyMs: 0 });
    return context.json({ session, expiresAtMs }, 201);
  });

  app.post("/api/uploads", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.");
    }
    const token = bearerToken(context.req.raw);
    if (token === null) return apiError(401, "SESSION_REQUIRED", "Start an anonymous CueBench session before requesting a private upload.");
    let session;
    try {
      session = await verifyAnonymousSession(token, settings.keyRing, currentNow);
    } catch (error) {
      return tokenFailure(error);
    }
    const input = uploadRequest(await context.req.json<unknown>().catch(() => null));
    if (input === null) return apiError(400, "UPLOAD_REQUEST_INVALID", "CueBench could not read the requested private upload operation.");
    if (!input.disclosureAccepted) {
      return apiError(428, "DISCLOSURE_REQUIRED", "Accept the temporary cloud-processing disclosure before CueBench uploads a private processing copy.");
    }
    let media: UploadMediaMetadata;
    try {
      media = validateUploadMetadata(input.media, settings);
    } catch (error) {
      const message = error instanceof UploadValidationError ? error.message : "CueBench could not validate the selected video.";
      recordTelemetry(dependencies.telemetry, { stage: "upload", status: "rejected", errorCode: error instanceof UploadValidationError ? error.code : "UPLOAD_METADATA_INVALID" });
      return apiError(422, error instanceof UploadValidationError ? error.code : "UPLOAD_METADATA_INVALID", message);
    }
    const quotaLedger = dependencies.quotaLedger ?? (env.QUOTA_LEDGER === undefined
      ? undefined
      : new DurableObjectQuotaLedger(env.QUOTA_LEDGER as unknown as ConstructorParameters<typeof DurableObjectQuotaLedger>[0]));
    if (quotaLedger === undefined) return apiError(503, "QUOTA_UNAVAILABLE", "CueBench cannot safely enforce anonymous processing limits right now.");
    const ip = clientIp(context.req.raw);
    const [sessionKey, ipKey, operationKey, projectKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", session.sessionId),
      saltedLedgerKey(settings.quotaSalt, "network", ip),
      saltedLedgerKey(settings.quotaSalt, "operation", `${session.sessionId}:${input.operationId}`),
      saltedLedgerKey(settings.quotaSalt, "project", input.projectId),
    ]);
    if (settings.globalSpendBreakerOpen) {
      recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: media.durationMs, byteSize: media.byteLength, status: "rejected", errorCode: "GLOBAL_BREAKER" });
      return quotaFailure("GLOBAL_BREAKER");
    }
    const reservation = await quotaLedger.reserveUpload({
      sessionKey,
      ipKey,
      operationKey,
      mediaMinutes: Math.ceil(media.durationMs / 60_000),
      nowMs: currentNow,
      expiresAtMs: session.expiresAtMs,
      quotas: settings.quotas,
    });
    if (!reservation.accepted) {
      recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: media.durationMs, byteSize: media.byteLength, status: "rejected", errorCode: reservation.code });
      return quotaFailure(reservation.code);
    }
    const uploadCapability = await issueUploadCapability({
      sessionId: session.sessionId,
      sessionKey,
      operationId: input.operationId,
      operationKey,
      projectKey,
      media,
      nowMs: currentNow,
      expiresAtMs: Math.min(session.expiresAtMs, currentNow + settings.uploadCapabilityTtlMs),
      receiptExpiresAtMs: currentNow + settings.recoveryTtlMs,
      settings,
    });
    recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: media.durationMs, byteSize: media.byteLength, status: "accepted" });
    return context.json({ uploadCapability, expiresAtMs: Math.min(session.expiresAtMs, currentNow + settings.uploadCapabilityTtlMs) }, 201);
  });

  app.put("/api/uploads/:operationId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.");
    }
    const operationId = context.req.param("operationId");
    if (!opaqueId(operationId)) return apiError(400, "OPERATION_INVALID", "CueBench could not read this private upload operation.");
    const sessionToken = bearerToken(context.req.raw);
    const capabilityToken = context.req.header("x-cuebench-upload-capability");
    if (sessionToken === null || capabilityToken === undefined) return apiError(401, "UPLOAD_CAPABILITY_REQUIRED", "CueBench needs the anonymous session and private upload capability.");
    let session;
    let capability;
    try {
      [session, capability] = await Promise.all([
        verifyAnonymousSession(sessionToken, settings.keyRing, currentNow),
        verifyUploadCapability(capabilityToken, settings, currentNow),
      ]);
    } catch (error) {
      return tokenFailure(error);
    }
    if (capability.sessionId !== session.sessionId || capability.operationId !== operationId) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload capability belongs to a different anonymous session or operation.");
    }
    const quotaLedger = dependencies.quotaLedger ?? (env.QUOTA_LEDGER === undefined
      ? undefined
      : new DurableObjectQuotaLedger(env.QUOTA_LEDGER as unknown as ConstructorParameters<typeof DurableObjectQuotaLedger>[0]));
    const objectStore = dependencies.objectStore ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2PrivateObjectStore(env.PROCESSING_BUCKET));
    if (quotaLedger === undefined || objectStore === undefined) return apiError(503, "UPLOAD_UNAVAILABLE", "CueBench cannot safely store a private processing copy right now.");
    const state = await quotaLedger.operationState({ sessionKey: capability.sessionKey, operationKey: capability.operationKey, nowMs: currentNow });
    if (state === "cleaned") return apiError(410, "UPLOAD_CLEANED", "This private processing copy was already deleted.");
    if (state === "missing") return apiError(409, "UPLOAD_UNKNOWN", "CueBench could not find this private upload operation. Start again.");
    const receipt = await issueUploadReceipt(capability, settings);
    if (state === "uploaded") return context.json({ receipt }, 200);
    if (state === "uploading") return apiError(409, "UPLOAD_IN_PROGRESS", "CueBench is already writing this private processing copy. Wait for that request instead of creating another copy.");
    const declaredContentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (declaredContentType !== capability.media.contentType) {
      return apiError(422, "CONTENT_TYPE_MISMATCH", "CueBench could not verify the selected video's media type. No processing copy was stored.");
    }
    let body: ArrayBuffer;
    try {
      body = await readExactUploadBody(context.req.raw, capability.media.byteLength, settings.maxUploadBytes);
    } catch (error) {
      const message = error instanceof UploadValidationError ? error.message : "CueBench could not verify the selected media bytes.";
      return apiError(422, error instanceof UploadValidationError ? error.code : "BODY_SIZE", message);
    }
    const claim = await quotaLedger.claimUpload({ sessionKey: capability.sessionKey, operationKey: capability.operationKey, nowMs: currentNow });
    if (claim === "uploaded") return context.json({ receipt }, 200);
    if (claim === "cleaned") return apiError(410, "UPLOAD_CLEANED", "This private processing copy was already deleted.");
    if (claim === "missing") return apiError(409, "UPLOAD_UNKNOWN", "CueBench could not find this private upload operation. Start again.");
    if (claim === "uploading") return apiError(409, "UPLOAD_IN_PROGRESS", "CueBench is already writing this private processing copy. Wait for that request instead of creating another copy.");
    try {
      await objectStore.put(capability.objectKey, body, {
        contentType: capability.media.contentType,
        customMetadata: privateObjectMetadata(capability),
      });
    } catch {
      await quotaLedger.releaseUpload({ sessionKey: capability.sessionKey, operationKey: capability.operationKey, nowMs: currentNow });
      return apiError(502, "UPLOAD_STORAGE_FAILED", "CueBench could not complete the private upload. Retry the same operation while its capability is valid.");
    }
    const marked = await quotaLedger.markUploaded({ sessionKey: capability.sessionKey, operationKey: capability.operationKey, nowMs: currentNow });
    if (!marked) {
      await objectStore.delete(capability.objectKey);
      await quotaLedger.releaseUpload({ sessionKey: capability.sessionKey, operationKey: capability.operationKey, nowMs: currentNow });
      return apiError(409, "UPLOAD_STATE_CHANGED", "CueBench could not safely complete this private upload. No processing copy was retained.");
    }
    recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: capability.media.durationMs, byteSize: capability.media.byteLength, status: "uploaded" });
    return context.json({ receipt }, 201);
  });

  app.post("/api/uploads/:operationId/complete", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.");
    }
    const operationId = context.req.param("operationId");
    const sessionToken = bearerToken(context.req.raw);
    const receipt = context.req.header("x-cuebench-operation-receipt");
    if (!opaqueId(operationId) || sessionToken === null || receipt === undefined) return apiError(401, "UPLOAD_RECEIPT_REQUIRED", "CueBench needs the anonymous session and signed upload receipt.");
    let session;
    let claims;
    try {
      [session, claims] = await Promise.all([
        verifyAnonymousSession(sessionToken, settings.keyRing, currentNow),
        verifyUploadReceipt(receipt, settings, currentNow),
      ]);
    } catch (error) {
      return tokenFailure(error);
    }
    if (claims.sessionId !== session.sessionId || claims.operationId !== operationId) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This signed upload receipt belongs to a different anonymous session or operation.");
    }
    const objectStore = dependencies.objectStore ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2PrivateObjectStore(env.PROCESSING_BUCKET));
    const workflow = dependencies.workflow ?? workerWorkflow(env.PROCESSING_WORKFLOW);
    if (objectStore === undefined || workflow === undefined) return apiError(503, "PROCESSING_UNAVAILABLE", "CueBench cannot start private processing right now.");
    const object = await objectStore.head(claims.objectKey);
    if (!isAuthoritativePrivateObject(object, claims)) {
      recordTelemetry(dependencies.telemetry, { stage: "processing", durationMs: claims.media.durationMs, byteSize: claims.media.byteLength, status: "rejected", errorCode: "AUTHORITATIVE_METADATA_MISMATCH" });
      return apiError(409, "AUTHORITATIVE_METADATA_MISMATCH", "CueBench could not verify the private processing copy before work started. No workflow was started.");
    }
    await workflow.start({ receipt, objectKey: claims.objectKey });
    recordTelemetry(dependencies.telemetry, { stage: "processing", durationMs: claims.media.durationMs, byteSize: claims.media.byteLength, status: "queued" });
    return context.json({ receipt, status: "queued" }, 202);
  });

  app.delete("/api/uploads/:operationId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.");
    }
    const operationId = context.req.param("operationId");
    const sessionToken = bearerToken(context.req.raw);
    const receipt = context.req.header("x-cuebench-operation-receipt");
    if (!opaqueId(operationId) || sessionToken === null || receipt === undefined) return apiError(401, "UPLOAD_RECEIPT_REQUIRED", "CueBench needs the anonymous session and signed upload receipt.");
    let session;
    let claims;
    try {
      [session, claims] = await Promise.all([
        verifyAnonymousSession(sessionToken, settings.keyRing, currentNow),
        verifyUploadReceipt(receipt, settings, currentNow),
      ]);
    } catch (error) {
      return tokenFailure(error);
    }
    if (claims.sessionId !== session.sessionId || claims.operationId !== operationId) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This signed upload receipt belongs to a different anonymous session or operation.");
    }
    const quotaLedger = dependencies.quotaLedger ?? (env.QUOTA_LEDGER === undefined
      ? undefined
      : new DurableObjectQuotaLedger(env.QUOTA_LEDGER as unknown as ConstructorParameters<typeof DurableObjectQuotaLedger>[0]));
    const objectStore = dependencies.objectStore ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2PrivateObjectStore(env.PROCESSING_BUCKET));
    if (quotaLedger === undefined || objectStore === undefined) return apiError(503, "CLEANUP_UNAVAILABLE", "CueBench could not request immediate private-copy cleanup right now.");
    await objectStore.delete(claims.objectKey);
    await quotaLedger.markCleaned({ sessionKey: claims.sessionKey, operationKey: claims.operationKey, nowMs: currentNow });
    recordTelemetry(dependencies.telemetry, { stage: "cleanup", durationMs: claims.media.durationMs, byteSize: claims.media.byteLength, status: "deleted" });
    return new Response(null, { status: 204 });
  });

  app.notFound(async (context) => {
    if (env.ASSETS !== undefined && context.req.method === "GET") return env.ASSETS.fetch(context.req.raw);
    return apiError(404, "NOT_FOUND", "CueBench could not find that route.");
  });

  return app;
};

const worker = {
  fetch: async (request: Request, env: WorkerEnv): Promise<Response> => createCueBenchWorker(env).fetch(request, env),
};

export default worker;
