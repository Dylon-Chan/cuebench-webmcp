import {
  GenerationRunStatusSchema,
  StagedAudioDescriptionGenerationResultSchema,
  type Actor,
  type GenerationRunStatus,
} from "@cuebench/contracts";
import {
  captionEvidenceProjectionForAudioDescription,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import type { CloudUploadFetch, PersistedCloudUploadRecovery } from "../project/cloud-upload";
import type { AudioDescriptionGenerationAdoptionCommand } from "../project/project-store";
import {
  GenerationClientError,
  notifyGenerationLifecycle,
  throwIfGenerationAborted,
  withGenerationLifecycleOutcome,
  type DeletedGenerationStartRecovery,
  type GenerationLifecycleObserver,
  type GenerationReceiptAdoption,
  type GenerationReceiptCancellationIntent,
  type GenerationReceiptExpirySettlement,
  type GenerationReceiptTerminalCleanup,
  type PendingGenerationStartReservation,
} from "./generation-client";

const aiActor = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const humanActor = { type: "Human" as const, id: "human" };
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const sha256 = /^[0-9a-f]{64}$/i;
const maxGenerationRetentionMs = 24 * 60 * 60 * 1_000;

/**
 * Separate from a caption receipt: this opaque capability is bound to the
 * canonical, retained caption-evidence projection that informed the AD pass.
 * It is retained only in the browser's project-scoped durable receipt store.
 */
export interface AudioDescriptionGenerationReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly signedAudioDescriptionGenerationReceipt: string;
  readonly session: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly captionEvidenceHash: string;
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  readonly projectOwnerCapability: string;
  readonly retentionExpiresAtMs: number;
  readonly savedAtMs: number;
  readonly adoption?: GenerationReceiptAdoption;
  readonly cancellationRequested?: GenerationReceiptCancellationIntent;
  readonly terminalCleanup?: GenerationReceiptTerminalCleanup;
  readonly expirySettlement?: GenerationReceiptExpirySettlement;
}

export interface AudioDescriptionGenerationProjectStore {
  readonly getSnapshot: () => { readonly project: CaptionProject | null; readonly mode?: "durable" | "temporary" | null };
  /** Optional project-instance owner prevents queued lifecycle commands crossing an import/replacement boundary. */
  readonly executeCommand: (command: DomainCommand, expectedProjectId?: string) => Promise<CommandResult>;
  /** Must complete before the browser polls an AD receipt. */
  readonly persistAudioDescriptionGenerationReceipt: (runId: string, receipt: AudioDescriptionGenerationReceipt) => Promise<void>;
  readonly reserveAudioDescriptionGenerationReceipt?: (runId: string, reservation?: PendingGenerationStartReservation) => Promise<void>;
  readonly releaseAudioDescriptionGenerationReceiptReservation?: (runId: string) => Promise<void>;
  readonly reconcileDeletedAudioDescriptionGenerationStart?: (input: DeletedGenerationStartRecovery) => Promise<boolean>;
  readonly loadAudioDescriptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly listAudioDescriptionGenerationReceiptRunIds?: () => Promise<readonly string[]>;
  readonly getCloudProjectOwnerCapability?: (projectId: string) => Promise<string | null>;
  readonly adoptStagedAudioDescriptionGenerationResult: (command: AudioDescriptionGenerationAdoptionCommand) => Promise<CommandResult>;
  /**
   * Durable stores settle an expired AD receipt together with the target
   * lease in one transaction. Alternate/in-memory stores may omit this and
   * use the conservative compatibility path below.
   */
  readonly settleExpiredAudioDescriptionGenerationReceipt?: (runId: string) => Promise<unknown | null>;
}

export interface StartAudioDescriptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: AudioDescriptionGenerationProjectStore;
  readonly upload: Pick<PersistedCloudUploadRecovery, "operationId" | "session" | "operationReceipt" | "sourceByteLength" | "sourceSha256" | "durationMs" | "projectOwnerCapability">;
  /** An agent cancellation stops only before the next durable lifecycle edge. */
  readonly signal?: AbortSignal;
  /** Invocation-only cancellation used after a durable lease exists. */
  readonly postCommitSignal?: AbortSignal;
  readonly onLifecycleEvent?: GenerationLifecycleObserver["onLifecycleEvent"];
}

export interface StartedAudioDescriptionGeneration {
  readonly receipt: AudioDescriptionGenerationReceipt;
  readonly status: GenerationRunStatus;
}

export interface CancelAudioDescriptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: AudioDescriptionGenerationProjectStore;
  readonly receipt: AudioDescriptionGenerationReceipt;
  /** Browser Agent cancellation retains BrowserAgent provenance in the Court Record. */
  readonly actor?: Actor;
  /** An agent cancellation stops only before the cancellation-intent write. */
  readonly signal?: AbortSignal;
  /** Invocation-only cancellation used after cancellation intent is durable. */
  readonly postCommitSignal?: AbortSignal;
  readonly onLifecycleEvent?: GenerationLifecycleObserver["onLifecycleEvent"];
}

export interface AdoptAudioDescriptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: AudioDescriptionGenerationProjectStore;
  readonly receipt: AudioDescriptionGenerationReceipt;
  /** Human dialog result. The agent/browser API cannot set this on its own. */
  readonly confirmedProposedReplacement: boolean;
}

