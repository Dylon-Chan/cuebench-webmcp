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
  type QuotaRejectionCode,
} from "./quota-ledger";
import {
  SignedTokenError,
  issueAnonymousSession,
  verifyAnonymousSession,
  type AnonymousSessionClaims,
} from "./session";
import {
  R2PrivateObjectStore,
  UploadValidationError,
  issueUploadCapability,
  issueUploadPartReceipt,
  issueUploadReceipt,
  type MultipartAbortOutcome,
  normaliseContentType,
  readExactUploadPart,
  validateUploadMetadata,
  verifyUploadCapability,
  verifyUploadReceipt,
  type MultipartPrivateObjectStore,
  type UploadOperationAuthorization,
  type UploadCapabilityClaims,
  type UploadMediaMetadata,
  type UploadReceiptClaims,
} from "./uploads";
import {
  DurableObjectUploadCoordinator,
  type CleanupTarget,
  type UploadCoordinatorPort,
  type UploadOperationRecord,
  type UploadOperationState,
} from "./upload-operations";
import {
  MediaContainerProbeService,
  MediaProbeRejected,
  isSupportedAuthoritativeMedia,
  type MediaProbe,
} from "./probe";
import { fixtureMediaPreparationEnabled } from "./media-preparation-fixture";
import { recordTelemetry, type TelemetrySink } from "./telemetry";
import {
  createGenerationRoutes,
  type GenerationRunRecordStore,
  type GenerationWorkflowControl,
} from "./generation-routes";
import {
  createAudioDescriptionGenerationRoutes,
  type AudioDescriptionGenerationRunRecordStore,
  type AudioDescriptionGenerationWorkflowControl,
} from "./ad-generation-routes";
import {
  createNarrationPreviewRoutes,
  type NarrationPreviewRecordStore,
} from "./narration-preview-routes";
import type { NarrationTtsProvider } from "./openai/tts";

export { QuotaLedger } from "./quota-ledger";
export { UploadCoordinator } from "./upload-operations";
export { MediaPreparationContainer } from "./media-container";
export { CaptionGenerationWorkflow } from "./workflows/generation";
export { AudioDescriptionGenerationWorkflow } from "./workflows/audio-description-generation";
export {
  MediaContainerPreparationService,
  type MediaPreparation,
  type MediaPreparationRequest,
  type PreparedMediaManifest,
} from "./probe";
// Required by @cloudflare/containers for `outboundByHost` interception. The
// browser API never routes to this WorkerEntrypoint.
export { ContainerProxy } from "@cloudflare/containers";

export interface TurnstileVerification {
  readonly success: boolean;
  readonly hostname?: string;
  readonly action?: string;
}

export interface TurnstileVerifier {
  verify: (input: {
    readonly token: string;
    readonly ip: string;
    readonly idempotencyKey: string;
    readonly expectedHostname: string;
    readonly expectedAction: string;
  }) => Promise<TurnstileVerification>;
}

export interface ProcessingWorkflow {
  /** Provider adapters return the actual billable amount when it is known. */
  start: (input: { readonly id: string; readonly receipt: string; readonly objectKey: string }) => Promise<{ readonly spendCents?: number } | void>;
  /** A deterministic provider id lets ambiguous create be reconciled without a duplicate start. */
  get?: (input: { readonly id: string }) => Promise<"started" | "missing" | "unknown">;
}

export interface WorkerDependencies {
  readonly clock?: () => number;
  readonly createId?: () => string;
  readonly verifyTurnstile?: TurnstileVerifier["verify"];
  readonly quotaLedger?: QuotaLedgerPort;
  /** Fixture-only single-operation coordinator. Production selects one DO per salted operation key. */
  readonly uploadCoordinator?: UploadCoordinatorPort;
  readonly objectStore?: MultipartPrivateObjectStore;
  readonly mediaProbe?: MediaProbe;
  readonly workflow?: ProcessingWorkflow;
  /** Task 13 seams remain private Worker-only ports, never browser bindings. */
  readonly generationRuns?: GenerationRunRecordStore;
  readonly generationWorkflow?: GenerationWorkflowControl;
  /** Isolated AD recovery records share only the target-discriminated project lease. */
  readonly audioDescriptionRuns?: AudioDescriptionGenerationRunRecordStore;
  readonly audioDescriptionWorkflow?: AudioDescriptionGenerationWorkflowControl;
  /** Task 14 receipt/TTS seams remain Worker-only; preview audio stays browser-local. */
  readonly narrationPreviews?: NarrationPreviewRecordStore;
  readonly narrationTts?: NarrationTtsProvider;
  readonly telemetry?: TelemetrySink;
}

type WorkerBindings = { readonly Bindings: WorkerEnv };
type NextAction = "retry" | "resume-upload" | "retry-probe" | "retry-completion" | "retry-cleanup" | "start-new-operation" | "wait-for-status" | "complete-turnstile" | "refresh-browser";

interface StructuredErrorOptions {
  readonly retrySafe?: boolean;
  readonly stateChanged?: boolean;
  readonly nextAction?: NextAction;
}

const apiError = (status: number, code: string, message: string, options: StructuredErrorOptions = {}): Response => Response.json({
  error: {
    version: 1,
    code,
    message,
    retrySafe: options.retrySafe ?? false,
    stateChanged: options.stateChanged ?? false,
    nextAction: options.nextAction ?? "start-new-operation",
  },
}, { status });

const securityHeaders = (headers: Headers): void => {
  headers.set("content-security-policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
};

// Cloudflare injects CF-Connecting-IP at the edge. A caller-controlled forwarding
// header must never choose the identity used for quota or upload ownership.
const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";

const bearerToken = (request: Request): string | null => {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length === 0 ? null : token;
};

const opaqueId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const projectOwnerCapability = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null => typeof value === "object" && value !== null && !Array.isArray(value)
  ? value as Readonly<Record<string, unknown>>
  : null;

const uploadRequest = (value: unknown): {
  readonly projectId: string;
  readonly operationId: string;
  readonly projectOwnerCapability: string;
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
    || !projectOwnerCapability(record.projectOwnerCapability)
    || typeof media.byteLength !== "number"
    || typeof media.durationMs !== "number"
    || typeof media.contentType !== "string"
    || typeof record.disclosureAccepted !== "boolean"
  ) return null;
  return {
    projectId: record.projectId,
    operationId: record.operationId,
    projectOwnerCapability: record.projectOwnerCapability.toLowerCase(),
    media: { byteLength: media.byteLength, durationMs: media.durationMs, contentType: media.contentType },
    disclosureAccepted: record.disclosureAccepted,
  };
};

const MAX_SESSION_REQUEST_BYTES = 4 * 1024;
const MAX_TURNSTILE_TOKEN_BYTES = 2_048;
const MAX_SESSION_IDEMPOTENCY_BYTES = 128;

const sessionRequest = (value: unknown): { readonly token: string; readonly purpose: "upload" | "cleanup" } | null => {
  const record = asRecord(value);
  if (record === null || typeof record.turnstileToken !== "string") return null;
  const allowed = new Set(["turnstileToken", "idempotencyKey", "purpose"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const token = record.turnstileToken.trim();
  if (token.length === 0 || new TextEncoder().encode(token).byteLength > MAX_TURNSTILE_TOKEN_BYTES) return null;
  if (record.idempotencyKey !== undefined && (typeof record.idempotencyKey !== "string" || new TextEncoder().encode(record.idempotencyKey).byteLength > MAX_SESSION_IDEMPOTENCY_BYTES)) return null;
  const purpose = record.purpose === undefined ? "upload" : record.purpose;
  return purpose === "upload" || purpose === "cleanup" ? { token, purpose } : null;
};

/** Reads an intentionally tiny session envelope without allowing JSON parsing to materialize an arbitrary body. */
const readBoundedSessionJson = async (request: Request): Promise<unknown | null> => {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_SESSION_REQUEST_BYTES) return null;
  }
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SESSION_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
};

const partNumber = (value: string): number | null => /^[1-9][0-9]{0,5}$/.test(value) && Number.isSafeInteger(Number(value))
  ? Number(value)
  : null;

const now = (dependency: WorkerDependencies): number => dependency.clock?.() ?? Date.now();
const createId = (dependency: WorkerDependencies): string => dependency.createId?.() ?? globalThis.crypto.randomUUID();

