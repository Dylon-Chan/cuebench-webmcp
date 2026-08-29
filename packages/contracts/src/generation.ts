import { z } from "zod";
import {
  ContractVersionSchema,
  DomainErrorCodeSchema,
  IdentifierSchema,
  MAX_GENERATION_WARNINGS,
  ProjectRevisionSchema,
} from "./envelope";

export const GenerationTargetTrackSchema = z.enum([
  "Captions",
  "AudioDescriptions",
]);

const GenerationRunBaseSchema = z.object({
  contractVersion: ContractVersionSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  targetTrack: GenerationTargetTrackSchema,
  expectedProjectRevision: ProjectRevisionSchema,
  warnings: z
    .array(z.string().trim().min(1).max(500))
    .max(MAX_GENERATION_WARNINGS)
    .optional(),
});

const GenerationProgressSchema = z.number().min(0).max(1);

export const GenerationRunStatusSchema = z.discriminatedUnion("stage", [
  GenerationRunBaseSchema.extend({
    stage: z.literal("Queued"),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("PreparingMedia"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("Transcribing"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("AligningEvidence"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("ReconcilingTranscript"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("SegmentingCaptions"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("AnalyzingVisuals"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("PlacingAudioDescriptions"),
    progress: GenerationProgressSchema.optional(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("AwaitingAdoption"),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("Completed"),
    adoptedProjectRevision: ProjectRevisionSchema,
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("Failed"),
    code: DomainErrorCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
  GenerationRunBaseSchema.extend({
    stage: z.literal("Cancelled"),
  }),
]);

export type GenerationTargetTrack = z.infer<
  typeof GenerationTargetTrackSchema
>;
export type GenerationRunStatus = z.infer<typeof GenerationRunStatusSchema>;
