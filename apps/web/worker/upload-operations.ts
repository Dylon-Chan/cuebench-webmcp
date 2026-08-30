/**
 * Operation coordination is deliberately separate from quota accounting. It
 * holds only opaque hashes, multipart ids/ETags, and lifecycle state; no
 * filenames, captions, URLs, or project content cross this boundary.
 */

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
  | "cancelled"
  | "cleanup-pending"
  | "failed-retryable";

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly byteLength: number;
}

interface ClaimedPart {
  readonly claimId: string;
  readonly expiresAtMs: number;
}

export interface UploadOperationRecord {
  readonly ownerSessionKey: string;
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
  | { readonly kind: "claimed"; readonly claimId: string; readonly record: UploadOperationRecord }
  | { readonly kind: "uploaded"; readonly part: UploadedPart; readonly record: UploadOperationRecord }
  | { readonly kind: "in-progress"; readonly record: UploadOperationRecord }
  | { readonly kind: "unavailable"; readonly record: UploadOperationRecord };

export type CompletionClaimResult =
  | { readonly kind: "claimed"; readonly record: UploadOperationRecord }
  | { readonly kind: "status"; readonly record: UploadOperationRecord };

export interface UploadCoordinatorPort {
  begin: (input: BeginUploadOperationInput) => Promise<BeginUploadOperationResult>;
  attachMultipart: (input: { readonly uploadId: string; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  get: (nowMs: number) => Promise<UploadOperationRecord | null>;
  claimPart: (input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }) => Promise<PartClaimResult>;
  releasePart: (input: { readonly partNumber: number; readonly claimId: string; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  recordPart: (input: { readonly partNumber: number; readonly claimId: string; readonly etag: string; readonly byteLength: number; readonly nowMs: number }) => Promise<UploadOperationRecord | null>;
  beginCompletion: (nowMs: number) => Promise<CompletionClaimResult>;
  markProbing: (nowMs: number) => Promise<UploadOperationRecord | null>;
  markReady: (nowMs: number) => Promise<UploadOperationRecord | null>;
  claimWorkflowStart: (nowMs: number) => Promise<CompletionClaimResult>;
  markQueued: (nowMs: number) => Promise<UploadOperationRecord | null>;
  markRetryableFailure: (note: string, nowMs: number) => Promise<UploadOperationRecord | null>;
  markCancelled: (pendingCleanup: boolean, nowMs: number) => Promise<UploadOperationRecord | null>;
}

export interface DurableObjectStorage {
  get: <Value>(key: string) => Promise<Value | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorage;
}

const storageKey = "cuebench-upload-coordinator-v2";
const partKey = (partNumber: number): string => String(partNumber);

const clearExpiredClaims = (record: UploadOperationRecord, nowMs: number): UploadOperationRecord => ({
  ...record,
  claims: Object.fromEntries(Object.entries(record.claims).filter(([, claim]) => claim.expiresAtMs > nowMs)),
});

const active = (record: UploadOperationRecord | null, nowMs: number): UploadOperationRecord | null => {
  if (record === null || record.expiresAtMs <= nowMs) return null;
  return clearExpiredClaims(record, nowMs);
};

const withRecord = (record: UploadOperationRecord, next: Partial<UploadOperationRecord>): UploadOperationRecord => ({ ...record, ...next });

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
  reconciliationNote: null,
});

const compatible = (record: UploadOperationRecord, input: BeginUploadOperationInput): boolean => record.ownerSessionKey === input.ownerSessionKey
  && record.ownerIpKey === input.ownerIpKey
  && record.metadataHash === input.metadataHash
  && record.reservationKey === input.reservationKey
  && record.objectKey === input.objectKey
  && record.byteLength === input.byteLength
  && record.partSize === input.partSize
  && record.partCount === input.partCount
  && record.receiptExpiresAtMs === input.receiptExpiresAtMs;

/** A serial Durable Object per opaque operation hash. */
export class UploadCoordinator {
  public constructor(private readonly state: DurableObjectStateLike) {}