const turnstileVerifier = (settings: Pick<WorkerSettings, "turnstileSecret" | "turnstileVerifyUrl">): TurnstileVerifier["verify"] => async (input) => {
  const body = new URLSearchParams({
    secret: settings.turnstileSecret,
    response: input.token,
    remoteip: input.ip,
    idempotency_key: input.idempotencyKey,
  });
  try {
    const response = await fetch(settings.turnstileVerifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return { success: false };
    const result = await response.json() as { readonly success?: unknown; readonly hostname?: unknown; readonly action?: unknown };
    return {
      success: result.success === true,
      ...(typeof result.hostname === "string" ? { hostname: result.hostname } : {}),
      ...(typeof result.action === "string" ? { action: result.action } : {}),
    };
  } catch {
    return { success: false };
  }
};

const workflowIdFor = (operationKey: string): string => `cuebench-${operationKey}`;

/** Translates Cloudflare's instance handle into the narrow coordinator status. */
const workflowBindingStatus = async (binding: NonNullable<WorkerEnv["PROCESSING_WORKFLOW"]>, id: string): Promise<"started" | "missing" | "unknown"> => {
  if (binding.get === undefined) return "unknown";
  try {
    const instance = await binding.get(id);
    const status = await instance.status();
    return status.status === "unknown" ? "unknown" : "started";
  } catch {
    // The platform throws for an instance that has not yet been created.
    return "missing";
  }
};

const workerWorkflow = (binding: WorkerEnv["PROCESSING_WORKFLOW"] | undefined): ProcessingWorkflow | undefined => {
  if (binding === undefined) return undefined;
  return {
    start: async ({ id, receipt, objectKey }) => {
      try {
        // The deterministic id is the exactly-once boundary when this call is retried by infrastructure.
        await binding.create({ id, params: { receipt, objectKey } });
      } catch (error) {
        if (await workflowBindingStatus(binding, id) === "started") return;
        throw error;
      }
    },
    ...(binding.get === undefined ? {} : { get: ({ id }: { readonly id: string }) => workflowBindingStatus(binding, id) }),
  };
};

const tokenFailure = (error: unknown): Response => {
  if (!(error instanceof SignedTokenError)) return apiError(401, "SESSION_INVALID", "CueBench could not verify this anonymous session.", { nextAction: "complete-turnstile" });
  if (error.code === "expired") return apiError(401, "SESSION_EXPIRED", "This anonymous CueBench session or recovery receipt has expired.", { nextAction: "complete-turnstile" });
  return apiError(401, "SESSION_INVALID", "CueBench could not verify this anonymous session.", { nextAction: "complete-turnstile" });
};

const receiptFailure = (error: unknown): Response => {
  if (error instanceof SignedTokenError && error.code === "expired") {
    return apiError(410, "UPLOAD_EXPIRED", "This private upload receipt has expired and cannot authorize further processing. Start a new operation.", { stateChanged: false, nextAction: "start-new-operation" });
  }
  return tokenFailure(error);
};

const requiresUploadPurpose = (session: AnonymousSessionClaims): Response | null => session.purpose === "cleanup"
  ? apiError(403, "SESSION_CLEANUP_ONLY", "This anonymous session can only remove a retained private copy.", { nextAction: "complete-turnstile" })
  : null;

type AuthenticatedOperation = {
  readonly session: AnonymousSessionClaims;
  readonly receipt: UploadReceiptClaims;
};

const requestOwnsProjectOwner = async (
  ownerCapability: string | undefined,
  session: AnonymousSessionClaims,
  ownerKey: string,
  settings: WorkerSettings,
): Promise<boolean> => {
  if (projectOwnerCapability(ownerCapability)) {
    return (await saltedLedgerKey(settings.quotaSalt, "project-owner", ownerCapability.toLowerCase())) === ownerKey;
  }
  // Receipts issued before the owner-capability deployment survive only for
  // their already-signed TTL and remain tied to their original session.
  if (ownerKey !== await saltedLedgerKey(settings.quotaSalt, "session", session.sessionId)) return false;
  return true;
};

/**
 * Keeps receipt-expiry semantics and cleanup-only session scope identical for
 * every receipt-bearing operation route. The receipt remains the opaque
 * recovery credential; IP is never used as operation ownership on replay.
 */
const resolveAuthenticatedOperation = async (input: {
  readonly sessionToken: string;
  readonly receiptToken: string;
  readonly ownerCapability: string | undefined;
  readonly settings: WorkerSettings;
  readonly nowMs: number;
  readonly requireUploadPurpose: boolean;
}): Promise<AuthenticatedOperation | Response> => {
  let session: AnonymousSessionClaims;
  try {
    session = await verifyAnonymousSession(input.sessionToken, input.settings.keyRing, input.nowMs);
  } catch (error) {
    return tokenFailure(error);
  }
  if (input.requireUploadPurpose) {
    const purposeFailure = requiresUploadPurpose(session);
    if (purposeFailure !== null) return purposeFailure;
  }
  try {
    const receipt = await verifyUploadReceipt(input.receiptToken, input.settings, input.nowMs);
    if (!await requestOwnsProjectOwner(input.ownerCapability, session, receipt.ownerKey, input.settings)) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload belongs to a different browser project owner.", { nextAction: "start-new-operation" });
    }
    return { session, receipt };
  } catch (error) {
    return receiptFailure(error);
  }
};

const quotaFailure = (code: QuotaRejectionCode, state: Pick<StructuredErrorOptions, "stateChanged"> = {}): Response => {
  if (code === "GLOBAL_BREAKER") return apiError(429, code, "CueBench processing is temporarily unavailable while its public-use spend limit is active.", { retrySafe: true, nextAction: "retry", ...state });
  if (code === "PENDING_SESSION_LIMIT" || code === "PENDING_IP_LIMIT") {
    return apiError(429, code, "CueBench already has the maximum number of private uploads reserved for this anonymous session or network. Cancel an unfinished upload or retry after its lease expires.", { retrySafe: true, nextAction: "resume-upload", ...state });
  }
  if (code === "SESSION_QUOTA" || code === "IP_QUOTA") {
    return apiError(429, code, "CueBench's completed private-processing quota has been reached for this anonymous session or network.", { retrySafe: true, nextAction: "retry", ...state });
  }
  return apiError(409, code, "CueBench could not find the pending private-upload reservation. Start a new upload operation.", { nextAction: "start-new-operation", ...state });
};

/** Checks both the deployed fail-closed switch and the live ledger before cost-bearing work. */
const globalBreakerGuard = async (
  settings: WorkerSettings,
  quotaLedger: QuotaLedgerPort,
  currentNow: number,
  state: Pick<StructuredErrorOptions, "stateChanged"> = {},
): Promise<Response | null> => {
  if (settings.globalSpendBreakerOpen) return quotaFailure("GLOBAL_BREAKER", state);
  try {
    if (await quotaLedger.isGlobalBreakerOpen({ nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents })) {
      return quotaFailure("GLOBAL_BREAKER", state);
    }
  } catch {
    return apiError(503, "GLOBAL_BREAKER_UNAVAILABLE", "CueBench cannot safely check its public-use spend limit right now.", { retrySafe: true, nextAction: "retry", ...state });
  }
  return null;
};

const uploadCoordinatorFor = (env: WorkerEnv, dependencies: WorkerDependencies, operationKey: string): UploadCoordinatorPort | undefined => dependencies.uploadCoordinator ?? (env.UPLOAD_COORDINATOR === undefined
  ? undefined
  : new DurableObjectUploadCoordinator(env.UPLOAD_COORDINATOR as unknown as ConstructorParameters<typeof DurableObjectUploadCoordinator>[0], operationKey));

const quotaLedgerFor = (env: WorkerEnv, dependencies: WorkerDependencies): QuotaLedgerPort | undefined => dependencies.quotaLedger ?? (env.QUOTA_LEDGER === undefined
  ? undefined
  : new DurableObjectQuotaLedger(env.QUOTA_LEDGER as unknown as ConstructorParameters<typeof DurableObjectQuotaLedger>[0]));

const objectStoreFor = (env: WorkerEnv, dependencies: WorkerDependencies): MultipartPrivateObjectStore | undefined => dependencies.objectStore ?? (env.PROCESSING_BUCKET === undefined
  ? undefined
  : new R2PrivateObjectStore(env.PROCESSING_BUCKET));

const probeFor = (
  env: WorkerEnv,
  settings: WorkerSettings,
  dependencies: WorkerDependencies,
  currentNow: number,
): MediaProbe | undefined => {
  // Even fixture adapters must not bypass the production authority boundary:
  // neither an unbound service nor a missing dedicated media key may complete R2.
  // Local Workerd has no Container runtime. Its explicit generation fixture
  // uses a direct signed preparation adapter and leaves upload probing
  // unavailable instead of silently substituting a fake authoritative probe.
  if (fixtureMediaPreparationEnabled(env)) return undefined;
  if (env.MEDIA_PREPARER === undefined || settings.mediaJobSigning === undefined) return undefined;
  return dependencies.mediaProbe ?? new MediaContainerProbeService(env.MEDIA_PREPARER, settings.mediaJobSigning, () => currentNow);
};

interface DerivedOperation {
  readonly sessionKey: string;
  readonly ownerKey: string;
  readonly ipKey: string;
  readonly operationKey: string;
  readonly projectKey: string;
  readonly reservationKey: string;
  readonly metadataHash: string;
  readonly objectKey: string;
  readonly partCount: number;
  readonly expiresAtMs: number;
}

const deriveOperation = async (settings: WorkerSettings, session: AnonymousSessionClaims, ip: string, input: { readonly projectId: string; readonly operationId: string; readonly projectOwnerCapability: string; readonly media: UploadMediaMetadata }, currentNow: number): Promise<DerivedOperation> => {
  const partCount = Math.ceil(input.media.byteLength / settings.partSizeBytes);
  const ownerKey = await saltedLedgerKey(settings.quotaSalt, "project-owner", input.projectOwnerCapability);
  const operationSource = `${ownerKey}:${input.operationId}`;
  const metadataSource = JSON.stringify({ projectId: input.projectId, media: input.media, partSize: settings.partSizeBytes, partCount });
  const [sessionKey, ipKey, operationKey, projectKey, reservationKey, metadataHash] = await Promise.all([
    saltedLedgerKey(settings.quotaSalt, "session", session.sessionId),
    saltedLedgerKey(settings.quotaSalt, "network", ip),
    saltedLedgerKey(settings.quotaSalt, "operation", operationSource),
    saltedLedgerKey(settings.quotaSalt, "project", input.projectId),
    saltedLedgerKey(settings.quotaSalt, "reservation", operationSource),
    saltedLedgerKey(settings.quotaSalt, "metadata", metadataSource),
  ]);
  return {
    sessionKey,
    ownerKey,
    ipKey,
    operationKey,
    projectKey,
    reservationKey,
    metadataHash,
    objectKey: `processing/${ownerKey}/${operationKey}`,
    partCount,
    // The signed recovery receipt, not a changing network or a short-lived
    // Turnstile session, is the resumable operation credential.
    expiresAtMs: currentNow + settings.recoveryTtlMs,
  };
};

