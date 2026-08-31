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
import {
  generationArtifactWriteLeaseKey,
  generationCleanupMarkerKey,
  generationPreparationWriteLeaseKey,
} from "./generation-cleanup";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
/**
 * A run retains its two live content-addressed state objects in the record;
 * cleanup re-inventories the exact namespace for an interrupted superseded
 * snapshot. Provider request outputs have their own immutable refs, so the
 * record itself needs room for only the live state/result plus <=128 bounded
 * request refs. Cleanup separately permits a larger but finite set of
 * orphaned snapshots from interrupted compare-and-swap writes.
 */
const MAX_ARTIFACT_REFERENCES = 256;
const MAX_GENERATION_ARTIFACT_KEYS = 1_024;
/** Cloudflare R2 limits one multi-object delete request to 1,000 keys. */
const MAX_R2_DELETE_KEYS = 1_000;
/** Task12 has one audio/waveform/manifest/index and at most 12 visual thumbnails. */
const MAX_PREPARED_OUTPUTS = 16;
const MAX_PREPARATION_WRITE_LEASE_BYTES = 1_024;
/** At most one scoped writer per immutable checkpoint plus Task12 outputs. */
const MAX_GENERATION_WRITE_LEASES = MAX_GENERATION_ARTIFACT_KEYS + MAX_PREPARED_OUTPUTS;
/** Includes every checkpoint plus exact source and every bounded Task12 derivative. */
const MAX_CLEANUP_ARTIFACT_KEYS = MAX_GENERATION_ARTIFACT_KEYS + 1 + MAX_PREPARED_OUTPUTS;
const MAX_PROFILE_RULES_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const clone = <Value>(value: Value): Value => structuredClone(value);
const detachPrivateRunArtifacts = (record: GenerationRunRecord): Omit<GenerationRunRecord, "workflowState" | "workflowStateRef" | "stagedResult" | "stagedResultRef" | "artifactRefs"> => {
  const detached = { ...record } as Record<string, unknown>;
  for (const key of ["workflowState", "workflowStateRef", "stagedResult", "stagedResultRef", "artifactRefs"] as const) {
    Reflect.deleteProperty(detached, key);
  }
  return detached as Omit<GenerationRunRecord, "workflowState" | "workflowStateRef" | "stagedResult" | "stagedResultRef" | "artifactRefs">;
};
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
  /** Salted owner identity copied from the upload receipt, never a raw session id. */
  readonly sessionKey: string;
  /** Stable salted browser-project owner identity used by the active-run CAS fence. */
  readonly ownerKey?: string;
  /** Salted project identity used only by the private server-side run lease. */
  readonly projectKey: string;
  /** Signed project/source facts verified against the authoritative prepared manifest. */
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  readonly operationId: string;
  readonly operationKey: string;
  readonly objectKey: string;
}

/**
 * A private, content-addressed R2 payload. Recovery records retain only these
 * bounded pointers so word-rich workflow state can never grow the record past
 * its 2 MiB CAS boundary.
 */
export interface GenerationRunArtifactReference {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type GenerationCleanupAction = "adopted" | "discarded" | "cancelled";

/**
 * A compact tombstone keeps cleanup recoverable after rich private artifacts
 * have been detached. The R2 store appends every server-derived Task12
 * derivative as an exact key before deletion; it never deletes a prefix.
 */
export interface GenerationRunCleanup {
  readonly version: 1;
  readonly state: "pending" | "completed";
  readonly action: GenerationCleanupAction;
  readonly artifactKeys: readonly string[];
  readonly requestedAtMs: number;
  readonly completedAtMs?: number;
}

export interface GenerationRunRecord {
  readonly version: 1;
  readonly receipt: string;
  readonly claims: GenerationRunReceiptClaims;
  /** Private upload receipt used only by the run-specific Workflow. */
  readonly uploadReceipt: string;
  readonly status: GenerationRunStatus;
  readonly cancelled: boolean;
  readonly dispatched: boolean;
  /**
   * A deterministic per-run Workflow attempt. Legacy records imply attempt 1;
   * only an observed errored/terminated instance may advance this number.
   */
  readonly workflowAttempt?: number;
  /** Exact browser profile snapshot used by deterministic segmentation. */
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  /** Durable Workflow-only state. Never returned by a route. */
  readonly workflowState?: unknown;
  readonly workflowStateRef?: GenerationRunArtifactReference;
  readonly stagedResult?: StagedGenerationResult;
  readonly stagedResultRef?: GenerationRunArtifactReference;
  /** Live state/result refs plus request-scoped provider checkpoints needed for resume. */
  readonly artifactRefs?: readonly GenerationRunArtifactReference[];
  /** Durable cleanup intent/tombstone after adoption, discard, or cancellation. */
  readonly cleanup?: GenerationRunCleanup;
  /**
   * Written in the same R2 record update as a terminal status, before the
   * separate active-lease CAS. A failed lease CAS is therefore recoverable
   * from every later record read/acknowledgement/cleanup rather than leaving
   * a paid run fenced until its natural expiry.
   */
  readonly leaseReleasePending?: true;
  readonly updatedAtMs: number;
}

/**
 * A private, compare-and-swap lease prevents a valid upload capability from
 * launching multiple billable run ids against one project/media operation.
 * Released entries intentionally remain as tombstones so an old terminal
 * writer cannot delete a later owner's lease.
 */
export interface ActiveGenerationLease {
  readonly version: 1;
  /** Salted authenticated owner identity; project ids alone are portable. */
  readonly sessionKey: string;
  /** New leases carry a stable browser-project owner key; legacy leases fall back to sessionKey. */
  readonly ownerKey?: string;
  readonly projectKey: string;
  readonly operationKey: string;
  readonly runId: string;
  readonly state: "active" | "released";
  readonly expiresAtMs: number;
  readonly updatedAtMs: number;
}

export type ActiveGenerationLeaseAcquisition =
  | { readonly kind: "acquired"; readonly lease: ActiveGenerationLease }
  | { readonly kind: "same-run"; readonly lease: ActiveGenerationLease }
  | { readonly kind: "conflict"; readonly lease: ActiveGenerationLease };

/** Private status/result storage. The record is never exposed by R2 URL. */
export interface GenerationRunRecordStore {
  readonly load: (input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">) => Promise<GenerationRunRecord | null>;
  readonly save: (record: GenerationRunRecord) => Promise<void>;
  /** Detaches and deletes only the exact immutable artifacts owned by this run. */
  readonly cleanup: (input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: GenerationCleanupAction;
    readonly nowMs: number;
  }) => Promise<GenerationRunRecord | null>;
  /** Atomically claims the signed project before quota/provider work starts. */
  readonly acquireActiveLease: (input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }) => Promise<ActiveGenerationLeaseAcquisition>;
  /** Terminal writers transition their own lease to a retained release tombstone. */
  readonly releaseActiveLease: (input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly nowMs: number;
  }) => Promise<void>;
  /**
   * Request-scoped provider output is separated from the evolving workflow
   * state so each durable Workflow step returns a tiny content-addressed ref.
   * Fixture/in-memory stores may omit this port and retain the small value
   * inline instead.
   */
  readonly writeProviderCheckpoint?: (input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly value: unknown;
  }) => Promise<GenerationRunArtifactReference>;
  readonly readProviderCheckpoint?: (input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly reference: GenerationRunArtifactReference;
  }) => Promise<unknown | null>;
}

/** A retryable workflow recovery failure remains owned until it is resumed or expires. */
const durableTerminalStatus = (status: GenerationRunStatus): boolean => (
  status.stage === "Cancelled"
  || status.stage === "Completed"
  || (status.stage === "Failed" && status.retryable !== true)
);

/**
 * The record write is the write-ahead half of terminal lease release. We
 * intentionally retain the marker after release: releasing a retained lease
 * tombstone is idempotent, and a later read can safely repair a crash between
 * the record PUT and the lease CAS without relying on a best-effort client.
 */
const withTerminalLeaseReleasePending = (record: GenerationRunRecord): GenerationRunRecord => (
  durableTerminalStatus(record.status) && record.leaseReleasePending !== true
    ? { ...record, leaseReleasePending: true }
    : record
);

const activeOwnerKey = (value: Pick<ActiveGenerationLease, "sessionKey" | "ownerKey">): string => value.ownerKey ?? value.sessionKey;

const activeLeaseIdentityMatches = (
  lease: ActiveGenerationLease,
  input: Pick<ActiveGenerationLease, "sessionKey" | "ownerKey" | "projectKey" | "operationKey" | "runId">,
): boolean => activeOwnerKey(lease) === activeOwnerKey(input)
  && lease.projectKey === input.projectKey
  && lease.operationKey === input.operationKey
  && lease.runId === input.runId;

export class InMemoryGenerationRunRecordStore implements GenerationRunRecordStore {
  private readonly records = new Map<string, GenerationRunRecord>();
  private readonly activeLeases = new Map<string, ActiveGenerationLease>();
  private key(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): string {
    return `${input.operationKey}:${input.runId}`;
  }
  public async load(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<GenerationRunRecord | null> {
    const record = this.records.get(this.key(input));
    if (record === undefined) return null;
    // Keep the in-memory port semantically identical to R2: terminal reads
    // are a safe reconciliation point for a previously interrupted release.
    await this.releaseIfTerminal(record);
    return clone(record);
  }
  private async releaseIfTerminal(record: GenerationRunRecord): Promise<void> {
    if (!durableTerminalStatus(record.status)) return;
    await this.releaseActiveLease({
      sessionKey: record.claims.sessionKey,
      ...(record.claims.ownerKey === undefined ? {} : { ownerKey: record.claims.ownerKey }),
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      nowMs: record.updatedAtMs,
    });
  }
  public async save(record: GenerationRunRecord): Promise<void> {
    const key = this.key(record.claims);
    const current = this.records.get(key);
    // Once an acknowledgement has detached rich data, a stale Workflow save
    // cannot recreate a private artifact or revive the terminal run.
    if (current?.cleanup !== undefined) return;
    if (record.cancelled) {
      // Keep any artifacts/state written by a concurrent worker, but make the
      // cancellation terminal. The staged-result route is intentionally an
      // adoption barrier for this state.
      const persisted = withTerminalLeaseReleasePending(current === undefined ? record : {
        ...current,
        cancelled: true,
        status: record.status,
        updatedAtMs: record.updatedAtMs,
      });
      this.records.set(key, clone(persisted));
      await this.releaseIfTerminal(persisted);
      return;
    }
    // An in-flight worker must never resurrect a cancelled record.
    if (current?.cancelled === true) return;
    const persisted = withTerminalLeaseReleasePending(current === undefined ? record : mergeActiveRecord(current, record));
    this.records.set(key, clone(persisted));
    await this.releaseIfTerminal(persisted);
  }

  public async acquireActiveLease(input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): Promise<ActiveGenerationLeaseAcquisition> {
    const ownerKey = activeOwnerKey(input);
    const existing = this.activeLeases.get(`${ownerKey}:${input.projectKey}`);
    if (existing !== undefined && existing.state === "active" && existing.expiresAtMs > input.nowMs) {
      return activeLeaseIdentityMatches(existing, input)
        ? { kind: "same-run", lease: clone(existing) }
        : { kind: "conflict", lease: clone(existing) };
    }
    const lease: ActiveGenerationLease = {
      version: 1,
      sessionKey: input.sessionKey,
      ...(input.ownerKey === undefined ? {} : { ownerKey: input.ownerKey }),
      projectKey: input.projectKey,
      operationKey: input.operationKey,
      runId: input.runId,
      state: "active",
      expiresAtMs: input.expiresAtMs,
      updatedAtMs: input.nowMs,
    };
    this.activeLeases.set(`${ownerKey}:${input.projectKey}`, clone(lease));
    return { kind: "acquired", lease: clone(lease) };
  }

  public async releaseActiveLease(input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly nowMs: number;
  }): Promise<void> {
    const ownerKey = activeOwnerKey(input);
    const existing = this.activeLeases.get(`${ownerKey}:${input.projectKey}`);
    if (existing === undefined || !activeLeaseIdentityMatches(existing, input) || existing.state === "released") return;
    this.activeLeases.set(`${ownerKey}:${input.projectKey}`, {
      ...existing,
      state: "released",
      updatedAtMs: Math.max(existing.updatedAtMs, input.nowMs),
    });
  }

