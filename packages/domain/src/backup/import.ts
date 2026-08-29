import type { Actor } from "@cuebench/contracts";
import { domainError, type DomainError } from "../errors";
import type { CaptionProject } from "../model";
import {
  exportProjectBackup,
  isProjectBackupV1,
  PROJECT_BACKUP_SCHEMA_VERSION,
  projectBackupManifestHash,
  type ProjectBackupV1,
} from "./schema";

export interface MediaRelinkCandidate {
  readonly sourceId: string;
  readonly sha256: string;
  readonly durationMs: number;
}

export interface MigrationPreview {
  readonly mode: "preview";
  readonly requiresHumanConfirmation: true;
  readonly schemaVersion: number;
  readonly migratedFrom: number | null;
  readonly project: CaptionProject;
}

export interface MigrationReadOnlyPreview {
  readonly mode: "read-only";
  readonly readOnly: true;
  readonly schemaVersion: number;
  readonly reason: "NEWER_SCHEMA";
  readonly project: unknown;
}

export type ImportMigrationPreview = MigrationPreview | MigrationReadOnlyPreview;
export type ImportPreviewMigration = (value: unknown) => ImportMigrationPreview;

export interface ImportSafetyBackup {
  readonly required: true;
  readonly projectId: string | null;
  /** Present only when an existing selected project can be backed up now. */
  readonly backup: ProjectBackupV1 | null;
  readonly reason: "REPLACE_PROJECT" | "MIGRATION" | "IMPORT";
}

export interface MediaRelinkRequired {
  readonly status: "required";
  readonly expectedSha256: string;
}

export interface MediaRelinkVerified {
  readonly status: "verified";
  readonly expectedSha256: string;
  readonly actualSha256: string;
}

export interface MediaRelinkMismatch {
  readonly status: "mismatch";
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly error: DomainError;
}

export type MediaRelinkPreview = MediaRelinkRequired | MediaRelinkVerified | MediaRelinkMismatch;

export interface ProjectImportPreview {
  readonly mode: "preview";
  readonly readOnly: false;
  readonly requiresHumanConfirmation: true;
  readonly requiresSafetyBackup: true;
  readonly safetyBackup: ImportSafetyBackup;
  readonly schemaVersion: number;
  readonly migratedFrom: number | null;
  readonly project: CaptionProject;
  readonly mediaRelink: MediaRelinkPreview;
  readonly canImport: boolean;
}

export interface ReadOnlyProjectImportPreview {
  readonly mode: "read-only";
  readonly readOnly: true;
  readonly requiresHumanConfirmation: true;
  readonly requiresSafetyBackup: false;
  readonly safetyBackup: null;
  readonly schemaVersion: number;
  readonly reason: "NEWER_SCHEMA";
  readonly project: unknown;
  readonly canImport: false;
}

export type ProjectImportDescriptor = ProjectImportPreview | ReadOnlyProjectImportPreview;

export interface PreviewProjectImportOptions {
  /** When supplied, import previews enforce the same human-only boundary as the UI. */
  readonly actor?: Actor;
  /** Existing project selected for replacement. Its portable safety backup is returned, never written here. */
  readonly replaceProject?: CaptionProject;
  readonly relinkedMedia?: MediaRelinkCandidate;
  /**
   * Inject storage's `describeImportedProject` / `migrateImportedProject`
   * here. Domain deliberately owns no runtime dependency on storage, avoiding
   * the storage -> domain package cycle.
   */
  readonly migration?: ImportPreviewMigration;
  /** Alias retained for adapters that name the callback after the operation. */
  readonly migrate?: ImportPreviewMigration;
}

export class BackupImportError extends Error {
  public readonly error: DomainError;

  public constructor(code: DomainError["code"], message: string) {
    super(message);
    this.name = "BackupImportError";
    this.error = domainError(code, message);
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalSha256 = (value: string): string => value.toLowerCase();
const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value);
const validDuration = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const staleDerivedArtifacts = (project: CaptionProject): CaptionProject => ({
  ...structuredClone(project),
  media: { ...project.media, relinkState: "Missing" },
  validation: project.validation.status === "NotRun"
    ? project.validation
    : { ...project.validation, status: "Stale" },
  certification: project.certification.status === "NotCertified"
    ? project.certification
    : { ...project.certification, status: "Stale" },
});

const basicPreview = (value: unknown): ImportMigrationPreview => {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion) || typeof value.schemaVersion !== "number") {
    throw new BackupImportError("INVALID_ARGUMENT", "A project backup requires an integer schemaVersion.");
  }
  if (value.schemaVersion > PROJECT_BACKUP_SCHEMA_VERSION) {
    return {
      mode: "read-only",
      readOnly: true,
      schemaVersion: value.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: value.project,
    };
  }
  if (value.schemaVersion !== PROJECT_BACKUP_SCHEMA_VERSION || !isRecord(value.project)) {
    throw new BackupImportError("BACKUP_SCHEMA_UNSUPPORTED", `No domain preview migration exists for backup schema v${value.schemaVersion}.`);
  }
  const project = value.project as unknown as CaptionProject;
  if (!isRecord(project.media) || typeof project.media.sha256 !== "string" || !isSha256(project.media.sha256)) {
    throw new BackupImportError("INVALID_ARGUMENT", "Backup project media must record a SHA-256 hash for Media Relink.");
  }
  return {
    mode: "preview",
    requiresHumanConfirmation: true,
    schemaVersion: value.schemaVersion,
    migratedFrom: null,
    project: staleDerivedArtifacts(project),
  };
};

