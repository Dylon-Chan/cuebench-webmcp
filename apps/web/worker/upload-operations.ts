/**
 * Serial, content-free upload coordination. The Durable Object holds only
 * opaque identifiers, multipart receipts, leases and lifecycle state. In
 * particular it never stores captions, filenames, URLs, media bytes or other
 * project content.
 */

import { DurableObjectQuotaLedger } from "./quota-ledger";

export type UploadOperationState =
  | "creating"
  | "pending"
  | "uploaded"
  | "completing"
  | "probing"
  | "ready"
  | "workflow-starting"
  | "queued"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "cleanup-pending"
  | "failed-retryable";

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly byteLength: number;
}

export interface OperationLease {
  readonly id: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

export interface CleanupTarget {
  /** `uncertain` means an external R2 call may have succeeded ambiguously. */
  readonly objectState: "multipart" | "completed" | "uncertain";
  readonly multipartUploadId: string | null;
  readonly reason: string;
}

type ClaimedPart = OperationLease;

export interface UploadOperationRecord {
  readonly ownerSessionKey: string;
  /** Saved only as a salted quota identity; it is never checked for recovery ownership. */
  readonly ownerIpKey: string;
  readonly metadataHash: string;
  readonly reservationKey: string;
  readonly objectKey: string;
  readonly byteLength: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly receiptExpiresAtMs: number;
  readonly state: UploadOperationState;
  readonly multipartUploadId: string | null;
  readonly parts: Readonly<Record<string, UploadedPart>>;
  readonly claims: Readonly<Record<string, ClaimedPart>>;
  /** Monotonic part generations make an expired body write unable to win later. */
  readonly partGenerations: Readonly<Record<string, number>>;
  readonly completionLease: OperationLease | null;
  /** A fenced external authoritative-probe lease. */
  readonly probeLease: OperationLease | null;
  readonly workflowLease: OperationLease | null;
  readonly cancellationLease: OperationLease | null;
  readonly nextLeaseGeneration: number;
  readonly cleanupTarget: CleanupTarget | null;
  readonly reconciliationNote: string | null;
}

export interface BeginUploadOperationInput {
  readonly ownerSessionKey: string;
  readonly ownerIpKey: string;
  readonly metadataHash: string;
  readonly reservationKey: string;
  readonly objectKey: string;
  readonly byteLength: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly receiptExpiresAtMs: number;
}

export type BeginUploadOperationResult =
  | { readonly kind: "created"; readonly record: UploadOperationRecord }
  | { readonly kind: "existing"; readonly record: UploadOperationRecord }
  | { readonly kind: "conflict"; readonly record: UploadOperationRecord };

export type PartClaimResult =
  | { readonly kind: "claimed"; readonly claim: OperationLease; readonly record: UploadOperationRecord }
  | { readonly kind: "uploaded"; readonly part: UploadedPart; readonly record: UploadOperationRecord }
  | { readonly kind: "in-progress"; readonly record: UploadOperationRecord }
  | { readonly kind: "unavailable"; readonly record: UploadOperationRecord };

export type PartRecordResult =
  | { readonly kind: "recorded"; readonly record: UploadOperationRecord }
  | { readonly kind: "stale"; readonly record: UploadOperationRecord }
  | { readonly kind: "invalid"; readonly record: UploadOperationRecord };

export type CompletionClaimResult =
  | { readonly kind: "claimed"; readonly claim: OperationLease; readonly record: UploadOperationRecord }
  | { readonly kind: "status"; readonly record: UploadOperationRecord };

export type CancellationClaimResult =
  | { readonly kind: "claimed"; readonly claim: OperationLease; readonly record: UploadOperationRecord }
  | { readonly kind: "status"; readonly record: UploadOperationRecord };

export interface UploadCoordinatorPort {
  begin: (input: BeginUploadOperationInput) => Promise<BeginUploadOperationResult>;
  attachMultipart: (input: { readonly uploadId: string; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  /** Records an upload id even when the caller failed after R2 creation but before attach. */
  markCreateReconciliation: (input: { readonly uploadId: string; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  get: (nowMs: number) => Promise<UploadOperationRecord | null>;
  claimPart: (input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }) => Promise<PartClaimResult>;
  releasePart: (input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  recordPart: (input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly etag: string; readonly byteLength: number; readonly nowMs: number }) => Promise<PartRecordResult>;
  beginCompletion: (input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }) => Promise<CompletionClaimResult>;
  markProbing: (input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  /** Claims the one authoritative probe allowed for an operation at a time. */
  claimProbe: (input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }) => Promise<CompletionClaimResult>;
  releaseProbe: (input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number; readonly note: string }) => Promise<UploadOperationRecord | null>;
  markReady: (input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  claimWorkflowStart: (input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }) => Promise<CompletionClaimResult>;
  /** Allows a deterministic workflow status lookup to reconcile an ambiguous create. */
  reconcileQueued: (input: { readonly nowMs: number; readonly claimId?: string; readonly claimGeneration?: number }) => Promise<UploadOperationRecord | null>;
  markQueued: (input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  /** A stale completion response cannot clobber a newer lifecycle state. */
  markRetryableFailure: (input: { readonly note: string; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }) => Promise<UploadOperationRecord | null>;
  /** Atomically prevents future multipart writes before any R2 deletion call. */
  claimCancellation: (input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string; readonly target: CleanupTarget; readonly mode?: "user" | "lifecycle" }) => Promise<CancellationClaimResult>;
  /** Cancellation is terminal only once both R2 and quota release acknowledge it. */
  finishCleanup: (input: { readonly claimId: string; readonly claimGeneration: number; readonly r2Acknowledged: boolean; readonly quotaAcknowledged: boolean; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
}

export interface DurableObjectStorage {
  get: <Value>(key: string) => Promise<Value | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  setAlarm?: (scheduledTime: number) => Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorage;
}

interface CoordinatorLifecycleEnv {
  readonly PROCESSING_BUCKET?: {
    readonly resumeMultipartUpload: (key: string, uploadId: string) => { abort: () => Promise<void> };
    readonly delete: (key: string) => Promise<void>;
  };
  readonly QUOTA_LEDGER?: ConstructorParameters<typeof DurableObjectQuotaLedger>[0];
}

// Keep the original key so an in-flight v2 operation is reconciled instead of
// disappearing on deployment. `normaliseRecord` upgrades its shape in place.
const storageKey = "cuebench-upload-coordinator-v2";
const partKey = (partNumber: number): string => String(partNumber);
/** A private object is retained until R2 and quota acknowledgement make cancellation terminal. */
const terminal = (state: UploadOperationState): boolean => state === "cancelled";
const leaseIsLive = (lease: OperationLease | null, nowMs: number): boolean => lease !== null && lease.expiresAtMs > nowMs;

const withRecord = (record: UploadOperationRecord, next: Partial<UploadOperationRecord>): UploadOperationRecord => ({ ...record, ...next });

/**
 * Cleanup intent is derived from the persisted lifecycle, never a stale
 * browser request. R2 complete may have succeeded whenever we were completing
 * or failed afterwards, so those states retain both abort/delete uncertainty.
 */
export const cleanupTargetForLifecycle = (
  record: Pick<UploadOperationRecord, "state" | "multipartUploadId">,
  reason: string,
): CleanupTarget => {
  const completed = record.state === "probing"
    || record.state === "ready"
    || record.state === "workflow-starting"
    || record.state === "queued"
    || record.state === "completed";
  const uncertain = record.state === "creating"
    || record.state === "completing"
    || record.state === "failed-retryable"
    || record.state === "cancelling"
    || record.state === "cleanup-pending";
  return {
    objectState: completed ? "completed" : uncertain || record.multipartUploadId === null ? "uncertain" : "multipart",
    multipartUploadId: record.multipartUploadId,
    reason,
  };
};

const cleanupTargetFor = cleanupTargetForLifecycle;

/**
 * Expiry never deletes state. It becomes explicit cleanup work so a client,
 * Worker alarm, or operational reconciler can truthfully finish private-copy
 * deletion without losing the multipart id.
 */
const normaliseRecord = (input: UploadOperationRecord | null, nowMs: number): UploadOperationRecord | null => {
  if (input === null) return null;
  const legacy = input as UploadOperationRecord & {
    readonly claims?: Readonly<Record<string, Partial<OperationLease> & { readonly claimId?: string }>>;
    readonly partGenerations?: Readonly<Record<string, number>>;
    readonly completionLease?: OperationLease | null;
    readonly probeLease?: OperationLease | null;
    readonly workflowLease?: OperationLease | null;
    readonly cancellationLease?: OperationLease | null;
    readonly nextLeaseGeneration?: number;
    readonly cleanupTarget?: CleanupTarget | null;
  };
  const claims = Object.fromEntries(Object.entries(legacy.claims ?? {})
    .filter(([, claim]) => typeof claim.expiresAtMs === "number" && claim.expiresAtMs > nowMs)
    .map(([key, claim]) => [key, {
      id: claim.id ?? claim.claimId ?? `legacy-${key}`,
      generation: claim.generation ?? 0,
      expiresAtMs: claim.expiresAtMs!,
    }]));
  const partGenerations = legacy.partGenerations ?? Object.fromEntries(Object.entries(claims).map(([key, claim]) => [key, claim.generation]));
  const maxGeneration = Math.max(0, ...Object.values(partGenerations));
  const record = withRecord(input, {
    claims,
    partGenerations,
    completionLease: leaseIsLive(legacy.completionLease ?? null, nowMs) ? legacy.completionLease! : null,
    probeLease: leaseIsLive(legacy.probeLease ?? null, nowMs) ? legacy.probeLease! : null,
    workflowLease: leaseIsLive(legacy.workflowLease ?? null, nowMs) ? legacy.workflowLease! : null,
    cancellationLease: leaseIsLive(legacy.cancellationLease ?? null, nowMs) ? legacy.cancellationLease! : null,
    nextLeaseGeneration: legacy.nextLeaseGeneration ?? maxGeneration,
    cleanupTarget: legacy.cleanupTarget ?? null,
  });
  if (terminal(record.state)) return record;
  if (record.state === "cleanup-pending" || record.state === "cancelling") {
    return record.cleanupTarget === null
      ? withRecord(record, { cleanupTarget: cleanupTargetFor(record, "cleanup-target-reconciliation") })
      : record;
  }
  if (record.expiresAtMs > nowMs) return record;
  return withRecord(record, {
    state: "cleanup-pending",
    claims: {},
    completionLease: null,
    probeLease: null,
    workflowLease: null,
    cleanupTarget: record.cleanupTarget ?? cleanupTargetFor(record, "lease-expired"),
    reconciliationNote: "lease-expired",
  });
};

const partExpectedBytes = (record: UploadOperationRecord, partNumber: number): number => {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > record.partCount) return 0;
  return partNumber === record.partCount
    ? record.byteLength - record.partSize * (record.partCount - 1)
    : record.partSize;
};

const allPartsPresent = (record: UploadOperationRecord): boolean => Object.keys(record.parts).length === record.partCount;

const createRecord = (input: BeginUploadOperationInput): UploadOperationRecord => ({
  ownerSessionKey: input.ownerSessionKey,
  ownerIpKey: input.ownerIpKey,
  metadataHash: input.metadataHash,
  reservationKey: input.reservationKey,
  objectKey: input.objectKey,
  byteLength: input.byteLength,
  partSize: input.partSize,
  partCount: input.partCount,
  createdAtMs: input.nowMs,
  expiresAtMs: input.expiresAtMs,
  receiptExpiresAtMs: input.receiptExpiresAtMs,
  state: "creating",
  multipartUploadId: null,
  parts: {},
  claims: {},
  partGenerations: {},
  completionLease: null,
  probeLease: null,
  workflowLease: null,
  cancellationLease: null,
  nextLeaseGeneration: 0,
  cleanupTarget: null,
  reconciliationNote: null,
});

const compatible = (record: UploadOperationRecord, input: BeginUploadOperationInput): boolean => record.ownerSessionKey === input.ownerSessionKey
  && record.metadataHash === input.metadataHash
  && record.reservationKey === input.reservationKey
  && record.objectKey === input.objectKey
  && record.byteLength === input.byteLength
  && record.partSize === input.partSize
  && record.partCount === input.partCount;

const newLease = (record: UploadOperationRecord, id: string, nowMs: number, leaseMs: number, extendPastOperation = false): { readonly record: UploadOperationRecord; readonly lease: OperationLease } => {
  const generation = record.nextLeaseGeneration + 1;
  const lease = { id, generation, expiresAtMs: extendPastOperation ? nowMs + leaseMs : Math.min(record.expiresAtMs, nowMs + leaseMs) };
  return { record: withRecord(record, { nextLeaseGeneration: generation }), lease };
};

const sameLease = (lease: OperationLease | null, id: string, generation: number): boolean => lease !== null && lease.id === id && lease.generation === generation;

/** Cloudflare exposes terminal multipart outcomes as structured error codes. */
const multipartAbortOutcome = (error: unknown): "already-absent" | "already-completed" | null => {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as Readonly<Record<string, unknown>>).code;
  if (code === "AlreadyCompleted") return "already-completed";
  return code === "NoSuchUpload" || code === "AlreadyAborted" ? "already-absent" : null;
};

type CoordinatorAction =
  | { readonly type: "begin"; readonly nowMs: number; readonly input: BeginUploadOperationInput }
  | { readonly type: "attach-multipart" | "mark-create-reconciliation"; readonly nowMs: number; readonly uploadId: string }
  | { readonly type: "get"; readonly nowMs: number }
  | { readonly type: "claim-part"; readonly nowMs: number; readonly partNumber: number; readonly leaseMs: number; readonly claimId: string }
  | { readonly type: "release-part"; readonly nowMs: number; readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number }
  | { readonly type: "record-part"; readonly nowMs: number; readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly etag: string; readonly byteLength: number }
  | { readonly type: "begin-completion"; readonly nowMs: number; readonly leaseMs: number; readonly claimId: string }
  | { readonly type: "mark-probing"; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }
  | { readonly type: "claim-probe"; readonly nowMs: number; readonly leaseMs: number; readonly claimId: string }
  | { readonly type: "release-probe"; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number; readonly note: string }
  | { readonly type: "mark-ready"; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }
  | { readonly type: "claim-workflow-start"; readonly nowMs: number; readonly leaseMs: number; readonly claimId: string }
  | { readonly type: "reconcile-queued"; readonly nowMs: number; readonly claimId?: string; readonly claimGeneration?: number }
  | { readonly type: "mark-queued"; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }
  | { readonly type: "retryable-failure"; readonly nowMs: number; readonly note: string; readonly claimId: string; readonly claimGeneration: number }
  | { readonly type: "claim-cancellation"; readonly nowMs: number; readonly leaseMs: number; readonly claimId: string; readonly target: CleanupTarget; readonly mode?: "user" | "lifecycle" }
  | { readonly type: "finish-cleanup"; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number; readonly r2Acknowledged: boolean; readonly quotaAcknowledged: boolean };

const partClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-part" }>): { readonly record: UploadOperationRecord; readonly value: PartClaimResult } => {
  const expected = partExpectedBytes(record, action.partNumber);
  if (expected === 0) return { record, value: { kind: "unavailable", record } };
  const key = partKey(action.partNumber);
  const existing = record.parts[key];
  if (existing !== undefined) return { record, value: { kind: "uploaded", part: existing, record } };
  if (record.state !== "pending" || record.multipartUploadId === null) return { record, value: { kind: "unavailable", record } };
  if (record.claims[key] !== undefined) return { record, value: { kind: "in-progress", record } };
  const generation = (record.partGenerations[key] ?? 0) + 1;
  const claim: OperationLease = { id: action.claimId, generation, expiresAtMs: Math.min(record.expiresAtMs, action.nowMs + action.leaseMs) };
  const next = withRecord(record, {
    claims: { ...record.claims, [key]: claim },
    partGenerations: { ...record.partGenerations, [key]: generation },
  });
  return { record: next, value: { kind: "claimed", claim, record: next } };
};

const completionClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "begin-completion" }>): { readonly record: UploadOperationRecord; readonly value: CompletionClaimResult } => {
  const isRetry = record.state === "completing" && record.completionLease === null;
  if (!((record.state === "uploaded" || record.state === "failed-retryable" || isRetry) && record.multipartUploadId !== null)) {
    return { record, value: { kind: "status", record } };
  }
  const leased = newLease(record, action.claimId, action.nowMs, action.leaseMs);
  const next = withRecord(leased.record, { state: "completing", completionLease: leased.lease, reconciliationNote: null });
  return { record: next, value: { kind: "claimed", claim: leased.lease, record: next } };
};

const workflowClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-workflow-start" }>): { readonly record: UploadOperationRecord; readonly value: CompletionClaimResult } => {
  const isRetry = record.state === "workflow-starting" && record.workflowLease === null;
  if (!(record.state === "ready" || isRetry)) return { record, value: { kind: "status", record } };
  const leased = newLease(record, action.claimId, action.nowMs, action.leaseMs);
  const next = withRecord(leased.record, { state: "workflow-starting", workflowLease: leased.lease, reconciliationNote: null });
  return { record: next, value: { kind: "claimed", claim: leased.lease, record: next } };
};

const probeClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-probe" }>): { readonly record: UploadOperationRecord; readonly value: CompletionClaimResult } => {
  if (record.state !== "probing" || record.probeLease !== null) return { record, value: { kind: "status", record } };
  const leased = newLease(record, action.claimId, action.nowMs, action.leaseMs);
  const next = withRecord(leased.record, { probeLease: leased.lease, reconciliationNote: null });
  return { record: next, value: { kind: "claimed", claim: leased.lease, record: next } };
};

/** Do not downgrade a known post-complete state merely because a stale client still knows a multipart id. */
const promotedCleanupTarget = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-cancellation" }>): CleanupTarget => {
  const derived = cleanupTargetFor(record, action.target.reason);
  const persisted = record.cleanupTarget;
  if (record.state === "cleanup-pending" || record.state === "cancelling") {
    if (persisted !== null) return persisted;
  }
  const objectState = persisted?.objectState === "uncertain" ? "uncertain" : derived.objectState;
  return {
    objectState,
    multipartUploadId: persisted?.multipartUploadId ?? derived.multipartUploadId ?? action.target.multipartUploadId,
    reason: persisted?.reason ?? action.target.reason,
  };
};

const cancellationClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-cancellation" }>): { readonly record: UploadOperationRecord; readonly value: CancellationClaimResult } => {
  if (record.state === "cancelled") {
    return { record, value: { kind: "status", record } };
  }
  if (action.mode !== "lifecycle" && (record.state === "queued" || record.state === "completed" || record.state === "workflow-starting")) {
    return { record, value: { kind: "status", record } };
  }
  if (record.state === "cancelling" && record.cancellationLease !== null) return { record, value: { kind: "status", record } };
  const target = promotedCleanupTarget(record, action);
  const leased = newLease(record, action.claimId, action.nowMs, action.leaseMs, true);
  const next = withRecord(leased.record, {
    state: "cancelling",
    claims: {},
    completionLease: null,
    probeLease: null,
    workflowLease: null,
    cancellationLease: leased.lease,
    cleanupTarget: target,
    reconciliationNote: target.reason,
  });
  return { record: next, value: { kind: "claimed", claim: leased.lease, record: next } };
};

const applyAction = (current: UploadOperationRecord | null, action: CoordinatorAction): { readonly record: UploadOperationRecord | null; readonly value: unknown } => {
  if (action.type === "begin") {
    if (current === null) {
      const record = createRecord(action.input);
      return { record, value: { kind: "created", record } satisfies BeginUploadOperationResult };
    }
    return { record: current, value: compatible(current, action.input)
      ? { kind: "existing", record: current } satisfies BeginUploadOperationResult
      : { kind: "conflict", record: current } satisfies BeginUploadOperationResult };
  }
  if (current === null) return { record: null, value: null };
  if (action.type === "get") return { record: current, value: current };
  if (action.type === "attach-multipart" || action.type === "mark-create-reconciliation") {
    if (current.state === "creating") {
      const record = withRecord(current, { multipartUploadId: action.uploadId, state: "pending" });
      return { record, value: record };
    }
    if (current.state === "cancelling" || current.state === "cleanup-pending") {
      const existingTarget = current.cleanupTarget ?? cleanupTargetFor(current, "create-reconciliation");
      const cleanupTarget = {
        ...existingTarget,
        objectState: existingTarget.objectState === "completed" ? "uncertain" : existingTarget.objectState,
        multipartUploadId: existingTarget.multipartUploadId ?? action.uploadId,
      } satisfies CleanupTarget;
      const record = withRecord(current, { multipartUploadId: current.multipartUploadId ?? action.uploadId, cleanupTarget });
      return { record, value: record };
    }
    return { record: current, value: current };
  }
  if (action.type === "claim-part") {
    const applied = partClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "release-part") {
    const key = partKey(action.partNumber);
    const claim = current.claims[key];
    if (claim === undefined || !sameLease(claim, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const claims = Object.fromEntries(Object.entries(current.claims).filter(([entry]) => entry !== key));
    const record = withRecord(current, { claims });
    return { record, value: record };
  }
  if (action.type === "record-part") {
    const key = partKey(action.partNumber);
    const claim = current.claims[key];
    if (claim === undefined || !sameLease(claim, action.claimId, action.claimGeneration)) {
      return { record: current, value: { kind: "stale", record: current } satisfies PartRecordResult };
    }
    const expected = partExpectedBytes(current, action.partNumber);
    if (current.state !== "pending" || expected !== action.byteLength || action.etag.length === 0) {
      return { record: current, value: { kind: "invalid", record: current } satisfies PartRecordResult };
    }
    const claims = Object.fromEntries(Object.entries(current.claims).filter(([entry]) => entry !== key));
    const parts = { ...current.parts, [key]: { partNumber: action.partNumber, etag: action.etag, byteLength: action.byteLength } };
    const pending = withRecord(current, { claims, parts });
    const record = allPartsPresent(pending) ? withRecord(pending, { state: "uploaded" }) : pending;
    return { record, value: { kind: "recorded", record } satisfies PartRecordResult };
  }
  if (action.type === "begin-completion") {
    const applied = completionClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "mark-probing") {
    if (current.state !== "completing" || !sameLease(current.completionLease, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const record = withRecord(current, { state: "probing", completionLease: null, probeLease: null });
    return { record, value: record };
  }
  if (action.type === "claim-probe") {
    const applied = probeClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "release-probe") {
    if (current.state !== "probing" || !sameLease(current.probeLease, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const record = withRecord(current, { probeLease: null, reconciliationNote: action.note });
    return { record, value: record };
  }
  if (action.type === "mark-ready") {
    if (current.state !== "probing" || !sameLease(current.probeLease, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const record = withRecord(current, { state: "ready", probeLease: null, reconciliationNote: null });
    return { record, value: record };
  }
  if (action.type === "claim-workflow-start") {
    const applied = workflowClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "reconcile-queued" || action.type === "mark-queued") {
    const claimed = action.type === "reconcile-queued" && action.claimId === undefined
      ? true
      : sameLease(current.workflowLease, action.claimId!, action.claimGeneration!);
    if (current.state !== "workflow-starting" || !claimed) return { record: current, value: current };
    const record = withRecord(current, { state: "queued", workflowLease: null, reconciliationNote: null });
    return { record, value: record };
  }
  if (action.type === "retryable-failure") {
    if (current.state !== "completing" || !sameLease(current.completionLease, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const record = withRecord(current, { state: "failed-retryable", completionLease: null, reconciliationNote: action.note });
    return { record, value: record };
  }
  if (action.type === "claim-cancellation") {
    const applied = cancellationClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "finish-cleanup") {
    if (current.state !== "cancelling" || !sameLease(current.cancellationLease, action.claimId, action.claimGeneration)) return { record: current, value: current };
    const record = action.r2Acknowledged && action.quotaAcknowledged
      ? withRecord(current, { state: "cancelled", cancellationLease: null, cleanupTarget: null, reconciliationNote: null })
      : withRecord(current, { state: "cleanup-pending", cancellationLease: null, reconciliationNote: "cleanup-acknowledgement-pending" });
    return { record, value: record };
  }
  return { record: current, value: current };
};

const nextAlarmAt = (record: UploadOperationRecord, nowMs: number): number | null => {
  if (terminal(record.state)) return null;
  if (record.state === "cleanup-pending" || record.state === "cancelling") return nowMs + 60_000;
  if (record.expiresAtMs > nowMs) return record.expiresAtMs;
  // Retry a failed cleanup on a bounded cadence without claiming the object is gone.
  return nowMs + 60_000;
};

/** A serial Durable Object per opaque operation hash. */
export class UploadCoordinator {
  public constructor(private readonly state: DurableObjectStateLike, private readonly lifecycle: CoordinatorLifecycleEnv = {}) {}

  private async persist(record: UploadOperationRecord | null, nowMs: number): Promise<void> {
    await this.state.storage.put(storageKey, record);
    const next = record === null ? null : nextAlarmAt(record, nowMs);
    if (next !== null) await this.state.storage.setAlarm?.(next);
  }

  public async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method-not-allowed" }, { status: 405 });
    let action: CoordinatorAction;
    try {
      action = await request.json() as CoordinatorAction;
    } catch {
      return Response.json({ error: "invalid-json" }, { status: 400 });
    }
    const current = normaliseRecord((await this.state.storage.get<UploadOperationRecord>(storageKey)) ?? null, action.nowMs);
    const applied = applyAction(current, action);
    await this.persist(applied.record, action.nowMs);
    return Response.json(applied.value);
  }

  /**
   * Durable Object alarms reconcile expiry without a browser returning. The
   * target is persisted before calls, so an abort/delete or quota outage stays
   * truthfully retryable rather than silently orphaning private media.
   */
  public async alarm(): Promise<void> {
    const nowMs = Date.now();
    const current = normaliseRecord((await this.state.storage.get<UploadOperationRecord>(storageKey)) ?? null, nowMs);
    if (current === null || terminal(current.state)) return;
    const action: CoordinatorAction = {
      type: "claim-cancellation",
      nowMs,
      leaseMs: 60_000,
      claimId: globalThis.crypto.randomUUID(),
      target: current.cleanupTarget ?? cleanupTargetFor(current, "expiry-alarm"),
      mode: "lifecycle",
    };
    const claimed = applyAction(current, action);
    await this.persist(claimed.record, nowMs);
    const result = claimed.value as CancellationClaimResult;
    const bucket = this.lifecycle.PROCESSING_BUCKET;
    const quotaLedgerNamespace = this.lifecycle.QUOTA_LEDGER;
    if (result.kind !== "claimed" || bucket === undefined || quotaLedgerNamespace === undefined) return;
    const target = result.record.cleanupTarget;
    if (target === null) return;
    // An unknown multipart id can never be acknowledged by deleting the object
    // key; keep it in cleanup-pending for the configured R2 lifecycle backstop.
    let r2Acknowledged = !(target.objectState === "uncertain" && target.multipartUploadId === null);
    let mustDeleteObject = target.objectState === "completed" || target.objectState === "uncertain";
    if ((target.objectState === "multipart" || target.objectState === "uncertain") && target.multipartUploadId !== null) {
      try {
        await bucket.resumeMultipartUpload(result.record.objectKey, target.multipartUploadId).abort();
      } catch (error) {
        const outcome = multipartAbortOutcome(error);
        if (outcome === "already-completed") mustDeleteObject = true;
        if (outcome === null) r2Acknowledged = false;
      }
    }
    if (mustDeleteObject) {
      try {
        await bucket.delete(result.record.objectKey);
      } catch {
        r2Acknowledged = false;
      }
    }
    const quotaAcknowledged = await (async (): Promise<boolean> => {
      try {
        await new DurableObjectQuotaLedger(quotaLedgerNamespace).releaseUploadReservation({ reservationKey: result.record.reservationKey, nowMs });
        return true;
      } catch {
        return false;
      }
    })();
    const finished = applyAction(normaliseRecord((await this.state.storage.get<UploadOperationRecord>(storageKey)) ?? null, nowMs), {
      type: "finish-cleanup",
      nowMs,
      claimId: result.claim.id,
      claimGeneration: result.claim.generation,
      r2Acknowledged,
      quotaAcknowledged,
    });
    await this.persist(finished.record, nowMs);
  }
}

/** Fixture implementation uses exactly the same serial transition functions. */
export class InMemoryUploadCoordinator implements UploadCoordinatorPort {
  private record: UploadOperationRecord | null = null;

  private apply(action: CoordinatorAction): unknown {
    const current = normaliseRecord(this.record, action.nowMs);
    const applied = applyAction(current, action);
    this.record = applied.record;
    return applied.value;
  }

  public async begin(input: BeginUploadOperationInput): Promise<BeginUploadOperationResult> { return this.apply({ type: "begin", nowMs: input.nowMs, input }) as BeginUploadOperationResult; }
  public async attachMultipart(input: { readonly uploadId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "attach-multipart", ...input }) as UploadOperationRecord | null; }
  public async markCreateReconciliation(input: { readonly uploadId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "mark-create-reconciliation", ...input }) as UploadOperationRecord | null; }
  public async get(nowMs: number): Promise<UploadOperationRecord | null> { return this.apply({ type: "get", nowMs }) as UploadOperationRecord | null; }
  public async claimPart(input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<PartClaimResult> { return this.apply({ type: "claim-part", nowMs: input.nowMs, partNumber: input.partNumber, leaseMs: input.leaseMs, claimId: input.createId() }) as PartClaimResult; }
  public async releasePart(input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "release-part", ...input }) as UploadOperationRecord | null; }
  public async recordPart(input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly etag: string; readonly byteLength: number; readonly nowMs: number }): Promise<PartRecordResult> { return this.apply({ type: "record-part", ...input }) as PartRecordResult; }
  public async beginCompletion(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.apply({ type: "begin-completion", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }) as CompletionClaimResult; }
  public async markProbing(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "mark-probing", ...input }) as UploadOperationRecord | null; }
  public async claimProbe(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.apply({ type: "claim-probe", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }) as CompletionClaimResult; }
  public async releaseProbe(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number; readonly note: string }): Promise<UploadOperationRecord | null> { return this.apply({ type: "release-probe", ...input }) as UploadOperationRecord | null; }
  public async markReady(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "mark-ready", ...input }) as UploadOperationRecord | null; }
  public async claimWorkflowStart(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.apply({ type: "claim-workflow-start", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }) as CompletionClaimResult; }
  public async reconcileQueued(input: { readonly nowMs: number; readonly claimId?: string; readonly claimGeneration?: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "reconcile-queued", ...input }) as UploadOperationRecord | null; }
  public async markQueued(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "mark-queued", ...input }) as UploadOperationRecord | null; }
  public async markRetryableFailure(input: { readonly note: string; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "retryable-failure", ...input }) as UploadOperationRecord | null; }
  public async claimCancellation(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string; readonly target: CleanupTarget; readonly mode?: "user" | "lifecycle" }): Promise<CancellationClaimResult> { return this.apply({ type: "claim-cancellation", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId(), target: input.target, ...(input.mode === undefined ? {} : { mode: input.mode }) }) as CancellationClaimResult; }
  public async finishCleanup(input: { readonly claimId: string; readonly claimGeneration: number; readonly r2Acknowledged: boolean; readonly quotaAcknowledged: boolean; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.apply({ type: "finish-cleanup", ...input }) as UploadOperationRecord | null; }
}