  public async cleanup(input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: GenerationCleanupAction;
    readonly nowMs: number;
  }): Promise<GenerationRunRecord | null> {
    const key = this.key(input.claims);
    const current = this.records.get(key);
    if (current === undefined) return null;
    await this.releaseIfTerminal(current);
    if (current.cleanup !== undefined) return clone(current);
    const cleaned: GenerationRunRecord = {
      ...detachPrivateRunArtifacts(current),
      cleanup: {
        version: 1,
        state: "completed",
        action: input.action,
        artifactKeys: exactRunArtifactKeys(current),
        requestedAtMs: input.nowMs,
        completedAtMs: input.nowMs,
      },
      updatedAtMs: Math.max(current.updatedAtMs, input.nowMs),
    };
    this.records.set(key, clone(cleaned));
    await this.releaseIfTerminal(cleaned);
    return clone(cleaned);
  }
}

const recordKey = (input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): string =>
  `prepared/${input.operationKey}/generation-runs/${input.runId}.json`;

const activeGenerationLeaseKey = (ownerKey: string, projectKey: string): string =>
  `processing/generation-leases/${ownerKey}/${projectKey}.json`;

const MAX_ACTIVE_LEASE_BYTES = 2_048;

const parsedActiveGenerationLease = (value: unknown): ActiveGenerationLease | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const lease = value as Readonly<Record<string, unknown>>;
  return lease.version === 1
    && typeof lease.sessionKey === "string" && SHA256.test(lease.sessionKey)
    && (lease.ownerKey === undefined || typeof lease.ownerKey === "string" && SHA256.test(lease.ownerKey))
    && typeof lease.projectKey === "string" && SHA256.test(lease.projectKey)
    && typeof lease.operationKey === "string" && SHA256.test(lease.operationKey)
    && typeof lease.runId === "string" && OPAQUE_ID.test(lease.runId)
    && (lease.state === "active" || lease.state === "released")
    && Number.isSafeInteger(lease.expiresAtMs) && (lease.expiresAtMs as number) >= 0
    && Number.isSafeInteger(lease.updatedAtMs) && (lease.updatedAtMs as number) >= 0
    ? {
      version: 1,
      sessionKey: lease.sessionKey.toLowerCase(),
      ...(lease.ownerKey === undefined ? {} : { ownerKey: (lease.ownerKey as string).toLowerCase() }),
      projectKey: lease.projectKey.toLowerCase(),
      operationKey: lease.operationKey.toLowerCase(),
      runId: lease.runId,
      state: lease.state,
      expiresAtMs: lease.expiresAtMs as number,
      updatedAtMs: lease.updatedAtMs as number,
    }
    : null;
};

type GenerationArtifactKind = "workflow-state" | "staged-result" | "provider-result";

const artifactKey = (
  input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
  kind: GenerationArtifactKind,
  digest: string,
): string => `prepared/${input.operationKey}/generation-runs/${input.runId}/artifacts/${kind}-${digest}.json`;

const parsedArtifactKey = (
  key: string,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
): { readonly kind: GenerationArtifactKind; readonly sha256: string } | null => {
  const match = key.match(new RegExp(`^prepared/${claims.operationKey}/generation-runs/${claims.runId}/artifacts/(workflow-state|staged-result|provider-result)-([a-f0-9]{64})\\.json$`));
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const kind = match[1] === "workflow-state" || match[1] === "staged-result" || match[1] === "provider-result" ? match[1] : null;
  return kind === null ? null : { kind, sha256: match[2].toLowerCase() };
};

const artifactReference = (value: unknown): GenerationRunArtifactReference | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.key === "string"
    && typeof record.sha256 === "string"
    && SHA256.test(record.sha256)
    && Number.isSafeInteger(record.byteLength)
    && (record.byteLength as number) > 0
    && (record.byteLength as number) <= MAX_ARTIFACT_BYTES
    ? { key: record.key, sha256: record.sha256.toLowerCase(), byteLength: record.byteLength as number }
    : null;
};

const validArtifactReference = (
  reference: GenerationRunArtifactReference,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
  kind: GenerationArtifactKind,
): boolean => reference.key === artifactKey(claims, kind, reference.sha256);

const validAnyArtifactReference = (
  reference: GenerationRunArtifactReference,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
): boolean => (
  validArtifactReference(reference, claims, "workflow-state")
  || validArtifactReference(reference, claims, "staged-result")
  || validArtifactReference(reference, claims, "provider-result")
);

const artifactReferences = (
  value: unknown,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
): readonly GenerationRunArtifactReference[] | null => {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_REFERENCES) return null;
  const references = value.map(artifactReference);
  if (
    references.some((reference) => reference === null)
    || references.some((reference) => !validAnyArtifactReference(reference!, claims))
    || new Set(references.map((reference) => reference!.key)).size !== references.length
  ) return null;
  return references as GenerationRunArtifactReference[];
};

/**
 * Keep a validated exact-key inventory. New records retain only their live
 * refs; cleanup independently scans the bounded private namespace so a crash
 * after an artifact PUT can never make an orphan undiscoverable.
 */
const mergedArtifactReferences = (
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
  ...groups: readonly (readonly GenerationRunArtifactReference[] | undefined)[]
): readonly GenerationRunArtifactReference[] => {
  const byKey = new Map<string, GenerationRunArtifactReference>();
  for (const group of groups) {
    for (const reference of group ?? []) {
      if (!validAnyArtifactReference(reference, claims)) {
        throw new Error("CueBench generation recovery record has an invalid private artifact reference.");
      }
      byKey.set(reference.key, reference);
    }
  }
  if (byKey.size > MAX_ARTIFACT_REFERENCES) {
    throw new Error("CueBench generation recovery record has too many private checkpoint artifacts.");
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
};

const currentArtifactReferences = (record: GenerationRunRecord): readonly GenerationRunArtifactReference[] => [
  ...(record.workflowStateRef === undefined ? [] : [record.workflowStateRef]),
  ...(record.stagedResultRef === undefined ? [] : [record.stagedResultRef]),
];

const cleanupArtifactKey = (
  key: string,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId" | "objectKey">,
): boolean => (
  key === claims.objectKey
  || (key.startsWith(`prepared/${claims.operationKey}/generation-runs/${claims.runId}/artifacts/`)
    && key.endsWith(".json"))
  || preparedOutputArtifactKey(key, claims)
) && key.length <= 1_000;

/** Every derivative allowed by the scoped Container bridge has a bounded cardinality. */
const preparedOutputArtifactKey = (
  key: string,
  claims: Pick<GenerationRunReceiptClaims, "operationKey">,
): boolean => (
  new RegExp(`^prepared/${claims.operationKey}/audio/[a-f0-9]{64}\\.wav$`).test(key)
  || new RegExp(`^prepared/${claims.operationKey}/waveforms/[a-f0-9]{64}\\.json$`).test(key)
  || new RegExp(`^prepared/${claims.operationKey}/thumbnails/[a-f0-9]{64}\\.webp$`).test(key)
  || new RegExp(`^prepared/${claims.operationKey}/manifests/[a-f0-9]{64}\\.json$`).test(key)
  || new RegExp(`^prepared/${claims.operationKey}/indexes/[a-f0-9]{64}\\.json$`).test(key)
);

const cleanupRecord = (
  value: unknown,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId" | "objectKey">,
): GenerationRunCleanup | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const cleanup = value as Readonly<Record<string, unknown>>;
  if (
    cleanup.version !== 1
    || (cleanup.state !== "pending" && cleanup.state !== "completed")
    || (cleanup.action !== "adopted" && cleanup.action !== "discarded" && cleanup.action !== "cancelled")
    || !Array.isArray(cleanup.artifactKeys)
    || cleanup.artifactKeys.length > MAX_CLEANUP_ARTIFACT_KEYS
    || cleanup.artifactKeys.some((key) => typeof key !== "string" || !cleanupArtifactKey(key, claims))
    || new Set(cleanup.artifactKeys).size !== cleanup.artifactKeys.length
    || !Number.isSafeInteger(cleanup.requestedAtMs)
    || (cleanup.requestedAtMs as number) < 0
    || (cleanup.completedAtMs !== undefined && (!Number.isSafeInteger(cleanup.completedAtMs) || (cleanup.completedAtMs as number) < (cleanup.requestedAtMs as number)))
    || (cleanup.state === "pending" && cleanup.completedAtMs !== undefined)
    || (cleanup.state === "completed" && cleanup.completedAtMs === undefined)
  ) return null;
  return {
    version: 1,
    state: cleanup.state,
    action: cleanup.action,
    artifactKeys: [...cleanup.artifactKeys] as string[],
    requestedAtMs: cleanup.requestedAtMs as number,
    ...(cleanup.completedAtMs === undefined ? {} : { completedAtMs: cleanup.completedAtMs as number }),
  };
};

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
  if (
    record.version !== 1
    || typeof record.receipt !== "string"
    || typeof record.uploadReceipt !== "string"
    || typeof record.cancelled !== "boolean"
    || typeof record.dispatched !== "boolean"
    || (record.leaseReleasePending !== undefined && record.leaseReleasePending !== true)
    || !Number.isSafeInteger(record.updatedAtMs)
    || (record.workflowAttempt !== undefined && (!Number.isSafeInteger(record.workflowAttempt) || (record.workflowAttempt as number) < 1 || (record.workflowAttempt as number) > 8))
  ) return null;
  const claims = record.claims as GenerationRunReceiptClaims | undefined;
  if (claims === undefined || !validClaims(claims) || !OPAQUE_ID.test(claims.runId) || !OPAQUE_ID.test(claims.projectId) || !SHA256.test(claims.operationKey)) return null;
  const status = GenerationRunStatusSchema.safeParse(record.status);
  if (!status.success || status.data.runId !== claims.runId || status.data.projectId !== claims.projectId) return null;
  const qualityProfileRules = record.qualityProfileRules === undefined ? undefined : boundedProfileRules(record.qualityProfileRules);
  if (qualityProfileRules === null) return null;
  const staged = record.stagedResult === undefined ? undefined : StagedGenerationResultSchema.safeParse(record.stagedResult);
  if (staged !== undefined && !staged.success) return null;
  const workflowStateRef = record.workflowStateRef === undefined ? undefined : artifactReference(record.workflowStateRef);
  const stagedResultRef = record.stagedResultRef === undefined ? undefined : artifactReference(record.stagedResultRef);
  const artifactRefs = record.artifactRefs === undefined ? [] : artifactReferences(record.artifactRefs, claims);
  const cleanup = record.cleanup === undefined ? undefined : cleanupRecord(record.cleanup, claims);
  if (
    workflowStateRef === null
    || stagedResultRef === null
    || artifactRefs === null
    || cleanup === null
    || (record.workflowState !== undefined && workflowStateRef !== undefined)
    || (record.stagedResult !== undefined && stagedResultRef !== undefined)
    || (workflowStateRef !== undefined && !validArtifactReference(workflowStateRef, claims, "workflow-state"))
    || (stagedResultRef !== undefined && !validArtifactReference(stagedResultRef, claims, "staged-result"))
  ) return null;
  return {
    version: 1,
    receipt: record.receipt,
    claims,
    uploadReceipt: record.uploadReceipt,
    status: status.data,
    cancelled: record.cancelled,
    dispatched: record.dispatched,
    ...(record.workflowAttempt === undefined ? {} : { workflowAttempt: record.workflowAttempt as number }),
    ...(qualityProfileRules === undefined ? {} : { qualityProfileRules }),
    ...(record.workflowState === undefined ? {} : { workflowState: record.workflowState }),
    ...(workflowStateRef === undefined ? {} : { workflowStateRef }),
    ...(staged === undefined ? {} : { stagedResult: staged.data }),
    ...(stagedResultRef === undefined ? {} : { stagedResultRef }),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(record.leaseReleasePending === true ? { leaseReleasePending: true as const } : {}),
    updatedAtMs: record.updatedAtMs as number,
  };
};

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
);

/**
 * Request-level step payloads are immutable provider-result objects. The
 * evolving workflow-state artifact stores only these refs, never a growing
 * copy of every already-completed chunk/window response.
 */
const providerCheckpointReferences = (
  workflowState: unknown,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
): readonly GenerationRunArtifactReference[] | null => {
  const state = objectRecord(workflowState);
  if (state === null) return [];
  const refs: GenerationRunArtifactReference[] = [];
  for (const field of ["diarizationChunks", "wordTimestampChunks", "reconciliationWindows"] as const) {
    const entries = state[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      const referenceValue = objectRecord(entry)?.artifactRef;
      if (referenceValue === undefined) continue;
      const reference = artifactReference(referenceValue);
      if (reference === null || !validArtifactReference(reference, claims, "provider-result")) return null;
      refs.push(reference);
    }
  }
  return new Set(refs.map((reference) => reference.key)).size === refs.length ? refs : null;
};

