import {
  AudioDescriptionGenerationRunReceiptSchema,
  CaptionEvidenceProjectionSchema,
  GenerationRunStatusSchema,
  StagedAudioDescriptionGenerationResultSchema,
  type AudioDescriptionGenerationRunReceipt,
  type CaptionEvidenceProjection,
  type GenerationRunStatus,
  type StagedAudioDescriptionGenerationResult,
} from "@cuebench/contracts";
import { canonicalHash, canonicalSerialize } from "@cuebench/domain";
import type { R2Bucket, R2Conditional } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { resolveWorkerSettings, type WorkerEnv, type WorkerSettings } from "./env";
import {
  R2GenerationRunRecordStore,
  type GenerationRunRecordStore,
  type ActiveGenerationLeaseAcquisition,
} from "./generation-routes";
import {
  generationArtifactWriteLeaseKey,
  generationCleanupMarkerKey,
} from "./generation-cleanup";
import { saltedLedgerKey, type QuotaLedgerPort } from "./quota-ledger";
import {
  SignedTokenError,
  signOpaqueToken,
  verifyAnonymousSession,
  verifyOpaqueToken,
  type SignedTokenFields,
} from "./session";
import { verifyUploadReceipt } from "./uploads";

/** The AD route never permits a receipt, projection, or checkpoint to outlive private R2 retention. */
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_REFS = 256;
/** Source + prepared manifest + frames + immutable checkpoints, all bounded. */
const MAX_CLEANUP_KEYS = 1_024;
const CLEANUP_DELETE_BATCH_SIZE = 50;
const ORPHAN_ARTIFACT_SCAN_LIMIT = MAX_ARTIFACT_REFS + 1;
const MAX_PREPARED_THUMBNAILS = 256;
const MAX_PREPARATION_WRITER_LEASES = 512;
const MAX_WINDOW_CHECKPOINTS = 32;
const MAX_PROFILE_RULES_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clone = <Value>(value: Value): Value => structuredClone(value);
const onlyIfAbsent = (): R2Conditional => new Headers({ "if-none-match": "*" }) as unknown as R2Conditional;

/** Canonical encoding is for hashes; private R2 records must remain JSON-readable. */
const jsonBytes = (value: unknown, failure: string): Uint8Array => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new Error(failure);
  return encoder.encode(encoded);
};

type Bindings = { readonly Bindings: WorkerEnv };
type SharedLeaseStore = Pick<GenerationRunRecordStore, "acquireActiveLease" | "releaseActiveLease">;

/** The receipt carries every browser-visible mutable fact that the Workflow must re-check. */
export type AudioDescriptionGenerationRunReceiptClaims = AudioDescriptionGenerationRunReceipt & SignedTokenFields;

export interface AudioDescriptionGenerationArtifactReference {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type AudioDescriptionWindowCallState =
  | "ready"
  | "calling"
  | "completed"
  | "accepted-unknown"
  | "retryable-failed";

export interface AudioDescriptionWindowCheckpoint {
  readonly state: AudioDescriptionWindowCallState;
  /** Immutable, monotonically increasing provider-attempt identity. */
  readonly attempt: number;
  readonly attemptId: string;
  readonly checkpoint?: AudioDescriptionGenerationArtifactReference;
  readonly updatedAtMs: number;
}

export type AudioDescriptionGenerationCleanupAction = "adopted" | "discarded" | "cancelled" | "expired";

export interface AudioDescriptionGenerationCleanup {
  readonly version: 1;
  readonly state: "pending" | "completed";
  readonly action: AudioDescriptionGenerationCleanupAction;
  /** Exact private keys only: source, prepared visual evidence, and artifacts. */
  readonly artifactKeys: readonly string[];
  readonly requestedAtMs: number;
  readonly completedAtMs?: number;
}

/**
 * This private record intentionally keeps no raw video, thumbnail bytes, or
 * TTS audio. It binds only canonical caption evidence and private R2 refs.
 */
export interface AudioDescriptionGenerationRunRecord {
  readonly version: 1;
  readonly receipt: string;
  readonly claims: AudioDescriptionGenerationRunReceiptClaims;
  readonly uploadReceipt: string;
  readonly captionEvidenceProjection: CaptionEvidenceProjection;
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  readonly status: GenerationRunStatus;
  readonly cancelled: boolean;
  readonly dispatched: boolean;
  readonly windowCheckpoints: Readonly<Record<string, AudioDescriptionWindowCheckpoint>>;
  readonly stagedResultRef?: AudioDescriptionGenerationArtifactReference;
  readonly artifactRefs: readonly AudioDescriptionGenerationArtifactReference[];
  /**
   * Exact non-artifact private objects owned by this run: the uploaded source
   * plus its prepared visual manifest and thumbnails. Artifact writes retain
   * their hash-bound refs separately.
   */
  readonly privateObjectKeys: readonly string[];
  readonly cleanup?: AudioDescriptionGenerationCleanup;
  /** A terminal route writes this before the independent shared-lease CAS. */
  readonly leaseReleasePending?: true;
  /** Terminal cleanup removed raw captions, rules, receipts, and artifact refs. */
  readonly contentRedacted?: true;
  readonly updatedAtMs: number;
}

export type AudioDescriptionWindowClaim =
  | { readonly kind: "claimed"; readonly record: AudioDescriptionGenerationRunRecord; readonly attemptId: string }
  | { readonly kind: "completed" | "accepted-unknown" | "retryable-failed" | "cancelled" | "missing"; readonly record?: AudioDescriptionGenerationRunRecord };

/**
 * Separate AD-store surface prevents caption code from accidentally reading
 * an AD-only projection or checkpoint. The sole shared primitive is the
 * target-discriminated global project lease.
 */
export interface AudioDescriptionGenerationRunRecordStore {
  readonly load: (input: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly save: (record: AudioDescriptionGenerationRunRecord) => Promise<void>;
  readonly claimWindowProviderCall: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly windowId: string;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionWindowClaim>;
  readonly markWindowRetryableFailure: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly windowId: string;
    readonly attemptId: string;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly markWindowAcceptedUnknown: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly windowId: string;
    readonly attemptId: string;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly recordPrivateObjectKeys: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly keys: readonly string[];
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly completeWindow: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly windowId: string;
    readonly attemptId: string;
    readonly value: unknown;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationArtifactReference | null>;
  readonly readWindowCheckpoint: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly reference: AudioDescriptionGenerationArtifactReference;
  }) => Promise<unknown | null>;
  readonly stageResult: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly result: StagedAudioDescriptionGenerationResult;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly readStagedResult: (record: AudioDescriptionGenerationRunRecord) => Promise<StagedAudioDescriptionGenerationResult | null>;
  readonly terminal: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: AudioDescriptionGenerationCleanupAction;
    readonly adoptedProjectRevision?: number;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly cleanup: (input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: AudioDescriptionGenerationCleanupAction;
    readonly nowMs: number;
  }) => Promise<AudioDescriptionGenerationRunRecord | null>;
  readonly markLeaseReleased: (claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">) => Promise<AudioDescriptionGenerationRunRecord | null>;
}

const sameText = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const recordKey = (operationKey: string, runId: string): string =>
  `prepared/${operationKey}/audio-description-runs/${runId}.json`;

const artifactPrefix = (operationKey: string, runId: string): string =>
  `prepared/${operationKey}/audio-description-runs/${runId}/artifacts/`;

const preparationPrefix = (operationKey: string): string => `prepared/${operationKey}/`;

/**
 * The signed preparer may emit a manifest, thumbnails, normalized audio,
 * waveform, and a deterministic index. These are the only non-artifact
 * namespaces cleanup may rescan; recovery records and other run records are
 * never deletion targets.
 */
const isPreparedOperationOutputKey = (operationKey: string, key: string): boolean => (
  new RegExp(`^prepared/${operationKey}/(?:audio/[a-f0-9]{64}\\.wav|waveforms/[a-f0-9]{64}\\.json|thumbnails/[a-f0-9]{64}\\.webp|manifests/[a-f0-9]{64}\\.json|indexes/[a-f0-9]{64}\\.json)$`, "u")
    .test(key)
);

/** Only this run's exact source or preparation namespace may enter cleanup. */
const isRunPrivateObjectKey = (
  claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "objectKey">,
  key: string,
): boolean => (
  key === claims.objectKey
  || key.startsWith(`prepared/${claims.operationKey}/`)
);

const artifactKey = (operationKey: string, runId: string, kind: "window" | "staged-result", digest: string): string =>
  `${artifactPrefix(operationKey, runId)}${kind}-${digest}.json`;

const validArtifactReference = (value: unknown): value is AudioDescriptionGenerationArtifactReference => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reference = value as Readonly<Record<string, unknown>>;
  return typeof reference.key === "string"
    && typeof reference.sha256 === "string" && SHA256.test(reference.sha256)
    && Number.isSafeInteger(reference.byteLength) && (reference.byteLength as number) > 0 && (reference.byteLength as number) <= MAX_ARTIFACT_BYTES;
};

const validWindowCheckpoint = (value: unknown): value is AudioDescriptionWindowCheckpoint => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Readonly<Record<string, unknown>>;
  const state = checkpoint.state;
  if (
    state !== "ready" && state !== "calling" && state !== "completed"
    && state !== "accepted-unknown" && state !== "retryable-failed"
  ) return false;
  if (!Number.isSafeInteger(checkpoint.attempt) || (checkpoint.attempt as number) <= 0 || typeof checkpoint.attemptId !== "string" || !OPAQUE_ID.test(checkpoint.attemptId)) return false;
  if (!Number.isSafeInteger(checkpoint.updatedAtMs) || (checkpoint.updatedAtMs as number) < 0) return false;
  if (state === "completed") return validArtifactReference(checkpoint.checkpoint);
  return checkpoint.checkpoint === undefined;
};

const windowAttemptId = (windowId: string, attempt: number): string =>
  `${windowId.slice(0, 112)}-a${attempt}`;

const validCleanup = (value: unknown): value is AudioDescriptionGenerationCleanup => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cleanup = value as Readonly<Record<string, unknown>>;
  if (
    cleanup.version !== 1
    || (cleanup.state !== "pending" && cleanup.state !== "completed")
    || (cleanup.action !== "adopted" && cleanup.action !== "discarded" && cleanup.action !== "cancelled" && cleanup.action !== "expired")
    || !Array.isArray(cleanup.artifactKeys)
    || cleanup.artifactKeys.length > MAX_CLEANUP_KEYS
    || cleanup.artifactKeys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 1_000)
    || !Number.isSafeInteger(cleanup.requestedAtMs) || (cleanup.requestedAtMs as number) < 0
  ) return false;
  return cleanup.completedAtMs === undefined
    || Number.isSafeInteger(cleanup.completedAtMs) && (cleanup.completedAtMs as number) >= (cleanup.requestedAtMs as number);
};

const validRules = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try { return encoder.encode(canonicalSerialize(value)).byteLength <= MAX_PROFILE_RULES_BYTES; } catch { return false; }
};

const validClaims = (value: unknown): value is AudioDescriptionGenerationRunReceiptClaims =>
  AudioDescriptionGenerationRunReceiptSchema.safeParse(value).success;

