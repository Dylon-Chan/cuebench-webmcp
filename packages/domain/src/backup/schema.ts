import type { CaptionProject } from "../model";
import { MAX_PORTABLE_PROJECT_BACKUP_BYTES } from "@cuebench/contracts";
import { canonicalHash } from "../quality/hash";
import type { RoundTripResult } from "../export/round-trip";

export const PROJECT_BACKUP_SCHEMA_VERSION = 1 as const;
export const PROJECT_BACKUP_KIND = "CueBenchProjectBackup" as const;

export type BackupJsonValue = null | boolean | number | string | readonly BackupJsonValue[] | {
  readonly [key: string]: BackupJsonValue;
};

export interface BackupTrackMetadata {
  readonly itemCount: number;
  readonly hash: string;
}

/**
 * This is intentionally only portable metadata. Download Blob/object URLs,
 * source bytes, and synthetic narration are never represented here.
 */
export interface ProjectBackupExportMetadata {
  readonly projectHash: string;
  readonly sourceMediaSha256: string;
  readonly tracks: {
    readonly captions: BackupTrackMetadata;
    readonly audioDescriptions: BackupTrackMetadata;
  };
  readonly excludedArtifactPaths: readonly string[];
  readonly exportedAtMs?: number;
  readonly projectCreatedAtMs?: number;
  /** Legacy b8 v1 metadata retained only for authenticated compatibility reads. */
  readonly roundTripResult?: RoundTripResult;
  /** Legacy arbitrary metadata is read-only compatible; new exports never add it. */
  readonly additional?: Readonly<Record<string, BackupJsonValue>>;
}

export interface ProjectBackupV1 {
  readonly schemaVersion: 1;
  readonly backupKind: typeof PROJECT_BACKUP_KIND;
  readonly project: CaptionProject;
  readonly exportMetadata: ProjectBackupExportMetadata;
  /** SHA-256 over the complete portable payload excluding this field itself. */
  readonly manifestHash: string;
}

export interface ExportProjectBackupOptions {
  /** A caller-provided real export time; no clock is consulted in the domain layer. */
  readonly exportedAtMs?: number;
}

export class ProjectBackupManifestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectBackupManifestError";
  }
}

/** UTF-8 byte length of the exact compact wire representation we download. */
export const projectBackupSerializedByteLength = (backup: ProjectBackupV1): number =>
  new TextEncoder().encode(JSON.stringify(backup)).byteLength;

export const assertPortableProjectBackupByteBudget = (backup: ProjectBackupV1): void => {
  if (projectBackupSerializedByteLength(backup) > MAX_PORTABLE_PROJECT_BACKUP_BYTES) {
    throw new ProjectBackupManifestError("CueBench project backup exceeds the 10 MB portable import budget.");
  }
};

export interface LegacyProjectBackupEnvelopeV0 {
  readonly schemaVersion: 0;
  readonly project: unknown;
}

export interface NewerProjectBackupEnvelope {
  readonly schemaVersion: number;
  readonly project: unknown;
}

export type ClassifiedProjectBackupEnvelope =
  | { readonly kind: "current"; readonly backup: ProjectBackupV1 }
  | { readonly kind: "legacy"; readonly backup: LegacyProjectBackupEnvelopeV0 }
  | { readonly kind: "newer"; readonly backup: NewerProjectBackupEnvelope };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isSafeTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isCanonicalHash = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const isTrackMetadata = (value: unknown): value is BackupTrackMetadata =>
  isRecord(value)
  && hasExactKeys(value, ["itemCount", "hash"])
  && typeof value.itemCount === "number"
  && Number.isSafeInteger(value.itemCount)
  && value.itemCount >= 0
  && isCanonicalHash(value.hash);

const isRoundTripResult = (value: unknown): value is RoundTripResult => {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === true) return hasExactKeys(value, ["ok"]);
  return isRecord(value.error) && isRecord(value.firstDifference);
};

