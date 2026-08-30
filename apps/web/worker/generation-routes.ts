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
  generationCleanupMarkerKey,
  generationPreparationWriteLeaseKey,
} from "./generation-cleanup";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
/** A run has a small fixed number of durable stage checkpoints; never truncate this inventory. */
const MAX_ARTIFACT_REFERENCES = 64;
/** Task12 has one audio/waveform/manifest/index and at most 12 visual thumbnails. */
const MAX_PREPARED_OUTPUTS = 16;
const MAX_PREPARATION_WRITE_LEASE_BYTES = 1_024;
/** Includes every checkpoint plus exact source and every bounded Task12 derivative. */
const MAX_CLEANUP_ARTIFACT_KEYS = MAX_ARTIFACT_REFERENCES + 1 + MAX_PREPARED_OUTPUTS;
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
  /** Exact browser profile snapshot used by deterministic segmentation. */
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  /** Durable Workflow-only state. Never returned by a route. */
  readonly workflowState?: unknown;
  readonly workflowStateRef?: GenerationRunArtifactReference;
  readonly stagedResult?: StagedGenerationResult;
  readonly stagedResultRef?: GenerationRunArtifactReference;
  /** Every immutable run checkpoint ever referenced by this recovery record. */
  readonly artifactRefs?: readonly GenerationRunArtifactReference[];
  /** Durable cleanup intent/tombstone after adoption, discard, or cancellation. */
  readonly cleanup?: GenerationRunCleanup;
  readonly updatedAtMs: number;
}

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
    // Once an acknowledgement has detached rich data, a stale Workflow save
    // cannot recreate a private artifact or revive the terminal run.
    if (current?.cleanup !== undefined) return;
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

  public async cleanup(input: {
    readonly claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">;
    readonly action: GenerationCleanupAction;
    readonly nowMs: number;
  }): Promise<GenerationRunRecord | null> {
    const key = this.key(input.claims);
    const current = this.records.get(key);
    if (current === undefined) return null;
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
    return clone(cleaned);
  }
}

const recordKey = (input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): string =>
  `prepared/${input.operationKey}/generation-runs/${input.runId}.json`;

const artifactKey = (
  input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
  kind: "workflow-state" | "staged-result",
  digest: string,
): string => `prepared/${input.operationKey}/generation-runs/${input.runId}/artifacts/${kind}-${digest}.json`;

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
  kind: "workflow-state" | "staged-result",
): boolean => reference.key === artifactKey(claims, kind, reference.sha256);

