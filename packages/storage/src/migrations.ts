import { ActorSchema, ReviewStateSchema } from "@cuebench/contracts";
import {
  createProject,
  type AudioDescriptionBeat,
  type AudioDescriptionBeatRevision,
  type CaptionCue,
  type CaptionCueRevision,
  type CaptionProject,
  type DomainEvent,
} from "@cuebench/domain";
import { z } from "zod";
import {
  CueBenchDatabase,
  STORAGE_SCHEMA_VERSION,
  saveProject,
  validateCaptionProject,
} from "./database";

const identifier = z.string().trim().min(1).max(200);
const positiveInteger = z.number().int().refine(Number.isSafeInteger).positive();
const nonNegativeInteger = z.number().int().refine(Number.isSafeInteger).nonnegative();
const sha256 = z.string().trim().regex(/^[0-9a-f]{64}$/i);

export class StorageMigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageMigrationError";
  }
}

/** The browser backup envelope intentionally does not include source blobs. */
export interface ProjectEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly project: CaptionProject;
}

export interface WritableProjectDescriptor {
  readonly mode: "read-write";
  readonly readOnly: false;
  readonly schemaVersion: 1;
  readonly migratedFrom: number | null;
  readonly project: CaptionProject;
}

export interface ReadOnlyProjectDescriptor {
  readonly mode: "read-only";
  readonly readOnly: true;
  readonly schemaVersion: number;
  readonly reason: "NEWER_SCHEMA";
  /** Keep the original envelope for preview/export without writing it locally. */
  readonly project: unknown;
}

export type ImportedProjectDescriptor = WritableProjectDescriptor | ReadOnlyProjectDescriptor;

const ImportedEnvelopeSchema = z.object({
  schemaVersion: nonNegativeInteger,
  project: z.unknown(),
}).strict();

const LegacyMediaSchema = z.object({
  id: identifier,
  hash: sha256,
  durationMs: nonNegativeInteger,
  linked: z.boolean(),
}).strict();

const LegacyCueSchema = z.object({
  id: identifier,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  text: z.string().min(1).max(1_000).refine((value) => value.trim().length > 0),
  speaker: z.string().min(1).max(200).refine((value) => value.trim().length > 0).nullable(),
  revision: positiveInteger.default(1),
  state: ReviewStateSchema,
  actor: ActorSchema,
  cause: z.string().trim().min(1).default("Migrated from schema v0"),
}).strict().refine((cue) => cue.endMs > cue.startMs, { path: ["endMs"], message: "Cue must end after it starts." });

const LegacyAudioDescriptionSchema = z.object({
  id: identifier,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  description: z.string().min(1).max(1_000).refine((value) => value.trim().length > 0),
  revision: positiveInteger.default(1),
  state: ReviewStateSchema,
  actor: ActorSchema,
  cause: z.string().trim().min(1).default("Migrated from schema v0"),
}).strict().refine((beat) => beat.endMs > beat.startMs, { path: ["endMs"], message: "Beat must end after it starts." });

const LegacyHistoryEventSchema = z.object({
  id: identifier,
  kind: z.string().trim().min(1),
  revision: positiveInteger,
  actor: ActorSchema,
  itemId: identifier.optional(),
  detail: z.string().optional(),
}).strict();

const LegacyProjectV0Schema = z.object({
  projectId: identifier,
  revision: positiveInteger,
  name: z.string().trim().min(1).max(1_000),
  sourceMedia: LegacyMediaSchema,
  captionCues: z.array(LegacyCueSchema).default([]),
  audioDescriptionBeats: z.array(LegacyAudioDescriptionSchema).default([]),
  history: z.array(LegacyHistoryEventSchema).default([]),
}).strict();

export type LegacyProjectV0 = z.infer<typeof LegacyProjectV0Schema>;

const previousCaptionRevisions = (
  item: CaptionCue,
  count: number,
): readonly CaptionCueRevision[] => Array.from({ length: count }, (_, index) => ({
  ...item.current,
  itemRevision: index + 1,
  state: index + 1 === count ? item.current.state : "Proposed",
  parentItemRevision: index === 0 ? null : index,
}));

const previousAudioDescriptionRevisions = (
  item: AudioDescriptionBeat,
  count: number,
): readonly AudioDescriptionBeatRevision[] => Array.from({ length: count }, (_, index) => ({
  ...item.current,
  itemRevision: index + 1,
  state: index + 1 === count ? item.current.state : "Proposed",
  parentItemRevision: index === 0 ? null : index,
}));

/**
 * v0 was a practical monolithic local draft: it named media `id`/`hash`,
 * kept a single current item revision, and recorded event names as `kind`.
 * v1 expands those records into immutable histories and the current domain
 * aggregate without inventing additional authoring changes.
 */
