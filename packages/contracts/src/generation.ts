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
/**
 * These are deliberately below the browser backup safety envelope. A staged
 * result becomes canonical project/backup data on adoption, so accepting a
 * larger private artifact would create an export that cannot safely import.
 */
export const MAX_LOCAL_CAPTION_EVIDENCE_WORDS = 2_700;
export const MAX_LOCAL_CAPTION_CUES = 500;
/** At most four historical packages are retained, but their transcript budget is shared. */
export const MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES = 4;
/**
 * A project cannot retain four independent 2,700-word transcripts and still
 * round-trip through the browser's 50k-node import gate. This is the shared
 * retained-word budget, not a reduction of a single accepted run's limit.
 */
export const MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_WORDS = MAX_LOCAL_CAPTION_EVIDENCE_WORDS;
export const MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES = 6 * 1024 * 1024;
/**
 * Measured with the same value-node semantics as browser backup parsing.
 * The remaining import-node headroom covers canonical project evidence,
 * adopted cue revisions, Court Record, and the backup envelope.
 */
export const MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES = 31_000;
/** Keep a margin beneath the browser parser's hard 50,000-value limit. */
export const MAX_PORTABLE_PROJECT_JSON_NODES = 49_000;
/**
 * The complete compact export envelope—not only transcript evidence—must fit
 * the browser's pre-parse import ceiling. Keeping this contract-side avoids
 * a domain adoption that the web import boundary would later reject.
 */
export const MAX_PORTABLE_PROJECT_BACKUP_BYTES = 10 * 1024 * 1024;

/** Counts JSON values exactly as the browser's import safety traversal does. */
export const countJsonNodes = (value: unknown): number => {
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
    } else {
      stack.push(...Object.values(current));
    }
  }
  return nodes;
};
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
  /** Stable salted browser-project owner used for cross-session lease fencing. */
  ownerKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Salted project identity used for the server-side one-active-run fence. */
  projectKey: z.string().regex(/^[0-9a-f]{64}$/),
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
  /**
   * The verbatim Whisper token before a bounded reconciliation replacement.
   * Keeping this locally lets a reviewer inspect what changed after the
   * temporary provider artifacts have been deleted.
   */
  sourceText: z.string().trim().min(1).max(1_000).optional(),
  speaker: z.string().trim().min(1).max(200).nullable(),
  speakerSegmentIds: z.array(IdentifierSchema).max(32),
  sourceWordIndex: z.number().int().nonnegative(),
}).strict();

/** Bounded diarization source excerpts addressed by `speakerSegmentIds`. */
export const SpeakerEvidenceSegmentSchema = EvidenceIntervalSchema.extend({
  id: IdentifierSchema,
  speaker: z.string().trim().min(1).max(200),
  /** The provider segment may be larger; canonical project evidence retains a bounded excerpt. */
  text: z.string().trim().min(1).max(1_000),
}).strict();

export const UncertaintySpanSchema = EvidenceIntervalSchema.extend({
  uncertaintyId: IdentifierSchema,
  reason: z.enum(["speaker-conflict", "speaker-gap", "text-conflict", "timestamp-gap"]),
  evidenceIds: z.array(IdentifierSchema).min(1).max(64),
}).strict();

const ProviderEndpointSchema = z.object({
  path: z.string().trim().min(1).max(500),
  method: z.enum(["POST", "FIXTURE"]),
  /** Exact bounded provider request parameters, excluding raw media/prompt bodies. */
  parameters: z.record(z.string().trim().min(1).max(80), z.string().trim().max(500)),
}).strict();

const ProviderPromptSchema = z.object({
  version: z.string().trim().min(1).max(120),
  sha256: Sha256Schema,
}).strict();

const ProviderStructuredOutputSchema = z.object({
  version: z.string().trim().min(1).max(120),
  sha256: Sha256Schema,
  strict: z.literal(true),
}).strict();

const ProviderQualityProfileSchema = z.object({
  revision: ProjectRevisionSchema,
  rulesSha256: Sha256Schema,
}).strict();

const ProviderTimingSchema = z.object({
  startedAtMs: SafeTimestampSchema,
  completedAtMs: SafeTimestampSchema,
  durationMs: SafeTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.completedAtMs < value.startedAtMs || value.durationMs !== value.completedAtMs - value.startedAtMs) {
    context.addIssue({ code: "custom", message: "Provider timing must be a non-negative exact elapsed interval." });
  }
});

const ProviderUsageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("audio-duration"), seconds: z.number().finite().nonnegative() }).strict(),
  z.object({
    kind: z.literal("tokens"),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.string().trim().min(1).max(160) }).strict(),
]);

const ProviderCostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), reason: z.string().trim().min(1).max(160) }).strict(),
  z.object({ kind: z.literal("estimated"), currency: z.literal("USD"), micros: z.number().int().nonnegative() }).strict(),
]);