type OperationAuthorizationFields = Pick<UploadOperationAuthorization, "ownerKey" | "reservationKey" | "metadataHash" | "objectKey" | "media" | "partSize" | "partCount" | "receiptExpiresAtMs">;

const recordMatchesReceipt = (record: UploadOperationRecord | null, receipt: OperationAuthorizationFields): record is UploadOperationRecord => record !== null
  && (record.ownerKey ?? record.ownerSessionKey) === receipt.ownerKey
  && record.reservationKey === receipt.reservationKey
  && record.metadataHash === receipt.metadataHash
  && record.objectKey === receipt.objectKey
  && record.byteLength === receipt.media.byteLength
  && record.partSize === receipt.partSize
  && record.partCount === receipt.partCount
  && record.receiptExpiresAtMs === receipt.receiptExpiresAtMs;

const recordMatchesCapability = (record: UploadOperationRecord | null, capability: UploadCapabilityClaims): record is UploadOperationRecord => recordMatchesReceipt(record, capability);

const operationAuthorization = (input: {
  readonly sessionId: string;
  readonly media: UploadMediaMetadata;
  readonly operationId: string;
  readonly sessionKey: string;
  readonly ownerKey: string;
  readonly ipKey: string;
  readonly operationKey: string;
  readonly projectKey: string;
  readonly reservationKey: string;
  readonly metadataHash: string;
  readonly objectKey: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly issuedAtMs: number;
  readonly receiptExpiresAtMs: number;
}) => input;

const receiptFromRecord = (sessionId: string, input: { readonly operationId: string; readonly media: UploadMediaMetadata }, derived: DerivedOperation, record: UploadOperationRecord) => operationAuthorization({
  sessionId,
  media: input.media,
  operationId: input.operationId,
  sessionKey: derived.sessionKey,
  ownerKey: derived.ownerKey,
  // Network identity is retained only for quota accounting. A signed recovery
  // receipt must survive a normal mobile/Wi-Fi network change.
  ipKey: record.ownerIpKey,
  operationKey: derived.operationKey,
  projectKey: derived.projectKey,
  reservationKey: derived.reservationKey,
  metadataHash: derived.metadataHash,
  objectKey: derived.objectKey,
  partSize: record.partSize,
  partCount: record.partCount,
  issuedAtMs: record.createdAtMs,
  receiptExpiresAtMs: record.receiptExpiresAtMs,
});

const capabilityFromReceipt = (receipt: UploadOperationAuthorization, currentNow: number, settings: WorkerSettings, capabilitySessionId = receipt.sessionId): Promise<string> => issueUploadCapability({
  ...receipt,
  sessionId: capabilitySessionId,
  issuedAtMs: currentNow,
  expiresAtMs: Math.min(receipt.receiptExpiresAtMs, currentNow + settings.uploadCapabilityTtlMs),
  settings,
});

const operationResponse = async (input: {
  readonly receipt: UploadOperationAuthorization;
  readonly settings: WorkerSettings;
  readonly currentNow: number;
  readonly state: UploadOperationState;
  readonly parts: Readonly<Record<string, { readonly partNumber: number }>>;
  readonly status: 200 | 201;
  /** A recovery status call rebinds only the short capability to the new anonymous session. */
  readonly capabilitySessionId?: string;
}) => {
  const [operationReceipt, uploadCapability] = await Promise.all([
    issueUploadReceipt({ ...input.receipt, settings: input.settings }),
    capabilityFromReceipt(input.receipt, input.currentNow, input.settings, input.capabilitySessionId),
  ]);
  return {
    body: {
      operationReceipt,
      uploadCapability,
      capabilityExpiresAtMs: Math.min(input.receipt.receiptExpiresAtMs, input.currentNow + input.settings.uploadCapabilityTtlMs),
      partSize: input.receipt.partSize,
      partCount: input.receipt.partCount,
      uploadedPartNumbers: Object.values(input.parts).map((part) => part.partNumber).sort((a, b) => a - b),
      status: input.state,
    },
    status: input.status,
  };
};

const partExpectedBytes = (record: UploadOperationRecord, part: number): number => part === record.partCount
  ? record.byteLength - record.partSize * (record.partCount - 1)
  : record.partSize;

const sortedParts = (record: UploadOperationRecord): ReadonlyArray<{ readonly partNumber: number; readonly etag: string }> => Object.values(record.parts)
  .sort((left, right) => left.partNumber - right.partNumber)
  .map((part) => ({ partNumber: part.partNumber, etag: part.etag }));

const cleanupOperation = async (input: {
  readonly record: UploadOperationRecord;
  readonly objectStore: MultipartPrivateObjectStore;
  readonly coordinator: UploadCoordinatorPort;
  readonly quotaLedger: QuotaLedgerPort;
  readonly nowMs: number;
  readonly target: CleanupTarget;
  readonly createId: () => string;
  readonly mode?: "user" | "lifecycle";
}): Promise<{ readonly clean: boolean; readonly stateChanged: boolean; readonly record: UploadOperationRecord | null }> => {
  // This serial claim happens before touching R2. A concurrent PUT observes
  // `cancelling` and cannot overwrite a just-deleted multipart operation.
  const cancellation = await input.coordinator.claimCancellation({
    nowMs: input.nowMs,
    leaseMs: 60_000,
    createId: input.createId,
    target: input.target,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
  }).catch(() => null);
  if (cancellation === null) return { clean: false, stateChanged: false, record: input.record };
  if (cancellation.kind === "status") {
    return { clean: cancellation.record.state === "cancelled", stateChanged: false, record: cancellation.record };
  }
  const target = cancellation.record.cleanupTarget;
  if (target === null) return { clean: false, stateChanged: true, record: cancellation.record };
  // Deleting a key cannot prove that an unknown multipart upload was aborted.
  // Retain this explicit cleanup-pending receipt until R2's lifecycle backstop
  // and a reconciler can safely acknowledge it.
  let r2Acknowledged = !(target.objectState === "uncertain" && target.multipartUploadId === null);
  let mustDeleteObject = target.objectState === "completed" || target.objectState === "uncertain";
  if ((target.objectState === "multipart" || target.objectState === "uncertain") && target.multipartUploadId !== null) {
    try {
      const outcome: void | MultipartAbortOutcome = await input.objectStore.abortMultipart({ key: cancellation.record.objectKey, uploadId: target.multipartUploadId });
      if (outcome === "possibly-completed") mustDeleteObject = true;
    } catch {
      r2Acknowledged = false;
    }
  }
  if (mustDeleteObject) {
    try {
      await input.objectStore.delete(cancellation.record.objectKey);
    } catch {
      r2Acknowledged = false;
    }
  }
  const quotaAcknowledged = await (async (): Promise<boolean> => {
    try {
      // `false` means there was no pending reservation left (for example after
      // authoritative commit); it is still a successful acknowledgement.
      await input.quotaLedger.releaseUploadReservation({ reservationKey: cancellation.record.reservationKey, nowMs: input.nowMs });
      return true;
    } catch {
      return false;
    }
  })();
  const record = await input.coordinator.finishCleanup({
    claimId: cancellation.claim.id,
    claimGeneration: cancellation.claim.generation,
    r2Acknowledged,
    quotaAcknowledged,
    nowMs: input.nowMs,
  }).catch(() => null);
  return { clean: record?.state === "cancelled", stateChanged: true, record };
};