  public async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method-not-allowed" }, { status: 405 });
    let action: CoordinatorAction;
    try {
      action = await request.json() as CoordinatorAction;
    } catch {
      return Response.json({ error: "invalid-json" }, { status: 400 });
    }
    const current = active((await this.state.storage.get<UploadOperationRecord>(storageKey)) ?? null, action.nowMs);
    const applied = applyAction(current, action);
    if (applied.record === null) {
      // DO storage retains no expired operation data.
      await this.state.storage.put(storageKey, null);
    } else {
      await this.state.storage.put(storageKey, applied.record);
    }
    return Response.json(applied.value);
  }
}

type CoordinatorAction =
  | { readonly type: "begin"; readonly nowMs: number; readonly input: BeginUploadOperationInput }
  | { readonly type: "attach-multipart"; readonly nowMs: number; readonly uploadId: string }
  | { readonly type: "get"; readonly nowMs: number }
  | { readonly type: "claim-part"; readonly nowMs: number; readonly partNumber: number; readonly leaseMs: number; readonly claimId: string }
  | { readonly type: "release-part"; readonly nowMs: number; readonly partNumber: number; readonly claimId: string }
  | { readonly type: "record-part"; readonly nowMs: number; readonly partNumber: number; readonly claimId: string; readonly etag: string; readonly byteLength: number }
  | { readonly type: "begin-completion"; readonly nowMs: number }
  | { readonly type: "mark-probing" | "mark-ready" | "claim-workflow-start" | "mark-queued"; readonly nowMs: number }
  | { readonly type: "retryable-failure"; readonly nowMs: number; readonly note: string }
  | { readonly type: "mark-cancelled"; readonly nowMs: number; readonly pendingCleanup: boolean };

const partClaim = (record: UploadOperationRecord, action: Extract<CoordinatorAction, { readonly type: "claim-part" }>): { readonly record: UploadOperationRecord; readonly value: PartClaimResult } => {
  const expected = partExpectedBytes(record, action.partNumber);
  if (expected === 0) return { record, value: { kind: "unavailable", record } };
  const existing = record.parts[partKey(action.partNumber)];
  if (existing !== undefined) return { record, value: { kind: "uploaded", part: existing, record } };
  if (record.state !== "pending") return { record, value: { kind: "unavailable", record } };
  if (record.claims[partKey(action.partNumber)] !== undefined) return { record, value: { kind: "in-progress", record } };
  const next = withRecord(record, {
    claims: {
      ...record.claims,
      [partKey(action.partNumber)]: { claimId: action.claimId, expiresAtMs: Math.min(record.expiresAtMs, action.nowMs + action.leaseMs) },
    },
  });
  return { record: next, value: { kind: "claimed", claimId: action.claimId, record: next } };
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
  if (action.type === "attach-multipart") {
    if (current.state !== "creating") return { record: current, value: current };
    const record = withRecord(current, { multipartUploadId: action.uploadId, state: "pending" });
    return { record, value: record };
  }
  if (action.type === "claim-part") {
    const applied = partClaim(current, action);
    return { record: applied.record, value: applied.value };
  }
  if (action.type === "release-part") {
    const claimed = current.claims[partKey(action.partNumber)];
    if (claimed === undefined || claimed.claimId !== action.claimId) return { record: current, value: current };
    const claims = Object.fromEntries(Object.entries(current.claims).filter(([key]) => key !== partKey(action.partNumber)));
    return { record: withRecord(current, { claims }), value: withRecord(current, { claims }) };
  }
  if (action.type === "record-part") {
    const claimed = current.claims[partKey(action.partNumber)];
    const expected = partExpectedBytes(current, action.partNumber);
    if (claimed === undefined || claimed.claimId !== action.claimId || expected !== action.byteLength || action.etag.length === 0) return { record: current, value: null };
    const claims = Object.fromEntries(Object.entries(current.claims).filter(([key]) => key !== partKey(action.partNumber)));
    const parts = { ...current.parts, [partKey(action.partNumber)]: { partNumber: action.partNumber, etag: action.etag, byteLength: action.byteLength } };
    const pending = withRecord(current, { claims, parts });
    const record = allPartsPresent(pending) ? withRecord(pending, { state: "uploaded" }) : pending;
    return { record, value: record };
  }
  if (action.type === "begin-completion") {
    if ((current.state !== "uploaded" && current.state !== "failed-retryable") || current.multipartUploadId === null) return { record: current, value: { kind: "status", record: current } satisfies CompletionClaimResult };
    const record = withRecord(current, { state: "completing" });
    return { record, value: { kind: "claimed", record } satisfies CompletionClaimResult };
  }
  if (action.type === "mark-probing") {
    if (current.state !== "completing" && current.state !== "failed-retryable") return { record: current, value: current };
    const record = withRecord(current, { state: "probing" });
    return { record, value: record };
  }
  if (action.type === "mark-ready") {
    if (current.state !== "probing") return { record: current, value: current };
    const record = withRecord(current, { state: "ready", reconciliationNote: null });
    return { record, value: record };
  }
  if (action.type === "claim-workflow-start") {
    if (current.state !== "ready") return { record: current, value: { kind: "status", record: current } satisfies CompletionClaimResult };
    const record = withRecord(current, { state: "workflow-starting" });
    return { record, value: { kind: "claimed", record } satisfies CompletionClaimResult };
  }
  if (action.type === "mark-queued") {
    if (current.state !== "workflow-starting") return { record: current, value: current };
    const record = withRecord(current, { state: "queued" });
    return { record, value: record };
  }
  if (action.type === "retryable-failure") {
    const record = withRecord(current, { state: "failed-retryable", reconciliationNote: action.note });
    return { record, value: record };
  }
  if (action.type !== "mark-cancelled") return { record: current, value: current };
  const record = withRecord(current, { state: action.pendingCleanup ? "cleanup-pending" : "cancelled" });
  return { record, value: record };
};

/** Fixture implementation uses the identical serial state transition functions. */
export class InMemoryUploadCoordinator implements UploadCoordinatorPort {
  private record: UploadOperationRecord | null = null;

