import { z } from "zod";
import {
  ContractVersionSchema,
  CursorSchema,
  IdentifierSchema,
  ItemRevisionSchema,
  MAX_TRACK_ITEMS_PER_PAGE,
  MediaTimeSchema,
  NonNegativeIntegerSchema,
  ProjectRevisionSchema,
} from "./envelope";

export const MAX_CAPTION_TEXT_LENGTH = 1_000 as const;
export const MAX_AD_DESCRIPTION_LENGTH = 1_000 as const;
export const MAX_SPEAKER_NAME_LENGTH = 200 as const;

export const ActorTypeSchema = z.enum([
  "Human",
  "BrowserAgent",
  "CueBenchAI",
  "System",
]);

export const ActorSchema = z
  .object({
    type: ActorTypeSchema,
    id: IdentifierSchema,
  })
  .strict();

export const ReviewStateSchema = z.enum([
  "Proposed",
  "AgentReady",
  "Objected",
  "Sustained",
]);

export const ProjectItemKindSchema = z.enum([
  "CaptionCue",
  "AudioDescriptionBeat",
]);

const TimedProjectItemShape = {
  itemId: IdentifierSchema,
  itemRevision: ItemRevisionSchema,
  state: ReviewStateSchema,
  startMs: MediaTimeSchema,
  endMs: MediaTimeSchema,
};

const CaptionCueSnapshotObjectSchema = z
  .object({
    ...TimedProjectItemShape,
    kind: z.literal("CaptionCue"),
    text: z.string().trim().min(1).max(MAX_CAPTION_TEXT_LENGTH),
    speaker: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SPEAKER_NAME_LENGTH)
      .nullable()
      .optional(),
  })
  .strict();

const AudioDescriptionBeatSnapshotObjectSchema = z
  .object({
    ...TimedProjectItemShape,
    kind: z.literal("AudioDescriptionBeat"),
    description: z.string().trim().min(1).max(MAX_AD_DESCRIPTION_LENGTH),
  })
  .strict();

const hasValidTiming = (item: { startMs: number; endMs: number }) =>
  item.endMs > item.startMs;

export const CaptionCueSnapshotSchema = CaptionCueSnapshotObjectSchema.refine(
  hasValidTiming,
  {
    message: "Item end time must be after its start time",
    path: ["endMs"],
  },
);

export const AudioDescriptionBeatSnapshotSchema =
  AudioDescriptionBeatSnapshotObjectSchema.refine(hasValidTiming, {
    message: "Item end time must be after its start time",
    path: ["endMs"],
  });

export const ProjectItemSnapshotSchema = z
  .discriminatedUnion("kind", [
    CaptionCueSnapshotObjectSchema,
    AudioDescriptionBeatSnapshotObjectSchema,
  ])
  .refine(hasValidTiming, {
    message: "Item end time must be after its start time",
    path: ["endMs"],
  });

/**
 * A track snapshot is a cursor page: `items` holds at most `limit` current
 * items, `totalCount` counts the complete track, and `truncated` is true
 * exactly when `nextCursor` identifies a following page. An initial page must
 * expose a continuation when its items do not account for the whole track.
 */
export const TrackPageSchema = z
  .object({
    limit: z.number().int().positive().max(MAX_TRACK_ITEMS_PER_PAGE),
    cursor: CursorSchema.nullable(),
    nextCursor: CursorSchema.nullable(),
    truncated: z.boolean(),
    totalCount: NonNegativeIntegerSchema,
  })
  .strict();

type BoundedTrack = {
  items: readonly unknown[];
  page: z.infer<typeof TrackPageSchema>;
};

const hasConsistentTrackPage = (track: BoundedTrack) =>
  track.items.length <= track.page.limit &&
  track.page.totalCount >= track.items.length &&
  track.page.truncated === (track.page.nextCursor !== null) &&
  (track.page.cursor !== null ||
    track.page.totalCount === track.items.length ||
    track.page.nextCursor !== null);

