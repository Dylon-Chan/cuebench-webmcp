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

const SafeTimestampSchema = z.number().int().refine(Number.isSafeInteger).nonnegative();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, "Expected a SHA-256 hash.");
const EvidenceIntervalSchema = z.object({
  startMs: SafeTimestampSchema,
  endMs: SafeTimestampSchema,
}).strict().refine((value) => value.endMs > value.startMs, {
  message: "Evidence intervals must end after they start.",
  path: ["endMs"],
});

/**
 * Claims signed by the Worker before a browser may poll or request adoption.
 * The opaque signature travels separately; retaining the claims schema here
 * gives workflow, browser, and replay code one fail-closed contract.
 */
export const GenerationRunReceiptSchema = z.object({
  contractVersion: ContractVersionSchema,
  /** Signed-token protocol version, distinct from the public contract version. */
  version: z.literal(1),
  type: z.literal("generation-run-receipt"),
  keyId: IdentifierSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  targetTrack: z.literal("Captions"),
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  mediaSha256: Sha256Schema,
  /** Salted anonymous-session identity; no browser/session identifier is exposed. */
  sessionKey: z.string().regex(/^[0-9a-f]{64}$/),
  /** Browser project identity that the prepared manifest must prove before providers run. */
  sourceByteLength: z.number().int().positive(),
  sourceDurationMs: SafeTimestampSchema.refine((value) => value > 0),
  operationId: IdentifierSchema,
  operationKey: z.string().regex(/^[0-9a-f]{64}$/),
  objectKey: z.string().min(1).max(1_000),
  issuedAtMs: SafeTimestampSchema,
  expiresAtMs: SafeTimestampSchema,
}).strict().refine((value) => value.expiresAtMs > value.issuedAtMs, {
  message: "Generation receipts must expire after they are issued.",
  path: ["expiresAtMs"],
});

export const CaptionEvidenceWordSchema = EvidenceIntervalSchema.extend({
  evidenceId: IdentifierSchema,
  text: z.string().trim().min(1).max(1_000),
  speaker: z.string().trim().min(1).max(200).nullable(),
  speakerSegmentIds: z.array(IdentifierSchema).max(32),
  sourceWordIndex: z.number().int().nonnegative(),
}).strict();

export const UncertaintySpanSchema = EvidenceIntervalSchema.extend({
  uncertaintyId: IdentifierSchema,
  reason: z.enum(["speaker-conflict", "speaker-gap", "text-conflict", "timestamp-gap"]),
  evidenceIds: z.array(IdentifierSchema).min(1).max(64),
}).strict();

export const GenerationProviderProvenanceSchema = z.object({
  role: z.enum(["diarization", "word-timestamps", "reconciliation"]),
  model: z.string().trim().min(1).max(200),
  requestHash: Sha256Schema,
  responseHash: Sha256Schema,
  /** Audio transcription has no store parameter; Responses calls explicitly use false. */
  store: z.boolean().nullable(),
  requestMetadata: z.record(z.string(), z.string().trim().max(500)).default({}),
  warnings: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
}).strict();

/** Private, evidence-first package that enables a human to inspect every staged cue. */
export const CaptionEvidenceBundleSchema = z.object({
  contractVersion: ContractVersionSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  mediaSha256: Sha256Schema,
  preparedManifest: z.object({ key: z.string().min(1).max(1_000), sha256: Sha256Schema }).strict(),
  normalizedAudio: z.object({
    key: z.string().min(1).max(1_000),
    sha256: Sha256Schema,
    byteLength: z.number().int().positive(),
    durationMs: SafeTimestampSchema,
    contentType: z.string().trim().min(1).max(200),
  }).strict(),
  words: z.array(CaptionEvidenceWordSchema).max(100_000),
  uncertaintySpans: z.array(UncertaintySpanSchema).max(10_000),
  provenance: z.array(GenerationProviderProvenanceSchema).min(2).max(8),
}).strict();

