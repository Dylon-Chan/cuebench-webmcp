import {
  GenerationRunStatusSchema,
  StagedGenerationResultSchema,
  type Actor,
  type GenerationRunStatus,
} from "@cuebench/contracts";
import type { CaptionProject, CommandResult, DomainCommand } from "@cuebench/domain";
import type { CloudUploadFetch, PersistedCloudUploadRecovery } from "../project/cloud-upload";
import type { CaptionGenerationAdoptionCommand } from "../project/project-store";

const aiActor = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const humanActor = { type: "Human" as const, id: "human" };
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const sha256 = /^[0-9a-f]{64}$/i;
const maxGenerationRetentionMs = 24 * 60 * 60 * 1_000;

/** Keep an agent cancellation out of every pre-commit durable boundary. */
export const throwIfGenerationAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted !== true) return;
  const error = new Error("CueBench generation request was cancelled before its next durable boundary.");
  error.name = "AbortError";
  throw error;
};

/**
 * The browser commits this state in the same Dexie transaction as adoption.
 * A transient acknowledgement outage therefore remains recoverable after the
 * target-track lease is released and after a browser reload.
 */
export interface GenerationReceiptAdoption {
  readonly status: "adopted";
  readonly adoptedProjectRevision: number;
  readonly localEvidencePackageId: string;
  /** `lifecycle-pending` means the bounded R2 rule, not an exact delete, owns expiry cleanup. */
  readonly cleanupAcknowledgement: "pending" | "acknowledged" | "lifecycle-pending";
}

/**
 * A terminal cancellation keeps its browser recovery capability until the
 * Worker has durably finished deleting the exact private artifact inventory.
 * Unlike adoption, this does not create project evidence; it only prevents a
 * cancelled run from becoming an unrecoverable cleanup tombstone on reload.
 */
export interface GenerationReceiptTerminalCleanup {
  readonly action: "cancelled";
  /** `lifecycle-pending` never claims exact deletion completed. */
  readonly cleanupAcknowledgement: "pending" | "acknowledged" | "lifecycle-pending";
  /** Separate from remote R2 cleanup: a tab can crash between these writes. */
  readonly localLeaseRelease: "pending" | "released";
}

/**
 * Write-ahead marker for an authenticated cancellation request. It is saved
 * before DELETE so a tab crash after the Worker accepts cancellation cannot
 * strand the matching local target-track lease without a retry capability.
 */
export interface GenerationReceiptCancellationIntent {
  readonly status: "requested";
}

/**
 * A signed receipt/session has elapsed before the browser can authenticate a
 * final server action. The result can never be adopted with that capability,
 * so the local caption lease is released while the private lifecycle backstop
 * remains truthfully visible rather than being claimed as an exact deletion.
 */
export interface GenerationReceiptExpirySettlement {
  readonly state: "lifecycle-pending";
  readonly disposition: "receipt-expired" | "cancellation-unconfirmed";
  readonly localLeaseRelease: "pending" | "released";
}

/**
 * Private write-ahead identity retained before a potentially durable start
 * POST. It lets a project deletion win the browser race without ever
 * restoring the deleted project merely to persist a late signed receipt.
 */
export interface PendingGenerationStartReservation {
  readonly projectId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly projectOwnerCapability: string;
  readonly mediaSha256: string;
  readonly sourceDurationMs: number;
}

/** A parsed start response is offered to the durable deletion receipt before normal receipt persistence. */
export interface DeletedGenerationStartRecovery {
  readonly projectId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly projectOwnerCapability: string;
  readonly receipt: unknown;
}

export interface GenerationClientReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string;
  /** Opaque Worker-signed bearer, retained in Dexie and never displayed. */
  readonly signedGenerationReceipt: string;
  /** Same anonymous owner session required alongside the signed capability. */
  readonly session: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  /** Stable non-portable browser-project owner secret required for every run. */
  readonly projectOwnerCapability: string;
  /** Worker-attested expiry from the signed generation receipt claims. */
  readonly retentionExpiresAtMs: number;
  readonly savedAtMs: number;
  /** Present only after the canonical local adoption transaction commits. */
  readonly adoption?: GenerationReceiptAdoption;
  /** Present after the browser asks to cancel, before Worker cleanup is known. */
  readonly cancellationRequested?: GenerationReceiptCancellationIntent;
  /** Present after cancellation is accepted by the authenticated Worker. */
  readonly terminalCleanup?: GenerationReceiptTerminalCleanup;
  /** Present when the signed owner capability elapsed before a terminal ACK. */
  readonly expirySettlement?: GenerationReceiptExpirySettlement;
}

export interface GenerationProjectStore {
  readonly getSnapshot: () => { readonly project: CaptionProject | null; readonly mode?: "durable" | "temporary" | null };
  /** Optional project-instance owner prevents queued lifecycle commands crossing an import/replacement boundary. */
  readonly executeCommand: (command: DomainCommand, expectedProjectId?: string) => Promise<CommandResult>;
  /** This must complete before the browser starts polling an opaque receipt. */
  readonly persistCaptionGenerationReceipt: (runId: string, receipt: GenerationClientReceipt) => Promise<void>;
  /** Durable ProjectStore reserves a crash-safe slot before server dispatch. */
  readonly reserveCaptionGenerationReceipt?: (runId: string, reservation?: PendingGenerationStartReservation) => Promise<void>;
  /** Removes only an unfulfilled internal receipt reservation. */
  readonly releaseCaptionGenerationReceiptReservation?: (runId: string) => Promise<void>;
  /**
   * Returns true only when this exact start was deleted while its POST was in
   * flight. The store durably captures the signed run for exact cleanup and
   * the client must not persist it back into a removed project.
   */
  readonly reconcileDeletedCaptionGenerationStart?: (input: DeletedGenerationStartRecovery) => Promise<boolean>;
  readonly loadCaptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  /** Optional upgrade path for showing detached pending cleanup after reload. */
  readonly listCaptionGenerationReceiptRunIds?: () => Promise<readonly string[]>;
  /** Reads the current non-portable project-instance owner from IndexedDB. */
  readonly getCloudProjectOwnerCapability?: (projectId: string) => Promise<string | null>;
  readonly adoptStagedCaptionGenerationResult: (command: CaptionGenerationAdoptionCommand) => Promise<CommandResult>;
}

