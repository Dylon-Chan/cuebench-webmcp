import {
  applyCommand,
  createProject,
  buildProjectBackupFilename,
  canonicalHash,
  domainError,
  exportProjectBackup as exportProjectBackupManifest,
  prepareTrackExport as prepareDomainTrackExport,
  previewProjectImport,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
  type ProjectImportDescriptor,
  type ProjectTrackExport,
  type ProjectTrackExportRequest,
} from "@cuebench/domain";
import {
  CueBenchDatabase,
  adoptStagedAudioDescriptionGenerationResult as adoptPersistedAudioDescriptionGenerationResult,
  adoptStagedCaptionGenerationResult as adoptPersistedCaptionGenerationResult,
  describeImportedProject,
  deleteRunReceipt,
  executePersistentCommand,
  initializeProject,
  loadProject,
  loadProjectInTransaction,
  loadNarrationBlob,
  loadRunReceipt,
  listRunReceipts,
  loadSetting,
  loadSourceMedia,
  releaseRunReceiptReservation,
  reserveRunReceiptSlot,
  saveRunReceipt,
  runReceiptKey,
  saveNarrationBlob,
  saveSetting,
  settleExpiredAudioDescriptionGenerationReceipt as settlePersistedExpiredAudioDescriptionGenerationReceipt,
  sourceBlobKey,
  StorageStaleWriteError,
  type SourceBlobRow,
} from "@cuebench/storage";
import {
  createNarrationPreviewGateway,
  type NarrationPreviewAuthorization,
} from "../review/narration-preview-client";
import type {
  NarrationPreviewGateway,
  NarrationPreviewRequest,
} from "../review/NarrationPreview";
import {
  BUNDLED_SAMPLE_AUDIO_DESCRIPTION_GAPS,
  BUNDLED_SAMPLE_DURATION_MS,
  createBundledSampleFile,
} from "./bundled-sample";
import {
  hashLocalMedia,
  LocalMediaError,
  ObjectUrlLease,
  ingestLocalMedia,
  inspectLocalMedia,
  probeVideoDuration,
  type IngestedLocalMedia,
  type MediaDurationProbe,
} from "./local-media";
import { parseBoundedBackupJson } from "./backup-import-safety";
import {
  bundledFixtureSourceProvenance,
  sourceProvenanceFrom,
  uploadedSourceProvenance,
  type SourceProvenance,
} from "./source-provenance";
import { clearPersistedCloudUpload, loadPersistedCloudUpload } from "./cloud-upload";
import type { CloudCleanupStatusEntry } from "./CloudCleanupStatus";
import type {
  DeletedGenerationStartRecovery,
  PendingGenerationStartReservation,
} from "../generation/generation-client";
import {
  cleanupProjectCloudArtifacts,
  type ProjectCloudCleanupAuthorization,
  type ProjectRunCleanupAuthorization,
  type ProjectUploadCleanupAuthorization,
} from "./project-cloud-cleanup";

export type ProjectMode = "durable" | "temporary";
export type ProjectRoute = "start" | "temporary-choice" | "workbench";
export type ProjectActivity = "hydrating" | "preparing" | "saving" | "importing" | "deleting" | null;

export interface CloudCleanupRequest {
  readonly projectId: string;
  readonly sourceId: string;
  readonly activeRunId: string | null;
  /** Task 15 owns the remote cancellation protocol; deletion always requests it first. */
  readonly cancelActiveWork: true;
}

export interface CloudCleanupResult {
  readonly status: "deleted" | "pending" | "failed";
  readonly message: string;
}

export type CloudCleanupHook = (request: CloudCleanupRequest) => Promise<CloudCleanupResult>;

export interface ProjectDeletionResult {
  readonly localDeleted: true;
  readonly cloudCleanup: CloudCleanupResult;
  readonly cleanupNotice: string;
  /** Retained locally so a pending hosted cleanup can be retried truthfully. */
  readonly receiptId: string;
}

export interface ProjectBackupDownload {
  readonly filename: string;
  readonly text: string;
  /** A durable peer updated the project before serialization; this backup uses that canonical version. */
  readonly freshnessNotice?: string;
}

export interface FreshProjectTrackExport {
  readonly project: CaptionProject;
  readonly prepared: ProjectTrackExport;
  readonly freshnessNotice: string | null;
}

export interface ImportedProjectResult {
  readonly project: CaptionProject;
  readonly cleanupNotice: string;
}

export interface BrowserStorageManager {
  estimate: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  persist: () => Promise<boolean>;
}

export interface PendingUpload {
  readonly file: File;
  readonly durationMs: number;
  readonly projectId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly sourceProvenance: SourceProvenance;
}

export interface ProjectStoreSnapshot {
  readonly route: ProjectRoute;
  readonly project: CaptionProject | null;
  readonly mode: ProjectMode | null;
  /** Present only with a live, playable Blob-backed object URL. */
  readonly sourceObjectUrl: string | null;
  /** Trusted local source facts, never inferred from mutable project text. */
  readonly sourceProvenance: SourceProvenance | null;
  readonly pendingUpload: PendingUpload | null;
  readonly activity: ProjectActivity;
  readonly error: string | null;
  /** Retained after a confirmed deletion so we never overstate cloud cleanup. */
  readonly cleanupNotice: string | null;
}

/**
 * Page-internal ownership fence for a non-portable browser project instance.
 * This deliberately never contains the durable owner capability itself: the
 * bridge needs only an opaque epoch to reject work retained from a replaced
 * import, while hosted capability material remains private to this store.
 */
export interface ProjectInstanceFence {
  readonly projectId: string;
  readonly projectInstanceEpoch: number;
  /**
   * A one-way, page-internal fingerprint of the persisted non-portable owner
   * capability. It is never serialized into a backup or returned to an
   * agent; it only prevents a stale tab from mutating a same-id replacement.
   */
  readonly projectInstanceCapabilityFingerprint?: string;
}

/**
 * A page captured a nonportable owner binding that no longer authorizes this
 * project namespace. This is intentionally distinct from a normal expected
 * revision rejection: a Browser Agent must never continue lifecycle work
 * across a same-id import from another tab.
 */
export class ProjectInstanceFenceError extends Error {
  public constructor() {
    super("CueBench's browser project instance changed before this lifecycle action could continue.");
    this.name = "ProjectInstanceFenceError";
  }
}

export interface ProjectStoreOptions {
  readonly database?: CueBenchDatabase;
  readonly browserStorage?: BrowserStorageManager | null;
  readonly mediaDurationProbe?: MediaDurationProbe;
  readonly objectUrlLease?: ObjectUrlLease;
  readonly createId?: () => string;
  readonly bundledSampleLoader?: () => File | Promise<File>;
  /** Optional hosted-cleanup seam populated by Task 15. Its absence is reported as lifecycle-pending, never success. */
  readonly cloudCleanup?: CloudCleanupHook;
  /** Bounds hosted deletion work; local deletion never waits indefinitely on a cloud hook. */
  readonly cloudCleanupTimeoutMs?: number;
  /** Test seam: a synchronous UI-side fault after commit must reconcile forward, never restore a dead preview. */
  readonly afterImportCommitted?: () => void;
  /** Test seam for proving that a stale restore cannot replace a newer operation. */
  readonly beforeRestoreLoad?: () => Promise<void>;
}

export type CaptionGenerationAdoptionCommand = Extract<DomainCommand, {
  readonly type: "AdoptCaptionGenerationResult";
}>;

export type AudioDescriptionGenerationAdoptionCommand = Extract<DomainCommand, {
  readonly type: "AdoptAudioDescriptionGenerationResult";
}>;

/**
 * Capability-bound port handed only to a WebMCP generation invocation. The
 * raw ProjectStore remains available to ordinary Human UI flows, while every
 * lifecycle/receipt operation here carries one captured instance fence.
 */
export interface BoundGenerationProjectStore {
  readonly getSnapshot: () => { readonly project: CaptionProject | null; readonly mode: ProjectMode | null };
  readonly executeCommand: (command: DomainCommand, expectedProjectId?: string) => Promise<CommandResult>;
  readonly persistCaptionGenerationReceipt: (runId: string, receipt: unknown) => Promise<void>;
  readonly deleteCaptionGenerationReceipt: (runId: string) => Promise<void>;
  readonly reserveCaptionGenerationReceipt: (runId: string, reservation?: PendingGenerationStartReservation) => Promise<void>;
  readonly releaseCaptionGenerationReceiptReservation: (runId: string) => Promise<void>;
  readonly reconcileDeletedCaptionGenerationStart: (input: DeletedGenerationStartRecovery) => Promise<boolean>;
  readonly loadCaptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly listCaptionGenerationReceiptRunIds: () => Promise<readonly string[]>;
  readonly persistAudioDescriptionGenerationReceipt: (runId: string, receipt: unknown) => Promise<void>;
  readonly reserveAudioDescriptionGenerationReceipt: (runId: string, reservation?: PendingGenerationStartReservation) => Promise<void>;
  readonly releaseAudioDescriptionGenerationReceiptReservation: (runId: string) => Promise<void>;
  readonly reconcileDeletedAudioDescriptionGenerationStart: (input: DeletedGenerationStartRecovery) => Promise<boolean>;
  readonly loadAudioDescriptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly listAudioDescriptionGenerationReceiptRunIds: () => Promise<readonly string[]>;
  readonly settleExpiredAudioDescriptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly getCloudProjectOwnerCapability: (projectId: string) => Promise<string | null>;
  readonly adoptStagedCaptionGenerationResult: (command: CaptionGenerationAdoptionCommand) => Promise<CommandResult>;
  readonly adoptStagedAudioDescriptionGenerationResult: (command: AudioDescriptionGenerationAdoptionCommand) => Promise<CommandResult>;
}

const metadataReserveBytes = 16 * 1024 * 1024;
const cloudCleanupBackstopMs = 24 * 60 * 60 * 1_000;
const expiredCloudCleanupMessage = "Private cleanup is lifecycle-pending because this browser recovery capability expired. The 24-hour lifecycle backstop remains in effect.";
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const projectOwnerKey = (projectId: string): string => `project-owner:${projectId}`;
/**
 * This is deliberately separate from the short-lived project creation marker
 * above. It is a stable, non-portable browser-project instance capability
 * used to bind optional private cloud operations across anonymous-session
 * renewal. Backups never carry it.
 */
const projectInstanceOwnerCapabilityKey = (projectId: string): string => `project-instance-owner-capability:${projectId}`;
const projectSourceProvenanceKey = (projectId: string): string => `project-source-provenance:${projectId}`;
const lastDurableProjectKey = "last-durable-project";
const importSafetyBackupKey = (projectId: string, backupId: string): string => `import-safety-backup:${projectId}:${backupId}`;
const replacementSafetyBackupKey = (projectId: string, backupId: string): string => `replacement-safety-backup:${projectId}:${backupId}`;
const deletionReceiptKey = (projectId: string, receiptId: string): string => `project-deletion-receipt:${projectId}:${receiptId}`;
/**
 * Kept outside the project namespace cleanup list so a late start response
 * can attach its exact signed run to the already-committed deletion receipt.
 * The opaque operation+run suffix prevents a reused upload from aliasing a
 * later start, and it is deleted on normal receipt persistence, cleanup, or
 * expiry.
 */
const pendingGenerationStartIntentKey = (projectId: string, operationId: string, runId: string): string =>
  `pending-generation-start:${projectId}:${operationId}:${runId}`;
const pendingGenerationStartIntentPrefix = (projectId: string): string => `pending-generation-start:${projectId}:`;
/** A dangling pre-POST write-ahead entry is private recovery material, not durable project state. */
const PENDING_GENERATION_START_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const importReplacementHash = (project: CaptionProject): string => canonicalHash("cuebench.web.import-replacement.v1", project);

interface ReplacementImportExpectation {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectHash: string;
  readonly mode: ProjectMode;
}

interface DeletionReceipt {
  readonly receiptId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly activeRunId: string | null;
  readonly createdAtMs: number;
  /** Anonymous hosted recovery and the R2 lifecycle backstop are bounded to 24 hours. */
  readonly expiresAtMs: number;
  readonly attempts: number;
  readonly state: "pending" | "deleted" | "failed" | "lifecycle-pending";
  readonly message: string;
  /**
   * Private, bounded recovery capabilities captured before the project rows
   * disappear. They never enter a snapshot, backup, tool response, or the
   * start-screen cleanup projection.
   */
  readonly authorization?: ProjectCloudCleanupAuthorization;
}

/** Private only; never copied into snapshots, backups, tool results, or UI. */
interface PendingDeletedGenerationStartIntent {
  readonly version: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly ownerCapability: string;
  readonly mediaSha256: string;
  readonly sourceDurationMs: number;
  readonly createdAtMs: number;
  /** Written atomically with project deletion before the normal rows vanish. */
  readonly deletionReceiptId?: string;
}

const withoutCloudCleanupAuthorization = (receipt: DeletionReceipt): Omit<DeletionReceipt, "authorization"> => {
  const publicLifecycle = { ...receipt };
  delete publicLifecycle.authorization;
  return publicLifecycle;
};

interface ProjectInstanceOwnerCapability {
  readonly version: 1;
  readonly projectId: string;
  readonly capability: string;
}

const createProjectInstanceOwnerCapability = (): string => {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw new Error("CueBench cannot create a cryptographically random browser-project owner capability.");
  }
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readProjectInstanceOwnerCapability = (value: unknown, projectId: string): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return record.version === 1
    && record.projectId === projectId
    && typeof record.capability === "string"
    && /^[0-9a-f]{64}$/i.test(record.capability)
    ? record.capability.toLowerCase()
    : null;
};

/** Header-safe opaque capability material. This is private persistence only. */
const privateCredential = (value: unknown): string | null => (
  typeof value === "string"
  && value.length > 0
  && value.length <= 16_384
  && !/[\r\n]/.test(value)
) ? value : null;

const privateOpaqueIdentifier = (value: unknown): string | null => (
  typeof value === "string"
  && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
) ? value : null;

const pendingDeletedGenerationStartIntentFrom = (
  value: unknown,
): PendingDeletedGenerationStartIntent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const projectId = privateOpaqueIdentifier(record.projectId);
  const operationId = privateOpaqueIdentifier(record.operationId);
  const runId = privateOpaqueIdentifier(record.runId);
  const ownerCapability = typeof record.ownerCapability === "string" && /^[0-9a-f]{64}$/iu.test(record.ownerCapability)
    ? record.ownerCapability.toLowerCase()
    : null;
  const mediaSha256 = typeof record.mediaSha256 === "string" && /^[0-9a-f]{64}$/iu.test(record.mediaSha256)
    ? record.mediaSha256.toLowerCase()
    : null;
  const deletionReceiptId = record.deletionReceiptId === undefined
    ? undefined
    : privateOpaqueIdentifier(record.deletionReceiptId);
  if (
    record.version !== 1
    || projectId === null
    || operationId === null
    || runId === null
    || (record.targetTrack !== "Captions" && record.targetTrack !== "AudioDescriptions")
    || ownerCapability === null
    || mediaSha256 === null
    || !Number.isSafeInteger(record.sourceDurationMs)
    || (record.sourceDurationMs as number) <= 0
    || !Number.isSafeInteger(record.createdAtMs)
    || (record.createdAtMs as number) < 0
    || (record.deletionReceiptId !== undefined && deletionReceiptId === null)
  ) return null;
  return {
    version: 1,
    projectId,
    operationId,
    runId,
    targetTrack: record.targetTrack,
    ownerCapability,
    mediaSha256,
    sourceDurationMs: record.sourceDurationMs as number,
    createdAtMs: record.createdAtMs as number,
    ...(deletionReceiptId === undefined ? {} : { deletionReceiptId: deletionReceiptId as string }),
  };
};

