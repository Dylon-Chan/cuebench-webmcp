import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_RECONCILIATION_CURSOR_KEY,
  LIFECYCLE_RECONCILIATION_LEAD_MS,
  lifecycleReconciliationKey,
  reconcilePrivateLifecycleTombstones,
  registerPrivateLifecycleTombstone,
} from "./lifecycle-reconciler";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
}

/** Minimal private-R2 fake: every delete is recorded so this test catches a prefix sweep. */
class MemoryPrivateBucket {
  public readonly objects = new Map<string, StoredObject>();
  public readonly deleted: string[] = [];

  public async put(key: string, value: string | Uint8Array): Promise<{ readonly etag: string }> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, { bytes, etag });
    return { etag };
  }

  public async get(key: string): Promise<{ readonly size: number; readonly etag: string; text: () => Promise<string> } | null> {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    return {
      size: object.bytes.byteLength,
      etag: object.etag,
      text: async () => new TextDecoder().decode(object.bytes),
    };
  }

  public async list(input: { readonly prefix: string; readonly limit: number; readonly cursor?: string }): Promise<{ readonly objects: readonly { readonly key: string }[]; readonly truncated: boolean; readonly cursor?: string }> {
    const matching = [...this.objects.keys()].filter((key) => key.startsWith(input.prefix)).sort();
    // R2 returns an opaque continuation. This fake models the only property
    // the reconciler needs: a page after the last returned key remains
    // reachable even if earlier exact keys are deleted during that page.
    const remaining = input.cursor === undefined
      ? matching
      : matching.filter((key) => key > input.cursor!);
    const page = remaining.slice(0, input.limit);
    const truncated = page.length < remaining.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated && page.length > 0 ? { cursor: page[page.length - 1] } : {}),
    };
  }

  public async delete(keys: string | readonly string[]): Promise<void> {
    for (const key of (typeof keys === "string" ? [keys] : keys)) {
      this.deleted.push(key);
      this.objects.delete(key);
    }
  }
}

const operationKey = "a".repeat(64);
const runId = "caption-reconcile-run";

