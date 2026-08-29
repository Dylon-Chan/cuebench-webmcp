import { createProject, type CaptionProject } from "@cuebench/domain";
import { z } from "zod";
import { STORAGE_SCHEMA_VERSION, validateCaptionProject } from "./database";

const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value, {
  message: "Identifier must not have leading or trailing whitespace.",
});
const positiveInteger = z.number().int().refine(Number.isSafeInteger).positive();
const nonNegativeInteger = z.number().int().refine(Number.isSafeInteger).nonnegative();
const nonBlankText = z.string().min(1).refine((value) => value.trim().length > 0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
const actor = z.object({
  type: z.enum(["Human", "BrowserAgent", "CueBenchAI", "System"]),
  id: identifier,
}).strict();
const reviewState = z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]);

export class StorageMigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageMigrationError";
  }
}

/** The browser backup envelope intentionally excludes source-media blobs. */
export interface ProjectEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly project: CaptionProject;
}

/** A migrated aggregate is only a preview until Task 5 obtains human import consent. */
export interface ProjectPreviewDescriptor {
  readonly mode: "preview";
  readonly requiresHumanConfirmation: true;
  readonly schemaVersion: 1;
  readonly migratedFrom: number | null;
  readonly project: CaptionProject;
}

export interface ReadOnlyProjectDescriptor {
  readonly mode: "read-only";
  readonly readOnly: true;
  readonly schemaVersion: number;
  readonly reason: "NEWER_SCHEMA";
  /** Original data is retained for preview/export and is never written by this module. */
  readonly project: unknown;
}

export type ImportedProjectDescriptor = ProjectPreviewDescriptor | ReadOnlyProjectDescriptor;

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
  text: nonBlankText.max(1_000),
  speaker: nonBlankText.max(200).nullable(),
  /** Retained only to explain unavailable historical revisions; never fabricated. */
  revision: positiveInteger.default(1),
  state: reviewState,
  actor,
  cause: nonBlankText.max(1_000).default("Migrated from schema v0"),
}).strict().refine((cue) => cue.endMs > cue.startMs, {
  path: ["endMs"],
  message: "Cue must end after it starts.",
});

const LegacyAudioDescriptionSchema = z.object({
  id: identifier,
  startMs: nonNegativeInteger,
  endMs: nonNegativeInteger,
  description: nonBlankText.max(1_000),
  revision: positiveInteger.default(1),
  state: reviewState,
  actor,
  cause: nonBlankText.max(1_000).default("Migrated from schema v0"),
}).strict().refine((beat) => beat.endMs > beat.startMs, {
  path: ["endMs"],
  message: "Beat must end after it starts.",
});

const LegacyHistoryEventSchema = z.object({
  id: identifier,
  kind: nonBlankText.max(200),
  revision: positiveInteger,
  actor,
  itemId: identifier.optional(),
  detail: z.string().optional(),
}).strict();

const LegacyProjectV0Schema = z.object({
  projectId: identifier,
  revision: positiveInteger,
  name: nonBlankText.max(1_000),
  sourceMedia: LegacyMediaSchema,
  captionCues: z.array(LegacyCueSchema).default([]),
  audioDescriptionBeats: z.array(LegacyAudioDescriptionSchema).default([]),
  history: z.array(LegacyHistoryEventSchema).default([]),
}).strict();

export type LegacyProjectV0 = z.infer<typeof LegacyProjectV0Schema>;

/**
 * v0 held a single mutable item state and counters claiming past revisions.
 * It did not retain the earlier revision payloads, so fabricating proposed
 * predecessors would create false audit history. v1 therefore starts every
 * migrated item at one explicit `migrated-current` revision and records one
 * deterministic System event that legacy history is unavailable. Source blobs
 * are not part of backups, so even a formerly linked source must be relinked.
 */
export const migrateV0ToV1 = (value: unknown): ProjectEnvelopeV1 => {
  const parsed = LegacyProjectV0Schema.safeParse(value);
  if (!parsed.success) {
    throw new StorageMigrationError(`Invalid v0 project: ${parsed.error.issues[0]?.message ?? "unknown shape"}`);
  }
  const source = parsed.data;
  try {
    const project = createProject({
      projectId: source.projectId,
      title: source.name,
      media: {
        sourceId: source.sourceMedia.id,
        sha256: source.sourceMedia.hash.toLowerCase(),
        durationMs: source.sourceMedia.durationMs,
        relinkState: "Missing",
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
    const unavailableDetail = `Legacy v0 history (${source.history.length} event(s), revision ${source.revision}) is unavailable; migrated current state is the only retained audit point.`;
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      project: validateCaptionProject({
        ...project,
        courtRecord: [{
          eventId: "legacy-history-unavailable",
          projectRevision: 1,
          type: "LegacyHistoryUnavailable",
          actor: { type: "System", id: "cuebench-migration" },
          detail: unavailableDetail,
        }],
      }),
    };
  } catch (error) {
    throw new StorageMigrationError(error instanceof Error ? error.message : "Invalid v0 project data.");
  }
};

export interface ProjectMigration {
  readonly from: number;
  readonly to: 1;
  readonly migrate: (project: unknown) => ProjectEnvelopeV1;
}

/** Ordered, pure migrations. They preview data only and have no Dexie dependency. */
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
  let project: unknown = envelope.data.project;
  const migratedFrom = version === STORAGE_SCHEMA_VERSION ? null : version;
  while (version < STORAGE_SCHEMA_VERSION) {
    const migration = PROJECT_MIGRATIONS.find((candidate) => candidate.from === version);
    if (migration === undefined) throw new StorageMigrationError(`No project migration exists from schema v${version}.`);
    const migrated = migration.migrate(project);
    version = migration.to;
    project = migrated.project;
  }
  return {
    mode: "preview",
    requiresHumanConfirmation: true,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migratedFrom,
    project: validateCaptionProject(project),
  };
};

/** Alias emphasizes that this operation is pure and never writes browser storage. */
export const migrateImportedProject = describeImportedProject;
