import { Hono } from "hono";
import type { R2Bucket, R2Conditional } from "@cloudflare/workers-types";
import {
  GenerationRunReceiptSchema,
  GenerationRunStatusSchema,
  StagedGenerationResultSchema,
  type GenerationRunStatus,
  type StagedGenerationResult,
} from "@cuebench/contracts";
import { resolveWorkerSettings, type WorkerEnv, type WorkerSettings } from "./env";
import { saltedLedgerKey, type QuotaLedgerPort } from "./quota-ledger";
import {
  SignedTokenError,
  signOpaqueToken,
  verifyAnonymousSession,
  verifyOpaqueToken,
  type SignedTokenFields,
} from "./session";
import { verifyUploadReceipt } from "./uploads";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_RULES_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const clone = <Value>(value: Value): Value => structuredClone(value);
// R2 supports HTTP conditional headers, including If-None-Match: *. The
// package's DOM/Worker header declarations differ, so preserve the runtime
// Headers instance while narrowing it to the binding's conditional union.
const onlyIfAbsent = (): R2Conditional => new Headers({ "if-none-match": "*" }) as unknown as R2Conditional;

export interface GenerationRunReceiptClaims extends SignedTokenFields {
  readonly contractVersion: 1;
  readonly type: "generation-run-receipt";
  readonly runId: string;
  readonly projectId: string;
  readonly targetTrack: "Captions";
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly objectKey: string;
}

export interface GenerationRunRecord {
  readonly version: 1;
  readonly receipt: string;
  readonly claims: GenerationRunReceiptClaims;
  readonly status: GenerationRunStatus;
  readonly cancelled: boolean;
  readonly dispatched: boolean;
  /** Exact browser profile snapshot used by deterministic segmentation. */
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  /** Durable Workflow-only state. Never returned by a route. */
  readonly workflowState?: unknown;
  readonly stagedResult?: StagedGenerationResult;
  readonly updatedAtMs: number;
}

/** Private status/result storage. The record is never exposed by R2 URL. */
export interface GenerationRunRecordStore {
  readonly load: (input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">) => Promise<GenerationRunRecord | null>;
  readonly save: (record: GenerationRunRecord) => Promise<void>;
}

export class InMemoryGenerationRunRecordStore implements GenerationRunRecordStore {
  private readonly records = new Map<string, GenerationRunRecord>();
  private key(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): string {
    return `${input.operationKey}:${input.runId}`;
  }
  public async load(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<GenerationRunRecord | null> {
    const record = this.records.get(this.key(input));
    return record === undefined ? null : clone(record);
  }
  public async save(record: GenerationRunRecord): Promise<void> {
    const key = this.key(record.claims);
    const current = this.records.get(key);
    if (record.cancelled) {
      // Keep any artifacts/state written by a concurrent worker, but make the
      // cancellation terminal. The staged-result route is intentionally an
      // adoption barrier for this state.
      this.records.set(key, clone(current === undefined ? record : {
        ...current,
        cancelled: true,
        status: record.status,
        updatedAtMs: record.updatedAtMs,
      }));
      return;
    }
    // An in-flight worker must never resurrect a cancelled record.
    if (current?.cancelled === true) return;
    this.records.set(key, clone(current === undefined ? record : mergeActiveRecord(current, record)));
  }
}

const recordKey = (input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): string =>
  `prepared/${input.operationKey}/generation-runs/${input.runId}.json`;

const boundedProfileRules = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_PROFILE_RULES_BYTES) return null;
    const cloned: unknown = JSON.parse(serialized);
    return typeof cloned === "object" && cloned !== null && !Array.isArray(cloned)
      ? cloned as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
};