const assertManifest = (value: unknown): void => {
  if (!isProjectBackupV1(value)) return;
  const expected = projectBackupManifestHash({
    schemaVersion: value.schemaVersion,
    backupKind: value.backupKind,
    project: value.project,
    exportMetadata: value.exportMetadata,
  });
  if (value.manifestHash !== expected) {
    throw new BackupImportError("INVALID_ARGUMENT", "Project backup manifest hash does not match its portable contents.");
  }
};

export const verifyMediaRelink = (
  expectedSha256: string,
  candidate: MediaRelinkCandidate,
): MediaRelinkVerified | MediaRelinkMismatch => {
  if (!isSha256(expectedSha256) || !isSha256(candidate.sha256) || !validDuration(candidate.durationMs) || candidate.sourceId.trim().length === 0) {
    throw new BackupImportError("INVALID_ARGUMENT", "Media Relink requires a source id, canonical duration, and SHA-256 hash.");
  }
  const expected = normalSha256(expectedSha256);
  const actual = normalSha256(candidate.sha256);
  if (actual !== expected) {
    return {
      status: "mismatch",
      expectedSha256: expected,
      actualSha256: actual,
      error: domainError("MEDIA_HASH_MISMATCH", "The selected media does not match the SHA-256 recorded by this project backup."),
    };
  }
  return { status: "verified", expectedSha256: expected, actualSha256: actual };
};

const optionsFor = (
  options: PreviewProjectImportOptions | ImportPreviewMigration | undefined,
): PreviewProjectImportOptions => typeof options === "function" ? { migration: options } : options ?? {};

/**
 * Pure import preflight. It never writes Dexie, never performs a relink
 * command, and never downgrades a newer schema. The UI/storage adapter must
 * persist the returned safety backup and obtain human confirmation before it
 * writes a previewed aggregate.
 */
export const previewProjectImport = (
  value: unknown,
  options?: PreviewProjectImportOptions | ImportPreviewMigration,
): ProjectImportDescriptor => {
  const resolved = optionsFor(options);
  if (resolved.actor !== undefined && resolved.actor.type !== "Human") {
    throw new BackupImportError("HUMAN_AUTHORITY_REQUIRED", "Only a human may import a project backup.");
  }
  assertManifest(value);
  const migration = resolved.migration ?? resolved.migrate ?? basicPreview;
  let migrated: ImportMigrationPreview;
  try {
    migrated = migration(value);
  } catch (error) {
    if (error instanceof BackupImportError) throw error;
    throw new BackupImportError("BACKUP_SCHEMA_UNSUPPORTED", error instanceof Error ? error.message : "Project backup migration failed.");
  }
  if (migrated.mode === "read-only") {
    return {
      mode: "read-only",
      readOnly: true,
      requiresHumanConfirmation: true,
      requiresSafetyBackup: false,
      safetyBackup: null,
      schemaVersion: migrated.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: migrated.project,
      canImport: false,
    };
  }

  const project = staleDerivedArtifacts(migrated.project);
  const expectedSha256 = normalSha256(project.media.sha256);
  const relink = resolved.relinkedMedia === undefined
    ? { status: "required" as const, expectedSha256 }
    : verifyMediaRelink(expectedSha256, resolved.relinkedMedia);
  const relinkedProject = relink.status === "verified" && resolved.relinkedMedia !== undefined
    ? {
      ...project,
      media: {
        sourceId: resolved.relinkedMedia.sourceId,
        sha256: relink.actualSha256,
        durationMs: resolved.relinkedMedia.durationMs,
        relinkState: "Linked" as const,
      },
    }
    : project;
  const reason = resolved.replaceProject !== undefined
    ? "REPLACE_PROJECT" as const
    : migrated.migratedFrom !== null
      ? "MIGRATION" as const
      : "IMPORT" as const;
  return {
    mode: "preview",
    readOnly: false,
    requiresHumanConfirmation: true,
    requiresSafetyBackup: true,
    safetyBackup: {
      required: true,
      projectId: resolved.replaceProject?.projectId ?? null,
      backup: resolved.replaceProject === undefined ? null : exportProjectBackup(resolved.replaceProject),
      reason,
    },
    schemaVersion: migrated.schemaVersion,
    migratedFrom: migrated.migratedFrom,
    project: relinkedProject,
    mediaRelink: relink,
    canImport: relink.status === "verified",
  };
};