const workflowHistory = (value: unknown): readonly unknown[] => {
  const record = objectRecord(value);
  return record !== null && Array.isArray(record.stageHistory) ? record.stageHistory : [];
};

const hasOwn = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const providerAttemptStateRank = (value: unknown): number => (
  value === "completed" ? 3 : value === "retryable-failed" ? 2 : value === "accepted-unknown" ? 1 : 0
);

/**
 * Merge write-ahead provider intent by its immutable attempt id. A stale
 * route/dispatch save may be missing a just-checkpointed attempt, but it must
 * never turn a completed result back into accepted-unknown or drop it.
 */
const mergeProviderAttemptJournal = (existing: unknown, incoming: unknown): unknown => {
  if (!Array.isArray(existing)) return incoming;
  if (!Array.isArray(incoming)) return existing;
  const output = [...existing];
  const indexByAttemptId = new Map<string, number>();
  for (const [index, candidate] of output.entries()) {
    const attemptId = objectRecord(candidate)?.attemptId;
    if (typeof attemptId === "string" && attemptId.length > 0) indexByAttemptId.set(attemptId, index);
  }
  for (const candidate of incoming) {
    const record = objectRecord(candidate);
    const attemptId = record?.attemptId;
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      // An unkeyed legacy value cannot safely supersede a known durable
      // journal entry. Preserve it only when no keyed state exists at all.
      if (output.length === 0) output.push(candidate);
      continue;
    }
    const existingIndex = indexByAttemptId.get(attemptId);
    if (existingIndex === undefined) {
      indexByAttemptId.set(attemptId, output.length);
      output.push(candidate);
      continue;
    }
    const current = objectRecord(output[existingIndex]);
    if (current === null) continue;
    const currentRank = providerAttemptStateRank(current.state);
    const nextRank = providerAttemptStateRank(record?.state);
    if (nextRank > currentRank) output[existingIndex] = candidate;
    else if (nextRank === currentRank) output[existingIndex] = { ...record, ...current };
  }
  return output;
};

const requestCheckpointStrength = (value: unknown): number => {
  const record = objectRecord(value);
  if (record === null) return 0;
  if (record.artifactRef !== undefined) return 3;
  if (record.value !== undefined) return 2;
  // Legacy inlined reconciliation checkpoints store their result fields
  // directly. They remain stronger than an absent/stale entry.
  return record.requestKey !== undefined ? 1 : 0;
};

/** Monotonic request-key journal merge for chunk/window checkpoint refs. */
const mergeRequestCheckpointJournal = (existing: unknown, incoming: unknown): unknown => {
  if (!Array.isArray(existing)) return incoming;
  if (!Array.isArray(incoming)) return existing;
  const output = [...existing];
  const indexByRequestKey = new Map<string, number>();
  for (const [index, candidate] of output.entries()) {
    const requestKey = objectRecord(candidate)?.requestKey;
    if (typeof requestKey === "string" && requestKey.length > 0) indexByRequestKey.set(requestKey, index);
  }
  for (const candidate of incoming) {
    const requestKey = objectRecord(candidate)?.requestKey;
    if (typeof requestKey !== "string" || requestKey.length === 0) {
      if (output.length === 0) output.push(candidate);
      continue;
    }
    const currentIndex = indexByRequestKey.get(requestKey);
    if (currentIndex === undefined) {
      indexByRequestKey.set(requestKey, output.length);
      output.push(candidate);
      continue;
    }
    const current = output[currentIndex];
    if (requestCheckpointStrength(candidate) > requestCheckpointStrength(current)) output[currentIndex] = candidate;
  }
  return output;
};

/** A later aggregate wins; otherwise preserve the currently durable value on a tie. */
const workflowProgress = (state: Readonly<Record<string, unknown>>): number => {
  if (state.staged !== undefined) return 8;
  if (state.reconciled !== undefined) return 7;
  if (state.reconciliationWindows !== undefined) return 6.5;
  if (state.aligned !== undefined) return 6;
  if (state.wordTimestamps !== undefined) return 5;
  if (state.wordTimestampChunks !== undefined) return 4.5;
  if (state.diarization !== undefined) return 4;
  if (state.diarizationChunks !== undefined) return 3.5;
  if (state.manifest !== undefined) return 3;
  if (state.preparedManifest !== undefined) return 2;
  return 1;
};

const mergeMonotonicArtifact = (
  merged: Record<string, unknown>,
  existing: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
  key: string,
  existingProgress: number,
  incomingProgress: number,
): void => {
  if (!hasOwn(existing, key)) return;
  if (!hasOwn(incoming, key) || existingProgress >= incomingProgress) merged[key] = existing[key];
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
  // prevents an older retry from moving a stage backwards. Equal histories
  // also prefer the current durable snapshot because a dispatch-only save has
  // no authority to replace its journal/partial aggregate fields.
  merged.stageHistory = existingHistory.length >= nextHistory.length ? existingHistory : nextHistory;
  const existingProgress = workflowProgress(existing);
  const nextProgress = workflowProgress(next);
  for (const artifact of ["preparedManifest", "manifest", "diarization", "wordTimestamps", "aligned", "reconciled", "staged"] as const) {
    mergeMonotonicArtifact(merged, existing, next, artifact, existingProgress, nextProgress);
  }
  if (hasOwn(existing, "providerAttempts") || hasOwn(next, "providerAttempts")) {
    merged.providerAttempts = mergeProviderAttemptJournal(existing.providerAttempts, next.providerAttempts);
  }
  for (const journal of ["diarizationChunks", "wordTimestampChunks", "reconciliationWindows"] as const) {
    if (hasOwn(existing, journal) || hasOwn(next, journal)) {
      merged[journal] = mergeRequestCheckpointJournal(existing[journal], next[journal]);
    }
  }
  merged.cancelled = existing.cancelled === true || next.cancelled === true;
  return merged;
};

const sameReceiptIdentity = (left: GenerationRunRecord, right: GenerationRunRecord): boolean => (
  left.receipt === right.receipt
  && left.claims.operationKey === right.claims.operationKey
  && left.claims.runId === right.claims.runId
  && left.claims.projectId === right.claims.projectId
  && left.claims.sessionKey === right.claims.sessionKey
  && (left.claims.ownerKey ?? left.claims.sessionKey) === (right.claims.ownerKey ?? right.claims.sessionKey)
  && left.claims.projectKey === right.claims.projectKey
  && left.uploadReceipt === right.uploadReceipt
);

/** Monotonic merge for non-cancelled writes after a compare-and-swap retry. */
const mergeActiveRecord = (current: GenerationRunRecord, incoming: GenerationRunRecord): GenerationRunRecord => {
  if (!sameReceiptIdentity(current, incoming)) throw new Error("CueBench generation recovery record identity conflict.");
  const currentHistory = workflowHistory(current.workflowState);
  const incomingHistory = workflowHistory(incoming.workflowState);
  const incomingAdvancesWorkflow = incomingHistory.length > currentHistory.length
    || (current.workflowState === undefined && incoming.workflowState !== undefined);
  // Browser adoption acknowledgement is the only route-owned terminal
  // transition. It must not be discarded merely because its workflow history
  // intentionally stays at AwaitingAdoption while private artifacts detach.
  const incomingAcknowledgesAdoption = current.status.stage === "AwaitingAdoption"
    && incoming.status.stage === "Completed"
    && !incoming.cancelled;
  // A route recovery may repair an older Queued/Running visible stage after
  // it finds the matching immutable staged payload. This is not a new result;
  // it only restores the atomically durable adoption boundary.
  const incomingRepairsStagedSuccess = hasDurableStagedSuccess(incoming)
    && incoming.status.stage === "AwaitingAdoption"
    && !current.cancelled;
  const incomingMarksWorkflowFailure = incoming.status.stage === "Failed"
    && current.status.stage !== "Completed"
    && !current.cancelled
    && !hasDurableStagedSuccess(current);
  const workflowState = mergeWorkflowState(current.workflowState, incoming.workflowState);
  const artifactRefs = mergedArtifactReferences(
    current.claims,
    current.artifactRefs,
    currentArtifactReferences(current),
    incoming.artifactRefs,
    currentArtifactReferences(incoming),
  );
  const currentWorkflowAttempt = current.workflowAttempt ?? 1;
  const incomingWorkflowAttempt = incoming.workflowAttempt ?? 1;
  const incomingRetriesWorkflowFailure = current.status.stage === "Failed"
    && current.status.retryable === true
    && incoming.status.stage === "Queued"
    && incomingWorkflowAttempt > currentWorkflowAttempt;
  return {
    ...current,
    ...incoming,
    status: incomingAdvancesWorkflow || incomingAcknowledgesAdoption || incomingRepairsStagedSuccess || incomingMarksWorkflowFailure || incomingRetriesWorkflowFailure
      ? incoming.status
      : current.status,
    cancelled: false,
    // A durable replacement attempt deliberately resets dispatch state. A
    // stale save from its predecessor cannot turn that new attempt into a
    // fictional live Workflow, while ordinary saves remain monotonic.
    dispatched: incomingWorkflowAttempt > currentWorkflowAttempt
      ? incoming.dispatched
      : current.dispatched || incoming.dispatched,
    ...(Math.max(currentWorkflowAttempt, incomingWorkflowAttempt) === 1
      ? {}
      : { workflowAttempt: Math.max(currentWorkflowAttempt, incomingWorkflowAttempt) }),
    ...(incoming.qualityProfileRules === undefined && current.qualityProfileRules !== undefined
      ? { qualityProfileRules: current.qualityProfileRules }
      : {}),
    ...(workflowState === undefined ? {} : { workflowState }),
    ...(incoming.stagedResult === undefined && current.stagedResult !== undefined
      ? { stagedResult: current.stagedResult }
      : {}),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    updatedAtMs: Math.max(current.updatedAtMs, incoming.updatedAtMs),
  };
};

const preparedManifestKey = (
  value: unknown,
  claims: Pick<GenerationRunReceiptClaims, "operationKey">,
): string | null => {
  const record = objectRecord(value);
  const key = record?.key;
  const sha256 = record?.sha256;
  return typeof key === "string"
    && typeof sha256 === "string"
    && SHA256.test(sha256)
    && key === `prepared/${claims.operationKey}/manifests/${sha256.toLowerCase()}.json`
    ? key
    : null;
};

const preparedAudioKey = (
  value: unknown,
  claims: Pick<GenerationRunReceiptClaims, "operationKey">,
): string | null => {
  const record = objectRecord(value);
  const key = record?.key;
  const sha256 = record?.sha256;
  return typeof key === "string"
    && typeof sha256 === "string"
    && SHA256.test(sha256)
    && key === `prepared/${claims.operationKey}/audio/${sha256.toLowerCase()}.wav`
    ? key
    : null;
};

/**
 * Every listed value is a server-derived exact key. This intentionally avoids
 * a broad operation-prefix delete while fulfilling immediate deletion for an
 * adopted/cancelled private source and its prepared derivatives.
 */
const exactRunArtifactKeys = (record: GenerationRunRecord): readonly string[] => {
  const state = objectRecord(record.workflowState);
  const stagedEvidence = record.stagedResult?.evidence;
  const keys = [
    ...mergedArtifactReferences(record.claims, record.artifactRefs, currentArtifactReferences(record)).map((reference) => reference.key),
    record.claims.objectKey,
    preparedManifestKey(state?.preparedManifest, record.claims),
    preparedAudioKey(objectRecord(state?.manifest)?.normalizedAudio, record.claims),
    preparedManifestKey(stagedEvidence?.preparedManifest, record.claims),
    preparedAudioKey(stagedEvidence?.normalizedAudio, record.claims),
  ].filter((key): key is string => key !== null);
  return [...new Set(keys)];
};

const detachRunArtifacts = (
  record: GenerationRunRecord,
  cleanup: GenerationRunCleanup,
): GenerationRunRecord => {
  return { ...detachPrivateRunArtifacts(record), cleanup };
};

/** R2 remains private; terminal runs delete exact owned keys immediately and lifecycle is the 24-hour backstop. */
export class R2GenerationRunRecordStore implements GenerationRunRecordStore {
  public constructor(private readonly bucket: R2Bucket) {}