const parseRecord = (value: unknown): GenerationRunRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.version !== 1 || typeof record.receipt !== "string" || typeof record.cancelled !== "boolean" || typeof record.dispatched !== "boolean" || !Number.isSafeInteger(record.updatedAtMs)) return null;
  const claims = record.claims as GenerationRunReceiptClaims | undefined;
  if (claims === undefined || claims.type !== "generation-run-receipt" || !OPAQUE_ID.test(claims.runId) || !OPAQUE_ID.test(claims.projectId) || !SHA256.test(claims.operationKey)) return null;
  const status = GenerationRunStatusSchema.safeParse(record.status);
  if (!status.success || status.data.runId !== claims.runId || status.data.projectId !== claims.projectId) return null;
  const qualityProfileRules = record.qualityProfileRules === undefined ? undefined : boundedProfileRules(record.qualityProfileRules);
  if (qualityProfileRules === null) return null;
  const staged = record.stagedResult === undefined ? undefined : StagedGenerationResultSchema.safeParse(record.stagedResult);
  if (staged !== undefined && !staged.success) return null;
  return {
    version: 1,
    receipt: record.receipt,
    claims,
    status: status.data,
    cancelled: record.cancelled,
    dispatched: record.dispatched,
    ...(qualityProfileRules === undefined ? {} : { qualityProfileRules }),
    ...(record.workflowState === undefined ? {} : { workflowState: record.workflowState }),
    ...(staged === undefined ? {} : { stagedResult: staged.data }),
    updatedAtMs: record.updatedAtMs as number,
  };
};

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
);

const workflowHistory = (value: unknown): readonly unknown[] => {
  const record = objectRecord(value);
  return record !== null && Array.isArray(record.stageHistory) ? record.stageHistory : [];
};

/**
 * Rebase a workflow snapshot over the latest durable state. Route writes know
 * only a dispatch flag, while workflow writes know the expensive artifacts;
 * neither is allowed to erase the other after an R2 CAS retry.
 */
const mergeWorkflowState = (current: unknown, incoming: unknown): unknown => {
  const existing = objectRecord(current);
  const next = objectRecord(incoming);
  if (existing === null) return incoming;
  if (next === null) return current;
  const existingHistory = workflowHistory(existing);
  const nextHistory = workflowHistory(next);
  const merged: Record<string, unknown> = { ...existing, ...next };
  // Each runner transition appends history; retaining the longer history
  // prevents an older retry from moving a stage backwards.
  merged.stageHistory = existingHistory.length > nextHistory.length ? existingHistory : nextHistory;
  for (const artifact of ["preparedManifest", "manifest", "diarization", "wordTimestamps", "aligned", "reconciled", "staged"] as const) {
    if (next[artifact] === undefined && existing[artifact] !== undefined) merged[artifact] = existing[artifact];
  }
  merged.cancelled = existing.cancelled === true || next.cancelled === true;
  return merged;
};

const sameReceiptIdentity = (left: GenerationRunRecord, right: GenerationRunRecord): boolean => (
  left.receipt === right.receipt
  && left.claims.operationKey === right.claims.operationKey
  && left.claims.runId === right.claims.runId
  && left.claims.projectId === right.claims.projectId
);

/** Monotonic merge for non-cancelled writes after a compare-and-swap retry. */
const mergeActiveRecord = (current: GenerationRunRecord, incoming: GenerationRunRecord): GenerationRunRecord => {
  if (!sameReceiptIdentity(current, incoming)) throw new Error("CueBench generation recovery record identity conflict.");
  const currentHistory = workflowHistory(current.workflowState);
  const incomingHistory = workflowHistory(incoming.workflowState);
  const incomingAdvancesWorkflow = incomingHistory.length > currentHistory.length
    || (current.workflowState === undefined && incoming.workflowState !== undefined);
  const workflowState = mergeWorkflowState(current.workflowState, incoming.workflowState);
  return {
    ...current,
    ...incoming,
    status: incomingAdvancesWorkflow ? incoming.status : current.status,
    cancelled: false,
    dispatched: current.dispatched || incoming.dispatched,
    ...(incoming.qualityProfileRules === undefined && current.qualityProfileRules !== undefined
      ? { qualityProfileRules: current.qualityProfileRules }
      : {}),
    ...(workflowState === undefined ? {} : { workflowState }),
    ...(incoming.stagedResult === undefined && current.stagedResult !== undefined
      ? { stagedResult: current.stagedResult }
      : {}),
    updatedAtMs: Math.max(current.updatedAtMs, incoming.updatedAtMs),
  };
};

