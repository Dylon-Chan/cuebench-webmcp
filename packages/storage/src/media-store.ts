import type { MediaSourceSnapshot } from "@cuebench/contracts";
import {
  CueBenchDatabase,
  narrationBlobKey,
  runReceiptKey,
  sourceBlobKey,
  validateNarrationBlobRow,
  validateRunReceiptRow,
  validateSettingRow,
  validateSourceBlobRow,
  type NarrationBlobRow,
  type RunReceiptRow,
  type SettingRow,
  type SourceBlobRow,
} from "./database";

const now = (): number => Date.now();

const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value);
const isIdentifier = (value: string): boolean => value.trim().length > 0 && value.length <= 200;
const assertBlob: (value: unknown, label: string) => asserts value is Blob = (value, label) => {
  if (typeof Blob === "undefined" || !(value instanceof Blob)) {
    throw new TypeError(`${label} must be a Blob.`);
  }
};

export interface SourceMediaInput {
  readonly sourceId: string;
  readonly sha256: string;
  readonly blob: Blob;
  readonly fileName?: string | null;
  readonly contentType?: string;
}

export interface NarrationBlobInput {
  readonly beatId: string;
  readonly itemRevision: number;
  readonly blob: Blob;
  readonly contentType?: string;
}

const sourceInputFrom = (
  source: SourceMediaInput | Pick<MediaSourceSnapshot, "sourceId" | "sha256">,
  blob: Blob | undefined,
): SourceMediaInput => {
  if ("blob" in source) return source;
  if (blob === undefined) throw new TypeError("A source-media Blob is required.");
  return { ...source, blob };
};

/**
 * Stores source media by project and immutable media hash. The primary key is
 * hash-derived, so repeated imports (including racing browser tabs) cannot
 * create duplicate copies of the same source blob.
 */
export async function saveSourceMedia(
  db: CueBenchDatabase,
  projectId: string,
  source: SourceMediaInput,
): Promise<SourceBlobRow>;
export async function saveSourceMedia(
  db: CueBenchDatabase,
  projectId: string,
  source: Pick<MediaSourceSnapshot, "sourceId" | "sha256">,
  blob: Blob,
): Promise<SourceBlobRow>;
export async function saveSourceMedia(
  db: CueBenchDatabase,
  projectId: string,
  source: SourceMediaInput | Pick<MediaSourceSnapshot, "sourceId" | "sha256">,
  blob?: Blob,
): Promise<SourceBlobRow> {
  const input = sourceInputFrom(source, blob);
  if (!isIdentifier(projectId) || !isIdentifier(input.sourceId) || !isSha256(input.sha256)) {
    throw new TypeError("Source media needs non-empty project/source ids and a SHA-256 hash.");
  }
  assertBlob(input.blob, "Source media");
  const key = sourceBlobKey(projectId, input.sha256);
  const candidate: SourceBlobRow = {
    key,
    projectId,
    sourceId: input.sourceId,
    sha256: input.sha256,
    blob: input.blob,
    byteLength: input.blob.size,
    contentType: input.contentType ?? input.blob.type,
    fileName: input.fileName ?? null,
    savedAtMs: now(),
  };
  const validatedCandidate = validateSourceBlobRow(candidate);
  try {
    return await db.transaction("rw", db.sourceBlobs, async () => {
      const existing = await db.sourceBlobs.get(key);
      if (existing !== undefined) return validateSourceBlobRow(existing);
      await db.sourceBlobs.add(validatedCandidate);
      return validatedCandidate;
    });
  } catch (error) {
    // A second database connection may win after this transaction read but
    // before its add. Re-read the deterministic key rather than writing a
    // second blob under a different source id.
    if (error instanceof Error && error.name === "ConstraintError") {
      const existing = await db.sourceBlobs.get(key);
      if (existing !== undefined) return validateSourceBlobRow(existing);
    }
    throw error;
  }
}

export const loadSourceMedia = async (
  db: CueBenchDatabase,
  projectId: string,
  sourceIdOrSha256: string,
): Promise<SourceBlobRow | undefined> => db.transaction("r", db.sourceBlobs, async () => {
  const byHash = isSha256(sourceIdOrSha256)
    ? await db.sourceBlobs.get(sourceBlobKey(projectId, sourceIdOrSha256))
    : undefined;
  if (byHash !== undefined) return validateSourceBlobRow(byHash);
  const bySourceId = await db.sourceBlobs.where("[projectId+sourceId]").equals([projectId, sourceIdOrSha256]).first();
  return bySourceId === undefined ? undefined : validateSourceBlobRow(bySourceId);
});

export const saveNarrationBlob = async (
  db: CueBenchDatabase,
  projectId: string,
  input: NarrationBlobInput,
): Promise<NarrationBlobRow> => {
  if (!isIdentifier(projectId) || !isIdentifier(input.beatId) || !Number.isSafeInteger(input.itemRevision) || input.itemRevision <= 0) {
    throw new TypeError("Narration blobs need a project, beat, and positive item revision.");
  }
  assertBlob(input.blob, "Narration preview");
  const row = validateNarrationBlobRow({
    key: narrationBlobKey(projectId, input.beatId, input.itemRevision),
    projectId,
    beatId: input.beatId,
    itemRevision: input.itemRevision,
    blob: input.blob,
    byteLength: input.blob.size,
    contentType: input.contentType ?? input.blob.type,
    savedAtMs: now(),
  });
  await db.transaction("rw", db.narrationBlobs, async () => {
    await db.narrationBlobs.put(row);
  });
  return row;
};

