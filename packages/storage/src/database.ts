import Dexie, { type Table } from "dexie";
import type {
  CertificationSnapshot,
  MediaSourceSnapshot,
  ValidationSnapshot,
} from "@cuebench/contracts";
import {
  canonicalSerialize,
  currentValidationRun,
  currentProjectItems,
  verifyCertificationSnapshot,
  type AudioDescriptionBeat,
  type AudioDescriptionBeatRevision,
  type CaptionCue,
  type CaptionCueRevision,
  type CaptionProject,
  type DomainEvent,
  type EvidenceProvenance,
  type GenerationLease,
  type ProjectCertification,
  type QualityFinding,
  type QualityProfile,
  type Selection,
  type ValidationRun,
  type WarningWaiver,
} from "@cuebench/domain";
import { z } from "zod";

/** The durable project-envelope schema, independent of Dexie's internal schema number. */
export const STORAGE_SCHEMA_VERSION = 1 as const;

const clone = <Value>(value: Value): Value => structuredClone(value);
const sameValue = (left: unknown, right: unknown): boolean => canonicalSerialize(left) === canonicalSerialize(right);

const positiveSafeInteger = z.number().int().refine(Number.isSafeInteger).positive();
const nonNegativeSafeInteger = z.number().int().refine(Number.isSafeInteger).nonnegative();
/** Stored identifiers are canonical; validation must not trim them on read. */
const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value, {
  message: "Identifier must not have leading or trailing whitespace.",
});
/** Human-facing text is retained byte-for-byte, while all-whitespace values remain invalid. */
const nonBlankText = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "Text must contain a non-whitespace character.",
});
const boundedText = (maximum: number) => nonBlankText.max(maximum);
const lowercaseSha256 = z.string().regex(/^[0-9a-f]{64}$/, "Expected a canonical lowercase SHA-256 hash.");
const prefixedSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected a SHA-256 hash.");
const unknownRecord = z.record(z.string(), z.unknown());

const ActorStorageSchema = z.object({
  type: z.enum(["Human", "BrowserAgent", "CueBenchAI", "System"]),
  id: identifier,
}).strict();

const ReviewStateStorageSchema = z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]);

const MediaSourceStorageSchema = z.object({
  sourceId: identifier,
  sha256: lowercaseSha256,
  durationMs: nonNegativeSafeInteger,
  relinkState: z.enum(["Linked", "Missing", "TemporarySession"]),
}).strict();

const ValidationSnapshotStorageSchema = z.object({
  status: z.enum(["NotRun", "Current", "Stale"]),
  blockerCount: nonNegativeSafeInteger,
  warningCount: nonNegativeSafeInteger,
}).strict();

const CertificationSnapshotStorageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NotCertified") }).strict(),
  z.object({ status: z.literal("Current"), certificationId: identifier }).strict(),
  z.object({ status: z.literal("Stale"), certificationId: identifier }).strict(),
]);

const CaptionCueRevisionSchema = z.object({
  itemId: identifier,
  itemRevision: positiveSafeInteger,
  state: ReviewStateStorageSchema,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  actor: ActorStorageSchema,
  cause: boundedText(1_000),
  parentItemRevision: positiveSafeInteger.nullable(),
  kind: z.literal("CaptionCue"),
  text: boundedText(1_000),
  speaker: boundedText(200).nullable(),
}).strict().refine((revision) => revision.endMs > revision.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});

const AudioDescriptionBeatRevisionSchema = z.object({
  itemId: identifier,
  itemRevision: positiveSafeInteger,
  state: ReviewStateStorageSchema,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  actor: ActorStorageSchema,
  cause: boundedText(1_000),
  parentItemRevision: positiveSafeInteger.nullable(),
  kind: z.literal("AudioDescriptionBeat"),
  description: boundedText(1_000),
}).strict().refine((revision) => revision.endMs > revision.startMs, {
  message: "A revision must end after it starts.",
  path: ["endMs"],
});

const RevisionSchema = z.discriminatedUnion("kind", [
  CaptionCueRevisionSchema,
  AudioDescriptionBeatRevisionSchema,
]);

const CaptionCueSchema = z.object({
  itemId: identifier,
  kind: z.literal("CaptionCue"),
  revisions: z.array(CaptionCueRevisionSchema).min(1),
  current: CaptionCueRevisionSchema,
  mergedIntoItemId: identifier.nullable(),
}).strict();

const AudioDescriptionBeatSchema = z.object({
  itemId: identifier,
  kind: z.literal("AudioDescriptionBeat"),
  revisions: z.array(AudioDescriptionBeatRevisionSchema).min(1),
  current: AudioDescriptionBeatRevisionSchema,
}).strict();

const AudioDescriptionGapSchema = z.object({
  gapId: identifier,
  gapRevision: positiveSafeInteger,
  state: z.enum(["Available", "Consumed"]),
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
}).strict().refine((gap) => gap.endMs > gap.startMs, {
  message: "An audio-description gap must end after it starts.",
  path: ["endMs"],
});

const ItemSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ itemId: identifier, itemRevision: positiveSafeInteger, kind: z.literal("CaptionCue") }).strict(),
  z.object({ itemId: identifier, itemRevision: positiveSafeInteger, kind: z.literal("AudioDescriptionBeat") }).strict(),
  z.object({
    itemId: identifier,
    itemRevision: positiveSafeInteger,
    kind: z.literal("AudioDescriptionGap"),
    state: z.literal("Available"),
  }).strict(),
]);

const QualityProfileSchema = z.object({
  profileId: identifier,
  revision: positiveSafeInteger,
  name: boundedText(1_000),
  rules: unknownRecord,
}).strict();

const WarningWaiverSchema = z.object({
  findingId: identifier,
  reason: boundedText(4_000),
  actor: ActorStorageSchema,
  projectRevision: positiveSafeInteger,
}).strict();

const EvidenceProvenanceSchema = z.object({
  evidenceId: identifier,
  projectId: identifier,
  mediaSha256: lowercaseSha256,
  itemId: identifier.nullable(),
  itemRevision: positiveSafeInteger.nullable(),
}).strict().refine((evidence) => (evidence.itemId === null) === (evidence.itemRevision === null), {
  message: "Evidence item id and revision must be present together.",
});

const GenerationLeaseSchema = z.object({
  runId: identifier,
  targetTrack: z.enum(["Captions", "AudioDescriptions"]),
  actor: ActorStorageSchema,
}).strict();

const DomainEventSchema = z.object({
  eventId: identifier,
  projectRevision: positiveSafeInteger,
  type: boundedText(200),
  actor: ActorStorageSchema,
  itemId: identifier.optional(),
  detail: z.string().optional(),
}).strict();

const ValidationInputItemSchema = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  itemId: identifier,
  itemRevision: positiveSafeInteger,
  state: ReviewStateStorageSchema,
  startMs: nonNegativeSafeInteger,
  endMs: nonNegativeSafeInteger,
  text: z.string(),
  speaker: z.string().nullable(),
  mergedIntoItemId: identifier.nullable().optional(),
}).strict().refine((item) => item.endMs > item.startMs, {
  message: "Validation input items must end after they start.",
  path: ["endMs"],
});

const ValidationInputSchema = z.object({
  projectId: identifier,
  projectRevision: positiveSafeInteger,
  media: MediaSourceStorageSchema,
  evidence: z.array(EvidenceProvenanceSchema),
  qualityProfile: QualityProfileSchema,
  captions: z.object({
    order: z.array(identifier),
    items: z.array(ValidationInputItemSchema),
  }).strict(),
  audioDescriptions: z.object({
    order: z.array(identifier),
    items: z.array(ValidationInputItemSchema),
  }).strict(),
  audioDescriptionGaps: z.array(AudioDescriptionGapSchema),
}).strict();

const FindingTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project"),
    projectId: identifier,
    projectRevision: positiveSafeInteger,
  }).strict(),
  z.object({
    type: z.literal("item"),
    kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
    itemId: identifier,
    itemRevision: positiveSafeInteger,
  }).strict(),
  z.object({
    type: z.literal("pair"),
    first: z.object({
      kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
      itemId: identifier,
      itemRevision: positiveSafeInteger,
    }).strict(),
    second: z.object({
      kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
      itemId: identifier,
      itemRevision: positiveSafeInteger,
    }).strict(),
  }).strict(),
]);

const QualityFindingSchema = z.object({
  id: identifier,
  findingId: identifier,
  ruleId: boundedText(200),
  severity: z.enum(["blocker", "warning"]),
  message: boundedText(4_000),
  target: FindingTargetSchema,
}).strict().refine((finding) => finding.id === finding.findingId, {
  message: "Finding id aliases must agree.",
});

const StoredValidationRunSchema = z.object({
  projectId: identifier,
  projectRevision: positiveSafeInteger,
  profileId: identifier,
  profileRevision: positiveSafeInteger,
  input: ValidationInputSchema,
  inputHash: prefixedSha256,
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
  const sameIds = (left: readonly { readonly findingId: string }[], right: readonly { readonly findingId: string }[]) =>
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
  itemId: identifier,
  itemRevision: positiveSafeInteger,
}).strict();