export interface GenerationClientErrorDetails {
  readonly code?: string;
  readonly status?: number;
  /** A run could exist server-side, so retain the local target-track lease. */
  readonly dispatchMayBeDurable?: boolean;
  /** A page adapter must surface this recoverable identity rather than claim no state changed. */
  readonly lifecycleOutcome?: GenerationLifecycleOutcome;
}

export interface GenerationLifecycleOutcome {
  readonly runId: string;
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly disposition: "accepted-unknown" | "lifecycle-pending";
  /** Distinguishes a retained start from a cancellation recovery receipt. */
  readonly operation?: "start" | "cancel";
  /** Never claim a known cancellation receipt is missing. */
  readonly receiptState?: "available" | "missing" | "expired";
}

export type GenerationLifecycleEvent =
  | { readonly phase: "lease-acquired"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "dispatch-uncertain"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "remote-start-accepted"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "receipt-persisted"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "lease-released"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "cancellation-intent-persisted"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" }
  | { readonly phase: "remote-cancelled"; readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" };

export interface GenerationLifecycleObserver {
  /** Called synchronously after a durable local or remote lifecycle effect begins. */
  readonly onLifecycleEvent?: ((event: GenerationLifecycleEvent) => void) | undefined;
}

export const notifyGenerationLifecycle = (observer: GenerationLifecycleObserver, event: GenerationLifecycleEvent): void => {
  try {
    observer.onLifecycleEvent?.(event);
  } catch {
    // A UI observer cannot roll back an already-durable receipt, lease, or
    // remote request. The caller will still return its typed lifecycle state.
  }
};

export const withGenerationLifecycleOutcome = (
  error: unknown,
  lifecycleOutcome: GenerationLifecycleOutcome,
): GenerationClientError => {
  if (error instanceof GenerationClientError) {
    return new GenerationClientError(error.message, { ...error.details, lifecycleOutcome });
  }
  // Keep a local adapter failure intelligible to Human recovery UI while
  // adding the typed identity that prevents an unsafe retry. This message is
  // never a hosted/provider body (those are normalized above).
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "CueBench generation lifecycle needs recovery before it can be retried.";
  return new GenerationClientError(message, { lifecycleOutcome });
};

export class GenerationClientError extends Error {
  public constructor(message: string, public readonly details: GenerationClientErrorDetails = {}) {
    super(message);
    this.name = "GenerationClientError";
  }
}

export interface StartCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly upload: Pick<PersistedCloudUploadRecovery, "operationId" | "session" | "operationReceipt" | "sourceByteLength" | "sourceSha256" | "durationMs" | "projectOwnerCapability">;
  /** An agent cancellation stops only before the next durable lifecycle edge. */
  readonly signal?: AbortSignal;
  /**
   * The browser-agent invocation signal only. Once a lease exists, a
   * registration-family replacement must never cancel the idempotent POST.
   */
  readonly postCommitSignal?: AbortSignal;
  readonly onLifecycleEvent?: GenerationLifecycleObserver["onLifecycleEvent"];
}

export interface StartedCaptionGeneration {
  readonly receipt: GenerationClientReceipt;
  readonly status: GenerationRunStatus;
}

export interface CancelCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly receipt: GenerationClientReceipt;
  /** Browser Agent cancellation remains BrowserAgent-attributed in the Court Record. */
  readonly actor?: Actor;
  /** An agent cancellation stops only before the cancellation-intent write. */
  readonly signal?: AbortSignal;
  /**
   * The browser-agent invocation signal only. Once the intent is durable,
   * the old active-run registration cannot cancel its own terminal DELETE.
   */
  readonly postCommitSignal?: AbortSignal;
  readonly onLifecycleEvent?: GenerationLifecycleObserver["onLifecycleEvent"];
}

export interface AdoptCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly receipt: GenerationClientReceipt;
  readonly confirmedProposedReplacement: boolean;
}

export interface CaptionGenerationClientPort {
  readonly start: (input: StartCaptionGenerationInput) => Promise<StartedCaptionGeneration>;
  readonly status: (receipt: GenerationClientReceipt, signal?: AbortSignal) => Promise<GenerationRunStatus>;
  readonly cancel: (input: CancelCaptionGenerationInput) => Promise<GenerationRunStatus>;
  readonly adopt: (input: AdoptCaptionGenerationInput) => Promise<CommandResult>;
  /** Idempotently retries the authenticated cloud cleanup after local adoption. */
  /** Returns the exact persisted settlement; callers must not synthesize an acknowledgement. */
  readonly retryAdoptionCleanup: (input: Pick<AdoptCaptionGenerationInput, "store" | "receipt">) => Promise<GenerationClientReceipt>;
  /** Retries a cancellation tombstone without releasing its local lease early. */
  readonly retryCancellationCleanup: (input: CancelCaptionGenerationInput) => Promise<void>;
  readonly loadStoredReceipt: (store: GenerationProjectStore, project: CaptionProject, runId: string) => Promise<GenerationClientReceipt | null>;
  /** Read-only validation for inspectors; unlike loadStoredReceipt it never settles expiry or releases a lease. */
  readonly peekStoredReceipt?: (store: GenerationProjectStore, project: CaptionProject, runId: string) => Promise<GenerationClientReceipt | null>;
}

export interface CaptionGenerationClientOptions {
  readonly fetcher?: CloudUploadFetch;
  readonly createRunId?: () => string;
  readonly clock?: () => number;
}