/** Creates the same-origin Hono API. Tests inject fixture-only verification, storage, probe, and workflow adapters. */
export const createCueBenchWorker = (env: WorkerEnv, dependencies: WorkerDependencies = {}) => {
  const app = new Hono<WorkerBindings>();

  app.use("*", async (context, next) => {
    securityHeaders(context.res.headers);
    await next();
    securityHeaders(context.res.headers);
  });

  app.onError(() => apiError(500, "WORKER_UNAVAILABLE", "CueBench could not complete that private processing request. No browser project data changed.", { retrySafe: true, nextAction: "retry" }));

  const generationQuotaLedger = quotaLedgerFor(env, dependencies);
  app.route("/", createGenerationRoutes(env, {
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(generationQuotaLedger === undefined ? {} : { quotaLedger: generationQuotaLedger }),
    ...(dependencies.generationRuns === undefined ? {} : { runs: dependencies.generationRuns }),
    ...(dependencies.generationWorkflow === undefined ? {} : { workflow: dependencies.generationWorkflow }),
  }));
  const audioDescriptionQuotaLedger = quotaLedgerFor(env, dependencies);
  app.route("/", createAudioDescriptionGenerationRoutes(env, {
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(audioDescriptionQuotaLedger === undefined ? {} : { quotaLedger: audioDescriptionQuotaLedger }),
    ...(dependencies.audioDescriptionRuns === undefined ? {} : { runs: dependencies.audioDescriptionRuns }),
    ...(dependencies.generationRuns === undefined ? {} : { leases: dependencies.generationRuns }),
    ...(dependencies.audioDescriptionWorkflow === undefined ? {} : { workflow: dependencies.audioDescriptionWorkflow }),
  }));
  const narrationQuotaLedger = quotaLedgerFor(env, dependencies);
  app.route("/", createNarrationPreviewRoutes(env, {
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(narrationQuotaLedger === undefined ? {} : { quotaLedger: narrationQuotaLedger }),
    ...(dependencies.narrationPreviews === undefined ? {} : { previews: dependencies.narrationPreviews }),
    ...(dependencies.narrationTts === undefined ? {} : { tts: dependencies.narrationTts }),
  }));

  app.get("/api/health", (context) => context.json({ status: "ok" }));

  app.post("/api/session", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch (error) {
      return error instanceof WorkerConfigurationError
        ? apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" })
        : apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const input = sessionRequest(await readBoundedSessionJson(context.req.raw));
    if (input === null) return apiError(400, "TURNSTILE_REQUIRED", "Complete the anti-abuse verification before starting anonymous processing.", { nextAction: "complete-turnstile" });
    const quotaLedger = quotaLedgerFor(env, dependencies);
    if (quotaLedger === undefined) return apiError(503, "SESSION_COORDINATION_UNAVAILABLE", "CueBench cannot safely coordinate this anti-abuse challenge right now.", { retrySafe: true, nextAction: "retry" });
    // A fresh proof may be needed solely to delete an old private copy. The
    // static breaker blocks new spend, never that cleanup-only reauthentication.
    if (input.purpose === "upload") {
      const breaker = await globalBreakerGuard(settings, quotaLedger, currentNow);
      if (breaker !== null) return breaker;
    }
    const ip = clientIp(context.req.raw);
    const expectedHostname = settings.turnstileExpectedHostname ?? new URL(context.req.raw.url).hostname;
    const challengeKey = await saltedLedgerKey(settings.quotaSalt, "turnstile", input.token);
    const expiresAtMs = currentNow + settings.sessionTtlMs;
    let replay = await quotaLedger.reserveTurnstileSession({
      challengeKey,
      sessionId: createId(dependencies),
      siteverifyId: createId(dependencies),
      issuedAtMs: currentNow,
      expiresAtMs,
      nowMs: currentNow,
    }).catch(() => null);
    if (replay === null) return apiError(503, "SESSION_COORDINATION_UNAVAILABLE", "CueBench cannot safely coordinate this anti-abuse challenge right now.", { retrySafe: true, nextAction: "retry" });
    if (!replay.verified) {
      const verification = await (dependencies.verifyTurnstile ?? turnstileVerifier(settings))({
        token: input.token,
        ip,
        // Never accept a caller-provided idempotency key for the upstream verifier.
        idempotencyKey: replay.siteverifyId,
        expectedHostname,
        expectedAction: settings.turnstileExpectedAction,
      });
      if (verification.success !== true || verification.hostname !== expectedHostname || verification.action !== settings.turnstileExpectedAction) {
        await quotaLedger.releaseTurnstileSession({ challengeKey, nowMs: currentNow }).catch(() => undefined);
        recordTelemetry(dependencies.telemetry, { stage: "session", status: "rejected", errorCode: "TURNSTILE_REJECTED" });
        return apiError(403, "TURNSTILE_REJECTED", "CueBench could not verify the anti-abuse check for this site and action. No anonymous session was created.", { nextAction: "complete-turnstile" });
      }
      const verified = await quotaLedger.markTurnstileSessionVerified({ challengeKey, nowMs: currentNow }).catch(() => null);
      if (verified === null) return apiError(503, "SESSION_COORDINATION_UNAVAILABLE", "CueBench verified the anti-abuse challenge but could not safely retain its anonymous-session result.", { retrySafe: true, stateChanged: true, nextAction: "retry" });
      replay = verified;
    }
    const session = await issueAnonymousSession({
      sessionId: replay.sessionId,
      issuedAtMs: replay.issuedAtMs,
      expiresAtMs: replay.expiresAtMs,
      purpose: input.purpose,
      keyRing: settings.keyRing,
    });
    recordTelemetry(dependencies.telemetry, { stage: "session", status: "accepted", latencyMs: 0 });
    return context.json({ session, expiresAtMs: replay.expiresAtMs }, 201);
  });

  app.post("/api/uploads", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const sessionToken = bearerToken(context.req.raw);
    if (sessionToken === null) return apiError(401, "SESSION_REQUIRED", "Start an anonymous CueBench session before requesting a private upload.", { nextAction: "complete-turnstile" });
    let session: AnonymousSessionClaims;
    try {
      session = await verifyAnonymousSession(sessionToken, settings.keyRing, currentNow);
    } catch (error) {
      return tokenFailure(error);
    }
    const purposeFailure = requiresUploadPurpose(session);
    if (purposeFailure !== null) return purposeFailure;
    const input = uploadRequest(await context.req.json<unknown>().catch(() => null));
    if (input === null) return apiError(400, "UPLOAD_REQUEST_INVALID", "CueBench could not read the requested private upload operation.", { nextAction: "start-new-operation" });
    if (!input.disclosureAccepted) {
      return apiError(428, "DISCLOSURE_REQUIRED", "Accept the temporary cloud-processing disclosure before CueBench uploads a private processing copy.", { nextAction: "resume-upload" });
    }
    let media: UploadMediaMetadata;
    try {
      media = validateUploadMetadata(input.media, settings);
    } catch (error) {
      const code = error instanceof UploadValidationError ? error.code : "UPLOAD_METADATA_INVALID";
      recordTelemetry(dependencies.telemetry, { stage: "upload", status: "rejected", errorCode: code });
      return apiError(422, code, error instanceof UploadValidationError ? error.message : "CueBench could not validate the selected video.", { nextAction: "start-new-operation" });
    }
    const ip = clientIp(context.req.raw);
    const derived = await deriveOperation(settings, session, ip, { ...input, media }, currentNow);
    const quotaLedger = quotaLedgerFor(env, dependencies);
    const coordinator = uploadCoordinatorFor(env, dependencies, derived.operationKey);
    const objectStore = objectStoreFor(env, dependencies);
    if (quotaLedger === undefined || coordinator === undefined || objectStore === undefined) {
      return apiError(503, "UPLOAD_UNAVAILABLE", "CueBench cannot safely reserve and store a private processing copy right now.", { retrySafe: true, nextAction: "retry" });
    }
    const breaker = await globalBreakerGuard(settings, quotaLedger, currentNow);
    if (breaker !== null) return breaker;
    const reservation = await quotaLedger.reserveUpload({
      sessionKey: derived.sessionKey,
      ipKey: derived.ipKey,
      reservationKey: derived.reservationKey,
      byteLength: media.byteLength,
      nowMs: currentNow,
      expiresAtMs: derived.expiresAtMs,
      quotas: settings.quotas,
    }).catch(() => null);
    if (reservation === null) return apiError(503, "QUOTA_UNAVAILABLE", "CueBench cannot safely enforce anonymous processing limits right now.", { retrySafe: true, nextAction: "retry" });
    if (!reservation.accepted) {
      recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: media.durationMs, byteSize: media.byteLength, status: "rejected", errorCode: reservation.code });
      return quotaFailure(reservation.code);
    }
    const begin = await coordinator.begin({
      ownerSessionKey: derived.sessionKey,
      ownerKey: derived.ownerKey,
      ownerIpKey: derived.ipKey,
      metadataHash: derived.metadataHash,
      reservationKey: derived.reservationKey,
      objectKey: derived.objectKey,
      byteLength: media.byteLength,
      partSize: settings.partSizeBytes,
      partCount: derived.partCount,
      nowMs: currentNow,
      expiresAtMs: derived.expiresAtMs,
      receiptExpiresAtMs: derived.expiresAtMs,
    }).catch(() => null);
    if (begin === null) return apiError(503, "UPLOAD_COORDINATION_UNAVAILABLE", "CueBench could not safely coordinate this private upload.", { retrySafe: true, nextAction: "retry" });
    if (begin.kind === "conflict") {
      return apiError(409, "IDEMPOTENCY_CONFLICT", "This upload operation id was already used with different private media metadata. Start a new operation id.", { nextAction: "start-new-operation" });
    }
    let record = begin.record;
    if (begin.kind === "created") {
      let multipart: { readonly uploadId: string };
      try {
        multipart = await objectStore.createMultipart(record.objectKey, {
          contentType: media.contentType,
          customMetadata: { operation: record.objectKey.split("/").at(-1) ?? "", owner: record.ownerKey ?? record.ownerSessionKey },
        });
      } catch {
        const cleanup = await cleanupOperation({
          record,
          objectStore,
          coordinator,
          quotaLedger,
          nowMs: currentNow,
          createId: () => createId(dependencies),
          // R2 can fail after it accepted creation; deletion is the truthful
          // compensation even though no upload id was returned.
          target: { objectState: "uncertain", multipartUploadId: null, reason: "multipart-create-ambiguous" },
        });
        return apiError(cleanup.clean ? 502 : 409, cleanup.clean ? "MULTIPART_CREATE_FAILED" : "MULTIPART_CREATE_CLEANUP_PENDING", cleanup.clean
          ? "CueBench could not confirm private multipart creation and reconciled any temporary object before returning."
          : "CueBench could not confirm private multipart creation and is retaining a cleanup receipt for reconciliation.", { retrySafe: !cleanup.clean, stateChanged: cleanup.stateChanged, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
      }
      const attached = await coordinator.attachMultipart({ uploadId: multipart.uploadId, nowMs: currentNow }).catch(() => null);
      record = attached ?? record;
      if (record.state !== "pending" || record.multipartUploadId !== multipart.uploadId) {
        // Persist the exact id before compensation. A duplicate POST cannot
        // create a second multipart upload while this state is reconciled.
        const reconciled = await coordinator.markCreateReconciliation({ uploadId: multipart.uploadId, nowMs: currentNow }).catch(() => null);
        if (reconciled !== null) record = reconciled;
        const cleanup = await cleanupOperation({
          record,
          objectStore,
          coordinator,
          quotaLedger,
          nowMs: currentNow,
          createId: () => createId(dependencies),
          target: { objectState: "multipart", multipartUploadId: multipart.uploadId, reason: "multipart-attach-ambiguous" },
        });
        return apiError(cleanup.clean ? 503 : 409, cleanup.clean ? "MULTIPART_CREATE_RECONCILED" : "MULTIPART_CREATE_RECONCILIATION_REQUIRED", cleanup.clean
          ? "CueBench reconciled private multipart creation before a receipt was returned. Start a fresh operation."
          : "CueBench created a private multipart upload but is retaining its exact cleanup target. Keep the recovery receipt and retry cleanup.", { retrySafe: !cleanup.clean, stateChanged: true, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
      }
    }
    if (record.state === "creating") {
      // A concurrent duplicate observes the immutable operation immediately;
      // it never opens a second R2 multipart upload while creation is in flight.
      const receipt = receiptFromRecord(session.sessionId, { operationId: input.operationId, media }, derived, record);
      const response = await operationResponse({ receipt, settings, currentNow, state: record.state, parts: record.parts, status: 200 });
      return context.json(response.body, response.status);
    }
    const receipt = receiptFromRecord(session.sessionId, { operationId: input.operationId, media }, derived, record);
    const response = await operationResponse({ receipt, settings, currentNow, state: record.state, parts: record.parts, status: begin.kind === "created" ? 201 : 200 });
    recordTelemetry(dependencies.telemetry, { stage: "upload", durationMs: media.durationMs, byteSize: media.byteLength, status: begin.kind === "created" ? "accepted" : "resumed" });
    return context.json(response.body, response.status);
  });

  app.put("/api/uploads/:operationId/parts/:partNumber", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const operationId = context.req.param("operationId");
    const requestedPart = partNumber(context.req.param("partNumber"));
    const sessionToken = bearerToken(context.req.raw);
    const capabilityToken = context.req.header("x-cuebench-upload-capability");
    if (!opaqueId(operationId) || requestedPart === null || sessionToken === null || capabilityToken === undefined) {
      return apiError(401, "UPLOAD_CAPABILITY_REQUIRED", "CueBench needs the anonymous session and private multipart capability.", { nextAction: "resume-upload" });
    }
    let session: AnonymousSessionClaims;
    let capability: UploadCapabilityClaims;
    try {
      [session, capability] = await Promise.all([
        verifyAnonymousSession(sessionToken, settings.keyRing, currentNow),
        verifyUploadCapability(capabilityToken, settings, currentNow),
      ]);
    } catch (error) {
      return tokenFailure(error);
    }
    const purposeFailure = requiresUploadPurpose(session);
    if (purposeFailure !== null) return purposeFailure;
    if (capability.sessionId !== session.sessionId || capability.operationId !== operationId) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private multipart capability belongs to a different anonymous session or operation.", { nextAction: "start-new-operation" });
    }
    if (!await requestOwnsProjectOwner(context.req.header("x-cuebench-project-owner"), session, capability.ownerKey, settings)) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private multipart capability belongs to a different browser project owner.", { nextAction: "start-new-operation" });
    }
    if (normaliseContentType(context.req.header("content-type") ?? "") !== capability.media.contentType) {
      return apiError(422, "CONTENT_TYPE_MISMATCH", "CueBench could not verify this private upload part's media type. No part was stored.", { nextAction: "resume-upload" });
    }
    const coordinator = uploadCoordinatorFor(env, dependencies, capability.operationKey);
    const objectStore = objectStoreFor(env, dependencies);
    const quotaLedger = quotaLedgerFor(env, dependencies);
    if (coordinator === undefined || objectStore === undefined || quotaLedger === undefined) return apiError(503, "UPLOAD_UNAVAILABLE", "CueBench cannot safely store this private multipart chunk right now.", { retrySafe: true, nextAction: "retry" });
    const breaker = await globalBreakerGuard(settings, quotaLedger, currentNow);
    if (breaker !== null) return breaker;
    const record = await coordinator.get(currentNow).catch(() => null);
    if (!recordMatchesCapability(record, capability)) return apiError(409, "UPLOAD_UNKNOWN", "CueBench could not find this private upload operation. Start a new operation.", { nextAction: "start-new-operation" });
    if (record.multipartUploadId === null || requestedPart > record.partCount) return apiError(409, "UPLOAD_STATE_CHANGED", "CueBench cannot accept this multipart chunk in the operation's current state.", { retrySafe: true, nextAction: "wait-for-status" });
    // The serial DO lease is acquired before any body byte is read.
    const claim = await coordinator.claimPart({ partNumber: requestedPart, nowMs: currentNow, leaseMs: settings.partLeaseMs, createId: () => createId(dependencies) }).catch(() => null);
    if (claim === null) return apiError(503, "PART_COORDINATION_UNAVAILABLE", "CueBench could not safely claim this private multipart chunk.", { retrySafe: true, nextAction: "retry" });
    const existingPartResponse = async (part: { readonly partNumber: number; readonly etag: string }, status: 200 | 201): Promise<Response> => context.json({
      partReceipt: await issueUploadPartReceipt({
        sessionId: capability.sessionId,
        operationId,
        operationKey: capability.operationKey,
        partNumber: part.partNumber,
        etag: part.etag,
        issuedAtMs: record.createdAtMs,
        expiresAtMs: record.receiptExpiresAtMs,
        settings,
      }),
      partNumber: part.partNumber,
      status: claim.record.state,
    }, status);
    if (claim.kind === "uploaded") return existingPartResponse(claim.part, 200);
    if (claim.kind === "in-progress") return apiError(409, "PART_IN_PROGRESS", "CueBench is already receiving this private multipart chunk. Wait for its receipt, then retry status.", { retrySafe: true, nextAction: "wait-for-status" });
    if (claim.kind === "unavailable") return apiError(409, "PART_STATE_UNAVAILABLE", "CueBench cannot accept this private multipart chunk in the operation's current state.", { retrySafe: true, nextAction: "wait-for-status" });
    const expectedBytes = partExpectedBytes(record, requestedPart);
    let body: ArrayBuffer;
    try {
      body = await readExactUploadPart(context.req.raw, expectedBytes, settings.partSizeBytes);
    } catch (error) {
      await coordinator.releasePart({ partNumber: requestedPart, claimId: claim.claim.id, claimGeneration: claim.claim.generation, nowMs: currentNow }).catch(() => undefined);
      return apiError(422, error instanceof UploadValidationError ? error.code : "BODY_SIZE", error instanceof UploadValidationError ? error.message : "CueBench could not verify this private upload part size.", { retrySafe: true, nextAction: "resume-upload" });
    }
    let uploaded: { readonly etag: string };
    try {
      uploaded = await objectStore.uploadPart({ key: record.objectKey, uploadId: record.multipartUploadId, partNumber: requestedPart, body });
    } catch {
      await coordinator.releasePart({ partNumber: requestedPart, claimId: claim.claim.id, claimGeneration: claim.claim.generation, nowMs: currentNow }).catch(() => undefined);
      return apiError(502, "PART_STORAGE_FAILED", "CueBench could not store this private multipart chunk. Retry the same part while its upload lease is active.", { retrySafe: true, nextAction: "resume-upload" });
    }
    const marked = await coordinator.recordPart({ partNumber: requestedPart, claimId: claim.claim.id, claimGeneration: claim.claim.generation, etag: uploaded.etag, byteLength: body.byteLength, nowMs: currentNow }).catch(() => null);
    if (marked === null) {
      return apiError(503, "PART_RECONCILIATION_REQUIRED", "CueBench stored a private multipart chunk but could not persist its receipt. Retry the same part after its short lease expires; no whole file is retained in Worker memory.", { retrySafe: true, stateChanged: true, nextAction: "wait-for-status" });
    }
    if (marked.kind !== "recorded") {
      // The body arrived after its serial lease expired. R2 cannot safely
      // remove an individual ambiguous part, so compensate the exact multipart
      // target rather than letting a stale ETag win a later completion.
      const cleanup = await cleanupOperation({
        record: marked.record,
        objectStore,
        coordinator,
        quotaLedger,
        nowMs: currentNow,
        createId: () => createId(dependencies),
        target: { objectState: "multipart", multipartUploadId: marked.record.multipartUploadId, reason: marked.kind === "stale" ? "stale-part-lease" : "invalid-part-receipt" },
      });
      return apiError(cleanup.clean ? 409 : 409, cleanup.clean ? "PART_STALE_FENCED" : "PART_STALE_CLEANUP_PENDING", cleanup.clean
        ? "CueBench fenced a late private multipart write and aborted the affected upload. Start a fresh operation."
        : "CueBench fenced a late private multipart write and is reconciling the exact private cleanup target.", { retrySafe: !cleanup.clean, stateChanged: true, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
    }
    recordTelemetry(dependencies.telemetry, { stage: "upload", byteSize: body.byteLength, status: "part-uploaded" });
    return existingPartResponse({ partNumber: requestedPart, etag: uploaded.etag }, 201);
  });

  app.get("/api/uploads/:operationId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const operationId = context.req.param("operationId");
    const sessionToken = bearerToken(context.req.raw);
    const receiptToken = context.req.header("x-cuebench-operation-receipt");
    if (!opaqueId(operationId) || sessionToken === null || receiptToken === undefined) return apiError(401, "UPLOAD_RECEIPT_REQUIRED", "CueBench needs the anonymous session and signed operation receipt.", { nextAction: "resume-upload" });
    const authenticated = await resolveAuthenticatedOperation({ sessionToken, receiptToken, ownerCapability: context.req.header("x-cuebench-project-owner"), settings, nowMs: currentNow, requireUploadPurpose: true });
    if (authenticated instanceof Response) return authenticated;
    const { session, receipt } = authenticated;
    if (receipt.operationId !== operationId) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different operation.", { nextAction: "start-new-operation" });
    const coordinator = uploadCoordinatorFor(env, dependencies, receipt.operationKey);
    if (coordinator === undefined) return apiError(503, "UPLOAD_COORDINATION_UNAVAILABLE", "CueBench cannot safely read this private upload's resumable state right now.", { retrySafe: true, nextAction: "retry" });
    const record = await coordinator.get(currentNow).catch(() => null);
    if (!recordMatchesReceipt(record, receipt)) return apiError(410, "UPLOAD_EXPIRED", "This private upload operation is no longer available. Start a new operation.", { nextAction: "start-new-operation" });
    const response = await operationResponse({ receipt, settings, currentNow, state: record.state, parts: record.parts, status: 200, capabilitySessionId: session.sessionId });
    return context.json(response.body);
  });

  app.post("/api/uploads/:operationId/complete", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const operationId = context.req.param("operationId");
    const sessionToken = bearerToken(context.req.raw);
    const receiptToken = context.req.header("x-cuebench-operation-receipt");
    if (!opaqueId(operationId) || sessionToken === null || receiptToken === undefined) return apiError(401, "UPLOAD_RECEIPT_REQUIRED", "CueBench needs the anonymous session and signed operation receipt.", { nextAction: "resume-upload" });
    const authenticated = await resolveAuthenticatedOperation({ sessionToken, receiptToken, ownerCapability: context.req.header("x-cuebench-project-owner"), settings, nowMs: currentNow, requireUploadPurpose: true });
    if (authenticated instanceof Response) return authenticated;
    const { receipt } = authenticated;
    if (receipt.operationId !== operationId) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This signed private-upload receipt belongs to a different operation.", { nextAction: "start-new-operation" });
    const coordinator = uploadCoordinatorFor(env, dependencies, receipt.operationKey);
    const objectStore = objectStoreFor(env, dependencies);
    const quotaLedger = quotaLedgerFor(env, dependencies);
    if (coordinator === undefined || objectStore === undefined || quotaLedger === undefined) return apiError(503, "PROCESSING_UNAVAILABLE", "CueBench cannot safely complete private processing right now.", { retrySafe: true, nextAction: "retry" });
    let record = await coordinator.get(currentNow).catch(() => null);
    if (!recordMatchesReceipt(record, receipt)) return apiError(410, "UPLOAD_EXPIRED", "This private upload operation is no longer available. Start a new operation.", { nextAction: "start-new-operation" });
    if (record.state === "queued" || record.state === "completed") return context.json({ operationReceipt: receiptToken, status: record.state }, 200);
    if (record.state === "cancelled") return apiError(409, "UPLOAD_CANCELLED", "CueBench confirmed cleanup of this temporary private upload. Start a new operation to process another copy.", { nextAction: "start-new-operation" });
    if (record.state === "cleanup-pending" || record.state === "cancelling") return apiError(409, "UPLOAD_CLEANUP_PENDING", "CueBench is reconciling deletion of this private processing copy. Keep the receipt and retry cleanup status.", { retrySafe: true, nextAction: "retry-cleanup" });
    if (record.state === "pending" || record.state === "creating") return apiError(409, "UPLOAD_INCOMPLETE", "Upload every bounded private multipart chunk before requesting authoritative processing.", { retrySafe: true, nextAction: "resume-upload" });
    if (record.multipartUploadId === null) return apiError(409, "UPLOAD_STATE_CHANGED", "CueBench cannot complete this private upload in its current state.", { retrySafe: true, nextAction: "wait-for-status" });

    const initialBreaker = await globalBreakerGuard(settings, quotaLedger, currentNow);
    if (initialBreaker !== null) return initialBreaker;

    // Refuse unavailable authoritative inspection before completing the R2
    // multipart object. This prevents a completed private copy from being
    // retained solely because the future media-probe service is absent.
    const probe = probeFor(env, settings, dependencies, currentNow);
    if ((record.state === "uploaded" || record.state === "failed-retryable" || record.state === "completing") && probe === undefined) {
      const cleanup = await cleanupOperation({
        record,
        objectStore,
        coordinator,
        quotaLedger,
        nowMs: currentNow,
        createId: () => createId(dependencies),
        // A prior complete response may have been lost while the coordinator
        // still says `completing`; delete as well as abort in that case.
        target: {
          objectState: record.state === "uploaded" ? "multipart" : "uncertain",
          multipartUploadId: record.multipartUploadId,
          reason: "media-probe-unavailable-before-complete",
        },
      });
      return apiError(cleanup.clean ? 503 : 409, cleanup.clean ? "MEDIA_PROBE_UNAVAILABLE" : "MEDIA_PROBE_CLEANUP_PENDING", cleanup.clean
        ? "CueBench could not authoritatively inspect this private media, so it aborted the temporary multipart copy before completion."
        : "CueBench could not authoritatively inspect this private media and is reconciling the temporary multipart cleanup.", { retrySafe: !cleanup.clean, stateChanged: true, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
    }

    let completionStateChanged = false;
    if (record.state === "uploaded" || record.state === "failed-retryable" || record.state === "completing") {
      const completion = await coordinator.beginCompletion({ nowMs: currentNow, leaseMs: settings.partLeaseMs, createId: () => createId(dependencies) }).catch(() => null);
      if (completion === null) return apiError(503, "COMPLETE_COORDINATION_UNAVAILABLE", "CueBench could not safely claim this private completion.", { retrySafe: true, nextAction: "retry" });
      record = completion.record;
      if (completion.kind === "claimed") {
        let completedObject: boolean;
        try {
          completedObject = (await objectStore.head(record.objectKey)).exists;
        } catch {
          await coordinator.markRetryableFailure({ note: "object-head-before-complete", nowMs: currentNow, claimId: completion.claim.id, claimGeneration: completion.claim.generation }).catch(() => undefined);
          return apiError(503, "COMPLETE_RECONCILIATION_REQUIRED", "CueBench could not check whether this private multipart object was already completed. Retry the same receipt; no duplicate workflow will start.", { retrySafe: true, stateChanged: true, nextAction: "retry-completion" });
        }
        if (!completedObject) {
          try {
            await objectStore.completeMultipart({ key: record.objectKey, uploadId: record.multipartUploadId!, parts: sortedParts(record) });
          } catch {
            // R2 completion may have succeeded before the response was lost.
            try {
              completedObject = (await objectStore.head(record.objectKey)).exists;
            } catch {
              completedObject = false;
            }
            if (!completedObject) {
              await coordinator.markRetryableFailure({ note: "multipart-complete-ambiguous", nowMs: currentNow, claimId: completion.claim.id, claimGeneration: completion.claim.generation }).catch(() => undefined);
              return apiError(502, "COMPLETE_RECONCILIATION_REQUIRED", "CueBench could not confirm multipart completion. The private operation remains recoverable; retry the same completion receipt rather than starting another upload.", { retrySafe: true, stateChanged: true, nextAction: "retry-completion" });
            }
          }
        }
        const probing = await coordinator.markProbing({ claimId: completion.claim.id, claimGeneration: completion.claim.generation, nowMs: currentNow }).catch(() => null);
        if (probing === null || probing.state !== "probing") {
          return apiError(503, "COMPLETE_RECONCILIATION_REQUIRED", "CueBench confirmed private multipart completion but could not persist the authoritative-probe transition. Keep this receipt; cleanup and completion reconciliation remain explicit.", { retrySafe: true, stateChanged: true, nextAction: "retry-completion" });
        }
        completionStateChanged = true;
      }
    }
    // `probing` is deliberately retained on probe failure. Browser/R2 metadata never starts a workflow.
    record = await coordinator.get(currentNow).catch(() => null);
    if (!recordMatchesReceipt(record, receipt)) return apiError(503, "PROCESSING_RECONCILIATION_REQUIRED", "CueBench could not reconcile this private operation after multipart completion.", { retrySafe: true, nextAction: "wait-for-status" });
    if (record.state === "completing") return apiError(503, "COMPLETE_RECONCILIATION_REQUIRED", "CueBench is reconciling multipart completion for this private operation. Retry the same receipt; do not create another upload.", { retrySafe: true, nextAction: "retry-completion" });
    if (record.state !== "probing" && record.state !== "ready" && record.state !== "workflow-starting") return apiError(409, "UPLOAD_STATE_CHANGED", "CueBench cannot authoritatively validate this private upload in its current state.", { retrySafe: true, nextAction: "wait-for-status" });

    let authoritativeStateChanged = false;
    if (record.state === "probing") {
      if (probe === undefined) {
        const cleanup = await cleanupOperation({ record, objectStore, coordinator, quotaLedger, nowMs: currentNow, createId: () => createId(dependencies), target: { objectState: "completed", multipartUploadId: record.multipartUploadId, reason: "media-probe-unavailable" } });
        return apiError(cleanup.clean ? 503 : 409, cleanup.clean ? "MEDIA_PROBE_UNAVAILABLE" : "MEDIA_PROBE_CLEANUP_PENDING", cleanup.clean
          ? "CueBench cannot authoritatively inspect this private media, so it deleted the temporary copy before any workflow started."
          : "CueBench cannot authoritatively inspect this private media and is reconciling deletion of the temporary copy.", { retrySafe: !cleanup.clean, stateChanged: true, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
      }
      const probeBreaker = await globalBreakerGuard(settings, quotaLedger, currentNow, { stateChanged: completionStateChanged });
      if (probeBreaker !== null) return probeBreaker;
      const probeClaim = await coordinator.claimProbe({ nowMs: currentNow, leaseMs: settings.partLeaseMs, createId: () => createId(dependencies) }).catch(() => null);
      if (probeClaim === null) return apiError(503, "PROBE_COORDINATION_UNAVAILABLE", "CueBench could not safely claim authoritative media inspection.", { retrySafe: true, stateChanged: completionStateChanged, nextAction: "retry-probe" });
      if (probeClaim.kind === "status") return apiError(503, "PROBE_IN_PROGRESS", "CueBench is already authoritatively inspecting this private copy. Retry the same receipt after the short probe lease.", { retrySafe: true, stateChanged: completionStateChanged, nextAction: "retry-probe" });
      const probeSpend = await quotaLedger.reserveSpend({
        spendKey: `probe:${receipt.operationKey}`,
        maxCents: settings.maxMediaProbeCostCents,
        nowMs: currentNow,
        globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
      }).catch(() => null);
      if (probeSpend === null || !probeSpend.accepted) {
        await coordinator.releaseProbe({ claimId: probeClaim.claim.id, claimGeneration: probeClaim.claim.generation, nowMs: currentNow, note: "probe-spend-unavailable" }).catch(() => undefined);
        return probeSpend === null
          ? apiError(503, "SPEND_RECONCILIATION_REQUIRED", "CueBench could not persist the conservative authoritative-probe spend reservation. No probe was started.", { retrySafe: true, stateChanged: true, nextAction: "retry-probe" })
          : quotaFailure("GLOBAL_BREAKER", { stateChanged: true });
      }
      let facts;
      try {
        facts = await probe.probe({
          operationId: receipt.operationId,
          operationKey: receipt.operationKey,
          objectKey: receipt.objectKey,
          inputByteLength: receipt.media.byteLength,
          inputContentType: receipt.media.contentType === "video/mp4" ? "video/mp4" : "video/webm",
          operationReceipt: receiptToken,
          receiptExpiresAtMs: receipt.receiptExpiresAtMs,
          idempotencyKey: `probe:${receipt.operationKey}`,
        });
      } catch (error) {
        if (error instanceof MediaProbeRejected) {
          // A versioned, deterministic 4xx from the private service means
          // this completed object can never enter a workflow. Cleanup also
          // releases the operation's pending upload quota and probe lease.
          await quotaLedger.finalizeSpend({
            spendKey: `probe:${receipt.operationKey}`,
            actualCents: 0,
            nowMs: currentNow,
            globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
          }).catch(() => undefined);
          const cleanup = await cleanupOperation({
            record,
            objectStore,
            coordinator,
            quotaLedger,
            nowMs: currentNow,
            createId: () => createId(dependencies),
            target: {
              objectState: "completed",
              multipartUploadId: record.multipartUploadId,
              reason: `authoritative-media-${error.code.toLowerCase()}`,
            },
          });
          recordTelemetry(dependencies.telemetry, {
            stage: "processing",
            byteSize: receipt.media.byteLength,
            status: "rejected",
            errorCode: "AUTHORITATIVE_MEDIA_REJECTED",
          });
          return apiError(cleanup.clean ? 422 : 409, cleanup.clean ? "AUTHORITATIVE_MEDIA_REJECTED" : "AUTHORITATIVE_MEDIA_CLEANUP_PENDING", cleanup.clean
            ? "CueBench's authoritative private-media inspection rejected this file. No workflow was started."
            : "CueBench rejected this private media and is reconciling deletion. Keep the receipt and retry cleanup.", { stateChanged: true, retrySafe: !cleanup.clean, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
        }
        await coordinator.releaseProbe({ claimId: probeClaim.claim.id, claimGeneration: probeClaim.claim.generation, nowMs: currentNow, note: "media-probe-unavailable" }).catch(() => undefined);
        return apiError(503, "MEDIA_PROBE_UNAVAILABLE", "CueBench could not authoritatively inspect this private media. The private copy remains recoverable only until its disclosed cleanup deadline.", { retrySafe: true, stateChanged: true, nextAction: "retry-probe" });
      }
      if (facts.providerSpendCents !== undefined) {
        const settledProbe = await quotaLedger.finalizeSpend({
          spendKey: `probe:${receipt.operationKey}`,
          actualCents: facts.providerSpendCents,
          nowMs: currentNow,
          globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
        }).catch(() => null);
        if (settledProbe === null || !settledProbe.persisted) {
          await coordinator.releaseProbe({ claimId: probeClaim.claim.id, claimGeneration: probeClaim.claim.generation, nowMs: currentNow, note: "probe-spend-settlement-required" }).catch(() => undefined);
          return apiError(503, "SPEND_RECONCILIATION_REQUIRED", "CueBench could not persist authoritative media-probe usage. No workflow was started.", { retrySafe: true, stateChanged: true, nextAction: "retry-probe" });
        }
      }
      const factsMatch = facts.byteLength === receipt.media.byteLength && facts.mimeType === receipt.media.contentType;
      if (!factsMatch || !isSupportedAuthoritativeMedia(facts, { maxBytes: settings.maxUploadBytes, maxDurationMs: settings.maxUploadDurationMs })) {
        const cleanup = await cleanupOperation({ record, objectStore, coordinator, quotaLedger, nowMs: currentNow, createId: () => createId(dependencies), target: { objectState: "completed", multipartUploadId: record.multipartUploadId, reason: "authoritative-media-rejected" } });
        recordTelemetry(dependencies.telemetry, { stage: "processing", byteSize: receipt.media.byteLength, status: "rejected", errorCode: "AUTHORITATIVE_MEDIA_REJECTED" });
        return apiError(cleanup.clean ? 422 : 409, cleanup.clean ? "AUTHORITATIVE_MEDIA_REJECTED" : "AUTHORITATIVE_MEDIA_CLEANUP_PENDING", cleanup.clean
          ? "CueBench's authoritative private-media inspection rejected this file. No workflow was started."
          : "CueBench rejected this private media and is reconciling deletion. Keep the receipt and retry cleanup.", { stateChanged: true, retrySafe: !cleanup.clean, nextAction: cleanup.clean ? "start-new-operation" : "retry-cleanup" });
      }
      const commitBreaker = await globalBreakerGuard(settings, quotaLedger, currentNow, { stateChanged: true });
      if (commitBreaker !== null) return commitBreaker;
      const committed = await quotaLedger.commitMedia({
        reservationKey: receipt.reservationKey,
        actualByteLength: facts.byteLength,
        actualDurationMs: facts.durationMs,
        nowMs: currentNow,
        quotas: settings.quotas,
      }).catch(() => null);
      if (committed === null) {
        await coordinator.releaseProbe({ claimId: probeClaim.claim.id, claimGeneration: probeClaim.claim.generation, nowMs: currentNow, note: "quota-reconciliation-required" }).catch(() => undefined);
        return apiError(503, "QUOTA_RECONCILIATION_REQUIRED", "CueBench verified the private media but could not atomically reconcile anonymous quota. No workflow was started; retry the same receipt.", { retrySafe: true, stateChanged: true, nextAction: "retry-probe" });
      }
      if (!committed.accepted) {
        const cleanup = await cleanupOperation({ record, objectStore, coordinator, quotaLedger, nowMs: currentNow, createId: () => createId(dependencies), target: { objectState: "completed", multipartUploadId: record.multipartUploadId, reason: "authoritative-quota-rejected" } });
        return cleanup.clean
          ? quotaFailure(committed.code, { stateChanged: true })
          : apiError(409, "QUOTA_REJECTED_CLEANUP_PENDING", "CueBench rejected private processing under the authoritative quota but is reconciling deletion. Keep the receipt and retry cleanup.", { retrySafe: true, stateChanged: true, nextAction: "retry-cleanup" });
      }
      record = await coordinator.markReady({ claimId: probeClaim.claim.id, claimGeneration: probeClaim.claim.generation, nowMs: currentNow }).catch(() => null);
      if (!recordMatchesReceipt(record, receipt) || record.state !== "ready") return apiError(503, "PROCESSING_RECONCILIATION_REQUIRED", "CueBench committed authoritative quota but could not persist the next private-processing state. Retry the same receipt; no workflow was started.", { retrySafe: true, stateChanged: true, nextAction: "retry-probe" });
      authoritativeStateChanged = true;
    }

    const workflow = dependencies.workflow ?? workerWorkflow(env.PROCESSING_WORKFLOW);
    if (workflow === undefined) return apiError(503, "PROCESSING_UNAVAILABLE", "CueBench cannot start private processing right now. The authoritatively verified upload remains recoverable.", { retrySafe: true, stateChanged: authoritativeStateChanged, nextAction: "retry" });
    const workflowId = workflowIdFor(receipt.operationKey);
    const workflowBreaker = await globalBreakerGuard(settings, quotaLedger, currentNow, { stateChanged: authoritativeStateChanged });
    if (workflowBreaker !== null) return workflowBreaker;
    const workflowSpend = await quotaLedger.reserveSpend({
      spendKey: `workflow:${receipt.operationKey}`,
      maxCents: settings.maxWorkflowProviderCostCents,
      nowMs: currentNow,
      globalSpendLimitCents: settings.quotas.globalSpendLimitCents,
    }).catch(() => null);
    if (workflowSpend === null) return apiError(503, "SPEND_RECONCILIATION_REQUIRED", "CueBench could not persist the conservative workflow provider-cost reservation. No workflow was started or queued.", { retrySafe: true, stateChanged: true, nextAction: "wait-for-status" });
    if (!workflowSpend.accepted) return quotaFailure("GLOBAL_BREAKER", { stateChanged: authoritativeStateChanged });
    const workflowSpendStateChanged = !workflowSpend.existing;
    if (record.state === "workflow-starting" && workflow.get !== undefined) {
      const status = await workflow.get({ id: workflowId }).catch(() => "unknown" as const);
      if (status === "started") {
        const reconciled = await coordinator.reconcileQueued({ nowMs: currentNow }).catch(() => null);
        if (recordMatchesReceipt(reconciled, receipt)) return context.json({ operationReceipt: receiptToken, status: reconciled.state }, 200);
      }
    }
    const workflowClaim = await coordinator.claimWorkflowStart({ nowMs: currentNow, leaseMs: settings.partLeaseMs, createId: () => createId(dependencies) }).catch(() => null);
    if (workflowClaim === null) return apiError(503, "WORKFLOW_COORDINATION_UNAVAILABLE", "CueBench could not safely claim this private workflow start.", { retrySafe: true, stateChanged: authoritativeStateChanged || workflowSpendStateChanged, nextAction: "retry" });
    if (workflowClaim.kind === "status") {
      if (workflowClaim.record.state === "queued" || workflowClaim.record.state === "completed") return context.json({ operationReceipt: receiptToken, status: workflowClaim.record.state }, 200);
      return apiError(503, "WORKFLOW_RECONCILIATION_REQUIRED", "CueBench is reconciling the deterministic workflow start for this private upload. Do not start another workflow.", { retrySafe: true, stateChanged: authoritativeStateChanged || workflowSpendStateChanged, nextAction: "wait-for-status" });
    }
    let workflowResult: { readonly spendCents?: number } | void;
    try {
      workflowResult = await workflow.start({ id: workflowId, receipt: receiptToken, objectKey: receipt.objectKey });
    } catch {
      if (workflow.get !== undefined && await workflow.get({ id: workflowId }).catch(() => "unknown" as const) === "started") {
        const queued = await coordinator.reconcileQueued({ nowMs: currentNow, claimId: workflowClaim.claim.id, claimGeneration: workflowClaim.claim.generation }).catch(() => null);
        if (recordMatchesReceipt(queued, receipt)) return context.json({ operationReceipt: receiptToken, status: queued.state }, 200);
      }
      return apiError(503, "WORKFLOW_RECONCILIATION_REQUIRED", "CueBench issued a deterministic workflow start but could not confirm it. Keep this receipt; do not start another workflow.", { retrySafe: true, stateChanged: true, nextAction: "wait-for-status" });
    }
    const reportedSpendCents = typeof workflowResult === "object" && workflowResult !== null && typeof workflowResult.spendCents === "number"
      ? workflowResult.spendCents
      : undefined;
    if (reportedSpendCents !== undefined) {
      const settled = await quotaLedger.finalizeSpend({ spendKey: `workflow:${receipt.operationKey}`, actualCents: reportedSpendCents, nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents }).catch(() => null);
      if (settled === null || !settled.persisted) return apiError(503, "SPEND_RECONCILIATION_REQUIRED", "CueBench started deterministic processing but could not persist its provider-spend settlement. Keep this receipt; its workflow is not yet marked queued.", { retrySafe: true, stateChanged: true, nextAction: "wait-for-status" });
    }
    const queued = await coordinator.markQueued({ nowMs: currentNow, claimId: workflowClaim.claim.id, claimGeneration: workflowClaim.claim.generation }).catch(() => null);
    if (!recordMatchesReceipt(queued, receipt)) return apiError(503, "WORKFLOW_RECONCILIATION_REQUIRED", "CueBench started the deterministic private workflow but could not persist its receipt status. Keep this receipt; do not start another workflow.", { retrySafe: true, stateChanged: true, nextAction: "wait-for-status" });
    recordTelemetry(dependencies.telemetry, { stage: "processing", durationMs: receipt.media.durationMs, byteSize: receipt.media.byteLength, status: "queued" });
    return context.json({ operationReceipt: receiptToken, status: "queued" }, 202);
  });

  app.delete("/api/uploads/:operationId", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try {
      settings = resolveWorkerSettings(env);
    } catch {
      return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench processing is not configured for this environment.", { retrySafe: true, nextAction: "retry" });
    }
    const operationId = context.req.param("operationId");
    const sessionToken = bearerToken(context.req.raw);
    const receiptToken = context.req.header("x-cuebench-operation-receipt");
    if (!opaqueId(operationId) || sessionToken === null || receiptToken === undefined) return apiError(401, "UPLOAD_RECEIPT_REQUIRED", "CueBench needs the anonymous session and signed operation receipt.", { nextAction: "resume-upload" });
    const authenticated = await resolveAuthenticatedOperation({ sessionToken, receiptToken, ownerCapability: context.req.header("x-cuebench-project-owner"), settings, nowMs: currentNow, requireUploadPurpose: false });
    if (authenticated instanceof Response) return authenticated;
    const { receipt } = authenticated;
    if (receipt.operationId !== operationId) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different operation.", { nextAction: "start-new-operation" });
    const coordinator = uploadCoordinatorFor(env, dependencies, receipt.operationKey);
    const objectStore = objectStoreFor(env, dependencies);
    const quotaLedger = quotaLedgerFor(env, dependencies);
    if (coordinator === undefined || objectStore === undefined || quotaLedger === undefined) return apiError(503, "CLEANUP_UNAVAILABLE", "CueBench could not request immediate private-copy cleanup right now.", { retrySafe: true, nextAction: "retry-cleanup" });
    const record = await coordinator.get(currentNow).catch(() => null);
    if (!recordMatchesReceipt(record, receipt)) return apiError(410, "UPLOAD_EXPIRED", "This private upload operation is no longer available. Start a new operation.", { nextAction: "start-new-operation" });
    if (record.state === "queued" || record.state === "completed" || record.state === "workflow-starting") return apiError(409, "PROCESSING_ALREADY_STARTED", "CueBench cannot cancel this private copy because deterministic processing has already started.", { nextAction: "wait-for-status" });
    if (record.state === "cancelled") return new Response(null, { status: 204 });
    const cleanup = await cleanupOperation({
      record,
      objectStore,
      coordinator,
      quotaLedger,
      nowMs: currentNow,
      createId: () => createId(dependencies),
      target: {
        objectState: record.state === "probing" || record.state === "ready"
          ? "completed"
          : record.state === "failed-retryable" || record.state === "completing"
            ? "uncertain"
            : "multipart",
        multipartUploadId: record.multipartUploadId,
        reason: "user-cancel",
      },
    });
    if (!cleanup.clean) return apiError(409, "CLEANUP_RECONCILIATION_REQUIRED", "CueBench could not confirm every private-copy cleanup acknowledgement. Keep the receipt and retry cleanup.", { retrySafe: true, stateChanged: cleanup.stateChanged, nextAction: "retry-cleanup" });
    recordTelemetry(dependencies.telemetry, { stage: "cleanup", byteSize: receipt.media.byteLength, status: "deleted" });
    return new Response(null, { status: 204 });
  });

  app.notFound(async (context) => {
    if (env.ASSETS !== undefined && context.req.method === "GET") return env.ASSETS.fetch(context.req.raw);
    return apiError(404, "NOT_FOUND", "CueBench could not find that route.", { nextAction: "start-new-operation" });
  });

  return app;
};

const worker = {
  fetch: async (request: Request, env: WorkerEnv): Promise<Response> => createCueBenchWorker(env).fetch(request, env),
};

export default worker;
