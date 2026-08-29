import { z } from "zod";
import {
  ContractVersionSchema,
  IdentifierSchema,
  ItemRevisionSchema,
  MediaTimeSchema,
  NonNegativeIntegerSchema,
  ProjectRevisionSchema,
} from "./envelope";

export const ActorTypeSchema = z.enum([
  "Human",
  "BrowserAgent",
  "CueBenchAI",
  "System",
]);

export const ActorSchema = z.object({
  type: ActorTypeSchema,
  id: IdentifierSchema,
});

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

export const ProjectItemSnapshotSchema = z
  .object({
    itemId: IdentifierSchema,
    itemRevision: ItemRevisionSchema,
    kind: ProjectItemKindSchema,
    state: ReviewStateSchema,
    startMs: MediaTimeSchema,
    endMs: MediaTimeSchema,
  })
  .refine((item) => item.endMs > item.startMs, {
    message: "Item end time must be after its start time",
    path: ["endMs"],
  });

export const TrackSnapshotSchema = z.object({
  itemCount: NonNegativeIntegerSchema,
  currentItems: z.array(ProjectItemSnapshotSchema),
});

export const MediaSourceSnapshotSchema = z.object({
  sourceId: IdentifierSchema,
  sha256: z.string().trim().min(1),
  durationMs: MediaTimeSchema,
  relinkState: z.enum(["Linked", "Missing", "TemporarySession"]),
});

export const SelectionSnapshotSchema = z.object({
  itemId: IdentifierSchema,
  itemRevision: ItemRevisionSchema,
  kind: ProjectItemKindSchema,
});

export const ValidationSnapshotSchema = z.object({
  status: z.enum(["NotRun", "Current", "Stale"]),
  blockerCount: NonNegativeIntegerSchema,
  warningCount: NonNegativeIntegerSchema,
});

export const CertificationSnapshotSchema = z.object({
  status: z.enum(["NotCertified", "Current", "Stale"]),
  certificationId: IdentifierSchema.nullable(),
});

export const ProjectSnapshotSchema = z.object({
  contractVersion: ContractVersionSchema,
  projectId: IdentifierSchema,
  projectRevision: ProjectRevisionSchema,
  title: z.string().trim().min(1),
  media: MediaSourceSnapshotSchema,
  captions: TrackSnapshotSchema,
  audioDescriptions: TrackSnapshotSchema,
  selectedItem: SelectionSnapshotSchema.nullable(),
  validation: ValidationSnapshotSchema,
  certification: CertificationSnapshotSchema,
});

export type ActorType = z.infer<typeof ActorTypeSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export type ProjectItemKind = z.infer<typeof ProjectItemKindSchema>;
export type ProjectItemSnapshot = z.infer<typeof ProjectItemSnapshotSchema>;
export type TrackSnapshot = z.infer<typeof TrackSnapshotSchema>;
export type MediaSourceSnapshot = z.infer<typeof MediaSourceSnapshotSchema>;
export type SelectionSnapshot = z.infer<typeof SelectionSnapshotSchema>;
export type ValidationSnapshot = z.infer<typeof ValidationSnapshotSchema>;
export type CertificationSnapshot = z.infer<
  typeof CertificationSnapshotSchema
>;
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