const isExportMetadata = (value: unknown): value is ProjectBackupExportMetadata => {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "projectHash",
    "sourceMediaSha256",
    "tracks",
    "excludedArtifactPaths",
    "exportedAtMs",
    "projectCreatedAtMs",
    "roundTripResult",
    "additional",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!isCanonicalHash(value.projectHash) || typeof value.sourceMediaSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sourceMediaSha256)) {
    return false;
  }
  if (!isRecord(value.tracks)
    || !hasExactKeys(value.tracks, ["captions", "audioDescriptions"])
    || !isTrackMetadata(value.tracks.captions)
    || !isTrackMetadata(value.tracks.audioDescriptions)
    || !Array.isArray(value.excludedArtifactPaths)
    || value.excludedArtifactPaths.some((path) => typeof path !== "string")) return false;
  if (value.exportedAtMs !== undefined && !isSafeTimestamp(value.exportedAtMs)) return false;
  if (value.projectCreatedAtMs !== undefined && !isSafeTimestamp(value.projectCreatedAtMs)) return false;
  if (value.roundTripResult !== undefined && !isRoundTripResult(value.roundTripResult)) return false;
  return value.additional === undefined || isRecord(value.additional);
};

const isBlob = (value: unknown): boolean => typeof Blob !== "undefined" && value instanceof Blob;

const isBinaryPayload = (value: unknown): boolean =>
  isBlob(value)
  || (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer)
  || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value));

/**
 * These are old UI-only fields, never members of CaptionProject. They are
 * deliberately recognized only at the aggregate root so a quality-profile
 * rule named e.g. `blob` is not silently erased from a backup.
 */
const rootArtifactKey = (key: string): boolean => {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return normalized === "objecturl"
    || normalized === "sourcevideo"
    || normalized === "sourcevideofile"
    || normalized === "sourceblob"
    || normalized === "mediablob"
    || normalized === "narrationaudio"
    || normalized === "narrationblob"
    || normalized === "narrationpreview"
    || normalized === "narrationurl"
    || normalized === "narrationobjecturl"
    || /^narration(?:audio|blob|preview|url|objecturl)?$/.test(normalized);
};

const isMediaDataUri = (value: string): boolean => /^data:(?:video|audio)\//i.test(value);

const assertPortableManifestValue = (
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): void => {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectBackupManifestError(`Portable backup value at ${path} is not finite.`);
    return;
  }
  if (typeof value === "string") {
    if (/^blob:/i.test(value) || isMediaDataUri(value)) {
      throw new ProjectBackupManifestError(`Portable backup cannot retain media URL data at ${path}.`);
    }
    return;
  }
  if (isBinaryPayload(value)) throw new ProjectBackupManifestError(`Portable backup cannot retain binary media data at ${path}.`);
  if (typeof value !== "object" || value === undefined) {
    throw new ProjectBackupManifestError(`Portable backup value at ${path} is not JSON-compatible.`);
  }
  if (ancestors.has(value)) throw new ProjectBackupManifestError(`Portable backup cannot contain a cyclic value at ${path}.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortableManifestValue(entry, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProjectBackupManifestError(`Portable backup value at ${path} must be a plain object.`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (path === "project" && rootArtifactKey(key)) {
        throw new ProjectBackupManifestError(`Portable backup cannot retain legacy media artifact ${path}.${key}.`);
      }
      assertPortableManifestValue(entry, path.length === 0 ? key : `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
};

