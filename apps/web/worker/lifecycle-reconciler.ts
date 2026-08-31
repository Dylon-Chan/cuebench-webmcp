import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * The R2 lifecycle rule is intentionally a backstop, not the mechanism that
 * makes the 24-hour privacy promise. These small, server-only tombstones let
 * a scheduled Worker retry the already-existing exact-key cleanup before a
 * receipt expires. They contain opaque identifiers and object paths only—no
 * media, captions, session tokens, or signed receipts.
 */
export const LIFECYCLE_RECONCILIATION_PREFIX = "processing/lifecycle-tombstones/";
/** Private, opaque continuation for bounded scheduled sweeps; outside the tombstone prefix. */
export const LIFECYCLE_RECONCILIATION_CURSOR_KEY = "processing/lifecycle-reconciliation-cursor.json";
export const LIFECYCLE_RECONCILIATION_LEAD_MS = 30 * 60 * 1_000;
export const MAX_LIFECYCLE_RECONCILIATION_TOMBSTONES = 64;

const MAX_TOMBSTONE_BYTES = 16 * 1024;
const MAX_EXACT_DELETE_KEYS = 64;
const MAX_CURSOR_BYTES = 4 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;

export type LifecycleTargetTrack = "Captions" | "AudioDescriptions";

export interface PrivateLifecycleTombstone {
  readonly version: 1;
  readonly targetTrack: LifecycleTargetTrack;
  readonly operationKey: string;
  readonly runId: string;
  /** Server-derived exact R2 recovery-record key, never a user-supplied URL. */
  readonly recordKey: string;
  /** Signed receipt expiry, capped by the server at one day from start. */
  readonly expiresAtMs: number;
}

export interface LifecycleReconciliationResult {
  readonly scanned: number;
  readonly due: number;
  readonly completed: number;
  readonly pending: number;
  readonly invalid: number;
  /** More opaque tombstones remain than this invocation's fixed work budget. */
  readonly backlog: boolean;
}

export type LifecycleSettlement =
  | { readonly state: "completed"; readonly deleteKeys: readonly string[] }
  | { readonly state: "pending" | "missing" };

const recordKeyFor = (targetTrack: LifecycleTargetTrack, operationKey: string, runId: string): string => (
  targetTrack === "Captions"
    ? `prepared/${operationKey}/generation-runs/${runId}.json`
    : `prepared/${operationKey}/audio-description-runs/${runId}.json`
);

const validInputs = (input: Pick<PrivateLifecycleTombstone, "targetTrack" | "operationKey" | "runId" | "recordKey" | "expiresAtMs">): boolean => (
  (input.targetTrack === "Captions" || input.targetTrack === "AudioDescriptions")
  && SHA256.test(input.operationKey)
  && OPAQUE_ID.test(input.runId)
  && input.recordKey === recordKeyFor(input.targetTrack, input.operationKey, input.runId)
  && Number.isSafeInteger(input.expiresAtMs)
  && input.expiresAtMs > 0
);

/** A deterministic exact key lets the scheduled handler read/delete one run without prefix deletion. */
export const lifecycleReconciliationKey = (input: Pick<PrivateLifecycleTombstone, "targetTrack" | "operationKey" | "runId">): string => {
  if ((input.targetTrack !== "Captions" && input.targetTrack !== "AudioDescriptions") || !SHA256.test(input.operationKey) || !OPAQUE_ID.test(input.runId)) {
    throw new Error("CueBench cannot create a lifecycle tombstone for an invalid private run.");
  }
  const target = input.targetTrack === "Captions" ? "captions" : "audio-descriptions";
  return `${LIFECYCLE_RECONCILIATION_PREFIX}${input.operationKey.toLowerCase()}/${target}/${input.runId}.json`;
};

const parseTombstone = (value: unknown): PrivateLifecycleTombstone | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== 1
    || (record.targetTrack !== "Captions" && record.targetTrack !== "AudioDescriptions")
    || typeof record.operationKey !== "string"
    || typeof record.runId !== "string"
    || typeof record.recordKey !== "string"
    || !Number.isSafeInteger(record.expiresAtMs)
  ) return null;
  const tombstone: PrivateLifecycleTombstone = {
    version: 1,
    targetTrack: record.targetTrack,
    operationKey: record.operationKey.toLowerCase(),
    runId: record.runId,
    recordKey: record.recordKey,
    expiresAtMs: record.expiresAtMs as number,
  };
  return validInputs(tombstone) ? tombstone : null;
};

const isExactPrivateObjectKey = (key: string): boolean => (
  key.length > 0
  && key.length <= 1_000
  && !key.includes("..")
  && (key.startsWith("processing/") || key.startsWith("prepared/"))
);

const validCursor = (value: unknown): value is string => (
  typeof value === "string"
  && value.length > 0
  && value.length <= MAX_CURSOR_BYTES
  && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })
);

/**
 * The continuation is deliberately opaque and contains no run receipt,
 * owner, session, media, or URL. A missing/corrupt cursor restarts safely at
 * the beginning; it can repeat work, never skip a private deletion.
 */