/** A schema-shaped non-content placeholder retained only after exact deletion. */
const redactedProjectionFor = (claims: AudioDescriptionGenerationRunReceiptClaims): CaptionEvidenceProjection => ({
  contractVersion: 1,
  projectId: claims.projectId,
  expectedProjectRevision: claims.expectedProjectRevision,
  expectedQualityProfileRevision: claims.expectedQualityProfileRevision,
  mediaSha256: claims.mediaSha256,
  localEvidencePackageIds: ["redacted"],
  captions: [{
    itemId: "redacted",
    itemRevision: 1,
    state: "Proposed",
    startMs: 0,
    endMs: 1,
    text: "redacted",
    evidenceIds: [],
  }],
  evidence: [],
});

const parseRecord = (value: unknown): AudioDescriptionGenerationRunRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== 1
    || typeof record.receipt !== "string" || record.receipt.length === 0 || record.receipt.length > 8_192
    || !validClaims(record.claims)
    || typeof record.uploadReceipt !== "string" || record.uploadReceipt.length === 0 || record.uploadReceipt.length > 8_192
    || !CaptionEvidenceProjectionSchema.safeParse(record.captionEvidenceProjection).success
    || !GenerationRunStatusSchema.safeParse(record.status).success
    || (record.cancelled !== true && record.cancelled !== false)
    || (record.dispatched !== true && record.dispatched !== false)
    || typeof record.windowCheckpoints !== "object" || record.windowCheckpoints === null || Array.isArray(record.windowCheckpoints)
    || Object.keys(record.windowCheckpoints as object).length > MAX_WINDOW_CHECKPOINTS
    || !Object.entries(record.windowCheckpoints as Readonly<Record<string, unknown>>).every(([windowId, checkpoint]) => OPAQUE_ID.test(windowId) && validWindowCheckpoint(checkpoint))
    || !Array.isArray(record.artifactRefs) || record.artifactRefs.length > MAX_ARTIFACT_REFS || !record.artifactRefs.every(validArtifactReference)
    || (record.stagedResultRef !== undefined && !validArtifactReference(record.stagedResultRef))
    || (record.cleanup !== undefined && !validCleanup(record.cleanup))
    || (record.leaseReleasePending !== undefined && record.leaseReleasePending !== true)
    || (record.contentRedacted !== undefined && record.contentRedacted !== true)
    || !Number.isSafeInteger(record.updatedAtMs) || (record.updatedAtMs as number) < 0
    || !validRules(record.qualityProfileRules)
  ) return null;
  const claims = record.claims as AudioDescriptionGenerationRunReceiptClaims;
  const status = record.status as GenerationRunStatus;
  if (
    status.targetTrack !== "AudioDescriptions"
    || status.runId !== claims.runId
    || status.projectId !== claims.projectId
    || status.expectedProjectRevision !== claims.expectedProjectRevision
  ) return null;
  const projection = record.captionEvidenceProjection as CaptionEvidenceProjection;
  const privateObjectKeys = record.privateObjectKeys === undefined ? [claims.objectKey] : record.privateObjectKeys;
  const redacted = record.contentRedacted === true;
  if (
    !Array.isArray(privateObjectKeys)
    || !redacted && privateObjectKeys.length === 0
    || privateObjectKeys.length > MAX_CLEANUP_KEYS
    || privateObjectKeys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 1_000 || !redacted && !isRunPrivateObjectKey(claims, key))
    || new Set(privateObjectKeys).size !== privateObjectKeys.length
  ) return null;
  if (!redacted && (
    projection.projectId !== claims.projectId
    || projection.expectedProjectRevision !== claims.expectedProjectRevision
    || projection.expectedQualityProfileRevision !== claims.expectedQualityProfileRevision
    || projection.mediaSha256.toLowerCase() !== claims.mediaSha256.toLowerCase()
    || !sameText(projectionHash(projection), claims.captionEvidenceHash.toLowerCase())
  )) return null;
  const artifacts = record.artifactRefs as readonly AudioDescriptionGenerationArtifactReference[];
  if (
    new Set(artifacts.map((artifact) => artifact.key)).size !== artifacts.length
    || artifacts.some((artifact) => !artifact.key.startsWith(artifactPrefix(claims.operationKey, claims.runId)))
    || record.cleanup !== undefined && (record.cleanup as AudioDescriptionGenerationCleanup).artifactKeys.some((key) => !isRunPrivateObjectKey(claims, key))
  ) return null;
  if (redacted && (
    record.receipt !== "redacted"
    || record.uploadReceipt !== "redacted"
    || record.qualityProfileRules !== undefined
    || privateObjectKeys.length !== 0
    || Object.keys(record.windowCheckpoints as object).length !== 0
    || record.stagedResultRef !== undefined
    || record.cleanup === undefined
    || !(record.cancelled || terminalStatus(status))
  )) return null;
  return clone({
    version: 1 as const,
    receipt: record.receipt,
    claims,
    uploadReceipt: record.uploadReceipt,
    captionEvidenceProjection: projection,
    ...(record.qualityProfileRules === undefined ? {} : { qualityProfileRules: record.qualityProfileRules as Readonly<Record<string, unknown>> }),
    status,
    cancelled: record.cancelled,
    dispatched: record.dispatched,
    windowCheckpoints: record.windowCheckpoints as Readonly<Record<string, AudioDescriptionWindowCheckpoint>>,
    ...(record.stagedResultRef === undefined ? {} : { stagedResultRef: record.stagedResultRef as AudioDescriptionGenerationArtifactReference }),
    artifactRefs: artifacts,
    privateObjectKeys: redacted ? [] : privateObjectKeys as readonly string[],
    ...(record.cleanup === undefined ? {} : { cleanup: record.cleanup as AudioDescriptionGenerationCleanup }),
    ...(record.leaseReleasePending === true ? { leaseReleasePending: true as const } : {}),
    ...(redacted ? { contentRedacted: true as const } : {}),
    updatedAtMs: record.updatedAtMs as number,
  });
};

const projectionHash = (projection: CaptionEvidenceProjection): string =>
  canonicalHash("cuebench.audio-description.caption-evidence.v1", projection).slice("sha256:".length).toLowerCase();

const statusFor = (
  claims: AudioDescriptionGenerationRunReceiptClaims,
  stage: GenerationRunStatus["stage"],
  extras: Readonly<Record<string, unknown>> = {},
): GenerationRunStatus => GenerationRunStatusSchema.parse({
  contractVersion: 1,
  runId: claims.runId,
  projectId: claims.projectId,
  targetTrack: "AudioDescriptions",
  expectedProjectRevision: claims.expectedProjectRevision,
  stage,
  ...extras,
});

const terminalStatus = (status: GenerationRunStatus): boolean =>
  status.stage === "Completed" || status.stage === "Cancelled" || status.stage === "Failed" && status.retryable === false;

