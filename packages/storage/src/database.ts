import Dexie, { type Table } from "dexie";
import {
  ActorSchema,
  CertificationSnapshotSchema,
  IdentifierSchema,
  MediaSourceSnapshotSchema,
  ReviewStateSchema,
  ValidationSnapshotSchema,
} from "@cuebench/contracts";
import type {
  AudioDescriptionBeat,
  AudioDescriptionBeatRevision,
  AudioDescriptionGap,
  CaptionCue,
  CaptionCueRevision,
  CaptionProject,
  DomainEvent,
  EvidenceProvenance,
  GenerationLease,
  ProjectCertification,
  QualityProfile,
  Selection,
  WarningWaiver,
} from "@cuebench/domain";
import type {
  QualityFinding,
  ValidationRun,
} from "@cuebench/domain";
import { z } from "zod";

export const STORAGE_SCHEMA_VERSION = 1 as const;

const clone = <Value>(value: Value): Value => structuredClone(value);

const positiveSafeInteger = z.number().int().refine(Number.isSafeInteger).positive();
const nonNegativeSafeInteger = z.number().int().refine(Number.isSafeInteger).nonnegative();
const nonEmptyText = z.string().trim().min(1);
const sha256 = z.string().trim().regex(/^[0-9a-f]{64}$/i);
const unknownRecord = z.record(z.string(), z.unknown());

const ReviewStateStorageSchema = ReviewStateSchema;

const CaptionCueRevisionSchema = z.object({
  itemId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
  state: ReviewStateStorageSchema,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  actor: ActorSchema,
  cause: nonEmptyText,
  parentItemRevision: positiveSafeInteger.nullable(),
  kind: z.literal("CaptionCue"),
  text: z.string().min(1).max(1_000).refine((value) => value.trim().length > 0),
  speaker: z.string().min(1).max(200).refine((value) => value.trim().length > 0).nullable(),
}).strict().refine((revision) => revision.endMs > revision.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});

const AudioDescriptionBeatRevisionSchema = z.object({
  itemId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
  state: ReviewStateStorageSchema,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  actor: ActorSchema,
  cause: nonEmptyText,
  parentItemRevision: positiveSafeInteger.nullable(),
  kind: z.literal("AudioDescriptionBeat"),
  description: z.string().min(1).max(1_000).refine((value) => value.trim().length > 0),
}).strict().refine((revision) => revision.endMs > revision.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});

const RevisionSchema = z.discriminatedUnion("kind", [
  CaptionCueRevisionSchema,
  AudioDescriptionBeatRevisionSchema,
]);

const CaptionCueSchema = z.object({
  itemId: IdentifierSchema,
  kind: z.literal("CaptionCue"),
  revisions: z.array(CaptionCueRevisionSchema).min(1),
  current: CaptionCueRevisionSchema,
  mergedIntoItemId: IdentifierSchema.nullable(),
}).strict();

const AudioDescriptionBeatSchema = z.object({
  itemId: IdentifierSchema,
  kind: z.literal("AudioDescriptionBeat"),
  revisions: z.array(AudioDescriptionBeatRevisionSchema).min(1),
  current: AudioDescriptionBeatRevisionSchema,
}).strict();

const AudioDescriptionGapSchema = z.object({
  gapId: IdentifierSchema,
  gapRevision: positiveSafeInteger,
  state: z.enum(["Available", "Consumed"]),
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
}).strict().refine((gap) => gap.endMs > gap.startMs, {
  message: "An audio-description gap must end after it starts.",
  path: ["endMs"],
});

const ItemSelectionSchema = z.discriminatedUnion("kind", [
  z.object({
    itemId: IdentifierSchema,
    itemRevision: positiveSafeInteger,
    kind: z.literal("CaptionCue"),
  }).strict(),
  z.object({
    itemId: IdentifierSchema,
    itemRevision: positiveSafeInteger,
    kind: z.literal("AudioDescriptionBeat"),
  }).strict(),
  z.object({
    itemId: IdentifierSchema,
    itemRevision: positiveSafeInteger,
    kind: z.literal("AudioDescriptionGap"),
    state: z.literal("Available"),
  }).strict(),
]);

const QualityProfileSchema = z.object({
  profileId: IdentifierSchema,
  revision: positiveSafeInteger,
  name: nonEmptyText,
  rules: unknownRecord,
}).strict();

const WarningWaiverSchema = z.object({
  findingId: IdentifierSchema,
  reason: nonEmptyText,
  actor: ActorSchema,
  projectRevision: positiveSafeInteger,
}).strict();

const EvidenceProvenanceSchema = z.object({
  evidenceId: IdentifierSchema,
  projectId: IdentifierSchema,
  mediaSha256: sha256,
  itemId: IdentifierSchema.nullable(),
  itemRevision: positiveSafeInteger.nullable(),
}).strict().refine((evidence) => (evidence.itemId === null) === (evidence.itemRevision === null), {
  message: "Evidence item id and revision must be present together.",
});

const GenerationLeaseSchema = z.object({
  runId: IdentifierSchema,
  targetTrack: z.enum(["Captions", "AudioDescriptions"]),
  actor: ActorSchema,
}).strict();

const DomainEventSchema = z.object({
  eventId: IdentifierSchema,
  projectRevision: positiveSafeInteger,
  type: nonEmptyText,
  actor: ActorSchema,
  itemId: IdentifierSchema.optional(),
  detail: z.string().optional(),
}).strict();