/** R2 remains private; lifecycle policy already limits the prepared/ prefix to 24 hours. */
export class R2GenerationRunRecordStore implements GenerationRunRecordStore {
  public constructor(private readonly bucket: R2Bucket) {}

  private async current(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<{ readonly record: GenerationRunRecord; readonly etag: string } | null> {
    const object = await this.bucket.get(recordKey(input));
    if (object === null || object.size > MAX_RECORD_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await object.text()) as unknown;
    } catch {
      return null;
    }
    const record = parseRecord(parsed);
    return record !== null && record.claims.operationKey === input.operationKey && record.claims.runId === input.runId
      ? { record, etag: object.etag }
      : null;
  }

  public async load(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<GenerationRunRecord | null> {
    return (await this.current(input))?.record ?? null;
  }

  public async save(record: GenerationRunRecord): Promise<void> {
    const key = recordKey(record.claims);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(record.claims);
      if (current === null) {
        const encoded = JSON.stringify(record);
        if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) throw new Error("CueBench generation recovery record exceeds its private retention bound.");
        const created = await this.bucket.put(key, encoded, {
          onlyIf: onlyIfAbsent(),
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        });
        if (created !== null) return;
        continue;
      }

      // A route cancellation wins over every stale workflow snapshot. When
      // processing the cancellation itself, retain the newest worker state so
      // diagnostics/recovery remain available, but never make it adoptable.
      if (!record.cancelled && current.record.cancelled) return;
      const candidate: GenerationRunRecord = record.cancelled
        ? {
          ...current.record,
          cancelled: true,
          status: record.status,
          updatedAtMs: record.updatedAtMs,
        }
        : mergeActiveRecord(current.record, record);
      const encoded = JSON.stringify(candidate);
      if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) throw new Error("CueBench generation recovery record exceeds its private retention bound.");
      const saved = await this.bucket.put(key, encoded, {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) return;
    }
    const error = new Error("CueBench could not atomically persist its generation recovery record.");
    Object.assign(error, { retryable: true });
    throw error;
  }
}

export interface GenerationWorkflowControl {
  /** The workflow is already created after authoritative upload completion. */
  readonly startCaptionGeneration: (input: { readonly operationKey: string; readonly receipt: string }) => Promise<void>;
  readonly cancelCaptionGeneration: (input: { readonly operationKey: string; readonly receipt: string }) => Promise<void>;
}

export interface GenerationRouteDependencies {
  readonly clock?: () => number;
  readonly quotaLedger?: QuotaLedgerPort;
  readonly runs?: GenerationRunRecordStore;
  readonly workflow?: GenerationWorkflowControl;
}

type Bindings = { readonly Bindings: WorkerEnv };

const apiError = (status: number, code: string, message: string, retrySafe = false): Response => Response.json({
  error: { version: 1, code, message, retrySafe, stateChanged: false, nextAction: retrySafe ? "retry" : "wait-for-status" },
}, { status });

const now = (dependencies: GenerationRouteDependencies): number => dependencies.clock?.() ?? Date.now();
const bearer = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  return value !== null && value.startsWith("Bearer ") && value.slice(7).trim().length > 0 ? value.slice(7).trim() : null;
};
const operationReceipt = (request: Request): string | null => request.headers.get("x-cuebench-operation-receipt")?.trim() || null;
const generationReceipt = (request: Request): string | null => request.headers.get("x-cuebench-generation-receipt")?.trim() || null;
const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";

const bodyRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

interface StartRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
}

const startRequest = (value: unknown): StartRequest | null => {
  const record = bodyRecord(value);
  if (record === null || Object.keys(record).some((key) => !["projectId", "runId", "expectedProjectRevision", "expectedQualityProfileRevision", "mediaSha256", "qualityProfileRules"].includes(key))) return null;
  if (
    !OPAQUE_ID.test(record.projectId as string)
    || !OPAQUE_ID.test(record.runId as string)
    || !Number.isSafeInteger(record.expectedProjectRevision) || (record.expectedProjectRevision as number) <= 0
    || !Number.isSafeInteger(record.expectedQualityProfileRevision) || (record.expectedQualityProfileRevision as number) <= 0
    || typeof record.mediaSha256 !== "string" || !SHA256.test(record.mediaSha256)
  ) return null;
  const qualityProfileRules = record.qualityProfileRules === undefined ? undefined : boundedProfileRules(record.qualityProfileRules);
  if (qualityProfileRules === null) return null;
  return {
    projectId: record.projectId as string,
    runId: record.runId as string,
    expectedProjectRevision: record.expectedProjectRevision as number,
    expectedQualityProfileRevision: record.expectedQualityProfileRevision as number,
    mediaSha256: (record.mediaSha256 as string).toLowerCase(),
    ...(qualityProfileRules === undefined ? {} : { qualityProfileRules }),
  };
};