const pendingDeletedGenerationStartIntentFor = (
  reservation: PendingGenerationStartReservation,
  nowMs: number,
): PendingDeletedGenerationStartIntent => {
  const projectId = privateOpaqueIdentifier(reservation.projectId);
  const operationId = privateOpaqueIdentifier(reservation.operationId);
  const runId = privateOpaqueIdentifier(reservation.runId);
  const ownerCapability = /^[0-9a-f]{64}$/iu.test(reservation.projectOwnerCapability)
    ? reservation.projectOwnerCapability.toLowerCase()
    : null;
  const mediaSha256 = /^[0-9a-f]{64}$/iu.test(reservation.mediaSha256)
    ? reservation.mediaSha256.toLowerCase()
    : null;
  if (
    projectId === null
    || operationId === null
    || runId === null
    || (reservation.targetTrack !== "Captions" && reservation.targetTrack !== "AudioDescriptions")
    || ownerCapability === null
    || mediaSha256 === null
    || !Number.isSafeInteger(reservation.sourceDurationMs)
    || reservation.sourceDurationMs <= 0
  ) throw new Error("CueBench could not reserve an invalid private generation-start recovery intent.");
  return {
    version: 1,
    projectId,
    operationId,
    runId,
    targetTrack: reservation.targetTrack,
    ownerCapability,
    mediaSha256,
    sourceDurationMs: reservation.sourceDurationMs,
    createdAtMs: nowMs,
  };
};

const samePendingDeletedGenerationStartIntent = (
  left: PendingDeletedGenerationStartIntent,
  right: PendingDeletedGenerationStartIntent,
): boolean => (
  left.projectId === right.projectId
  && left.operationId === right.operationId
  && left.runId === right.runId
  && left.targetTrack === right.targetTrack
  && left.ownerCapability === right.ownerCapability
  && left.mediaSha256 === right.mediaSha256
  && left.sourceDurationMs === right.sourceDurationMs
);

const pendingDeletedGenerationStartIntentExpired = (
  intent: PendingDeletedGenerationStartIntent,
  nowMs: number,
): boolean => intent.createdAtMs <= nowMs - PENDING_GENERATION_START_INTENT_MAX_AGE_MS;

/**
 * Validates a late response against the private write-ahead intent. The
 * caller has already schema-validated the Worker body, but this independent
 * check keeps a detached/stale tab from attaching a different signed run.
 */
const privatePendingStartRunAuthorization = (
  value: unknown,
  intent: PendingDeletedGenerationStartIntent,
  nowMs: number,
): { readonly run: ProjectRunCleanupAuthorization; readonly expiresAtMs: number } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const receipt = value as Readonly<Record<string, unknown>>;
  const signedRunReceipt = intent.targetTrack === "Captions"
    ? privateCredential(receipt.signedGenerationReceipt)
    : privateCredential(receipt.signedAudioDescriptionGenerationReceipt);
  const session = privateCredential(receipt.session);
  const retentionExpiresAtMs = receipt.retentionExpiresAtMs;
  if (
    receipt.version !== 1
    || receipt.runId !== intent.runId
    || receipt.projectId !== intent.projectId
    || signedRunReceipt === null
    || session === null
    || typeof receipt.projectOwnerCapability !== "string"
    || receipt.projectOwnerCapability.toLowerCase() !== intent.ownerCapability
    || typeof receipt.mediaSha256 !== "string"
    || receipt.mediaSha256.toLowerCase() !== intent.mediaSha256
    || receipt.sourceDurationMs !== intent.sourceDurationMs
    || !Number.isSafeInteger(retentionExpiresAtMs)
    || (retentionExpiresAtMs as number) <= nowMs
  ) return null;
  return {
    run: {
      targetTrack: intent.targetTrack,
      runId: intent.runId,
      signedRunReceipt,
      session,
    },
    expiresAtMs: retentionExpiresAtMs as number,
  };
};

const privateRunCleanupAuthorization = (
  value: unknown,
  project: CaptionProject,
  expectedRun: { readonly runId: string; readonly targetTrack: "Captions" | "AudioDescriptions" },
  ownerCapability: string,
  nowMs: number,
  terminalAction?: ProjectRunCleanupAuthorization["terminalAction"],
): { readonly run: ProjectRunCleanupAuthorization; readonly expiresAtMs: number } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const receipt = value as Readonly<Record<string, unknown>>;
  const signedRunReceipt = expectedRun.targetTrack === "Captions"
    ? privateCredential(receipt.signedGenerationReceipt)
    : privateCredential(receipt.signedAudioDescriptionGenerationReceipt);
  const session = privateCredential(receipt.session);
  const retentionExpiresAtMs = receipt.retentionExpiresAtMs;
  if (
    receipt.version !== 1
    || receipt.runId !== expectedRun.runId
    || receipt.projectId !== project.projectId
    || signedRunReceipt === null
    || session === null
    || typeof receipt.mediaSha256 !== "string"
    || receipt.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
    || receipt.sourceDurationMs !== project.media.durationMs
    || typeof receipt.projectOwnerCapability !== "string"
    || receipt.projectOwnerCapability.toLowerCase() !== ownerCapability
    || !Number.isSafeInteger(retentionExpiresAtMs)
    || (retentionExpiresAtMs as number) <= nowMs
  ) return null;
  return {
    run: {
      targetTrack: expectedRun.targetTrack,
      runId: expectedRun.runId,
      signedRunReceipt,
      session,
      ...(terminalAction === undefined ? {} : { terminalAction }),
    },
    expiresAtMs: retentionExpiresAtMs as number,
  };
};

/**
 * A local target lease can disappear as part of adoption or cancellation
 * before the server receives its terminal acknowledgement. Keep that intent
 * attached to the exact signed run, never infer it from a later upload row.
 */
const pendingTerminalRunAction = (
  value: Readonly<Record<string, unknown>>,
): ProjectRunCleanupAuthorization["terminalAction"] | undefined => {
  const adoption = value.adoption;
  if (typeof adoption === "object" && adoption !== null && !Array.isArray(adoption)) {
    const record = adoption as Readonly<Record<string, unknown>>;
    if (
      record.status === "adopted"
      && record.cleanupAcknowledgement === "pending"
      && Number.isSafeInteger(record.adoptedProjectRevision)
      && (record.adoptedProjectRevision as number) > 0
    ) return { kind: "acknowledge", action: "adopted", adoptedProjectRevision: record.adoptedProjectRevision as number };
  }
  // A future/historical client may retain a server-issued discard marker.
  // Accept only the exact static action vocabulary and never arbitrary body.
  const acknowledgement = value.terminalAcknowledgement;
  if (typeof acknowledgement === "object" && acknowledgement !== null && !Array.isArray(acknowledgement)) {
    const record = acknowledgement as Readonly<Record<string, unknown>>;
    if (record.action === "discarded" && record.cleanupAcknowledgement === "pending") {
      return { kind: "acknowledge", action: "discarded" };
    }
  }
  const terminal = value.terminalCleanup;
  if (typeof terminal === "object" && terminal !== null && !Array.isArray(terminal)) {
    const record = terminal as Readonly<Record<string, unknown>>;
    if (record.action === "cancelled" && record.cleanupAcknowledgement === "pending") return { kind: "cancel" };
  }
  if (typeof value.cancellationRequested === "object" && value.cancellationRequested !== null && !Array.isArray(value.cancellationRequested)) {
    if ((value.cancellationRequested as Readonly<Record<string, unknown>>).status === "requested") return { kind: "cancel" };
  }
  return undefined;
};

const privateTerminalRunCleanupAuthorization = (
  value: unknown,
  project: CaptionProject,
  runId: string,
  ownerCapability: string,
  nowMs: number,
): { readonly run: ProjectRunCleanupAuthorization; readonly expiresAtMs: number } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const receipt = value as Readonly<Record<string, unknown>>;
  const captionReceipt = privateCredential(receipt.signedGenerationReceipt);
  const audioDescriptionReceipt = privateCredential(receipt.signedAudioDescriptionGenerationReceipt);
  if ((captionReceipt === null) === (audioDescriptionReceipt === null)) return null;
  const terminalAction = pendingTerminalRunAction(receipt);
  if (terminalAction === undefined) return null;
  return privateRunCleanupAuthorization(
    receipt,
    project,
    { runId, targetTrack: captionReceipt === null ? "AudioDescriptions" : "Captions" },
    ownerCapability,
    nowMs,
    terminalAction,
  );
};

const privateUploadCleanupAuthorization = (
  project: CaptionProject,
  ownerCapability: string,
  nowMs: number,
): { readonly upload: ProjectUploadCleanupAuthorization; readonly expiresAtMs: number } | null => {
  let recovery: ReturnType<typeof loadPersistedCloudUpload>;
  try {
    recovery = loadPersistedCloudUpload(
      project.projectId,
      { sha256: project.media.sha256, durationMs: project.media.durationMs },
      undefined,
      ownerCapability,
    );
  } catch {
    // Browser storage can be unavailable after a tab is detached. Treat the
    // opaque upload receipt as absent; never guess a replacement capability.
    return null;
  }
  const session = privateCredential(recovery?.session);
  const operationReceipt = privateCredential(recovery?.operationReceipt);
  if (
    recovery === null
    || session === null
    || operationReceipt === null
    || !Number.isSafeInteger(recovery.sessionExpiresAtMs)
    || (recovery.sessionExpiresAtMs as number) <= nowMs
  ) return null;
  return {
    upload: {
      operationId: recovery.operationId,
      operationReceipt,
      session,
    },
    expiresAtMs: recovery.sessionExpiresAtMs as number,
  };
};

const cleanupAuthorizationFrom = (
  value: unknown,
): ProjectCloudCleanupAuthorization | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== 1
    || typeof record.ownerCapability !== "string"
    || !/^[0-9a-f]{64}$/i.test(record.ownerCapability)
    || !Number.isSafeInteger(record.expiresAtMs)
    || (record.expiresAtMs as number) <= 0
  ) return undefined;
  const runValue = record.run;
  const run = typeof runValue === "object" && runValue !== null && !Array.isArray(runValue)
    ? runValue as Readonly<Record<string, unknown>>
    : null;
  const uploadValue = record.upload;
  const upload = typeof uploadValue === "object" && uploadValue !== null && !Array.isArray(uploadValue)
    ? uploadValue as Readonly<Record<string, unknown>>
    : null;
  const terminalActionValue = run?.terminalAction;
  const terminalAction = typeof terminalActionValue === "object" && terminalActionValue !== null && !Array.isArray(terminalActionValue)
    ? terminalActionValue as Readonly<Record<string, unknown>>
    : null;
  const parsedTerminalAction: ProjectRunCleanupAuthorization["terminalAction"] | undefined = terminalAction?.kind === "cancel"
    ? { kind: "cancel" }
    : terminalAction?.kind === "acknowledge"
      && (terminalAction.action === "adopted" || terminalAction.action === "discarded")
      && (
        terminalAction.action === "discarded"
        || (Number.isSafeInteger(terminalAction.adoptedProjectRevision) && (terminalAction.adoptedProjectRevision as number) > 0)
      )
      ? {
        kind: "acknowledge",
        action: terminalAction.action,
        ...(terminalAction.adoptedProjectRevision === undefined ? {} : { adoptedProjectRevision: terminalAction.adoptedProjectRevision as number }),
      }
      : undefined;
  const parsedRun = run !== null
    && (run.targetTrack === "Captions" || run.targetTrack === "AudioDescriptions")
    && privateCredential(run.runId) !== null
    && privateCredential(run.signedRunReceipt) !== null
    && privateCredential(run.session) !== null
    ? {
      targetTrack: run.targetTrack,
      runId: privateCredential(run.runId)!,
      signedRunReceipt: privateCredential(run.signedRunReceipt)!,
      session: privateCredential(run.session)!,
      ...(parsedTerminalAction === undefined ? {} : { terminalAction: parsedTerminalAction }),
    } satisfies ProjectRunCleanupAuthorization
    : undefined;
  const parsedUpload = upload !== null
    && privateCredential(upload.operationId) !== null
    && privateCredential(upload.operationReceipt) !== null
    && privateCredential(upload.session) !== null
    ? {
      operationId: privateCredential(upload.operationId)!,
      operationReceipt: privateCredential(upload.operationReceipt)!,
      session: privateCredential(upload.session)!,
    } satisfies ProjectUploadCleanupAuthorization
    : undefined;
  if (parsedRun === undefined && parsedUpload === undefined) return undefined;
  return {
    version: 1,
    ownerCapability: record.ownerCapability.toLowerCase(),
    expiresAtMs: record.expiresAtMs as number,
    ...(parsedRun === undefined ? {} : { run: parsedRun }),
    ...(parsedUpload === undefined ? {} : { upload: parsedUpload }),
  };
};

/** Do not let UI/runtime fences retain or expose the durable raw capability. */
const projectInstanceCapabilityFingerprint = (projectId: string, capability: string): string =>
  canonicalHash("cuebench.web.project-instance-owner-capability-fingerprint.v1", { projectId, capability });

const emptySnapshot = (): ProjectStoreSnapshot => ({
  route: "start",
  project: null,
  mode: null,
  sourceObjectUrl: null,
  sourceProvenance: null,
  pendingUpload: null,
  activity: null,
  error: null,
  cleanupNotice: null,
});

interface PendingBackupImport {
  readonly originalEnvelope: unknown;
  readonly descriptor: ProjectImportDescriptor;
  readonly relinkFile: File | null;
  /** Exact canonical target visible to the Human at preview time, or null for a new local project. */
  readonly replacement: ReplacementImportExpectation | null;
}

const humanImportActor = { type: "Human" as const, id: "human" };

const browserStorageManager = (): BrowserStorageManager | null => {
  const storage = globalThis.navigator?.storage;
  if (storage?.estimate === undefined || storage.persist === undefined) return null;
  return {
    estimate: () => storage.estimate(),
    persist: () => storage.persist(),
  };
};

const readMode = (value: unknown): ProjectMode | null => {
  if (typeof value !== "object" || value === null || !("mode" in value)) return null;
  const mode = value.mode;
  return mode === "durable" || mode === "temporary" ? mode : null;
};

const readProjectId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return null;
  return typeof value.projectId === "string" && value.projectId.trim().length > 0 ? value.projectId : null;
};

const readOwnerToken = (value: unknown, projectId: string): string | null => {
  if (typeof value !== "object" || value === null || !("projectId" in value) || !("token" in value)) return null;
  return value.projectId === projectId && typeof value.token === "string" && value.token.length > 0 ? value.token : null;
};

const userFacingError = (error: unknown, fallback: string): string => error instanceof Error && error.message.length > 0
  ? error.message
  : fallback;

const isQuotaExceeded = (error: unknown): boolean => error instanceof Error && error.name === "QuotaExceededError";

const titleForFile = (file: File): string => file.name.trim().length > 0 ? file.name : "Local video";

/** Browser-canonical lifecycle with durable IndexedDB and truthful page-memory fallback. */
export class ProjectStore {
  private readonly database: CueBenchDatabase;
  private readonly storage: BrowserStorageManager | null;
  private readonly mediaDurationProbe: MediaDurationProbe;
  private readonly bundledSampleLoader: () => File | Promise<File>;
  private readonly beforeRestoreLoad: (() => Promise<void>) | undefined;
  private readonly cloudCleanup: CloudCleanupHook | undefined;
  private readonly cloudCleanupTimeoutMs: number;
  private readonly afterImportCommitted: (() => void) | undefined;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly ownedProjectTokens = new Map<string, string>();
  private pendingBackupImport: PendingBackupImport | null = null;
  private activeCleanupReceiptId: string | null = null;
  /** One browser store never sends overlapping hosted-cleanup requests for the same retained receipt. */
  private readonly cleanupOperations = new Map<string, Promise<CloudCleanupResult>>();
  private narrationPreviewGatewayInstance: NarrationPreviewGateway | null = null;
  private operationEpoch = 0;
  /**
   * Rotates only when this page replaces the logical project instance (for
   * example a same-id backup import whose non-portable capability rotates).
   * Regular domain revisions retain this epoch so queued commands can advance
   * a revision without losing their page-owned instance identity.
   */
  private projectInstanceEpoch = 0;
  /** One-way identity of the durable capability captured by this page. */
  private projectInstanceCapabilityFingerprint: string | null = null;
  /** Keeps page-originated domain writes ordered just like the durable CAS boundary. */
  private commandQueue: Promise<void> = Promise.resolve();