const defaultFetcher = (): CloudUploadFetch => {
  if (typeof globalThis.fetch !== "function") throw new GenerationClientError("Caption generation is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const responseError = async (response: Response, fallback: string): Promise<GenerationClientError> => {
  try {
    const body = await response.json() as { readonly error?: Readonly<Record<string, unknown>> };
    const error = body.error;
    if (typeof error?.message === "string" && error.message.trim().length > 0) {
      const code = typeof error.code === "string" ? error.code : undefined;
      return new GenerationClientError(error.message, {
        status: response.status,
        ...(code === undefined ? {} : { code }),
        ...(["GENERATION_DISPATCH_PENDING", "GENERATION_RECORD_UNCERTAIN", "GENERATION_LEASE_UNCERTAIN"].includes(code ?? "") ? { dispatchMayBeDurable: true } : {}),
      });
    }
  } catch {
    // Do not surface an untrusted gateway body: it may include private context.
  }
  return new GenerationClientError(fallback, { status: response.status });
};

const responseRecord = (value: unknown, fallback: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GenerationClientError(fallback);
  return value as Readonly<Record<string, unknown>>;
};

const parseStatus = (value: unknown): GenerationRunStatus => {
  const parsed = GenerationRunStatusSchema.safeParse(value);
  if (!parsed.success) throw new GenerationClientError("CueBench received an invalid caption-generation status.");
  return parsed.data;
};

const requireUploadAuthorization = (upload: StartCaptionGenerationInput["upload"], project: CaptionProject): { readonly session: string; readonly operationReceipt: string; readonly sourceByteLength: number; readonly sourceDurationMs: number; readonly projectOwnerCapability: string } => {
  if (
    typeof upload.session !== "string" || upload.session.trim().length === 0
    || typeof upload.operationReceipt !== "string" || upload.operationReceipt.trim().length === 0
    || !Number.isSafeInteger(upload.sourceByteLength) || upload.sourceByteLength <= 0
    || !Number.isSafeInteger(upload.durationMs) || upload.durationMs <= 0
    || typeof upload.sourceSha256 !== "string" || !sha256.test(upload.sourceSha256)
    || upload.sourceSha256.toLowerCase() !== project.media.sha256.toLowerCase()
    || upload.durationMs !== project.media.durationMs
    || typeof upload.projectOwnerCapability !== "string" || !/^[0-9a-f]{64}$/i.test(upload.projectOwnerCapability)
  ) {
    throw new GenerationClientError("Complete or refresh optional cloud processing before starting caption generation.");
  }
  return {
    session: upload.session,
    operationReceipt: upload.operationReceipt,
    sourceByteLength: upload.sourceByteLength,
    sourceDurationMs: upload.durationMs,
    projectOwnerCapability: upload.projectOwnerCapability.toLowerCase(),
  };
};

const parseStart = (
  value: unknown,
  project: CaptionProject,
  expectedProjectRevision: number,
  runId: string,
  savedAtMs: number,
  authorization: { readonly session: string; readonly sourceByteLength: number; readonly sourceDurationMs: number; readonly projectOwnerCapability: string },
): StartedCaptionGeneration => {
  const record = responseRecord(value, "CueBench did not return a signed caption-generation receipt.");
  if (typeof record.generationRunReceipt !== "string" || record.generationRunReceipt.trim().length === 0) {
    throw new GenerationClientError("CueBench did not return a signed caption-generation receipt.");
  }
  if (
    !Number.isSafeInteger(record.retentionExpiresAtMs)
    || (record.retentionExpiresAtMs as number) <= savedAtMs
    || (record.retentionExpiresAtMs as number) > savedAtMs + maxGenerationRetentionMs
  ) throw new GenerationClientError("CueBench did not return a bounded private-retention deadline for this caption run.");
  const status = parseStatus(record.status);
  if (
    status.runId !== runId
    || status.projectId !== project.projectId
    || status.targetTrack !== "Captions"
    || status.expectedProjectRevision !== expectedProjectRevision
  ) throw new GenerationClientError("CueBench returned a caption-generation receipt for different project evidence.");
  return {
    receipt: {
      version: 1,
      runId,
      projectId: project.projectId,
      signedGenerationReceipt: record.generationRunReceipt,
      session: authorization.session,
      expectedProjectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      mediaSha256: project.media.sha256.toLowerCase(),
      sourceByteLength: authorization.sourceByteLength,
      sourceDurationMs: authorization.sourceDurationMs,
      projectOwnerCapability: authorization.projectOwnerCapability,
      retentionExpiresAtMs: record.retentionExpiresAtMs as number,
      savedAtMs,
    },
    status,
  };
};

const isMatchingCaptionLease = (project: CaptionProject, runId: string): boolean => (
  project.activeGenerationRun?.runId === runId && project.activeGenerationRun.targetTrack === "Captions"
);

const captionLeaseBase = (project: CaptionProject, runId: string) => {
  const lease = project.activeGenerationRun;
  if (!isMatchingCaptionLease(project, runId) || lease?.base === undefined) {
    throw new GenerationClientError("This caption-generation lease cannot safely adopt after recovery. Discard it before starting a new run.", { code: "STALE_RUN" });
  }
  return lease.base;
};

const parsedAdoption = (value: unknown): GenerationReceiptAdoption | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const adoption = value as Readonly<Record<string, unknown>>;
  return adoption.status === "adopted"
    && Number.isSafeInteger(adoption.adoptedProjectRevision)
    && (adoption.adoptedProjectRevision as number) > 0
    && typeof adoption.localEvidencePackageId === "string"
    && opaqueId.test(adoption.localEvidencePackageId)
    && (adoption.cleanupAcknowledgement === "pending" || adoption.cleanupAcknowledgement === "acknowledged" || adoption.cleanupAcknowledgement === "lifecycle-pending")
    ? {
      status: "adopted",
      adoptedProjectRevision: adoption.adoptedProjectRevision as number,
      localEvidencePackageId: adoption.localEvidencePackageId,
      cleanupAcknowledgement: adoption.cleanupAcknowledgement,
    }
    : null;
};

const parsedExpirySettlement = (value: unknown): GenerationReceiptExpirySettlement | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settlement = value as Readonly<Record<string, unknown>>;
  return settlement.state === "lifecycle-pending"
    && (settlement.disposition === "receipt-expired" || settlement.disposition === "cancellation-unconfirmed")
    && (settlement.localLeaseRelease === "pending" || settlement.localLeaseRelease === "released")
    ? {
      state: "lifecycle-pending",
      disposition: settlement.disposition,
      localLeaseRelease: settlement.localLeaseRelease,
    }
    : null;
};