const ValidationInputItemSchema = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  itemId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
  state: nonEmptyText,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  text: z.string(),
  speaker: z.string().nullable(),
  mergedIntoItemId: IdentifierSchema.nullable().optional(),
}).strict().refine((item) => item.endMs > item.startMs, {
  message: "Validation input items must end after they start.",
  path: ["endMs"],
});

const ValidationInputSchema = z.object({
  projectId: IdentifierSchema,
  projectRevision: positiveSafeInteger,
  media: MediaSourceSnapshotSchema,
  evidence: z.array(EvidenceProvenanceSchema),
  qualityProfile: QualityProfileSchema,
  captions: z.object({
    order: z.array(IdentifierSchema),
    items: z.array(ValidationInputItemSchema),
  }).strict(),
  audioDescriptions: z.object({
    order: z.array(IdentifierSchema),
    items: z.array(ValidationInputItemSchema),
  }).strict(),
  audioDescriptionGaps: z.array(AudioDescriptionGapSchema),
}).strict();

const FindingTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project"),
    projectId: IdentifierSchema,
    projectRevision: positiveSafeInteger,
  }).strict(),
  z.object({
    type: z.literal("item"),
    kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
    itemId: IdentifierSchema,
    itemRevision: positiveSafeInteger,
  }).strict(),
  z.object({
    type: z.literal("pair"),
    first: z.object({
      kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
      itemId: IdentifierSchema,
      itemRevision: positiveSafeInteger,
    }).strict(),
    second: z.object({
      kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
      itemId: IdentifierSchema,
      itemRevision: positiveSafeInteger,
    }).strict(),
  }).strict(),
]);

const QualityFindingSchema = z.object({
  id: IdentifierSchema,
  findingId: IdentifierSchema,
  ruleId: nonEmptyText,
  severity: z.enum(["blocker", "warning"]),
  message: nonEmptyText,
  target: FindingTargetSchema,
}).strict().refine((finding) => finding.id === finding.findingId, {
  message: "Finding id aliases must agree.",
});

const StoredValidationRunSchema = z.object({
  projectId: IdentifierSchema,
  projectRevision: positiveSafeInteger,
  profileId: IdentifierSchema,
  profileRevision: positiveSafeInteger,
  input: ValidationInputSchema,
  inputHash: nonEmptyText,
  blockerCount: nonNegativeSafeInteger,
  warningCount: nonNegativeSafeInteger,
}).strict();

const ValidationRunSchema = StoredValidationRunSchema.extend({
  findings: z.array(QualityFindingSchema),
  blockers: z.array(QualityFindingSchema),
  warnings: z.array(QualityFindingSchema),
}).strict().superRefine((run, context) => {
  const blockers = run.findings.filter((finding) => finding.severity === "blocker");
  const warnings = run.findings.filter((finding) => finding.severity === "warning");
  const sameIds = (left: readonly { findingId: string }[], right: readonly { findingId: string }[]) =>
    left.length === right.length && left.every((value, index) => value.findingId === right[index]?.findingId);
  if (run.blockerCount !== blockers.length || run.warningCount !== warnings.length) {
    context.addIssue({ code: "custom", message: "Validation counts do not match findings." });
  }
  if (!sameIds(run.blockers, blockers) || !sameIds(run.warnings, warnings)) {
    context.addIssue({ code: "custom", message: "Validation finding partitions do not match findings." });
  }
});

const CertificationItemRevisionSchema = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  itemId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
}).strict();

const StoredProjectCertificationSchema = z.object({
  certificationId: IdentifierSchema,
  certificationSnapshotHash: nonEmptyText,
  readinessHash: nonEmptyText,
  certifiedAtMs: positiveSafeInteger,
  actor: ActorSchema,
  media: MediaSourceSnapshotSchema,
  evidence: z.array(EvidenceProvenanceSchema),
  itemRevisions: z.array(CertificationItemRevisionSchema),
  qualityProfile: QualityProfileSchema,
  validationRun: StoredValidationRunSchema,
  warningWaivers: z.array(WarningWaiverSchema),
}).strict();

const ProjectCertificationSchema = StoredProjectCertificationSchema.extend({
  validationRun: ValidationRunSchema,
}).strict();

const CaptionProjectSchema = z.object({
  contractVersion: z.literal(1),
  projectId: IdentifierSchema,
  projectRevision: positiveSafeInteger,
  title: nonEmptyText,
  media: MediaSourceSnapshotSchema,
  evidence: z.array(EvidenceProvenanceSchema),
  captions: z.object({
    kind: z.literal("Captions"),
    order: z.array(IdentifierSchema),
    items: z.record(z.string(), CaptionCueSchema),
  }).strict(),
  audioDescriptions: z.object({
    kind: z.literal("AudioDescriptions"),
    order: z.array(IdentifierSchema),
    items: z.record(z.string(), AudioDescriptionBeatSchema),
  }).strict(),
  audioDescriptionGaps: z.record(z.string(), AudioDescriptionGapSchema),
  selectedItem: ItemSelectionSchema.nullable(),
  validation: ValidationSnapshotSchema,
  validationRun: ValidationRunSchema.nullable(),
  certification: CertificationSnapshotSchema,
  certifications: z.array(ProjectCertificationSchema),
  qualityProfile: QualityProfileSchema,
  warningWaivers: z.record(z.string(), WarningWaiverSchema),
  activeGenerationRun: GenerationLeaseSchema.nullable(),
  courtRecord: z.array(DomainEventSchema),
}).strict();