const readSweepCursor = async (bucket: R2Bucket): Promise<string | undefined> => {
  const stored = await bucket.get(LIFECYCLE_RECONCILIATION_CURSOR_KEY).catch(() => null);
  if (stored === null || stored.size <= 0 || stored.size > MAX_CURSOR_BYTES) return undefined;
  try {
    const parsed = JSON.parse(await stored.text()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Readonly<Record<string, unknown>>;
    return record.version === 1 && validCursor(record.cursor) ? record.cursor : undefined;
  } catch {
    return undefined;
  }
};

/** Persist after processing: a failed cursor write merely repeats exact work next tick. */
const persistSweepCursor = async (
  bucket: R2Bucket,
  cursor: string | undefined,
  clearExisting: boolean,
): Promise<boolean> => {
  try {
    if (cursor === undefined) {
      // Avoid an unnecessary write/delete on an initial one-page sweep. If a
      // previous page did leave a continuation, clearing it at the natural
      // end is what makes the next scheduler tick start a fresh fair pass.
      if (!clearExisting) return true;
      await bucket.delete(LIFECYCLE_RECONCILIATION_CURSOR_KEY);
      return true;
    }
    if (!validCursor(cursor)) return false;
    await bucket.put(LIFECYCLE_RECONCILIATION_CURSOR_KEY, JSON.stringify({ version: 1, cursor }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { cuebench_lifecycle_cursor: "1" },
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Write ahead of a run-record write. If this fails, the caller fails closed
 * before it can persist an untracked recovery run. Replacing this one exact
 * tombstone is idempotent and deliberately needs no broad object listing.
 */
export const registerPrivateLifecycleTombstone = async (
  input: Omit<PrivateLifecycleTombstone, "version"> & { readonly bucket: R2Bucket },
): Promise<void> => {
  const { bucket, ...fields } = input;
  const tombstone: PrivateLifecycleTombstone = { version: 1, ...fields };
  if (!validInputs(tombstone)) throw new Error("CueBench rejected an invalid private lifecycle tombstone.");
  const encoded = JSON.stringify(tombstone);
  if (encoded.length === 0 || encoded.length > MAX_TOMBSTONE_BYTES) throw new Error("CueBench lifecycle tombstone exceeds its private bound.");
  await bucket.put(lifecycleReconciliationKey(tombstone), encoded, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { cuebench_lifecycle_tombstone: "1" },
  });
};

/**
 * Processes a bounded list of opaque tombstones. `settle` owns the
 * target-specific fence/inventory logic; this coordinator only deletes the
 * exact keys it is handed after that logic says cleanup is complete.
 */
export const reconcilePrivateLifecycleTombstones = async (input: {
  readonly bucket: R2Bucket;
  readonly nowMs: number;
  readonly settle: (entry: PrivateLifecycleTombstone) => Promise<LifecycleSettlement>;
}): Promise<LifecycleReconciliationResult> => {
  const cursor = await readSweepCursor(input.bucket);
  const listed = await input.bucket.list({
    prefix: LIFECYCLE_RECONCILIATION_PREFIX,
    limit: MAX_LIFECYCLE_RECONCILIATION_TOMBSTONES,
    ...(cursor === undefined ? {} : { cursor }),
  });
  // Cursor pagination makes bounded forward progress even when malformed or
  // not-yet-due lower keys fill a page. The continuation is persisted only
  // after all page work; a crash repeats a page idempotently rather than
  // skipping a due exact tombstone.
  const objects = listed.objects.slice(0, MAX_LIFECYCLE_RECONCILIATION_TOMBSTONES);

  let due = 0;
  let completed = 0;
  let pending = 0;
  let invalid = 0;
  for (const object of objects) {
    const indexKey = object.key;
    const stored = await input.bucket.get(indexKey).catch(() => null);
    if (stored === null || stored.size <= 0 || stored.size > MAX_TOMBSTONE_BYTES) {
      invalid += 1;
      continue;
    }
    let parsed: PrivateLifecycleTombstone | null;
    try {
      parsed = parseTombstone(JSON.parse(await stored.text()));
    } catch {
      invalid += 1;
      continue;
    }
    if (parsed === null || lifecycleReconciliationKey(parsed) !== indexKey) {
      invalid += 1;
      continue;
    }
    if (input.nowMs < parsed.expiresAtMs - LIFECYCLE_RECONCILIATION_LEAD_MS) continue;
    due += 1;
    let settlement: LifecycleSettlement;
    try { settlement = await input.settle(parsed); } catch { pending += 1; continue; }
    if (settlement.state === "pending") {
      pending += 1;
      continue;
    }
    if (settlement.state === "missing") {
      try {
        await input.bucket.delete(indexKey);
        completed += 1;
      } catch { pending += 1; }
      continue;
    }
    if (settlement.state !== "completed") {
      invalid += 1;
      continue;
    }
    const deleteKeys = [...new Set([...settlement.deleteKeys, indexKey])];
    if (
      deleteKeys.length > MAX_EXACT_DELETE_KEYS
      || deleteKeys.some((key) => !isExactPrivateObjectKey(key))
    ) {
      invalid += 1;
      continue;
    }
    try {
      await input.bucket.delete(deleteKeys);
      completed += 1;
    } catch {
      pending += 1;
    }
  }
  const listedCursor = (listed as { readonly cursor?: unknown }).cursor;
  const hasUsableNextCursor = listed.truncated && validCursor(listedCursor);
  const nextCursor = hasUsableNextCursor ? listedCursor : undefined;
  // If an unexpected list response says it is truncated without a usable
  // continuation, retain the old cursor (or no cursor) and report backlog.
  // Advancing to an invented position could skip an exact private cleanup.
  const cursorPersisted = listed.truncated && !hasUsableNextCursor
    ? false
    : await persistSweepCursor(input.bucket, nextCursor, cursor !== undefined);
  // `truncated` with no valid continuation is explicitly backlog, not a
  // false completed sweep. Cursor persistence failure is likewise visible so
  // the scheduler retries the same bounded page without hiding the backlog.
  const backlog = listed.truncated || !cursorPersisted;
  return { scanned: objects.length, due, completed, pending, invalid, backlog };
};