export interface AudioDescriptionGenerationClientPort {
  readonly start: (input: StartAudioDescriptionGenerationInput) => Promise<StartedAudioDescriptionGeneration>;
  readonly status: (receipt: AudioDescriptionGenerationReceipt, signal?: AbortSignal) => Promise<GenerationRunStatus>;
  /** Reuses the signed run and starts only the server-approved bounded retry. */
  readonly retry: (receipt: AudioDescriptionGenerationReceipt, signal?: AbortSignal) => Promise<GenerationRunStatus>;
  readonly cancel: (input: CancelAudioDescriptionGenerationInput) => Promise<GenerationRunStatus>;
  readonly adopt: (input: AdoptAudioDescriptionGenerationInput) => Promise<CommandResult>;
  readonly retryAdoptionCleanup: (input: Pick<AdoptAudioDescriptionGenerationInput, "store" | "receipt">) => Promise<AudioDescriptionGenerationReceipt>;
  readonly retryCancellationCleanup: (input: CancelAudioDescriptionGenerationInput) => Promise<void>;
  readonly loadStoredReceipt: (store: AudioDescriptionGenerationProjectStore, project: CaptionProject, runId: string) => Promise<AudioDescriptionGenerationReceipt | null>;
  /** Read-only validation for inspectors; unlike loadStoredReceipt it never settles expiry or releases a lease. */
  readonly peekStoredReceipt?: (store: AudioDescriptionGenerationProjectStore, project: CaptionProject, runId: string) => Promise<AudioDescriptionGenerationReceipt | null>;
}

export interface AudioDescriptionGenerationClientOptions {
  readonly fetcher?: CloudUploadFetch;
  readonly createRunId?: () => string;
  readonly clock?: () => number;
}

const defaultFetcher = (): CloudUploadFetch => {
  if (typeof globalThis.fetch !== "function") throw new GenerationClientError("Audio-description generation is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const responseRecord = (value: unknown, fallback: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GenerationClientError(fallback);
  return value as Readonly<Record<string, unknown>>;
};

/** A 5xx/transport/body ambiguity may follow a durable server write. Never mint another run id in that case. */
const responseError = async (response: Response, fallback: string): Promise<GenerationClientError> => {
  try {
    const body = await response.json() as { readonly error?: Readonly<Record<string, unknown>> };
    const error = body.error;
    if (typeof error?.message === "string" && error.message.trim().length > 0) {
      const code = typeof error.code === "string" ? error.code : undefined;
      return new GenerationClientError(error.message, {
        status: response.status,
        ...(code === undefined ? {} : { code }),
        ...(response.status >= 500 || ["AD_GENERATION_DISPATCH_PENDING", "AD_GENERATION_RECORD_UNCERTAIN", "AD_GENERATION_LEASE_UNAVAILABLE"].includes(code ?? "")
          ? { dispatchMayBeDurable: true }
          : {}),
      });
    }
  } catch {
    // Do not echo a potentially private gateway body.
  }
  return new GenerationClientError(fallback, { status: response.status, ...(response.status >= 500 ? { dispatchMayBeDurable: true } : {}) });
};

const parseStatus = (value: unknown): GenerationRunStatus => {
  const parsed = GenerationRunStatusSchema.safeParse(value);
  if (!parsed.success || parsed.data.targetTrack !== "AudioDescriptions") {
    throw new GenerationClientError("CueBench received an invalid audio-description generation status.");
  }
  return parsed.data;
};

const requireUploadAuthorization = (
  upload: StartAudioDescriptionGenerationInput["upload"],
  project: CaptionProject,
): { readonly session: string; readonly operationReceipt: string; readonly sourceByteLength: number; readonly sourceDurationMs: number; readonly projectOwnerCapability: string } => {
  if (
    typeof upload.session !== "string" || upload.session.trim().length === 0
    || typeof upload.operationReceipt !== "string" || upload.operationReceipt.trim().length === 0
    || !Number.isSafeInteger(upload.sourceByteLength) || upload.sourceByteLength <= 0
    || !Number.isSafeInteger(upload.durationMs) || upload.durationMs <= 0
    || typeof upload.sourceSha256 !== "string" || !sha256.test(upload.sourceSha256)
    || upload.sourceSha256.toLowerCase() !== project.media.sha256.toLowerCase()
    || upload.durationMs !== project.media.durationMs
    || typeof upload.projectOwnerCapability !== "string" || !/^[0-9a-f]{64}$/i.test(upload.projectOwnerCapability)
  ) throw new GenerationClientError("Complete or refresh optional cloud processing before proposing audio descriptions.");
  return {
    session: upload.session,
    operationReceipt: upload.operationReceipt,
    sourceByteLength: upload.sourceByteLength,
    sourceDurationMs: upload.durationMs,
    projectOwnerCapability: upload.projectOwnerCapability.toLowerCase(),
  };
};

const isMatchingAudioDescriptionLease = (project: CaptionProject, runId: string): boolean => (
  project.activeGenerationRun?.runId === runId && project.activeGenerationRun.targetTrack === "AudioDescriptions"
);

const audioDescriptionLeaseBase = (project: CaptionProject, runId: string) => {
  const lease = project.activeGenerationRun;
  if (!isMatchingAudioDescriptionLease(project, runId) || lease?.base === undefined || lease.base.targetTrack !== "AudioDescriptions") {
    throw new GenerationClientError("This audio-description lease cannot safely recover. Discard it before starting a new review run.", { code: "STALE_RUN" });
  }
  return lease.base;
};

const terminalCleanupState = (value: unknown, action: "adopted" | "cancelled"): "pending" | "completed" => {
  const cleanup = responseRecord(value, "CueBench did not return a durable private-media cleanup state.");
  if (cleanup.version !== 1 || cleanup.action !== action || (cleanup.state !== "pending" && cleanup.state !== "completed")) {
    throw new GenerationClientError("CueBench returned an invalid private audio-description cleanup state.");
  }
  return cleanup.state;
};

const parsedAdoption = (value: unknown): GenerationReceiptAdoption | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const adoption = value as Readonly<Record<string, unknown>>;
  return adoption.status === "adopted"
    && Number.isSafeInteger(adoption.adoptedProjectRevision) && (adoption.adoptedProjectRevision as number) > 0
    && typeof adoption.localEvidencePackageId === "string" && opaqueId.test(adoption.localEvidencePackageId)
    && (adoption.cleanupAcknowledgement === "pending" || adoption.cleanupAcknowledgement === "acknowledged" || adoption.cleanupAcknowledgement === "lifecycle-pending")
    ? { status: "adopted", adoptedProjectRevision: adoption.adoptedProjectRevision as number, localEvidencePackageId: adoption.localEvidencePackageId, cleanupAcknowledgement: adoption.cleanupAcknowledgement }
    : undefined;
};

