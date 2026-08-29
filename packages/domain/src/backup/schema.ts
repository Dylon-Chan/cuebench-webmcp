import type { CaptionProject } from "../model";
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
  readonly roundTripResult?: RoundTripResult;
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
  /** Project-creation time retained by the browser persistence layer, when available. */
  readonly projectCreatedAtMs?: number;
  readonly roundTripResult?: RoundTripResult;
  readonly additionalExportMetadata?: Readonly<Record<string, unknown>>;
}

const OMIT = Symbol("cuebench-backup-omit");
type Sanitized = BackupJsonValue | typeof OMIT;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBlob = (value: unknown): boolean => typeof Blob !== "undefined" && value instanceof Blob;

const artifactKey = (key: string): boolean => {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return normalized === "objecturl"
    || normalized === "sourcevideo"
    || normalized === "sourcevideofile"
    || normalized === "sourceblob"
    || normalized === "mediablob"
    || normalized === "blob"
    || normalized.endsWith("blob")
    || /^narration(?:audio|blob|preview|url|objecturl)?$/.test(normalized);
};

const timestamp = (value: number | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer timestamp.`);
  return value;
};

/**
 * Removes non-portable artifacts recursively. Paths are retained in metadata
 * so a restore preview can truthfully explain why media/narration is absent.
 */
const sanitizeForBackup = (value: unknown, path: string, excluded: string[]): Sanitized => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`Backup cannot serialize non-finite number at ${path}.`);
    if (typeof value === "string" && value.startsWith("blob:")) {
      excluded.push(path);
      return OMIT;
    }
    return value;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    excluded.push(path);
    return OMIT;
  }
  if (isBlob(value)) {
    excluded.push(path);
    return OMIT;
  }
  if (Array.isArray(value)) {
    const result: BackupJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = sanitizeForBackup(value[index], `${path}[${index}]`, excluded);
      if (child !== OMIT) result.push(child);
    }
    return result;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    excluded.push(path);
    return OMIT;
  }
  const result: Record<string, BackupJsonValue> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (artifactKey(key)) {
      excluded.push(childPath);
      continue;
    }
    const child = sanitizeForBackup(childValue, childPath, excluded);
    if (child !== OMIT) result[key] = child;
  }
  return result;
};

const sanitizedRecord = (value: unknown, path: string, excluded: string[]): Readonly<Record<string, BackupJsonValue>> => {
  const sanitized = sanitizeForBackup(value, path, excluded);
  if (sanitized === OMIT || Array.isArray(sanitized) || !isRecord(sanitized)) {
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
  const additional = options.additionalExportMetadata === undefined
    ? undefined
    : sanitizedRecord(options.additionalExportMetadata, "exportMetadata.additional", excluded);
  const projectCreatedAtMs = timestamp(
    options.projectCreatedAtMs ?? project.createdAtMs,
    "Project creation timestamp",
  );
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
    ...(options.roundTripResult === undefined ? {} : { roundTripResult: structuredClone(options.roundTripResult) }),
    ...(additional === undefined ? {} : { additional }),
  };
  const payload: Omit<ProjectBackupV1, "manifestHash"> = {
    schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
    backupKind: PROJECT_BACKUP_KIND,
    project: portableProject,
    exportMetadata: metadata,
  };
  return { ...payload, manifestHash: projectBackupManifestHash(payload) };
};

export const isProjectBackupV1 = (value: unknown): value is ProjectBackupV1 => {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_BACKUP_SCHEMA_VERSION || value.backupKind !== PROJECT_BACKUP_KIND) return false;
  return isRecord(value.project) && isRecord(value.exportMetadata) && typeof value.manifestHash === "string";
};