const statusFor = (claims: GenerationRunReceiptClaims, stage: GenerationRunStatus["stage"]): GenerationRunStatus => ({
  contractVersion: 1,
  runId: claims.runId,
  projectId: claims.projectId,
  targetTrack: "Captions",
  expectedProjectRevision: claims.expectedProjectRevision,
  stage,
} as GenerationRunStatus);

const validClaims = (claims: GenerationRunReceiptClaims): boolean => (
  GenerationRunReceiptSchema.safeParse(claims).success
);

export const issueGenerationRunReceipt = async (input: Omit<GenerationRunReceiptClaims, "type" | "version" | "keyId" | "contractVersion">, settings: Pick<WorkerSettings, "keyRing">): Promise<string> =>
  signOpaqueToken<GenerationRunReceiptClaims>({ contractVersion: 1, type: "generation-run-receipt", ...input }, settings.keyRing);

export const verifyGenerationRunReceipt = async (token: string, settings: Pick<WorkerSettings, "keyRing">, currentNow: number): Promise<GenerationRunReceiptClaims> => {
  const claims = await verifyOpaqueToken<GenerationRunReceiptClaims>(token, settings.keyRing, currentNow, "generation-run-receipt");
  if (!validClaims(claims)) throw new SignedTokenError("malformed", "CueBench received an invalid caption-generation receipt.");
  return claims;
};

const bindingWorkflow = (binding: WorkerEnv["PROCESSING_WORKFLOW"] | undefined): GenerationWorkflowControl | undefined => {
  const get = binding?.get;
  if (get === undefined) return undefined;
  return {
    startCaptionGeneration: async ({ operationKey, receipt }) => {
      const instance = await get(`cuebench-${operationKey}`);
      if (instance.sendEvent === undefined) throw new Error("CueBench Workflow events are unavailable.");
      await instance.sendEvent({ type: "caption-generation-start", payload: { receipt } });
    },
    cancelCaptionGeneration: async ({ operationKey, receipt }) => {
      const instance = await get(`cuebench-${operationKey}`);
      if (instance.sendEvent === undefined) return;
      await instance.sendEvent({ type: "caption-generation-cancel", payload: { receipt } });
    },
  };
};

const globalBreakerOpen = async (settings: WorkerSettings, ledger: QuotaLedgerPort, currentNow: number): Promise<boolean> => (
  settings.globalSpendBreakerOpen || await ledger.isGlobalBreakerOpen({ nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents })
);

/**
 * Registers the generation boundary on the same-origin Worker. It has no
 * media-preparation endpoint: Task 12 preparation is exclusively invoked by
 * the Durable Workflow after this route has persisted the signed receipt.
 */