const timestamp = (value: number | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer timestamp.`);
  return value;
};

/**
 * Preserves the aggregate exactly except known legacy UI media fields at its
 * root. A hidden binary/media value is rejected rather than quietly deleting
 * legitimate project data from the portable history.
 */
const sanitizeForBackup = (value: unknown, path: string, excluded: string[]): BackupJsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`Backup cannot serialize non-finite number at ${path}.`);
    if (typeof value === "string" && (/^blob:/i.test(value) || isMediaDataUri(value))) {
      throw new TypeError(`Backup cannot retain media URL data at ${path}.`);
    }
    return value;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Backup value at ${path} is not JSON-compatible.`);
  }
  if (isBinaryPayload(value)) {
    throw new TypeError(`Backup cannot retain binary media data at ${path}.`);
  }
  if (Array.isArray(value)) {
    const result: BackupJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(sanitizeForBackup(value[index], `${path}[${index}]`, excluded));
    }
    return result;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`Backup value at ${path} must be a plain JSON object.`);
  }
  const result: Record<string, BackupJsonValue> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (path === "project" && rootArtifactKey(key)) {
      excluded.push(childPath);
      continue;
    }
    result[key] = sanitizeForBackup(childValue, childPath, excluded);
  }
  return result;
};

const sanitizedRecord = (value: unknown, path: string, excluded: string[]): Readonly<Record<string, BackupJsonValue>> => {
  const sanitized = sanitizeForBackup(value, path, excluded);
  if (Array.isArray(sanitized) || !isRecord(sanitized)) {
    throw new TypeError(`${path || "Backup value"} must be a portable object.`);
  }
  return sanitized;
};

const payloadForHash = (backup: Omit<ProjectBackupV1, "manifestHash">): Omit<ProjectBackupV1, "manifestHash"> => ({
  schemaVersion: backup.schemaVersion,
  backupKind: backup.backupKind,
  project: backup.project,
  exportMetadata: backup.exportMetadata,
});

export const projectBackupManifestHash = (backup: Omit<ProjectBackupV1, "manifestHash">): string =>
  canonicalHash("cuebench.project-backup.v1", payloadForHash(backup));

const backupSlug = (title: string): string => {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return compact.length > 0 ? compact : "cuebench-project";
};

/** Portable project backups are deliberately distinct from timed-text exports. */
export const buildProjectBackupFilename = (title: string): string => `${backupSlug(title)}.cuebench.json`;

/**
 * Produces only a serializable manifest. The mutable aggregate already holds
 * immutable revisions, validation findings, evidence provenance, profiles,
 * Court Record, certifications, and their hashes, so none are flattened or
 * recomputed here.
 */
export const exportProjectBackup = (
  project: CaptionProject,
  options: ExportProjectBackupOptions = {},
): ProjectBackupV1 => {
  const excluded: string[] = [];
  const portableProject = sanitizedRecord(project, "project", excluded) as unknown as CaptionProject;
  const projectCreatedAtMs = timestamp(project.createdAtMs, "Project creation timestamp");
  const exportedAtMs = timestamp(options.exportedAtMs, "Export timestamp");
  const metadata: ProjectBackupExportMetadata = {
    projectHash: canonicalHash("cuebench.project-backup.project.v1", portableProject),
    sourceMediaSha256: portableProject.media.sha256,
    tracks: {
      captions: {
        itemCount: portableProject.captions.order.length,
        hash: canonicalHash("cuebench.project-backup.captions.v1", portableProject.captions),
      },
      audioDescriptions: {
        itemCount: portableProject.audioDescriptions.order.length,
        hash: canonicalHash("cuebench.project-backup.audio-descriptions.v1", portableProject.audioDescriptions),
      },
    },
    excludedArtifactPaths: [...new Set(excluded)].sort(),
    ...(exportedAtMs === undefined ? {} : { exportedAtMs }),
    ...(projectCreatedAtMs === undefined ? {} : { projectCreatedAtMs }),
  };
  const payload: Omit<ProjectBackupV1, "manifestHash"> = {
    schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
    backupKind: PROJECT_BACKUP_KIND,
    project: portableProject,
    exportMetadata: metadata,
  };
  const backup = { ...payload, manifestHash: projectBackupManifestHash(payload) };
  assertPortableProjectBackupByteBudget(backup);
  return backup;
};