export const loadNarrationBlob = async (
  db: CueBenchDatabase,
  projectId: string,
  beatId: string,
  itemRevision: number,
): Promise<NarrationBlobRow | undefined> => db.transaction("r", db.narrationBlobs, async () => {
  const row = await db.narrationBlobs.get(narrationBlobKey(projectId, beatId, itemRevision));
  return row === undefined ? undefined : validateNarrationBlobRow(row);
});

/** Persist the opaque signed recovery capability before status polling starts. */
export const saveRunReceipt = async (
  db: CueBenchDatabase,
  projectId: string,
  runId: string,
  receipt: unknown,
): Promise<RunReceiptRow> => {
  if (!isIdentifier(projectId) || !isIdentifier(runId)) throw new TypeError("Run receipts need project and run ids.");
  const row = validateRunReceiptRow({ key: runReceiptKey(projectId, runId), projectId, runId, receipt, savedAtMs: now() });
  await db.transaction("rw", db.runReceipts, async () => {
    await db.runReceipts.put(row);
  });
  return row;
};

export const loadRunReceipt = async (
  db: CueBenchDatabase,
  projectId: string,
  runId: string,
): Promise<RunReceiptRow | undefined> => db.transaction("r", db.runReceipts, async () => {
  const row = await db.runReceipts.get(runReceiptKey(projectId, runId));
  return row === undefined ? undefined : validateRunReceiptRow(row);
});

export const saveSetting = async (
  db: CueBenchDatabase,
  key: string,
  value: unknown,
): Promise<SettingRow> => {
  if (!isIdentifier(key)) throw new TypeError("Setting key must be a non-empty identifier.");
  const row = validateSettingRow({ key, value, updatedAtMs: now() });
  await db.transaction("rw", db.settings, async () => {
    await db.settings.put(row);
  });
  return row;
};

export const loadSetting = async (db: CueBenchDatabase, key: string): Promise<SettingRow | undefined> =>
  db.transaction("r", db.settings, async () => {
    const row = await db.settings.get(key);
    return row === undefined ? undefined : validateSettingRow(row);
  });

export interface ProjectStorageEstimate {
  readonly projectId: string;
  readonly sourceBlobBytes: number;
  readonly narrationBlobBytes: number;
  readonly metadataBytes: number;
  readonly totalBytes: number;
  readonly browserUsageBytes: number | null;
  readonly browserQuotaBytes: number | null;
  readonly browserAvailableBytes: number | null;
}

const byteLengthOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;

/**
 * Reports the exact retained blob sizes plus a conservative JSON metadata
 * estimate. Browser quota is advisory and deliberately does not make a
 * temporary session look durably saved.
 */
export const estimateProjectStorage = async (
  db: CueBenchDatabase,
  projectId: string,
): Promise<ProjectStorageEstimate> => {
  const rows = await db.transaction(
    "r",
    [
      db.projectHeaders,
      db.items,
      db.revisions,
      db.findings,
      db.evidence,
      db.courtRecord,
      db.certifications,
      db.sourceBlobs,
      db.narrationBlobs,
      db.runReceipts,
    ],
    async () => Promise.all([
      db.projectHeaders.get(projectId),
      db.items.where("projectId").equals(projectId).toArray(),
      db.revisions.where("projectId").equals(projectId).toArray(),
      db.findings.where("projectId").equals(projectId).toArray(),
      db.evidence.where("projectId").equals(projectId).toArray(),
      db.courtRecord.where("projectId").equals(projectId).toArray(),
      db.certifications.where("projectId").equals(projectId).toArray(),
      db.sourceBlobs.where("projectId").equals(projectId).toArray(),
      db.narrationBlobs.where("projectId").equals(projectId).toArray(),
      db.runReceipts.where("projectId").equals(projectId).toArray(),
    ]),
  );
  const [header, items, revisions, findings, evidence, courtRecord, certifications, sourceBlobs, narrationBlobs, receipts] = rows;
  const validSources = sourceBlobs.map(validateSourceBlobRow);
  const validNarration = narrationBlobs.map(validateNarrationBlobRow);
  const sourceBlobBytes = validSources.reduce((total, row) => total + row.byteLength, 0);
  const narrationBlobBytes = validNarration.reduce((total, row) => total + row.byteLength, 0);
  const metadataBytes = byteLengthOf(header)
    + byteLengthOf(items)
    + byteLengthOf(revisions)
    + byteLengthOf(findings)
    + byteLengthOf(evidence)
    + byteLengthOf(courtRecord)
    + byteLengthOf(certifications)
    + byteLengthOf(receipts);
  let browserUsageBytes: number | null = null;
  let browserQuotaBytes: number | null = null;
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    browserUsageBytes = typeof estimate?.usage === "number" ? estimate.usage : null;
    browserQuotaBytes = typeof estimate?.quota === "number" ? estimate.quota : null;
  } catch {
    // Quota estimation is advisory and unavailable in several private modes.
  }
  return {
    projectId,
    sourceBlobBytes,
    narrationBlobBytes,
    metadataBytes,
    totalBytes: sourceBlobBytes + narrationBlobBytes + metadataBytes,
    browserUsageBytes,
    browserQuotaBytes,
    browserAvailableBytes: browserUsageBytes === null || browserQuotaBytes === null
      ? null
      : Math.max(0, browserQuotaBytes - browserUsageBytes),
  };
};