  public constructor(options: ProjectStoreOptions = {}) {
    this.database = options.database ?? new CueBenchDatabase();
    this.storage = options.browserStorage === undefined ? browserStorageManager() : options.browserStorage;
    this.mediaDurationProbe = options.mediaDurationProbe ?? probeVideoDuration;
    this.objectUrlLease = options.objectUrlLease ?? null;
    this.triedObjectUrlLease = options.objectUrlLease !== undefined;
    this.createId = options.createId ?? defaultCreateId;
    this.bundledSampleLoader = options.bundledSampleLoader ?? createBundledSampleFile;
    this.beforeRestoreLoad = options.beforeRestoreLoad;
    this.cloudCleanup = options.cloudCleanup;
    this.cloudCleanupTimeoutMs = Math.max(1, Math.trunc(options.cloudCleanupTimeoutMs ?? 5_000));
    this.afterImportCommitted = options.afterImportCommitted;
  }

  public getSnapshot = (): ProjectStoreSnapshot => this.snapshot;

  /** Internal bridge-only identity; it is never serialized into a tool result. */
  public getProjectInstanceEpoch = (): number => this.projectInstanceEpoch;

  /**
   * Internal bridge-only capability fence. The raw durable capability stays
   * in IndexedDB/private hosted ports; callers receive only its one-way
   * fingerprint and must never place it in a WebMCP result.
   */
  public getProjectInstanceFence = (): ProjectInstanceFence | null => {
    const project = this.snapshot.project;
    if (project === null) return null;
    return {
      projectId: project.projectId,
      projectInstanceEpoch: this.projectInstanceEpoch,
      ...(this.projectInstanceCapabilityFingerprint === null
        ? {}
        : { projectInstanceCapabilityFingerprint: this.projectInstanceCapabilityFingerprint }),
    };
  };

  /**
   * Binds every generation lease, recovery receipt, and adoption operation to
   * one exact page-visible project instance. This facade deliberately ignores
   * the generation clients' legacy project-id argument: only the captured
   * opaque fence can authorize its queued storage work.
   */
  public bindGenerationStore = (expectedProject: ProjectInstanceFence): BoundGenerationProjectStore => {
    const assertCurrent = (): void => this.assertExpectedProjectInstance(expectedProject);
    return {
      getSnapshot: () => {
        assertCurrent();
        const snapshot = this.getSnapshot();
        return { project: snapshot.project, mode: snapshot.mode };
      },
      executeCommand: (command) => this.executeCommand(command, expectedProject),
      persistCaptionGenerationReceipt: (runId, receipt) => this.persistCaptionGenerationReceipt(runId, receipt, expectedProject),
      deleteCaptionGenerationReceipt: (runId) => this.deleteCaptionGenerationReceipt(runId, expectedProject),
      reserveCaptionGenerationReceipt: (runId, reservation) => this.reserveCaptionGenerationReceipt(runId, reservation, expectedProject),
      releaseCaptionGenerationReceiptReservation: (runId) => this.releaseCaptionGenerationReceiptReservation(runId, expectedProject),
      // Deletion intentionally invalidates this page's visible fence. This
      // exceptional recovery bridge is instead fenced by the private
      // write-ahead intent captured before the POST, so it can attach a late
      // exact receipt without reviving the removed project instance.
      reconcileDeletedCaptionGenerationStart: (input) => this.reconcileDeletedGenerationStart(input),
      loadCaptionGenerationReceipt: (runId) => this.loadCaptionGenerationReceipt(runId, expectedProject),
      listCaptionGenerationReceiptRunIds: () => this.listCaptionGenerationReceiptRunIds(expectedProject),
      persistAudioDescriptionGenerationReceipt: (runId, receipt) => this.persistAudioDescriptionGenerationReceipt(runId, receipt, expectedProject),
      reserveAudioDescriptionGenerationReceipt: (runId, reservation) => this.reserveAudioDescriptionGenerationReceipt(runId, reservation, expectedProject),
      releaseAudioDescriptionGenerationReceiptReservation: (runId) => this.releaseAudioDescriptionGenerationReceiptReservation(runId, expectedProject),
      reconcileDeletedAudioDescriptionGenerationStart: (input) => this.reconcileDeletedGenerationStart(input),
      loadAudioDescriptionGenerationReceipt: (runId) => this.loadAudioDescriptionGenerationReceipt(runId, expectedProject),
      listAudioDescriptionGenerationReceiptRunIds: () => this.listAudioDescriptionGenerationReceiptRunIds(expectedProject),
      settleExpiredAudioDescriptionGenerationReceipt: (runId) => this.settleExpiredAudioDescriptionGenerationReceipt(runId, expectedProject),
      getCloudProjectOwnerCapability: (projectId) => this.getCloudProjectOwnerCapability(projectId, expectedProject),
      adoptStagedCaptionGenerationResult: (command) => this.adoptStagedCaptionGenerationResult(command, expectedProject),
      adoptStagedAudioDescriptionGenerationResult: (command) => this.adoptStagedAudioDescriptionGenerationResult(command, expectedProject),
    };
  };