const parsedCancellationIntent = (value: unknown): GenerationReceiptCancellationIntent | undefined => (
  typeof value === "object" && value !== null && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>).status === "requested"
    ? { status: "requested" }
    : undefined
);

const parsedTerminalCleanup = (value: unknown): GenerationReceiptTerminalCleanup | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cleanup = value as Readonly<Record<string, unknown>>;
  return cleanup.action === "cancelled"
    && (cleanup.cleanupAcknowledgement === "pending" || cleanup.cleanupAcknowledgement === "acknowledged" || cleanup.cleanupAcknowledgement === "lifecycle-pending")
    && (cleanup.localLeaseRelease === "pending" || cleanup.localLeaseRelease === "released")
    ? { action: "cancelled", cleanupAcknowledgement: cleanup.cleanupAcknowledgement, localLeaseRelease: cleanup.localLeaseRelease }
    : undefined;
};

const parsedExpirySettlement = (value: unknown): GenerationReceiptExpirySettlement | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const settlement = value as Readonly<Record<string, unknown>>;
  return settlement.state === "lifecycle-pending"
    && (settlement.disposition === "receipt-expired" || settlement.disposition === "cancellation-unconfirmed")
    && (settlement.localLeaseRelease === "pending" || settlement.localLeaseRelease === "released")
    ? { state: "lifecycle-pending", disposition: settlement.disposition, localLeaseRelease: settlement.localLeaseRelease }
    : undefined;
};

const parseStart = (
  value: unknown,
  project: CaptionProject,
  base: ReturnType<typeof audioDescriptionLeaseBase>,
  runId: string,
  savedAtMs: number,
  authorization: { readonly session: string; readonly sourceByteLength: number; readonly sourceDurationMs: number; readonly projectOwnerCapability: string },
): StartedAudioDescriptionGeneration => {
  const record = responseRecord(value, "CueBench did not return a signed audio-description receipt.");
  if (typeof record.audioDescriptionGenerationReceipt !== "string" || record.audioDescriptionGenerationReceipt.trim().length === 0) {
    throw new GenerationClientError("CueBench did not return a signed audio-description receipt.");
  }
  if (!Number.isSafeInteger(record.retentionExpiresAtMs) || (record.retentionExpiresAtMs as number) <= savedAtMs || (record.retentionExpiresAtMs as number) > savedAtMs + maxGenerationRetentionMs) {
    throw new GenerationClientError("CueBench did not return a bounded private-retention deadline for this audio-description run.");
  }
  const status = parseStatus(record.status);
  if (status.runId !== runId || status.projectId !== project.projectId || status.expectedProjectRevision !== base.expectedProjectRevision) {
    throw new GenerationClientError("CueBench returned an audio-description receipt for different project evidence.");
  }
  return {
    receipt: {
      version: 1,
      runId,
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: record.audioDescriptionGenerationReceipt,
      session: authorization.session,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      mediaSha256: base.mediaSha256,
      captionEvidenceHash: base.captionEvidenceHash,
      sourceByteLength: authorization.sourceByteLength,
      sourceDurationMs: authorization.sourceDurationMs,
      projectOwnerCapability: authorization.projectOwnerCapability,
      retentionExpiresAtMs: record.retentionExpiresAtMs as number,
      savedAtMs,
    },
    status,
  };
};

/**
 * Same-origin browser client for the target-aware AD Workflow. It sends only
 * bounded retained caption evidence and opaque upload/session capabilities;
 * no video Blob, provider key, TTS audio, or certification authority crosses
 * this boundary.
 */
export class AudioDescriptionGenerationClient implements AudioDescriptionGenerationClientPort {
  private readonly fetcher: CloudUploadFetch;
  private readonly createRunId: () => string;
  private readonly clock: () => number;

  public constructor(options: AudioDescriptionGenerationClientOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher();
    this.createRunId = options.createRunId ?? (() => globalThis.crypto.randomUUID());
    this.clock = options.clock ?? Date.now;
  }