  private apply(action: CoordinatorAction): unknown {
    const current = active(this.record, action.nowMs);
    const applied = applyAction(current, action);
    this.record = applied.record;
    return applied.value;
  }

  public async begin(input: BeginUploadOperationInput): Promise<BeginUploadOperationResult> {
    return this.apply({ type: "begin", nowMs: input.nowMs, input }) as BeginUploadOperationResult;
  }

  public async attachMultipart(input: { readonly uploadId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "attach-multipart", ...input }) as UploadOperationRecord | null;
  }

  public async get(nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "get", nowMs }) as UploadOperationRecord | null;
  }

  public async claimPart(input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<PartClaimResult> {
    return this.apply({ type: "claim-part", nowMs: input.nowMs, partNumber: input.partNumber, leaseMs: input.leaseMs, claimId: input.createId() }) as PartClaimResult;
  }

  public async releasePart(input: { readonly partNumber: number; readonly claimId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "release-part", ...input }) as UploadOperationRecord | null;
  }

  public async recordPart(input: { readonly partNumber: number; readonly claimId: string; readonly etag: string; readonly byteLength: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "record-part", ...input }) as UploadOperationRecord | null;
  }

  public async beginCompletion(nowMs: number): Promise<CompletionClaimResult> {
    return this.apply({ type: "begin-completion", nowMs }) as CompletionClaimResult;
  }

  public async markProbing(nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "mark-probing", nowMs }) as UploadOperationRecord | null;
  }

  public async markReady(nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "mark-ready", nowMs }) as UploadOperationRecord | null;
  }

  public async claimWorkflowStart(nowMs: number): Promise<CompletionClaimResult> {
    return this.apply({ type: "claim-workflow-start", nowMs }) as CompletionClaimResult;
  }

  public async markQueued(nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "mark-queued", nowMs }) as UploadOperationRecord | null;
  }

  public async markRetryableFailure(note: string, nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "retryable-failure", nowMs, note }) as UploadOperationRecord | null;
  }

  public async markCancelled(pendingCleanup: boolean, nowMs: number): Promise<UploadOperationRecord | null> {
    return this.apply({ type: "mark-cancelled", nowMs, pendingCleanup }) as UploadOperationRecord | null;
  }
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
  public get(nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "get", nowMs }); }
  public claimPart(input: { readonly partNumber: number; readonly nowMs: number; readonly leaseMs: number; readonly createId: () => string }): Promise<PartClaimResult> { return this.call({ type: "claim-part", nowMs: input.nowMs, partNumber: input.partNumber, leaseMs: input.leaseMs, claimId: input.createId() }); }
  public releasePart(input: { readonly partNumber: number; readonly claimId: string; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "release-part", ...input }); }
  public recordPart(input: { readonly partNumber: number; readonly claimId: string; readonly etag: string; readonly byteLength: number; readonly nowMs: number }): Promise<UploadOperationRecord | null> { return this.call({ type: "record-part", ...input }); }
  public beginCompletion(nowMs: number): Promise<CompletionClaimResult> { return this.call({ type: "begin-completion", nowMs }); }
  public markProbing(nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-probing", nowMs }); }
  public markReady(nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-ready", nowMs }); }
  public claimWorkflowStart(nowMs: number): Promise<CompletionClaimResult> { return this.call({ type: "claim-workflow-start", nowMs }); }
  public markQueued(nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-queued", nowMs }); }
  public markRetryableFailure(note: string, nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "retryable-failure", nowMs, note }); }
  public markCancelled(pendingCleanup: boolean, nowMs: number): Promise<UploadOperationRecord | null> { return this.call({ type: "mark-cancelled", nowMs, pendingCleanup }); }
}

export const expectedPartByteLength = partExpectedBytes;