  private async readArtifact(
    reference: GenerationRunArtifactReference,
    claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    kind: GenerationArtifactKind,
  ): Promise<unknown | null> {
    if (!validArtifactReference(reference, claims, kind)) return null;
    const object = await this.bucket.get(reference.key);
    if (object === null || object.size !== reference.byteLength || object.size > MAX_ARTIFACT_BYTES) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    if (actual !== reference.sha256) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return null;
    }
  }

  private async hydrate(record: GenerationRunRecord): Promise<GenerationRunRecord | null> {
    const workflowState = record.workflowStateRef === undefined
      ? record.workflowState
      : await this.readArtifact(record.workflowStateRef, record.claims, "workflow-state");
    if (record.workflowStateRef !== undefined && workflowState === null) return null;
    const stagedValue = record.stagedResultRef === undefined
      ? record.stagedResult
      : await this.readArtifact(record.stagedResultRef, record.claims, "staged-result");
    if (record.stagedResultRef !== undefined && stagedValue === null) return null;
    const staged = stagedValue === undefined ? undefined : StagedGenerationResultSchema.safeParse(stagedValue);
    if (staged !== undefined && !staged.success) return null;
    return {
      ...record,
      ...(workflowState === undefined ? {} : { workflowState }),
      ...(staged === undefined ? {} : { stagedResult: staged.data }),
    };
  }

  private async storeArtifact(
    claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    kind: GenerationArtifactKind,
    value: unknown,
  ): Promise<GenerationRunArtifactReference> {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("CueBench generation artifact cannot be serialized for private recovery.");
    }
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("CueBench generation artifact exceeds its private retention bound.");
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = Array.from(digest, (item) => item.toString(16).padStart(2, "0")).join("");
    const key = artifactKey(claims, kind, sha256);
    const writerLease = generationArtifactWriteLeaseKey(claims.operationKey, claims.runId, key);
    // Register before the marker read. A terminal cleanup that races this
    // write either sees the writer and stays pending, or this writer sees the
    // marker and never reaches R2. The lease is intentionally retained for an
    // ambiguous R2 PUT failure: R2 cannot prove that an aborted request did
    // not still commit after its caller lost the response.
    const acquired = await this.bucket.put(writerLease, JSON.stringify({ version: 1, artifactKey: key }), {
      onlyIf: onlyIfAbsent(),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cuebench_generation_artifact_writer: "1" },
    });
    if (acquired === null) {
      const error = new Error("CueBench is already durably writing this private generation checkpoint.");
      Object.assign(error, { retryable: true });
      throw error;
    }
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
      if (await this.bucket.head(generationCleanupMarkerKey(claims.operationKey)) !== null) {
        if (!await releaseWriterLease()) throw new Error("CueBench could not settle a fenced generation checkpoint writer.");
        throw new Error("CueBench terminal cleanup fenced this private generation checkpoint.");
      }
      putMayHaveStarted = true;
      const stored = await this.bucket.put(key, bytes, {
        onlyIf: onlyIfAbsent(),
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { sha256, cuebench_generation_artifact: "1" },
      });
      if (stored === null) {
        const existing = await this.bucket.head(key);
        if (
          existing === null
          || existing.size !== bytes.byteLength
          || existing.httpMetadata?.contentType !== "application/json; charset=utf-8"
          || existing.customMetadata?.sha256 !== sha256
        ) {
          throw new Error("CueBench could not safely reuse a private generation checkpoint.");
        }
      }
      if (await this.bucket.head(generationCleanupMarkerKey(claims.operationKey)) !== null) {
        // This exact key is in the active run namespace, so reclaiming it is
        // safe even if cleanup listed immediately before this post-PUT fence.
        await this.bucket.delete(key);
        if (!await releaseWriterLease()) throw new Error("CueBench could not settle a fenced generation checkpoint writer.");
        throw new Error("CueBench terminal cleanup reclaimed a late private generation checkpoint.");
      }
      if (!await releaseWriterLease()) throw new Error("CueBench could not durably settle a private generation checkpoint writer.");
      return { key, sha256, byteLength: bytes.byteLength };
    } catch (error) {
      // Before `put` starts, no later R2 commit is possible, so it is safe to
      // release. Once PUT starts, preserve the writer lease unless the normal
      // post-PUT settlement path above completed it.
      if (!putMayHaveStarted) await releaseWriterLease();
      throw error;
    }
  }

  public async writeProviderCheckpoint(input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly value: unknown;
  }): Promise<GenerationRunArtifactReference> {
    return this.storeArtifact(input.claims, "provider-result", input.value);
  }

  public async readProviderCheckpoint(input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly reference: GenerationRunArtifactReference;
  }): Promise<unknown | null> {
    return this.readArtifact(input.reference, input.claims, "provider-result");
  }

  private async compact(record: GenerationRunRecord): Promise<GenerationRunRecord> {
    const {
      workflowState,
      stagedResult,
      workflowStateRef: existingWorkflowStateRef,
      stagedResultRef: existingStagedResultRef,
      artifactRefs: _existingArtifactRefs,
      ...base
    } = record;
    // Historical refs are intentionally derived from the compact current
    // state below rather than copied into every new record snapshot.
    void _existingArtifactRefs;
    // `stagedResult` is the sole recoverable copy of word-rich output. The
    // runner state may carry it while transitioning, but persisting it in both
    // artifacts would recreate the multi-megabyte duplication this boundary
    // exists to prevent.
    const stateRecord = objectRecord(workflowState);
    const compactWorkflowState = stagedResult !== undefined && stateRecord !== null
      ? {
        ...(stateRecord.request === undefined ? {} : { request: stateRecord.request }),
        ...(stateRecord.stageHistory === undefined ? {} : { stageHistory: stateRecord.stageHistory }),
        cancelled: stateRecord.cancelled === true,
      }
      : workflowState;
    const workflowStateRef = compactWorkflowState === undefined
      ? existingWorkflowStateRef
      : await this.storeArtifact(record.claims, "workflow-state", compactWorkflowState);
    const stagedResultRef = stagedResult === undefined
      ? existingStagedResultRef
      : await this.storeArtifact(record.claims, "staged-result", stagedResult);
    const providerRefs = providerCheckpointReferences(compactWorkflowState, record.claims);
    if (providerRefs === null) {
      throw new Error("CueBench generation state has an invalid request checkpoint reference.");
    }
    // A state save supersedes the previous immutable workflow snapshot. Rich
    // request output instead lives once in its own provider-result artifact;
    // the state contains only the small refs needed to resume from the next
    // incomplete request.
    const artifactRefs = mergedArtifactReferences(
      record.claims,
      providerRefs,
      workflowStateRef === undefined ? undefined : [workflowStateRef],
      stagedResultRef === undefined ? undefined : [stagedResultRef],
    );
    return {
      ...base,
      ...(workflowStateRef === undefined ? {} : { workflowStateRef }),
      ...(stagedResultRef === undefined ? {} : { stagedResultRef }),
      ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    };
  }

  private async encoded(record: GenerationRunRecord): Promise<string> {
    const compact = await this.compact(record);
    return this.encodedCompact(compact);
  }

  private encodedCompact(record: GenerationRunRecord): string {
    const encoded = JSON.stringify(record);
    if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) {
      throw new Error("CueBench generation recovery record exceeds its private retention bound.");
    }
    return encoded;
  }

  private async compactEncoded(record: GenerationRunRecord): Promise<{
    readonly compact: GenerationRunRecord;
    readonly encoded: string;
  }> {
    const compact = await this.compact(record);
    return { compact, encoded: this.encodedCompact(compact) };
  }

  /**
   * Once a compact record points at its replacement state, an older immutable
   * checkpoint is no longer part of active recovery. Delete it only after the
   * CAS, and deliberately tolerate a failed delete: `runArtifactKeys` is the
   * authoritative bounded inventory during terminal cleanup.
   */
  private async reclaimSupersededArtifacts(
    previous: GenerationRunRecord | null,
    persisted: GenerationRunRecord,
  ): Promise<void> {
    if (previous === null) return;
    const retained = new Set(mergedArtifactReferences(
      persisted.claims,
      persisted.artifactRefs,
      currentArtifactReferences(persisted),
    ).map((reference) => reference.key));
    let previousReferences: readonly GenerationRunArtifactReference[];
    try {
      previousReferences = mergedArtifactReferences(
        previous.claims,
        previous.artifactRefs,
        currentArtifactReferences(previous),
      );
    } catch {
      // A malformed legacy inventory is already rejected on load. Do not
      // turn a successfully durable new state into a failed request merely
      // because its best-effort reclamation cannot interpret old debris.
      return;
    }
    const stale = previousReferences
      .map((reference) => reference.key)
      .filter((key) => !retained.has(key));
    if (stale.length === 0) return;
    try {
      await this.bucket.delete(stale);
    } catch {
      // The namespace scan before cleanup completion is the durable retry
      // path. There is intentionally no broad-prefix deletion here.
    }
  }

  private async current(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<{ readonly record: GenerationRunRecord; readonly etag: string } | null> {
    const object = await this.bucket.get(recordKey(input));
    if (object === null || object.size > MAX_RECORD_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await object.text()) as unknown;
    } catch {
      return null;
    }
    const parsedRecord = parseRecord(parsed);
    const record = parsedRecord === null ? null : await this.hydrate(parsedRecord);
    return record !== null && record.claims.operationKey === input.operationKey && record.claims.runId === input.runId
      ? { record, etag: object.etag }
      : null;
  }

  private async currentActiveLease(ownerKey: string, projectKey: string): Promise<{ readonly lease: ActiveGenerationLease; readonly etag: string } | null> {
    const object = await this.bucket.get(activeGenerationLeaseKey(ownerKey, projectKey));
    if (object === null || object.size <= 0 || object.size > MAX_ACTIVE_LEASE_BYTES) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(await object.text()) as unknown; } catch { return null; }
    const lease = parsedActiveGenerationLease(parsed);
    return lease !== null && activeOwnerKey(lease) === ownerKey && lease.projectKey === projectKey ? { lease, etag: object.etag } : null;
  }

  private encodedActiveLease(lease: ActiveGenerationLease): string {
    const encoded = JSON.stringify(lease);
    if (new TextEncoder().encode(encoded).byteLength > MAX_ACTIVE_LEASE_BYTES) {
      throw new Error("CueBench generation lease exceeds its private retention bound.");
    }
    return encoded;
  }

  public async acquireActiveLease(input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): Promise<ActiveGenerationLeaseAcquisition> {
    if (!SHA256.test(input.sessionKey) || (input.ownerKey !== undefined && !SHA256.test(input.ownerKey)) || !SHA256.test(input.projectKey) || !SHA256.test(input.operationKey) || !OPAQUE_ID.test(input.runId) || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.nowMs) {
      throw new Error("CueBench cannot acquire an invalid private generation lease.");
    }
    const desired: ActiveGenerationLease = {
      version: 1,
      sessionKey: input.sessionKey.toLowerCase(),
      ...(input.ownerKey === undefined ? {} : { ownerKey: input.ownerKey.toLowerCase() }),
      projectKey: input.projectKey.toLowerCase(),
      operationKey: input.operationKey.toLowerCase(),
      runId: input.runId,
      state: "active",
      expiresAtMs: input.expiresAtMs,
      updatedAtMs: input.nowMs,
    };
    const ownerKey = activeOwnerKey(desired);
    const key = activeGenerationLeaseKey(ownerKey, desired.projectKey);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.currentActiveLease(ownerKey, desired.projectKey);
      if (current === null) {
        const created = await this.bucket.put(key, this.encodedActiveLease(desired), {
          onlyIf: onlyIfAbsent(),
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        });
        if (created !== null) return { kind: "acquired", lease: desired };
        continue;
      }
      if (current.lease.state === "active" && current.lease.expiresAtMs > input.nowMs) {
        return activeLeaseIdentityMatches(current.lease, desired)
          ? { kind: "same-run", lease: current.lease }
          : { kind: "conflict", lease: current.lease };
      }
      const replaced = await this.bucket.put(key, this.encodedActiveLease(desired), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (replaced !== null) return { kind: "acquired", lease: desired };
    }
    const error = new Error("CueBench could not atomically acquire its private generation lease.");
    Object.assign(error, { retryable: true });
    throw error;
  }

  public async releaseActiveLease(input: {
    readonly sessionKey: string;
    readonly ownerKey?: string;
    readonly projectKey: string;
    readonly operationKey: string;
    readonly runId: string;
    readonly nowMs: number;
  }): Promise<void> {
    if (!SHA256.test(input.sessionKey) || (input.ownerKey !== undefined && !SHA256.test(input.ownerKey)) || !SHA256.test(input.projectKey) || !SHA256.test(input.operationKey) || !OPAQUE_ID.test(input.runId)) return;
    const ownerKey = activeOwnerKey(input).toLowerCase();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.currentActiveLease(ownerKey, input.projectKey.toLowerCase());
      if (current === null || current.lease.state === "released" || !activeLeaseIdentityMatches(current.lease, input)) return;
      const released: ActiveGenerationLease = {
        ...current.lease,
        state: "released",
        updatedAtMs: Math.max(current.lease.updatedAtMs, input.nowMs),
      };
      const saved = await this.bucket.put(activeGenerationLeaseKey(activeOwnerKey(released), released.projectKey), this.encodedActiveLease(released), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) return;
    }
    const error = new Error("CueBench could not durably release its private generation lease.");
    Object.assign(error, { retryable: true });
    throw error;
  }

  private async releaseIfTerminal(record: GenerationRunRecord): Promise<void> {
    if (!durableTerminalStatus(record.status)) return;
    await this.releaseActiveLease({
      sessionKey: record.claims.sessionKey,
      ...(record.claims.ownerKey === undefined ? {} : { ownerKey: record.claims.ownerKey }),
      projectKey: record.claims.projectKey,
      operationKey: record.claims.operationKey,
      runId: record.claims.runId,
      nowMs: record.updatedAtMs,
    });
  }

  /**
   * A terminal record can outlive a failed lease CAS. Reads deliberately do
   * not fail just because this repair attempt is transiently unavailable: the
   * terminal stage remains visible and every authenticated terminal path will
   * try again before claiming cleanup settled.
   */
  private async reconcileTerminalLease(record: GenerationRunRecord): Promise<boolean> {
    if (!durableTerminalStatus(record.status)) return true;
    try {
      await this.releaseIfTerminal(record);
      return true;
    } catch {
      return false;
    }
  }

  public async load(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<GenerationRunRecord | null> {
    const current = await this.current(input);
    if (current === null) return null;
    await this.reconcileTerminalLease(current.record);
    return current.record;
  }

  public async save(record: GenerationRunRecord): Promise<void> {
    const key = recordKey(record.claims);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(record.claims);
      if (current === null) {
        const candidate = withTerminalLeaseReleasePending(record);
        const compact = await this.compactEncoded(candidate);
        const created = await this.bucket.put(key, compact.encoded, {
          onlyIf: onlyIfAbsent(),
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        });
        if (created !== null) {
          await this.releaseIfTerminal(compact.compact);
          return;
        }
        continue;
      }

      // A route cancellation wins over every stale workflow snapshot. When
      // processing the cancellation itself, retain the newest worker state so
      // diagnostics/recovery remain available, but never make it adoptable.
      if (current.record.cleanup !== undefined) return;
      if (!record.cancelled && current.record.cancelled) return;
      const candidate: GenerationRunRecord = withTerminalLeaseReleasePending(record.cancelled
        ? {
          ...current.record,
          cancelled: true,
          status: record.status,
          updatedAtMs: record.updatedAtMs,
        }
        : mergeActiveRecord(current.record, record));
      const compact = await this.compactEncoded(candidate);
      const saved = await this.bucket.put(key, compact.encoded, {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) {
        await this.reclaimSupersededArtifacts(current.record, compact.compact);
        await this.releaseIfTerminal(compact.compact);
        return;
      }
    }
    const error = new Error("CueBench could not atomically persist its generation recovery record.");
    Object.assign(error, { retryable: true });
    throw error;
  }

  /**
   * Fence the operation before taking an artifact inventory. A stale
   * Container is then unable to create a new derivative after terminal
   * cleanup has started; the bridge also checks this marker again after PUT.
   * The marker itself remains under the existing <=24h `prepared/` lifecycle
   * prefix so it cannot become durable project data.
   */
  private async fencePreparationWrites(
    claims: Pick<GenerationRunReceiptClaims, "operationKey">,
    action: GenerationCleanupAction,
    nowMs: number,
  ): Promise<void> {
    await this.bucket.put(generationCleanupMarkerKey(claims.operationKey), JSON.stringify({
      version: 1,
      action,
      requestedAtMs: nowMs,
    }), {
      onlyIf: onlyIfAbsent(),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  /**
   * Enumerate only the five fixed Task12 output collections, then retain the
   * validated exact keys. This is intentionally not an R2 prefix delete.
   */
  private async preparedOutputKeys(
    claims: Pick<GenerationRunReceiptClaims, "operationKey">,
  ): Promise<readonly string[]> {
    const collections: ReadonlyArray<readonly [directory: string, maximum: number]> = [
      ["audio", 1],
      ["waveforms", 1],
      ["thumbnails", 12],
      ["manifests", 1],
      ["indexes", 1],
    ];
    const keys: string[] = [];
    for (const [directory, maximum] of collections) {
      const listed = await this.bucket.list({
        prefix: `prepared/${claims.operationKey}/${directory}/`,
        // Request one more than the contract permits, so an unexpected
        // collection is never silently truncated into a "completed" cleanup.
        limit: maximum + 1,
      });
      if (listed.truncated || listed.objects.length > maximum) {
        throw new Error("CueBench preparation artifact inventory exceeds its bounded contract.");
      }
      for (const object of listed.objects) {
        if (!preparedOutputArtifactKey(object.key, claims)) {
          throw new Error("CueBench preparation artifact inventory contains an invalid private key.");
        }
        keys.push(object.key);
      }
    }
    if (keys.length > MAX_PREPARED_OUTPUTS || new Set(keys).size !== keys.length) {
      throw new Error("CueBench preparation artifact inventory exceeds its bounded contract.");
    }
    return keys.sort((left, right) => left.localeCompare(right));
  }

  /**
   * Re-inventory the one active run's immutable checkpoint namespace before
   * declaring cleanup complete. This catches a content-addressed PUT which
   * reached R2 after a crash but before the compact run record could refer to
   * it; cleanup never relies solely on the last serialized reference array.
   */
  private async listBoundedPrivateObjects(prefix: string, maximum: number): Promise<readonly { readonly key: string; readonly size: number }[]> {
    const objects: Array<{ readonly key: string; readonly size: number }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const remaining = maximum - objects.length;
      if (remaining < 0) throw new Error("CueBench private artifact inventory exceeds its bounded contract.");
      // R2 caps an individual list page at 1,000 objects. Always request one
      // extra bounded slot where possible so an over-limit namespace fails
      // closed instead of being silently treated as fully drained.
      const listed = await this.bucket.list({
        prefix,
        limit: Math.min(1_000, remaining + 1),
        ...(cursor === undefined ? {} : { cursor }),
      });
      objects.push(...listed.objects.map((object) => ({ key: object.key, size: object.size })));
      if (objects.length > maximum) throw new Error("CueBench private artifact inventory exceeds its bounded contract.");
      if (!listed.truncated) return objects;
      const nextCursor = (listed as unknown as { readonly cursor?: unknown }).cursor;
      if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
        throw new Error("CueBench private artifact inventory pagination is invalid.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private async runArtifactKeys(
    claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
  ): Promise<readonly string[]> {
    let listed: readonly { readonly key: string; readonly size: number }[];
    try {
      listed = await this.listBoundedPrivateObjects(
        `prepared/${claims.operationKey}/generation-runs/${claims.runId}/artifacts/`,
        MAX_GENERATION_ARTIFACT_KEYS,
      );
    } catch {
      throw new Error("CueBench generation checkpoint inventory exceeds its bounded contract.");
    }
    const keys: string[] = [];
    for (const object of listed) {
      if (parsedArtifactKey(object.key, claims) === null) {
        throw new Error("CueBench generation checkpoint inventory contains an invalid private key.");
      }
      keys.push(object.key);
    }
    return keys.sort((left, right) => left.localeCompare(right));
  }

  /**
   * Cleanup inventories slightly more than one R2 multi-delete request can
   * carry (all bounded run checkpoints plus Task12 outputs). Delete exactly
   * that durable tombstone inventory in R2-sized chunks. If a later chunk
   * fails, callers leave the tombstone pending; a retry idempotently repeats
   * earlier chunks and resumes at the remaining keys instead of claiming
   * cleanup completed.
   */
  private async deleteCleanupArtifactKeys(keys: readonly string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += MAX_R2_DELETE_KEYS) {
      await this.bucket.delete(keys.slice(offset, offset + MAX_R2_DELETE_KEYS));
    }
  }

  /**
   * A scoped bridge lease is created before a Container's first terminal
   * marker read. R2 does not provide an abort signal for `put`, so an elapsed
   * timestamp cannot prove an outstanding writer drained. Every durable lease
   * remains an active fence until its owning bridge request explicitly removes
   * it after its final R2/marker settlement checks; lifecycle is the bounded
   * recovery backstop for a process that never returns.
   */
  private async activeWriterLeases(
    claims: Pick<GenerationRunReceiptClaims, "operationKey">,
  ): Promise<readonly string[]> {
    let listed: readonly { readonly key: string; readonly size: number }[];
    try {
      listed = await this.listBoundedPrivateObjects(
        `prepared/${claims.operationKey}/generation-inflight/`,
        MAX_GENERATION_WRITE_LEASES,
      );
    } catch {
      throw new Error("CueBench private writer lease inventory exceeds its bounded contract.");
    }
    const active: string[] = [];
    for (const listedLease of listed) {
      if (listedLease.size <= 0 || listedLease.size > MAX_PREPARATION_WRITE_LEASE_BYTES) {
        throw new Error("CueBench preparation-write lease is invalid.");
      }
      const object = await this.bucket.get(listedLease.key);
      if (object === null || object.size !== listedLease.size) throw new Error("CueBench preparation-write lease is unavailable.");
      let lease: unknown;
      try { lease = JSON.parse(await object.text()) as unknown; } catch { throw new Error("CueBench preparation-write lease is invalid."); }
      if (typeof lease !== "object" || lease === null || Array.isArray(lease)) throw new Error("CueBench preparation-write lease is invalid.");
      const fields = lease as Readonly<Record<string, unknown>>;
      if (
        fields.version !== 1
      ) throw new Error("CueBench preparation-write lease is invalid.");
      let expectedKey: string;
      try {
        if (Object.keys(fields).length === 2 && typeof fields.outputKey === "string" && preparedOutputArtifactKey(fields.outputKey, claims)) {
          expectedKey = generationPreparationWriteLeaseKey(claims.operationKey, fields.outputKey);
        } else if (Object.keys(fields).length === 2 && typeof fields.artifactKey === "string") {
          const parsed = parsedArtifactKey(fields.artifactKey, {
            operationKey: claims.operationKey,
            // A lease path below independently carries and verifies this id;
            // supplying it here only lets the shared parser validate the
            // immutable artifact shape before we compare its exact key.
            runId: fields.artifactKey.split("/")[3] ?? "",
          });
          if (parsed === null) throw new Error("CueBench generation writer lease is invalid.");
          expectedKey = generationArtifactWriteLeaseKey(claims.operationKey, fields.artifactKey.split("/")[3]!, fields.artifactKey);
        } else {
          throw new Error("CueBench private writer lease is invalid.");
        }
      } catch {
        throw new Error("CueBench private writer lease is invalid.");
      }
      if (listedLease.key !== expectedKey) throw new Error("CueBench preparation-write lease is invalid.");
      active.push(listedLease.key);
    }
    return active;
  }

  /** Persist newly observed exact derivatives before their R2 deletion. */
  private async retainCleanupArtifactKeys(
    input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    action: GenerationCleanupAction,
    discovered: readonly string[],
    nowMs: number,
  ): Promise<GenerationRunRecord | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(input);
      if (current === null || current.record.cleanup === undefined) return current?.record ?? null;
      const cleanup = current.record.cleanup;
      if (cleanup.action !== action) return current.record;
      const artifactKeys = [...new Set([...cleanup.artifactKeys, ...discovered])].sort((left, right) => left.localeCompare(right));
      if (artifactKeys.length > MAX_CLEANUP_ARTIFACT_KEYS) {
        throw new Error("CueBench generation cleanup inventory exceeds its bounded contract.");
      }
      if (artifactKeys.length === cleanup.artifactKeys.length && cleanup.state === "pending") return current.record;
      // This normally only transitions pending -> pending with newly listed
      // keys. Retaining the completed branch makes an interrupted old
      // deployment safe to repair on its first idempotent acknowledgement.
      const pending = { ...cleanup };
      delete pending.completedAtMs;
      const candidate: GenerationRunRecord = {
        ...current.record,
        cleanup: { ...pending, state: "pending", artifactKeys },
        updatedAtMs: Math.max(current.record.updatedAtMs, nowMs),
      };
      const saved = await this.bucket.put(recordKey(input), await this.encoded(candidate), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) return candidate;
    }
    return null;
  }

  private async completeCleanup(
    input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    action: GenerationCleanupAction,
    nowMs: number,
    fallback: GenerationRunRecord,
  ): Promise<GenerationRunRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(input);
      if (current === null || current.record.cleanup === undefined) return current?.record ?? fallback;
      if (current.record.cleanup.action !== action || current.record.cleanup.state === "completed") return current.record;
      const completed: GenerationRunRecord = {
        ...current.record,
        cleanup: { ...current.record.cleanup, state: "completed", completedAtMs: nowMs },
        updatedAtMs: Math.max(current.record.updatedAtMs, nowMs),
      };
      const saved = await this.bucket.put(recordKey(input), await this.encoded(completed), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) return completed;
    }
    return fallback;
  }

  /**
   * Older deployments could mark exact-key cleanup complete immediately
   * before a terminal lease CAS response was lost. Reopen that tombstone if a
   * later authenticated retry still cannot settle the retained lease; callers
   * then keep their receipt and retry instead of being told cleanup finished.
   */
  private async reopenCleanupForTerminalLeaseRelease(
    input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    action: GenerationCleanupAction,
    nowMs: number,
    fallback: GenerationRunRecord,
  ): Promise<GenerationRunRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(input);
      if (current === null || current.record.cleanup === undefined) return current?.record ?? fallback;
      if (current.record.cleanup.action !== action || current.record.cleanup.state === "pending") return current.record;
      const pending = { ...current.record.cleanup };
      delete pending.completedAtMs;
      const candidate: GenerationRunRecord = {
        ...current.record,
        cleanup: { ...pending, state: "pending" },
        updatedAtMs: Math.max(current.record.updatedAtMs, nowMs),
      };
      const saved = await this.bucket.put(recordKey(input), await this.encoded(candidate), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) return candidate;
    }
    return fallback;
  }

  public async cleanup(input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: GenerationCleanupAction;
    readonly nowMs: number;
  }): Promise<GenerationRunRecord | null> {
    const key = recordKey(input.claims);
    let detached: GenerationRunRecord | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(input.claims);
      if (current === null) return null;
      // Do this before detaching or listing. If a cancellation races an
      // in-flight prepare call, its next scoped bridge write is rejected and
      // a post-PUT race is immediately reclaimed by the bridge.
      await this.fencePreparationWrites(current.record.claims, input.action, input.nowMs);
      const existing = current.record.cleanup;
      if (existing !== undefined) {
        detached = current.record;
        break;
      }
      const cleanup: GenerationRunCleanup = {
        version: 1,
        state: "pending",
        action: input.action,
        artifactKeys: exactRunArtifactKeys(current.record),
        requestedAtMs: input.nowMs,
      };
      const candidate = detachRunArtifacts(current.record, cleanup);
      const saved = await this.bucket.put(key, await this.encoded(candidate), {
        onlyIf: { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      if (saved !== null) {
        detached = candidate;
        break;
      }
    }
    if (detached === null || detached.cleanup === undefined || detached.cleanup.action !== input.action) return detached;
    // The terminal status was written with leaseReleasePending before any
    // release CAS. Never report cleanup completed while that independent CAS
    // is still uncertain; a read, acknowledgement, delete, or retry will
    // continue this idempotent repair.
    if (!await this.reconcileTerminalLease(detached)) {
      return detached.cleanup.state === "completed"
        ? this.reopenCleanupForTerminalLeaseRelease(input.claims, input.action, input.nowMs, detached)
        : detached;
    }
    if (detached.cleanup.state === "completed") return detached;

    // The tombstone is persisted before every delete. Any discovery/listing
    // error leaves it pending, so an authenticated retry can resume instead
    // of claiming an incomplete cleanup. The marker prevents new bridge
    // writes, but sweep twice to reclaim a write that was already in flight.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      try {
        if ((await this.activeWriterLeases(detached.claims)).length > 0) return detached;
      } catch {
        return detached;
      }
      let outputs: readonly string[];
      let checkpoints: readonly string[];
      try {
        outputs = await this.preparedOutputKeys(detached.claims);
        checkpoints = await this.runArtifactKeys(input.claims);
        const retained = await this.retainCleanupArtifactKeys(input.claims, input.action, [...outputs, ...checkpoints], input.nowMs);
        if (retained === null) return detached;
        detached = retained;
      } catch {
        return detached;
      }
      if (detached.cleanup === undefined || detached.cleanup.action !== input.action || detached.cleanup.state === "completed") return detached;
      try {
        if (detached.cleanup.artifactKeys.length > 0) await this.deleteCleanupArtifactKeys(detached.cleanup.artifactKeys);
      } catch {
        return detached;
      }
      try {
        if (
          (await this.activeWriterLeases(detached.claims)).length === 0
          && (await this.preparedOutputKeys(detached.claims)).length === 0
          && (await this.runArtifactKeys(input.claims)).length === 0
        ) {
          return this.completeCleanup(input.claims, input.action, input.nowMs, detached);
        }
      } catch {
        return detached;
      }
    }
    // A repeat acknowledgement sees the durable pending inventory and retries
    // the exact-key sweep; no route reports a completed cleanup prematurely.
    return detached;
  }
}