export const migrateV0ToV1 = (value: unknown): ProjectEnvelopeV1 => {
  const legacy = LegacyProjectV0Schema.safeParse(value);
  if (!legacy.success) {
    throw new StorageMigrationError(`Invalid v0 project: ${legacy.error.issues[0]?.message ?? "unknown shape"}`);
  }
  const source = legacy.data;
  let project: CaptionProject;
  try {
    project = createProject({
      projectId: source.projectId,
      title: source.name,
      media: {
        sourceId: source.sourceMedia.id,
        sha256: source.sourceMedia.hash,
        durationMs: source.sourceMedia.durationMs,
        relinkState: source.sourceMedia.linked ? "Linked" : "Missing",
      },
      captions: source.captionCues.map((cue) => ({
        kind: "CaptionCue" as const,
        itemId: cue.id,
        state: cue.state,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        speaker: cue.speaker,
        actor: cue.actor,
        cause: cue.cause,
      })),
      audioDescriptions: source.audioDescriptionBeats.map((beat) => ({
        kind: "AudioDescriptionBeat" as const,
        itemId: beat.id,
        state: beat.state,
        startMs: beat.startMs,
        endMs: beat.endMs,
        description: beat.description,
        actor: beat.actor,
        cause: beat.cause,
      })),
    });
  } catch (error) {
    throw new StorageMigrationError(error instanceof Error ? error.message : "Invalid v0 project data.");
  }
  const captions: Record<string, CaptionCue> = {};
  for (const cue of source.captionCues) {
    const item = project.captions.items[cue.id];
    if (item === undefined) throw new StorageMigrationError("Migrated cue is missing.");
    const revisions = previousCaptionRevisions(item, cue.revision);
    captions[cue.id] = { ...item, revisions, current: revisions.at(-1)! };
  }
  const audioDescriptions: Record<string, AudioDescriptionBeat> = {};
  for (const beat of source.audioDescriptionBeats) {
    const item = project.audioDescriptions.items[beat.id];
    if (item === undefined) throw new StorageMigrationError("Migrated audio-description beat is missing.");
    const revisions = previousAudioDescriptionRevisions(item, beat.revision);
    audioDescriptions[beat.id] = { ...item, revisions, current: revisions.at(-1)! };
  }
  const courtRecord: DomainEvent[] = source.history.map((event) => ({
    eventId: event.id,
    projectRevision: event.revision,
    type: event.kind,
    actor: event.actor,
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  }));
  const migrated = validateCaptionProject({
    ...project,
    projectRevision: source.revision,
    captions: { ...project.captions, items: captions },
    audioDescriptions: { ...project.audioDescriptions, items: audioDescriptions },
    courtRecord,
  });
  return { schemaVersion: STORAGE_SCHEMA_VERSION, project: migrated };
};

export interface ProjectMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (project: unknown) => ProjectEnvelopeV1;
}

/** Ordered, one-way migrations for serialized project structure. */
export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  { from: 0, to: 1, migrate: migrateV0ToV1 },
];

export const describeImportedProject = (value: unknown): ImportedProjectDescriptor => {
  const envelope = ImportedEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new StorageMigrationError(`Invalid project envelope: ${envelope.error.issues[0]?.message ?? "unknown shape"}`);
  }
  if (envelope.data.schemaVersion > STORAGE_SCHEMA_VERSION) {
    return {
      mode: "read-only",
      readOnly: true,
      schemaVersion: envelope.data.schemaVersion,
      reason: "NEWER_SCHEMA",
      project: envelope.data.project,
    };
  }
  let version = envelope.data.schemaVersion;
  let project = envelope.data.project;
  const migratedFrom = version === STORAGE_SCHEMA_VERSION ? null : version;
  while (version < STORAGE_SCHEMA_VERSION) {
    const migration = PROJECT_MIGRATIONS.find((candidate) => candidate.from === version);
    if (migration === undefined) {
      throw new StorageMigrationError(`No project migration exists from schema v${version}.`);
    }
    const migrated = migration.migrate(project);
    version = migration.to;
    project = migrated.project;
  }
  return {
    mode: "read-write",
    readOnly: false,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migratedFrom,
    project: validateCaptionProject(project),
  };
};

export const migrateImportedProject = describeImportedProject;

/**
 * Persists only a supported, validated descriptor. A future schema remains a
 * read-only preview and cannot alter the browser-canonical database.
 */
export const importProject = async (
  db: CueBenchDatabase,
  value: unknown,
): Promise<ImportedProjectDescriptor> => {
  const descriptor = describeImportedProject(value);
  if (descriptor.mode === "read-write") await saveProject(db, descriptor.project);
  return descriptor;
};