export const CaptionTrackSnapshotSchema = z
  .object({
    kind: z.literal("Captions"),
    items: z.array(CaptionCueSnapshotSchema).max(MAX_TRACK_ITEMS_PER_PAGE),
    page: TrackPageSchema,
  })
  .strict()
  .refine(hasConsistentTrackPage, {
    message:
      "Track items must fit the requested page and agree with cursor truncation",
    path: ["page"],
  });

export const AudioDescriptionTrackSnapshotSchema = z
  .object({
    kind: z.literal("AudioDescriptions"),
    items: z
      .array(AudioDescriptionBeatSnapshotSchema)
      .max(MAX_TRACK_ITEMS_PER_PAGE),
    page: TrackPageSchema,
  })
  .strict()
  .refine(hasConsistentTrackPage, {
    message:
      "Track items must fit the requested page and agree with cursor truncation",
    path: ["page"],
  });

export const TrackSnapshotSchema = z.union([
  CaptionTrackSnapshotSchema,
  AudioDescriptionTrackSnapshotSchema,
]);

export const MediaSourceSnapshotSchema = z
  .object({
    sourceId: IdentifierSchema,
    sha256: z.string().trim().regex(/^[0-9a-f]{64}$/i),
    durationMs: MediaTimeSchema,
    relinkState: z.enum(["Linked", "Missing", "TemporarySession"]),
  })
  .strict();

export const SelectionSnapshotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      itemId: IdentifierSchema,
      itemRevision: ItemRevisionSchema,
      kind: z.literal("CaptionCue"),
    })
    .strict(),
  z
    .object({
      itemId: IdentifierSchema,
      itemRevision: ItemRevisionSchema,
      kind: z.literal("AudioDescriptionBeat"),
    })
    .strict(),
]);

export const ValidationSnapshotSchema = z
  .object({
    status: z.enum(["NotRun", "Current", "Stale"]),
    blockerCount: NonNegativeIntegerSchema,
    warningCount: NonNegativeIntegerSchema,
  })
  .strict();

export const CertificationSnapshotSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NotCertified") }).strict(),
  z
    .object({
      status: z.literal("Current"),
      certificationId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("Stale"),
      certificationId: IdentifierSchema,
    })
    .strict(),
]);

export const ProjectSnapshotSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    projectId: IdentifierSchema,
    projectRevision: ProjectRevisionSchema,
    title: z.string().trim().min(1).max(MAX_CAPTION_TEXT_LENGTH),
    media: MediaSourceSnapshotSchema,
    captions: CaptionTrackSnapshotSchema,
    audioDescriptions: AudioDescriptionTrackSnapshotSchema,
    selectedItem: SelectionSnapshotSchema.nullable(),
    validation: ValidationSnapshotSchema,
    certification: CertificationSnapshotSchema,
  })
  .strict()
  .refine(
    (project) =>
      project.certification.status !== "Current" ||
      (project.validation.status === "Current" &&
        project.validation.blockerCount === 0),
    {
      message:
        "Current certification requires current validation with no blockers",
      path: ["certification", "status"],
    },
  );

export type ActorType = z.infer<typeof ActorTypeSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export type ProjectItemKind = z.infer<typeof ProjectItemKindSchema>;
export type CaptionCueSnapshot = z.infer<typeof CaptionCueSnapshotSchema>;
export type AudioDescriptionBeatSnapshot = z.infer<
  typeof AudioDescriptionBeatSnapshotSchema
>;
export type ProjectItemSnapshot = z.infer<typeof ProjectItemSnapshotSchema>;
export type TrackPage = z.infer<typeof TrackPageSchema>;
export type CaptionTrackSnapshot = z.infer<typeof CaptionTrackSnapshotSchema>;
export type AudioDescriptionTrackSnapshot = z.infer<
  typeof AudioDescriptionTrackSnapshotSchema
>;
export type TrackSnapshot = z.infer<typeof TrackSnapshotSchema>;
export type MediaSourceSnapshot = z.infer<typeof MediaSourceSnapshotSchema>;
export type SelectionSnapshot = z.infer<typeof SelectionSnapshotSchema>;
export type ValidationSnapshot = z.infer<typeof ValidationSnapshotSchema>;
export type CertificationSnapshot = z.infer<
  typeof CertificationSnapshotSchema
>;
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