export type StoredValidationRun = Omit<ValidationRun, "findings" | "blockers" | "warnings">;

export interface StoredProjectCertification extends Omit<ProjectCertification, "validationRun"> {
  readonly validationRun: StoredValidationRun;
}

export interface ProjectHeaderRow {
  readonly projectId: string;
  readonly schemaVersion: 1;
  readonly contractVersion: 1;
  readonly projectRevision: number;
  readonly title: string;
  readonly media: CaptionProject["media"];
  readonly captionOrder: readonly string[];
  readonly audioDescriptionOrder: readonly string[];
  readonly audioDescriptionGaps: Readonly<Record<string, AudioDescriptionGap>>;
  readonly selectedItem: Selection | null;
  readonly validation: CaptionProject["validation"];
  readonly validationRun: StoredValidationRun | null;
  readonly certification: CaptionProject["certification"];
  readonly qualityProfile: QualityProfile;
  readonly warningWaivers: Readonly<Record<string, WarningWaiver>>;
  readonly activeGenerationRun: GenerationLease | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ItemRow {
  readonly key: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly kind: "CaptionCue" | "AudioDescriptionBeat";
  readonly currentItemRevision: number;
  readonly mergedIntoItemId: string | null;
}

export interface RevisionRow {
  readonly key: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemRevision: number;
  readonly kind: "CaptionCue" | "AudioDescriptionBeat";
  readonly revision: CaptionCueRevision | AudioDescriptionBeatRevision;
}

export interface FindingRow {
  readonly key: string;
  readonly projectId: string;
  readonly scope: string;
  readonly findingId: string;
  readonly finding: QualityFinding;
}

export interface EvidenceRow {
  readonly key: string;
  readonly projectId: string;
  readonly evidenceId: string;
  readonly sequence: number;
  readonly evidence: EvidenceProvenance;
}

export interface CourtRecordRow {
  readonly key: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly event: DomainEvent;
}

export interface CertificationRow {
  readonly key: string;
  readonly projectId: string;
  readonly certificationId: string;
  readonly sequence: number;
  readonly certification: StoredProjectCertification;
}

export interface SourceBlobRow {
  readonly key: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly sha256: string;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly contentType: string;
  readonly fileName: string | null;
  readonly savedAtMs: number;
}

export interface NarrationBlobRow {
  readonly key: string;
  readonly projectId: string;
  readonly beatId: string;
  readonly itemRevision: number;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly contentType: string;
  readonly savedAtMs: number;
}

export interface RunReceiptRow {
  readonly key: string;
  readonly projectId: string;
  readonly runId: string;
  /** Opaque signed recovery data. Project content never belongs in this row. */
  readonly receipt: unknown;
  readonly savedAtMs: number;
}

export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAtMs: number;
}

const ProjectHeaderRowSchema = z.object({
  projectId: IdentifierSchema,
  schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  contractVersion: z.literal(1),
  projectRevision: positiveSafeInteger,
  title: nonEmptyText,
  media: MediaSourceSnapshotSchema,
  captionOrder: z.array(IdentifierSchema),
  audioDescriptionOrder: z.array(IdentifierSchema),
  audioDescriptionGaps: z.record(z.string(), AudioDescriptionGapSchema),
  selectedItem: ItemSelectionSchema.nullable(),
  validation: ValidationSnapshotSchema,
  validationRun: StoredValidationRunSchema.nullable(),
  certification: CertificationSnapshotSchema,
  qualityProfile: QualityProfileSchema,
  warningWaivers: z.record(z.string(), WarningWaiverSchema),
  activeGenerationRun: GenerationLeaseSchema.nullable(),
  createdAtMs: nonNegativeSafeInteger,
  updatedAtMs: nonNegativeSafeInteger,
}).strict();

const ItemRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  itemId: IdentifierSchema,
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  currentItemRevision: positiveSafeInteger,
  mergedIntoItemId: IdentifierSchema.nullable(),
}).strict();

const RevisionRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  itemId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  revision: RevisionSchema,
}).strict();

const FindingRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  scope: nonEmptyText,
  findingId: IdentifierSchema,
  finding: QualityFindingSchema,
}).strict();

const EvidenceRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  evidenceId: IdentifierSchema,
  sequence: nonNegativeSafeInteger,
  evidence: EvidenceProvenanceSchema,
}).strict();

const CourtRecordRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  eventId: IdentifierSchema,
  sequence: nonNegativeSafeInteger,
  event: DomainEventSchema,
}).strict();

const CertificationRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  certificationId: IdentifierSchema,
  sequence: nonNegativeSafeInteger,
  certification: StoredProjectCertificationSchema,
}).strict();

const blobSchema = z.custom<Blob>((value) => typeof Blob !== "undefined" && value instanceof Blob, {
  message: "Expected a Blob.",
});

const SourceBlobRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  sourceId: IdentifierSchema,
  sha256,
  blob: blobSchema,
  byteLength: nonNegativeSafeInteger,
  contentType: z.string(),
  fileName: z.string().nullable(),
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const NarrationBlobRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  beatId: IdentifierSchema,
  itemRevision: positiveSafeInteger,
  blob: blobSchema,
  byteLength: nonNegativeSafeInteger,
  contentType: z.string(),
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const RunReceiptRowSchema = z.object({
  key: nonEmptyText,
  projectId: IdentifierSchema,
  runId: IdentifierSchema,
  receipt: z.unknown(),
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const SettingRowSchema = z.object({
  key: nonEmptyText,
  value: z.unknown(),
  updatedAtMs: nonNegativeSafeInteger,
}).strict();

export class StorageReadValidationError extends Error {
  public readonly table: string;

  public constructor(table: string, message: string) {
    super(`CueBench storage validation failed for ${table}: ${message}`);
    this.name = "StorageReadValidationError";
    this.table = table;
  }
}

const parseStored = <Value>(schema: z.ZodType, value: unknown, table: string): Value => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as Value;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "row";
  throw new StorageReadValidationError(table, `${path}: ${issue?.message ?? "invalid value"}`);
};

const recordKey = (...parts: readonly string[]): string => JSON.stringify(parts);

const itemKey = (projectId: string, itemId: string) => recordKey(projectId, itemId);
const revisionKey = (projectId: string, itemId: string, itemRevision: number) =>
  recordKey(projectId, itemId, String(itemRevision));
const findingKey = (projectId: string, scope: string, findingId: string) => recordKey(projectId, scope, findingId);
const evidenceKey = (projectId: string, evidenceId: string) => recordKey(projectId, evidenceId);
const courtRecordKey = (projectId: string, eventId: string) => recordKey(projectId, eventId);
const certificationKey = (projectId: string, certificationId: string) => recordKey(projectId, certificationId);
export const sourceBlobKey = (projectId: string, sourceSha256: string) => recordKey(projectId, sourceSha256);
export const narrationBlobKey = (projectId: string, beatId: string, itemRevision: number) =>
  recordKey(projectId, beatId, String(itemRevision));
export const runReceiptKey = (projectId: string, runId: string) => recordKey(projectId, runId);

const currentValidationScope = (run: StoredValidationRun) => `current:${run.inputHash}`;
const certificationValidationScope = (certification: StoredProjectCertification) =>
  `certification:${certification.certificationId}:${certification.validationRun.inputHash}`;

const storedValidationRun = (run: ValidationRun): StoredValidationRun => {
  return {
    projectId: run.projectId,
    projectRevision: run.projectRevision,
    profileId: run.profileId,
    profileRevision: run.profileRevision,
    input: clone(run.input),
    inputHash: run.inputHash,
    blockerCount: run.blockerCount,
    warningCount: run.warningCount,
  };
};

const rehydrateValidationRun = (
  stored: StoredValidationRun,
  findings: readonly QualityFinding[],
): ValidationRun => {
  const orderedFindings = [...findings].sort((left, right) => left.findingId.localeCompare(right.findingId));
  const run: ValidationRun = {
    ...clone(stored),
    findings: orderedFindings,
    blockers: orderedFindings.filter((finding) => finding.severity === "blocker"),
    warnings: orderedFindings.filter((finding) => finding.severity === "warning"),
  };
  return parseStored<ValidationRun>(ValidationRunSchema, run, "validation runs");
};

const storedCertification = (certification: ProjectCertification): StoredProjectCertification => {
  const { validationRun, ...rest } = certification;
  return {
    ...clone(rest),
    validationRun: storedValidationRun(validationRun),
  };
};

const rehydrateCertification = (
  stored: StoredProjectCertification,
  findings: readonly QualityFinding[],
): ProjectCertification => parseStored<ProjectCertification>(ProjectCertificationSchema, {
  ...clone(stored),
  validationRun: rehydrateValidationRun(stored.validationRun, findings),
}, "certifications");

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const assertRevisionHistory = (
  item: CaptionCue | AudioDescriptionBeat,
  project: CaptionProject,
): void => {
  const revisions = item.revisions;
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    if (revision.itemId !== item.itemId || revision.kind !== item.kind) {
      throw new StorageReadValidationError("revisions", "Revision does not belong to its item.");
    }
    if (revision.itemRevision !== index + 1 || revision.parentItemRevision !== (index === 0 ? null : index)) {
      throw new StorageReadValidationError("revisions", "Revision history must be contiguous and immutable.");
    }
    if (revision.startMs < 0 || revision.endMs > project.media.durationMs || revision.endMs <= revision.startMs) {
      throw new StorageReadValidationError("revisions", "Revision timing falls outside the linked media.");
    }
  }
  const latest = revisions.at(-1);
  if (latest === undefined || !sameJson(latest, item.current)) {
    throw new StorageReadValidationError("items", "Item current revision does not equal its immutable history tail.");
  }
};

const assertTrackOrder = (
  order: readonly string[],
  expectedIds: readonly string[],
  table: string,
): void => {
  const actual = new Set(order);
  if (actual.size !== order.length || actual.size !== expectedIds.length || expectedIds.some((itemId) => !actual.has(itemId))) {
    throw new StorageReadValidationError(table, "Track order must contain every live item exactly once.");
  }
};

const assertContiguousSequences = (
  rows: readonly { readonly sequence: number }[],
  table: string,
): void => {
  const ordered = [...rows].sort((left, right) => left.sequence - right.sequence);
  if (ordered.some((row, index) => row.sequence !== index)) {
    throw new StorageReadValidationError(table, "Normalized row sequence is not contiguous.");
  }
};

