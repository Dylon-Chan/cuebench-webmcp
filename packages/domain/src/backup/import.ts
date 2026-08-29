import type { Actor } from "@cuebench/contracts";
import { domainError, type DomainError } from "../errors";
import type { CaptionProject } from "../model";
import { canonicalHash } from "../quality/hash";
import { CaptionProjectAggregateError, validateCaptionProjectAggregate } from "./aggregate";
import {
  classifyProjectBackupEnvelope,
  exportProjectBackup,
  ProjectBackupManifestError,
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
  /** The input envelope is cloned before migration so recovery is exact. */
  readonly projectId: null;
  readonly originalEnvelope: unknown;
  readonly originalEnvelopeHash: string;
  readonly actor: Actor;
  readonly reason: "MIGRATION" | "IMPORT";
}

/** A replacement target is protected independently from the incoming envelope. */
export interface ReplacementProjectSafetyBackup {
  readonly projectId: string;
  readonly backup: ProjectBackupV1;
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
  readonly replacementSafetyBackup: ReplacementProjectSafetyBackup | null;
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
  readonly replacementSafetyBackup: null;
  readonly schemaVersion: number;
  readonly reason: "NEWER_SCHEMA";
  readonly project: unknown;
  readonly canImport: false;
}

export type ProjectImportDescriptor = ProjectImportPreview | ReadOnlyProjectImportPreview;

export interface PreviewProjectImportOptions {
  /** Explicit provenance is required at the public import boundary. */
  readonly actor: Actor;
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
  const envelope = classifyProjectBackupEnvelope(value);
  if (envelope.kind === "newer") {
    return {
      mode: "read-only",
      readOnly: true,
      schemaVersion: envelope.backup.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: envelope.backup.project,
    };
  }
  if (envelope.kind === "legacy") {
    throw new BackupImportError("BACKUP_SCHEMA_UNSUPPORTED", "A legacy project backup requires the explicit storage migration preview.");
  }
  const project = validateCaptionProjectAggregate(envelope.backup.project);
  if (!isRecord(project.media) || typeof project.media.sha256 !== "string" || !isSha256(project.media.sha256)) {
    throw new BackupImportError("INVALID_ARGUMENT", "Backup project media must record a SHA-256 hash for Media Relink.");
  }
  return {
    mode: "preview",
    requiresHumanConfirmation: true,
    schemaVersion: envelope.backup.schemaVersion,
    migratedFrom: null,
    project: staleDerivedArtifacts(project),
  };
};

const cloneIncomingEnvelope = (value: unknown, actor: Actor, reason: ImportSafetyBackup["reason"]): ImportSafetyBackup => {
  let originalEnvelope: unknown;
  try {
    originalEnvelope = structuredClone(value);
  } catch {
    throw new BackupImportError("INVALID_ARGUMENT", "A project import envelope must be safely cloneable before migration.");
  }
  return {
    required: true,
    projectId: null,
    originalEnvelope,
    originalEnvelopeHash: canonicalHash("cuebench.import.original-envelope.v1", originalEnvelope),
    actor: structuredClone(actor),
    reason,
  };
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

const requireHumanProvenance = (options: PreviewProjectImportOptions | undefined): Actor => {
  const actor = options?.actor;
  if (actor === undefined || actor.type !== "Human" || typeof actor.id !== "string" || actor.id.trim().length === 0 || actor.id.trim() !== actor.id) {
    throw new BackupImportError("HUMAN_AUTHORITY_REQUIRED", "A named Human actor is required to preview a project import.");
  }
  return actor;
};

/**
 * Pure import preflight. It never writes Dexie, never performs a relink
 * command, and never downgrades a newer schema. The UI/storage adapter must
 * persist the returned safety backup and obtain human confirmation before it
 * writes a previewed aggregate.
 */
export const previewProjectImport = (
  value: unknown,
  options: PreviewProjectImportOptions,
): ProjectImportDescriptor => {
  const actor = requireHumanProvenance(options);
  let envelope;
  try {
    envelope = classifyProjectBackupEnvelope(value);
  } catch (error) {
    if (error instanceof ProjectBackupManifestError) {
      throw new BackupImportError("BACKUP_SCHEMA_UNSUPPORTED", error.message);
    }
    throw error;
  }
  if (envelope.kind === "newer") {
    return {
      mode: "read-only",
      readOnly: true,
      requiresHumanConfirmation: true,
      requiresSafetyBackup: false,
      safetyBackup: null,
      replacementSafetyBackup: null,
      schemaVersion: envelope.backup.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: envelope.backup.project,
      canImport: false,
    };
  }
  /** ADR-0019: capture the exact source before any migration can transform it. */
  const safetyBackup = cloneIncomingEnvelope(
    value,
    actor,
    envelope.kind === "legacy" ? "MIGRATION" : "IMPORT",
  );
  const migration = options.migration ?? options.migrate ?? basicPreview;
  let migrated: ImportMigrationPreview;
  try {
    migrated = migration(value);
  } catch (error) {
    if (error instanceof BackupImportError) throw error;
    if (error instanceof CaptionProjectAggregateError) {
      throw new BackupImportError("INVALID_ARGUMENT", error.message);
    }
    throw new BackupImportError("BACKUP_SCHEMA_UNSUPPORTED", error instanceof Error ? error.message : "Project backup migration failed.");
  }
  if (migrated.mode === "read-only") {
    return {
      mode: "read-only",
      readOnly: true,
      requiresHumanConfirmation: true,
      requiresSafetyBackup: false,
      safetyBackup: null,
      replacementSafetyBackup: null,
      schemaVersion: migrated.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: migrated.project,
      canImport: false,
    };
  }

  let checkedProject: CaptionProject;
  try {
    /** A custom storage migration is never a substitute for the public aggregate proof. */
    checkedProject = validateCaptionProjectAggregate(migrated.project);
  } catch (error) {
    if (error instanceof CaptionProjectAggregateError) {
      throw new BackupImportError("INVALID_ARGUMENT", error.message);
    }
    throw error;
  }
  const project = validateCaptionProjectAggregate(staleDerivedArtifacts(checkedProject));
  const expectedSha256 = normalSha256(project.media.sha256);
  const relink = options.relinkedMedia === undefined
    ? { status: "required" as const, expectedSha256 }
    : verifyMediaRelink(expectedSha256, options.relinkedMedia);
  const relinkedProject = relink.status === "verified" && options.relinkedMedia !== undefined
    ? {
      ...project,
      media: {
        sourceId: options.relinkedMedia.sourceId,
        sha256: relink.actualSha256,
        durationMs: options.relinkedMedia.durationMs,
        relinkState: "Linked" as const,
      },
    }
    : project;
  let validatedRelinkedProject: CaptionProject;
  try {
    /** Mirrors RelinkMedia's all-revision/gap timing invariant before canImport becomes true. */
    validatedRelinkedProject = validateCaptionProjectAggregate(relinkedProject);
  } catch (error) {
    if (error instanceof CaptionProjectAggregateError) {
      throw new BackupImportError("INVALID_ARGUMENT", error.message);
    }
    throw error;
  }
  return {
    mode: "preview",
    readOnly: false,
    requiresHumanConfirmation: true,
    requiresSafetyBackup: true,
    safetyBackup,
    replacementSafetyBackup: options.replaceProject === undefined
      ? null
      : { projectId: options.replaceProject.projectId, backup: exportProjectBackup(options.replaceProject) },
    schemaVersion: migrated.schemaVersion,
    migratedFrom: migrated.migratedFrom,
    project: validatedRelinkedProject,
    mediaRelink: relink,
    canImport: relink.status === "verified",
  };
};