  public async start(input: StartAudioDescriptionGenerationInput): Promise<StartedAudioDescriptionGeneration> {
    throwIfGenerationAborted(input.signal);
    const snapshot = input.store.getSnapshot();
    if (snapshot.mode !== "durable") throw new GenerationClientError("Audio-description generation needs durable browser storage before CueBench can acquire a recoverable target-track lease.", { code: "DURABLE_STORAGE_REQUIRED" });
    const authorization = requireUploadAuthorization(input.upload, input.project);
    const visibleProject = snapshot.project;
    if (visibleProject === null || visibleProject.projectId !== input.project.projectId) {
      throw new GenerationClientError("CueBench project identity changed before audio-description generation could start.");
    }
    let leasedProject = visibleProject;
    let runId: string;
    const receiptSlotReserved = input.store.reserveAudioDescriptionGenerationReceipt !== undefined;
    if (leasedProject.activeGenerationRun === null) {
      runId = this.createRunId();
      if (!opaqueId.test(runId)) throw new GenerationClientError("CueBench generated an invalid audio-description run identifier.");
      await input.store.reserveAudioDescriptionGenerationReceipt?.(runId, {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "AudioDescriptions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        mediaSha256: leasedProject.media.sha256,
        sourceDurationMs: authorization.sourceDurationMs,
      });
      try {
        throwIfGenerationAborted(input.signal);
      } catch (error) {
        if (receiptSlotReserved) {
          try { await input.store.releaseAudioDescriptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
        throw error;
      }
      const lease = await input.store.executeCommand({
        type: "StartGenerationRun",
        actor: aiActor,
        runId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: leasedProject.projectRevision,
      }, input.project.projectId);
      if (lease.error !== undefined) {
        if (receiptSlotReserved) await input.store.releaseAudioDescriptionGenerationReceiptReservation?.(runId);
        throw new GenerationClientError(lease.error.message, { code: lease.error.code });
      }
      leasedProject = lease.project;
      notifyGenerationLifecycle(input, { phase: "lease-acquired", runId, targetTrack: "AudioDescriptions" });
    } else if (isMatchingAudioDescriptionLease(leasedProject, leasedProject.activeGenerationRun.runId)) {
      runId = leasedProject.activeGenerationRun.runId;
      await input.store.reserveAudioDescriptionGenerationReceipt?.(runId, {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "AudioDescriptions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        mediaSha256: leasedProject.media.sha256,
        sourceDurationMs: authorization.sourceDurationMs,
      });
      try {
        throwIfGenerationAborted(input.signal);
      } catch (error) {
        if (receiptSlotReserved) {
          try { await input.store.releaseAudioDescriptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
        throw error;
      }
    } else {
      throw new GenerationClientError("Another caption or audio-description run currently owns CueBench's global project lease.", { code: "TARGET_TRACK_LEASE_CONFLICT" });
    }
    const base = audioDescriptionLeaseBase(leasedProject, runId);
    const captionEvidence = captionEvidenceProjectionForAudioDescription(leasedProject, base.expectedProjectRevision);
    if (
      captionEvidence === null
      || captionEvidence.hash !== base.captionEvidenceHash
      || captionEvidence.projection.mediaSha256.toLowerCase() !== base.mediaSha256
      || captionEvidence.projection.expectedQualityProfileRevision !== base.qualityProfileRevision
    ) throw new GenerationClientError("CueBench's retained caption evidence changed before visual review could start.", { code: "STALE_PROJECT" });

    let durableStartMayExist = false;
    try {
      // StartGenerationRun is durable. Its lifecycle observer can replace
      // the starter tool family synchronously, aborting the group signal that
      // got us here. Dispatch with only the invocation signal from now on.
      const response = await this.fetcher("/api/audio-description-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization.session}`,
          "content-type": "application/json",
          "x-cuebench-operation-receipt": authorization.operationReceipt,
          "x-cuebench-project-owner": authorization.projectOwnerCapability,
        },
        body: JSON.stringify({
          projectId: leasedProject.projectId,
          runId,
          expectedProjectRevision: base.expectedProjectRevision,
          expectedQualityProfileRevision: base.qualityProfileRevision,
          mediaSha256: base.mediaSha256,
          sourceByteLength: authorization.sourceByteLength,
          sourceDurationMs: authorization.sourceDurationMs,
          captionEvidenceProjection: captionEvidence.projection,
          captionEvidenceHash: captionEvidence.hash,
          qualityProfileRules: leasedProject.qualityProfile.rules,
        }),
        ...(input.postCommitSignal === undefined ? {} : { signal: input.postCommitSignal }),
      });
      if (!response.ok) throw await responseError(response, "CueBench could not start a recoverable audio-description run.");
      // A 2xx confirms a durable server record even if the body/IDB write is
      // interrupted. Keep the exact run id and lease; never duplicate a call.
      durableStartMayExist = true;
      notifyGenerationLifecycle(input, { phase: "remote-start-accepted", runId, targetTrack: "AudioDescriptions" });
      const started = parseStart(await response.json(), leasedProject, base, runId, this.clock(), authorization);
      const deletedStartRecovery = {
        projectId: leasedProject.projectId,
        operationId: input.upload.operationId,
        runId,
        targetTrack: "AudioDescriptions",
        projectOwnerCapability: authorization.projectOwnerCapability,
        receipt: started.receipt,
      } as const;
      const projectDeletedDuringStart = () => new GenerationClientError("This local project was deleted while CueBench started the audio-description run. CueBench retained the exact run for private cleanup.", {
          code: "PROJECT_DELETED_DURING_START",
          lifecycleOutcome: {
            runId,
            targetTrack: "AudioDescriptions",
            disposition: "lifecycle-pending",
            operation: "start",
            receiptState: "available",
          },
        });
      if (await input.store.reconcileDeletedAudioDescriptionGenerationStart?.(deletedStartRecovery)) throw projectDeletedDuringStart();
      try {
        await input.store.persistAudioDescriptionGenerationReceipt(runId, started.receipt);
      } catch (persistenceError) {
        // The deleted tab may commit between the first recovery check and
        // this queued durable write. Capture the exact signed run on that
        // second boundary rather than leaving an otherwise-cleanable AD run
        // to retention-only cleanup.
        if (await input.store.reconcileDeletedAudioDescriptionGenerationStart?.(deletedStartRecovery)) {
          throw projectDeletedDuringStart();
        }
        throw persistenceError;
      }
      notifyGenerationLifecycle(input, { phase: "receipt-persisted", runId, targetTrack: "AudioDescriptions" });
      return started;
    } catch (error) {
      const current = input.store.getSnapshot().project;
      const clientError = error instanceof GenerationClientError ? error : null;
      const ambiguous = durableStartMayExist || clientError?.details.dispatchMayBeDurable === true || clientError === null;
      if (ambiguous) notifyGenerationLifecycle(input, { phase: "dispatch-uncertain", runId, targetTrack: "AudioDescriptions" });
      if (!ambiguous && current !== null && isMatchingAudioDescriptionLease(current, runId)) {
        const released = await input.store.executeCommand({ type: "ReleaseGenerationRun", actor: aiActor, runId, expectedProjectRevision: current.projectRevision }, input.project.projectId).catch(() => null);
        if (released?.error === undefined) notifyGenerationLifecycle(input, { phase: "lease-released", runId, targetTrack: "AudioDescriptions" });
        if (receiptSlotReserved) {
          try { await input.store.releaseAudioDescriptionGenerationReceiptReservation?.(runId); } catch { /* reservation cleanup is best-effort */ }
        }
      }
      const retained = input.store.getSnapshot().project;
      if (retained !== null && isMatchingAudioDescriptionLease(retained, runId)) {
        throw withGenerationLifecycleOutcome(error, {
          runId,
          targetTrack: "AudioDescriptions",
          disposition: ambiguous ? "accepted-unknown" : "lifecycle-pending",
          operation: "start",
          receiptState: "missing",
        });
      }
      throw error;
    }
  }

  public async status(receipt: AudioDescriptionGenerationReceipt, signal?: AbortSignal): Promise<GenerationRunStatus> {
    throwIfGenerationAborted(signal);
    const response = await this.fetcher(`/api/audio-description-runs/${encodeURIComponent(receipt.runId)}`, {
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "x-cuebench-audio-description-receipt": receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not read audio-description generation status.");
    const record = responseRecord(await response.json(), "CueBench did not return audio-description generation status.");
    const status = parseStatus(record.status);
    if (status.runId !== receipt.runId || status.projectId !== receipt.projectId || status.expectedProjectRevision !== receipt.expectedProjectRevision) {
      throw new GenerationClientError("CueBench returned status for different audio-description evidence.");
    }
    return status;
  }

  public async retry(receipt: AudioDescriptionGenerationReceipt, signal?: AbortSignal): Promise<GenerationRunStatus> {
    throwIfGenerationAborted(signal);
    if (this.clock() >= receipt.retentionExpiresAtMs) {
      throw new GenerationClientError("CueBench cannot replay this audio-description review after its private recovery capability expired.", { code: "RECOVERY_ARTIFACT_EXPIRED" });
    }
    const response = await this.fetcher(`/api/audio-description-runs/${encodeURIComponent(receipt.runId)}/retry`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "x-cuebench-audio-description-receipt": receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not begin the retained safe audio-description retry.");
    const record = responseRecord(await response.json(), "CueBench did not return the bounded audio-description retry status.");
    const status = parseStatus(record.status);
    if (status.runId !== receipt.runId || status.projectId !== receipt.projectId || status.expectedProjectRevision !== receipt.expectedProjectRevision) {
      throw new GenerationClientError("CueBench returned retry status for different audio-description evidence.");
    }
    return status;
  }

  private async requestCancellation(receipt: AudioDescriptionGenerationReceipt, signal?: AbortSignal): Promise<{ readonly status: GenerationRunStatus; readonly cleanup: "pending" | "completed" }> {
    const response = await this.fetcher(`/api/audio-description-runs/${encodeURIComponent(receipt.runId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "x-cuebench-audio-description-receipt": receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not cancel this audio-description run.");
    const record = responseRecord(await response.json(), "CueBench did not confirm audio-description cancellation.");
    const status = parseStatus(record.status);
    if (status.stage !== "Cancelled" || status.runId !== receipt.runId || status.projectId !== receipt.projectId) {
      throw new GenerationClientError("CueBench did not confirm cancellation of this audio-description run.");
    }
    return { status, cleanup: terminalCleanupState(record.cleanup, "cancelled") };
  }

  private async releaseAudioDescriptionLease(
    store: AudioDescriptionGenerationProjectStore,
    runId: string,
    actor: Actor = humanActor,
  ): Promise<void> {
    const current = store.getSnapshot().project;
    if (current !== null && isMatchingAudioDescriptionLease(current, runId)) {
      const released = await store.executeCommand({ type: "ReleaseGenerationRun", actor, runId, expectedProjectRevision: current.projectRevision }, current.projectId);
      if (released.error !== undefined && released.error.code !== "STALE_RUN") {
        throw new GenerationClientError("CueBench confirmed cloud cancellation, but the local audio-description lease needs recovery before it can be released.", { code: released.error.code });
      }
    }
  }

  private async persistCancellationIntent(store: AudioDescriptionGenerationProjectStore, receipt: AudioDescriptionGenerationReceipt): Promise<AudioDescriptionGenerationReceipt> {
    if (receipt.cancellationRequested?.status === "requested") return receipt;
    const requested: AudioDescriptionGenerationReceipt = { ...receipt, cancellationRequested: { status: "requested" } };
    await store.persistAudioDescriptionGenerationReceipt(receipt.runId, requested);
    return requested;
  }

  private async settleCancelledLease(
    store: AudioDescriptionGenerationProjectStore,
    receipt: AudioDescriptionGenerationReceipt,
    actor: Actor = humanActor,
  ): Promise<AudioDescriptionGenerationReceipt> {
    const terminal = receipt.terminalCleanup;
    if (terminal?.action !== "cancelled") throw new GenerationClientError("CueBench cannot release an audio-description lease before cancellation is durably recorded.");
    if (terminal.localLeaseRelease === "released") return receipt;
    await this.releaseAudioDescriptionLease(store, receipt.runId, actor);
    const settled: AudioDescriptionGenerationReceipt = { ...receipt, terminalCleanup: { ...terminal, localLeaseRelease: "released" } };
    await store.persistAudioDescriptionGenerationReceipt(receipt.runId, settled);
    return settled;
  }

  private async completeCancellationRequest(
    input: CancelAudioDescriptionGenerationInput,
    receipt: AudioDescriptionGenerationReceipt,
  ): Promise<{ readonly status: GenerationRunStatus; readonly cleanup: "pending" | "completed" }> {
    // The write-ahead cancellation intent is durable before DELETE. Do not
    // let replacement of the old active-run group abort that exact request.
    const remote = await this.requestCancellation(receipt, input.postCommitSignal);
    notifyGenerationLifecycle(input, { phase: "remote-cancelled", runId: receipt.runId, targetTrack: "AudioDescriptions" });
    const withoutIntent = { ...receipt };
    delete withoutIntent.cancellationRequested;
    const persisted: AudioDescriptionGenerationReceipt = {
      ...withoutIntent,
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: remote.cleanup === "completed" ? "acknowledged" : "pending",
        localLeaseRelease: receipt.terminalCleanup?.localLeaseRelease ?? "pending",
      },
    };
    // This receipt write intentionally comes before local release; a crash
    // cannot strand a local global lease after the Worker accepted DELETE.
    await input.store.persistAudioDescriptionGenerationReceipt(receipt.runId, persisted);
    // Exact R2 object deletion can finish before the independent shared
    // server lease CAS. Keep the local lease and the visible retry path until
    // the route explicitly reports that both terminal boundaries settled.
    if (remote.cleanup === "completed") {
      await this.settleCancelledLease(input.store, persisted, input.actor ?? humanActor);
    }
    return remote;
  }

  public async cancel(input: CancelAudioDescriptionGenerationInput): Promise<GenerationRunStatus> {
    let intentCommitted = input.receipt.cancellationRequested?.status === "requested";
    try {
      throwIfGenerationAborted(input.signal);
      const requested = await this.persistCancellationIntent(input.store, input.receipt);
      intentCommitted = true;
      notifyGenerationLifecycle(input, { phase: "cancellation-intent-persisted", runId: requested.runId, targetTrack: "AudioDescriptions" });
      return (await this.completeCancellationRequest(input, requested)).status;
    } catch (error) {
      if (!intentCommitted && error instanceof Error && error.name === "AbortError") throw error;
      const current = input.store.getSnapshot().project;
      if (current !== null && isMatchingAudioDescriptionLease(current, input.receipt.runId)) {
        throw withGenerationLifecycleOutcome(error, {
          runId: input.receipt.runId,
          targetTrack: "AudioDescriptions",
          disposition: "lifecycle-pending",
          operation: "cancel",
          receiptState: "available",
        });
      }
      throw error;
    }
  }

  private async settleExpiredReceipt(store: AudioDescriptionGenerationProjectStore, receipt: AudioDescriptionGenerationReceipt): Promise<AudioDescriptionGenerationReceipt> {
    if (store.settleExpiredAudioDescriptionGenerationReceipt !== undefined) {
      const persisted = await store.settleExpiredAudioDescriptionGenerationReceipt(receipt.runId);
      if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted)) {
        throw new GenerationClientError("CueBench could not atomically recover this expired audio-description receipt.", { code: "RECOVERY_ARTIFACT_EXPIRED" });
      }
      const payload = persisted as Readonly<Record<string, unknown>>;
      const adoption = payload.adoption === undefined ? undefined : parsedAdoption(payload.adoption);
      const terminalCleanup = payload.terminalCleanup === undefined ? undefined : parsedTerminalCleanup(payload.terminalCleanup);
      const expirySettlement = payload.expirySettlement === undefined ? undefined : parsedExpirySettlement(payload.expirySettlement);
      if (receipt.adoption?.cleanupAcknowledgement === "pending") {
        if (
          adoption === undefined
          || adoption.adoptedProjectRevision !== receipt.adoption.adoptedProjectRevision
          || adoption.localEvidencePackageId !== receipt.adoption.localEvidencePackageId
          || adoption.cleanupAcknowledgement !== "lifecycle-pending"
        ) throw new GenerationClientError("CueBench returned an invalid atomic adoption-expiry settlement.");
        return { ...receipt, adoption };
      }
      if (receipt.terminalCleanup?.action === "cancelled") {
        if (terminalCleanup === undefined || terminalCleanup.cleanupAcknowledgement !== "lifecycle-pending") {
          throw new GenerationClientError("CueBench returned an invalid atomic cancellation-expiry settlement.");
        }
        return { ...receipt, terminalCleanup };
      }
      if (expirySettlement === undefined || expirySettlement.state !== "lifecycle-pending") {
        throw new GenerationClientError("CueBench returned an invalid atomic receipt-expiry settlement.");
      }
      return { ...receipt, expirySettlement };
    }
    if (receipt.adoption?.cleanupAcknowledgement === "pending") {
      const lifecycle: AudioDescriptionGenerationReceipt = { ...receipt, adoption: { ...receipt.adoption, cleanupAcknowledgement: "lifecycle-pending" } };
      await store.persistAudioDescriptionGenerationReceipt(receipt.runId, lifecycle);
      return lifecycle;
    }
    if (receipt.terminalCleanup?.action === "cancelled") {
      const lifecycle: AudioDescriptionGenerationReceipt = receipt.terminalCleanup.cleanupAcknowledgement === "lifecycle-pending"
        ? receipt
        : { ...receipt, terminalCleanup: { ...receipt.terminalCleanup, cleanupAcknowledgement: "lifecycle-pending" } };
      if (lifecycle !== receipt) await store.persistAudioDescriptionGenerationReceipt(receipt.runId, lifecycle);
      return this.settleCancelledLease(store, lifecycle);
    }
    const pending = receipt.expirySettlement?.localLeaseRelease === "released"
      ? receipt
      : {
        ...receipt,
        expirySettlement: {
          state: "lifecycle-pending" as const,
          disposition: receipt.cancellationRequested?.status === "requested" ? "cancellation-unconfirmed" as const : "receipt-expired" as const,
          localLeaseRelease: "pending" as const,
        },
      };
    if (pending !== receipt) await store.persistAudioDescriptionGenerationReceipt(receipt.runId, pending);
    if (pending.expirySettlement?.localLeaseRelease === "released") return pending;
    await this.releaseAudioDescriptionLease(store, receipt.runId);
    const settled: AudioDescriptionGenerationReceipt = { ...pending, expirySettlement: { ...pending.expirySettlement!, localLeaseRelease: "released" } };
    await store.persistAudioDescriptionGenerationReceipt(receipt.runId, settled);
    return settled;
  }

  public async retryCancellationCleanup(input: CancelAudioDescriptionGenerationInput): Promise<void> {
    const terminal = input.receipt.terminalCleanup;
    if (terminal?.action !== "cancelled") {
      if (input.receipt.cancellationRequested?.status !== "requested") throw new GenerationClientError("CueBench cannot retry cancellation cleanup before cancellation is durably recorded in this browser.");
      if (this.clock() >= input.receipt.retentionExpiresAtMs) {
        await this.settleExpiredReceipt(input.store, input.receipt);
        return;
      }
      await this.completeCancellationRequest(input, input.receipt);
      return;
    }
    if (terminal.cleanupAcknowledgement === "acknowledged" || terminal.cleanupAcknowledgement === "lifecycle-pending") {
      await this.settleCancelledLease(input.store, input.receipt);
      return;
    }
    if (this.clock() >= input.receipt.retentionExpiresAtMs) {
      const lifecycle: AudioDescriptionGenerationReceipt = { ...input.receipt, terminalCleanup: { ...terminal, cleanupAcknowledgement: "lifecycle-pending" } };
      await input.store.persistAudioDescriptionGenerationReceipt(input.receipt.runId, lifecycle);
      await this.settleCancelledLease(input.store, lifecycle);
      return;
    }
    const remote = await this.completeCancellationRequest(input, input.receipt);
    if (remote.cleanup !== "completed") throw new GenerationClientError("CueBench is still draining a private visual-preparation write before cancellation cleanup can complete.");
  }

  private async acknowledgeAdoption(receipt: AudioDescriptionGenerationReceipt, adoptedProjectRevision: number): Promise<void> {
    const response = await this.fetcher(`/api/audio-description-runs/${encodeURIComponent(receipt.runId)}/acknowledge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receipt.session}`,
        "content-type": "application/json",
        "x-cuebench-audio-description-receipt": receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": receipt.projectOwnerCapability,
      },
      body: JSON.stringify({ action: "adopted", adoptedProjectRevision }),
    });
    if (!response.ok) throw await responseError(response, "CueBench could not confirm private audio-description cleanup.");
    const record = responseRecord(await response.json(), "CueBench did not confirm private audio-description cleanup.");
    const status = parseStatus(record.status);
    if (
      status.stage !== "Completed"
      || status.runId !== receipt.runId
      || status.projectId !== receipt.projectId
      || status.expectedProjectRevision !== receipt.expectedProjectRevision
      || status.adoptedProjectRevision !== adoptedProjectRevision
    ) throw new GenerationClientError("CueBench returned an invalid audio-description cleanup acknowledgement.");
    if (terminalCleanupState(record.cleanup, "adopted") !== "completed") {
      throw new GenerationClientError("CueBench is still draining a private visual-preparation write before cleanup can complete.");
    }
  }

  public async retryAdoptionCleanup(input: Pick<AdoptAudioDescriptionGenerationInput, "store" | "receipt">): Promise<AudioDescriptionGenerationReceipt> {
    const adoption = input.receipt.adoption;
    if (adoption?.status !== "adopted") throw new GenerationClientError("CueBench cannot retry cleanup before local audio-description adoption has committed.");
    if (this.clock() >= input.receipt.retentionExpiresAtMs) return this.settleExpiredReceipt(input.store, input.receipt);
    await this.acknowledgeAdoption(input.receipt, adoption.adoptedProjectRevision);
    const acknowledged: AudioDescriptionGenerationReceipt = { ...input.receipt, adoption: { ...adoption, cleanupAcknowledgement: "acknowledged" } };
    await input.store.persistAudioDescriptionGenerationReceipt(input.receipt.runId, acknowledged);
    return acknowledged;
  }

  public async adopt(input: AdoptAudioDescriptionGenerationInput): Promise<CommandResult> {
    const response = await this.fetcher(`/api/audio-description-runs/${encodeURIComponent(input.receipt.runId)}/staged-result`, {
      headers: {
        authorization: `Bearer ${input.receipt.session}`,
        "x-cuebench-audio-description-receipt": input.receipt.signedAudioDescriptionGenerationReceipt,
        "x-cuebench-project-owner": input.receipt.projectOwnerCapability,
      },
    });
    if (!response.ok) throw await responseError(response, "CueBench could not retrieve a complete staged audio-description result.");
    const record = responseRecord(await response.json(), "CueBench did not return a complete staged audio-description result.");
    const parsed = StagedAudioDescriptionGenerationResultSchema.safeParse(record.result);
    if (!parsed.success) throw new GenerationClientError("CueBench returned an invalid staged audio-description result.");
    const result = parsed.data;
    const base = audioDescriptionLeaseBase(input.project, input.receipt.runId);
    const projection = captionEvidenceProjectionForAudioDescription(input.project, base.expectedProjectRevision);
    if (
      projection === null
      || projection.hash !== base.captionEvidenceHash
      || input.receipt.captionEvidenceHash !== base.captionEvidenceHash
      || input.receipt.expectedProjectRevision !== base.expectedProjectRevision
      || input.receipt.expectedQualityProfileRevision !== base.qualityProfileRevision
      || result.runId !== input.receipt.runId
      || result.projectId !== input.project.projectId
      || result.expectedProjectRevision !== base.expectedProjectRevision
      || result.expectedQualityProfileRevision !== base.qualityProfileRevision
      || result.mediaSha256.toLowerCase() !== base.mediaSha256
      || result.captionEvidenceHash.toLowerCase() !== base.captionEvidenceHash
      || result.evidence.mediaSha256.toLowerCase() !== base.mediaSha256
      || result.evidence.captionEvidenceHash.toLowerCase() !== base.captionEvidenceHash
    ) throw new GenerationClientError("The staged audio-description result is stale for CueBench's current retained caption evidence.", { code: "STALE_PROJECT" });

    const adopted = await input.store.adoptStagedAudioDescriptionGenerationResult({
      type: "AdoptAudioDescriptionGenerationResult",
      actor: aiActor,
      runId: input.receipt.runId,
      expectedProjectRevision: base.expectedProjectRevision,
      expectedQualityProfileRevision: base.qualityProfileRevision,
      confirmedProposedReplacement: input.confirmedProposedReplacement,
      result,
    });
    if (adopted.error !== undefined) return adopted;
    const pending: AudioDescriptionGenerationReceipt = {
      ...input.receipt,
      adoption: {
        status: "adopted",
        adoptedProjectRevision: adopted.project.projectRevision,
        localEvidencePackageId: `audio-description-${input.receipt.runId}`,
        cleanupAcknowledgement: "pending",
      },
    };
    try {
      // The durable ProjectStore performs this marker atomically with the
      // project mutation. Rewriting it keeps test/alternate ports honest.
      await input.store.persistAudioDescriptionGenerationReceipt(input.receipt.runId, pending);
      await this.retryAdoptionCleanup({ store: input.store, receipt: pending });
    } catch {
      // Local adoption succeeded and stays discoverable. A failed cleanup ACK
      // must not invite a second AI adoption or claim private objects deleted.
    }
    return adopted;
  }

  public async peekStoredReceipt(
    store: AudioDescriptionGenerationProjectStore,
    project: CaptionProject,
    runId: string,
  ): Promise<AudioDescriptionGenerationReceipt | null> {
    const value = await store.loadAudioDescriptionGenerationReceipt(runId);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const receipt = value as Partial<AudioDescriptionGenerationReceipt>;
    const savedAtMs = receipt.savedAtMs;
    const expectedProjectRevision = receipt.expectedProjectRevision;
    const expectedQualityProfileRevision = receipt.expectedQualityProfileRevision;
    const sourceByteLength = receipt.sourceByteLength;
    const sourceDurationMs = receipt.sourceDurationMs;
    const retentionExpiresAtMs = receipt.retentionExpiresAtMs === undefined
      && typeof savedAtMs === "number" && Number.isSafeInteger(savedAtMs) && savedAtMs <= Number.MAX_SAFE_INTEGER - maxGenerationRetentionMs
      ? savedAtMs + maxGenerationRetentionMs
      : receipt.retentionExpiresAtMs;
    if (
      receipt.version !== 1
      || receipt.runId !== runId
      || receipt.projectId !== project.projectId
      || typeof receipt.signedAudioDescriptionGenerationReceipt !== "string" || receipt.signedAudioDescriptionGenerationReceipt.length === 0
      || typeof receipt.session !== "string" || receipt.session.length === 0
      || typeof expectedProjectRevision !== "number" || !Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1
      || typeof expectedQualityProfileRevision !== "number" || !Number.isSafeInteger(expectedQualityProfileRevision) || expectedQualityProfileRevision < 1
      || typeof receipt.mediaSha256 !== "string" || !sha256.test(receipt.mediaSha256) || receipt.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || typeof receipt.captionEvidenceHash !== "string" || !sha256.test(receipt.captionEvidenceHash)
      || typeof sourceByteLength !== "number" || !Number.isSafeInteger(sourceByteLength) || sourceByteLength <= 0
      || typeof sourceDurationMs !== "number" || !Number.isSafeInteger(sourceDurationMs) || sourceDurationMs !== project.media.durationMs
      || typeof receipt.projectOwnerCapability !== "string" || !/^[0-9a-f]{64}$/i.test(receipt.projectOwnerCapability)
      || typeof savedAtMs !== "number" || !Number.isSafeInteger(savedAtMs) || savedAtMs < 0
      || typeof retentionExpiresAtMs !== "number" || !Number.isSafeInteger(retentionExpiresAtMs) || retentionExpiresAtMs <= savedAtMs || retentionExpiresAtMs > savedAtMs + maxGenerationRetentionMs
    ) return null;
    const adoption = receipt.adoption === undefined ? undefined : parsedAdoption(receipt.adoption);
    const cancellationRequested = receipt.cancellationRequested === undefined ? undefined : parsedCancellationIntent(receipt.cancellationRequested);
    const terminalCleanup = receipt.terminalCleanup === undefined ? undefined : parsedTerminalCleanup(receipt.terminalCleanup);
    const expirySettlement = receipt.expirySettlement === undefined ? undefined : parsedExpirySettlement(receipt.expirySettlement);
    if (
      receipt.adoption !== undefined && adoption === undefined
      || receipt.cancellationRequested !== undefined && cancellationRequested === undefined
      || receipt.terminalCleanup !== undefined && terminalCleanup === undefined
      || receipt.expirySettlement !== undefined && expirySettlement === undefined
    ) return null;
    const normalized: AudioDescriptionGenerationReceipt = {
      version: 1,
      runId,
      projectId: project.projectId,
      signedAudioDescriptionGenerationReceipt: receipt.signedAudioDescriptionGenerationReceipt,
      session: receipt.session,
      expectedProjectRevision,
      expectedQualityProfileRevision,
      mediaSha256: receipt.mediaSha256.toLowerCase(),
      captionEvidenceHash: receipt.captionEvidenceHash.toLowerCase(),
      sourceByteLength,
      sourceDurationMs,
      projectOwnerCapability: receipt.projectOwnerCapability.toLowerCase(),
      retentionExpiresAtMs: retentionExpiresAtMs as number,
      savedAtMs,
      ...(adoption === undefined ? {} : { adoption }),
      ...(cancellationRequested === undefined ? {} : { cancellationRequested }),
      ...(terminalCleanup === undefined ? {} : { terminalCleanup }),
      ...(expirySettlement === undefined ? {} : { expirySettlement }),
    };
    return normalized;
  }

  /**
   * Recovery is intentionally distinct from inspection. Callers that need to
   * repair an elapsed capability opt into this mutating path; inspectors must
   * use {@link peekStoredReceipt} so merely reading a run never changes its
   * lease, receipt, revision, or registered tool groups.
   */
  public async loadStoredReceipt(
    store: AudioDescriptionGenerationProjectStore,
    project: CaptionProject,
    runId: string,
  ): Promise<AudioDescriptionGenerationReceipt | null> {
    const normalized = await this.peekStoredReceipt(store, project, runId);
    return normalized === null || this.clock() < normalized.retentionExpiresAtMs
      ? normalized
      : this.settleExpiredReceipt(store, normalized);
  }
}