const appendRef = (
  refs: readonly AudioDescriptionGenerationArtifactReference[],
  reference: AudioDescriptionGenerationArtifactReference,
): readonly AudioDescriptionGenerationArtifactReference[] => {
  const byKey = new Map(refs.map((entry) => [entry.key, entry]));
  const existing = byKey.get(reference.key);
  if (existing !== undefined && (existing.sha256 !== reference.sha256 || existing.byteLength !== reference.byteLength)) {
    throw new Error("CueBench found a conflicting immutable AD artifact reference.");
  }
  byKey.set(reference.key, reference);
  const output = [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  if (output.length > MAX_ARTIFACT_REFS) throw new Error("CueBench AD run exceeds its bounded private artifact references.");
  return output;
};

const sameClaims = (left: AudioDescriptionGenerationRunReceiptClaims, right: AudioDescriptionGenerationRunReceiptClaims): boolean => (
  left.runId === right.runId
  && left.projectId === right.projectId
  && left.targetTrack === right.targetTrack
  && left.expectedProjectRevision === right.expectedProjectRevision
  && left.expectedQualityProfileRevision === right.expectedQualityProfileRevision
  && left.mediaSha256.toLowerCase() === right.mediaSha256.toLowerCase()
  && left.captionEvidenceHash.toLowerCase() === right.captionEvidenceHash.toLowerCase()
  && left.sessionKey === right.sessionKey
  && left.ownerKey === right.ownerKey
  && left.projectKey === right.projectKey
  && left.sourceByteLength === right.sourceByteLength
  && left.sourceDurationMs === right.sourceDurationMs
  && left.operationId === right.operationId
  && left.operationKey === right.operationKey
  && left.objectKey === right.objectKey
  && left.issuedAtMs === right.issuedAtMs
  && left.expiresAtMs === right.expiresAtMs
);

/** Cancellation/acceptance beats an in-flight snapshot that was loaded earlier. */
const mergeRecord = (
  current: AudioDescriptionGenerationRunRecord,
  candidate: AudioDescriptionGenerationRunRecord,
): AudioDescriptionGenerationRunRecord => {
  if (!sameClaims(current.claims, candidate.claims)) {
    throw new Error("CueBench found conflicting private AD recovery records.");
  }
  if (
    current.receipt !== candidate.receipt
    && current.contentRedacted !== true
    && candidate.contentRedacted !== true
  ) throw new Error("CueBench found conflicting private AD recovery records.");
  const currentTerminal = current.cancelled || terminalStatus(current.status);
  const candidateTerminal = candidate.cancelled || terminalStatus(candidate.status);
  const winner = currentTerminal && !candidateTerminal ? current : candidate;
  const other = winner === current ? candidate : current;
  const windowCheckpoints: Record<string, AudioDescriptionWindowCheckpoint> = { ...current.windowCheckpoints };
  for (const [windowId, checkpoint] of Object.entries(candidate.windowCheckpoints)) {
    const existing = windowCheckpoints[windowId];
    // Completion is terminal for a window: an older failure snapshot, a late
    // worker retry, or a merge race may never turn a persisted result back
    // into accepted-unknown. A later attempt may only exist after a known
    // pre-acceptance failure, never after completion/ambiguity.
    if (existing === undefined) {
      windowCheckpoints[windowId] = checkpoint;
    } else if (existing.state === "completed" || existing.state === "accepted-unknown") {
      continue;
    } else if (checkpoint.state === "completed" || checkpoint.state === "accepted-unknown") {
      windowCheckpoints[windowId] = checkpoint;
    } else if (
      checkpoint.attempt > existing.attempt
      || checkpoint.attempt === existing.attempt && checkpoint.updatedAtMs >= existing.updatedAtMs
    ) {
      windowCheckpoints[windowId] = checkpoint;
    }
  }
  const stagedResultRef = current.stagedResultRef ?? candidate.stagedResultRef;
  if (current.cleanup !== undefined && candidate.cleanup !== undefined && current.cleanup.action !== candidate.cleanup.action) {
    throw new Error("CueBench found conflicting terminal AD cleanup actions.");
  }
  const artifactRefs = appendRefs(current.artifactRefs, candidate.artifactRefs);
  const privateObjectKeys = appendPrivateObjectKeys(current.privateObjectKeys, candidate.privateObjectKeys);
  const cleanupBase = current.cleanup ?? candidate.cleanup;
  const cleanup = cleanupBase === undefined ? undefined : (() => {
    const currentCleanup = current.cleanup;
    const candidateCleanup = candidate.cleanup;
    const artifactKeys = appendPrivateObjectKeys([], [
      ...(currentCleanup?.artifactKeys ?? []),
      ...(candidateCleanup?.artifactKeys ?? []),
      ...current.privateObjectKeys,
      ...candidate.privateObjectKeys,
      ...artifactRefs.map((artifact) => artifact.key),
    ]);
    // A completed cleanup may only stay completed when every exact artifact
    // it knows about was already part of the deleting snapshot. If a writer
    // raced terminal cleanup, reopen the tiny inventory instead of leaking
    // that immutable object or ever prefix-deleting a media directory.
    const knownByBothCompletedSnapshots = artifactKeys.every((key) =>
      (currentCleanup?.state !== "completed" || currentCleanup.artifactKeys.includes(key))
      && (candidateCleanup?.state !== "completed" || candidateCleanup.artifactKeys.includes(key)));
    const state = knownByBothCompletedSnapshots
      && (currentCleanup?.state === "completed" || candidateCleanup?.state === "completed")
      ? "completed" as const
      : "pending" as const;
    const requestedAtMs = Math.min(
      currentCleanup?.requestedAtMs ?? cleanupBase.requestedAtMs,
      candidateCleanup?.requestedAtMs ?? cleanupBase.requestedAtMs,
    );
    const completedAtMs = state === "completed"
      ? Math.max(currentCleanup?.completedAtMs ?? 0, candidateCleanup?.completedAtMs ?? 0)
      : undefined;
    return {
      version: 1 as const,
      state,
      action: cleanupBase.action,
      artifactKeys,
      requestedAtMs,
      ...(completedAtMs === undefined ? {} : { completedAtMs }),
    };
  })();
  const status = currentTerminal && !candidateTerminal ? current.status
    : candidateTerminal && !currentTerminal ? candidate.status
      : stagedResultRef !== undefined && !current.cancelled && !candidate.cancelled && !terminalStatus(winner.status)
        ? statusFor(winner.claims, "AwaitingAdoption")
        : winner.status;
  if (current.contentRedacted === true || candidate.contentRedacted === true) {
    const tombstone = current.contentRedacted === true ? current : candidate;
    const tombstoneCleanup = cleanup ?? tombstone.cleanup;
    if (tombstoneCleanup === undefined) throw new Error("CueBench AD tombstone lost its cleanup state.");
    return {
      ...redactedRecord({ ...tombstone, status, cancelled: current.cancelled || candidate.cancelled }, tombstoneCleanup, Math.max(current.updatedAtMs, candidate.updatedAtMs)),
      artifactRefs,
      // Exact private-object paths remain only in the cleanup inventory after
      // redaction. A late artifact ref reopens that inventory through the
      // merge above without restoring transcript/receipt content.
      privateObjectKeys: [],
      ...(current.leaseReleasePending === true || candidate.leaseReleasePending === true ? { leaseReleasePending: true as const } : {}),
    };
  }
  return {
    ...winner,
    uploadReceipt: current.uploadReceipt,
    captionEvidenceProjection: current.captionEvidenceProjection,
    ...(current.qualityProfileRules === undefined ? {} : { qualityProfileRules: current.qualityProfileRules }),
    status,
    cancelled: current.cancelled || candidate.cancelled,
    dispatched: current.dispatched || candidate.dispatched,
    windowCheckpoints,
    ...(stagedResultRef === undefined ? {} : { stagedResultRef }),
    artifactRefs,
    privateObjectKeys,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(current.leaseReleasePending === true || candidate.leaseReleasePending === true ? { leaseReleasePending: true as const } : {}),
    updatedAtMs: Math.max(current.updatedAtMs, candidate.updatedAtMs, other.updatedAtMs),
  };
};

const appendRefs = (
  first: readonly AudioDescriptionGenerationArtifactReference[],
  second: readonly AudioDescriptionGenerationArtifactReference[],
): readonly AudioDescriptionGenerationArtifactReference[] => second.reduce(appendRef, first);

const appendPrivateObjectKeys = (first: readonly string[], second: readonly string[]): readonly string[] => {
  const keys = [...new Set([...first, ...second])].sort((left, right) => left.localeCompare(right));
  if (keys.length > MAX_CLEANUP_KEYS) throw new Error("CueBench AD run exceeds its bounded private cleanup inventory.");
  return keys;
};

const cleanupInventory = (record: AudioDescriptionGenerationRunRecord): readonly string[] =>
  appendPrivateObjectKeys(record.privateObjectKeys, record.artifactRefs.map((artifact) => artifact.key));

const redactedRecord = (
  record: AudioDescriptionGenerationRunRecord,
  cleanup: AudioDescriptionGenerationCleanup,
  updatedAtMs: number,
): AudioDescriptionGenerationRunRecord => ({
  version: 1,
  receipt: "redacted",
  claims: record.claims,
  uploadReceipt: "redacted",
  captionEvidenceProjection: redactedProjectionFor(record.claims),
  status: record.status,
  cancelled: record.cancelled,
  dispatched: true,
  windowCheckpoints: {},
  artifactRefs: [],
  privateObjectKeys: [],
  cleanup,
  ...(record.leaseReleasePending === true ? { leaseReleasePending: true as const } : {}),
  contentRedacted: true,
  updatedAtMs: Math.max(record.updatedAtMs, updatedAtMs),
});

const sameArtifactKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);

const newRecord = (input: {
  readonly receipt: string;
  readonly claims: AudioDescriptionGenerationRunReceiptClaims;
  readonly uploadReceipt: string;
  readonly captionEvidenceProjection: CaptionEvidenceProjection;
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  readonly nowMs: number;
}): AudioDescriptionGenerationRunRecord => ({
  version: 1,
  receipt: input.receipt,
  claims: input.claims,
  uploadReceipt: input.uploadReceipt,
  captionEvidenceProjection: input.captionEvidenceProjection,
  ...(input.qualityProfileRules === undefined ? {} : { qualityProfileRules: input.qualityProfileRules }),
  status: statusFor(input.claims, "Queued"),
  cancelled: false,
  dispatched: false,
  windowCheckpoints: {},
  artifactRefs: [],
  privateObjectKeys: [input.claims.objectKey],
  updatedAtMs: input.nowMs,
});