const assertProjectRelationships = (project: CaptionProject): void => {
  for (const [itemId, item] of Object.entries(project.captions.items)) {
    if (item.itemId !== itemId) throw new StorageReadValidationError("items", "Caption item map key does not match item id.");
    assertRevisionHistory(item, project);
    if (item.mergedIntoItemId !== null && (
      item.mergedIntoItemId === item.itemId || project.captions.items[item.mergedIntoItemId] === undefined
    )) throw new StorageReadValidationError("items", "Merged cue target is invalid.");
  }
  for (const [itemId, item] of Object.entries(project.audioDescriptions.items)) {
    if (item.itemId !== itemId) throw new StorageReadValidationError("items", "Audio-description item map key does not match item id.");
    assertRevisionHistory(item, project);
  }
  assertTrackOrder(
    project.captions.order,
    Object.values(project.captions.items).filter((item) => item.mergedIntoItemId === null).map((item) => item.itemId),
    "project headers",
  );
  assertTrackOrder(
    project.audioDescriptions.order,
    Object.values(project.audioDescriptions.items).map((item) => item.itemId),
    "project headers",
  );
  for (const [gapId, gap] of Object.entries(project.audioDescriptionGaps)) {
    if (gap.gapId !== gapId || gap.endMs > project.media.durationMs) {
      throw new StorageReadValidationError("project headers", "Audio-description gap is invalid.");
    }
  }
  for (const evidence of project.evidence) {
    if (evidence.projectId !== project.projectId || evidence.mediaSha256 !== project.media.sha256) {
      throw new StorageReadValidationError("evidence", "Evidence does not bind to this project and media.");
    }
    if (evidence.itemId !== null) {
      const item = project.captions.items[evidence.itemId] ?? project.audioDescriptions.items[evidence.itemId];
      if (item === undefined || !item.revisions.some((revision) => revision.itemRevision === evidence.itemRevision)) {
        throw new StorageReadValidationError("evidence", "Evidence references an unknown item revision.");
      }
    }
  }
  if (project.selectedItem !== null) {
    if (project.selectedItem.kind === "AudioDescriptionGap") {
      const gap = project.audioDescriptionGaps[project.selectedItem.itemId];
      if (gap === undefined || gap.state !== "Available" || gap.gapRevision !== project.selectedItem.itemRevision) {
        throw new StorageReadValidationError("project headers", "Selected gap is no longer current.");
      }
    } else {
      const item = project.captions.items[project.selectedItem.itemId]
        ?? project.audioDescriptions.items[project.selectedItem.itemId];
      if (item === undefined || item.kind !== project.selectedItem.kind || item.current.itemRevision !== project.selectedItem.itemRevision) {
        throw new StorageReadValidationError("project headers", "Selected item is no longer current.");
      }
    }
  }
  const certificationIds = new Set<string>();
  for (const certification of project.certifications) {
    if (certificationIds.has(certification.certificationId)) {
      throw new StorageReadValidationError("certifications", "Certification ids must be unique.");
    }
    certificationIds.add(certification.certificationId);
  }
  if (project.certification.status !== "NotCertified" && !certificationIds.has(project.certification.certificationId)) {
    throw new StorageReadValidationError("project headers", "Current certification pointer has no snapshot.");
  }
  if (project.validation.status === "Current" && project.validationRun === null) {
    throw new StorageReadValidationError("project headers", "Current validation has no persisted validation run.");
  }
  const assertValidationRunProject = (run: ValidationRun, table: string) => {
    if (run.projectId !== project.projectId || run.input.projectId !== project.projectId) {
      throw new StorageReadValidationError(table, "Validation run belongs to another project.");
    }
  };
  if (project.validationRun !== null) assertValidationRunProject(project.validationRun, "findings");
  for (const certification of project.certifications) {
    assertValidationRunProject(certification.validationRun, "certifications");
    if (certification.evidence.some((entry) => entry.projectId !== project.projectId)) {
      throw new StorageReadValidationError("certifications", "Certification evidence belongs to another project.");
    }
  }
  if (project.activeGenerationRun !== null && project.activeGenerationRun.actor.type !== "CueBenchAI") {
    throw new StorageReadValidationError("project headers", "Only CueBench AI may hold a generation write lease.");
  }
  const eventIds = new Set<string>();
  for (const event of project.courtRecord) {
    if (eventIds.has(event.eventId) || event.projectRevision > project.projectRevision) {
      throw new StorageReadValidationError("court record", "Court Record events are not valid for this project revision.");
    }
    eventIds.add(event.eventId);
  }
  for (const [findingId, waiver] of Object.entries(project.warningWaivers)) {
    if (findingId !== waiver.findingId) throw new StorageReadValidationError("project headers", "Warning waiver key does not match finding id.");
  }
};

export const validateCaptionProject = (value: unknown): CaptionProject => {
  const project = parseStored<CaptionProject>(CaptionProjectSchema, value, "project");
  assertProjectRelationships(project);
  return clone(project);
};

export interface NormalizedProjectRows {
  readonly header: ProjectHeaderRow;
  readonly items: readonly ItemRow[];
  readonly revisions: readonly RevisionRow[];
  readonly findings: readonly FindingRow[];
  readonly evidence: readonly EvidenceRow[];
  readonly courtRecord: readonly CourtRecordRow[];
  readonly certifications: readonly CertificationRow[];
}