export interface GenerationWorkflowControl {
  /** Every run gets its own Workflow instance; upload completion never owns it. */
  readonly startCaptionGeneration: (input: {
    readonly operationKey: string;
    readonly runId: string;
    readonly receipt: string;
    readonly uploadReceipt: string;
    /** A replacement is used only after a terminal broken Workflow instance. */
    readonly workflowAttempt?: number;
  }) => Promise<void>;
  /** Optional binding-only status probe for an already accepted dispatch. */
  readonly reconcileCaptionGeneration?: (input: {
    readonly operationKey: string;
    readonly runId: string;
    readonly receipt: string;
    readonly uploadReceipt: string;
    readonly workflowAttempt?: number;
  }) => Promise<void>;
  readonly cancelCaptionGeneration: (input: { readonly operationKey: string; readonly runId: string; readonly receipt: string }) => Promise<void>;
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
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
}

interface AcknowledgeRequest {
  readonly action: "adopted" | "discarded";
  readonly adoptedProjectRevision?: number;
}

const startRequest = (value: unknown): StartRequest | null => {
  const record = bodyRecord(value);
  if (record === null || Object.keys(record).some((key) => !["projectId", "runId", "expectedProjectRevision", "expectedQualityProfileRevision", "mediaSha256", "sourceByteLength", "sourceDurationMs", "qualityProfileRules"].includes(key))) return null;
  if (
    !OPAQUE_ID.test(record.projectId as string)
    || !OPAQUE_ID.test(record.runId as string)
    || !Number.isSafeInteger(record.expectedProjectRevision) || (record.expectedProjectRevision as number) <= 0
    || !Number.isSafeInteger(record.expectedQualityProfileRevision) || (record.expectedQualityProfileRevision as number) <= 0
    || typeof record.mediaSha256 !== "string" || !SHA256.test(record.mediaSha256)
    || !Number.isSafeInteger(record.sourceByteLength) || (record.sourceByteLength as number) <= 0
    || !Number.isSafeInteger(record.sourceDurationMs) || (record.sourceDurationMs as number) <= 0
  ) return null;
  const qualityProfileRules = record.qualityProfileRules === undefined ? undefined : boundedProfileRules(record.qualityProfileRules);
  if (qualityProfileRules === null) return null;
  return {
    projectId: record.projectId as string,
    runId: record.runId as string,
    expectedProjectRevision: record.expectedProjectRevision as number,
    expectedQualityProfileRevision: record.expectedQualityProfileRevision as number,
    mediaSha256: (record.mediaSha256 as string).toLowerCase(),
    sourceByteLength: record.sourceByteLength as number,
    sourceDurationMs: record.sourceDurationMs as number,
    ...(qualityProfileRules === undefined ? {} : { qualityProfileRules }),
  };
};