export class InMemoryAudioDescriptionGenerationRunRecordStore implements AudioDescriptionGenerationRunRecordStore {
  private readonly records = new Map<string, AudioDescriptionGenerationRunRecord>();
  private readonly artifacts = new Map<string, unknown>();
  private key(input: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): string {
    return `${input.operationKey}:${input.runId}`;
  }
  public async load(input: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<AudioDescriptionGenerationRunRecord | null> {
    const record = this.records.get(this.key(input));
    return record === undefined ? null : clone(record);
  }
  public async save(candidate: AudioDescriptionGenerationRunRecord): Promise<void> {
    const key = this.key(candidate.claims);
    const current = this.records.get(key);
    this.records.set(key, clone(current === undefined ? candidate : mergeRecord(current, candidate)));
  }
  private async update(
    claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">,
    mutate: (record: AudioDescriptionGenerationRunRecord) => AudioDescriptionGenerationRunRecord | null,
  ): Promise<AudioDescriptionGenerationRunRecord | null> {
    const key = this.key(claims);
    const current = this.records.get(key);
    if (current === undefined) return null;
    const next = mutate(clone(current));
    if (next === null) return clone(current);
    const merged = mergeRecord(current, next);
    this.records.set(key, clone(merged));
    return clone(merged);
  }
  public async claimWindowProviderCall(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly nowMs: number }): Promise<AudioDescriptionWindowClaim> {
    if (!OPAQUE_ID.test(input.windowId)) throw new Error("CueBench received an invalid AD window identity.");
    let outcome: AudioDescriptionWindowClaim | null = null;
    const updated = await this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        outcome = { kind: "cancelled", record: current };
        return current;
      }
      const existing = current.windowCheckpoints[input.windowId];
      if (existing?.state === "completed" || existing?.state === "accepted-unknown") {
        outcome = { kind: existing.state, record: current };
        return current;
      }
      if (existing?.state === "calling") {
        outcome = { kind: "accepted-unknown", record: current };
        return current;
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      const attemptId = windowAttemptId(input.windowId, attempt);
      const next = {
        ...current,
        windowCheckpoints: {
          ...current.windowCheckpoints,
          [input.windowId]: { state: "calling" as const, attempt, attemptId, updatedAtMs: input.nowMs },
        },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
      outcome = { kind: "claimed", record: next, attemptId };
      return next;
    });
    return updated === null ? { kind: "missing" } : outcome ?? { kind: "accepted-unknown", record: updated };
  }
  public markWindowRetryableFailure(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.windowState(input, "retryable-failed");
  }
  public markWindowAcceptedUnknown(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.windowState(input, "accepted-unknown");
  }
  public recordPrivateObjectKeys(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly keys: readonly string[]; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      if (input.keys.length === 0) return current;
      if (input.keys.some((key) => !isRunPrivateObjectKey(current.claims, key))) {
        throw new Error("CueBench rejected a private object outside this audio-description run.");
      }
      return {
        ...current,
        privateObjectKeys: appendPrivateObjectKeys(current.privateObjectKeys, input.keys),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  private windowState(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }, state: "retryable-failed" | "accepted-unknown"): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      const existing = current.windowCheckpoints[input.windowId];
      if (
        current.cancelled || terminalStatus(current.status)
        || existing?.state !== "calling"
        || existing.attemptId !== input.attemptId
      ) return current;
      return {
        ...current,
        windowCheckpoints: {
          ...current.windowCheckpoints,
          [input.windowId]: { state, attempt: existing.attempt, attemptId: existing.attemptId, updatedAtMs: input.nowMs },
        },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async completeWindow(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly value: unknown; readonly nowMs: number }): Promise<AudioDescriptionGenerationArtifactReference | null> {
    const bytes = encoder.encode(canonicalSerialize(input.value));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("CueBench AD window checkpoint exceeds its private bound.");
    const digest = await sha256Hex(bytes);
    const reference = { key: artifactKey(input.claims.operationKey, input.claims.runId, "window", digest), sha256: digest, byteLength: bytes.byteLength };
    this.artifacts.set(reference.key, clone(input.value));
    const record = await this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        // A writer may have put an immutable artifact just before observing a
        // cancellation. Retain its exact key in the tombstone inventory so a
        // later cleanup never needs a dangerous prefix delete.
        return { ...current, artifactRefs: appendRef(current.artifactRefs, reference) };
      }
      const existing = current.windowCheckpoints[input.windowId];
      if (existing?.state === "completed") return current;
      if (existing?.state !== "calling" || existing.attemptId !== input.attemptId) return current;
      return {
        ...current,
        windowCheckpoints: { ...current.windowCheckpoints, [input.windowId]: { state: "completed", attempt: existing.attempt, attemptId: existing.attemptId, checkpoint: reference, updatedAtMs: input.nowMs } },
        artifactRefs: appendRef(current.artifactRefs, reference),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
    return record?.windowCheckpoints[input.windowId]?.checkpoint ?? null;
  }
  public async readWindowCheckpoint(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly reference: AudioDescriptionGenerationArtifactReference }): Promise<unknown | null> {
    const record = await this.load(input.claims);
    if (record === null || !record.artifactRefs.some((candidate) => candidate.key === input.reference.key && candidate.sha256 === input.reference.sha256)) return null;
    const value = this.artifacts.get(input.reference.key);
    return value === undefined ? null : clone(value);
  }
  public async stageResult(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly result: StagedAudioDescriptionGenerationResult; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    const result = StagedAudioDescriptionGenerationResultSchema.parse(input.result);
    const bytes = encoder.encode(canonicalSerialize(result));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("CueBench staged AD result exceeds its private bound.");
    const digest = await sha256Hex(bytes);
    const reference = { key: artifactKey(input.claims.operationKey, input.claims.runId, "staged-result", digest), sha256: digest, byteLength: bytes.byteLength };
    this.artifacts.set(reference.key, clone(result));
    return this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        return { ...current, artifactRefs: appendRef(current.artifactRefs, reference) };
      }
      return {
        ...current,
        stagedResultRef: reference,
        artifactRefs: appendRef(current.artifactRefs, reference),
        status: statusFor(current.claims, "AwaitingAdoption"),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async readStagedResult(record: AudioDescriptionGenerationRunRecord): Promise<StagedAudioDescriptionGenerationResult | null> {
    if (record.stagedResultRef === undefined) return null;
    const result = StagedAudioDescriptionGenerationResultSchema.safeParse(this.artifacts.get(record.stagedResultRef.key));
    return result.success ? clone(result.data) : null;
  }
  public terminal(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly action: AudioDescriptionGenerationCleanupAction; readonly adoptedProjectRevision?: number; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      if (current.cleanup !== undefined && current.cleanup.action !== input.action) return current;
      if (input.action === "adopted") {
        if (current.cancelled || current.status.stage !== "AwaitingAdoption" || input.adoptedProjectRevision === undefined) return current;
        return {
          ...current,
          status: statusFor(current.claims, "Completed", { adoptedProjectRevision: input.adoptedProjectRevision }),
          leaseReleasePending: true,
          updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
        };
      }
      if (current.status.stage === "Completed") return current;
      return {
        ...current,
        cancelled: true,
        status: statusFor(current.claims, "Cancelled"),
        leaseReleasePending: true,
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async cleanup(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly action: AudioDescriptionGenerationCleanupAction; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    const pending = await this.update(input.claims, (current) => {
      if (current.cleanup !== undefined && current.cleanup.action !== input.action) return current;
      if (current.cleanup?.state === "completed") return current;
      const cleanup: AudioDescriptionGenerationCleanup = {
        version: 1,
        state: "pending",
        action: input.action,
        artifactKeys: appendPrivateObjectKeys(current.cleanup?.artifactKeys ?? [], cleanupInventory(current)),
        requestedAtMs: current.cleanup?.requestedAtMs ?? input.nowMs,
      };
      return { ...current, cleanup, updatedAtMs: Math.max(current.updatedAtMs, input.nowMs) };
    });
    if (pending === null || pending.cleanup === undefined || pending.cleanup.action !== input.action || pending.cleanup.state === "completed") return pending;
    for (const key of pending.cleanup.artifactKeys) this.artifacts.delete(key);
    return this.update(input.claims, (current) => {
      if (
        current.cleanup === undefined
        || current.cleanup.action !== input.action
        || current.cleanup.state === "completed"
        || !sameArtifactKeys(current.cleanup.artifactKeys, pending.cleanup!.artifactKeys)
      ) return current;
      const cleanup: AudioDescriptionGenerationCleanup = { ...current.cleanup, state: "completed", completedAtMs: input.nowMs };
      return redactedRecord({ ...current, cleanup }, cleanup, input.nowMs);
    });
  }
  public markLeaseReleased(claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(claims, (current) => {
      if (current.leaseReleasePending !== true) return current;
      const next = { ...current } as Record<string, unknown>;
      Reflect.deleteProperty(next, "leaseReleasePending");
      return next as unknown as AudioDescriptionGenerationRunRecord;
    });
  }
}

/** Small SHA-256 helper kept in this Worker file so record writing has no browser dependency. */
const sha256Hex = async (value: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * R2 implementation uses CAS for every state transition. Cleanup deletes an
 * exact inventory and performs only a bounded artifact-prefix rescan to find
 * an orphaned immutable put; it never deletes a broad source-media prefix.
 */
export class R2AudioDescriptionGenerationRunRecordStore implements AudioDescriptionGenerationRunRecordStore {
  public constructor(private readonly bucket: R2Bucket) {}

  private async read(input: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<{ readonly record: AudioDescriptionGenerationRunRecord; readonly etag: string } | null> {
    const object = await this.bucket.get(recordKey(input.operationKey, input.runId));
    if (object === null) return null;
    if (object.size <= 0 || object.size > MAX_RECORD_BYTES) throw new Error("CueBench AD recovery record is unavailable or exceeds its bound.");
    let parsed: unknown;
    try { parsed = JSON.parse(await object.text()); } catch { throw new Error("CueBench AD recovery record is malformed."); }
    const record = parseRecord(parsed);
    if (record === null || record.claims.operationKey !== input.operationKey || record.claims.runId !== input.runId) {
      throw new Error("CueBench AD recovery record is invalid.");
    }
    return { record, etag: object.etag };
  }

  private async write(record: AudioDescriptionGenerationRunRecord, onlyIf: R2Conditional): Promise<boolean> {
    const bytes = jsonBytes(record, "CueBench AD recovery record cannot be encoded as JSON.");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECORD_BYTES) throw new Error("CueBench AD recovery record exceeds its private bound.");
    const written = await this.bucket.put(recordKey(record.claims.operationKey, record.claims.runId), bytes, {
      onlyIf,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cuebench_audio_description_run: "1" },
    });
    return written !== null;
  }

  private async update(
    claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">,
    mutate: (record: AudioDescriptionGenerationRunRecord) => AudioDescriptionGenerationRunRecord,
  ): Promise<AudioDescriptionGenerationRunRecord | null> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.read(claims);
      if (current === null) return null;
      const candidate = mergeRecord(current.record, mutate(clone(current.record)));
      if (await this.write(candidate, { etagMatches: current.etag })) return candidate;
    }
    throw new Error("CueBench could not persist an AD recovery transition after bounded contention.");
  }

  public async load(input: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<AudioDescriptionGenerationRunRecord | null> {
    return (await this.read(input))?.record ?? null;
  }

  public async save(candidate: AudioDescriptionGenerationRunRecord): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.read(candidate.claims);
      if (current === null) {
        if (await this.write(candidate, onlyIfAbsent())) return;
        continue;
      }
      const merged = mergeRecord(current.record, candidate);
      if (await this.write(merged, { etagMatches: current.etag })) return;
    }
    throw new Error("CueBench could not persist an AD recovery record after bounded contention.");
  }

  private async writeArtifact(input: {
    readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly kind: "window" | "staged-result";
    readonly value: unknown;
  }): Promise<AudioDescriptionGenerationArtifactReference> {
    const bytes = jsonBytes(input.value, "CueBench AD artifact cannot be encoded as JSON.");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("CueBench AD artifact exceeds its private bound.");
    const sha256 = await sha256Hex(bytes);
    const key = artifactKey(input.claims.operationKey, input.claims.runId, input.kind, sha256);
    const writerLease = generationArtifactWriteLeaseKey(input.claims.operationKey, input.claims.runId, key);
    // Register before the terminal-marker read. A cleanup that wins this race
    // sees the durable writer and remains pending; a writer that loses sees
    // the marker before it can publish. On an ambiguous R2 PUT failure the
    // lease intentionally remains: R2 cannot prove the write did not commit.
    const acquired = await this.bucket.put(writerLease, jsonBytes({ version: 1, artifactKey: key }, "CueBench AD artifact writer lease cannot be encoded."), {
      onlyIf: onlyIfAbsent(),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cuebench_audio_description_artifact_writer: "1" },
    });
    if (acquired === null) throw new Error("CueBench could not acquire its immutable AD artifact writer lease.");
    const releaseWriterLease = async (): Promise<boolean> => {
      try {
        await this.bucket.delete(writerLease);
        return true;
      } catch {
        return false;
      }
    };
    let putMayHaveStarted = false;
    try {
      if (await this.bucket.head(generationCleanupMarkerKey(input.claims.operationKey)) !== null) {
        if (!await releaseWriterLease()) throw new Error("CueBench could not settle a fenced AD artifact writer.");
        throw new Error("CueBench terminal cleanup fenced this private AD artifact.");
      }
      const existing = await this.bucket.head(key);
      if (existing === null) {
        putMayHaveStarted = true;
        const put = await this.bucket.put(key, bytes, {
          onlyIf: onlyIfAbsent(),
          httpMetadata: { contentType: "application/json; charset=utf-8" },
          customMetadata: { sha256, cuebench_audio_description_artifact: input.kind },
        });
        if (put === null) {
          const raced = await this.bucket.head(key);
          if (raced === null || raced.size !== bytes.byteLength || raced.customMetadata?.sha256?.toLowerCase() !== sha256) {
            throw new Error("CueBench could not durably write its immutable AD artifact.");
          }
        }
      } else if (existing.size !== bytes.byteLength || existing.customMetadata?.sha256?.toLowerCase() !== sha256) {
        throw new Error("CueBench found a conflicting immutable AD artifact.");
      }
      // A marker may appear immediately after the exact-key inventory scan.
      // Reclaim only this run's immutable object and never CAS a checkpoint
      // after the terminal action has fenced its operation.
      if (await this.bucket.head(generationCleanupMarkerKey(input.claims.operationKey)) !== null) {
        await this.bucket.delete(key);
        if (!await releaseWriterLease()) throw new Error("CueBench could not settle a fenced AD artifact writer.");
        throw new Error("CueBench terminal cleanup reclaimed this private AD artifact.");
      }
      if (!await releaseWriterLease()) throw new Error("CueBench could not settle its AD artifact writer lease.");
      return { key, sha256, byteLength: bytes.byteLength };
    } catch (error) {
      // Before an R2 PUT starts, no delayed publication is possible. Once it
      // starts, retain the lease on error so terminal cleanup cannot report a
      // false clean while R2 may still commit after this caller loses contact.
      if (!putMayHaveStarted) await releaseWriterLease();
      throw error;
    }
  }

  private async readArtifact(reference: AudioDescriptionGenerationArtifactReference): Promise<unknown | null> {
    const object = await this.bucket.get(reference.key);
    if (object === null || object.size !== reference.byteLength || object.size > MAX_ARTIFACT_BYTES) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256Hex(bytes) !== reference.sha256.toLowerCase()) return null;
    try { return JSON.parse(decoder.decode(bytes)); } catch { return null; }
  }

  /**
   * The record is the source of truth, but an immutable put can crash between
   * R2 acceptance and the following CAS. Scan only this run's artifact prefix
   * with a strict bound so that such an orphan becomes an exact key, never a
   * broad media-prefix delete.
   */
  private async orphanArtifactKeys(claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<readonly string[] | null> {
    const listed = await this.bucket.list({ prefix: artifactPrefix(claims.operationKey, claims.runId), limit: ORPHAN_ARTIFACT_SCAN_LIMIT });
    if (listed.truncated || listed.objects.length > MAX_ARTIFACT_REFS) return null;
    const keys = listed.objects.map((object) => object.key);
    return keys.every((key) => key.startsWith(artifactPrefix(claims.operationKey, claims.runId)))
      ? keys
      : null;
  }

  /**
   * A pre-CAS crash can leave a signed-preparer output unrecorded. Inventory
   * the five fixed namespaces independently with an extra list slot, so an
   * unexpected collection can never be silently truncated into "clean".
   */
  private async preparedOutputKeys(claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey">): Promise<readonly string[] | null> {
    const collections: ReadonlyArray<readonly [directory: string, maximum: number]> = [
      ["audio", 1],
      ["waveforms", 1],
      ["thumbnails", MAX_PREPARED_THUMBNAILS],
      ["manifests", 1],
      ["indexes", 1],
    ];
    const keys: string[] = [];
    for (const [directory, maximum] of collections) {
      const listed = await this.bucket.list({
        prefix: `${preparationPrefix(claims.operationKey)}${directory}/`,
        limit: maximum + 1,
      });
      if (listed.truncated || listed.objects.length > maximum) return null;
      const collectionKeys = listed.objects.map((object) => object.key);
      if (!collectionKeys.every((key) => isPreparedOperationOutputKey(claims.operationKey, key))) return null;
      keys.push(...collectionKeys);
    }
    return keys.length <= MAX_CLEANUP_KEYS && new Set(keys).size === keys.length
      ? keys.sort((left, right) => left.localeCompare(right))
      : null;
  }

  /**
   * The signed bridge writes this marker before every terminal cleanup. It
   * prevents a late container/preparer PUT after our inventory sweep; a
   * concurrent writer lease below still makes cleanup remain pending.
   */
  private async fencePreparationWrites(
    claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey">,
    action: AudioDescriptionGenerationCleanupAction,
    nowMs: number,
  ): Promise<void> {
    await this.bucket.put(generationCleanupMarkerKey(claims.operationKey), jsonBytes({
      version: 1,
      action,
      requestedAtMs: nowMs,
    }, "CueBench AD cleanup marker cannot be encoded."), {
      onlyIf: onlyIfAbsent(),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  /**
   * Any durable bridge writer lease means R2 cannot prove that its PUT has
   * drained. Do not inspect/delete that namespace: leave this run's exact
   * cleanup tombstone pending until the bridge settles its own lease.
   */
  private async hasActivePreparationWriterLease(claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey">): Promise<boolean | null> {
    const listed = await this.bucket.list({
      prefix: `${preparationPrefix(claims.operationKey)}generation-inflight/`,
      limit: MAX_PREPARATION_WRITER_LEASES + 1,
    });
    if (listed.truncated || listed.objects.length > MAX_PREPARATION_WRITER_LEASES) return null;
    return listed.objects.every((object) => object.key.startsWith(`${preparationPrefix(claims.operationKey)}generation-inflight/`))
      ? listed.objects.length > 0
      : null;
  }

  private async deleteInBatches(keys: readonly string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += CLEANUP_DELETE_BATCH_SIZE) {
      await this.bucket.delete([...keys.slice(offset, offset + CLEANUP_DELETE_BATCH_SIZE)]);
    }
  }

  public async claimWindowProviderCall(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly nowMs: number }): Promise<AudioDescriptionWindowClaim> {
    if (!OPAQUE_ID.test(input.windowId)) throw new Error("CueBench received an invalid AD window identity.");
    let outcome: AudioDescriptionWindowClaim | null = null;
    const updated = await this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        outcome = { kind: "cancelled", record: current };
        return current;
      }
      const existing = current.windowCheckpoints[input.windowId];
      if (existing?.state === "completed" || existing?.state === "accepted-unknown") {
        outcome = { kind: existing.state, record: current };
        return current;
      }
      if (existing?.state === "calling") {
        // A prior process crossed the durable pre-call boundary. No endpoint
        // can prove whether OpenAI accepted it, so recovery must fail closed.
        outcome = { kind: "accepted-unknown", record: current };
        return current;
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      const attemptId = windowAttemptId(input.windowId, attempt);
      const next = {
        ...current,
        windowCheckpoints: { ...current.windowCheckpoints, [input.windowId]: { state: "calling" as const, attempt, attemptId, updatedAtMs: input.nowMs } },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
      outcome = { kind: "claimed", record: next, attemptId };
      return next;
    });
    if (updated === null) return { kind: "missing" };
    return outcome ?? { kind: "accepted-unknown", record: updated };
  }

  private windowState(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }, state: "retryable-failed" | "accepted-unknown"): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      const existing = current.windowCheckpoints[input.windowId];
      if (
        current.cancelled || terminalStatus(current.status)
        || existing?.state !== "calling"
        || existing.attemptId !== input.attemptId
      ) return current;
      return {
        ...current,
        windowCheckpoints: {
          ...current.windowCheckpoints,
          [input.windowId]: { state, attempt: existing.attempt, attemptId: existing.attemptId, updatedAtMs: input.nowMs },
        },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public markWindowRetryableFailure(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.windowState(input, "retryable-failed");
  }
  public markWindowAcceptedUnknown(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.windowState(input, "accepted-unknown");
  }
  public recordPrivateObjectKeys(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly keys: readonly string[]; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      if (input.keys.length === 0) return current;
      if (input.keys.some((key) => !isRunPrivateObjectKey(current.claims, key))) {
        throw new Error("CueBench rejected a private object outside this audio-description run.");
      }
      return {
        ...current,
        privateObjectKeys: appendPrivateObjectKeys(current.privateObjectKeys, input.keys),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async completeWindow(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly windowId: string; readonly attemptId: string; readonly value: unknown; readonly nowMs: number }): Promise<AudioDescriptionGenerationArtifactReference | null> {
    const reference = await this.writeArtifact({ claims: input.claims, kind: "window", value: input.value });
    const updated = await this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        return { ...current, artifactRefs: appendRef(current.artifactRefs, reference) };
      }
      const existing = current.windowCheckpoints[input.windowId];
      if (existing?.state === "completed") return current;
      if (existing?.state !== "calling" || existing.attemptId !== input.attemptId) return current;
      return {
        ...current,
        windowCheckpoints: { ...current.windowCheckpoints, [input.windowId]: { state: "completed", attempt: existing.attempt, attemptId: existing.attemptId, checkpoint: reference, updatedAtMs: input.nowMs } },
        artifactRefs: appendRef(current.artifactRefs, reference),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
    return updated?.windowCheckpoints[input.windowId]?.checkpoint ?? null;
  }
  public async readWindowCheckpoint(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly reference: AudioDescriptionGenerationArtifactReference }): Promise<unknown | null> {
    const record = await this.load(input.claims);
    if (record === null || !record.artifactRefs.some((candidate) => candidate.key === input.reference.key && candidate.sha256 === input.reference.sha256)) return null;
    return this.readArtifact(input.reference);
  }
  public async stageResult(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly result: StagedAudioDescriptionGenerationResult; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    const result = StagedAudioDescriptionGenerationResultSchema.parse(input.result);
    const reference = await this.writeArtifact({ claims: input.claims, kind: "staged-result", value: result });
    return this.update(input.claims, (current) => {
      if (current.cancelled || terminalStatus(current.status)) {
        return { ...current, artifactRefs: appendRef(current.artifactRefs, reference) };
      }
      return {
        ...current,
        stagedResultRef: current.stagedResultRef ?? reference,
        artifactRefs: appendRef(current.artifactRefs, reference),
        status: statusFor(current.claims, "AwaitingAdoption"),
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async readStagedResult(record: AudioDescriptionGenerationRunRecord): Promise<StagedAudioDescriptionGenerationResult | null> {
    if (record.stagedResultRef === undefined) return null;
    const parsed = await this.readArtifact(record.stagedResultRef);
    const staged = StagedAudioDescriptionGenerationResultSchema.safeParse(parsed);
    if (!staged.success) return null;
    const value = staged.data;
    return value.runId === record.claims.runId
      && value.projectId === record.claims.projectId
      && value.expectedProjectRevision === record.claims.expectedProjectRevision
      && value.expectedQualityProfileRevision === record.claims.expectedQualityProfileRevision
      && value.mediaSha256.toLowerCase() === record.claims.mediaSha256.toLowerCase()
      && value.captionEvidenceHash.toLowerCase() === record.claims.captionEvidenceHash.toLowerCase()
      ? value
      : null;
  }
  public terminal(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly action: AudioDescriptionGenerationCleanupAction; readonly adoptedProjectRevision?: number; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(input.claims, (current) => {
      if (current.cleanup !== undefined && current.cleanup.action !== input.action) return current;
      if (input.action === "adopted") {
        if (current.cancelled || current.status.stage !== "AwaitingAdoption" || input.adoptedProjectRevision === undefined) return current;
        return {
          ...current,
          status: statusFor(current.claims, "Completed", { adoptedProjectRevision: input.adoptedProjectRevision }),
          leaseReleasePending: true,
          updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
        };
      }
      if (current.status.stage === "Completed") return current;
      return {
        ...current,
        cancelled: true,
        status: statusFor(current.claims, "Cancelled"),
        leaseReleasePending: true,
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
  }
  public async cleanup(input: { readonly claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">; readonly action: AudioDescriptionGenerationCleanupAction; readonly nowMs: number }): Promise<AudioDescriptionGenerationRunRecord | null> {
    const beforeFence = await this.load(input.claims);
    if (
      beforeFence === null
      || beforeFence.cleanup?.action !== undefined && beforeFence.cleanup.action !== input.action
      || beforeFence.cleanup?.state === "completed"
    ) return beforeFence;
    try {
      // Fence before the tombstone inventory so a bridge writer that began
      // before this call is visible through its durable writer lease, while
      // a writer that begins afterwards is rejected before its R2 PUT.
      await this.fencePreparationWrites(beforeFence.claims, input.action, input.nowMs);
    } catch {
      return beforeFence;
    }
    const pending = await this.update(input.claims, (current) => {
      if (current.cleanup !== undefined && current.cleanup.action !== input.action) return current;
      if (current.cleanup?.state === "completed") return current;
      return {
        ...current,
        cleanup: {
          version: 1,
          state: "pending",
          action: input.action,
          artifactKeys: appendPrivateObjectKeys(current.cleanup?.artifactKeys ?? [], cleanupInventory(current)),
          requestedAtMs: current.cleanup?.requestedAtMs ?? input.nowMs,
        },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
    if (pending === null || pending.cleanup === undefined || pending.cleanup.action !== input.action || pending.cleanup.state === "completed") return pending;
    const writersBeforeInventory = await this.hasActivePreparationWriterLease(input.claims).catch(() => null);
    if (writersBeforeInventory !== false) return pending;
    const [orphanArtifactKeys, orphanPreparedOutputKeys] = await Promise.all([
      this.orphanArtifactKeys(input.claims).catch(() => null),
      this.preparedOutputKeys(input.claims).catch(() => null),
    ]);
    // A truncated/unavailable scan never permits completion: bounded exact
    // cleanup must remain lifecycle-pending until it can inventory every put.
    if (orphanArtifactKeys === null || orphanPreparedOutputKeys === null) return pending;
    const inventoried = await this.update(input.claims, (current) => {
      if (current.cleanup === undefined || current.cleanup.action !== input.action || current.cleanup.state === "completed") return current;
      return {
        ...current,
        cleanup: {
          ...current.cleanup,
          artifactKeys: appendPrivateObjectKeys(current.cleanup.artifactKeys, [
            ...orphanArtifactKeys,
            ...orphanPreparedOutputKeys,
          ]),
        },
        updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
      };
    });
    if (inventoried === null || inventoried.cleanup === undefined || inventoried.cleanup.action !== input.action || inventoried.cleanup.state === "completed") return inventoried;
    const deletedArtifactKeys = inventoried.cleanup.artifactKeys;
    try {
      await this.deleteInBatches(deletedArtifactKeys);
    } catch {
      return inventoried;
    }
    // Detect a put that raced the first scan. We do not claim cleanup
    // complete unless all bounded artifact/preparer namespaces are empty and
    // no bridge writer lease remains; a later status/ack retry drains any
    // late exact key without a dangerous prefix delete.
    const [writersAfterDelete, afterDeleteArtifactOrphans, afterDeletePreparedOutputOrphans] = await Promise.all([
      this.hasActivePreparationWriterLease(input.claims).catch(() => null),
      this.orphanArtifactKeys(input.claims).catch(() => null),
      this.preparedOutputKeys(input.claims).catch(() => null),
    ]);
    if (
      writersAfterDelete !== false
      || afterDeleteArtifactOrphans === null
      || afterDeletePreparedOutputOrphans === null
      || afterDeleteArtifactOrphans.length > 0
      || afterDeletePreparedOutputOrphans.length > 0
    ) {
      if (
        writersAfterDelete !== false
        || afterDeleteArtifactOrphans === null
        || afterDeletePreparedOutputOrphans === null
      ) return inventoried;
      return this.update(input.claims, (current) => {
        if (current.cleanup === undefined || current.cleanup.action !== input.action || current.cleanup.state === "completed") return current;
        return {
          ...current,
          cleanup: {
            ...current.cleanup,
            artifactKeys: appendPrivateObjectKeys(current.cleanup.artifactKeys, [
              ...afterDeleteArtifactOrphans,
              ...afterDeletePreparedOutputOrphans,
            ]),
          },
          updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
        };
      });
    }
    return this.update(input.claims, (current) => {
      if (
        current.cleanup === undefined
        || current.cleanup.action !== input.action
        || current.cleanup.state === "completed"
        // A terminal writer raced our exact-key delete. Leave cleanup pending
        // so the next status/ack recovery deletes the newly inventoried key.
        || !sameArtifactKeys(current.cleanup.artifactKeys, deletedArtifactKeys)
      ) return current;
      const cleanup: AudioDescriptionGenerationCleanup = { ...current.cleanup, state: "completed", completedAtMs: input.nowMs };
      return redactedRecord({ ...current, cleanup }, cleanup, input.nowMs);
    });
  }
  public markLeaseReleased(claims: Pick<AudioDescriptionGenerationRunReceiptClaims, "operationKey" | "runId">): Promise<AudioDescriptionGenerationRunRecord | null> {
    return this.update(claims, (current) => {
      if (current.leaseReleasePending !== true) return current;
      const next = { ...current } as Record<string, unknown>;
      Reflect.deleteProperty(next, "leaseReleasePending");
      return next as unknown as AudioDescriptionGenerationRunRecord;
    });
  }
}

export interface AudioDescriptionGenerationWorkflowControl {
  readonly startAudioDescriptionGeneration: (input: {
    readonly operationKey: string;
    readonly runId: string;
    readonly receipt: string;
    readonly uploadReceipt: string;
  }) => Promise<void>;
  readonly cancelAudioDescriptionGeneration: (input: {
    readonly operationKey: string;
    readonly runId: string;
    readonly receipt: string;
  }) => Promise<void>;
}

/**
 * Keeps the Cloudflare instance identifier opaque and bounded while making an
 * accepted create recoverable with the exact same private AD run identity.
 */
export const audioDescriptionWorkflowInstanceId = async (operationKey: string, runId: string): Promise<string> => {
  if (!SHA256.test(operationKey) || !OPAQUE_ID.test(runId)) {
    throw new Error("CueBench cannot create an invalid audio-description Workflow identity.");
  }
  const bytes = encoder.encode(`cuebench:audio-description:${operationKey}:${runId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  return `cad-${hex.slice(0, 60)}`;
};

class AudioDescriptionWorkflowInstanceTerminalError extends Error {
  public constructor(public readonly workflowStatus: string) {
    super(`CueBench found a terminal audio-description Workflow instance (${workflowStatus}).`);
    this.name = "AudioDescriptionWorkflowInstanceTerminalError";
  }
}

const liveWorkflowStatuses = new Set(["queued", "running", "waiting", "paused"]);

/**
 * A duplicate Workflow create is never a reason to create another instance.
 * Only a live deterministic instance may be treated as a successful recovery;
 * a terminal instance without staged R2 evidence fails closed for human
 * recovery rather than risking another billable visual-analysis call.
 */
export const bindingAudioDescriptionWorkflow = (
  binding: WorkerEnv["AUDIO_DESCRIPTION_PROCESSING_WORKFLOW"] | undefined,
): AudioDescriptionGenerationWorkflowControl | undefined => {
  if (binding === undefined) return undefined;
  return {
    startAudioDescriptionGeneration: async ({ operationKey, runId, receipt, uploadReceipt }) => {
      const id = await audioDescriptionWorkflowInstanceId(operationKey, runId);
      try {
        await binding.create({ id, params: { audioDescriptionGenerationReceipt: receipt, uploadReceipt } });
      } catch (error) {
        if (binding.get === undefined) throw error;
        const instance = await binding.get(id);
        const status = await instance.status();
        if (liveWorkflowStatuses.has(status.status)) return;
        throw new AudioDescriptionWorkflowInstanceTerminalError(status.status);
      }
    },
    cancelAudioDescriptionGeneration: async () => {
      // R2 cancellation is authoritative and checked at each Workflow
      // boundary. The Workflows binding exposes no browser-safe hard kill.
    },
  };
};

export interface AudioDescriptionGenerationRouteDependencies {
  readonly clock?: () => number;
  readonly quotaLedger?: QuotaLedgerPort;
  readonly runs?: AudioDescriptionGenerationRunRecordStore;
  /** The existing store is used solely for the one global project lease. */
  readonly leases?: SharedLeaseStore;
  readonly workflow?: AudioDescriptionGenerationWorkflowControl;
}

interface StartRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly targetTrack: "AudioDescriptions";
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  readonly captionEvidenceProjection: CaptionEvidenceProjection;
  readonly captionEvidenceHash: string;
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
}

const bodyRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

const boundedRules = (value: unknown): Readonly<Record<string, unknown>> | null =>
  validRules(value) ? value as Readonly<Record<string, unknown>> : null;

const startRequest = (value: unknown): StartRequest | null => {
  const record = bodyRecord(value);
  const keys = [
    "projectId", "runId", "targetTrack", "expectedProjectRevision", "expectedQualityProfileRevision", "mediaSha256",
    "sourceByteLength", "sourceDurationMs", "captionEvidenceProjection", "captionEvidenceHash", "qualityProfileRules",
  ];
  if (record === null || Object.keys(record).some((key) => !keys.includes(key))) return null;
  const projection = CaptionEvidenceProjectionSchema.safeParse(record.captionEvidenceProjection);
  if (
    !projection.success
    || !OPAQUE_ID.test(record.projectId as string)
    || !OPAQUE_ID.test(record.runId as string)
    || record.targetTrack !== "AudioDescriptions"
    || !Number.isSafeInteger(record.expectedProjectRevision) || (record.expectedProjectRevision as number) <= 0
    || !Number.isSafeInteger(record.expectedQualityProfileRevision) || (record.expectedQualityProfileRevision as number) <= 0
    || typeof record.mediaSha256 !== "string" || !SHA256.test(record.mediaSha256)
    || !Number.isSafeInteger(record.sourceByteLength) || (record.sourceByteLength as number) <= 0
    || !Number.isSafeInteger(record.sourceDurationMs) || (record.sourceDurationMs as number) <= 0
    || typeof record.captionEvidenceHash !== "string" || !SHA256.test(record.captionEvidenceHash)
  ) return null;
  const rules = record.qualityProfileRules === undefined ? undefined : boundedRules(record.qualityProfileRules);
  if (rules === null) return null;
  return {
    projectId: record.projectId as string,
    runId: record.runId as string,
    targetTrack: "AudioDescriptions",
    expectedProjectRevision: record.expectedProjectRevision as number,
    expectedQualityProfileRevision: record.expectedQualityProfileRevision as number,
    mediaSha256: (record.mediaSha256 as string).toLowerCase(),
    sourceByteLength: record.sourceByteLength as number,
    sourceDurationMs: record.sourceDurationMs as number,
    captionEvidenceProjection: projection.data,
    captionEvidenceHash: (record.captionEvidenceHash as string).toLowerCase(),
    ...(rules === undefined ? {} : { qualityProfileRules: rules }),
  };
};

const projectionMatchesInput = (input: StartRequest): boolean => {
  const projection = input.captionEvidenceProjection;
  if (
    projection.projectId !== input.projectId
    || projection.expectedProjectRevision !== input.expectedProjectRevision
    || projection.expectedQualityProfileRevision !== input.expectedQualityProfileRevision
    || projection.mediaSha256.toLowerCase() !== input.mediaSha256
    || !sameText(projectionHash(projection), input.captionEvidenceHash)
  ) return false;
  return projection.captions.every((caption) => caption.startMs >= 0 && caption.endMs > caption.startMs && caption.endMs <= input.sourceDurationMs)
    && projection.evidence.every((evidence) => evidence.startMs >= 0 && evidence.endMs > evidence.startMs && evidence.endMs <= input.sourceDurationMs);
};

const apiError = (status: number, code: string, message: string, retrySafe = false): Response => Response.json({
  error: { version: 1, code, message, retrySafe, stateChanged: false, nextAction: retrySafe ? "retry" : "wait-for-status" },
}, { status });

const now = (dependencies: AudioDescriptionGenerationRouteDependencies): number => dependencies.clock?.() ?? Date.now();
const bearer = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  return header !== null && header.startsWith("Bearer ") && header.slice(7).trim() ? header.slice(7).trim() : null;
};
const uploadReceipt = (request: Request): string | null => request.headers.get("x-cuebench-operation-receipt")?.trim() || null;
const runReceipt = (request: Request): string | null => request.headers.get("x-cuebench-audio-description-receipt")?.trim() || null;
const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";

export const issueAudioDescriptionGenerationRunReceipt = (
  input: Omit<AudioDescriptionGenerationRunReceiptClaims, "version" | "keyId" | "type" | "contractVersion">,
  settings: Pick<WorkerSettings, "keyRing">,
): Promise<string> => signOpaqueToken<AudioDescriptionGenerationRunReceiptClaims>({
  contractVersion: 1,
  type: "audio-description-generation-run-receipt",
  ...input,
}, settings.keyRing);

export const verifyAudioDescriptionGenerationRunReceipt = async (
  token: string,
  settings: Pick<WorkerSettings, "keyRing">,
  currentNow: number,
): Promise<AudioDescriptionGenerationRunReceiptClaims> => {
  const claims = await verifyOpaqueToken<AudioDescriptionGenerationRunReceiptClaims>(
    token,
    settings.keyRing,
    currentNow,
    "audio-description-generation-run-receipt",
  );
  if (!validClaims(claims)) throw new SignedTokenError("malformed", "CueBench received an invalid audio-description generation receipt.");
  return claims;
};

const requestOwnsRun = async (
  request: Request,
  claims: AudioDescriptionGenerationRunReceiptClaims,
  settings: WorkerSettings,
  currentNow: number,
): Promise<boolean> => {
  const token = bearer(request);
  if (token === null) return false;
  try {
    const session = await verifyAnonymousSession(token, settings.keyRing, currentNow);
    if (session.purpose === "cleanup") return false;
    const rawOwner = request.headers.get("x-cuebench-project-owner");
    if (rawOwner === null || !SHA256.test(rawOwner)) return false;
    return (await saltedLedgerKey(settings.quotaSalt, "project-owner", rawOwner.toLowerCase())) === claims.ownerKey;
  } catch {
    return false;
  }
};

const sameStart = (record: AudioDescriptionGenerationRunRecord, input: StartRequest, ownerKey: string, upload: { readonly projectKey: string; readonly operationKey: string }): boolean => (
  record.claims.projectId === input.projectId
  && record.claims.expectedProjectRevision === input.expectedProjectRevision
  && record.claims.expectedQualityProfileRevision === input.expectedQualityProfileRevision
  && record.claims.mediaSha256.toLowerCase() === input.mediaSha256
  && record.claims.captionEvidenceHash.toLowerCase() === input.captionEvidenceHash
  && record.claims.ownerKey === ownerKey
  && record.claims.projectKey === upload.projectKey
  && record.claims.operationKey === upload.operationKey
  && record.claims.sourceByteLength === input.sourceByteLength
  && record.claims.sourceDurationMs === input.sourceDurationMs
  && canonicalSerialize(record.captionEvidenceProjection) === canonicalSerialize(input.captionEvidenceProjection)
  && canonicalSerialize(record.qualityProfileRules ?? {}) === canonicalSerialize(input.qualityProfileRules ?? {})
);

const releaseLease = async (
  leases: SharedLeaseStore,
  claims: AudioDescriptionGenerationRunReceiptClaims,
  currentNow: number,
): Promise<void> => leases.releaseActiveLease({
  sessionKey: claims.sessionKey,
  ownerKey: claims.ownerKey,
  projectKey: claims.projectKey,
  operationKey: claims.operationKey,
  runId: claims.runId,
  targetTrack: "AudioDescriptions",
  nowMs: currentNow,
});

const reconcileTerminal = async (
  runs: AudioDescriptionGenerationRunRecordStore,
  leases: SharedLeaseStore,
  record: AudioDescriptionGenerationRunRecord,
  currentNow: number,
): Promise<AudioDescriptionGenerationRunRecord> => {
  let reconciled = record;
  // A failed Workflow can never be safely replayed. It still owns this upload
  // operation until its exact private source/preparation inventory is durably
  // tombstoned, otherwise a later run could reuse the upload and an old
  // cancellation could delete that newer run's media.
  if (reconciled.status.stage === "Failed" && reconciled.status.retryable === false && reconciled.cleanup === undefined) {
    try {
      reconciled = (await runs.cleanup({
        claims: reconciled.claims,
        action: "discarded",
        nowMs: currentNow,
      })) ?? reconciled;
    } catch {
      // Leave the lease held. A later authenticated status request retries
      // the same bounded cleanup rather than releasing unsafe shared media.
    }
  }
  if (reconciled.cleanup?.state === "pending") {
    try {
      reconciled = (await runs.cleanup({
        claims: reconciled.claims,
        action: reconciled.cleanup.action,
        nowMs: currentNow,
      })) ?? reconciled;
    } catch {
      // The terminal inventory remains durable and bounded; a later status
      // poll/acknowledgement can safely resume exact-key cleanup.
    }
  }
  // A non-retryable failed run must finish (or at least durably enter) its
  // cleanup lifecycle before it releases the project/media lease. This also
  // preserves the operation marker that makes same-upload retries fail with a
  // fresh-upload requirement instead of racing old terminal cleanup.
  if (reconciled.status.stage === "Failed" && reconciled.status.retryable === false && reconciled.cleanup?.state !== "completed") return reconciled;
  if (reconciled.cleanup !== undefined && reconciled.cleanup.state !== "completed") return reconciled;
  if (reconciled.leaseReleasePending !== true) return reconciled;
  try {
    await releaseLease(leases, reconciled.claims, currentNow);
    return (await runs.markLeaseReleased(reconciled.claims)) ?? reconciled;
  } catch {
    return reconciled;
  }
};

const hasStagedResult = (record: AudioDescriptionGenerationRunRecord): boolean =>
  record.stagedResultRef !== undefined && record.status.stage === "AwaitingAdoption" && !record.cancelled;

const dispatch = async (
  runs: AudioDescriptionGenerationRunRecordStore,
  workflow: AudioDescriptionGenerationWorkflowControl,
  record: AudioDescriptionGenerationRunRecord,
  currentNow: number,
): Promise<AudioDescriptionGenerationRunRecord> => {
  if (record.cancelled || terminalStatus(record.status) || hasStagedResult(record) || record.dispatched) return record;
  // `save` is monotonic: the dispatch marker cannot erase a cancellation or staged result written by a Workflow race.
  try {
    await workflow.startAudioDescriptionGeneration({
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      receipt: record.receipt,
      uploadReceipt: record.uploadReceipt,
    });
  } catch (error) {
    if (!(error instanceof AudioDescriptionWorkflowInstanceTerminalError)) throw error;
    // The deterministic instance already terminated without a staged R2
    // result. Replaying it could bill again, so expose a durable terminal
    // recovery state and release the global lease instead.
    await runs.save({
      ...record,
      status: GenerationRunStatusSchema.parse({
        contractVersion: 1,
        runId: record.claims.runId,
        projectId: record.claims.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: record.claims.expectedProjectRevision,
        stage: "Failed",
        code: "AD_WORKFLOW_TERMINAL",
        message: "CueBench cannot safely replay a terminated audio-description workflow. Start a new review run after checking the recovery record.",
        retryable: false,
      }),
      leaseReleasePending: true,
      updatedAtMs: Math.max(record.updatedAtMs, currentNow),
    });
    return (await runs.load(record.claims)) ?? record;
  }
  await runs.save({ ...record, dispatched: true, updatedAtMs: Math.max(record.updatedAtMs, currentNow) });
  return (await runs.load(record.claims)) ?? record;
};

/** Same-origin hosted AD boundary; browser code only receives opaque receipts and staged review data. */
export const createAudioDescriptionGenerationRoutes = (
  env: WorkerEnv,
  dependencies: AudioDescriptionGenerationRouteDependencies = {},
) => {
  const app = new Hono<Bindings>();

  const stores = (): { readonly runs: AudioDescriptionGenerationRunRecordStore; readonly leases: SharedLeaseStore; readonly workflow: AudioDescriptionGenerationWorkflowControl; readonly ledger: QuotaLedgerPort } | null => {
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2AudioDescriptionGenerationRunRecordStore(env.PROCESSING_BUCKET));
    const leases = dependencies.leases ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const workflow = dependencies.workflow ?? bindingAudioDescriptionWorkflow(env.AUDIO_DESCRIPTION_PROCESSING_WORKFLOW);
    const ledger = dependencies.quotaLedger;
    return runs === undefined || leases === undefined || workflow === undefined || ledger === undefined ? null : { runs, leases, workflow, ledger };
  };

  app.post("/api/audio-description-runs", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench audio-description generation is not configured.", true); }
    const sessionToken = bearer(context.req.raw);
    const uploadToken = uploadReceipt(context.req.raw);
    if (sessionToken === null || uploadToken === null) return apiError(401, "SESSION_REQUIRED", "A current anonymous session and private upload receipt are required.");
    let session: Awaited<ReturnType<typeof verifyAnonymousSession>>;
    let upload: Awaited<ReturnType<typeof verifyUploadReceipt>>;
    try {
      session = await verifyAnonymousSession(sessionToken, settings.keyRing, currentNow);
      if (session.purpose === "cleanup") return apiError(403, "SESSION_CLEANUP_ONLY", "This session can only clean up private media.");
      upload = await verifyUploadReceipt(uploadToken, settings, currentNow);
    } catch (error) {
      return error instanceof SignedTokenError && error.code === "expired"
        ? apiError(410, "UPLOAD_EXPIRED", "The private upload receipt expired before audio-description generation could start.")
        : apiError(401, "SESSION_INVALID", "CueBench could not verify the anonymous session or private upload receipt.");
    }
    const input = startRequest(await context.req.json<unknown>().catch(() => null));
    if (input === null) return apiError(400, "AD_GENERATION_REQUEST_INVALID", "CueBench could not read the exact bounded caption-evidence request.");
    if (!projectionMatchesInput(input)) return apiError(400, "AD_CAPTION_EVIDENCE_INVALID", "CueBench rejected a stale, unbound, or out-of-range caption-evidence projection.");
    const rawOwner = context.req.header("x-cuebench-project-owner");
    if (rawOwner === undefined || !SHA256.test(rawOwner)) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "A matching browser-project owner capability is required for this private upload.");
    const [sessionKey, ownerKey, projectKey] = await Promise.all([
      saltedLedgerKey(settings.quotaSalt, "session", session.sessionId),
      saltedLedgerKey(settings.quotaSalt, "project-owner", rawOwner.toLowerCase()),
      saltedLedgerKey(settings.quotaSalt, "project", input.projectId),
    ]);
    if (ownerKey !== upload.ownerKey || projectKey !== upload.projectKey) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload belongs to a different CueBench project owner.");
    if (input.sourceByteLength !== upload.media.byteLength || input.sourceDurationMs !== upload.media.durationMs) return apiError(409, "UPLOAD_MEDIA_STALE", "This private upload receipt does not match the current project media dimensions.");
    const dependenciesForRun = stores();
    if (dependenciesForRun === null) return apiError(503, "AD_GENERATION_UNAVAILABLE", "CueBench cannot safely start a recoverable audio-description run right now.", true);
    const { runs, leases, workflow, ledger } = dependenciesForRun;
    const existing = await runs.load({ operationKey: upload.operationKey, runId: input.runId });
    if (existing !== null) {
      if (!sameStart(existing, input, ownerKey, upload)) return apiError(409, "IDEMPOTENCY_CONFLICT", "This audio-description run id was already used with different caption evidence.");
      const dispatched = await dispatch(runs, workflow, existing, currentNow).catch(() => existing);
      return context.json({ audioDescriptionGenerationReceipt: dispatched.receipt, retentionExpiresAtMs: dispatched.claims.expiresAtMs, status: dispatched.status }, 200);
    }
    if (env.PROCESSING_BUCKET !== undefined) {
      try {
        // Cleanup markers are operation-wide rather than target-specific. A
        // terminal AD run owns this upload until it has deleted/tombstoned the
        // source, so a new run must use a fresh upload/operation instead of
        // accepting a receipt that an old cancellation could later reclaim.
        if (await env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(upload.operationKey)) !== null) {
          return apiError(409, "UPLOAD_MEDIA_CLEANED", "This private upload was already cleaned up. Upload the current media again before generating audio descriptions.");
        }
        const source = await env.PROCESSING_BUCKET.head(upload.objectKey);
        if (source === null || source.size !== upload.media.byteLength || source.httpMetadata?.contentType !== upload.media.contentType) {
          return apiError(409, "UPLOAD_MEDIA_CLEANED", "This private upload is no longer available. Upload the current media again before generating audio descriptions.");
        }
      } catch { return apiError(503, "UPLOAD_MEDIA_UNAVAILABLE", "CueBench cannot verify the private upload before starting audio-description generation.", true); }
    }
    try {
      if (settings.globalSpendBreakerOpen || await ledger.isGlobalBreakerOpen({ nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents })) {
        return apiError(429, "GLOBAL_BREAKER", "CueBench generation is temporarily unavailable while the public-use spend limit is active.", true);
      }
    } catch { return apiError(503, "GLOBAL_BREAKER_UNAVAILABLE", "CueBench cannot safely check its processing spend limit right now.", true); }
    const expiresAtMs = Math.min(upload.expiresAtMs, session.expiresAtMs, currentNow + DAY_MS);
    if (expiresAtMs <= currentNow) return apiError(410, "UPLOAD_EXPIRED", "The private upload receipt expired before audio-description generation could start.");
    let lease: ActiveGenerationLeaseAcquisition;
    try {
      lease = await leases.acquireActiveLease({
        sessionKey,
        ownerKey,
        projectKey: upload.projectKey,
        operationKey: upload.operationKey,
        runId: input.runId,
        targetTrack: "AudioDescriptions",
        expiresAtMs,
        nowMs: currentNow,
      });
    } catch { return apiError(503, "AD_GENERATION_LEASE_UNAVAILABLE", "CueBench cannot safely reserve this project's durable generation lease right now.", true); }
    if (lease.kind === "conflict") return apiError(409, "GENERATION_LEASE_CONFLICT", "Another caption or audio-description run already owns this project's private media lease.");
    if (lease.kind === "same-run") {
      const recovered = await runs.load({ operationKey: upload.operationKey, runId: input.runId });
      if (recovered === null) return apiError(503, "AD_GENERATION_DISPATCH_PENDING", "CueBench is durably reserving this audio-description run. Retry with the same recovery lease.", true);
      if (!sameStart(recovered, input, ownerKey, upload)) return apiError(409, "IDEMPOTENCY_CONFLICT", "This audio-description run id was already used with different caption evidence.");
      const dispatched = await dispatch(runs, workflow, recovered, currentNow).catch(() => recovered);
      return context.json({ audioDescriptionGenerationReceipt: dispatched.receipt, retentionExpiresAtMs: dispatched.claims.expiresAtMs, status: dispatched.status }, 200);
    }
    const releaseUnrecorded = async (): Promise<void> => {
      await leases.releaseActiveLease({ sessionKey, ownerKey, projectKey: upload.projectKey, operationKey: upload.operationKey, runId: input.runId, targetTrack: "AudioDescriptions", nowMs: currentNow }).catch(() => undefined);
    };
    const ipKey = await saltedLedgerKey(settings.quotaSalt, "network", clientIp(context.req.raw));
    const quota = await ledger.reserveGeneration({
      sessionKey: upload.sessionKey,
      ipKey,
      usageKey: `audio-description-generation:${upload.operationKey}:${input.runId}`,
      nowMs: currentNow,
      quotas: settings.quotas,
    }).catch(() => null);
    if (quota === null) {
      await releaseUnrecorded();
      return apiError(503, "QUOTA_UNAVAILABLE", "CueBench cannot safely reserve anonymous generation quota right now.", true);
    }
    if (!quota) {
      await releaseUnrecorded();
      return apiError(429, "GENERATION_QUOTA", "CueBench's anonymous audio-description generation quota has been reached.", true);
    }
    let receipt: string;
    try {
      receipt = await issueAudioDescriptionGenerationRunReceipt({
        runId: input.runId,
        projectId: input.projectId,
        targetTrack: "AudioDescriptions",
        expectedProjectRevision: input.expectedProjectRevision,
        expectedQualityProfileRevision: input.expectedQualityProfileRevision,
        mediaSha256: input.mediaSha256,
        captionEvidenceHash: input.captionEvidenceHash,
        sessionKey,
        ownerKey,
        projectKey: upload.projectKey,
        sourceByteLength: input.sourceByteLength,
        sourceDurationMs: input.sourceDurationMs,
        operationId: upload.operationId,
        operationKey: upload.operationKey,
        objectKey: upload.objectKey,
        issuedAtMs: currentNow,
        expiresAtMs,
      }, settings);
    } catch {
      await releaseUnrecorded();
      return apiError(503, "AD_GENERATION_UNAVAILABLE", "CueBench could not issue a recoverable private audio-description receipt.", true);
    }
    const claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow);
    const record = newRecord({ receipt, claims, uploadReceipt: uploadToken, captionEvidenceProjection: input.captionEvidenceProjection, ...(input.qualityProfileRules === undefined ? {} : { qualityProfileRules: input.qualityProfileRules }), nowMs: currentNow });
    try {
      await runs.save(record);
    } catch {
      const observed = await runs.load(record.claims).catch(() => null);
      if (observed === null) {
        await releaseUnrecorded();
        return apiError(503, "AD_GENERATION_RECORD_UNAVAILABLE", "CueBench could not durably save this audio-description recovery receipt. No workflow was dispatched; retry safely.", true);
      }
      if (observed.receipt !== receipt) return apiError(409, "IDEMPOTENCY_CONFLICT", "This audio-description run id now belongs to different durable recovery evidence.");
    }
    const persisted = (await runs.load(record.claims)) ?? record;
    try {
      const dispatched = await dispatch(runs, workflow, persisted, currentNow);
      return context.json({ audioDescriptionGenerationReceipt: receipt, retentionExpiresAtMs: claims.expiresAtMs, status: dispatched.status }, 201);
    } catch {
      return apiError(503, "AD_GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable audio-description workflow yet.", true);
    }
  });

  const authorized = async (context: { readonly req: { readonly raw: Request; readonly param: (name: string) => string } }) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return { error: apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench audio-description generation is not configured.", true) }; }
    const receipt = runReceipt(context.req.raw);
    if (receipt === null) return { error: apiError(401, "AD_GENERATION_RECEIPT_REQUIRED", "A signed audio-description generation receipt is required.") };
    let claims: AudioDescriptionGenerationRunReceiptClaims;
    try { claims = await verifyAudioDescriptionGenerationRunReceipt(receipt, settings, currentNow); } catch { return { error: apiError(401, "AD_GENERATION_RECEIPT_INVALID", "CueBench could not verify this audio-description generation receipt.") }; }
    if (claims.runId !== context.req.param("runId")) return { error: apiError(403, "AD_GENERATION_RECEIPT_MISMATCH", "This receipt belongs to a different audio-description run.") };
    if (!await requestOwnsRun(context.req.raw, claims, settings, currentNow)) return { error: apiError(403, "AD_GENERATION_OWNERSHIP_MISMATCH", "A matching anonymous session and browser-project owner are required for this audio-description run.") };
    const available = stores();
    if (available === null) return { error: apiError(503, "AD_GENERATION_UNAVAILABLE", "CueBench cannot read private audio-description status right now.", true) };
    return { currentNow, settings, receipt, claims, ...available };
  };

  app.get("/api/audio-description-runs/:runId", async (context) => {
    const access = await authorized(context);
    if ("error" in access) return access.error;
    let record = await access.runs.load(access.claims);
    if (record === null || record.receipt !== access.receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private audio-description run.");
    if (record.leaseReleasePending === true || record.cleanup?.state === "pending") record = await reconcileTerminal(access.runs, access.leases, record, access.currentNow);
    return context.json({ status: record.status, recovery: record.windowCheckpoints });
  });

  app.get("/api/audio-description-runs/:runId/staged-result", async (context) => {
    const access = await authorized(context);
    if ("error" in access) return access.error;
    const record = await access.runs.load(access.claims);
    if (record === null || record.receipt !== access.receipt || record.cancelled || record.status.stage !== "AwaitingAdoption") {
      return apiError(409, "AD_GENERATION_RESULT_PENDING", "CueBench has not completed a staged audio-description result available for adoption.", true);
    }
    const result = await access.runs.readStagedResult(record);
    if (result === null) return apiError(503, "AD_GENERATION_RESULT_UNAVAILABLE", "CueBench cannot verify this private staged audio-description result.", true);
    return context.json({ result });
  });

  app.post("/api/audio-description-runs/:runId/acknowledge", async (context) => {
    const access = await authorized(context);
    if ("error" in access) return access.error;
    const body = bodyRecord(await context.req.json<unknown>().catch(() => null));
    if (body === null || Object.keys(body).some((key) => key !== "action" && key !== "adoptedProjectRevision")) {
      return apiError(400, "AD_GENERATION_ACKNOWLEDGEMENT_INVALID", "CueBench could not read this terminal audio-description acknowledgement.");
    }
    const action = body.action === "adopted" || body.action === "discarded" ? body.action : null;
    const adoptedProjectRevision = body.adoptedProjectRevision;
    if (
      action === null
      || action === "adopted" && (!Number.isSafeInteger(adoptedProjectRevision) || (adoptedProjectRevision as number) <= access.claims.expectedProjectRevision)
      || action === "discarded" && adoptedProjectRevision !== undefined
    ) return apiError(400, "AD_GENERATION_ACKNOWLEDGEMENT_INVALID", "CueBench could not read this terminal audio-description acknowledgement.");
    const record = await access.runs.load(access.claims);
    if (record === null || record.receipt !== access.receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private audio-description run.");
    if (record.cleanup !== undefined && record.cleanup.action !== action) return apiError(409, "AD_GENERATION_ACKNOWLEDGEMENT_CONFLICT", "CueBench already recorded a different terminal action for this audio-description run.");
    if (action === "adopted" && (record.cancelled || record.status.stage !== "AwaitingAdoption") && record.status.stage !== "Completed") {
      return apiError(409, "AD_GENERATION_ACKNOWLEDGEMENT_INVALID", "Only a staged result adopted through the local expected-revision transaction can be acknowledged.");
    }
    const terminal = await access.runs.terminal({ claims: access.claims, action, ...(action === "adopted" ? { adoptedProjectRevision: adoptedProjectRevision as number } : {}), nowMs: access.currentNow });
    if (terminal === null || terminal.cleanup !== undefined && terminal.cleanup.action !== action) return apiError(409, "AD_GENERATION_ACKNOWLEDGEMENT_CONFLICT", "CueBench already recorded a different terminal action for this audio-description run.");
    const cleaned = await access.runs.cleanup({ claims: access.claims, action, nowMs: access.currentNow });
    const reconciled = cleaned === null ? terminal : await reconcileTerminal(access.runs, access.leases, cleaned, access.currentNow);
    return context.json({ status: reconciled.status, cleanup: reconciled.cleanup });
  });

  app.delete("/api/audio-description-runs/:runId", async (context) => {
    const access = await authorized(context);
    if ("error" in access) return access.error;
    const record = await access.runs.load(access.claims);
    if (record === null || record.receipt !== access.receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private audio-description run.");
    if (record.status.stage === "Completed" || record.cleanup?.action === "adopted") return apiError(409, "AD_GENERATION_ACKNOWLEDGEMENT_CONFLICT", "An adopted audio-description run cannot be cancelled.");
    const terminal = await access.runs.terminal({ claims: access.claims, action: "cancelled", nowMs: access.currentNow });
    if (terminal === null || terminal.cleanup?.action === "adopted") return apiError(409, "AD_GENERATION_ACKNOWLEDGEMENT_CONFLICT", "An adopted audio-description run cannot be cancelled.");
    await access.workflow.cancelAudioDescriptionGeneration({ operationKey: access.claims.operationKey, runId: access.claims.runId, receipt: access.receipt }).catch(() => undefined);
    const cleaned = await access.runs.cleanup({ claims: access.claims, action: "cancelled", nowMs: access.currentNow });
    const reconciled = cleaned === null ? terminal : await reconcileTerminal(access.runs, access.leases, cleaned, access.currentNow);
    return context.json({ status: reconciled.status, cleanup: reconciled.cleanup });
  });

  return app;
};