export const normalizeProject = (
  value: CaptionProject,
  timestamps: { readonly createdAtMs: number; readonly updatedAtMs: number },
): NormalizedProjectRows => {
  const project = validateCaptionProject(value);
  const header: ProjectHeaderRow = {
    projectId: project.projectId,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    contractVersion: project.contractVersion,
    projectRevision: project.projectRevision,
    title: project.title,
    media: clone(project.media),
    captionOrder: clone(project.captions.order),
    audioDescriptionOrder: clone(project.audioDescriptions.order),
    audioDescriptionGaps: clone(project.audioDescriptionGaps),
    selectedItem: clone(project.selectedItem),
    validation: clone(project.validation),
    validationRun: project.validationRun === null ? null : storedValidationRun(project.validationRun),
    certification: clone(project.certification),
    qualityProfile: clone(project.qualityProfile),
    warningWaivers: clone(project.warningWaivers),
    activeGenerationRun: clone(project.activeGenerationRun),
    createdAtMs: timestamps.createdAtMs,
    updatedAtMs: timestamps.updatedAtMs,
  };
  const items: ItemRow[] = [];
  const revisions: RevisionRow[] = [];
  const appendItem = (item: CaptionCue | AudioDescriptionBeat, mergedIntoItemId: string | null) => {
    items.push({
      key: itemKey(project.projectId, item.itemId),
      projectId: project.projectId,
      itemId: item.itemId,
      kind: item.kind,
      currentItemRevision: item.current.itemRevision,
      mergedIntoItemId,
    });
    for (const revision of item.revisions) {
      revisions.push({
        key: revisionKey(project.projectId, item.itemId, revision.itemRevision),
        projectId: project.projectId,
        itemId: item.itemId,
        itemRevision: revision.itemRevision,
        kind: item.kind,
        revision: clone(revision),
      });
    }
  };
  for (const item of Object.values(project.captions.items)) appendItem(item, item.mergedIntoItemId);
  for (const item of Object.values(project.audioDescriptions.items)) appendItem(item, null);

  const findings: FindingRow[] = [];
  const appendRunFindings = (scope: string, run: ValidationRun) => {
    for (const finding of run.findings) {
      findings.push({
        key: findingKey(project.projectId, scope, finding.findingId),
        projectId: project.projectId,
        scope,
        findingId: finding.findingId,
        finding: clone(finding),
      });
    }
  };
  if (project.validationRun !== null) appendRunFindings(currentValidationScope(storedValidationRun(project.validationRun)), project.validationRun);

  const certifications = project.certifications.map((certification, sequence): CertificationRow => {
    const stored = storedCertification(certification);
    appendRunFindings(certificationValidationScope(stored), certification.validationRun);
    return {
      key: certificationKey(project.projectId, certification.certificationId),
      projectId: project.projectId,
      certificationId: certification.certificationId,
      sequence,
      certification: stored,
    };
  });

  const evidence = project.evidence.map((entry, sequence): EvidenceRow => ({
    key: evidenceKey(project.projectId, entry.evidenceId),
    projectId: project.projectId,
    evidenceId: entry.evidenceId,
    sequence,
    evidence: clone(entry),
  }));
  const courtRecord = project.courtRecord.map((event, sequence): CourtRecordRow => ({
    key: courtRecordKey(project.projectId, event.eventId),
    projectId: project.projectId,
    eventId: event.eventId,
    sequence,
    event: clone(event),
  }));
  return { header, items, revisions, findings, evidence, courtRecord, certifications };
};

const assertRowKey = (actual: string, expected: string, table: string): void => {
  if (actual !== expected) throw new StorageReadValidationError(table, "Row primary key does not match its normalized fields.");
};