/** Returns true only for the complete, integrity-checked v1 portable manifest. */
export const isProjectBackupV1 = (value: unknown): value is ProjectBackupV1 => {
  try {
    verifyProjectBackupManifest(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates every required v1 manifest field before any project migration can
 * inspect it. A v1-shaped object missing a field is never reclassified as a
 * legacy input: legacy migration is explicitly schemaVersion 0 only.
 */
export const verifyProjectBackupManifest = (value: unknown): ProjectBackupV1 => {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "backupKind", "project", "exportMetadata", "manifestHash"])
    || value.schemaVersion !== PROJECT_BACKUP_SCHEMA_VERSION
    || value.backupKind !== PROJECT_BACKUP_KIND
    || !isRecord(value.project)
    || !isExportMetadata(value.exportMetadata)
    || !isCanonicalHash(value.manifestHash)) {
    throw new ProjectBackupManifestError("CueBenchProjectBackup v1 requires a complete, strict manifest.");
  }
  const backup = value as unknown as ProjectBackupV1;
  assertPortableProjectBackupByteBudget(backup);
  assertPortableManifestValue(backup.project, "project");
  assertPortableManifestValue(backup.exportMetadata, "exportMetadata");
  if (
    backup.exportMetadata.projectHash !== canonicalHash("cuebench.project-backup.project.v1", backup.project)
    || backup.exportMetadata.sourceMediaSha256 !== backup.project.media.sha256
    || backup.exportMetadata.tracks.captions.itemCount !== backup.project.captions.order.length
    || backup.exportMetadata.tracks.captions.hash !== canonicalHash("cuebench.project-backup.captions.v1", backup.project.captions)
    || backup.exportMetadata.tracks.audioDescriptions.itemCount !== backup.project.audioDescriptions.order.length
    || backup.exportMetadata.tracks.audioDescriptions.hash !== canonicalHash("cuebench.project-backup.audio-descriptions.v1", backup.project.audioDescriptions)
  ) {
    throw new ProjectBackupManifestError("Project backup manifest export metadata does not bind its portable project payload.");
  }
  const expected = projectBackupManifestHash({
    schemaVersion: backup.schemaVersion,
    backupKind: backup.backupKind,
    project: backup.project,
    exportMetadata: backup.exportMetadata,
  });
  if (backup.manifestHash !== expected) {
    throw new ProjectBackupManifestError("Project backup manifest hash does not match its portable contents.");
  }
  return structuredClone(backup);
};

export const classifyProjectBackupEnvelope = (value: unknown): ClassifiedProjectBackupEnvelope => {
  if (!isRecord(value) || !Object.hasOwn(value, "schemaVersion") || !Number.isSafeInteger(value.schemaVersion) || typeof value.schemaVersion !== "number") {
    throw new ProjectBackupManifestError("A project backup requires an integer schemaVersion.");
  }
  if (value.schemaVersion === PROJECT_BACKUP_SCHEMA_VERSION) {
    return { kind: "current", backup: verifyProjectBackupManifest(value) };
  }
  if (value.schemaVersion === 0) {
    if (!hasExactKeys(value, ["schemaVersion", "project"])) {
      throw new ProjectBackupManifestError("Legacy project migration inputs must be explicit schemaVersion 0 envelopes.");
    }
    return { kind: "legacy", backup: structuredClone(value as unknown as LegacyProjectBackupEnvelopeV0) };
  }
  if (value.schemaVersion > PROJECT_BACKUP_SCHEMA_VERSION) {
    if (!Object.hasOwn(value, "project")) {
      throw new ProjectBackupManifestError("A newer project backup requires a project payload for read-only preview.");
    }
    return { kind: "newer", backup: structuredClone(value as unknown as NewerProjectBackupEnvelope) };
  }
  throw new ProjectBackupManifestError(`Unsupported project backup schema v${value.schemaVersion}.`);
};
