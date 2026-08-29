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
  expectedProjectRevision: ProjectRevisionSchema,
  warnings: z
    .array(z.string().trim().min(1).max(500))
    .max(MAX_GENERATION_WARNINGS)
    .optional(),
});

const GenerationProgressSchema = z.number().min(0).max(1);

const NeutralGenerationRunBaseSchema = GenerationRunBaseSchema.extend({
  targetTrack: GenerationTargetTrackSchema,
});

const CaptionGenerationRunBaseSchema = GenerationRunBaseSchema.extend({
  targetTrack: z.literal("Captions"),
});

const AudioDescriptionGenerationRunBaseSchema = GenerationRunBaseSchema.extend({
  targetTrack: z.literal("AudioDescriptions"),
});

/**
 * Queued, adoption, and terminal stages apply to either target track. Media
 * preparation, evidence alignment, and transcription are caption-only; visual
 * analysis and placement are audio-description-only.
 */
const GenerationRunStatusByStageSchema = z.discriminatedUnion("stage", [
  NeutralGenerationRunBaseSchema.extend({
    stage: z.literal("Queued"),
  }),
  CaptionGenerationRunBaseSchema.extend({
    stage: z.literal("PreparingMedia"),
    progress: GenerationProgressSchema.optional(),
  }),
  CaptionGenerationRunBaseSchema.extend({
    stage: z.literal("Transcribing"),
    progress: GenerationProgressSchema.optional(),
  }),
  CaptionGenerationRunBaseSchema.extend({
    stage: z.literal("AligningEvidence"),
    progress: GenerationProgressSchema.optional(),
  }),
  CaptionGenerationRunBaseSchema.extend({
    stage: z.literal("ReconcilingTranscript"),
    progress: GenerationProgressSchema.optional(),
  }),
  CaptionGenerationRunBaseSchema.extend({
    stage: z.literal("SegmentingCaptions"),
    progress: GenerationProgressSchema.optional(),
  }),
  AudioDescriptionGenerationRunBaseSchema.extend({
    stage: z.literal("AnalyzingVisuals"),
    progress: GenerationProgressSchema.optional(),
  }),
  AudioDescriptionGenerationRunBaseSchema.extend({
    stage: z.literal("PlacingAudioDescriptions"),
    progress: GenerationProgressSchema.optional(),
  }),
  NeutralGenerationRunBaseSchema.extend({
    stage: z.literal("AwaitingAdoption"),
  }),
  NeutralGenerationRunBaseSchema.extend({
    stage: z.literal("Completed"),
    adoptedProjectRevision: ProjectRevisionSchema,
  }),
  NeutralGenerationRunBaseSchema.extend({
    stage: z.literal("Failed"),
    code: DomainErrorCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
  NeutralGenerationRunBaseSchema.extend({
    stage: z.literal("Cancelled"),
  }),
]);

export const GenerationRunStatusSchema =
  GenerationRunStatusByStageSchema.superRefine((status, context) => {
    if (
      status.stage === "Completed" &&
      status.adoptedProjectRevision <= status.expectedProjectRevision
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Completed generation must advance the expected project revision",
        path: ["adoptedProjectRevision"],
      });
    }
  });

export type GenerationTargetTrack = z.infer<
  typeof GenerationTargetTrackSchema
>;
export type GenerationRunStatus = z.infer<typeof GenerationRunStatusSchema>;