export const GenerationProviderProvenanceSchema = z.object({
  role: z.enum(["diarization", "word-timestamps", "reconciliation"]),
  model: z.string().trim().min(1).max(200),
  requestHash: Sha256Schema,
  responseHash: Sha256Schema,
  /** Audio transcription has no store parameter; Responses calls explicitly use false. */
  store: z.boolean().nullable(),
  requestMetadata: z.record(z.string(), z.string().trim().max(500)).default({}),
  warnings: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  /** v2 fields are emitted by every new run; optional only to import v1 backups safely. */
  provenanceVersion: z.literal(2).optional(),
  disposition: z.enum(["executed", "skipped"]).optional(),
  skippedReason: z.enum(["no-uncertainty"]).nullable().optional(),
  provider: z.enum(["fixture", "openai"]).nullable().optional(),
  mode: z.enum(["fixture", "live"]).nullable().optional(),
  endpoint: ProviderEndpointSchema.nullable().optional(),
  prompt: ProviderPromptSchema.nullable().optional(),
  structuredOutput: ProviderStructuredOutputSchema.nullable().optional(),
  qualityProfile: ProviderQualityProfileSchema.optional(),
  timing: ProviderTimingSchema.nullable().optional(),
  usage: ProviderUsageSchema.optional(),
  cost: ProviderCostSchema.optional(),
  sourceMediaSha256: Sha256Schema.optional(),
}).strict();

/**
 * New Worker staging uses this strict v2 boundary. The broader public schema
 * above deliberately retains read-only import compatibility for v1 backups.
 */
export const StrictGenerationProviderProvenanceSchema = GenerationProviderProvenanceSchema.extend({
  provenanceVersion: z.literal(2),
  disposition: z.enum(["executed", "skipped"]),
  skippedReason: z.enum(["no-uncertainty"]).nullable(),
  provider: z.enum(["fixture", "openai"]).nullable(),
  mode: z.enum(["fixture", "live"]).nullable(),
  endpoint: ProviderEndpointSchema.nullable(),
  prompt: ProviderPromptSchema.nullable(),
  structuredOutput: ProviderStructuredOutputSchema.nullable(),
  qualityProfile: ProviderQualityProfileSchema,
  timing: ProviderTimingSchema.nullable(),
  usage: ProviderUsageSchema,
  cost: ProviderCostSchema,
  sourceMediaSha256: Sha256Schema,
}).superRefine((value, context) => {
  if (value.disposition === "executed") {
    if (value.skippedReason !== null || value.provider === null || value.mode === null || value.endpoint === null || value.timing === null) {
      context.addIssue({ code: "custom", message: "Executed provider provenance must retain provider, endpoint, and timing facts." });
    }
  } else if (
    value.role !== "reconciliation"
    || value.skippedReason !== "no-uncertainty"
    || value.provider !== null
    || value.mode !== null
    || value.endpoint !== null
    || value.timing !== null
  ) {
    context.addIssue({ code: "custom", message: "Only reconciliation may be explicitly skipped without a provider call." });
  }
});

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
  words: z.array(CaptionEvidenceWordSchema).max(MAX_LOCAL_CAPTION_EVIDENCE_WORDS),
  /**
   * Present on every newly staged run. Optional only for read-only v1
   * backup compatibility, where old word segment ids were not resolvable.
   */
  speakerSegments: z.array(SpeakerEvidenceSegmentSchema).max(MAX_LOCAL_CAPTION_EVIDENCE_WORDS).optional(),
  uncertaintySpans: z.array(UncertaintySpanSchema).max(MAX_LOCAL_CAPTION_EVIDENCE_WORDS),
  provenance: z.array(GenerationProviderProvenanceSchema).min(2).max(8),
}).strict().superRefine((value, context) => {
  if (value.speakerSegments === undefined) return;
  const segments = new Set(value.speakerSegments.map((segment) => segment.id));
  for (const word of value.words) {
    for (const segmentId of word.speakerSegmentIds) {
      if (!segments.has(segmentId)) {
        context.addIssue({
          code: "custom",
          message: "Word speaker evidence must resolve to a retained diarization segment.",
          path: ["words"],
        });
      }
    }
  }
});

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
  captions: z.array(StagedCaptionCueSchema).max(MAX_LOCAL_CAPTION_CUES),
  /** SHA-256 of the complete staged payload excluding this field itself. */
  outputSha256: Sha256Schema.optional(),
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
  /** Hash of the complete staged payload, retained after R2 artifact cleanup. */
  outputSha256: Sha256Schema.optional(),
  evidence: CaptionEvidenceBundleSchema,
  cueBindings: z.array(CueEvidenceBindingSchema).max(MAX_LOCAL_CAPTION_CUES),
}).strict().superRefine((value, context) => {
  if (value.evidence.runId !== value.runId || value.evidence.projectId !== value.projectId || value.evidence.mediaSha256 !== value.mediaSha256) {
    context.addIssue({ code: "custom", message: "Local evidence must bind to its exact generation run, project, and media." });
  }
  if (value.evidence.words.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
    context.addIssue({ code: "custom", message: "A Local Evidence Package may retain at most 2,700 word records.", path: ["evidence", "words"] });
  }
  if (countJsonNodes(value) > MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES) {
    context.addIssue({
      code: "custom",
      message: "A Local Evidence Package exceeds CueBench's portable JSON-node budget.",
    });
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