export const createGenerationRoutes = (env: WorkerEnv, dependencies: GenerationRouteDependencies = {}) => {
  const app = new Hono<Bindings>();

  app.post("/api/generation-runs", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench generation is not configured for this environment.", true);
    }
    const sessionToken = bearer(context.req.raw);
    const uploadToken = operationReceipt(context.req.raw);
    if (sessionToken === null || uploadToken === null) return apiError(401, "SESSION_REQUIRED", "A current anonymous session and private upload receipt are required.");
    let session: Awaited<ReturnType<typeof verifyAnonymousSession>>;
    let upload: Awaited<ReturnType<typeof verifyUploadReceipt>>;
    try {
      session = await verifyAnonymousSession(sessionToken, settings.keyRing, currentNow);
      if (session.purpose === "cleanup") return apiError(403, "SESSION_CLEANUP_ONLY", "This session can only clean up private media.");
      upload = await verifyUploadReceipt(uploadToken, settings, currentNow);
    } catch (error) {
      return error instanceof SignedTokenError && error.code === "expired"
        ? apiError(410, "UPLOAD_EXPIRED", "The private upload receipt expired before caption generation could start.")
        : apiError(401, "SESSION_INVALID", "CueBench could not verify the anonymous session or private upload receipt.");
    }
    const input = startRequest(await context.req.json<unknown>().catch(() => null));
    if (input === null) return apiError(400, "GENERATION_REQUEST_INVALID", "CueBench could not read the expected project, profile, and media revisions.");
    const projectKey = await saltedLedgerKey(settings.quotaSalt, "project", input.projectId);
    if (projectKey !== upload.projectKey) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different CueBench project.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const workflow = dependencies.workflow ?? bindingWorkflow(env.PROCESSING_WORKFLOW);
    const ledger = dependencies.quotaLedger;
    if (runs === undefined || workflow === undefined || ledger === undefined) {
      return apiError(503, "GENERATION_UNAVAILABLE", "CueBench cannot safely start a recoverable caption-generation run right now.", true);
    }
    const existing = await runs.load({ operationKey: upload.operationKey, runId: input.runId });
    if (existing !== null) {
      if (
        existing.claims.projectId !== input.projectId
        || existing.claims.expectedProjectRevision !== input.expectedProjectRevision
        || existing.claims.expectedQualityProfileRevision !== input.expectedQualityProfileRevision
        || existing.claims.mediaSha256 !== input.mediaSha256
        || JSON.stringify(existing.qualityProfileRules ?? {}) !== JSON.stringify(input.qualityProfileRules ?? {})
      ) return apiError(409, "IDEMPOTENCY_CONFLICT", "This generation run id was already used with different project evidence.");
      if (!existing.dispatched) {
        try {
          await workflow.startCaptionGeneration({ operationKey: upload.operationKey, receipt: existing.receipt });
          await runs.save({ ...existing, dispatched: true, updatedAtMs: currentNow });
        } catch {
          return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
        }
      }
      return context.json({ generationRunReceipt: existing.receipt, status: existing.status }, 200);
    }
    try {
      if (await globalBreakerOpen(settings, ledger, currentNow)) return apiError(429, "GLOBAL_BREAKER", "CueBench generation is temporarily unavailable while the public-use spend limit is active.", true);
    } catch {
      return apiError(503, "GLOBAL_BREAKER_UNAVAILABLE", "CueBench cannot safely check its processing spend limit right now.", true);
    }
    const ipKey = await saltedLedgerKey(settings.quotaSalt, "network", clientIp(context.req.raw));
    const accepted = await ledger.reserveGeneration({
      sessionKey: upload.sessionKey,
      ipKey,
      usageKey: `generation:${upload.operationKey}:${input.runId}`,
      nowMs: currentNow,
      quotas: settings.quotas,
    }).catch(() => null);
    if (accepted === null) return apiError(503, "QUOTA_UNAVAILABLE", "CueBench cannot safely reserve anonymous generation quota right now.", true);
    if (!accepted) return apiError(429, "GENERATION_QUOTA", "CueBench's anonymous caption-generation quota has been reached.", true);
    const expiresAtMs = Math.min(upload.expiresAtMs, currentNow + DAY_MS);
    if (expiresAtMs <= currentNow) return apiError(410, "UPLOAD_EXPIRED", "The private upload receipt expired before caption generation could start.");
    const receipt = await issueGenerationRunReceipt({
      runId: input.runId,
      projectId: input.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: input.expectedProjectRevision,
      expectedQualityProfileRevision: input.expectedQualityProfileRevision,
      mediaSha256: input.mediaSha256,
      operationId: upload.operationId,
      operationKey: upload.operationKey,
      objectKey: upload.objectKey,
      issuedAtMs: currentNow,
      expiresAtMs,
    }, settings);
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    // Persist before the workflow event is sent. A lost response can therefore
    // be retried without another provider run or a new opaque receipt.
    const record: GenerationRunRecord = {
      version: 1,
      receipt,
      claims,
      status: statusFor(claims, "Queued"),
      cancelled: false,
      dispatched: false,
      ...(input.qualityProfileRules === undefined ? {} : { qualityProfileRules: input.qualityProfileRules }),
      updatedAtMs: currentNow,
    };
    try {
      await runs.save(record);
      await workflow.startCaptionGeneration({ operationKey: upload.operationKey, receipt });
      await runs.save({ ...record, dispatched: true, updatedAtMs: currentNow });
    } catch {
      return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
    }
    return context.json({ generationRunReceipt: receipt, status: record.status }, 201);
  });

  app.get("/api/generation-runs/:runId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench generation is not configured for this environment.", true); }
    const receipt = generationReceipt(context.req.raw);
    if (receipt === null || context.req.param("runId") === "") return apiError(401, "GENERATION_RECEIPT_REQUIRED", "A signed caption-generation receipt is required.");
    let claims: GenerationRunReceiptClaims;
    try { claims = await verifyGenerationRunReceipt(receipt, settings, currentNow); } catch { return apiError(401, "GENERATION_RECEIPT_INVALID", "CueBench could not verify this caption-generation receipt."); }
    if (claims.runId !== context.req.param("runId")) return apiError(403, "GENERATION_RECEIPT_MISMATCH", "This receipt belongs to a different caption-generation run.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    if (runs === undefined) return apiError(503, "GENERATION_UNAVAILABLE", "CueBench cannot read private generation status right now.", true);
    const record = await runs.load(claims);
    if (record === null || record.receipt !== receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private caption-generation run.");
    return context.json({ status: record.status });
  });

  app.get("/api/generation-runs/:runId/staged-result", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench generation is not configured for this environment.", true); }
    const receipt = generationReceipt(context.req.raw);
    if (receipt === null) return apiError(401, "GENERATION_RECEIPT_REQUIRED", "A signed caption-generation receipt is required.");
    let claims: GenerationRunReceiptClaims;
    try { claims = await verifyGenerationRunReceipt(receipt, settings, currentNow); } catch { return apiError(401, "GENERATION_RECEIPT_INVALID", "CueBench could not verify this caption-generation receipt."); }
    if (claims.runId !== context.req.param("runId")) return apiError(403, "GENERATION_RECEIPT_MISMATCH", "This receipt belongs to a different caption-generation run.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const record = runs === undefined ? null : await runs.load(claims);
    // A cancellation or terminal workflow failure is an adoption barrier even
    // if a stale in-flight writer happened to retain a private staged object.
    // Only the explicitly durable AwaitingAdoption state can cross this route.
    if (record?.cancelled || record?.status.stage !== "AwaitingAdoption" || record.stagedResult === undefined) {
      return apiError(409, "GENERATION_RESULT_PENDING", "CueBench has not completed a staged caption result available for adoption.", true);
    }
    return context.json({ result: record.stagedResult });
  });

  app.delete("/api/generation-runs/:runId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench generation is not configured for this environment.", true); }
    const receipt = generationReceipt(context.req.raw);
    if (receipt === null) return apiError(401, "GENERATION_RECEIPT_REQUIRED", "A signed caption-generation receipt is required.");
    let claims: GenerationRunReceiptClaims;
    try { claims = await verifyGenerationRunReceipt(receipt, settings, currentNow); } catch { return apiError(401, "GENERATION_RECEIPT_INVALID", "CueBench could not verify this caption-generation receipt."); }
    if (claims.runId !== context.req.param("runId")) return apiError(403, "GENERATION_RECEIPT_MISMATCH", "This receipt belongs to a different caption-generation run.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const workflow = dependencies.workflow ?? bindingWorkflow(env.PROCESSING_WORKFLOW);
    const record = runs === undefined ? null : await runs.load(claims);
    if (record === null || runs === undefined) return apiError(404, "NOT_FOUND", "CueBench could not find this private caption-generation run.");
    const cancelled: GenerationRunRecord = { ...record, cancelled: true, status: statusFor(claims, "Cancelled"), updatedAtMs: currentNow };
    await runs.save(cancelled);
    await workflow?.cancelCaptionGeneration({ operationKey: claims.operationKey, receipt }).catch(() => undefined);
    return context.json({ status: cancelled.status });
  });

  return app;
};