const StoredProjectCertificationSchema = z.object({
  certificationId: identifier,
  certificationSnapshotHash: prefixedSha256,
  readinessHash: prefixedSha256,
  certifiedAtMs: positiveSafeInteger,
  actor: ActorStorageSchema,
  media: MediaSourceStorageSchema,
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
  projectId: identifier,
  projectRevision: positiveSafeInteger,
  title: boundedText(1_000),
  media: MediaSourceStorageSchema,
  evidence: z.array(EvidenceProvenanceSchema),
  captions: z.object({
    kind: z.literal("Captions"),
    order: z.array(identifier),
    items: z.record(z.string(), CaptionCueSchema),
  }).strict(),
  audioDescriptions: z.object({
    kind: z.literal("AudioDescriptions"),
    order: z.array(identifier),
    items: z.record(z.string(), AudioDescriptionBeatSchema),
  }).strict(),
  audioDescriptionGaps: z.record(z.string(), AudioDescriptionGapSchema),
  selectedItem: ItemSelectionSchema.nullable(),
  validation: ValidationSnapshotStorageSchema,
  validationRun: ValidationRunSchema.nullable(),
  certification: CertificationSnapshotStorageSchema,
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
  readonly media: MediaSourceSnapshot;
  readonly captionOrder: readonly string[];
  readonly audioDescriptionOrder: readonly string[];
  readonly audioDescriptionGaps: Readonly<Record<string, import("@cuebench/domain").AudioDescriptionGap>>;
  readonly selectedItem: Selection | null;
  readonly validation: ValidationSnapshot;
  readonly validationRun: StoredValidationRun | null;
  readonly certification: CertificationSnapshot;
  readonly qualityProfile: QualityProfile;
  readonly warningWaivers: Readonly<Record<string, WarningWaiver>>;
  readonly activeGenerationRun: GenerationLease | null;
  /** Ordered ids identify the current evidence projection; older versions remain append-only rows. */
  readonly evidenceOrder: readonly string[];
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

/** Evidence is immutable by version; the header chooses the current version of each id. */
export interface EvidenceRow {
  readonly key: string;
  readonly projectId: string;
  readonly evidenceId: string;
  readonly version: number;
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

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface VersionedRunReceipt {
  readonly version: 1;
  readonly payload: JsonValue;
}

export interface RunReceiptRow {
  readonly key: string;
  readonly projectId: string;
  readonly runId: string;
  /** Versioned JSON only: receipts must be durable and safely estimable. */
  readonly receipt: VersionedRunReceipt;
  readonly savedAtMs: number;
}

export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAtMs: number;
}

const ProjectHeaderRowSchema = z.object({
  projectId: identifier,
  schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  contractVersion: z.literal(1),
  projectRevision: positiveSafeInteger,
  title: boundedText(1_000),
  media: MediaSourceStorageSchema,
  captionOrder: z.array(identifier),
  audioDescriptionOrder: z.array(identifier),
  audioDescriptionGaps: z.record(z.string(), AudioDescriptionGapSchema),
  selectedItem: ItemSelectionSchema.nullable(),
  validation: ValidationSnapshotStorageSchema,
  validationRun: StoredValidationRunSchema.nullable(),
  certification: CertificationSnapshotStorageSchema,
  qualityProfile: QualityProfileSchema,
  warningWaivers: z.record(z.string(), WarningWaiverSchema),
  activeGenerationRun: GenerationLeaseSchema.nullable(),
  evidenceOrder: z.array(identifier),
  createdAtMs: nonNegativeSafeInteger,
  updatedAtMs: nonNegativeSafeInteger,
}).strict();

const ItemRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  itemId: identifier,
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  currentItemRevision: positiveSafeInteger,
  mergedIntoItemId: identifier.nullable(),
}).strict();

const RevisionRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  itemId: identifier,
  itemRevision: positiveSafeInteger,
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  revision: RevisionSchema,
}).strict();

const FindingRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  scope: nonBlankText,
  findingId: identifier,
  finding: QualityFindingSchema,
}).strict();

const EvidenceRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  evidenceId: identifier,
  version: positiveSafeInteger,
  sequence: nonNegativeSafeInteger,
  evidence: EvidenceProvenanceSchema,
}).strict();

const CourtRecordRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  eventId: identifier,
  sequence: nonNegativeSafeInteger,
  event: DomainEventSchema,
}).strict();

const CertificationRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  certificationId: identifier,
  sequence: nonNegativeSafeInteger,
  certification: StoredProjectCertificationSchema,
}).strict();

const blobSchema = z.custom<Blob>((value) => typeof Blob !== "undefined" && value instanceof Blob, {
  message: "Expected a Blob.",
});

const SourceBlobRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  sourceId: identifier,
  sha256: lowercaseSha256,
  blob: blobSchema,
  byteLength: nonNegativeSafeInteger,
  contentType: z.string(),
  fileName: z.string().nullable(),
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const NarrationBlobRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  beatId: identifier,
  itemRevision: positiveSafeInteger,
  blob: blobSchema,
  byteLength: nonNegativeSafeInteger,
  contentType: z.string(),
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const isJsonValue = (value: unknown, seen = new WeakSet<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, seen));
};

const VersionedRunReceiptSchema = z.object({
  version: z.literal(1),
  payload: z.custom<JsonValue>((value) => isJsonValue(value), {
    message: "Receipt payload must be finite, JSON-compatible, and acyclic.",
  }),
}).strict();

const RunReceiptRowSchema = z.object({
  key: nonBlankText,
  projectId: identifier,
  runId: identifier,
  receipt: VersionedRunReceiptSchema,
  savedAtMs: nonNegativeSafeInteger,
}).strict();