const parsedTerminalCleanup = (value: unknown): GenerationReceiptTerminalCleanup | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const cleanup = value as Readonly<Record<string, unknown>>;
  return cleanup.action === "cancelled"
    && (cleanup.cleanupAcknowledgement === "pending" || cleanup.cleanupAcknowledgement === "acknowledged" || cleanup.cleanupAcknowledgement === "lifecycle-pending")
    && (cleanup.localLeaseRelease === undefined || cleanup.localLeaseRelease === "pending" || cleanup.localLeaseRelease === "released")
    ? {
      action: "cancelled",
      cleanupAcknowledgement: cleanup.cleanupAcknowledgement,
      // Receipts persisted by the first durable cleanup deployment did not
      // distinguish cloud acknowledgement from local lease release. Treat
      // those as safely retryable rather than strand an existing project.
      localLeaseRelease: cleanup.localLeaseRelease === "released" ? "released" : "pending",
    }
    : null;
};

const parsedCancellationIntent = (value: unknown): GenerationReceiptCancellationIntent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return (value as Readonly<Record<string, unknown>>).status === "requested"
    ? { status: "requested" }
    : null;
};

const terminalCleanupState = (
  value: unknown,
  action: "adopted" | "cancelled",
): "pending" | "completed" => {
  const cleanup = responseRecord(value, "CueBench did not return a durable private-media cleanup state.");
  if (
    cleanup.version !== 1
    || cleanup.action !== action
    || (cleanup.state !== "pending" && cleanup.state !== "completed")
  ) throw new GenerationClientError("CueBench returned an invalid private-media cleanup state.");
  return cleanup.state;
};

/**
 * Browser-side boundary for the opaque same-origin API. It deliberately does
 * not call a provider or hold a media Blob: all provider work remains inside
 * the durable Cloudflare Workflow.
 */
export class CaptionGenerationClient implements CaptionGenerationClientPort {
  private readonly fetcher: CloudUploadFetch;
  private readonly createRunId: () => string;
  private readonly clock: () => number;

  public constructor(options: CaptionGenerationClientOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher();
    this.createRunId = options.createRunId ?? (() => globalThis.crypto.randomUUID());
    this.clock = options.clock ?? Date.now;
  }