const acknowledgeRequest = (value: unknown): AcknowledgeRequest | null => {
  const record = bodyRecord(value);
  if (record === null || Object.keys(record).some((key) => key !== "action" && key !== "adoptedProjectRevision")) return null;
  if (record.action === "discarded" && record.adoptedProjectRevision === undefined) return { action: "discarded" };
  if (
    record.action === "adopted"
    && Number.isSafeInteger(record.adoptedProjectRevision)
    && (record.adoptedProjectRevision as number) > 0
  ) return { action: "adopted", adoptedProjectRevision: record.adoptedProjectRevision as number };
  return null;
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

const requestOwnsGenerationRun = async (
  request: Request,
  claims: GenerationRunReceiptClaims,
  settings: WorkerSettings,
  currentNow: number,
): Promise<boolean> => {
  const sessionToken = bearer(request);
  if (sessionToken === null) return false;
  try {
    const session = await verifyAnonymousSession(sessionToken, settings.keyRing, currentNow);
    if (session.purpose === "cleanup") return false;
    const sessionKey = await saltedLedgerKey(settings.quotaSalt, "session", session.sessionId);
    const rawOwnerCapability = request.headers.get("x-cuebench-project-owner");
    if (rawOwnerCapability !== null && /^[0-9a-f]{64}$/i.test(rawOwnerCapability)) {
      return (await saltedLedgerKey(settings.quotaSalt, "project-owner", rawOwnerCapability.toLowerCase())) === (claims.ownerKey ?? claims.sessionKey);
    }
    // Pre-owner receipts remain session-bound only until their signed expiry.
    // Older receipts did not carry a separate browser-owner key. Newer
    // receipts produced by the compatibility issuer encode the session key as
    // their owner key, which is equivalent only for that original session and
    // must remain readable for their short bounded lifetime.
    return (claims.ownerKey ?? claims.sessionKey) === claims.sessionKey && sessionKey === claims.sessionKey;
  } catch {
    return false;
  }
};

/**
 * Cloudflare Workflow instance ids are bounded. Hash both untrusted opaque
 * identifiers so each generation run remains collision-resistant and distinct
 * without embedding a 64-byte operation digest plus a user-selected run id.
 */
export const generationWorkflowInstanceId = async (operationKey: string, runId: string, workflowAttempt = 1): Promise<string> => {
  if (!Number.isSafeInteger(workflowAttempt) || workflowAttempt < 1 || workflowAttempt > 8) {
    throw new Error("CueBench cannot create an invalid generation Workflow attempt.");
  }
  // Preserve the original instance identity for attempt one so deployed runs
  // remain discoverable. Replacement attempts are explicitly distinct.
  const suffix = workflowAttempt === 1 ? "" : `:attempt:${workflowAttempt}`;
  const bytes = new TextEncoder().encode(`cuebench:generation:${operationKey}:${runId}${suffix}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  // `cgr-` + 60 hex chars is deliberately below Workflows' bounded id limit.
  return `cgr-${hex.slice(0, 60)}`;
};

export class GenerationWorkflowInstanceTerminalError extends Error {
  public constructor(
    public readonly workflowStatus: string,
  ) {
    super(`CueBench found a terminal caption Workflow instance (${workflowStatus}).`);
    this.name = "GenerationWorkflowInstanceTerminalError";
  }
}

const liveWorkflowStatuses = new Set(["queued", "running", "waiting", "paused"]);

export const bindingWorkflow = (binding: WorkerEnv["PROCESSING_WORKFLOW"] | undefined): GenerationWorkflowControl | undefined => {
  if (binding === undefined) return undefined;
  const startCaptionGeneration: GenerationWorkflowControl["startCaptionGeneration"] = async ({ operationKey, runId, receipt, uploadReceipt, workflowAttempt = 1 }) => {
      const id = await generationWorkflowInstanceId(operationKey, runId, workflowAttempt);
      try {
        await binding.create({ id, params: { generationReceipt: receipt, uploadReceipt } });
      } catch (error) {
        // Cloudflare rejects a duplicate instance id. It is safe only after we
        // verify that same deterministic run instance already exists.
        if (binding.get === undefined) throw error;
        const instance = await binding.get(id);
        const status = await instance.status();
        if (liveWorkflowStatuses.has(status.status)) return;
        // A completed instance is not proof of durable staging: only the R2
        // record can prove the matching terminal/staged state. The route will
        // either create a replacement for errored/terminated or persist an
        // explicit retryable failure for complete/unknown states.
        throw new GenerationWorkflowInstanceTerminalError(status.status);
      }
    };
  return {
    startCaptionGeneration,
    reconcileCaptionGeneration: startCaptionGeneration,
    cancelCaptionGeneration: async ({ operationKey, runId }) => {
      // Cancellation is durable R2 state read by the Workflow at every stage
      // boundary. A direct run has no event wait to wake, and a new run gets a
      // different deterministic instance id after this lease is released.
      void operationKey;
      void runId;
    },
  };
};

const globalBreakerOpen = async (settings: WorkerSettings, ledger: QuotaLedgerPort, currentNow: number): Promise<boolean> => (
  settings.globalSpendBreakerOpen || await ledger.isGlobalBreakerOpen({ nowMs: currentNow, globalSpendLimitCents: settings.quotas.globalSpendLimitCents })
);

const MAX_WORKFLOW_ATTEMPTS = 3;
const workflowAttemptFor = (record: GenerationRunRecord): number => record.workflowAttempt ?? 1;

/** A staged payload is the only durable proof that AwaitingAdoption succeeded. */
const hasDurableStagedSuccess = (record: GenerationRunRecord): boolean => {
  const staged = record.stagedResult;
  return staged !== undefined
    && staged.runId === record.claims.runId
    && staged.projectId === record.claims.projectId
    && staged.expectedProjectRevision === record.claims.expectedProjectRevision
    && staged.expectedQualityProfileRevision === record.claims.expectedQualityProfileRevision;
};

const needsWorkflowRecovery = (record: GenerationRunRecord, workflow: GenerationWorkflowControl): boolean => (
  !record.cancelled
  && !durableTerminalStatus(record.status)
  && (
    // Repair a partially persisted final success without sending a new event.
    (hasDurableStagedSuccess(record) && record.status.stage !== "AwaitingAdoption")
    // The original record has not been dispatched yet.
    || !record.dispatched
    // A human has explicitly retried a route-visible recoverable failure.
    || (record.status.stage === "Failed" && record.status.retryable === true)
    // Real bindings can probe accepted instances; lightweight test/port
    // implementations remain idempotent without a redundant start call.
    || (record.dispatched && workflow.reconcileCaptionGeneration !== undefined)
  )
);

const workflowTerminalFailure = (
  record: GenerationRunRecord,
  error: GenerationWorkflowInstanceTerminalError,
  currentNow: number,
): GenerationRunRecord => ({
  ...record,
  // Mark it dispatched so a same-run retry reconciles this explicit recovery
  // state instead of repeatedly treating a completed/unknown instance as
  // live. A new human-started run has a fresh operation/lease.
  dispatched: true,
  status: GenerationRunStatusSchema.parse({
    contractVersion: 1,
    runId: record.claims.runId,
    projectId: record.claims.projectId,
    targetTrack: "Captions",
    expectedProjectRevision: record.claims.expectedProjectRevision,
    stage: "Failed",
    code: "GENERATION_STAGE_FAILED",
    message: error.workflowStatus === "complete"
      ? "CueBench's caption Workflow completed without a matching durable staged result. Retry this generation from its visible failure state."
      : "CueBench's caption Workflow instance is no longer live. Retry this generation from its visible failure state.",
    retryable: true,
  }),
  ...(workflowAttemptFor(record) === 1 ? {} : { workflowAttempt: workflowAttemptFor(record) }),
  updatedAtMs: currentNow,
});

/**
 * Dispatches only a durable record. On an observed broken Workflow instance,
 * it persists the replacement attempt before creating it. A completed/unknown
 * instance is never accepted as proof of success without its matching record.
 */
const dispatchDurableGenerationWorkflow = async (
  runs: GenerationRunRecordStore,
  workflow: GenerationWorkflowControl,
  record: GenerationRunRecord,
  currentNow: number,
): Promise<GenerationRunRecord> => {
  // A request response can be lost after Workflow creation but before the
  // route writes `dispatched`. Always observe the latest durable record first:
  // an AwaitingAdoption/staged run must never be interpreted as a completed
  // Workflow with missing output and overwritten with Failed.
  let current = (await runs.load(record.claims)) ?? record;
  if (current.cancelled || durableTerminalStatus(current.status)) return current;
  if (hasDurableStagedSuccess(current)) {
    if (current.status.stage !== "AwaitingAdoption") {
      const repaired = { ...current, status: statusFor(current.claims, "AwaitingAdoption"), updatedAtMs: currentNow };
      await runs.save(repaired);
      current = (await runs.load(current.claims)) ?? repaired;
    }
    return current;
  }
  // A human retry of a route-visible retryable failure always uses a fresh
  // Workflow instance id. The persisted provider-attempt journal remains in
  // the workflow state, so a possibly accepted audio call still fails closed.
  if (current.status.stage === "Failed" && current.status.retryable === true) {
    const previousAttempt = workflowAttemptFor(current);
    if (previousAttempt >= MAX_WORKFLOW_ATTEMPTS) {
      const exhausted: GenerationRunRecord = {
        ...current,
        status: GenerationRunStatusSchema.parse({
          contractVersion: 1,
          runId: current.claims.runId,
          projectId: current.claims.projectId,
          targetTrack: "Captions",
          expectedProjectRevision: current.claims.expectedProjectRevision,
          stage: "Failed",
          code: "GENERATION_STAGE_FAILED",
          message: "CueBench exhausted the bounded durable Workflow recovery attempts. Start a new caption run after reviewing this terminal failure.",
          retryable: false,
        }),
        updatedAtMs: currentNow,
      };
      await runs.save(exhausted);
      return (await runs.load(current.claims)) ?? exhausted;
    }
    const retrying: GenerationRunRecord = {
      ...current,
      status: statusFor(current.claims, "Queued"),
      dispatched: false,
      workflowAttempt: previousAttempt + 1,
      updatedAtMs: currentNow,
    };
    await runs.save(retrying);
    current = (await runs.load(current.claims)) ?? retrying;
  }
  const attempt = workflowAttemptFor(current);
  try {
    const invokeWorkflow = current.dispatched && workflow.reconcileCaptionGeneration !== undefined
      ? workflow.reconcileCaptionGeneration
      : workflow.startCaptionGeneration;
    await invokeWorkflow({
      operationKey: current.claims.operationKey,
      runId: current.claims.runId,
      receipt: current.receipt,
      uploadReceipt: current.uploadReceipt,
      workflowAttempt: attempt,
    });
    const dispatched: GenerationRunRecord = {
      ...current,
      dispatched: true,
      ...(attempt === 1 ? {} : { workflowAttempt: attempt }),
      updatedAtMs: currentNow,
    };
    await runs.save(dispatched);
    return (await runs.load(current.claims)) ?? dispatched;
  } catch (error) {
    if (!(error instanceof GenerationWorkflowInstanceTerminalError)) throw error;
    // `create()` can report a duplicate terminal instance after a successful
    // prior dispatch whose response/write was lost. Reload before treating its
    // status as a failure so an R2-staged result always wins.
    const refreshed = await runs.load(current.claims);
    if (refreshed !== null && !refreshed.cancelled && hasDurableStagedSuccess(refreshed)) {
      if (refreshed.status.stage === "AwaitingAdoption") return refreshed;
      const repaired = { ...refreshed, status: statusFor(refreshed.claims, "AwaitingAdoption"), updatedAtMs: currentNow };
      await runs.save(repaired);
      return (await runs.load(refreshed.claims)) ?? repaired;
    }
    if ((error.workflowStatus === "errored" || error.workflowStatus === "terminated") && attempt < MAX_WORKFLOW_ATTEMPTS) {
      const replacement: GenerationRunRecord = {
        ...current,
        dispatched: false,
        workflowAttempt: attempt + 1,
        updatedAtMs: currentNow,
      };
      // The replacement intent must be durable before a different instance id
      // is created, otherwise a route crash could hide an accepted dispatch.
      await runs.save(replacement);
      const persisted = await runs.load(current.claims);
      if (persisted === null) throw new Error("CueBench could not persist a replacement caption Workflow attempt.", { cause: error });
      return dispatchDurableGenerationWorkflow(runs, workflow, persisted, currentNow);
    }
    const failed = workflowTerminalFailure(current, error, currentNow);
    await runs.save(failed);
    return (await runs.load(current.claims)) ?? failed;
  }
};

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
    const sessionKey = await saltedLedgerKey(settings.quotaSalt, "session", session.sessionId);
    const rawOwnerCapability = context.req.header("x-cuebench-project-owner");
    let ownerKey: string;
    if (rawOwnerCapability !== undefined && /^[0-9a-f]{64}$/i.test(rawOwnerCapability)) {
      ownerKey = await saltedLedgerKey(settings.quotaSalt, "project-owner", rawOwnerCapability.toLowerCase());
    } else {
      // Existing bounded-TTL receipts were session-scoped before the stable
      // browser owner capability was deployed.
      if (upload.ownerKey !== upload.sessionKey || sessionKey !== upload.sessionKey) {
        return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "A matching browser-project owner capability is required for this private upload.");
      }
      ownerKey = upload.sessionKey;
    }
    if (ownerKey !== upload.ownerKey) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different browser project owner.");
    }
    const projectKey = await saltedLedgerKey(settings.quotaSalt, "project", input.projectId);
    if (projectKey !== upload.projectKey) return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different CueBench project.");
    if (input.sourceByteLength !== upload.media.byteLength || input.sourceDurationMs !== upload.media.durationMs) {
      return apiError(409, "UPLOAD_MEDIA_STALE", "This private upload receipt does not match the current project media dimensions.");
    }
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
        || (existing.claims.ownerKey ?? existing.claims.sessionKey) !== ownerKey
        || existing.claims.projectKey !== upload.projectKey
        || existing.claims.sourceByteLength !== input.sourceByteLength
        || existing.claims.sourceDurationMs !== input.sourceDurationMs
        || JSON.stringify(existing.qualityProfileRules ?? {}) !== JSON.stringify(input.qualityProfileRules ?? {})
      ) return apiError(409, "IDEMPOTENCY_CONFLICT", "This generation run id was already used with different project evidence.");
      if (needsWorkflowRecovery(existing, workflow)) {
        try {
          const dispatched = await dispatchDurableGenerationWorkflow(runs, workflow, existing, currentNow);
          return context.json({ generationRunReceipt: dispatched.receipt, retentionExpiresAtMs: dispatched.claims.expiresAtMs, status: dispatched.status }, 200);
        } catch {
          return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
        }
      }
      return context.json({ generationRunReceipt: existing.receipt, retentionExpiresAtMs: existing.claims.expiresAtMs, status: existing.status }, 200);
    }
    // Terminal adoption/discard/cancellation removes the private source and
    // leaves an operation marker until the <=24h lifecycle backstop. A new
    // run must use a fresh upload/operation rather than accept a receipt that
    // can only fail later inside a Workflow after reserving provider quota.
    if (env.PROCESSING_BUCKET !== undefined) {
      try {
        if (await env.PROCESSING_BUCKET.head(generationCleanupMarkerKey(upload.operationKey)) !== null) {
          return apiError(409, "UPLOAD_MEDIA_CLEANED", "This private upload was already cleaned up. Upload the current media again before starting another caption run.");
        }
        const source = await env.PROCESSING_BUCKET.head(upload.objectKey);
        if (
          source === null
          || source.size !== upload.media.byteLength
          || source.httpMetadata?.contentType !== upload.media.contentType
        ) return apiError(409, "UPLOAD_MEDIA_CLEANED", "This private upload is no longer available. Upload the current media again before starting another caption run.");
      } catch {
        return apiError(503, "UPLOAD_MEDIA_UNAVAILABLE", "CueBench cannot verify the private upload before starting caption generation.", true);
      }
    }
    try {
      if (await globalBreakerOpen(settings, ledger, currentNow)) return apiError(429, "GLOBAL_BREAKER", "CueBench generation is temporarily unavailable while the public-use spend limit is active.", true);
    } catch {
      return apiError(503, "GLOBAL_BREAKER_UNAVAILABLE", "CueBench cannot safely check its processing spend limit right now.", true);
    }
    // The generation receipt must never outlive the capability that proves its
    // anonymous owner. This bound also lets the server CAS lease self-expire
    // without creating a permanently active project/media lock.
    const expiresAtMs = Math.min(upload.expiresAtMs, session.expiresAtMs, currentNow + DAY_MS);
    if (expiresAtMs <= currentNow) return apiError(410, "UPLOAD_EXPIRED", "The private upload receipt expired before caption generation could start.");
    let activeLease: ActiveGenerationLeaseAcquisition;
    try {
      activeLease = await runs.acquireActiveLease({
        sessionKey,
        ownerKey,
        projectKey: upload.projectKey,
        operationKey: upload.operationKey,
        runId: input.runId,
        expiresAtMs,
        nowMs: currentNow,
      });
    } catch {
      return apiError(503, "GENERATION_LEASE_UNAVAILABLE", "CueBench cannot safely reserve this project's durable caption-generation lease right now.", true);
    }
    if (activeLease.kind === "conflict") {
      return apiError(409, "GENERATION_LEASE_CONFLICT", "A different caption-generation run already owns this project's private media lease.");
    }
    if (activeLease.kind === "same-run") {
      // A concurrent same-run POST can observe the project lease in the tiny
      // interval before the first route has durably written its recovery
      // record. It must not reserve quota or dispatch a duplicate Workflow.
      const recovered = await runs.load({ operationKey: upload.operationKey, runId: input.runId });
      if (recovered === null) {
        return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench is durably reserving this caption-generation run. Retry with the same recovery lease.", true);
      }
      if (
        recovered.claims.projectId !== input.projectId
        || recovered.claims.expectedProjectRevision !== input.expectedProjectRevision
        || recovered.claims.expectedQualityProfileRevision !== input.expectedQualityProfileRevision
        || recovered.claims.mediaSha256 !== input.mediaSha256
        || (recovered.claims.ownerKey ?? recovered.claims.sessionKey) !== ownerKey
        || recovered.claims.projectKey !== upload.projectKey
        || recovered.claims.sourceByteLength !== input.sourceByteLength
        || recovered.claims.sourceDurationMs !== input.sourceDurationMs
        || JSON.stringify(recovered.qualityProfileRules ?? {}) !== JSON.stringify(input.qualityProfileRules ?? {})
      ) return apiError(409, "IDEMPOTENCY_CONFLICT", "This generation run id was already used with different project evidence.");
      if (needsWorkflowRecovery(recovered, workflow)) {
        try {
          const dispatched = await dispatchDurableGenerationWorkflow(runs, workflow, recovered, currentNow);
          return context.json({ generationRunReceipt: dispatched.receipt, retentionExpiresAtMs: dispatched.claims.expiresAtMs, status: dispatched.status }, 200);
        } catch {
          return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
        }
      }
      return context.json({ generationRunReceipt: recovered.receipt, retentionExpiresAtMs: recovered.claims.expiresAtMs, status: recovered.status }, 200);
    }
    const releaseUnrecordedLease = async (): Promise<boolean> => {
      try {
        await runs.releaseActiveLease({
          sessionKey,
          ownerKey,
          projectKey: upload.projectKey,
          operationKey: upload.operationKey,
          runId: input.runId,
          nowMs: currentNow,
        });
        return true;
      } catch {
        return false;
      }
    };
    const ipKey = await saltedLedgerKey(settings.quotaSalt, "network", clientIp(context.req.raw));
    const accepted = await ledger.reserveGeneration({
      sessionKey: upload.sessionKey,
      ipKey,
      usageKey: `generation:${upload.operationKey}:${input.runId}`,
      nowMs: currentNow,
      quotas: settings.quotas,
    }).catch(() => null);
    if (accepted === null) {
      await releaseUnrecordedLease();
      return apiError(503, "QUOTA_UNAVAILABLE", "CueBench cannot safely reserve anonymous generation quota right now.", true);
    }
    if (!accepted) {
      await releaseUnrecordedLease();
      return apiError(429, "GENERATION_QUOTA", "CueBench's anonymous caption-generation quota has been reached.", true);
    }
    let receipt: string;
    try {
      receipt = await issueGenerationRunReceipt({
        runId: input.runId,
        projectId: input.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: input.expectedProjectRevision,
        expectedQualityProfileRevision: input.expectedQualityProfileRevision,
        mediaSha256: input.mediaSha256,
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
      await releaseUnrecordedLease();
      return apiError(503, "GENERATION_UNAVAILABLE", "CueBench could not issue a recoverable private caption-generation receipt.", true);
    }
    const claims = await verifyGenerationRunReceipt(receipt, settings, currentNow);
    // Persist before the workflow event is sent. A lost response can therefore
    // be retried without another provider run or a new opaque receipt.
    const record: GenerationRunRecord = {
      version: 1,
      receipt,
      claims,
      uploadReceipt: uploadToken,
      status: statusFor(claims, "Queued"),
      cancelled: false,
      dispatched: false,
      workflowAttempt: 1,
      ...(input.qualityProfileRules === undefined ? {} : { qualityProfileRules: input.qualityProfileRules }),
      updatedAtMs: currentNow,
    };
    let persistedRecord = record;
    try {
      await runs.save(record);
    } catch {
      // Saving a record can lose its response. Re-read before releasing the
      // project lease: only an authoritative absence proves no Workflow can
      // exist, because dispatch is strictly after this persistence boundary.
      let observed: GenerationRunRecord | null;
      try {
        observed = await runs.load(record.claims);
      } catch {
        return apiError(503, "GENERATION_RECORD_UNCERTAIN", "CueBench cannot prove whether this caption-generation recovery receipt was saved. Retry with the same run id.", true);
      }
      if (observed === null) {
        const released = await releaseUnrecordedLease();
        return released
          ? apiError(503, "GENERATION_RECORD_UNAVAILABLE", "CueBench could not durably save this caption-generation recovery receipt. No workflow was dispatched; retry safely.", true)
          : apiError(503, "GENERATION_LEASE_UNCERTAIN", "CueBench could not durably save this caption-generation recovery receipt or release its private lease. Retry with the same run id.", true);
      }
      if (observed.receipt !== receipt) {
        return apiError(409, "IDEMPOTENCY_CONFLICT", "This generation run id now belongs to different durable recovery evidence.");
      }
      persistedRecord = observed;
    }
    try {
      const dispatched = await dispatchDurableGenerationWorkflow(runs, workflow, persistedRecord, currentNow);
      return context.json({ generationRunReceipt: receipt, retentionExpiresAtMs: claims.expiresAtMs, status: dispatched.status }, 201);
    } catch {
      return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
    }
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
    if (!await requestOwnsGenerationRun(context.req.raw, claims, settings, currentNow)) return apiError(403, "GENERATION_OWNERSHIP_MISMATCH", "A matching anonymous session is required for this caption-generation run.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    if (runs === undefined) return apiError(503, "GENERATION_UNAVAILABLE", "CueBench cannot read private generation status right now.", true);
    let record = await runs.load(claims);
    if (record === null || record.receipt !== receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private caption-generation run.");
    // Polling is also durable recovery: a Workflow can die after accepted
    // dispatch without producing another route request. Reconcile its actual
    // instance status here rather than leaving a Queued stage until expiry.
    const workflow = dependencies.workflow ?? bindingWorkflow(env.PROCESSING_WORKFLOW);
    if (workflow !== undefined && needsWorkflowRecovery(record, workflow)) {
      try {
        record = await dispatchDurableGenerationWorkflow(runs, workflow, record, currentNow);
      } catch {
        // The persisted record remains the source of truth; transient binding
        // transport failures do not turn a visible status poll into an error.
        record = (await runs.load(claims)) ?? record;
      }
    }
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
    if (!await requestOwnsGenerationRun(context.req.raw, claims, settings, currentNow)) return apiError(403, "GENERATION_OWNERSHIP_MISMATCH", "A matching anonymous session is required for this caption-generation run.");
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

  app.post("/api/generation-runs/:runId/acknowledge", async (context) => {
    const currentNow = now(dependencies);
    let settings: WorkerSettings;
    try { settings = resolveWorkerSettings(env); } catch { return apiError(503, "CONFIGURATION_UNAVAILABLE", "CueBench generation is not configured for this environment.", true); }
    const receipt = generationReceipt(context.req.raw);
    if (receipt === null) return apiError(401, "GENERATION_RECEIPT_REQUIRED", "A signed caption-generation receipt is required.");
    let claims: GenerationRunReceiptClaims;
    try { claims = await verifyGenerationRunReceipt(receipt, settings, currentNow); } catch { return apiError(401, "GENERATION_RECEIPT_INVALID", "CueBench could not verify this caption-generation receipt."); }
    if (claims.runId !== context.req.param("runId")) return apiError(403, "GENERATION_RECEIPT_MISMATCH", "This receipt belongs to a different caption-generation run.");
    if (!await requestOwnsGenerationRun(context.req.raw, claims, settings, currentNow)) return apiError(403, "GENERATION_OWNERSHIP_MISMATCH", "A matching anonymous session is required for this caption-generation run.");
    const acknowledgement = acknowledgeRequest(await context.req.json<unknown>().catch(() => null));
    if (acknowledgement === null) return apiError(400, "GENERATION_ACKNOWLEDGEMENT_INVALID", "CueBench could not read this terminal caption-generation acknowledgement.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const record = runs === undefined ? null : await runs.load(claims);
    if (record === null || runs === undefined || record.receipt !== receipt) return apiError(404, "NOT_FOUND", "CueBench could not find this private caption-generation run.");
    if (record.cleanup !== undefined && record.cleanup.action !== acknowledgement.action) {
      return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "CueBench already recorded a different terminal action for this caption-generation run.");
    }
    if (acknowledgement.action === "adopted") {
      const adoptedProjectRevision = acknowledgement.adoptedProjectRevision!;
      if (record.status.stage === "Completed") {
        if (record.status.adoptedProjectRevision !== adoptedProjectRevision) {
          return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "CueBench already recorded this generation as adopted at a different project revision.");
        }
      } else {
        if (record.cancelled || record.status.stage !== "AwaitingAdoption") {
          return apiError(409, "GENERATION_ACKNOWLEDGEMENT_INVALID", "Only a complete staged caption result can be acknowledged as adopted.");
        }
        const completed: GenerationRunRecord = {
          ...record,
          status: {
            contractVersion: 1,
            runId: claims.runId,
            projectId: claims.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: claims.expectedProjectRevision,
            stage: "Completed",
            adoptedProjectRevision,
          } satisfies GenerationRunStatus,
          updatedAtMs: currentNow,
        };
        await runs.save(completed);
      }
    } else if (record.status.stage !== "Cancelled") {
      if (record.status.stage !== "AwaitingAdoption" && record.status.stage !== "Failed") {
        return apiError(409, "GENERATION_ACKNOWLEDGEMENT_INVALID", "Only a failed or staged caption result can be discarded.");
      }
      const cancelled: GenerationRunRecord = {
        ...record,
        cancelled: true,
        status: statusFor(claims, "Cancelled"),
        updatedAtMs: currentNow,
      };
      await runs.save(cancelled);
    }
    const cleaned = await runs.cleanup({ claims, action: acknowledgement.action, nowMs: currentNow });
    if (cleaned === null) return apiError(404, "NOT_FOUND", "CueBench could not retain this terminal caption-generation acknowledgement.");
    // The first terminal actor wins even if another authenticated request
    // races between the load above and the R2 tombstone compare-and-swap.
    if (cleaned.cleanup?.action !== acknowledgement.action) {
      return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "CueBench already recorded a different terminal action for this caption-generation run.");
    }
    return context.json({ status: cleaned.status, cleanup: cleaned.cleanup });
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
    if (!await requestOwnsGenerationRun(context.req.raw, claims, settings, currentNow)) return apiError(403, "GENERATION_OWNERSHIP_MISMATCH", "A matching anonymous session is required for this caption-generation run.");
    const runs = dependencies.runs ?? (env.PROCESSING_BUCKET === undefined ? undefined : new R2GenerationRunRecordStore(env.PROCESSING_BUCKET));
    const workflow = dependencies.workflow ?? bindingWorkflow(env.PROCESSING_WORKFLOW);
    const record = runs === undefined ? null : await runs.load(claims);
    if (record === null || runs === undefined) return apiError(404, "NOT_FOUND", "CueBench could not find this private caption-generation run.");
    if (record.status.stage === "Completed") return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "An adopted caption-generation run cannot be cancelled.");
    if (record.cleanup?.action === "adopted") return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "An adopted caption-generation run cannot be cancelled.");
    const cancelled: GenerationRunRecord = record.status.stage === "Cancelled"
      ? record
      : { ...record, cancelled: true, status: statusFor(claims, "Cancelled"), updatedAtMs: currentNow };
    if (cancelled !== record) await runs.save(cancelled);
    await workflow?.cancelCaptionGeneration({ operationKey: claims.operationKey, runId: claims.runId, receipt }).catch(() => undefined);
    // A prior interruption can leave the exact-key tombstone pending. Repeat
    // the same terminal action so DELETE is truly idempotent and promotes the
    // durable cleanup rather than returning a misleading success forever.
    const cleanupAction: GenerationCleanupAction = record.cleanup?.action ?? "cancelled";
    const cleaned = await runs.cleanup({ claims, action: cleanupAction, nowMs: currentNow });
    if (cleaned?.cleanup?.action === "adopted") return apiError(409, "GENERATION_ACKNOWLEDGEMENT_CONFLICT", "An adopted caption-generation run cannot be cancelled.");
    return context.json({ status: cleaned?.status ?? cancelled.status, cleanup: cleaned?.cleanup });
  });

  return app;
};