export class DurableObjectUploadCoordinator implements UploadCoordinatorPort {
  public constructor(private readonly namespace: { readonly idFromName: (name: string) => unknown; readonly get: (id: unknown) => { fetch: (request: Request) => Promise<Response> } }, private readonly operationKey: string) {}

  private async call<Value>(action: CoordinatorAction): Promise<Value> {
    const response = await this.namespace.get(this.namespace.idFromName(this.operationKey)).fetch(new Request("https://upload-coordinator.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    }));
    if (!response.ok) throw new Error("CueBench upload coordination is unavailable.");
    return response.json() as Promise<Value>;
  }

  public begin(input: BeginUploadOperationInput): Promise<BeginUploadOperationResult> { return this.call({ type: "begin", nowMs: input.nowMs, input }); }
  public attachMultipart(input: { readonly uploadId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "attach-multipart", ...input }); }
  public markCreateReconciliation(input: { readonly uploadId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-create-reconciliation", ...input }); }
  public get(nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "get", nowMs }); }
  public claimPart(input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<PartClaimResult> { return this.call({ type: "claim-part", nowMs: input.nowMs, partNumber: input.partNumber, leaseMs: input.leaseMs, claimId: input.createId() }); }
  public releasePart(input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "release-part", ...input }); }
  public recordPart(input: { readonly partNumber: number; readonly claimId: string; readonly claimGeneration: number; readonly etag: string; readonly byteLength: number; readonly nowMs: number }): Promise<PartRecordResult> { return this.call({ type: "record-part", ...input }); }
  public beginCompletion(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.call({ type: "begin-completion", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }); }
  public markProbing(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-probing", ...input }); }
  public claimProbe(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.call({ type: "claim-probe", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }); }
  public releaseProbe(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number; readonly note: string }): Promise<UploadOperationRecord | null> { return this.call({ type: "release-probe", ...input }); }
  public markReady(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-ready", ...input }); }
  public claimWorkflowStart(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<CompletionClaimResult> { return this.call({ type: "claim-workflow-start", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId() }); }
  public reconcileQueued(input: { readonly nowMs: number; readonly claimId?: string; readonly claimGeneration?: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "reconcile-queued", ...input }); }
  public markQueued(input: { readonly claimId: string; readonly claimGeneration: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-queued", ...input }); }
  public markRetryableFailure(input: { readonly note: string; readonly nowMs: number; readonly claimId: string; readonly claimGeneration: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "retryable-failure", ...input }); }
  public claimCancellation(input: { readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string; readonly target: CleanupTarget; readonly mode?: "user" | "lifecycle" }): Promise<CancellationClaimResult> { return this.call({ type: "claim-cancellation", nowMs: input.nowMs, leaseMs: input.leaseMs, claimId: input.createId(), target: input.target, ...(input.mode === undefined ? {} : { mode: input.mode }) }); }
  public finishCleanup(input: { readonly claimId: string; readonly claimGeneration: number; readonly r2Acknowledged: boolean; readonly quotaAcknowledged: boolean; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "finish-cleanup", ...input }); }
}

export const expectedPartByteLength = partExpectedBytes;