export const rehydrateProject = (rows: NormalizedProjectRows): CaptionProject => {
  const header = parseStored<ProjectHeaderRow>(ProjectHeaderRowSchema, rows.header, "project headers");
  const items = rows.items.map((row) => parseStored<ItemRow>(ItemRowSchema, row, "items"));
  const revisions = rows.revisions.map((row) => parseStored<RevisionRow>(RevisionRowSchema, row, "revisions"));
  const findings = rows.findings.map((row) => parseStored<FindingRow>(FindingRowSchema, row, "findings"));
  const evidence = rows.evidence.map((row) => parseStored<EvidenceRow>(EvidenceRowSchema, row, "evidence"));
  const courtRecord = rows.courtRecord.map((row) => parseStored<CourtRecordRow>(CourtRecordRowSchema, row, "court record"));
  const certifications = rows.certifications.map((row) => parseStored<CertificationRow>(CertificationRowSchema, row, "certifications"));
  const projectId = header.projectId;
  const allRows = [
    ...items, ...revisions, ...findings, ...evidence, ...courtRecord, ...certifications,
  ] as readonly { projectId: string }[];
  if (allRows.some((row) => row.projectId !== projectId)) {
    throw new StorageReadValidationError("normalized tables", "A child row belongs to another project.");
  }
  for (const row of items) assertRowKey(row.key, itemKey(projectId, row.itemId), "items");
  for (const row of revisions) assertRowKey(row.key, revisionKey(projectId, row.itemId, row.itemRevision), "revisions");
  for (const row of findings) assertRowKey(row.key, findingKey(projectId, row.scope, row.findingId), "findings");
  for (const row of evidence) assertRowKey(row.key, evidenceKey(projectId, row.evidenceId), "evidence");
  for (const row of courtRecord) assertRowKey(row.key, courtRecordKey(projectId, row.eventId), "court record");
  for (const row of certifications) assertRowKey(row.key, certificationKey(projectId, row.certificationId), "certifications");
  for (const row of findings) {
    if (row.findingId !== row.finding.findingId) {
      throw new StorageReadValidationError("findings", "Finding key does not match its finding payload.");
    }
  }
  assertContiguousSequences(evidence, "evidence");
  assertContiguousSequences(courtRecord, "court record");
  assertContiguousSequences(certifications, "certifications");

  const revisionsByItem = new Map<string, RevisionRow[]>();
  for (const row of revisions) {
    if (row.revision.itemId !== row.itemId || row.revision.itemRevision !== row.itemRevision || row.revision.kind !== row.kind) {
      throw new StorageReadValidationError("revisions", "Revision columns disagree with revision data.");
    }
    const rowsForItem = revisionsByItem.get(row.itemId) ?? [];
    rowsForItem.push(row);
    revisionsByItem.set(row.itemId, rowsForItem);
  }
  const captionItems: Record<string, CaptionCue> = {};
  const audioDescriptionItems: Record<string, AudioDescriptionBeat> = {};
  for (const row of items) {
    const history = [...(revisionsByItem.get(row.itemId) ?? [])].sort((left, right) => left.itemRevision - right.itemRevision);
    if (history.length === 0 || history.length !== row.currentItemRevision) {
      throw new StorageReadValidationError("revisions", "An item does not have its complete revision history.");
    }
    if (row.kind === "CaptionCue") {
      if (history.some((revision) => revision.kind !== "CaptionCue")) {
        throw new StorageReadValidationError("revisions", "Caption history contains another item kind.");
      }
      const itemRevisions = history.map((revision) => clone(revision.revision as CaptionCueRevision));
      const current = itemRevisions.at(-1);
      if (current === undefined) throw new StorageReadValidationError("revisions", "Caption history is empty.");
      captionItems[row.itemId] = {
        itemId: row.itemId,
        kind: "CaptionCue",
        revisions: itemRevisions,
        current,
        mergedIntoItemId: row.mergedIntoItemId,
      };
    } else {
      if (row.mergedIntoItemId !== null || history.some((revision) => revision.kind !== "AudioDescriptionBeat")) {
        throw new StorageReadValidationError("revisions", "Audio-description history is malformed.");
      }
      const itemRevisions = history.map((revision) => clone(revision.revision as AudioDescriptionBeatRevision));
      const current = itemRevisions.at(-1);
      if (current === undefined) throw new StorageReadValidationError("revisions", "Audio-description history is empty.");
      audioDescriptionItems[row.itemId] = {
        itemId: row.itemId,
        kind: "AudioDescriptionBeat",
        revisions: itemRevisions,
        current,
      };
    }
  }
  if (revisionsByItem.size !== items.length) {
    throw new StorageReadValidationError("revisions", "A revision references an item that does not exist.");
  }
  const recognizedFindingScopes = new Set<string>();
  if (header.validationRun !== null) recognizedFindingScopes.add(currentValidationScope(header.validationRun));
  for (const row of certifications) recognizedFindingScopes.add(certificationValidationScope(row.certification));
  if (findings.some((row) => !recognizedFindingScopes.has(row.scope))) {
    throw new StorageReadValidationError("findings", "Finding row is not attached to a persisted validation run.");
  }
  const findingsForScope = (scope: string): readonly QualityFinding[] => findings
    .filter((row) => row.scope === scope)
    .map((row) => clone(row.finding));
  const currentRun = header.validationRun === null
    ? null
    : rehydrateValidationRun(header.validationRun, findingsForScope(currentValidationScope(header.validationRun)));
  const rehydratedCertifications = [...certifications]
    .sort((left, right) => left.sequence - right.sequence)
    .map((row) => rehydrateCertification(
      row.certification,
      findingsForScope(certificationValidationScope(row.certification)),
    ));
  const project: CaptionProject = {
    contractVersion: header.contractVersion,
    projectId,
    projectRevision: header.projectRevision,
    title: header.title,
    media: clone(header.media),
    evidence: [...evidence].sort((left, right) => left.sequence - right.sequence).map((row) => clone(row.evidence)),
    captions: { kind: "Captions", order: clone(header.captionOrder), items: captionItems },
    audioDescriptions: { kind: "AudioDescriptions", order: clone(header.audioDescriptionOrder), items: audioDescriptionItems },
    audioDescriptionGaps: clone(header.audioDescriptionGaps),
    selectedItem: clone(header.selectedItem),
    validation: clone(header.validation),
    validationRun: currentRun,
    certification: clone(header.certification),
    certifications: rehydratedCertifications,
    qualityProfile: clone(header.qualityProfile),
    warningWaivers: clone(header.warningWaivers),
    activeGenerationRun: clone(header.activeGenerationRun),
    courtRecord: [...courtRecord].sort((left, right) => left.sequence - right.sequence).map((row) => clone(row.event)),
  };
  return validateCaptionProject(project);
};

export class CueBenchDatabase extends Dexie {
  public readonly projectHeaders!: Table<ProjectHeaderRow, string>;
  public readonly items!: Table<ItemRow, string>;
  public readonly revisions!: Table<RevisionRow, string>;
  public readonly findings!: Table<FindingRow, string>;
  public readonly evidence!: Table<EvidenceRow, string>;
  public readonly courtRecord!: Table<CourtRecordRow, string>;
  /** Compatibility alias that still refers to the singular Court Record table. */
  public readonly courtRecords!: Table<CourtRecordRow, string>;
  public readonly certifications!: Table<CertificationRow, string>;
  public readonly sourceBlobs!: Table<SourceBlobRow, string>;
  public readonly narrationBlobs!: Table<NarrationBlobRow, string>;
  public readonly runReceipts!: Table<RunReceiptRow, string>;
  public readonly settings!: Table<SettingRow, string>;