  public async start(input: StartCaptionGenerationInput): Promise<StartedCaptionGeneration> {
    throwIfGenerationAborted(input.signal);
    const snapshot = input.store.getSnapshot();
    if (snapshot.mode === "temporary") {
      throw new GenerationClientError("Caption generation needs durable browser storage before CueBench can acquire a recoverable target-track lease.", { code: "DURABLE_STORAGE_REQUIRED" });
    }
    const authorization = requireUploadAuthorization(input.upload, input.project);
    const visibleProject = snapshot.project;
    if (visibleProject === null || visibleProject.projectId !== input.project.projectId) {
      throw new GenerationClientError("CueBench project identity changed before caption generation could start.");
    }
    let leasedProject = visibleProject;
    let runId: string;
    const receiptSlotReserved = input.store.reserveCaptionGenerationReceipt !== undefined;
    if (leasedProject.activeGenerationRun === null) {
      runId = this.createRunId();
      if (!opaqueId.test(runId)) throw new GenerationClientError("CueBench generated an invalid caption-generation run identifier.");
      await input.store.reserveCaptionGenerationReceipt?.(runId, {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "Captions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        mediaSha256: leasedProject.media.sha256,
        sourceDurationMs: authorization.sourceDurationMs,
      });
      try {
        throwIfGenerationAborted(input.signal);
      } catch (error) {
        if (receiptSlotReserved) {
          try { await input.store.releaseCaptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
        throw error;
      }
      const lease = await input.store.executeCommand({
        type: "StartGenerationRun",
        actor: aiActor,
        runId,
        targetTrack: "Captions",
        expectedProjectRevision: leasedProject.projectRevision,
      }, input.project.projectId);
      if (lease.error !== undefined) {
        if (receiptSlotReserved) await input.store.releaseCaptionGenerationReceiptReservation?.(runId);
        throw new GenerationClientError(lease.error.message, { code: lease.error.code });
      }
      leasedProject = lease.project;
      notifyGenerationLifecycle(input, { phase: "lease-acquired", runId, targetTrack: "Captions" });
    } else if (isMatchingCaptionLease(leasedProject, leasedProject.activeGenerationRun.runId)) {
      runId = leasedProject.activeGenerationRun.runId;
      await input.store.reserveCaptionGenerationReceipt?.(runId, {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "Captions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        mediaSha256: leasedProject.media.sha256,
        sourceDurationMs: authorization.sourceDurationMs,
      });
      try {
        throwIfGenerationAborted(input.signal);
      } catch (error) {
        if (receiptSlotReserved) {
          try { await input.store.releaseCaptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
        throw error;
      }
    } else {
      throw new GenerationClientError("A different generation run currently holds CueBench's target-track lease.", { code: "TARGET_TRACK_LEASE_CONFLICT" });
    }
    // A retry may happen after permitted Audio Description edits have advanced
    // the global project revision. The signed server idempotency tuple must
    // remain the immutable caption lease base, never a later whole-project
    // revision that would turn a safe retry into an identity conflict.
    const leaseBase = captionLeaseBase(leasedProject, runId);

    let durableStartMayExist = false;
    try {
      // StartGenerationRun is the first durable edge. Its Browser Agent
      // callback synchronously replaces the starter family, which aborts the
      // group signal that started this operation. From here, use only the
      // caller's invocation signal: the idempotent POST must not self-cancel.
      const response = await this.fetcher("/api/generation-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization.session}`,
          "content-type": "application/json",
          "x-cuebench-operation-receipt": authorization.operationReceipt,
          "x-cuebench-project-owner": authorization.projectOwnerCapability,
        },
        ...(input.postCommitSignal === undefined ? {} : { signal: input.postCommitSignal }),
        body: JSON.stringify({
          projectId: leasedProject.projectId,
          runId,
          expectedProjectRevision: leaseBase.expectedProjectRevision,
          expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
          mediaSha256: leaseBase.mediaSha256,
          sourceByteLength: authorization.sourceByteLength,
          sourceDurationMs: authorization.sourceDurationMs,
          qualityProfileRules: leasedProject.qualityProfile.rules,
        }),
      });
      if (!response.ok) throw await responseError(response, "CueBench could not start a recoverable caption-generation run.");
      // A successful HTTP response means the Worker has already persisted its
      // private record. Retain the local lease even if a hostile/corrupt body
      // cannot be parsed or IndexedDB fails before saving the browser receipt.
      durableStartMayExist = true;
      notifyGenerationLifecycle(input, { phase: "remote-start-accepted", runId, targetTrack: "Captions" });
      const started = parseStart(await response.json(), leasedProject, leaseBase.expectedProjectRevision, runId, this.clock(), authorization);
      const deletedStartRecovery = {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "Captions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        receipt: started.receipt,
      } as const;
      const projectDeletedDuringStart = () => new GenerationClientError("This local project was deleted while CueBench started the caption run. CueBench retained the exact run for private cleanup.", {
          code: "PROJECT_DELETED_DURING_START",
          lifecycleOutcome: {
            runId,
            targetTrack: "Captions",
            disposition: "lifecycle-pending",
            operation: "start",
            receiptState: "available",
          },
        });
      if (await input.store.reconcileDeletedCaptionGenerationStart?.(deletedStartRecovery)) throw projectDeletedDuringStart();
      // This await is intentionally before returning to UI polling. If a tab
      // closes immediately after start, the signed capability still recovers.
      try {
        await input.store.persistCaptionGenerationReceipt(runId, started.receipt);
      } catch (persistenceError) {
        // Deletion can win after the first read above but before its queued
        // IndexedDB receipt write. Re-read the exact write-ahead intent with
        // the signed response before surfacing a storage error; otherwise the
        // browser would retain a hosted run only until the 24-hour backstop.
        if (await input.store.reconcileDeletedCaptionGenerationStart?.(deletedStartRecovery)) {
          throw projectDeletedDuringStart();
        }
        throw persistenceError;
      }
      notifyGenerationLifecycle(input, { phase: "receipt-persisted", runId, targetTrack: "Captions" });
      return started;
    } catch (error) {
      const current = input.store.getSnapshot().project;
      const clientError = error instanceof GenerationClientError ? error : null;
      // A transport failure or explicit dispatch-pending response is ambiguous:
      // retain the lease so the same run id can be retried instead of racing a
      // server-side Workflow that already holds its signed receipt.
      const ambiguous = durableStartMayExist || clientError === null || clientError.details.dispatchMayBeDurable === true;
      if (ambiguous) notifyGenerationLifecycle(input, { phase: "dispatch-uncertain", runId, targetTrack: "Captions" });
      if (!ambiguous && current !== null && isMatchingCaptionLease(current, runId)) {
        const released = await input.store.executeCommand({
          type: "ReleaseGenerationRun",
          actor: aiActor,
          runId,
          expectedProjectRevision: current.projectRevision,
        }, input.project.projectId).catch(() => null);
        if (released?.error === undefined) notifyGenerationLifecycle(input, { phase: "lease-released", runId, targetTrack: "Captions" });
        if (receiptSlotReserved) {
          try { await input.store.releaseCaptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
      }
      const retained = input.store.getSnapshot().project;
      if (retained !== null && isMatchingCaptionLease(retained, runId)) {
        throw withGenerationLifecycleOutcome(error, {
          runId,
          targetTrack: "Captions",
          disposition: ambiguous ? "accepted-unknown" : "lifecycle-pending",
          operation: "start",
          receiptState: "missing",
        });
      }
      throw error;
    }
  }

  public async status(receipt: GenerationClientReceipt, signal?: AbortSignal): Promise<GenerationRunStatus> {
    throwIfGenerationAborted(signal);
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(receipt.runId)}`, {
      headers: {
      authorization: `Bearer ${receipt.session}`,
      "x-cuebench-generation-receipt": receipt.signedGenerationReceipt,
      "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not read caption-generation status.");
    const record = responseRecord(await response.json(), "CueBench did not return caption-generation status.");
    const status = parseStatus(record.status);
    if (status.runId !== receipt.runId || status.projectId !== receipt.projectId || status.expectedProjectRevision !== receipt.expectedProjectRevision) {
      throw new GenerationClientError("CueBench returned status for different caption-generation evidence.");
    }
    return status;
  }

  private async requestCancellation(receipt: GenerationClientReceipt, signal?: AbortSignal): Promise<{
    readonly status: GenerationRunStatus;
    readonly cleanup: "pending" | "completed";
  }> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(receipt.runId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "x-cuebench-generation-receipt": receipt.signedGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not cancel this caption-generation run.");
    const record = responseRecord(await response.json(), "CueBench did not confirm caption-generation cancellation.");
    const status = parseStatus(record.status);
    if (status.stage !== "Cancelled" || status.runId !== receipt.runId || status.projectId !== receipt.projectId) {
      throw new GenerationClientError("CueBench did not confirm cancellation of this caption-generation run.");
    }
    return { status, cleanup: terminalCleanupState(record.cleanup, "cancelled") };
  }

  private async persistCancellationIntent(
    store: GenerationProjectStore,
    receipt: GenerationClientReceipt,
  ): Promise<GenerationClientReceipt> {
    if (receipt.cancellationRequested?.status === "requested") return receipt;
    const requested: GenerationClientReceipt = {
      ...receipt,
      cancellationRequested: { status: "requested" },
    };
    // This write intentionally precedes the authenticated DELETE. A later
    // response/persistence crash can therefore reload a bounded capability
    // and repeat the idempotent terminal request instead of stranding a lease.
    await store.persistCaptionGenerationReceipt(receipt.runId, requested);
    return requested;
  }

  private async persistCancellationCleanup(
    store: GenerationProjectStore,
    receipt: GenerationClientReceipt,
    cleanup: "pending" | "completed",
  ): Promise<GenerationClientReceipt> {
    const withoutCancellationIntent = { ...receipt };
    delete withoutCancellationIntent.cancellationRequested;
    const next: GenerationClientReceipt = {
      ...withoutCancellationIntent,
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: cleanup === "completed" ? "acknowledged" : "pending",
        localLeaseRelease: receipt.terminalCleanup?.localLeaseRelease ?? "pending",
      },
    };
    await store.persistCaptionGenerationReceipt(receipt.runId, next);
    return next;
  }

  private async completeCancellationRequest(
    input: CancelCaptionGenerationInput,
    receipt: GenerationClientReceipt,
  ): Promise<{
    readonly status: GenerationRunStatus;
    readonly cleanup: "pending" | "completed";
  }> {
    // Persisting cancellation intent is the first durable edge. The active
    // run family may be replaced synchronously after that write, so only an
    // explicit invocation cancellation may reach the idempotent DELETE.
    const remote = await this.requestCancellation(receipt, input.postCommitSignal);
    notifyGenerationLifecycle(input, { phase: "remote-cancelled", runId: receipt.runId, targetTrack: "Captions" });
    // This write is intentionally before local lease release. A pending
    // cleanup response is a durable capability to retry, not a successful
    // cancellation completion that can be forgotten after a reload.
    const persisted = await this.persistCancellationCleanup(input.store, receipt, remote.cleanup);
    // Server-side Cancelled is the authoritative terminal fence. Browser
    // editability must not be held hostage by an independent private-object
    // drain; its pending receipt remains visible and retryable after release.
    await this.settleCancelledCaptionLease(input.store, persisted, input.actor ?? humanActor);
    return remote;
  }

  /** Release only the matching target lease; remote terminal/expiry state is persisted first. */
  private async releaseCaptionLease(
    store: GenerationProjectStore,
    runId: string,
    actor: Actor = humanActor,
  ): Promise<void> {
    const current = store.getSnapshot().project;
    if (current !== null && isMatchingCaptionLease(current, runId)) {
      const released = await store.executeCommand({
        type: "ReleaseGenerationRun",
        // Preserve the caller that initiated this exact cancellation: ordinary
        // UI cleanup is Human, while a WebMCP request remains BrowserAgent in
        // the Court Record instead of being silently re-attributed.
        actor,
        runId,
        expectedProjectRevision: current.projectRevision,
      }, current.projectId);
      if (released.error !== undefined && released.error.code !== "STALE_RUN") {
        throw new GenerationClientError("CueBench confirmed cloud cancellation, but the local target-track lease needs recovery before it can be released.", { code: released.error.code });
      }
    }
  }

  private async markCancellationLifecyclePending(
    store: GenerationProjectStore,
    receipt: GenerationClientReceipt,
  ): Promise<GenerationClientReceipt> {
    const terminal = receipt.terminalCleanup;
    if (terminal?.action !== "cancelled") {
      throw new GenerationClientError("CueBench cannot use lifecycle recovery before cancellation is durably recorded.");
    }
    const lifecyclePending: GenerationClientReceipt = {
      ...receipt,
      terminalCleanup: {
        ...terminal,
        // The R2 rule is a retention backstop, not an exact-delete receipt.
        // Preserve that distinction in browser-canonical recovery state.
        cleanupAcknowledgement: "lifecycle-pending",
      },
    };
    await store.persistCaptionGenerationReceipt(receipt.runId, lifecyclePending);
    return lifecyclePending;
  }

  private async settleCancelledCaptionLease(
    store: GenerationProjectStore,
    receipt: GenerationClientReceipt,
    actor: Actor = humanActor,
  ): Promise<GenerationClientReceipt> {
    const terminal = receipt.terminalCleanup;
    if (terminal?.action !== "cancelled") {
      throw new GenerationClientError("CueBench cannot release a caption lease before cancellation cleanup is durably recorded.");
    }
    if (terminal.localLeaseRelease === "released") return receipt;
    // Preserve `localLeaseRelease: pending` before invoking the project
    // command. If the tab closes after the cloud acknowledgement but before
    // this command, reload has an explicit safe, idempotent release path.
    await this.releaseCaptionLease(store, receipt.runId, actor);
    const settled: GenerationClientReceipt = {
      ...receipt,
      terminalCleanup: {
        ...terminal,
        localLeaseRelease: "released",
      },
    };
    await store.persistCaptionGenerationReceipt(receipt.runId, settled);
    return settled;
  }

  /**
   * Settles an elapsed owner capability without pretending that R2 has already
   * deleted every private object. At this point adoption/cancellation cannot
   * be authenticated with the expired capability; retaining the browser lease
   * would therefore create a permanent local lock.
   */
  private async settleExpiredReceipt(
    store: GenerationProjectStore,
    receipt: GenerationClientReceipt,
  ): Promise<GenerationClientReceipt> {
    const adoption = receipt.adoption;
    if (adoption?.cleanupAcknowledgement === "pending") {
      const lifecyclePending: GenerationClientReceipt = {
        ...receipt,
        adoption: { ...adoption, cleanupAcknowledgement: "lifecycle-pending" },
      };
      await store.persistCaptionGenerationReceipt(receipt.runId, lifecyclePending);
      return lifecyclePending;
    }
    const terminal = receipt.terminalCleanup;
    if (terminal?.action === "cancelled") {
      const lifecyclePending: GenerationClientReceipt = terminal.cleanupAcknowledgement === "lifecycle-pending"
        ? receipt
        : {
          ...receipt,
          terminalCleanup: { ...terminal, cleanupAcknowledgement: "lifecycle-pending" },
        };
      if (lifecyclePending !== receipt) {
        await store.persistCaptionGenerationReceipt(receipt.runId, lifecyclePending);
      }
      return this.settleCancelledCaptionLease(store, lifecyclePending);
    }

    const previous = receipt.expirySettlement;
    const pending: GenerationClientReceipt = previous?.localLeaseRelease === "released"
      ? receipt
      : {
        ...receipt,
        expirySettlement: {
          state: "lifecycle-pending",
          disposition: receipt.cancellationRequested?.status === "requested"
            ? "cancellation-unconfirmed"
            : "receipt-expired",
          localLeaseRelease: "pending",
        },
      };
    if (pending !== receipt) await store.persistCaptionGenerationReceipt(receipt.runId, pending);
    if (pending.expirySettlement?.localLeaseRelease === "released") return pending;
    // Persisted pending intent precedes the local command so a crash can
    // resume this exact lease release after reload.
    await this.releaseCaptionLease(store, receipt.runId);
    const settled: GenerationClientReceipt = {
      ...pending,
      expirySettlement: { ...pending.expirySettlement!, localLeaseRelease: "released" },
    };
    await store.persistCaptionGenerationReceipt(receipt.runId, settled);
    return settled;
  }

  public async cancel(input: CancelCaptionGenerationInput): Promise<GenerationRunStatus> {
    let intentCommitted = input.receipt.cancellationRequested?.status === "requested";
    try {
      throwIfGenerationAborted(input.signal);
      const requested = await this.persistCancellationIntent(input.store, input.receipt);
      intentCommitted = true;
      notifyGenerationLifecycle(input, { phase: "cancellation-intent-persisted", runId: requested.runId, targetTrack: "Captions" });
      return (await this.completeCancellationRequest(input, requested)).status;
    } catch (error) {
      // Before the write-ahead intent exists, an explicit browser-agent
      // cancellation is genuinely unchanged and must not masquerade as a
      // retained lifecycle operation.
      if (!intentCommitted && error instanceof Error && error.name === "AbortError") throw error;
      const current = input.store.getSnapshot().project;
      if (current !== null && isMatchingCaptionLease(current, input.receipt.runId)) {
        throw withGenerationLifecycleOutcome(error, {
          runId: input.receipt.runId,
          targetTrack: "Captions",
          disposition: "lifecycle-pending",
          operation: "cancel",
          receiptState: "available",
        });
      }
      throw error;
    }
  }

  public async retryCancellationCleanup(input: CancelCaptionGenerationInput): Promise<void> {
    const terminal = input.receipt.terminalCleanup;
    if (terminal?.action !== "cancelled") {
      if (input.receipt.cancellationRequested?.status !== "requested") {
        throw new GenerationClientError("CueBench cannot retry cancellation cleanup before cancellation is durably recorded in this browser.");
      }
      if (this.clock() >= input.receipt.retentionExpiresAtMs) {
        // An intent alone cannot prove remote cancellation. It does prove the
        // browser must retain a truthful lifecycle-pending tombstone; after
        // the owner capability elapsed it can no longer adopt anything, so do
        // not leave the target track permanently locked.
        await this.settleExpiredReceipt(input.store, input.receipt);
        return;
      }
      await this.completeCancellationRequest(input, input.receipt);
      return;
    }
    if (terminal.cleanupAcknowledgement === "acknowledged" || terminal.cleanupAcknowledgement === "lifecycle-pending") {
      await this.settleCancelledCaptionLease(input.store, input.receipt);
      return;
    }
    if (this.clock() >= input.receipt.retentionExpiresAtMs) {
      // Once this Worker-attested deadline passes, the signed session and run
      // receipt can no longer authenticate a retry. The original terminal
      // DELETE already fenced writes; release the browser lease while keeping
      // the outcome truthfully marked lifecycle-pending rather than claiming
      // an immediate R2 acknowledgement that cannot exist any more.
      const lifecyclePending = await this.markCancellationLifecyclePending(input.store, input.receipt);
      await this.settleCancelledCaptionLease(input.store, lifecyclePending);
      return;
    }
    const remote = await this.completeCancellationRequest(input, input.receipt);
    if (remote.cleanup !== "completed") {
      throw new GenerationClientError("CueBench is still draining a private media-preparation write before cancellation cleanup can complete.");
    }
  }

  /**
   * The browser's canonical Dexie transaction commits first. Once that has
   * happened, tell the private Worker that its short-lived rich artifacts can
   * be detached. An acknowledgement failure cannot be allowed to report a
   * failed adoption or invite a duplicate local adoption; the signed receipt
   * and server-side 24-hour retention policy keep the idempotent retry safe.
   */
  private async acknowledgeAdoption(receipt: GenerationClientReceipt, adoptedProjectRevision: number): Promise<void> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(receipt.runId)}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "content-type": "application/json",
        "x-cuebench-generation-receipt": receipt.signedGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not confirm private caption-generation cleanup.");
    const record = responseRecord(await response.json(), "CueBench did not confirm private caption-generation cleanup.");
    const status = parseStatus(record.status);
    if (
      status.stage !== "Completed"
      || status.runId !== receipt.runId
      || status.projectId !== receipt.projectId
      || status.expectedProjectRevision !== receipt.expectedProjectRevision
      || status.adoptedProjectRevision !== adoptedProjectRevision
    ) throw new GenerationClientError("CueBench returned an invalid caption-generation cleanup acknowledgement.");
    if (terminalCleanupState(record.cleanup, "adopted") !== "completed") {
      // The server has durably recorded adoption, but an in-flight scoped
      // preparation write is still draining. Keep the Dexie receipt pending
      // so reload/retry remains visible rather than falsely claiming private
      // R2 cleanup completed.
      throw new GenerationClientError("CueBench is still draining a private media-preparation write before cleanup can complete.");
    }
  }

  public async retryAdoptionCleanup(input: Pick<AdoptCaptionGenerationInput, "store" | "receipt">): Promise<GenerationClientReceipt> {
    const adoption = input.receipt.adoption;
    if (adoption === undefined || adoption.status !== "adopted") {
      throw new GenerationClientError("CueBench cannot retry cleanup before the local caption adoption has committed.");
    }
    if (this.clock() >= input.receipt.retentionExpiresAtMs) {
      return this.settleExpiredReceipt(input.store, input.receipt);
    }
    await this.acknowledgeAdoption(input.receipt, adoption.adoptedProjectRevision);
    const acknowledged: GenerationClientReceipt = {
      ...input.receipt,
      adoption: {
        ...adoption,
        cleanupAcknowledgement: "acknowledged",
      },
    };
    await input.store.persistCaptionGenerationReceipt(input.receipt.runId, acknowledged);
    return acknowledged;
  }

  public async adopt(input: AdoptCaptionGenerationInput): Promise<CommandResult> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(input.receipt.runId)}/staged-result`, {
      headers: {
        authorization: `Bearer ${input.receipt.session}`,
        "x-cuebench-generation-receipt": input.receipt.signedGenerationReceipt,
        "x-cuebench-project-owner": input.receipt.projectOwnerCapability,
      },
    });
    if (!response.ok) throw await responseError(response, "CueBench could not retrieve a complete staged caption result.");
    const record = responseRecord(await response.json(), "CueBench did not return a complete staged caption result.");
    const parsed = StagedGenerationResultSchema.safeParse(record.result);
    if (!parsed.success) throw new GenerationClientError("CueBench returned an invalid staged caption result.");
    const result = parsed.data;
    const base = captionLeaseBase(input.project, input.receipt.runId);
    if (
      result.runId !== input.receipt.runId
      || result.projectId !== input.project.projectId
      || result.expectedProjectRevision !== base.expectedProjectRevision
      || result.expectedQualityProfileRevision !== base.qualityProfileRevision
      || result.evidence.mediaSha256.toLowerCase() !== input.project.media.sha256.toLowerCase()
      || input.project.media.sha256.toLowerCase() !== base.mediaSha256
    ) throw new GenerationClientError("The staged caption result is stale for CueBench's current project evidence.", { code: "STALE_PROJECT" });
    const adopted = await input.store.adoptStagedCaptionGenerationResult({
      type: "AdoptCaptionGenerationResult",
      actor: aiActor,
      runId: input.receipt.runId,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      confirmedProposedReplacement: input.confirmedProposedReplacement,
      result,
    });
    if (adopted.error !== undefined) return adopted;
    const pendingReceipt: GenerationClientReceipt = {
      ...input.receipt,
      adoption: {
        status: "adopted",
        adoptedProjectRevision: adopted.project.projectRevision,
        localEvidencePackageId: `generation-${input.receipt.runId}`,
        cleanupAcknowledgement: "pending",
      },
    };
    try {
      // `adoptStagedCaptionGenerationResult` has already atomically marked
      // this pending in Dexie with the project mutation. Rewriting the same
      // bounded receipt here keeps alternate GenerationProjectStore ports
      // honest before any network acknowledgement can fail.
      await input.store.persistCaptionGenerationReceipt(input.receipt.runId, pendingReceipt);
      await this.retryAdoptionCleanup({ store: input.store, receipt: pendingReceipt });
    } catch {
      // The local adoption transaction already durably records a pending
      // acknowledgement. Do not turn that success into a duplicate-adoption
      // prompt; GenerationStatus discovers the pending receipt after reload.
    }
    return adopted;
  }

  public async peekStoredReceipt(store: GenerationProjectStore, project: CaptionProject, runId: string): Promise<GenerationClientReceipt | null> {
    const value = await store.loadCaptionGenerationReceipt(runId);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const receipt = value as Partial<GenerationClientReceipt>;
    const expectedProjectRevision = receipt.expectedProjectRevision;
    const expectedQualityProfileRevision = receipt.expectedQualityProfileRevision;
    const savedAtMs = receipt.savedAtMs;
    // Upgrade the first durable-generation receipt shape conservatively. It
    // had the same documented <=24h ceiling but no explicit deadline field;
    // retaining it through the full bound avoids pinning an old local lease.
    const retentionExpiresAtMs = receipt.retentionExpiresAtMs === undefined
      && typeof savedAtMs === "number" && Number.isSafeInteger(savedAtMs) && savedAtMs <= Number.MAX_SAFE_INTEGER - maxGenerationRetentionMs
      ? savedAtMs + maxGenerationRetentionMs
      : receipt.retentionExpiresAtMs;
    const adoption = receipt.adoption === undefined ? undefined : parsedAdoption(receipt.adoption);
    const cancellationRequested = receipt.cancellationRequested === undefined
      ? undefined
      : parsedCancellationIntent(receipt.cancellationRequested);
    const terminalCleanup = receipt.terminalCleanup === undefined ? undefined : parsedTerminalCleanup(receipt.terminalCleanup);
    const expirySettlement = receipt.expirySettlement === undefined ? undefined : parsedExpirySettlement(receipt.expirySettlement);
    if (
      receipt.version !== 1
      || receipt.runId !== runId
      || receipt.projectId !== project.projectId
      || typeof expectedProjectRevision !== "number" || !Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1
      || typeof expectedQualityProfileRevision !== "number" || !Number.isSafeInteger(expectedQualityProfileRevision) || expectedQualityProfileRevision < 1
      || typeof receipt.signedGenerationReceipt !== "string" || receipt.signedGenerationReceipt.length === 0
      || typeof receipt.session !== "string" || receipt.session.length === 0
      || typeof receipt.mediaSha256 !== "string" || !sha256.test(receipt.mediaSha256)
      || typeof receipt.sourceByteLength !== "number" || !Number.isSafeInteger(receipt.sourceByteLength) || receipt.sourceByteLength <= 0
      || typeof receipt.sourceDurationMs !== "number" || !Number.isSafeInteger(receipt.sourceDurationMs) || receipt.sourceDurationMs <= 0
      || typeof receipt.projectOwnerCapability !== "string" || !/^[0-9a-f]{64}$/i.test(receipt.projectOwnerCapability)
      || receipt.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || receipt.sourceDurationMs !== project.media.durationMs
      || typeof savedAtMs !== "number" || !Number.isSafeInteger(savedAtMs) || savedAtMs < 0
      || typeof retentionExpiresAtMs !== "number" || !Number.isSafeInteger(retentionExpiresAtMs) || retentionExpiresAtMs <= savedAtMs || retentionExpiresAtMs > savedAtMs + maxGenerationRetentionMs
      || (receipt.adoption !== undefined && adoption === null)
      || (receipt.cancellationRequested !== undefined && cancellationRequested === null)
      || (receipt.terminalCleanup !== undefined && terminalCleanup === null)
      || (receipt.expirySettlement !== undefined && expirySettlement === null)
    ) return null;
    const normalized: GenerationClientReceipt = {
      ...receipt,
      retentionExpiresAtMs,
      projectOwnerCapability: receipt.projectOwnerCapability.toLowerCase(),
      ...(adoption === undefined ? {} : { adoption }),
      ...(cancellationRequested === undefined ? {} : { cancellationRequested }),
      ...(terminalCleanup === undefined ? {} : { terminalCleanup }),
      ...(expirySettlement === undefined ? {} : { expirySettlement }),
    } as GenerationClientReceipt;
    return normalized;
  }

  /** Human recovery may settle expiry; read-only inspectors must use peekStoredReceipt instead. */
  public async loadStoredReceipt(store: GenerationProjectStore, project: CaptionProject, runId: string): Promise<GenerationClientReceipt | null> {
    const normalized = await this.peekStoredReceipt(store, project, runId);
    return normalized === null || this.clock() < normalized.retentionExpiresAtMs
      ? normalized
      : this.settleExpiredReceipt(store, normalized);
  }
}