const SettingRowSchema = z.object({
  key: identifier,
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

/** Raised when a caller attempts to alter an immutable normalized history row. */
export class StorageImmutableWriteError extends Error {
  public constructor(message: string) {
    super(`CueBench immutable storage write rejected: ${message}`);
    this.name = "StorageImmutableWriteError";
  }
}

/** Raised after a different Dexie connection advanced the persisted header. */
export class StorageStaleWriteError extends Error {
  public constructor(projectId: string) {
    super(`CueBench project ${projectId} changed in another browser context.`);
    this.name = "StorageStaleWriteError";
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
const evidenceKey = (projectId: string, evidenceId: string, version: number) =>
  recordKey(projectId, evidenceId, String(version));
const courtRecordKey = (projectId: string, eventId: string) => recordKey(projectId, eventId);
const certificationKey = (projectId: string, certificationId: string) => recordKey(projectId, certificationId);
export const sourceBlobKey = (projectId: string, sourceSha256: string) => recordKey(projectId, sourceSha256);
export const narrationBlobKey = (projectId: string, beatId: string, itemRevision: number) =>
  recordKey(projectId, beatId, String(itemRevision));
export const runReceiptKey = (projectId: string, runId: string) => recordKey(projectId, runId);

/** A validation run is immutable at its post-command project revision. */
const validationScope = (run: StoredValidationRun) => `validation:${run.projectRevision}:${run.inputHash}`;

const storedValidationRun = (run: ValidationRun): StoredValidationRun => ({
  projectId: run.projectId,
  projectRevision: run.projectRevision,
  profileId: run.profileId,
  profileRevision: run.profileRevision,
  input: clone(run.input),
  inputHash: run.inputHash,
  blockerCount: run.blockerCount,
  warningCount: run.warningCount,
});

const rehydrateValidationRun = (
  stored: StoredValidationRun,
  findings: readonly QualityFinding[],
): ValidationRun => {
  const orderedFindings = [...findings].sort((left, right) => left.findingId.localeCompare(right.findingId));
  return parseStored<ValidationRun>(ValidationRunSchema, {
    ...clone(stored),
    findings: orderedFindings,
    blockers: orderedFindings.filter((finding) => finding.severity === "blocker"),
    warnings: orderedFindings.filter((finding) => finding.severity === "warning"),
  }, "validation runs");
};

const storedCertification = (certification: ProjectCertification): StoredProjectCertification => {
  const { validationRun, ...rest } = certification;
  return { ...clone(rest), validationRun: storedValidationRun(validationRun) };
};

const rehydrateCertification = (
  stored: StoredProjectCertification,
  findings: readonly QualityFinding[],
): ProjectCertification => parseStored<ProjectCertification>(ProjectCertificationSchema, {
  ...clone(stored),
  validationRun: rehydrateValidationRun(stored.validationRun, findings),
}, "certifications");

const assertUnique = (values: readonly string[], table: string, label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new StorageReadValidationError(table, `${label} must be unique.`);
  }
};

const assertRevisionHistory = (item: CaptionCue | AudioDescriptionBeat, project: CaptionProject): void => {
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
  if (!sameValue(revisions.at(-1), item.current)) {
    throw new StorageReadValidationError("items", "Item current revision does not equal its immutable history tail.");
  }
};

const assertTrackOrder = (order: readonly string[], expectedIds: readonly string[], table: string): void => {
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

const canonicalEvidence = (evidence: readonly EvidenceProvenance[]): readonly EvidenceProvenance[] =>
  [...evidence].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

const currentItemBindings = (project: CaptionProject) => currentProjectItems(project).map((item) => ({
  kind: item.kind,
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
}));

const assertCertificationPointer = (project: CaptionProject): void => {
  const certificationIds = project.certifications.map((certification) => certification.certificationId);
  assertUnique(certificationIds, "certifications", "Certification ids");
  for (const certification of project.certifications) {
    if (!verifyCertificationSnapshot(certification)) {
      throw new StorageReadValidationError("certifications", "Certification snapshot signature or structure is invalid.");
    }
    if (certification.validationRun.projectId !== project.projectId) {
      throw new StorageReadValidationError("certifications", "Certification validation run belongs to another project.");
    }
  }
  const pointer = project.certification;
  if (pointer.status === "NotCertified") return;
  const snapshot = project.certifications.find(
    (candidate) => candidate.certificationId === pointer.certificationId,
  );
  if (snapshot === undefined) {
    throw new StorageReadValidationError("project headers", "Certification pointer has no immutable snapshot.");
  }
  if (pointer.status === "Stale") return;
  if (
    project.validation.status !== "Current"
    || project.validationRun === null
    || !sameValue(snapshot.media, project.media)
    || !sameValue(snapshot.evidence, canonicalEvidence(project.evidence))
    || !sameValue(snapshot.itemRevisions, currentItemBindings(project))
    || !sameValue(snapshot.qualityProfile, project.qualityProfile)
    || !sameValue(snapshot.validationRun, project.validationRun)
  ) {
    throw new StorageReadValidationError("project headers", "Current certification does not bind the current project projection.");
  }
};

const assertProjectRelationships = (project: CaptionProject): void => {
  const globalIds = new Set<string>();
  const claimGlobalId = (id: string, table: string) => {
    if (globalIds.has(id)) throw new StorageReadValidationError(table, "Caption, audio-description, and gap ids must be globally unique.");
    globalIds.add(id);
  };
  for (const [itemId, item] of Object.entries(project.captions.items)) {
    if (item.itemId !== itemId) throw new StorageReadValidationError("items", "Caption item map key does not match item id.");
    claimGlobalId(itemId, "items");
    assertRevisionHistory(item, project);
    if (item.mergedIntoItemId !== null && (
      item.mergedIntoItemId === item.itemId || project.captions.items[item.mergedIntoItemId] === undefined
    )) throw new StorageReadValidationError("items", "Merged cue target is invalid.");
  }
  for (const [itemId, item] of Object.entries(project.audioDescriptions.items)) {
    if (item.itemId !== itemId) throw new StorageReadValidationError("items", "Audio-description item map key does not match item id.");
    claimGlobalId(itemId, "items");
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
    claimGlobalId(gapId, "project headers");
    if (gap.gapId !== gapId || gap.endMs > project.media.durationMs) {
      throw new StorageReadValidationError("project headers", "Audio-description gap is invalid.");
    }
  }
  assertUnique(project.evidence.map((entry) => entry.evidenceId), "evidence", "Evidence ids");
  for (const evidence of project.evidence) {
    if (evidence.projectId !== project.projectId) {
      throw new StorageReadValidationError("evidence", "Evidence belongs to another project.");
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
  if (project.validation.status === "Current" && project.validationRun === null) {
    throw new StorageReadValidationError("project headers", "Current validation has no persisted validation run.");
  }
  if (project.validation.status === "Current" && (
    currentValidationRun(project) === undefined
    || project.validation.blockerCount !== project.validationRun!.blockerCount
    || project.validation.warningCount !== project.validationRun!.warningCount
  )) {
    throw new StorageReadValidationError("project headers", "Current validation does not bind the current project projection.");
  }
  if (project.validationRun !== null && (
    project.validationRun.projectId !== project.projectId || project.validationRun.input.projectId !== project.projectId
  )) throw new StorageReadValidationError("findings", "Validation run belongs to another project.");
  if (project.activeGenerationRun !== null && project.activeGenerationRun.actor.type !== "CueBenchAI") {
    throw new StorageReadValidationError("project headers", "Only CueBench AI may hold a generation write lease.");
  }
  assertUnique(project.courtRecord.map((event) => event.eventId), "court record", "Court Record event ids");
  for (const event of project.courtRecord) {
    if (event.projectRevision > project.projectRevision) {
      throw new StorageReadValidationError("court record", "Court Record event is from a future project revision.");
    }
  }
  for (const [findingId, waiver] of Object.entries(project.warningWaivers)) {
    if (findingId !== waiver.findingId) throw new StorageReadValidationError("project headers", "Warning waiver key does not match finding id.");
  }
  assertCertificationPointer(project);
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

const appendRunFindings = (target: FindingRow[], projectId: string, run: ValidationRun): void => {
  const stored = storedValidationRun(run);
  const scope = validationScope(stored);
  for (const finding of run.findings) {
    const row: FindingRow = {
      key: findingKey(projectId, scope, finding.findingId),
      projectId,
      scope,
      findingId: finding.findingId,
      finding: clone(finding),
    };
    const existing = target.find((candidate) => candidate.key === row.key);
    if (existing === undefined) target.push(row);
    else if (!sameValue(existing, row)) {
      throw new StorageReadValidationError("findings", "One validation scope contains conflicting duplicate finding ids.");
    }
  }
};

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
    evidenceOrder: project.evidence.map((entry) => entry.evidenceId),
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
  if (project.validationRun !== null) appendRunFindings(findings, project.projectId, project.validationRun);
  const certifications = project.certifications.map((certification, sequence): CertificationRow => {
    appendRunFindings(findings, project.projectId, certification.validationRun);
    return {
      key: certificationKey(project.projectId, certification.certificationId),
      projectId: project.projectId,
      certificationId: certification.certificationId,
      sequence,
      certification: storedCertification(certification),
    };
  });
  const evidence = project.evidence.map((entry, sequence): EvidenceRow => ({
    key: evidenceKey(project.projectId, entry.evidenceId, 1),
    projectId: project.projectId,
    evidenceId: entry.evidenceId,
    version: 1,
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

const latestEvidenceRows = (rows: readonly EvidenceRow[]): Map<string, EvidenceRow> => {
  const latest = new Map<string, EvidenceRow>();
  for (const row of rows) {
    const previous = latest.get(row.evidenceId);
    if (previous === undefined || row.version > previous.version) latest.set(row.evidenceId, row);
    else if (row.version === previous.version) {
      throw new StorageReadValidationError("evidence", "Evidence has duplicate immutable versions.");
    }
  }
  return latest;
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
  const allRows = [...items, ...revisions, ...findings, ...evidence, ...courtRecord, ...certifications] as readonly { readonly projectId: string }[];
  if (allRows.some((row) => row.projectId !== projectId)) {
    throw new StorageReadValidationError("normalized tables", "A child row belongs to another project.");
  }
  for (const row of items) assertRowKey(row.key, itemKey(projectId, row.itemId), "items");
  for (const row of revisions) assertRowKey(row.key, revisionKey(projectId, row.itemId, row.itemRevision), "revisions");
  for (const row of findings) assertRowKey(row.key, findingKey(projectId, row.scope, row.findingId), "findings");
  for (const row of evidence) assertRowKey(row.key, evidenceKey(projectId, row.evidenceId, row.version), "evidence");
  for (const row of courtRecord) assertRowKey(row.key, courtRecordKey(projectId, row.eventId), "court record");
  for (const row of certifications) assertRowKey(row.key, certificationKey(projectId, row.certificationId), "certifications");
  assertUnique(items.map((row) => row.itemId), "items", "Item ids");
  assertUnique(revisions.map((row) => row.key), "revisions", "Revision keys");
  assertUnique(findings.map((row) => row.key), "findings", "Finding keys");
  assertUnique(courtRecord.map((row) => row.eventId), "court record", "Court Record event ids");
  assertUnique(certifications.map((row) => row.certificationId), "certifications", "Certification ids");
  assertContiguousSequences(courtRecord, "court record");
  assertContiguousSequences(certifications, "certifications");
  for (const row of findings) {
    if (row.findingId !== row.finding.findingId) {
      throw new StorageReadValidationError("findings", "Finding key does not match its finding payload.");
    }
  }

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

  const evidenceById = latestEvidenceRows(evidence);
  assertUnique(header.evidenceOrder, "project headers", "Current evidence ids");
  if (evidenceById.size !== header.evidenceOrder.length || header.evidenceOrder.some((id) => !evidenceById.has(id))) {
    throw new StorageReadValidationError("evidence", "Current evidence projection does not bind every persisted evidence id.");
  }
  const projectEvidence = header.evidenceOrder.map((id) => clone(evidenceById.get(id)!.evidence));

  const findingsForRun = (run: StoredValidationRun): readonly QualityFinding[] => {
    const scope = validationScope(run);
    const scoped = findings.filter((row) => row.scope === scope).map((row) => clone(row.finding));
    assertUnique(scoped.map((finding) => finding.findingId), "findings", "Finding ids in validation scope");
    return scoped;
  };
  const currentRun = header.validationRun === null ? null : rehydrateValidationRun(header.validationRun, findingsForRun(header.validationRun));
  const rehydratedCertifications = [...certifications]
    .sort((left, right) => left.sequence - right.sequence)
    .map((row) => rehydrateCertification(row.certification, findingsForRun(row.certification.validationRun)));
  const project: CaptionProject = {
    contractVersion: header.contractVersion,
    projectId,
    projectRevision: header.projectRevision,
    title: header.title,
    media: clone(header.media),
    evidence: projectEvidence,
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
  /** Compatibility alias for callers that use the plural table spelling. */
  public readonly courtRecords!: Table<CourtRecordRow, string>;
  public readonly certifications!: Table<CertificationRow, string>;
  public readonly sourceBlobs!: Table<SourceBlobRow, string>;
  public readonly narrationBlobs!: Table<NarrationBlobRow, string>;
  public readonly runReceipts!: Table<RunReceiptRow, string>;
  public readonly settings!: Table<SettingRow, string>;

  public constructor(name = "cuebench") {
    super(name);
    this.version(STORAGE_SCHEMA_VERSION).stores({
      projectHeaders: "&projectId, projectRevision, [projectId+projectRevision], updatedAtMs",
      items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
      revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
      findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
      evidence: "&key, projectId, evidenceId, version, [projectId+evidenceId], [projectId+evidenceId+version]",
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

const projectTables = (db: CueBenchDatabase) => [
  db.projectHeaders,
  db.items,
  db.revisions,
  db.findings,
  db.evidence,
  db.courtRecord,
  db.certifications,
] as const;

export interface WriteProjectOptions {
  /** Test-only fault seam. Throwing aborts the whole IndexedDB transaction. */
  readonly beforeCourtRecordWrite?: (event: DomainEvent) => void;
}

const rowMaps = (rows: NormalizedProjectRows) => ({
  items: new Map(rows.items.map((row) => [row.key, row])),
  revisions: new Map(rows.revisions.map((row) => [row.key, row])),
  findings: new Map(rows.findings.map((row) => [row.key, row])),
  courtRecord: new Map(rows.courtRecord.map((row) => [row.key, row])),
  certifications: new Map(rows.certifications.map((row) => [row.key, row])),
});

const assertExistingImmutableRows = <Row extends { readonly key: string }>(
  existing: readonly Row[],
  candidate: ReadonlyMap<string, Row>,
  table: string,
): void => {
  for (const row of existing) {
    const replacement = candidate.get(row.key);
    if (replacement === undefined) {
      throw new StorageImmutableWriteError(`${table} row ${row.key} would be deleted.`);
    }
    if (!sameValue(row, replacement)) {
      throw new StorageImmutableWriteError(`${table} row ${row.key} would be rewritten.`);
    }
  }
};

const assertPrefixHistory = <Row>(
  previous: readonly Row[],
  candidate: readonly Row[],
  table: string,
): void => {
  if (candidate.length < previous.length || previous.some((row, index) => !sameValue(row, candidate[index]))) {
    throw new StorageImmutableWriteError(`${table} history must append without rewriting prior rows.`);
  }
};

const addOnly = async <Row extends { readonly key: string }>(
  table: Table<Row, string>,
  existing: readonly Row[],
  candidates: readonly Row[],
  tableName: string,
): Promise<void> => {
  const existingByKey = new Map(existing.map((row) => [row.key, row]));
  const candidateByKey = new Map<string, Row>();
  for (const candidate of candidates) {
    const duplicate = candidateByKey.get(candidate.key);
    if (duplicate !== undefined && !sameValue(duplicate, candidate)) {
      throw new StorageImmutableWriteError(`${tableName} has duplicate keys with different payloads.`);
    }
    candidateByKey.set(candidate.key, candidate);
    const prior = existingByKey.get(candidate.key);
    if (prior !== undefined && !sameValue(prior, candidate)) {
      throw new StorageImmutableWriteError(`${tableName} row ${candidate.key} would be rewritten.`);
    }
  }
  const additions = [...candidateByKey.values()].filter((candidate) => !existingByKey.has(candidate.key));
  if (additions.length > 0) await table.bulkAdd([...additions]);
};

const evidenceCandidatesForAppend = (
  previousHeader: ProjectHeaderRow,
  previousRows: readonly EvidenceRow[],
  candidate: NormalizedProjectRows,
): readonly EvidenceRow[] => {
  const previousLatest = latestEvidenceRows(previousRows);
  const candidateById = new Map(candidate.evidence.map((row) => [row.evidenceId, row]));
  if (candidateById.size !== candidate.evidence.length) {
    throw new StorageImmutableWriteError("Evidence ids must be unique.");
  }
  for (const id of previousHeader.evidenceOrder) {
    if (!candidateById.has(id)) throw new StorageImmutableWriteError(`Evidence ${id} would be removed.`);
  }
  const additions: EvidenceRow[] = [];
  for (const candidateRow of candidate.evidence) {
    const previous = previousLatest.get(candidateRow.evidenceId);
    if (previous === undefined) {
      additions.push(candidateRow);
      continue;
    }
    if (!sameValue(previous.evidence, candidateRow.evidence)) {
      const nextVersion = previous.version + 1;
      additions.push({
        ...candidateRow,
        version: nextVersion,
        key: evidenceKey(candidateRow.projectId, candidateRow.evidenceId, nextVersion),
      });
    }
  }
  return additions;
};

/**
 * One-time aggregate initialization. It deliberately refuses to touch any
 * pre-existing project namespace so callers cannot use it as a rewrite API.
 */
export const initializeProject = async (db: CueBenchDatabase, project: CaptionProject): Promise<void> => {
  const checked = validateCaptionProject(project);
  await db.transaction("rw", projectTables(db), async () => {
    const projectId = checked.projectId;
    const [header, itemCount, revisionCount, findingCount, evidenceCount, courtCount, certificationCount] = await Promise.all([
      db.projectHeaders.get(projectId),
      db.items.where("projectId").equals(projectId).count(),
      db.revisions.where("projectId").equals(projectId).count(),
      db.findings.where("projectId").equals(projectId).count(),
      db.evidence.where("projectId").equals(projectId).count(),
      db.courtRecord.where("projectId").equals(projectId).count(),
      db.certifications.where("projectId").equals(projectId).count(),
    ]);
    if (header !== undefined || itemCount + revisionCount + findingCount + evidenceCount + courtCount + certificationCount > 0) {
      throw new StorageImmutableWriteError(`Project ${projectId} is already initialized.`);
    }
    const now = Date.now();
    const rows = normalizeProject(checked, { createdAtMs: now, updatedAtMs: now });
    await db.projectHeaders.add(rows.header);
    if (rows.items.length > 0) await db.items.bulkAdd([...rows.items]);
    if (rows.revisions.length > 0) await db.revisions.bulkAdd([...rows.revisions]);
    if (rows.findings.length > 0) await db.findings.bulkAdd([...rows.findings]);
    if (rows.evidence.length > 0) await db.evidence.bulkAdd([...rows.evidence]);
    if (rows.courtRecord.length > 0) await db.courtRecord.bulkAdd([...rows.courtRecord]);
    if (rows.certifications.length > 0) await db.certifications.bulkAdd([...rows.certifications]);
  });
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

export const loadProject = async (db: CueBenchDatabase, projectId: string): Promise<CaptionProject | undefined> =>
  db.transaction("r", projectTables(db), async () => loadProjectInTransaction(db, projectId));

/**
 * Internal command persistence primitive. The caller supplies the exact
 * aggregate it read in the same transaction; this routine appends histories,
 * updates projections, and advances the header through a persisted CAS.
 */
export const appendAcceptedProjectInTransaction = async (
  db: CueBenchDatabase,
  previous: CaptionProject,
  accepted: CaptionProject,
  options: WriteProjectOptions = {},
): Promise<void> => {
  const before = validateCaptionProject(previous);
  const after = validateCaptionProject(accepted);
  if (after.projectId !== before.projectId || after.projectRevision !== before.projectRevision + 1) {
    throw new StorageImmutableWriteError("Accepted command must advance exactly one project revision.");
  }
  const header = await db.projectHeaders.get(before.projectId);
  if (header === undefined) throw new StorageStaleWriteError(before.projectId);
  const previousHeader = parseStored<ProjectHeaderRow>(ProjectHeaderRowSchema, header, "project headers");
  if (previousHeader.projectRevision !== before.projectRevision) throw new StorageStaleWriteError(before.projectId);

  const [existingItems, existingRevisions, existingFindings, existingEvidence, existingCourt, existingCertifications] = await Promise.all([
    db.items.where("projectId").equals(before.projectId).toArray(),
    db.revisions.where("projectId").equals(before.projectId).toArray(),
    db.findings.where("projectId").equals(before.projectId).toArray(),
    db.evidence.where("projectId").equals(before.projectId).toArray(),
    db.courtRecord.where("projectId").equals(before.projectId).toArray(),
    db.certifications.where("projectId").equals(before.projectId).toArray(),
  ]);
  const previousRows: NormalizedProjectRows = {
    header: previousHeader,
    items: existingItems,
    revisions: existingRevisions,
    findings: existingFindings,
    evidence: existingEvidence,
    courtRecord: existingCourt,
    certifications: existingCertifications,
  };
  /** Rehydration confirms caller did not provide a stale or fabricated base aggregate. */
  if (!sameValue(rehydrateProject(previousRows), before)) throw new StorageStaleWriteError(before.projectId);

  const candidate = normalizeProject(after, {
    createdAtMs: previousHeader.createdAtMs,
    updatedAtMs: Date.now(),
  });
  const maps = rowMaps(candidate);
  assertExistingImmutableRows(existingRevisions, maps.revisions, "Revision");
  assertPrefixHistory(
    [...existingCourt].sort((left, right) => left.sequence - right.sequence),
    candidate.courtRecord,
    "Court Record",
  );
  assertPrefixHistory(
    [...existingCertifications].sort((left, right) => left.sequence - right.sequence),
    candidate.certifications,
    "Certification",
  );

  const candidateItemMap = maps.items;
  for (const existing of existingItems) {
    const replacement = candidateItemMap.get(existing.key);
    if (replacement === undefined || replacement.kind !== existing.kind) {
      throw new StorageImmutableWriteError(`Item ${existing.itemId} would be removed or change kind.`);
    }
  }
  await addOnly(db.revisions, existingRevisions, candidate.revisions, "Revision");
  await addOnly(db.findings, existingFindings, candidate.findings, "Finding");
  const newEvidence = evidenceCandidatesForAppend(previousHeader, existingEvidence, candidate);
  if (newEvidence.length > 0) await db.evidence.bulkAdd([...newEvidence]);
  await addOnly(db.certifications, existingCertifications, candidate.certifications, "Certification");
  if (options.beforeCourtRecordWrite !== undefined) {
    for (const event of candidate.courtRecord.slice(existingCourt.length)) options.beforeCourtRecordWrite(event.event);
  }
  await addOnly(db.courtRecord, existingCourt, candidate.courtRecord, "Court Record");

  const existingItemsByKey = new Map(existingItems.map((row) => [row.key, row]));
  const changedItems = candidate.items.filter((row) => !sameValue(existingItemsByKey.get(row.key), row));
  if (changedItems.length > 0) await db.items.bulkPut([...changedItems]);

  const changed = await db.projectHeaders
    .where("[projectId+projectRevision]")
    .equals([before.projectId, before.projectRevision])
    .modify((row) => Object.assign(row, candidate.header));
  if (changed !== 1) throw new StorageStaleWriteError(before.projectId);
};

export const validateSourceBlobRow = (value: unknown): SourceBlobRow => {
  const row = parseStored<SourceBlobRow>(SourceBlobRowSchema, value, "source blobs");
  if (row.key !== sourceBlobKey(row.projectId, row.sha256)) {
    throw new StorageReadValidationError("source blobs", "Row primary key does not match the canonical source hash.");
  }
  if (row.byteLength !== row.blob.size) {
    throw new StorageReadValidationError("source blobs", "Stored byte length does not match Blob size.");
  }
  return row;
};

export const validateNarrationBlobRow = (value: unknown): NarrationBlobRow => {
  const row = parseStored<NarrationBlobRow>(NarrationBlobRowSchema, value, "narration blobs");
  if (row.key !== narrationBlobKey(row.projectId, row.beatId, row.itemRevision)) {
    throw new StorageReadValidationError("narration blobs", "Row primary key does not match narration fields.");
  }
  if (row.byteLength !== row.blob.size) {
    throw new StorageReadValidationError("narration blobs", "Stored byte length does not match Blob size.");
  }
  return row;
};

export const validateRunReceiptRow = (value: unknown): RunReceiptRow => {
  const row = parseStored<RunReceiptRow>(RunReceiptRowSchema, value, "run receipts");
  if (row.key !== runReceiptKey(row.projectId, row.runId)) {
    throw new StorageReadValidationError("run receipts", "Row primary key does not match run receipt fields.");
  }
  return row;
};

export const validateSettingRow = (value: unknown): SettingRow =>
  parseStored<SettingRow>(SettingRowSchema, value, "settings");