const validAnyArtifactReference = (
  reference: GenerationRunArtifactReference,
  claims: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
): boolean => (
  validArtifactReference(reference, claims, "workflow-state")
  || validArtifactReference(reference, claims, "staged-result")
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

/** Keep the complete exact-key inventory rather than dropping superseded immutable snapshots. */
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
  if (record.version !== 1 || typeof record.receipt !== "string" || typeof record.uploadReceipt !== "string" || typeof record.cancelled !== "boolean" || typeof record.dispatched !== "boolean" || !Number.isSafeInteger(record.updatedAtMs)) return null;
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
    ...(qualityProfileRules === undefined ? {} : { qualityProfileRules }),
    ...(record.workflowState === undefined ? {} : { workflowState: record.workflowState }),
    ...(workflowStateRef === undefined ? {} : { workflowStateRef }),
    ...(staged === undefined ? {} : { stagedResult: staged.data }),
    ...(stagedResultRef === undefined ? {} : { stagedResultRef }),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    ...(cleanup === undefined ? {} : { cleanup }),
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
  && left.claims.sessionKey === right.claims.sessionKey
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
  const workflowState = mergeWorkflowState(current.workflowState, incoming.workflowState);
  const artifactRefs = mergedArtifactReferences(
    current.claims,
    current.artifactRefs,
    currentArtifactReferences(current),
    incoming.artifactRefs,
    currentArtifactReferences(incoming),
  );
  return {
    ...current,
    ...incoming,
    status: incomingAdvancesWorkflow || incomingAcknowledgesAdoption ? incoming.status : current.status,
    cancelled: false,
    dispatched: current.dispatched || incoming.dispatched,
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
    kind: "workflow-state" | "staged-result",
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
    kind: "workflow-state" | "staged-result",
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
    // Immutable content-addressed objects are safe to leave after a crashed
    // CAS attempt: the 24-hour lifecycle reaps an unreferenced object, while a
    // later retry reuses the same digest/key without copying arrays into R2.
    await this.bucket.put(key, bytes, {
      onlyIf: onlyIfAbsent(),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return { key, sha256, byteLength: bytes.byteLength };
  }

  private async compact(record: GenerationRunRecord): Promise<GenerationRunRecord> {
    const {
      workflowState,
      stagedResult,
      workflowStateRef: existingWorkflowStateRef,
      stagedResultRef: existingStagedResultRef,
      artifactRefs: existingArtifactRefs,
      ...base
    } = record;
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
    const artifactRefs = mergedArtifactReferences(
      record.claims,
      existingArtifactRefs,
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
    const encoded = JSON.stringify(compact);
    if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) {
      throw new Error("CueBench generation recovery record exceeds its private retention bound.");
    }
    return encoded;
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

  public async load(input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">): Promise<GenerationRunRecord | null> {
    return (await this.current(input))?.record ?? null;
  }

  public async save(record: GenerationRunRecord): Promise<void> {
    const key = recordKey(record.claims);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(record.claims);
      if (current === null) {
        const encoded = await this.encoded(record);
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
      if (current.record.cleanup !== undefined) return;
      if (!record.cancelled && current.record.cancelled) return;
      const candidate: GenerationRunRecord = record.cancelled
        ? {
          ...current.record,
          cancelled: true,
          status: record.status,
          updatedAtMs: record.updatedAtMs,
        }
        : mergeActiveRecord(current.record, record);
      const encoded = await this.encoded(candidate);
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
   * A scoped bridge lease is created before a Container's first terminal
   * marker read. R2 does not provide an abort signal for `put`, so an elapsed
   * timestamp cannot prove an outstanding writer drained. Every durable lease
   * remains an active fence until its owning bridge request explicitly removes
   * it after its final R2/marker settlement checks; lifecycle is the bounded
   * recovery backstop for a process that never returns.
   */
  private async preparationWriteLeases(
    claims: Pick<GenerationRunReceiptClaims, "operationKey">,
  ): Promise<readonly string[]> {
    const listed = await this.bucket.list({
      prefix: `prepared/${claims.operationKey}/generation-inflight/`,
      limit: MAX_PREPARED_OUTPUTS + 1,
    });
    if (listed.truncated || listed.objects.length > MAX_PREPARED_OUTPUTS) {
      throw new Error("CueBench preparation-write lease inventory exceeds its bounded contract.");
    }
    const active: string[] = [];
    for (const listedLease of listed.objects) {
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
        Object.keys(fields).length !== 2
        || fields.version !== 1
        || typeof fields.outputKey !== "string"
        || !preparedOutputArtifactKey(fields.outputKey, claims)
      ) throw new Error("CueBench preparation-write lease is invalid.");
      let expectedKey: string;
      try { expectedKey = generationPreparationWriteLeaseKey(claims.operationKey, fields.outputKey); } catch { throw new Error("CueBench preparation-write lease is invalid."); }
      if (listedLease.key !== expectedKey) throw new Error("CueBench preparation-write lease is invalid.");
      active.push(listedLease.key);
    }
    return active;
  }

  /** Persist newly observed exact derivatives before their R2 deletion. */
  private async retainPreparedOutputKeys(
    input: Pick<GenerationRunReceiptClaims, "operationKey" | "runId">,
    action: GenerationCleanupAction,
    outputs: readonly string[],
    nowMs: number,
  ): Promise<GenerationRunRecord | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(input);
      if (current === null || current.record.cleanup === undefined) return current?.record ?? null;
      const cleanup = current.record.cleanup;
      if (cleanup.action !== action) return current.record;
      const artifactKeys = [...new Set([...cleanup.artifactKeys, ...outputs])].sort((left, right) => left.localeCompare(right));
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
    if (detached === null || detached.cleanup === undefined || detached.cleanup.action !== input.action || detached.cleanup.state === "completed") return detached;

    // The tombstone is persisted before every delete. Any discovery/listing
    // error leaves it pending, so an authenticated retry can resume instead
    // of claiming an incomplete cleanup. The marker prevents new bridge
    // writes, but sweep twice to reclaim a write that was already in flight.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      try {
        if ((await this.preparationWriteLeases(detached.claims)).length > 0) return detached;
      } catch {
        return detached;
      }
      let outputs: readonly string[];
      try {
        outputs = await this.preparedOutputKeys(detached.claims);
        const retained = await this.retainPreparedOutputKeys(input.claims, input.action, outputs, input.nowMs);
        if (retained === null) return detached;
        detached = retained;
      } catch {
        return detached;
      }
      if (detached.cleanup === undefined || detached.cleanup.action !== input.action || detached.cleanup.state === "completed") return detached;
      try {
        if (detached.cleanup.artifactKeys.length > 0) await this.bucket.delete([...detached.cleanup.artifactKeys]);
      } catch {
        return detached;
      }
      try {
        if ((await this.preparedOutputKeys(detached.claims)).length === 0) {
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
  readonly startCaptionGeneration: (input: { readonly operationKey: string; readonly runId: string; readonly receipt: string; readonly uploadReceipt: string }) => Promise<void>;
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
    return (await saltedLedgerKey(settings.quotaSalt, "session", session.sessionId)) === claims.sessionKey;
  } catch {
    return false;
  }
};

/**
 * Cloudflare Workflow instance ids are bounded. Hash both untrusted opaque
 * identifiers so each generation run remains collision-resistant and distinct
 * without embedding a 64-byte operation digest plus a user-selected run id.
 */
export const generationWorkflowInstanceId = async (operationKey: string, runId: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`cuebench:generation:${operationKey}:${runId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  // `cgr-` + 60 hex chars is deliberately below Workflows' bounded id limit.
  return `cgr-${hex.slice(0, 60)}`;
};

const bindingWorkflow = (binding: WorkerEnv["PROCESSING_WORKFLOW"] | undefined): GenerationWorkflowControl | undefined => {
  if (binding === undefined) return undefined;
  return {
    startCaptionGeneration: async ({ operationKey, runId, receipt, uploadReceipt }) => {
      const id = await generationWorkflowInstanceId(operationKey, runId);
      try {
        await binding.create({ id, params: { generationReceipt: receipt, uploadReceipt } });
      } catch (error) {
        // Cloudflare rejects a duplicate instance id. It is safe only after we
        // verify that same deterministic run instance already exists.
        if (binding.get === undefined) throw error;
        const instance = await binding.get(id);
        const status = await instance.status();
        if (status.status === "unknown") throw error;
      }
    },
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
    if (sessionKey !== upload.sessionKey) {
      return apiError(403, "UPLOAD_OWNERSHIP_MISMATCH", "This private upload receipt belongs to a different anonymous session.");
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
        || existing.claims.sessionKey !== upload.sessionKey
        || existing.claims.sourceByteLength !== input.sourceByteLength
        || existing.claims.sourceDurationMs !== input.sourceDurationMs
        || JSON.stringify(existing.qualityProfileRules ?? {}) !== JSON.stringify(input.qualityProfileRules ?? {})
      ) return apiError(409, "IDEMPOTENCY_CONFLICT", "This generation run id was already used with different project evidence.");
      if (!existing.dispatched) {
        try {
          await workflow.startCaptionGeneration({ operationKey: upload.operationKey, runId: input.runId, receipt: existing.receipt, uploadReceipt: existing.uploadReceipt });
          await runs.save({ ...existing, dispatched: true, updatedAtMs: currentNow });
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
      sessionKey: upload.sessionKey,
      sourceByteLength: input.sourceByteLength,
      sourceDurationMs: input.sourceDurationMs,
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
      uploadReceipt: uploadToken,
      status: statusFor(claims, "Queued"),
      cancelled: false,
      dispatched: false,
      ...(input.qualityProfileRules === undefined ? {} : { qualityProfileRules: input.qualityProfileRules }),
      updatedAtMs: currentNow,
    };
    try {
      await runs.save(record);
      await workflow.startCaptionGeneration({ operationKey: upload.operationKey, runId: input.runId, receipt, uploadReceipt: uploadToken });
      await runs.save({ ...record, dispatched: true, updatedAtMs: currentNow });
    } catch {
      return apiError(503, "GENERATION_DISPATCH_PENDING", "CueBench saved the recovery receipt but could not dispatch its durable workflow yet.", true);
    }
    return context.json({ generationRunReceipt: receipt, retentionExpiresAtMs: claims.expiresAtMs, status: record.status }, 201);
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