export const StagedCaptionCueSchema = EvidenceIntervalSchema.extend({
  cueId: IdentifierSchema,
  text: z.string().trim().min(1).max(1_000),
  speaker: z.string().trim().min(1).max(200).nullable(),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

/**
 * A complete result is written only after every stage succeeds. It remains
 * private and recoverable until the browser performs its expected-revision
 * adoption transaction.
 */
export const StagedGenerationResultSchema = z.object({
  contractVersion: ContractVersionSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  targetTrack: z.literal("Captions"),
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  evidence: CaptionEvidenceBundleSchema,
  captions: z.array(StagedCaptionCueSchema).max(20_000),
  createdAtMs: SafeTimestampSchema,
  expiresAtMs: SafeTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs || value.expiresAtMs - value.createdAtMs > 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", message: "Staged generation results must retain private artifacts for no more than 24 hours.", path: ["expiresAtMs"] });
  }
  if (value.evidence.runId !== value.runId || value.evidence.projectId !== value.projectId) {
    context.addIssue({ code: "custom", message: "Evidence must bind to the staged generation result." });
  }
});

export const CueEvidenceBindingSchema = z.object({
  cueId: IdentifierSchema,
  itemId: IdentifierSchema,
  itemRevision: z.number().int().positive(),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

/** Browser-canonical evidence stays bounded even when a private run is larger. */
export const MAX_LOCAL_CAPTION_EVIDENCE_WORDS = 5_000;

/**
 * The browser's canonical, bounded evidence payload after human adoption.
 * It is intentionally part of the project aggregate (and therefore its
 * encrypted backup), unlike the short-lived Worker recovery receipt.
 */
export const LocalCaptionEvidencePackageSchema = z.object({
  packageId: IdentifierSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  mediaSha256: Sha256Schema,
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  retainedAtMs: SafeTimestampSchema,
  evidence: CaptionEvidenceBundleSchema,
  cueBindings: z.array(CueEvidenceBindingSchema).max(20_000),
}).strict().superRefine((value, context) => {
  if (value.evidence.runId !== value.runId || value.evidence.projectId !== value.projectId || value.evidence.mediaSha256 !== value.mediaSha256) {
    context.addIssue({ code: "custom", message: "Local evidence must bind to its exact generation run, project, and media." });
  }
  if (value.evidence.words.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
    context.addIssue({ code: "custom", message: "A Local Evidence Package may retain at most 5,000 word records.", path: ["evidence", "words"] });
  }
  const wordIds = new Set(value.evidence.words.map((word) => word.evidenceId));
  const seenBindingIds = new Set<string>();
  for (const binding of value.cueBindings) {
    if (binding.itemId !== binding.cueId) {
      context.addIssue({ code: "custom", message: "Cue evidence bindings must resolve to their adopted cue item.", path: ["cueBindings"] });
    }
    for (const evidenceId of binding.evidenceIds) {
      if (!wordIds.has(evidenceId) || seenBindingIds.has(evidenceId)) {
        context.addIssue({ code: "custom", message: "Cue evidence bindings must uniquely resolve to retained word evidence.", path: ["cueBindings"] });
      }
      seenBindingIds.add(evidenceId);
    }
  }
});

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
export type GenerationRunReceipt = z.infer<typeof GenerationRunReceiptSchema>;
export type CaptionEvidenceWord = z.infer<typeof CaptionEvidenceWordSchema>;
export type UncertaintySpan = z.infer<typeof UncertaintySpanSchema>;
export type GenerationProviderProvenance = z.infer<typeof GenerationProviderProvenanceSchema>;
export type CaptionEvidenceBundle = z.infer<typeof CaptionEvidenceBundleSchema>;
export type StagedCaptionCue = z.infer<typeof StagedCaptionCueSchema>;
export type StagedGenerationResult = z.infer<typeof StagedGenerationResultSchema>;
export type LocalCaptionEvidencePackage = z.infer<typeof LocalCaptionEvidencePackageSchema>;