  /**
   * Resolves the current non-portable project-instance capability directly
   * from IndexedDB before any cloud mutation. This is intentionally a fresh
   * durable read rather than a projectId-keyed localStorage value: a backup
   * import can atomically rotate the capability while an older tab remains
   * open with an obsolete opaque upload receipt.
   */
  public getCloudProjectOwnerCapability = async (projectId: string, expectedProject?: ProjectInstanceFence): Promise<string | null> => {
    this.assertExpectedProjectInstance(expectedProject);
    let observedReplacementFingerprint: string | null | undefined;
    return this.database.transaction("rw", [this.database.projectHeaders, this.database.settings], async () => {
      const header = await this.database.projectHeaders.get(projectId);
      if (header === undefined) return null;
      const existing = await this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId));
      const capability = readProjectInstanceOwnerCapability(existing?.value, projectId);
      if (!await this.isExpectedProjectInstanceDurablyAuthorized(projectId, expectedProject, (fingerprint) => {
        observedReplacementFingerprint = fingerprint;
      })) {
        this.reconcileProjectInstanceFenceMismatch(projectId, observedReplacementFingerprint);
        throw new ProjectInstanceFenceError();
      }
      if (capability !== null) return capability;
      // Compatibility migration for durable projects saved before this
      // capability existed. The record is born transactionally with the
      // project namespace and never reconstructed from localStorage.
      const value: ProjectInstanceOwnerCapability = {
        version: 1,
        projectId,
        capability: createProjectInstanceOwnerCapability(),
      };
      await this.database.settings.put({
        key: projectInstanceOwnerCapabilityKey(projectId),
        value,
        updatedAtMs: Date.now(),
      });
      return value.capability;
    });
  };

  /**
   * A stable browser-only gateway for disposable narration audio. It delegates
   * identity and stale-revision checks back to this canonical ProjectStore,
   * while the Worker remains the only OpenAI credential holder.
   */
  public getNarrationPreviewGateway = (): NarrationPreviewGateway => {
    if (this.narrationPreviewGatewayInstance !== null) return this.narrationPreviewGatewayInstance;
    this.narrationPreviewGatewayInstance = this.createNarrationPreviewGateway();
    return this.narrationPreviewGatewayInstance;
  };

  /**
   * Creates a one-invocation narration gateway tied to the exact visible
   * project instance captured by a Browser Agent tool. Unlike the Human UI
   * gateway above, this port carries the nonportable owner fence through
   * cache reads, cache writes, and hosted authorization.
   */
  public bindNarrationPreviewGateway = (expectedProject: ProjectInstanceFence): NarrationPreviewGateway => {
    this.assertExpectedProjectInstance(expectedProject);
    return this.createNarrationPreviewGateway(expectedProject);
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens a fresh real bundled Blob through the same storage decision as an upload. */
  public async openSample(): Promise<void> {
    const epoch = this.beginUserOperation("preparing");
    if (epoch === null) return;
    try {
      const file = await this.bundledSampleLoader();
      if (!this.isCurrent(epoch)) return;
      const inspected = await inspectLocalMedia(file, async () => BUNDLED_SAMPLE_DURATION_MS);
      if (!this.isCurrent(epoch)) return;
      await this.chooseStorageMode({
        file,
        durationMs: inspected.durationMs,
        projectId: `sample-${this.createId()}`,
        sourceId: `source-${this.createId()}`,
        title: "Gibbs free energy: a 90-second calibration",
        sourceProvenance: bundledFixtureSourceProvenance,
      }, epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not open the bundled Gibbs lesson."));
    }
  }

  /** Restores only verified durable projects. Temporary work is current-page memory by design. */
  public async restoreLastDurableProject(): Promise<void> {
    const epoch = this.beginRestore();
    if (epoch === null) return;
    try {
      await this.beforeRestoreLoad?.();
      if (!this.isCurrent(epoch)) return;
      await this.sweepLegacyTemporaryProjects(epoch);
      if (!this.isCurrent(epoch)) return;
      // Private pre-POST intents never represent a recoverable project. Sweep
      // abandoned tabs' capability-bearing entries before hydration can make
      // them linger indefinitely in browser storage.
      await this.database.transaction("rw", [this.database.settings], async () => {
        await this.sweepExpiredPendingGenerationStartIntents(Date.now());
      });
      if (!this.isCurrent(epoch)) return;

      const durableSetting = await loadSetting(this.database, lastDurableProjectKey);
      if (!this.isCurrent(epoch)) return;
      const durableProjectId = durableSetting === undefined ? null : readProjectId(durableSetting.value);
      if (durableProjectId !== null) {
        const result = await this.activateExistingProject(durableProjectId, "durable", epoch);
        if (result || !this.isCurrent(epoch)) return;
        this.failCurrentOperation(epoch, "CueBench could not restore the local media. Choose the video again to start a new project.");
        return;
      }

      this.completeToStart(epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not restore the local media."));
    }
  }

  public restoreLastProject(): Promise<void> {
    return this.restoreLastDurableProject();
  }

  public async chooseFile(file: File): Promise<void> {
    const epoch = this.beginUserOperation("preparing");
    if (epoch === null) return;
    try {
      const inspected = await inspectLocalMedia(file, this.mediaDurationProbe);
      if (!this.isCurrent(epoch)) return;
      await this.chooseStorageMode({
        file,
        durationMs: inspected.durationMs,
        projectId: `local-${this.createId()}`,
        sourceId: `source-${this.createId()}`,
        title: titleForFile(file),
        sourceProvenance: uploadedSourceProvenance,
      }, epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not open this video."));
    }
  }

  /** Continues from an explicit choice without writing the Blob to IndexedDB. */
  public async continueTemporarily(): Promise<void> {
    const pendingUpload = this.snapshot.pendingUpload;
    if (pendingUpload === null) return;
    const epoch = this.beginUserOperation("saving");
    if (epoch === null) return;
    await this.persistTemporaryUpload(pendingUpload, epoch);
  }

  public cancelPendingUpload(): void {
    if (this.snapshot.activity !== null) return;
    this.invalidateOperations();
    this.setSnapshot(emptySnapshot());
  }

  /**
   * The UI uses the same version-guarded reducer as WebMCP. Durable projects
   * commit through the IndexedDB CAS transaction; temporary projects retain the
   * exact command semantics in their explicitly in-memory session.
   */
  public executeCommand(command: DomainCommand, expectedProject?: string | ProjectInstanceFence): Promise<CommandResult> {
    const execute = async (): Promise<CommandResult> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode === null) {
        throw new Error("CueBench cannot edit a project before its media is available.");
      }
      if (snapshot.activity !== null) {
        throw new Error("CueBench cannot edit a project while another local operation is in progress.");
      }
      const expectedProjectId = typeof expectedProject === "string" ? expectedProject : expectedProject?.projectId;
      const expectedProjectInstanceEpoch = typeof expectedProject === "string"
        ? undefined
        : expectedProject?.projectInstanceEpoch;
      const expectedProjectInstanceCapabilityFingerprint = typeof expectedProject === "string"
        ? undefined
        : expectedProject?.projectInstanceCapabilityFingerprint;
      if (
        (expectedProjectId !== undefined && snapshot.project.projectId !== expectedProjectId)
        || (expectedProjectInstanceEpoch !== undefined && this.projectInstanceEpoch !== expectedProjectInstanceEpoch)
        || (
          expectedProjectInstanceCapabilityFingerprint !== undefined
          && this.projectInstanceCapabilityFingerprint !== expectedProjectInstanceCapabilityFingerprint
        )
      ) {
        return {
          project: snapshot.project,
          events: [],
          error: domainError("STALE_PROJECT", "The visible CueBench project was replaced before this command could run."),
        };
      }
      const projectId = snapshot.project.projectId;
      let observedReplacementFingerprint: string | null | undefined;
      try {
        const result = snapshot.mode === "durable"
          ? await executePersistentCommand(this.database, projectId, command, {
            ...(expectedProjectInstanceCapabilityFingerprint === undefined ? {} : {
              authorizeCommand: async () => {
                const setting = await this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId));
                const capability = readProjectInstanceOwnerCapability(setting?.value, projectId);
                const actualFingerprint = capability === null
                  ? null
                  : projectInstanceCapabilityFingerprint(projectId, capability);
                if (actualFingerprint !== expectedProjectInstanceCapabilityFingerprint) {
                  observedReplacementFingerprint = actualFingerprint;
                  return false;
                }
                return true;
              },
            }),
          })
          : applyCommand(snapshot.project, command);

        // Rejected durable writes can carry newer canonical state from the
        // transaction. Reconcile it before returning so the next UI command
        // never continues against an abandoned projection.
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({
            ...this.snapshot,
            project: result.project,
            error: result.error?.message ?? null,
          }, observedReplacementFingerprint === undefined ? {} : {
            // A same-id/same-revision import can otherwise leave this page's
            // old closure live. Rotate its local epoch only after the
            // transaction observed the persisted replacement capability.
            rotateProjectInstance: true,
            projectInstanceCapabilityFingerprint: observedReplacementFingerprint,
          });
        }
        return result;
      } catch (error) {
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({ ...this.snapshot, error: userFacingError(error, "CueBench could not apply this project command.") });
        }
        throw error;
      }
    };
    const queued = this.commandQueue.then(execute, execute);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * Caption evidence adoption additionally updates the locally persisted
   * signed run receipt. Keeping that work here prevents a React component
   * from accidentally splitting the expected-revision CAS across writes.
   */
  public adoptStagedCaptionGenerationResult(
    command: CaptionGenerationAdoptionCommand,
    expectedProject?: ProjectInstanceFence,
  ): Promise<CommandResult> {
    const execute = async (): Promise<CommandResult> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode === null) {
        throw new Error("CueBench cannot adopt caption evidence before its project is available.");
      }
      if (snapshot.activity !== null) {
        throw new Error("CueBench cannot adopt caption evidence while another local operation is in progress.");
      }
      if (snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can retain a recoverable caption-generation receipt.");
      }
      this.assertExpectedProjectInstance(expectedProject);
      const projectId = snapshot.project.projectId;
      let observedReplacementFingerprint: string | null | undefined;
      try {
        const result = await adoptPersistedCaptionGenerationResult(this.database, projectId, command, this.projectInstanceWriteOptions(
          projectId,
          expectedProject,
          (fingerprint) => { observedReplacementFingerprint = fingerprint; },
        ));
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({
            ...this.snapshot,
            project: result.project,
            error: result.error?.message ?? null,
          }, observedReplacementFingerprint === undefined ? {} : {
            rotateProjectInstance: true,
            projectInstanceCapabilityFingerprint: observedReplacementFingerprint,
          });
        }
        return result;
      } catch (error) {
        this.reconcileProjectInstanceFenceMismatch(projectId, observedReplacementFingerprint);
        if (expectedProject !== undefined && error instanceof StorageStaleWriteError) throw new ProjectInstanceFenceError();
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({ ...this.snapshot, error: userFacingError(error, "CueBench could not adopt the staged caption evidence.") });
        }
        throw error;
      }
    };
    const queued = this.commandQueue.then(execute, execute);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * Keeps target-aware AD adoption and its opaque cleanup receipt in one
   * IndexedDB transaction. Human certification remains a separate UI-only
   * decision; this only stages CueBench-AI Proposed beats and requirements.
   */
  public adoptStagedAudioDescriptionGenerationResult(
    command: AudioDescriptionGenerationAdoptionCommand,
    expectedProject?: ProjectInstanceFence,
  ): Promise<CommandResult> {
    const execute = async (): Promise<CommandResult> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode === null) {
        throw new Error("CueBench cannot adopt audio-description evidence before its project is available.");
      }
      if (snapshot.activity !== null) {
        throw new Error("CueBench cannot adopt audio-description evidence while another local operation is in progress.");
      }
      if (snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can retain a recoverable audio-description generation receipt.");
      }
      this.assertExpectedProjectInstance(expectedProject);
      const projectId = snapshot.project.projectId;
      let observedReplacementFingerprint: string | null | undefined;
      try {
        const result = await adoptPersistedAudioDescriptionGenerationResult(this.database, projectId, command, this.projectInstanceWriteOptions(
          projectId,
          expectedProject,
          (fingerprint) => { observedReplacementFingerprint = fingerprint; },
        ));
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({
            ...this.snapshot,
            project: result.project,
            error: result.error?.message ?? null,
          }, observedReplacementFingerprint === undefined ? {} : {
            rotateProjectInstance: true,
            projectInstanceCapabilityFingerprint: observedReplacementFingerprint,
          });
        }
        return result;
      } catch (error) {
        this.reconcileProjectInstanceFenceMismatch(projectId, observedReplacementFingerprint);
        if (expectedProject !== undefined && error instanceof StorageStaleWriteError) throw new ProjectInstanceFenceError();
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({ ...this.snapshot, error: userFacingError(error, "CueBench could not adopt the staged audio-description evidence.") });
        }
        throw error;
      }
    };
    const queued = this.commandQueue.then(execute, execute);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Persist the opaque signed recovery receipt before a browser polls it. */
  public persistCaptionGenerationReceipt(
    runId: string,
    receipt: unknown,
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    const persist = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can retain a recoverable caption-generation receipt.");
      }
      await this.runFencedReceiptOperation(snapshot.project.projectId, expectedProject, async (options) => {
        await this.database.transaction("rw", [this.database.runReceipts, this.database.settings], async () => {
          await saveRunReceipt(this.database, snapshot.project!.projectId, runId, { version: 1, payload: receipt }, options);
          // A successful normal local commit supersedes its pre-POST intent.
          // Remove the private owner material in the same transaction as the
          // receipt so project deletion cannot later misclassify it as an
          // unresolved start race.
          await this.deletePendingGenerationStartIntentsForRun(snapshot.project!.projectId, runId);
        });
      });
    };
    const queued = this.commandQueue.then(persist, persist);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Deletes one completed local caption receipt without touching hosted state. */
  public deleteCaptionGenerationReceipt(
    runId: string,
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    const snapshot = this.snapshot;
    const capturedProject = snapshot.project;
    const operationFence = expectedProject ?? this.getProjectInstanceFence();
    if (capturedProject === null || snapshot.mode !== "durable" || operationFence === null) {
      return Promise.reject(new Error("CueBench needs durable browser storage before it can delete a caption-generation receipt."));
    }
    const remove = async (): Promise<void> => {
      await this.runFencedReceiptOperation(capturedProject.projectId, operationFence, (options) => (
        deleteRunReceipt(this.database, capturedProject.projectId, runId, options)
      ));
    };
    const queued = this.commandQueue.then(remove, remove);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Reserve the exact opaque receipt row before a server-side generation start. */
  public reserveCaptionGenerationReceipt(
    runId: string,
    reservation?: PendingGenerationStartReservation,
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    const reserve = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can reserve a recoverable caption-generation receipt.");
      }
      if (reservation !== undefined && (reservation.projectId !== snapshot.project.projectId || reservation.runId !== runId)) {
        throw new Error("CueBench generation-start recovery intent did not match the current durable project.");
      }
      const reservedAtMs = Date.now();
      const intent = reservation === undefined ? undefined : pendingDeletedGenerationStartIntentFor(reservation, reservedAtMs);
      await this.runFencedReceiptOperation(snapshot.project.projectId, expectedProject, async (options) => {
        await this.database.transaction("rw", [this.database.runReceipts, this.database.settings], async () => {
          await this.sweepExpiredPendingGenerationStartIntents(reservedAtMs, snapshot.project!.projectId);
          await reserveRunReceiptSlot(this.database, snapshot.project!.projectId, runId, options);
          if (intent === undefined) return;
          const key = pendingGenerationStartIntentKey(intent.projectId, intent.operationId, intent.runId);
          const existing = await this.database.settings.get(key);
          const retained = pendingDeletedGenerationStartIntentFrom(existing?.value);
          if (retained !== null && !samePendingDeletedGenerationStartIntent(retained, intent)) {
            throw new Error("CueBench found a conflicting private generation-start recovery intent.");
          }
          if (retained === null) {
            await this.database.settings.put({ key, value: intent, updatedAtMs: Date.now() });
          }
        });
      });
    };
    const queued = this.commandQueue.then(reserve, reserve);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Release only an internal unfulfilled write-ahead reservation. */
  public releaseCaptionGenerationReceiptReservation(runId: string, expectedProject?: ProjectInstanceFence): Promise<void> {
    const release = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") return;
      await this.runFencedReceiptOperation(snapshot.project.projectId, expectedProject, async (options) => {
        await this.database.transaction("rw", [this.database.runReceipts, this.database.settings], async () => {
          await releaseRunReceiptReservation(this.database, snapshot.project!.projectId, runId, options);
          await this.deletePendingGenerationStartIntentsForRun(snapshot.project!.projectId, runId);
        });
      });
    };
    const queued = this.commandQueue.then(release, release);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Reads only the recovery receipt belonging to the currently visible project. */
  public async loadCaptionGenerationReceipt(runId: string, expectedProject?: ProjectInstanceFence): Promise<unknown | null> {
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode !== "durable") return null;
    const row = await this.runFencedReceiptOperation(snapshot.project.projectId, expectedProject, (options) => (
      loadRunReceipt(this.database, snapshot.project!.projectId, runId, options)
    ));
    return row?.receipt.version === 1 ? row.receipt.payload : null;
  }

  /** Lists opaque receipt ids so detached terminal cleanup can recover on reload. */
  public async listCaptionGenerationReceiptRunIds(expectedProject?: ProjectInstanceFence): Promise<readonly string[]> {
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode !== "durable") return [];
    return (await this.runFencedReceiptOperation(snapshot.project.projectId, expectedProject, (options) => (
      listRunReceipts(this.database, snapshot.project!.projectId, options)
    ))).map((row) => row.runId);
  }

  /**
   * AD receipts use the same project-scoped browser table as caption receipts,
   * but retain a distinct public surface so callers cannot accidentally treat
   * an AD capability as a caption capability. The opaque row is shared only at
   * this storage boundary; each client validates its own signed receipt shape.
   */
  public persistAudioDescriptionGenerationReceipt(
    runId: string,
    receipt: unknown,
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    return this.persistCaptionGenerationReceipt(runId, receipt, expectedProject);
  }

  /** Reserve an AD write-ahead receipt slot before a potentially billable dispatch. */
  public reserveAudioDescriptionGenerationReceipt(
    runId: string,
    reservation?: PendingGenerationStartReservation,
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    return this.reserveCaptionGenerationReceipt(runId, reservation, expectedProject);
  }

  /** Release only an unfulfilled AD receipt reservation. */
  public releaseAudioDescriptionGenerationReceiptReservation(runId: string, expectedProject?: ProjectInstanceFence): Promise<void> {
    return this.releaseCaptionGenerationReceiptReservation(runId, expectedProject);
  }

  /** Reads a project-scoped opaque AD recovery receipt. */
  public loadAudioDescriptionGenerationReceipt(runId: string, expectedProject?: ProjectInstanceFence): Promise<unknown | null> {
    return this.loadCaptionGenerationReceipt(runId, expectedProject);
  }

  /**
   * A successful start response can arrive after another tab deleted the
   * local project. This bridge never reconstructs a project or writes a run
   * receipt row; it captures only the exact private capability into the
   * already-committed deletion receipt, then starts exact cleanup.
   */
  public reconcileDeletedCaptionGenerationStart(input: DeletedGenerationStartRecovery): Promise<boolean> {
    return this.reconcileDeletedGenerationStart(input);
  }

  /** Target-specific alias keeps AD callers from treating caption recovery as interchangeable. */
  public reconcileDeletedAudioDescriptionGenerationStart(input: DeletedGenerationStartRecovery): Promise<boolean> {
    return this.reconcileDeletedGenerationStart(input);
  }

  /**
   * An expired signed AD receipt cannot authenticate remote cleanup, but its
   * matching local target lease still must not strand the project. Keeping
   * the release command and receipt lifecycle marker in one IndexedDB
   * transaction prevents a crash between those two durable facts.
   */
  public settleExpiredAudioDescriptionGenerationReceipt(runId: string, expectedProject?: ProjectInstanceFence): Promise<unknown | null> {
    const settle = async (): Promise<unknown | null> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") return null;
      const projectId = snapshot.project.projectId;
      const result = await this.runFencedReceiptOperation(projectId, expectedProject, (options) => (
        settlePersistedExpiredAudioDescriptionGenerationReceipt(this.database, projectId, runId, options)
      ));
      if (this.snapshot.project?.projectId === projectId) {
        this.setSnapshot({ ...this.snapshot, project: result.project, error: null });
      }
      return result.receipt;
    };
    const queued = this.commandQueue.then(settle, settle);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Lists opaque receipt ids for AD terminal-cleanup recovery after reload. */
  public listAudioDescriptionGenerationReceiptRunIds(expectedProject?: ProjectInstanceFence): Promise<readonly string[]> {
    return this.listCaptionGenerationReceiptRunIds(expectedProject);
  }

  /** Produces a portable manifest only; source video remains in browser storage and is never serialized. */
  public async exportProjectBackup(): Promise<ProjectBackupDownload> {
    const { project, freshnessNotice } = await this.freshProjectForSerialization();
    const backup = exportProjectBackupManifest(project, { exportedAtMs: Date.now() });
    return {
      filename: buildProjectBackupFilename(project.title),
      // Domain validates this exact compact representation against the shared
      // 10 MiB import envelope; pretty indentation would otherwise turn a
      // valid aggregate into a download the same browser refuses to import.
      text: JSON.stringify(backup),
      ...(freshnessNotice === null ? {} : { freshnessNotice }),
    };
  }

  /**
   * Export serialization is intentionally owned by the store rather than a
   * possibly stale React projection. A peer-tab edit becomes an explicit UI
   * refresh before round-trip verification can record its bytes.
   */
  public async prepareTrackExport(request: ProjectTrackExportRequest): Promise<ProjectTrackExport> {
    return (await this.prepareFreshTrackExport(request)).prepared;
  }

  public async prepareFreshTrackExport(request: ProjectTrackExportRequest): Promise<FreshProjectTrackExport> {
    const { project, freshnessNotice } = await this.freshProjectForSerialization(request.project.projectId);
    if (project.projectId !== request.project.projectId) {
      throw new Error("CueBench project identity changed before export. Review the current project and try again.");
    }
    return {
      project,
      prepared: prepareDomainTrackExport({ ...request, project }),
      freshnessNotice,
    };
  }

  /** Parses and previews an import without changing local storage. This UI-only boundary always supplies Human provenance. */
  public async previewBackupText(text: string): Promise<ProjectImportDescriptor> {
    const originalEnvelope = parseBoundedBackupJson(text);
    const visibleProject = this.snapshot.project;
    const replacement = visibleProject === null
      ? null
      : await this.freshProjectForSerialization(visibleProject.projectId);
    this.pendingBackupImport = null;
    const descriptor = previewProjectImport(originalEnvelope, {
      actor: humanImportActor,
      ...(replacement === null ? {} : { replaceProject: replacement.project }),
      migration: describeImportedProject,
    });
    this.pendingBackupImport = {
      originalEnvelope: structuredClone(originalEnvelope),
      descriptor,
      relinkFile: null,
      replacement: replacement === null ? null : {
        projectId: replacement.project.projectId,
        projectRevision: replacement.project.projectRevision,
        projectHash: importReplacementHash(replacement.project),
        mode: this.snapshot.mode ?? "durable",
      },
    };
    return descriptor;
  }

  /** Recomputes the pure preview after hashing the selected local video; a mismatch can never enable import. */
  public async relinkImportedMedia(file: File): Promise<ProjectImportDescriptor> {
    const pending = this.pendingBackupImport;
    if (pending === null || pending.descriptor.mode !== "preview") {
      throw new Error("Preview a compatible project backup before selecting media to relink.");
    }
    const [inspected, sha256] = await Promise.all([
      inspectLocalMedia(file, this.mediaDurationProbe),
      hashLocalMedia(file),
    ]);
    const descriptor = previewProjectImport(pending.originalEnvelope, {
      actor: humanImportActor,
      ...(pending.descriptor.replacementSafetyBackup === null
        ? {}
        : { replaceProject: pending.descriptor.replacementSafetyBackup.backup.project }),
      migration: describeImportedProject,
      relinkedMedia: {
        sourceId: `import-source-${this.createId()}`,
        sha256,
        durationMs: inspected.durationMs,
      },
    });
    this.pendingBackupImport = { ...pending, descriptor, relinkFile: file };
    return descriptor;
  }

  /**
   * Commits a previewed import only after a second hash check, all required
   * safety backups, and the Human dialog confirmation. Browser Agent tools
   * do not receive this method or a configurable actor parameter.
   */
  public async importPreviewedBackup(): Promise<ImportedProjectResult> {
    const initiallyPending = this.pendingBackupImport;
    const initiallySnapshot = this.snapshot;
    if (
      initiallyPending === null
      || initiallyPending.descriptor.mode !== "preview"
      || initiallyPending.relinkFile === null
      || !initiallyPending.descriptor.canImport
      || initiallySnapshot.activity !== null
    ) {
      throw new Error("CueBench needs a compatible preview and a SHA-256-verified media relink before import.");
    }

    this.invalidateOperations();
    const importEpoch = this.operationEpoch;
    this.setSnapshot({ ...initiallySnapshot, activity: "importing", error: null, cleanupNotice: null });
    try {
      /** Let any already-started persistent command settle before replacing its project namespace. */
      await this.commandQueue;
      if (!this.isCurrent(importEpoch)) throw new Error("CueBench stopped this import before it could commit.");
      const current = this.snapshot;
      const pending = this.pendingBackupImport;
      if (pending === null || pending.descriptor.mode !== "preview" || pending.relinkFile === null) {
        throw new Error("CueBench's import preview changed before confirmation. Preview the backup again.");
      }
      const replacementProject = await this.canonicalReplacementForImport(pending, current);
      const relinkFile = pending.relinkFile;

      const [inspected, sha256] = await Promise.all([
        inspectLocalMedia(relinkFile, this.mediaDurationProbe),
        hashLocalMedia(relinkFile),
      ]);
      if (!this.isCurrent(importEpoch)) throw new Error("CueBench stopped this import before it could commit.");
      const exactPreview = previewProjectImport(pending.originalEnvelope, {
        actor: humanImportActor,
        ...(replacementProject === null ? {} : { replaceProject: replacementProject }),
        migration: describeImportedProject,
        relinkedMedia: {
          sourceId: pending.descriptor.project.media.sourceId,
          sha256,
          durationMs: inspected.durationMs,
        },
      });
      if (exactPreview.mode !== "preview" || !exactPreview.canImport || exactPreview.mediaRelink.status !== "verified") {
        throw new Error("The selected media no longer matches the SHA-256 recorded by this backup. Choose the original source video again.");
      }
      const objectUrlLease = this.activeObjectUrlLease();
      if (objectUrlLease === undefined) {
        throw new LocalMediaError("object-url-unavailable", "This browser cannot safely preview the relinked local media.");
      }

      const importedProject = exactPreview.project;
      const backupId = this.createId();
      // A portable backup never imports browser authority. Generate the next
      // project-instance capability before entering the Dexie transaction and
      // persist it with the replacement rows, so an old tab's local receipt
      // cannot be accepted after the imported project becomes authoritative.
      const importedProjectOwnerCapability: ProjectInstanceOwnerCapability = {
        version: 1,
        projectId: importedProject.projectId,
        capability: createProjectInstanceOwnerCapability(),
      };
      /** The SHA-256 was recomputed immediately above; write its immutable binding within the same local transaction. */
      const verifiedMediaRow: SourceBlobRow = {
        key: sourceBlobKey(importedProject.projectId, importedProject.media.sha256),
        projectId: importedProject.projectId,
        sourceId: importedProject.media.sourceId,
        sha256: importedProject.media.sha256,
        blob: relinkFile,
        byteLength: relinkFile.size,
        contentType: relinkFile.type,
        fileName: relinkFile.name,
        savedAtMs: Date.now(),
      };
      /** Candidate media stays live only after both its second hash and durable transaction succeed. */
      const preparedObjectUrl = objectUrlLease.prepare(relinkFile);
      try {
        await this.database.transaction(
          "rw",
          [
            this.database.projectHeaders,
            this.database.items,
            this.database.revisions,
            this.database.findings,
            this.database.evidence,
            this.database.courtRecord,
            this.database.certifications,
            this.database.sourceBlobs,
            this.database.narrationBlobs,
            this.database.runReceipts,
            this.database.settings,
          ],
          async () => {
            const existingTarget = await this.database.projectHeaders.get(importedProject.projectId);
            let exactReplacement: CaptionProject | null = null;
            if (pending.replacement !== null && pending.replacement.mode === "durable") {
              const expected = pending.replacement;
              const header = await this.database.projectHeaders.get(expected.projectId);
              const canonical = header === undefined ? undefined : await loadProjectInTransaction(this.database, expected.projectId);
              if (
                header === undefined
                || canonical === undefined
                || header.projectRevision !== expected.projectRevision
                || canonical.projectRevision !== expected.projectRevision
                || importReplacementHash(canonical) !== expected.projectHash
              ) {
                throw new Error("CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again before importing.");
              }
              exactReplacement = canonical;
              if (existingTarget !== undefined && importedProject.projectId !== expected.projectId) {
                throw new Error("CueBench cannot overwrite another local project while importing this backup.");
              }
            } else if (pending.replacement !== null) {
              /**
               * A temporary page-memory project normally has no durable
               * namespace. Recheck that exact id inside this transaction:
               * another tab may have imported it while this tab was waiting
               * for a Human relink confirmation.
               */
              const temporaryReplacement = pending.replacement;
              const [durableHeader, durableMode] = await Promise.all([
                this.database.projectHeaders.get(temporaryReplacement.projectId),
                this.database.settings.get(projectModeKey(temporaryReplacement.projectId)),
              ]);
              if (durableHeader !== undefined || readMode(durableMode?.value) === "durable") {
                throw new Error("CueBench's temporary replacement project was saved durably after this preview. Preview the backup again before importing.");
              }
              exactReplacement = replacementProject;
              if (existingTarget !== undefined) {
                throw new Error("CueBench cannot overwrite another local project while importing this backup.");
              }
            } else if (existingTarget !== undefined) {
              throw new Error("CueBench cannot overwrite a project created after this import preview. Preview the backup again.");
            }

            /** Recovery snapshots are built from the exact canonical target observed by the transaction, never a stale React projection. */
            await this.database.settings.put({
              key: importSafetyBackupKey(importedProject.projectId, backupId),
              value: exactPreview.safetyBackup,
              updatedAtMs: Date.now(),
            });
            if (exactReplacement !== null) {
              await this.database.settings.put({
                key: replacementSafetyBackupKey(exactReplacement.projectId, backupId),
                value: {
                  projectId: exactReplacement.projectId,
                  backup: exportProjectBackupManifest(exactReplacement),
                },
                updatedAtMs: Date.now(),
              });
              await this.deleteProjectRows(exactReplacement.projectId);
              /** Keep the just-written recovery copies during an import replacement. */
              await this.deleteProjectSettings(exactReplacement.projectId, false);
            }
            await initializeProject(this.database, importedProject);
            await this.database.sourceBlobs.add(verifiedMediaRow);
            await this.database.settings.put({ key: projectModeKey(importedProject.projectId), value: { mode: "durable" }, updatedAtMs: Date.now() });
            await this.database.settings.put({
              key: projectInstanceOwnerCapabilityKey(importedProject.projectId),
              value: importedProjectOwnerCapability,
              updatedAtMs: Date.now(),
            });
            await this.database.settings.put({ key: projectSourceProvenanceKey(importedProject.projectId), value: uploadedSourceProvenance, updatedAtMs: Date.now() });
            await this.database.settings.put({ key: lastDurableProjectKey, value: { projectId: importedProject.projectId }, updatedAtMs: Date.now() });
          },
        );
      } catch (error) {
        preparedObjectUrl.revoke();
        throw error;
      }

      if (!this.isCurrent(importEpoch)) {
        preparedObjectUrl.revoke();
        throw new Error("CueBench stopped this import after local storage committed. Reopen the project to continue from the durable copy.");
      }

      /** No await is permitted after this point: storage is committed, so the UI always advances to the same verified media URL. */
      let postCommitIssue: string | null = null;
      try {
        this.afterImportCommitted?.();
      } catch (error) {
        postCommitIssue = userFacingError(error, "CueBench recovered the imported project after a UI update fault.");
      }
      const sourceObjectUrl = objectUrlLease.adopt(preparedObjectUrl);
      const cleanupNotice = "Imported project is stored in this browser. The selected local video was verified through Media Relink before replacement.";
      this.pendingBackupImport = null;
      this.setSnapshot({
        route: "workbench",
        project: importedProject,
        mode: "durable",
        sourceObjectUrl,
        sourceProvenance: uploadedSourceProvenance,
        pendingUpload: null,
        activity: null,
        error: postCommitIssue === null ? null : `Imported project recovered locally: ${postCommitIssue}`,
        cleanupNotice,
      }, {
        rotateProjectInstance: true,
        projectInstanceCapabilityFingerprint: projectInstanceCapabilityFingerprint(
          importedProject.projectId,
          importedProjectOwnerCapability.capability,
        ),
      });
      return { project: importedProject, cleanupNotice };
    } catch (error) {
      if (this.snapshot.activity === "importing") {
        this.setSnapshot({ ...this.snapshot, activity: null, error: userFacingError(error, "CueBench could not import this backup.") });
      }
      throw error;
    }
  }

  /** Deletes browser records atomically, then reports hosted cleanup honestly instead of treating a request as success. */
  public async deleteCurrentProject(): Promise<ProjectDeletionResult> {
    const initial = this.snapshot;
    if (initial.project === null || initial.mode === null || initial.activity !== null) {
      throw new Error("CueBench cannot delete a project while it is unavailable or another local operation is in progress.");
    }
    this.invalidateOperations();
    this.pendingBackupImport = null;
    this.setSnapshot({ ...initial, activity: "deleting", error: null, cleanupNotice: null });
    try {
      /** No new commands may begin after the deleting state is published. */
      await this.commandQueue;
      const current = this.snapshot;
      if (current.project === null || current.mode === null) throw new Error("CueBench project state changed before deletion could begin.");

      let deletionReceipt: DeletionReceipt | null = null;
      if (current.mode === "durable") {
        await this.database.transaction(
          "rw",
          [
            this.database.projectHeaders,
            this.database.items,
            this.database.revisions,
            this.database.findings,
            this.database.evidence,
            this.database.courtRecord,
            this.database.certifications,
            this.database.sourceBlobs,
            this.database.narrationBlobs,
            this.database.runReceipts,
            this.database.settings,
          ],
          async () => {
            const canonical = await loadProjectInTransaction(this.database, current.project!.projectId);
            if (canonical === undefined) {
              throw new Error("CueBench's project was already removed by another browser tab.");
            }
            const baseReceipt = this.newDeletionReceipt(canonical);
            const authorization = await this.captureDeletionCleanupAuthorization(
              canonical,
              baseReceipt.createdAtMs,
              baseReceipt.expiresAtMs,
            );
            // A browser-held run/upload receipt can expire before the outer
            // 24-hour cleanup backstop. The deletion record is therefore
            // usable only until the earlier boundary; once it expires every
            // private authorization is atomically scrubbed below.
            deletionReceipt = authorization === undefined
              ? baseReceipt
              : {
                ...baseReceipt,
                expiresAtMs: Math.min(baseReceipt.expiresAtMs, authorization.expiresAtMs),
                authorization,
              };
            // A start POST may already be durable while only its internal
            // receipt reservation exists locally. Preserve a tiny, exact
            // project/operation/run intent before the project rows disappear
            // so a late signed response can cancel that run rather than
            // restoring a deleted project to persist its receipt.
            await this.attachPendingGenerationStartsToDeletionReceipt(canonical, deletionReceipt);
            await this.deleteProjectRows(canonical.projectId);
            await this.deleteProjectSettings(canonical.projectId, true);
            const durablePointer = await this.database.settings.get(lastDurableProjectKey);
            if (readProjectId(durablePointer?.value) === canonical.projectId) {
              await this.database.settings.delete(lastDurableProjectKey);
            }
            await this.database.settings.put({
              key: deletionReceiptKey(deletionReceipt.projectId, deletionReceipt.receiptId),
              value: deletionReceipt,
              updatedAtMs: Date.now(),
            });
          },
        );
      } else {
        deletionReceipt = this.newDeletionReceipt(current.project);
        await this.database.settings.put({
          key: deletionReceiptKey(deletionReceipt.projectId, deletionReceipt.receiptId),
          value: deletionReceipt,
          updatedAtMs: Date.now(),
        });
      }

      if (deletionReceipt === null) throw new Error("CueBench could not retain the local deletion receipt.");
      // A committed deletion receipt is the only durable cleanup history. It
      // replaces every project-scoped upload copy, including a stale duplicate
      // left behind when a terminal run acknowledgement—not upload cleanup—
      // owns this deletion. Clearing only after the transaction commits keeps
      // a crash from erasing the last recovery path.
      try { clearPersistedCloudUpload(deletionReceipt.projectId); } catch { /* localStorage is best-effort */ }
      this.objectUrlLease?.revoke();
      const cloudCleanup: CloudCleanupResult = {
        status: "pending",
        message: "Cloud cleanup is pending lifecycle enforcement; CueBench will record the hosted result when it is confirmed.",
      };
      const cleanupNotice = `Local project copy deleted. ${cloudCleanup.message}`;
      this.activeCleanupReceiptId = deletionReceipt.receiptId;
      this.setSnapshot({ ...emptySnapshot(), cleanupNotice });
      void this.runCloudCleanupInBackground(deletionReceipt);
      return { localDeleted: true, cloudCleanup, cleanupNotice, receiptId: deletionReceipt.receiptId };
    } catch (error) {
      if (this.snapshot.activity === "deleting") {
        this.setSnapshot({ ...this.snapshot, activity: null, error: userFacingError(error, "CueBench could not delete this local project.") });
      }
      throw error;
    }
  }

  /** Lets a future lifecycle surface retry a retained hosted-cleanup receipt without recreating local project data. */
  public async retryCloudCleanup(receiptId: string): Promise<CloudCleanupResult> {
    const active = this.cleanupOperations.get(receiptId);
    if (active !== undefined) return active;
    const receipt = await this.findDeletionReceipt(receiptId);
    if (receipt === null) throw new Error("CueBench could not find that local deletion receipt.");
    this.activeCleanupReceiptId = receipt.receiptId;
    if (receipt.state === "deleted") return this.cloudCleanupResultFor(receipt);
    return this.completeCloudCleanup(receipt);
  }

  /**
   * A redacted projection for the Human start surface. It intentionally keeps
   * opaque hosted authorizations, object keys, and provider error bodies out
   * of React state and WebMCP-visible project data.
   */
  public async listCloudCleanupReceipts(nowMs = Date.now()): Promise<readonly CloudCleanupStatusEntry[]> {
    await this.database.transaction("rw", [this.database.settings], async () => {
      await this.sweepExpiredPendingGenerationStartIntents(nowMs);
    });
    let settings = await this.database.settings.toArray();
    let receipts = settings
      .map((setting) => this.deletionReceiptFrom(setting.value))
      .filter((receipt): receipt is DeletionReceipt => receipt !== null);
    const expired = receipts
      .filter((receipt) => receipt.state !== "deleted" && receipt.expiresAtMs <= nowMs);
    // Merely reopening a detached tab must not keep a signed session/run
    // receipt in IndexedDB after we publicly call it lifecycle-pending.
    // Each helper transaction drops all private authorization atomically.
    if (expired.length > 0) {
      await Promise.all(expired.map(async (receipt) => { await this.expireCloudCleanupReceipt(receipt); }));
      settings = await this.database.settings.toArray();
      receipts = settings
        .map((setting) => this.deletionReceiptFrom(setting.value))
        .filter((receipt): receipt is DeletionReceipt => receipt !== null);
    }
    return receipts
      .map((receipt): CloudCleanupStatusEntry => ({
        receiptId: receipt.receiptId,
        state: receipt.state === "deleted"
          ? "deleted"
          : receipt.state === "lifecycle-pending" || receipt.expiresAtMs <= nowMs
            ? "lifecycle-pending"
            : "deleting",
        message: receipt.state === "deleted"
          ? "CueBench confirmed private cloud cleanup."
          : receipt.state === "lifecycle-pending" || receipt.expiresAtMs <= nowMs
            ? expiredCloudCleanupMessage
            : receipt.state === "failed"
              ? "CueBench could not confirm private cloud cleanup yet. Retry this exact protected cleanup before the lifecycle backstop."
              : "CueBench requested private cloud cleanup and is waiting for confirmation.",
        attempts: receipt.attempts,
      }))
      .sort((left, right) => right.receiptId.localeCompare(left.receiptId));
  }

  /** Cancels stale async continuations and releases the only live local-media URL. */
  public dispose(): void {
    this.invalidateOperations();
    this.pendingBackupImport = null;
    this.activeCleanupReceiptId = null;
    this.objectUrlLease?.revokePrepared();
    this.objectUrlLease?.revoke();
    if (this.snapshot.route !== "start" || this.snapshot.sourceObjectUrl !== null || this.snapshot.activity !== null) {
      this.setSnapshot(emptySnapshot());
    }
  }

  /** Reads the durable aggregate after page commands settle, never serializing an abandoned peer-tab projection. */
  private async freshProjectForSerialization(expectedProjectId?: string): Promise<{ readonly project: CaptionProject; readonly freshnessNotice: string | null }> {
    await this.commandQueue;
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode === null) {
      throw new Error("CueBench cannot serialize a project before its media is available.");
    }
    if (expectedProjectId !== undefined && snapshot.project.projectId !== expectedProjectId) {
      throw new Error("CueBench project identity changed before serialization. Review the current project and try again.");
    }
    if (snapshot.mode !== "durable") return { project: snapshot.project, freshnessNotice: null };

    const canonical = await loadProject(this.database, snapshot.project.projectId);
    if (canonical === undefined) {
      throw new Error("CueBench's durable project was removed before it could be serialized.");
    }
    const stale = canonical.projectRevision !== snapshot.project.projectRevision
      || importReplacementHash(canonical) !== importReplacementHash(snapshot.project);
    if (!stale) return { project: canonical, freshnessNotice: null };

    const freshnessNotice = "This project changed in another browser tab. CueBench refreshed to its durable revision before serialization.";
    if (this.snapshot.project?.projectId === canonical.projectId && this.snapshot.mode === "durable") {
      this.setSnapshot({ ...this.snapshot, project: canonical, error: freshnessNotice });
    }
    return { project: canonical, freshnessNotice };
  }

  /** Rechecks the immutable preview target before hashing/relink work and again inside the write transaction. */
  private async canonicalReplacementForImport(
    pending: PendingBackupImport,
    snapshot: ProjectStoreSnapshot,
  ): Promise<CaptionProject | null> {
    const expected = pending.replacement;
    if (expected === null) return null;
    if (
      snapshot.project === null
      || snapshot.mode !== expected.mode
      || snapshot.project.projectId !== expected.projectId
    ) {
      throw new Error("CueBench's replacement project changed before import. Preview the backup again.");
    }
    if (expected.mode === "temporary") {
      if (
        snapshot.project.projectRevision !== expected.projectRevision
        || importReplacementHash(snapshot.project) !== expected.projectHash
      ) {
        throw new Error("CueBench's replacement project changed before import. Preview the backup again.");
      }
      return snapshot.project;
    }
    const canonical = await loadProject(this.database, expected.projectId);
    if (
      canonical === undefined
      || canonical.projectRevision !== expected.projectRevision
      || importReplacementHash(canonical) !== expected.projectHash
    ) {
      if (this.snapshot.project?.projectId === expected.projectId) {
        this.setSnapshot({
          ...this.snapshot,
          ...(canonical === undefined ? {} : { project: canonical }),
          error: "CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again.",
        });
      }
      throw new Error("CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again.");
    }
    return canonical;
  }

  private async chooseStorageMode(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    const durable = await this.hasDurableStorage(pendingUpload.file.size);
    if (!this.isCurrent(epoch)) return;
    if (durable) {
      this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
      await this.persistDurableUpload(pendingUpload, epoch);
      return;
    }
    this.offerTemporaryChoice(pendingUpload, epoch, null);
  }

  private async persistTemporaryUpload(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) {
      this.failCurrentOperation(epoch, "This browser cannot safely preview local media.");
      return;
    }

    try {
      const sha256 = await hashLocalMedia(pendingUpload.file);
      if (!this.isCurrent(epoch)) return;
      const project = createProject({
        projectId: pendingUpload.projectId,
        title: pendingUpload.title,
        media: {
          sourceId: pendingUpload.sourceId,
          sha256,
          durationMs: pendingUpload.durationMs,
          relinkState: "TemporarySession",
        },
        ...(pendingUpload.sourceProvenance.sourceKind === "bundled-fixture"
          ? { audioDescriptionGaps: BUNDLED_SAMPLE_AUDIO_DESCRIPTION_GAPS }
          : {}),
      });
      const sourceObjectUrl = objectUrlLease.replace(pendingUpload.file);
      this.setSnapshot({
        route: "workbench",
        project,
        mode: "temporary",
        sourceObjectUrl,
        sourceProvenance: pendingUpload.sourceProvenance,
        pendingUpload: null,
        activity: null,
        error: null,
        cleanupNotice: null,
      });
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not prepare this temporary project."));
    }
  }

  private async persistDurableUpload(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) {
      this.failCurrentOperation(epoch, "This browser cannot safely preview local media.");
      return;
    }

    let objectUrl: string | null = null;
    let previousDurableProjectId: string | null = null;
    let ownershipClaimed = false;
    try {
      previousDurableProjectId = await this.readLastDurableProjectId();
      if (!this.isCurrent(epoch)) return;
      const instanceCapability = await this.claimProjectOwnership(pendingUpload.projectId);
      ownershipClaimed = true;
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      const media = await ingestLocalMedia({
        database: this.database,
        projectId: pendingUpload.projectId,
        sourceId: pendingUpload.sourceId,
        file: pendingUpload.file,
        probeDuration: async () => pendingUpload.durationMs,
      });
      this.assertPersistedMedia(pendingUpload, media);
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      const project = createProject({
        projectId: pendingUpload.projectId,
        title: pendingUpload.title,
        media: {
          sourceId: media.sourceId,
          sha256: media.sha256,
          durationMs: media.durationMs,
          relinkState: "Linked",
        },
        ...(pendingUpload.sourceProvenance.sourceKind === "bundled-fixture"
          ? { audioDescriptionGaps: BUNDLED_SAMPLE_AUDIO_DESCRIPTION_GAPS }
          : {}),
      });
      await initializeProject(this.database, project);
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      // The fresh write was schema-validated and already SHA-256 checked by storage.
      objectUrl = objectUrlLease.replace(media.blob);
      await this.persistSourceProvenance(pendingUpload.projectId, pendingUpload.sourceProvenance);
      await this.persistMode(pendingUpload.projectId, "durable");
      if (!this.isCurrent(epoch)) {
        objectUrlLease.revokeIfCurrent(objectUrl);
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
        return;
      }
      await this.rememberDurableProject(pendingUpload.projectId);
      if (!this.isCurrent(epoch)) {
        objectUrlLease.revokeIfCurrent(objectUrl);
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
        return;
      }
      this.ownedProjectTokens.delete(pendingUpload.projectId);
      this.setSnapshot({
        route: "workbench",
        project,
        mode: "durable",
        sourceObjectUrl: objectUrl,
        sourceProvenance: pendingUpload.sourceProvenance,
        pendingUpload: null,
        activity: null,
        error: null,
        cleanupNotice: null,
      }, {
        projectInstanceCapabilityFingerprint: projectInstanceCapabilityFingerprint(pendingUpload.projectId, instanceCapability),
      });
    } catch (error) {
      if (objectUrl !== null) objectUrlLease.revokeIfCurrent(objectUrl);
      if (ownershipClaimed) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
      }
      if (!this.isCurrent(epoch)) return;
      if (isQuotaExceeded(error)) {
        this.offerTemporaryChoice(
          pendingUpload,
          epoch,
          "The browser ran out of durable storage. Continue temporarily or choose another video.",
        );
        return;
      }
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not save this video."));
    }
  }

  private assertPersistedMedia(pendingUpload: PendingUpload, media: IngestedLocalMedia): void {
    if (
      media.projectId !== pendingUpload.projectId
      || media.sourceId !== pendingUpload.sourceId
      || media.byteLength !== pendingUpload.file.size
      || media.blob.size !== pendingUpload.file.size
      || media.contentType !== pendingUpload.file.type
    ) {
      throw new Error("CueBench could not verify the saved local media binding.");
    }
  }

  private async activateExistingProject(projectId: string, expectedMode: ProjectMode, epoch: number): Promise<boolean> {
    const [project, mode, sourceProvenanceSetting, instanceCapability] = await Promise.all([
      loadProject(this.database, projectId),
      loadProjectMode(this.database, projectId),
      loadSetting(this.database, projectSourceProvenanceKey(projectId)),
      this.getCloudProjectOwnerCapability(projectId),
    ]);
    if (!this.isCurrent(epoch) || project === undefined || mode !== expectedMode || instanceCapability === null) return false;
    const sourceProvenance = sourceProvenanceSetting === undefined
      ? uploadedSourceProvenance
      : sourceProvenanceFrom(sourceProvenanceSetting.value) ?? uploadedSourceProvenance;
    let media: Awaited<ReturnType<typeof loadSourceMedia>>;
    try {
      media = await loadSourceMedia(this.database, projectId, project.media.sha256);
    } catch {
      return false;
    }
    if (!this.isCurrent(epoch) || media === undefined) return false;
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) throw new LocalMediaError("object-url-unavailable", "This browser cannot safely preview local media.");
    // No await follows this epoch check, so a stale restore cannot replace a newer object URL.
    const sourceObjectUrl = objectUrlLease.replace(media.blob);
    this.setSnapshot({
      route: "workbench",
      project,
      mode,
      sourceObjectUrl,
      sourceProvenance,
      pendingUpload: null,
      activity: null,
      error: null,
      cleanupNotice: null,
    }, {
      projectInstanceCapabilityFingerprint: projectInstanceCapabilityFingerprint(projectId, instanceCapability),
    });
    return true;
  }

  private async hasDurableStorage(sourceBytes: number): Promise<boolean> {
    if (this.storage === null) return false;
    try {
      const [estimate, persisted] = await Promise.all([this.storage.estimate(), this.storage.persist()]);
      const quota = estimate.quota;
      const usage = estimate.usage ?? 0;
      return persisted && quota !== undefined && quota - usage >= sourceBytes + metadataReserveBytes;
    } catch {
      return false;
    }
  }

  /** Claims a unique persistent owner before writing media, so a losing tab cannot roll back another tab. */
  private async claimProjectOwnership(projectId: string): Promise<string> {
    const token = this.createId();
    const instanceCapability: ProjectInstanceOwnerCapability = {
      version: 1,
      projectId,
      capability: createProjectInstanceOwnerCapability(),
    };
    try {
      await this.database.transaction("rw", [this.database.projectHeaders, this.database.settings], async () => {
        const [existingProject, existingOwner, existingInstanceCapability] = await Promise.all([
          this.database.projectHeaders.get(projectId),
          this.database.settings.get(projectOwnerKey(projectId)),
          this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId)),
        ]);
        if (existingProject !== undefined || existingOwner !== undefined || existingInstanceCapability !== undefined) {
          throw new Error("CueBench could not claim a unique local project. Try opening the media again.");
        }
        await this.database.settings.add({
          key: projectOwnerKey(projectId),
          value: { projectId, token },
          updatedAtMs: Date.now(),
        });
        await this.database.settings.add({
          key: projectInstanceOwnerCapabilityKey(projectId),
          value: instanceCapability,
          updatedAtMs: Date.now(),
        });
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ConstraintError") {
        throw new Error("CueBench could not claim a unique local project. Try opening the media again.", { cause: error });
      }
      throw error;
    }
    this.ownedProjectTokens.set(projectId, token);
    return instanceCapability.capability;
  }

  /** Compensates immutable writes only after proving this store owns the lifecycle marker. */
  private async rollbackProjectLifecycle(projectId: string): Promise<void> {
    const token = this.ownedProjectTokens.get(projectId);
    if (token === undefined) return;
    try {
      await this.database.transaction(
        "rw",
        [
          this.database.projectHeaders,
          this.database.items,
          this.database.revisions,
          this.database.findings,
          this.database.evidence,
          this.database.courtRecord,
          this.database.certifications,
          this.database.sourceBlobs,
          this.database.narrationBlobs,
          this.database.runReceipts,
          this.database.settings,
        ],
        async () => {
          const ownership = await this.database.settings.get(projectOwnerKey(projectId));
          if (readOwnerToken(ownership?.value, projectId) !== token) return;
          await this.deleteProjectRows(projectId);
          await Promise.all([
            this.database.settings.delete(projectModeKey(projectId)),
            this.database.settings.delete(projectOwnerKey(projectId)),
            this.database.settings.delete(projectInstanceOwnerCapabilityKey(projectId)),
            this.database.settings.delete(projectSourceProvenanceKey(projectId)),
          ]);
        },
      );
    } catch {
      // Preserve the primary browser/database failure. The owner marker prevents unrelated deletion on a retry.
    } finally {
      this.ownedProjectTokens.delete(projectId);
    }
  }

  /** Removes only old temporary rows that have neither a durable pointer nor a lifecycle owner. */
  private async sweepLegacyTemporaryProjects(epoch: number): Promise<void> {
    const settings = await this.database.settings.toArray();
    const durableProjectId = readProjectId(settings.find((setting) => setting.key === lastDurableProjectKey)?.value);
    const legacyIds = settings
      .filter((setting) => setting.key.startsWith("project-mode:") && readMode(setting.value) === "temporary")
      .map((setting) => setting.key.slice("project-mode:".length))
      .filter((projectId) => projectId.length > 0 && projectId !== durableProjectId);
    for (const projectId of legacyIds) {
      if (!this.isCurrent(epoch)) return;
      await this.purgeLegacyTemporaryProject(projectId);
    }
  }

  private async purgeLegacyTemporaryProject(projectId: string): Promise<void> {
    try {
      await this.database.transaction(
        "rw",
        [
          this.database.projectHeaders,
          this.database.items,
          this.database.revisions,
          this.database.findings,
          this.database.evidence,
          this.database.courtRecord,
          this.database.certifications,
          this.database.sourceBlobs,
          this.database.narrationBlobs,
          this.database.runReceipts,
          this.database.settings,
        ],
        async () => {
          const [mode, owner, durablePointer] = await Promise.all([
            this.database.settings.get(projectModeKey(projectId)),
            this.database.settings.get(projectOwnerKey(projectId)),
            this.database.settings.get(lastDurableProjectKey),
          ]);
          if (
            readMode(mode?.value) !== "temporary"
            || owner !== undefined
            || readProjectId(durablePointer?.value) === projectId
          ) return;
          await this.deleteProjectRows(projectId);
          await Promise.all([
            this.database.settings.delete(projectModeKey(projectId)),
            this.database.settings.delete(projectSourceProvenanceKey(projectId)),
          ]);
        },
      );
    } catch {
      // A future app start can retry the migration cleanup; never block durable hydration for an orphan.
    }
  }

  private async deleteProjectRows(projectId: string): Promise<void> {
    await Promise.all([
      this.database.projectHeaders.delete(projectId),
      this.database.items.where("projectId").equals(projectId).delete(),
      this.database.revisions.where("projectId").equals(projectId).delete(),
      this.database.findings.where("projectId").equals(projectId).delete(),
      this.database.evidence.where("projectId").equals(projectId).delete(),
      this.database.courtRecord.where("projectId").equals(projectId).delete(),
      this.database.certifications.where("projectId").equals(projectId).delete(),
      this.database.sourceBlobs.where("projectId").equals(projectId).delete(),
      this.database.narrationBlobs.where("projectId").equals(projectId).delete(),
      this.database.runReceipts.where("projectId").equals(projectId).delete(),
    ]);
  }

  /** Called inside a settings transaction; removes no ordinary project metadata. */
  private async deletePendingGenerationStartIntentsForRun(projectId: string, runId: string): Promise<void> {
    const keys = (await this.database.settings.toArray())
      .filter((setting) => {
        const intent = pendingDeletedGenerationStartIntentFrom(setting.value);
        return intent?.projectId === projectId && intent.runId === runId;
      })
      .map((setting) => setting.key);
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  /**
   * Called in a settings transaction. Invalid and expired write-ahead rows
   * are private leftovers, so they are removed by key prefix as well as by a
   * parsed value. A malformed row must not become an immortal owner/media
   * metadata record merely because it can no longer be decoded.
   */
  private async sweepExpiredPendingGenerationStartIntents(nowMs: number, projectId?: string): Promise<void> {
    const prefix = projectId === undefined ? "pending-generation-start:" : pendingGenerationStartIntentPrefix(projectId);
    const keys = (await this.database.settings.toArray())
      .filter((setting) => {
        if (!setting.key.startsWith(prefix)) return false;
        const intent = pendingDeletedGenerationStartIntentFrom(setting.value);
        return intent === null || pendingDeletedGenerationStartIntentExpired(intent, nowMs);
      })
      .map((setting) => setting.key);
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  /** Called inside a settings transaction when a deletion receipt becomes terminal or authority expires. */
  private async deletePendingGenerationStartIntentsForDeletionReceipt(receiptId: string): Promise<void> {
    const keys = (await this.database.settings.toArray())
      .filter((setting) => pendingDeletedGenerationStartIntentFrom(setting.value)?.deletionReceiptId === receiptId)
      .map((setting) => setting.key);
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  /**
   * Associates any exact pre-POST reservation with the deletion receipt while
   * all project ownership facts are still present. No signed run material
   * exists yet, so this deliberately does not select an upload fallback.
   */
  private async attachPendingGenerationStartsToDeletionReceipt(
    project: CaptionProject,
    deletionReceipt: DeletionReceipt,
  ): Promise<void> {
    const active = project.activeGenerationRun;
    const ownerSetting = await this.database.settings.get(projectInstanceOwnerCapabilityKey(project.projectId));
    const ownerCapability = readProjectInstanceOwnerCapability(ownerSetting?.value, project.projectId);
    const settings = await this.database.settings.toArray();
    for (const setting of settings) {
      if (!setting.key.startsWith(pendingGenerationStartIntentPrefix(project.projectId))) continue;
      const intent = pendingDeletedGenerationStartIntentFrom(setting.value);
      const canonicalActiveIntent = intent !== null
        && active !== null
        && ownerCapability !== null
        && intent.projectId === project.projectId
        && intent.runId === active.runId
        && intent.targetTrack === active.targetTrack
        && intent.ownerCapability === ownerCapability
        && intent.deletionReceiptId === undefined
        && !pendingDeletedGenerationStartIntentExpired(intent, deletionReceipt.createdAtMs);
      if (!canonicalActiveIntent) {
        // A deletion cannot safely keep an unmatched operation, prior-track,
        // malformed, already-attached, or expired private start intent. It
        // may contain an owner capability/media hash but has no canonical
        // active receipt to reconcile after the project is gone.
        await this.database.settings.delete(setting.key);
        continue;
      }
      await this.database.settings.put({
        key: setting.key,
        value: { ...intent, deletionReceiptId: deletionReceipt.receiptId },
        updatedAtMs: deletionReceipt.createdAtMs,
      });
    }
  }

  /** Removes local lifecycle metadata and, for a confirmed deletion, retained recovery copies containing project data. */
  private async deleteProjectSettings(projectId: string, includeSafetyBackups: boolean): Promise<void> {
    const keys = (await this.database.settings.toArray())
      .map((setting) => setting.key)
      .filter((key) => (
        key === projectModeKey(projectId)
        || key === projectOwnerKey(projectId)
        || key === projectInstanceOwnerCapabilityKey(projectId)
        || key === projectSourceProvenanceKey(projectId)
        || (includeSafetyBackups && (
          key.startsWith(`import-safety-backup:${projectId}:`)
          || key.startsWith(`replacement-safety-backup:${projectId}:`)
        ))
      ));
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  /** Reads the durable authority at the cache boundary, not a stale React projection. */
  private async currentNarrationProject(
    projectId: string,
    waitForQueuedCommands = true,
    expectedProject?: ProjectInstanceFence,
  ): Promise<CaptionProject> {
    this.assertExpectedProjectInstance(expectedProject);
    const snapshot = this.snapshot;
    if (
      snapshot.project === null
      || snapshot.mode !== "durable"
      || snapshot.project.projectId !== projectId
      || snapshot.activity !== null
    ) {
      throw new Error("CueBench narration preview is available only for the current durable browser project.");
    }
    // `saveNarrationPreview` itself is serialized through this queue. Awaiting
    // the queue from inside that queued task would await the task currently
    // being resolved, so it explicitly opts out after its turn begins.
    if (waitForQueuedCommands) await this.commandQueue;
    this.assertExpectedProjectInstance(expectedProject);
    const project = await loadProject(this.database, projectId);
    this.assertExpectedProjectInstance(expectedProject);
    if (project === undefined || this.snapshot.project?.projectId !== projectId || this.snapshot.mode !== "durable" || this.snapshot.activity !== null) {
      throw new Error("CueBench's narration-preview project changed while the request was pending. Select the current beat and try again.");
    }
    return project;
  }

  private assertCurrentNarrationBeat(project: CaptionProject, input: Pick<NarrationPreviewRequest, "beatId" | "itemRevision" | "text">): void {
    const beat = project.audioDescriptions.items[input.beatId];
    if (
      beat === undefined
      || beat.current.itemRevision !== input.itemRevision
      || beat.current.description.trim() !== input.text
    ) {
      throw new Error("This audio-description beat changed while CueBench was preparing its narration preview. Generate a preview for the current revision instead.");
    }
  }

  private createNarrationPreviewGateway(expectedProject?: ProjectInstanceFence): NarrationPreviewGateway {
    return createNarrationPreviewGateway({
      resolveAuthorization: async (projectId) => this.narrationPreviewAuthorization(projectId, expectedProject),
      cache: {
        load: async (input) => this.loadNarrationPreview(input, expectedProject),
        save: async (input) => this.saveNarrationPreview(input, expectedProject),
      },
    });
  }

  private async narrationPreviewAuthorization(
    projectId: string,
    expectedProject?: ProjectInstanceFence,
  ): Promise<NarrationPreviewAuthorization> {
    const project = await this.currentNarrationProject(projectId, true, expectedProject);
    const owner = await this.getCloudProjectOwnerCapability(projectId, expectedProject);
    if (owner === null) throw new Error("CueBench needs the durable browser-project owner identity before narration preview can start.");
    const recovery = loadPersistedCloudUpload(
      projectId,
      { sha256: project.media.sha256, durationMs: project.media.durationMs },
      undefined,
      owner,
    );
    if (recovery?.session === undefined || (recovery.sessionExpiresAtMs ?? 0) <= Date.now()) {
      throw new Error("Complete or refresh the anti-abuse verification in Optional cloud processing before CueBench can request a hosted narration preview.");
    }
    return { session: recovery.session, projectOwnerCapability: owner };
  }

  private async loadNarrationPreview(
    input: Pick<NarrationPreviewRequest, "projectId" | "cacheKey">,
    expectedProject?: ProjectInstanceFence,
  ) {
    this.assertExpectedProjectInstance(expectedProject);
    const snapshot = this.snapshot;
    if (snapshot.project?.projectId !== input.projectId || snapshot.mode !== "durable" || snapshot.activity !== null) return undefined;
    const row = await this.runFencedReceiptOperation(input.projectId, expectedProject, (options) => (
      loadNarrationBlob(this.database, input.projectId, input.cacheKey, options)
    ));
    return row === undefined
      ? undefined
      : { blob: row.blob, contentType: row.contentType, measuredDurationMs: row.measuredDurationMs };
  }

  private saveNarrationPreview(
    input: NarrationPreviewRequest & { readonly blob: Blob; readonly contentType: string; readonly measuredDurationMs: number },
    expectedProject?: ProjectInstanceFence,
  ): Promise<void> {
    const save = async (): Promise<void> => {
      const project = await this.currentNarrationProject(input.projectId, false, expectedProject);
      this.assertCurrentNarrationBeat(project, input);
      await this.runFencedReceiptOperation(input.projectId, expectedProject, (options) => (
        saveNarrationBlob(this.database, input.projectId, {
          beatId: input.beatId,
          itemRevision: input.itemRevision,
          cacheKey: input.cacheKey,
          blob: input.blob,
          contentType: input.contentType,
          measuredDurationMs: input.measuredDurationMs,
        }, options)
      ));
    };
    const queued = this.commandQueue.then(save, save);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * Captures only an existing exact-run or exact-upload capability while its
   * project namespace is still live. This never mints a cleanup credential,
   * never reconstructs one from a backup, and never uses a broad R2 prefix.
   */
  private async captureDeletionCleanupAuthorization(
    project: CaptionProject,
    nowMs: number,
    deletionExpiresAtMs: number,
  ): Promise<ProjectCloudCleanupAuthorization | undefined> {
    const ownerSetting = await this.database.settings.get(projectInstanceOwnerCapabilityKey(project.projectId));
    const ownerCapability = readProjectInstanceOwnerCapability(ownerSetting?.value, project.projectId);
    if (ownerCapability === null) return undefined;
    const activeRun = project.activeGenerationRun;
    if (activeRun !== null) {
      const row = await this.database.runReceipts.get(runReceiptKey(project.projectId, activeRun.runId));
      const parsed = privateRunCleanupAuthorization(
        row?.receipt.version === 1 ? row.receipt.payload : null,
        project,
        { runId: activeRun.runId, targetTrack: activeRun.targetTrack },
        ownerCapability,
        nowMs,
      );
      if (parsed === null) return undefined;
      return {
        version: 1,
        ownerCapability,
        expiresAtMs: Math.min(deletionExpiresAtMs, parsed.expiresAtMs),
        run: parsed.run,
      };
    }

    // Local adoption/cancellation can release the active target lease before
    // its server acknowledgement returns. Inspect the bounded project receipt
    // rows before falling back to an upload DELETE; otherwise a project delete
    // would send a conflicting operation-level command instead of the exact
    // adopted/discarded/cancelled run acknowledgement.
    const rows = await this.database.runReceipts.where("projectId").equals(project.projectId).toArray();
    for (const row of [...rows].sort((left, right) => right.savedAtMs - left.savedAtMs || right.runId.localeCompare(left.runId))) {
      const parsed = privateTerminalRunCleanupAuthorization(
        row.receipt.version === 1 ? row.receipt.payload : null,
        project,
        row.runId,
        ownerCapability,
        nowMs,
      );
      if (parsed === null) continue;
      return {
        version: 1,
        ownerCapability,
        expiresAtMs: Math.min(deletionExpiresAtMs, parsed.expiresAtMs),
        run: parsed.run,
      };
    }

    const parsedUpload = privateUploadCleanupAuthorization(project, ownerCapability, nowMs);
    if (parsedUpload === null) return undefined;
    return {
      version: 1,
      ownerCapability,
      expiresAtMs: Math.min(deletionExpiresAtMs, parsedUpload.expiresAtMs),
      upload: parsedUpload.upload,
    };
  }

  private newDeletionReceipt(project: CaptionProject): DeletionReceipt {
    const createdAtMs = Date.now();
    return {
      receiptId: `delete-${this.createId()}`,
      projectId: project.projectId,
      sourceId: project.media.sourceId,
      activeRunId: project.activeGenerationRun?.runId ?? null,
      createdAtMs,
      expiresAtMs: createdAtMs + cloudCleanupBackstopMs,
      attempts: 0,
      state: "pending",
      message: "Cloud cleanup is pending lifecycle enforcement.",
    };
  }

  private deletionReceiptFrom(value: unknown): DeletionReceipt | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (
      typeof record.receiptId !== "string"
      || typeof record.projectId !== "string"
      || typeof record.sourceId !== "string"
      || (record.activeRunId !== null && typeof record.activeRunId !== "string")
      || typeof record.createdAtMs !== "number"
      || !Number.isSafeInteger(record.createdAtMs)
      || record.createdAtMs < 0
      || (record.expiresAtMs !== undefined && (!Number.isSafeInteger(record.expiresAtMs) || (record.expiresAtMs as number) <= 0))
      || typeof record.attempts !== "number"
      || !Number.isSafeInteger(record.attempts)
      || record.attempts < 0
      || (record.state !== "pending" && record.state !== "deleted" && record.state !== "failed" && record.state !== "lifecycle-pending")
      || typeof record.message !== "string"
    ) return null;
    const authorization = cleanupAuthorizationFrom(record.authorization);
    const outerExpiry = typeof record.expiresAtMs === "number"
      ? record.expiresAtMs
      : (record.createdAtMs as number) + cloudCleanupBackstopMs;
    // Older records may have persisted their outer expiry before a bounded
    // run/upload authority was attached. Parse them conservatively too, so a
    // detached tab never revives that authority past its own signed window.
    const expiresAtMs = authorization === undefined
      ? outerExpiry
      : Math.min(outerExpiry, authorization.expiresAtMs);
    return {
      receiptId: record.receiptId,
      projectId: record.projectId,
      sourceId: record.sourceId,
      activeRunId: record.activeRunId,
      createdAtMs: record.createdAtMs,
      // Legacy receipts remain conservative. Reconstruct their original
      // lifecycle cap rather than presenting them as an instant deletion.
      expiresAtMs,
      attempts: record.attempts,
      state: record.state,
      message: record.message,
      ...(authorization === undefined ? {} : { authorization }),
    };
  }

  private cloudCleanupResultFor(receipt: DeletionReceipt): CloudCleanupResult {
    return {
      status: receipt.state === "deleted" ? "deleted" : receipt.state === "failed" ? "failed" : "pending",
      message: receipt.message,
    };
  }

  private async findDeletionReceipt(receiptId: string): Promise<DeletionReceipt | null> {
    const setting = (await this.database.settings.toArray()).find((candidate) => {
      const value = this.deletionReceiptFrom(candidate.value);
      return value?.receiptId === receiptId;
    });
    return setting === undefined ? null : this.deletionReceiptFrom(setting.value);
  }

  /**
   * Reconciles the narrow delete-after-start race across tabs. It relies only
   * on an exact private intent recorded before POST; normal project rows are
   * intentionally absent here and are never recreated. A malformed/stale
   * response is still treated as handled once it names a deleted intent, so
   * it cannot fall through to normal receipt persistence.
   */
  private async reconcileDeletedGenerationStart(input: DeletedGenerationStartRecovery): Promise<boolean> {
    const projectId = privateOpaqueIdentifier(input.projectId);
    const operationId = privateOpaqueIdentifier(input.operationId);
    const runId = privateOpaqueIdentifier(input.runId);
    const ownerCapability = typeof input.projectOwnerCapability === "string" && /^[0-9a-f]{64}$/iu.test(input.projectOwnerCapability)
      ? input.projectOwnerCapability.toLowerCase()
      : null;
    if (
      projectId === null
      || operationId === null
      || runId === null
      || (input.targetTrack !== "Captions" && input.targetTrack !== "AudioDescriptions")
      || ownerCapability === null
    ) return false;

    const intentKey = pendingGenerationStartIntentKey(projectId, operationId, runId);
    const nowMs = Date.now();
    let handled = false;
    let cleanupReceipt: DeletionReceipt | null = null;
    await this.database.transaction("rw", [this.database.settings], async () => {
      const intentSetting = await this.database.settings.get(intentKey);
      const intent = pendingDeletedGenerationStartIntentFrom(intentSetting?.value);
      if (intent !== null && pendingDeletedGenerationStartIntentExpired(intent, nowMs)) {
        // The project may already be gone, but this unfulfilled pre-POST
        // intent has crossed its browser recovery bound. Scrub it rather than
        // accepting a late capability into a deletion receipt.
        handled = intent.deletionReceiptId !== undefined;
        await this.database.settings.delete(intentKey);
        return;
      }
      if (
        intent === null
        || intent.projectId !== projectId
        || intent.operationId !== operationId
        || intent.runId !== runId
        || intent.targetTrack !== input.targetTrack
        || intent.ownerCapability !== ownerCapability
      ) return;
      // It is a normal in-flight start until deletion atomically assigns the
      // receipt id. Let ordinary persistence proceed in that live-project
      // case; do not manufacture deletion state from a stale tab.
      if (intent.deletionReceiptId === undefined) return;
      handled = true;

      const deletionSetting = await this.database.settings.get(deletionReceiptKey(projectId, intent.deletionReceiptId));
      const current = deletionSetting === undefined ? null : this.deletionReceiptFrom(deletionSetting.value);
      if (current === null) {
        // The deletion receipt is gone or malformed. Scrub the private
        // write-ahead owner rather than allowing a dead project to return.
        await this.database.settings.delete(intentKey);
        return;
      }
      if (current.state === "deleted" || current.state === "lifecycle-pending") {
        await this.deletePendingGenerationStartIntentsForDeletionReceipt(intent.deletionReceiptId);
        return;
      }
      if (current.expiresAtMs <= nowMs) {
        const lifecyclePending = {
          ...withoutCloudCleanupAuthorization(current),
          state: "lifecycle-pending" as const,
          message: expiredCloudCleanupMessage,
        };
        await this.database.settings.put({
          key: deletionReceiptKey(current.projectId, current.receiptId),
          value: lifecyclePending,
          updatedAtMs: nowMs,
        });
        await this.deletePendingGenerationStartIntentsForDeletionReceipt(intent.deletionReceiptId);
        return;
      }
      // A response can be corrupted after the Worker committed its start.
      // Preserve the intent for a later exact response, but never fall
      // through into normal persistence while the project remains deleted.
      const parsed = privatePendingStartRunAuthorization(input.receipt, intent, nowMs);
      if (parsed === null || current.activeRunId !== runId) return;

      const expiresAtMs = Math.min(current.expiresAtMs, parsed.expiresAtMs);
      const captured: DeletionReceipt = {
        ...current,
        expiresAtMs,
        authorization: {
          version: 1,
          ownerCapability: intent.ownerCapability,
          expiresAtMs,
          run: parsed.run,
        },
      };
      await this.database.settings.put({
        key: deletionReceiptKey(captured.projectId, captured.receiptId),
        value: captured,
        updatedAtMs: nowMs,
      });
      // The signed receipt is now atomically owned by the deletion receipt;
      // remove the duplicate private write-ahead owner before any network IO.
      await this.database.settings.delete(intentKey);
      cleanupReceipt = captured;
    });
    if (cleanupReceipt !== null) {
      // A no-authority background pass may already be in flight from the
      // deletion itself. Let that pass settle, then re-read the now-captured
      // exact run authorization and issue its DELETE; merely joining the old
      // promise would otherwise strand this late POST until a manual retry.
      void this.runCapturedStartCloudCleanup(cleanupReceipt);
    }
    return handled;
  }

  private async currentDeletionReceipt(receipt: DeletionReceipt): Promise<DeletionReceipt | null> {
    const setting = await this.database.settings.get(deletionReceiptKey(receipt.projectId, receipt.receiptId));
    return setting === undefined ? null : this.deletionReceiptFrom(setting.value);
  }

  private async runCloudCleanupInBackground(receipt: DeletionReceipt): Promise<void> {
    try {
      await this.completeCloudCleanup(receipt);
    } catch {
      // Local deletion already completed. Retained receipt metadata makes a later explicit retry possible.
    }
  }

  /** Serializes a newly captured late-start receipt behind an earlier no-auth cleanup pass. */
  private async runCapturedStartCloudCleanup(receipt: DeletionReceipt): Promise<void> {
    const active = this.cleanupOperations.get(receipt.receiptId);
    if (active !== undefined) {
      try { await active; } catch { /* retained receipt remains the recovery boundary */ }
    }
    await this.runCloudCleanupInBackground(receipt);
  }

  /** Deduplicates same-store retries before an async database or cloud boundary can interleave. */
  private completeCloudCleanup(receipt: DeletionReceipt): Promise<CloudCleanupResult> {
    const active = this.cleanupOperations.get(receipt.receiptId);
    if (active !== undefined) return active;
    const operation = this.completeCloudCleanupAttempt(receipt).finally(() => {
      if (this.cleanupOperations.get(receipt.receiptId) === operation) {
        this.cleanupOperations.delete(receipt.receiptId);
      }
    });
    this.cleanupOperations.set(receipt.receiptId, operation);
    return operation;
  }

  private async completeCloudCleanupAttempt(receipt: DeletionReceipt): Promise<CloudCleanupResult> {
    const current = await this.currentDeletionReceipt(receipt);
    if (current === null) {
      return {
        status: "pending",
        message: "CueBench could not find the retained deletion receipt. Cloud cleanup remains pending lifecycle enforcement.",
      };
    }
    if (current.state === "deleted") return this.cloudCleanupResultFor(current);
    // `lifecycle-pending` is terminal for browser authority even if a stale
    // old IndexedDB row somehow retained credentials. Never replay it.
    if (current.state === "lifecycle-pending") return this.cloudCleanupResultFor(current);
    // A background continuation or detached-tab retry may arrive after its
    // bounded browser recovery window. Do not call either the production
    // exact-delete client or an injected lifecycle seam once the receipt has
    // expired; the server-side lifecycle backstop is now authoritative.
    if (current.expiresAtMs <= Date.now()) {
      const expired = await this.expireCloudCleanupReceipt(current);
      const expiredResult: CloudCleanupResult = {
        status: "pending",
        message: expiredCloudCleanupMessage,
      };
      if (
        this.activeCleanupReceiptId === receipt.receiptId
        && this.snapshot.route === "start"
        && this.snapshot.project === null
      ) {
        this.setSnapshot({
          ...this.snapshot,
          cleanupNotice: `Local project copy deleted. ${expiredResult.message}`,
        });
      }
      return expired === null ? expiredResult : this.cloudCleanupResultFor(expired);
    }
    const result = await this.requestCloudCleanup({
      projectId: current.projectId,
      sourceId: current.sourceId,
      activeRunId: current.activeRunId,
      cancelActiveWork: true,
    }, current.authorization);
    let retained: DeletionReceipt | null;
    try {
      retained = await this.persistCloudCleanupResult(current, result);
    } catch {
      // Do not falsely report a successful hosted cleanup as a durable lifecycle receipt update.
      return {
        status: "pending",
        message: "Cloud cleanup returned a result, but CueBench could not retain its deletion receipt. Cleanup remains pending lifecycle enforcement.",
      };
    }
    if (retained === null) {
      return {
        status: "pending",
        message: "CueBench could not retain the current deletion receipt. Cloud cleanup remains pending lifecycle enforcement.",
      };
    }
    const finalResult = this.cloudCleanupResultFor(retained);
    if (
      this.activeCleanupReceiptId === receipt.receiptId
      && this.snapshot.route === "start"
      && this.snapshot.project === null
    ) {
      this.setSnapshot({
        ...this.snapshot,
        cleanupNotice: `Local project copy deleted. ${finalResult.message}`,
      });
    }
    return finalResult;
  }

  /**
   * The receipt is the cross-tab CAS boundary. `deleted` is terminal: a
   * delayed timeout or failure may never downgrade it after another tab has
   * confirmed remote deletion.
   */
  private async persistCloudCleanupResult(
    receipt: DeletionReceipt,
    result: CloudCleanupResult,
  ): Promise<DeletionReceipt | null> {
    let retained: DeletionReceipt | null = null;
    await this.database.transaction("rw", [this.database.settings], async () => {
      const setting = await this.database.settings.get(deletionReceiptKey(receipt.projectId, receipt.receiptId));
      const current = setting === undefined ? null : this.deletionReceiptFrom(setting.value);
      if (current === null) return;
      if (current.state === "deleted") {
        retained = current;
        await this.deletePendingGenerationStartIntentsForDeletionReceipt(receipt.receiptId);
        return;
      }
      const state = result.status === "deleted"
        ? "deleted"
        : current.state === "failed" || result.status === "failed"
          ? "failed"
          : "pending";
      const message = state === "failed" && result.status === "pending"
        ? current.message
        : result.message;
      const publicLifecycle = withoutCloudCleanupAuthorization(current);
      retained = {
        ...(state === "deleted" ? publicLifecycle : current),
        attempts: current.attempts + 1,
        state,
        message,
      };
      await this.database.settings.put({
        key: deletionReceiptKey(receipt.projectId, receipt.receiptId),
        value: retained,
        updatedAtMs: Date.now(),
      });
      if (state === "deleted") {
        // A confirmed exact delete leaves no valid reason to retain a
        // pre-POST owner/session intent in another tab's IndexedDB view.
        await this.deletePendingGenerationStartIntentsForDeletionReceipt(receipt.receiptId);
      }
    });
    return retained;
  }

  /**
   * Expiry is a terminal browser-authority boundary. Persisting the public
   * lifecycle-pending marker and dropping every owner/session/receipt field
   * in one IndexedDB transaction prevents a later detached tab from replaying
   * private cleanup credentials after the disclosed recovery window.
   */
  private async expireCloudCleanupReceipt(receipt: DeletionReceipt): Promise<DeletionReceipt | null> {
    let retained: DeletionReceipt | null = null;
    await this.database.transaction("rw", [this.database.settings], async () => {
      const setting = await this.database.settings.get(deletionReceiptKey(receipt.projectId, receipt.receiptId));
      const current = setting === undefined ? null : this.deletionReceiptFrom(setting.value);
      if (current === null) return;
      if (current.state === "deleted") {
        retained = current;
        await this.deletePendingGenerationStartIntentsForDeletionReceipt(receipt.receiptId);
        return;
      }
      const publicLifecycle = withoutCloudCleanupAuthorization(current);
      retained = {
        ...publicLifecycle,
        state: "lifecycle-pending",
        message: expiredCloudCleanupMessage,
      };
      await this.database.settings.put({
        key: deletionReceiptKey(receipt.projectId, receipt.receiptId),
        value: retained,
        updatedAtMs: Date.now(),
      });
      // Lifecycle-pending is terminal for browser authority. Scrub an
      // unresolved start race together with any retained run authorization.
      await this.deletePendingGenerationStartIntentsForDeletionReceipt(receipt.receiptId);
    });
    return retained;
  }

  private async requestCloudCleanup(
    request: CloudCleanupRequest,
    authorization: ProjectCloudCleanupAuthorization | undefined,
  ): Promise<CloudCleanupResult> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<CloudCleanupResult>((resolve) => {
      timeout = setTimeout(() => resolve({
        status: "pending",
        message: "Cloud cleanup did not confirm before the local lifecycle timeout and remains pending lifecycle enforcement.",
      }), this.cloudCleanupTimeoutMs);
    });
    const requested = Promise.resolve()
      .then(() => this.cloudCleanup === undefined
        ? cleanupProjectCloudArtifacts({ ...request, authorization })
        : this.cloudCleanup(request))
      .then((result): CloudCleanupResult => {
        if (
          (result.status === "deleted" || result.status === "pending" || result.status === "failed")
          && typeof result.message === "string"
          && result.message.trim().length > 0
        ) return this.cloudCleanup === undefined
          ? result
          : this.redactedCloudCleanupResult(result.status);
        return {
          status: "pending",
          message: "Cloud cleanup returned an incomplete status and remains pending lifecycle enforcement.",
        };
      })
      .catch((): CloudCleanupResult => ({
        status: "failed",
        message: "Cloud cleanup could not be confirmed and remains pending lifecycle enforcement.",
      }));
    const result = await Promise.race([requested, timedOut]);
    if (timeout !== null) clearTimeout(timeout);
    return result;
  }

  /** Hosted hooks may include a provider body or exact private object key; do not surface either after deletion. */
  private redactedCloudCleanupResult(status: CloudCleanupResult["status"]): CloudCleanupResult {
    switch (status) {
      case "deleted":
        return { status, message: "CueBench confirmed private cloud cleanup." };
      case "failed":
        return { status, message: "CueBench could not confirm private cloud cleanup. It remains subject to the 24-hour deletion ceiling." };
      default:
        return { status, message: "Cloud cleanup is pending lifecycle enforcement; CueBench will record the hosted result when it is confirmed." };
    }
  }

  private async persistMode(projectId: string, mode: ProjectMode): Promise<void> {
    await saveSetting(this.database, projectModeKey(projectId), { mode });
  }

  private async persistSourceProvenance(projectId: string, sourceProvenance: SourceProvenance): Promise<void> {
    await saveSetting(this.database, projectSourceProvenanceKey(projectId), sourceProvenance);
  }

  private async rememberDurableProject(projectId: string): Promise<void> {
    await saveSetting(this.database, lastDurableProjectKey, { projectId });
  }

  private async readLastDurableProjectId(): Promise<string | null> {
    const setting = await loadSetting(this.database, lastDurableProjectKey);
    return setting === undefined ? null : readProjectId(setting.value);
  }

  private async restoreDurableProjectPointer(previousProjectId: string | null, failedProjectId: string): Promise<void> {
    try {
      const current = await loadSetting(this.database, lastDurableProjectKey);
      if (current === undefined || readProjectId(current.value) !== failedProjectId) return;
      if (previousProjectId === null) {
        await this.database.settings.delete(lastDurableProjectKey);
      } else {
        await this.rememberDurableProject(previousProjectId);
      }
    } catch {
      // The owner-checked project rollback remains authoritative if pointer recovery is rejected.
    }
  }

  private offerTemporaryChoice(pendingUpload: PendingUpload, epoch: number, error: string | null): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({
      route: "temporary-choice",
      project: null,
      mode: null,
      sourceObjectUrl: null,
      // The temporary-decision screen still describes this concrete local
      // source. Keeping the fact here prevents title-based fallbacks when the
      // upload is continued in the current page.
      sourceProvenance: pendingUpload.sourceProvenance,
      pendingUpload,
      activity: null,
      error,
      cleanupNotice: null,
    });
  }

  private beginRestore(): number | null {
    if (this.snapshot.activity !== null || this.snapshot.project !== null) return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity: "hydrating", error: null, cleanupNotice: null });
    return epoch;
  }

  private beginUserOperation(activity: Exclude<ProjectActivity, "hydrating" | null>): number | null {
    if (this.snapshot.project !== null) return null;
    if (this.snapshot.activity !== null && this.snapshot.activity !== "hydrating") return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity, error: null, cleanupNotice: null });
    return epoch;
  }

  private completeToStart(epoch: number): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot(emptySnapshot());
  }

  private failCurrentOperation(epoch: number, error: string): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...emptySnapshot(), error });
  }

  private invalidateOperations(): void {
    this.operationEpoch += 1;
  }

  private isCurrent(epoch: number): boolean {
    return epoch === this.operationEpoch;
  }

  private activeObjectUrlLease(): ObjectUrlLease | undefined {
    if (this.objectUrlLease !== null) return this.objectUrlLease;
    if (this.triedObjectUrlLease) return undefined;
    this.triedObjectUrlLease = true;
    try {
      this.objectUrlLease = new ObjectUrlLease();
      return this.objectUrlLease;
    } catch {
      return undefined;
    }
  }

  /** Reject a captured WebMCP lifecycle port before it can touch a new page instance. */
  private assertExpectedProjectInstance(expectedProject?: ProjectInstanceFence): void {
    if (expectedProject === undefined) return;
    const project = this.snapshot.project;
    if (
      project === null
      || project.projectId !== expectedProject.projectId
      || this.projectInstanceEpoch !== expectedProject.projectInstanceEpoch
      || (
        expectedProject.projectInstanceCapabilityFingerprint !== undefined
        && this.projectInstanceCapabilityFingerprint !== expectedProject.projectInstanceCapabilityFingerprint
      )
    ) throw new ProjectInstanceFenceError();
  }

  /**
   * Re-reads the persisted nonportable owner inside the caller's Dexie
   * transaction. Page-local epochs catch React/closure replacement; this
   * durable comparison catches a second tab importing the same id/revision.
   */
  private async isExpectedProjectInstanceDurablyAuthorized(
    projectId: string,
    expectedProject: ProjectInstanceFence | undefined,
    onMismatch?: (fingerprint: string | null) => void,
  ): Promise<boolean> {
    if (expectedProject === undefined) return true;
    if (
      expectedProject.projectId !== projectId
      || this.projectInstanceEpoch !== expectedProject.projectInstanceEpoch
      || (
        expectedProject.projectInstanceCapabilityFingerprint !== undefined
        && this.projectInstanceCapabilityFingerprint !== expectedProject.projectInstanceCapabilityFingerprint
      )
    ) return false;
    if (expectedProject.projectInstanceCapabilityFingerprint === undefined) return true;
    const setting = await this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId));
    const capability = readProjectInstanceOwnerCapability(setting?.value, projectId);
    const fingerprint = capability === null
      ? null
      : projectInstanceCapabilityFingerprint(projectId, capability);
    if (fingerprint !== expectedProject.projectInstanceCapabilityFingerprint) {
      onMismatch?.(fingerprint);
      return false;
    }
    return true;
  }

  private projectInstanceWriteOptions(
    projectId: string,
    expectedProject: ProjectInstanceFence | undefined,
    onMismatch?: (fingerprint: string | null) => void,
  ): { readonly authorizeCommand?: () => Promise<boolean> } {
    if (expectedProject === undefined) return {};
    return {
      authorizeCommand: () => this.isExpectedProjectInstanceDurablyAuthorized(projectId, expectedProject, onMismatch),
    };
  }

  /** Rotate this page's internal identity after a durable fence rejects it. */
  private reconcileProjectInstanceFenceMismatch(
    projectId: string,
    observedReplacementFingerprint: string | null | undefined,
  ): void {
    if (observedReplacementFingerprint === undefined || this.snapshot.project?.projectId !== projectId) return;
    this.setSnapshot({
      ...this.snapshot,
      error: "CueBench's visible project instance changed in another browser context.",
    }, {
      rotateProjectInstance: true,
      projectInstanceCapabilityFingerprint: observedReplacementFingerprint,
    });
  }

  /** Run one opaque receipt read/write through the same durable owner fence. */
  private async runFencedReceiptOperation<T>(
    projectId: string,
    expectedProject: ProjectInstanceFence | undefined,
    operation: (options: { readonly authorizeCommand?: () => Promise<boolean> }) => Promise<T>,
  ): Promise<T> {
    this.assertExpectedProjectInstance(expectedProject);
    let observedReplacementFingerprint: string | null | undefined;
    try {
      return await operation(this.projectInstanceWriteOptions(
        projectId,
        expectedProject,
        (fingerprint) => { observedReplacementFingerprint = fingerprint; },
      ));
    } catch (error) {
      this.reconcileProjectInstanceFenceMismatch(projectId, observedReplacementFingerprint);
      if (expectedProject !== undefined && error instanceof StorageStaleWriteError) {
        throw new ProjectInstanceFenceError();
      }
      throw error;
    }
  }

  private setSnapshot(
    nextSnapshot: ProjectStoreSnapshot,
    options: {
      readonly rotateProjectInstance?: boolean;
      readonly projectInstanceCapabilityFingerprint?: string | null;
    } = {},
  ): void {
    const priorProjectId = this.snapshot.project?.projectId ?? null;
    const nextProjectId = nextSnapshot.project?.projectId ?? null;
    const replacedInstance = options.rotateProjectInstance === true || priorProjectId !== nextProjectId;
    if (replacedInstance) {
      this.projectInstanceEpoch += 1;
      this.projectInstanceCapabilityFingerprint = nextProjectId === null
        ? null
        : options.projectInstanceCapabilityFingerprint ?? null;
    } else if (options.projectInstanceCapabilityFingerprint !== undefined) {
      this.projectInstanceCapabilityFingerprint = options.projectInstanceCapabilityFingerprint;
    }
    this.snapshot = nextSnapshot;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /** A view subscriber must not roll a committed local lifecycle transition back to an obsolete object URL. */
      }
    }
  }
}

export const loadProjectMode = async (database: CueBenchDatabase, projectId: string): Promise<ProjectMode | null> => {
  const setting = await loadSetting(database, projectModeKey(projectId));
  return setting === undefined ? null : readMode(setting.value);
};