  public constructor(name = "cuebench") {
    super(name);
    this.version(STORAGE_SCHEMA_VERSION).stores({
      projectHeaders: "&projectId, projectRevision, updatedAtMs",
      items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
      revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
      findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
      evidence: "&key, projectId, evidenceId, [projectId+evidenceId]",
      courtRecord: "&key, projectId, eventId, projectRevision, [projectId+eventId]",
      certifications: "&key, projectId, certificationId, [projectId+certificationId]",
      sourceBlobs: "&key, projectId, sourceId, sha256, [projectId+sha256], [projectId+sourceId]",
      narrationBlobs: "&key, projectId, beatId, itemRevision, [projectId+beatId+itemRevision]",
      runReceipts: "&key, projectId, runId, [projectId+runId]",
      settings: "&key, updatedAtMs",
    });
    this.projectHeaders = this.table("projectHeaders");
    this.items = this.table("items");
    this.revisions = this.table("revisions");
    this.findings = this.table("findings");
    this.evidence = this.table("evidence");
    this.courtRecord = this.table("courtRecord");
    this.courtRecords = this.courtRecord;
    this.certifications = this.table("certifications");
    this.sourceBlobs = this.table("sourceBlobs");
    this.narrationBlobs = this.table("narrationBlobs");
    this.runReceipts = this.table("runReceipts");
    this.settings = this.table("settings");
  }
}

export interface WriteProjectOptions {
  /** Test-only synchronous fault seam; an exception aborts the Dexie transaction. */
  readonly beforeCourtRecordWrite?: (event: DomainEvent) => void;
}

const deleteProjectChildren = async (db: CueBenchDatabase, projectId: string): Promise<void> => {
  await db.items.where("projectId").equals(projectId).delete();
  await db.revisions.where("projectId").equals(projectId).delete();
  await db.findings.where("projectId").equals(projectId).delete();
  await db.evidence.where("projectId").equals(projectId).delete();
  await db.courtRecord.where("projectId").equals(projectId).delete();
  await db.certifications.where("projectId").equals(projectId).delete();
};

export const writeProjectInTransaction = async (
  db: CueBenchDatabase,
  project: CaptionProject,
  options: WriteProjectOptions = {},
): Promise<void> => {
  const checkedProject = validateCaptionProject(project);
  const existing = await db.projectHeaders.get(checkedProject.projectId);
  const existingHeader = existing === undefined
    ? undefined
    : parseStored<ProjectHeaderRow>(ProjectHeaderRowSchema, existing, "project headers");
  const now = Date.now();
  const rows = normalizeProject(checkedProject, {
    createdAtMs: existingHeader?.createdAtMs ?? now,
    updatedAtMs: now,
  });
  await db.projectHeaders.put(rows.header);
  await deleteProjectChildren(db, checkedProject.projectId);
  await db.items.bulkPut([...rows.items]);
  await db.revisions.bulkPut([...rows.revisions]);
  await db.findings.bulkPut([...rows.findings]);
  await db.evidence.bulkPut([...rows.evidence]);
  await db.certifications.bulkPut([...rows.certifications]);
  if (options.beforeCourtRecordWrite !== undefined) {
    for (const row of rows.courtRecord) options.beforeCourtRecordWrite(row.event);
  }
  await db.courtRecord.bulkPut([...rows.courtRecord]);
};

export const loadProjectInTransaction = async (
  db: CueBenchDatabase,
  projectId: string,
): Promise<CaptionProject | undefined> => {
  const header = await db.projectHeaders.get(projectId);
  if (header === undefined) return undefined;
  const [items, revisions, findings, evidence, courtRecord, certifications] = await Promise.all([
    db.items.where("projectId").equals(projectId).toArray(),
    db.revisions.where("projectId").equals(projectId).toArray(),
    db.findings.where("projectId").equals(projectId).toArray(),
    db.evidence.where("projectId").equals(projectId).toArray(),
    db.courtRecord.where("projectId").equals(projectId).toArray(),
    db.certifications.where("projectId").equals(projectId).toArray(),
  ]);
  return rehydrateProject({ header, items, revisions, findings, evidence, courtRecord, certifications });
};

const projectTables = (db: CueBenchDatabase) => [
  db.projectHeaders,
  db.items,
  db.revisions,
  db.findings,
  db.evidence,
  db.courtRecord,
  db.certifications,
] as const;

export const saveProject = async (db: CueBenchDatabase, project: CaptionProject): Promise<void> => {
  await db.transaction("rw", projectTables(db), async () => {
    await writeProjectInTransaction(db, project);
  });
};

export const loadProject = async (db: CueBenchDatabase, projectId: string): Promise<CaptionProject | undefined> =>
  db.transaction("r", projectTables(db), async () => loadProjectInTransaction(db, projectId));

export const validateSourceBlobRow = (value: unknown): SourceBlobRow =>
  parseStored<SourceBlobRow>(SourceBlobRowSchema, value, "source blobs");

export const validateNarrationBlobRow = (value: unknown): NarrationBlobRow =>
  parseStored<NarrationBlobRow>(NarrationBlobRowSchema, value, "narration blobs");

export const validateRunReceiptRow = (value: unknown): RunReceiptRow =>
  parseStored<RunReceiptRow>(RunReceiptRowSchema, value, "run receipts");

export const validateSettingRow = (value: unknown): SettingRow =>
  parseStored<SettingRow>(SettingRowSchema, value, "settings");