describe("private lifecycle reconciler", () => {
  it("starts a bounded exact-key cleanup before expiry and never broad-deletes private storage", async () => {
    const bucket = new MemoryPrivateBucket();
    const expiresAtMs = 2_000_000;
    const recordKey = `prepared/${operationKey}/generation-runs/${runId}.json`;
    const sourceKey = `processing/${"b".repeat(64)}/${operationKey}`;
    const tombstoneKey = lifecycleReconciliationKey({ targetTrack: "Captions", operationKey, runId });
    await registerPrivateLifecycleTombstone({
      bucket: bucket as never,
      targetTrack: "Captions",
      operationKey,
      runId,
      recordKey,
      expiresAtMs,
    });
    const persistedTombstone = await bucket.get(tombstoneKey);
    expect(await persistedTombstone?.text()).not.toMatch(/receipt|session|owner|capability|https?:/i);
    await bucket.put(recordKey, "private recovery record");
    await bucket.put(sourceKey, "private source");

    const observed: string[] = [];
    const result = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: expiresAtMs - LIFECYCLE_RECONCILIATION_LEAD_MS,
      settle: async (entry) => {
        observed.push(entry.recordKey);
        return { state: "completed", deleteKeys: [entry.recordKey, sourceKey] };
      },
    });

    expect(result).toEqual({ scanned: 1, due: 1, completed: 1, pending: 0, invalid: 0, backlog: false });
    expect(observed).toEqual([recordKey]);
    expect(bucket.deleted).toEqual([recordKey, sourceKey, tombstoneKey]);
    expect(bucket.objects.has(recordKey)).toBe(false);
    expect(bucket.objects.has(sourceKey)).toBe(false);
    expect(bucket.objects.has(tombstoneKey)).toBe(false);
  });

  it("keeps a malformed or not-yet-due tombstone rather than deleting an inferred prefix", async () => {
    const bucket = new MemoryPrivateBucket();
    const future = 3_000_000;
    const validKey = lifecycleReconciliationKey({ targetTrack: "AudioDescriptions", operationKey, runId: "ad-reconcile-run" });
    await registerPrivateLifecycleTombstone({
      bucket: bucket as never,
      targetTrack: "AudioDescriptions",
      operationKey,
      runId: "ad-reconcile-run",
      recordKey: `prepared/${operationKey}/audio-description-runs/ad-reconcile-run.json`,
      expiresAtMs: future,
    });
    await bucket.put("processing/lifecycle-tombstones/not-a-valid-entry.json", "{not json");

    const result = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: future - LIFECYCLE_RECONCILIATION_LEAD_MS - 1,
      settle: async () => ({ state: "completed", deleteKeys: [] }),
    });

    expect(result).toEqual({ scanned: 2, due: 0, completed: 0, pending: 0, invalid: 1, backlog: false });
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.has(validKey)).toBe(true);
  });

  it("keeps a partial failure durable for the next exact retry instead of claiming the whole sweep completed", async () => {
    const bucket = new MemoryPrivateBucket();
    const expiresAtMs = 4_000_000;
    const firstRunId = "caption-partial-cleanup";
    const secondRunId = "ad-partial-cleanup";
    const firstRecordKey = `prepared/${operationKey}/generation-runs/${firstRunId}.json`;
    const secondRecordKey = `prepared/${operationKey}/audio-description-runs/${secondRunId}.json`;
    const secondIndexKey = lifecycleReconciliationKey({ targetTrack: "AudioDescriptions", operationKey, runId: secondRunId });
    await registerPrivateLifecycleTombstone({ bucket: bucket as never, targetTrack: "Captions", operationKey, runId: firstRunId, recordKey: firstRecordKey, expiresAtMs });
    await registerPrivateLifecycleTombstone({ bucket: bucket as never, targetTrack: "AudioDescriptions", operationKey, runId: secondRunId, recordKey: secondRecordKey, expiresAtMs });

    const firstPass = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: expiresAtMs - LIFECYCLE_RECONCILIATION_LEAD_MS,
      settle: async (entry) => {
        if (entry.runId === secondRunId) throw new Error("temporary R2 cleanup failure");
        return { state: "completed", deleteKeys: [entry.recordKey] };
      },
    });

    expect(firstPass).toEqual({ scanned: 2, due: 2, completed: 1, pending: 1, invalid: 0, backlog: false });
    expect(bucket.objects.has(secondIndexKey)).toBe(true);
    const secondPass = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: expiresAtMs - LIFECYCLE_RECONCILIATION_LEAD_MS + 1,
      settle: async (entry) => ({ state: "completed", deleteKeys: [entry.recordKey] }),
    });
    expect(secondPass).toEqual({ scanned: 1, due: 1, completed: 1, pending: 0, invalid: 0, backlog: false });
    expect(bucket.objects.has(secondIndexKey)).toBe(false);
  });

  it("processes a fixed batch and reports backlog truthfully without a broad delete", async () => {
    const bucket = new MemoryPrivateBucket();
    const expiresAtMs = 5_000_000;
    const runIds = Array.from({ length: 65 }, (_, index) => `backlog-${index}`);
    for (const runId of runIds) {
      await registerPrivateLifecycleTombstone({
        bucket: bucket as never,
        targetTrack: "Captions",
        operationKey,
        runId,
        recordKey: `prepared/${operationKey}/generation-runs/${runId}.json`,
        expiresAtMs,
      });
    }
    const settled: string[] = [];
    const result = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: expiresAtMs - LIFECYCLE_RECONCILIATION_LEAD_MS,
      settle: async (entry) => {
        settled.push(entry.runId);
        return { state: "completed", deleteKeys: [entry.recordKey] };
      },
    });

    expect(result).toEqual({ scanned: 64, due: 64, completed: 64, pending: 0, invalid: 0, backlog: true });
    expect(settled).toHaveLength(64);
    expect([...bucket.objects.keys()].filter((key) => key.startsWith("processing/lifecycle-tombstones/"))).toHaveLength(1);
    expect(bucket.objects.has(LIFECYCLE_RECONCILIATION_CURSOR_KEY)).toBe(true);
    expect(bucket.deleted).toHaveLength(128);
  });

  it("makes fair bounded progress past more than one batch of lower-key malformed and not-yet-due tombstones", async () => {
    const bucket = new MemoryPrivateBucket();
    const currentNow = 6_000_000;
    const futureExpiry = currentNow + LIFECYCLE_RECONCILIATION_LEAD_MS + 10_000;
    // This malformed entry and the 65 future entries sort before the due
    // record. A first-page-only sweep would permanently starve the due run.
    await bucket.put("processing/lifecycle-tombstones/000-malformed.json", "{not json");
    for (let index = 0; index < 65; index += 1) {
      const lowerOperationKey = `0${index.toString(16).padStart(63, "0")}`;
      const lowerRunId = `future-${index}`;
      await registerPrivateLifecycleTombstone({
        bucket: bucket as never,
        targetTrack: "Captions",
        operationKey: lowerOperationKey,
        runId: lowerRunId,
        recordKey: `prepared/${lowerOperationKey}/generation-runs/${lowerRunId}.json`,
        expiresAtMs: futureExpiry,
      });
    }
    const dueOperationKey = "f".repeat(64);
    const dueRunId = "later-due-run";
    await registerPrivateLifecycleTombstone({
      bucket: bucket as never,
      targetTrack: "AudioDescriptions",
      operationKey: dueOperationKey,
      runId: dueRunId,
      recordKey: `prepared/${dueOperationKey}/audio-description-runs/${dueRunId}.json`,
      expiresAtMs: currentNow + LIFECYCLE_RECONCILIATION_LEAD_MS,
    });

    const settled: string[] = [];
    const first = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: currentNow,
      settle: async (entry) => {
        settled.push(entry.runId);
        return { state: "completed", deleteKeys: [entry.recordKey] };
      },
    });
    expect(first).toMatchObject({ scanned: 64, due: 0, completed: 0, backlog: true });
    expect(settled).toEqual([]);

    const second = await reconcilePrivateLifecycleTombstones({
      bucket: bucket as never,
      nowMs: currentNow,
      settle: async (entry) => {
        settled.push(entry.runId);
        return { state: "completed", deleteKeys: [entry.recordKey] };
      },
    });
    expect(second).toMatchObject({ due: 1, completed: 1 });
    expect(settled).toEqual([dueRunId]);
  });
});
