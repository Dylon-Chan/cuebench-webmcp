import { z } from "zod";
import {
  ContractVersionSchema,
  DomainErrorCodeSchema,
  IdentifierSchema,
  isVerificationPackageId,
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
/** The AD run is deliberately smaller than caption generation: it is a bounded visual-review pass. */
export const MAX_STAGED_AUDIO_DESCRIPTIONS = 256;
/**
 * A provider sees at most twelve frames in one bounded visual-analysis
 * window. A staged review can cite the bounded union across windows, so its
 * retention cap is deliberately larger while remaining beneath the portable
 * project envelope.
 */
export const MAX_STAGED_AUDIO_DESCRIPTION_FRAMES = 256;
export const MAX_STAGED_EXTENDED_DESCRIPTION_REQUIREMENTS = 64;
export const MAX_LOCAL_AUDIO_DESCRIPTION_EVIDENCE_PACKAGES = 4;
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

/**
 * A compact, browser-derived caption/evidence snapshot that an AD run may
 * rely on. It has no provider transcript body: it binds only captions and
 * evidence the human has already retained in the canonical project.
 */
export const CaptionEvidenceProjectionSchema = z.object({
  contractVersion: ContractVersionSchema,
  projectId: IdentifierSchema,
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  mediaSha256: Sha256Schema,
  localEvidencePackageIds: z.array(IdentifierSchema).min(1).max(MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES),
  captions: z.array(EvidenceIntervalSchema.extend({
    itemId: IdentifierSchema,
    itemRevision: z.number().int().positive(),
    state: z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]),
    text: z.string().trim().min(1).max(1_000),
    /**
     * Every live caption fences dialogue, including a human-authored cue that
     * predates retained word evidence. Such cues deliberately carry no word
     * links; `localEvidencePackageIds` remains the separate run precondition.
     */
    evidenceIds: z.array(IdentifierSchema).max(128),
  }).strict()).min(1).max(MAX_LOCAL_CAPTION_CUES),
  evidence: z.array(EvidenceIntervalSchema.extend({
    evidenceId: IdentifierSchema,
    itemId: IdentifierSchema,
    itemRevision: z.number().int().positive(),
  }).strict()).max(MAX_LOCAL_CAPTION_EVIDENCE_WORDS),
}).strict().superRefine((value, context) => {
  const captionById = new Map(value.captions.map((caption) => [caption.itemId, caption]));
  if (captionById.size !== value.captions.length) {
    context.addIssue({ code: "custom", message: "Caption-evidence projections must not repeat caption items.", path: ["captions"] });
  }
  if (new Set(value.localEvidencePackageIds).size !== value.localEvidencePackageIds.length) {
    context.addIssue({ code: "custom", message: "Caption-evidence projections must not repeat retained package ids.", path: ["localEvidencePackageIds"] });
  }
  const seenEvidence = new Set<string>();
  for (const evidence of value.evidence) {
    const caption = captionById.get(evidence.itemId);
    if (
      caption === undefined
      || caption.itemRevision !== evidence.itemRevision
      || !caption.evidenceIds.includes(evidence.evidenceId)
      || seenEvidence.has(evidence.evidenceId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Caption-evidence links must resolve to the bounded caption context.",
        path: ["evidence"],
      });
    }
    seenEvidence.add(evidence.evidenceId);
  }
  for (const caption of value.captions) {
    if (new Set(caption.evidenceIds).size !== caption.evidenceIds.length) {
      context.addIssue({ code: "custom", message: "Caption evidence ids must be unique per caption.", path: ["captions"] });
    }
  }
});

/**
 * Separate from caption receipts on purpose. An AD receipt is bound to the
 * exact retained caption-evidence projection that guided visual analysis.
 */
export const AudioDescriptionGenerationRunReceiptSchema = z.object({
  contractVersion: ContractVersionSchema,
  version: z.literal(1),
  type: z.literal("audio-description-generation-run-receipt"),
  keyId: IdentifierSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  targetTrack: z.literal("AudioDescriptions"),
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  mediaSha256: Sha256Schema,
  captionEvidenceHash: Sha256Schema,
  sessionKey: z.string().regex(/^[0-9a-f]{64}$/),
  ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
  projectKey: z.string().regex(/^[0-9a-f]{64}$/),
  sourceByteLength: z.number().int().positive(),
  sourceDurationMs: SafeTimestampSchema.refine((value) => value > 0),
  operationId: IdentifierSchema,
  operationKey: z.string().regex(/^[0-9a-f]{64}$/),
  objectKey: z.string().min(1).max(1_000),
  issuedAtMs: SafeTimestampSchema,
  expiresAtMs: SafeTimestampSchema,
}).strict().refine((value) => value.expiresAtMs > value.issuedAtMs, {
  message: "Audio-description generation receipts must expire after they are issued.",
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
  role: z.enum(["diarization", "word-timestamps", "reconciliation", "audio-description"]),
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

export const AudioDescriptionFrameEvidenceSchema = z.object({
  evidenceId: IdentifierSchema,
  atMs: SafeTimestampSchema,
  sha256: Sha256Schema,
  mimeType: z.string().trim().min(1).max(200),
}).strict();

export const AudioDescriptionEvidenceBundleSchema = z.object({
  contractVersion: ContractVersionSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  mediaSha256: Sha256Schema,
  captionEvidenceHash: Sha256Schema,
  preparedManifest: z.object({ key: z.string().min(1).max(1_000), sha256: Sha256Schema }).strict(),
  frames: z.array(AudioDescriptionFrameEvidenceSchema).max(MAX_STAGED_AUDIO_DESCRIPTION_FRAMES),
  sceneBoundaries: z.array(SafeTimestampSchema).max(256),
  provenance: z.array(GenerationProviderProvenanceSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.frames.map((frame) => frame.evidenceId)).size !== value.frames.length) {
    context.addIssue({ code: "custom", message: "Audio-description frame evidence ids must be unique.", path: ["frames"] });
  }
  if (value.provenance.some((entry) => entry.role !== "audio-description")) {
    context.addIssue({ code: "custom", message: "Audio-description evidence may retain only visual-analysis provenance.", path: ["provenance"] });
  }
});

export const StagedAudioDescriptionBeatSchema = EvidenceIntervalSchema.extend({
  beatId: IdentifierSchema,
  description: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

export const ExtendedDescriptionRequirementSchema = z.object({
  requirementId: IdentifierSchema,
  /** Retained as review context, never surfaced as an asserted model fact. */
  text: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
  reason: z.enum(["no-compatible-speech-gap", "requires-human-judgment", "insufficient-visual-evidence"]),
}).strict();

/** A staged AD result stays isolated from the caption result contract. */
export const StagedAudioDescriptionGenerationResultSchema = z.object({
  contractVersion: ContractVersionSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  targetTrack: z.literal("AudioDescriptions"),
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  mediaSha256: Sha256Schema,
  captionEvidenceHash: Sha256Schema,
  evidence: AudioDescriptionEvidenceBundleSchema,
  audioDescriptions: z.array(StagedAudioDescriptionBeatSchema).max(MAX_STAGED_AUDIO_DESCRIPTIONS),
  extendedDescriptionRequirements: z.array(ExtendedDescriptionRequirementSchema).max(MAX_STAGED_EXTENDED_DESCRIPTION_REQUIREMENTS),
  outputSha256: Sha256Schema.optional(),
  createdAtMs: SafeTimestampSchema,
  expiresAtMs: SafeTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs || value.expiresAtMs - value.createdAtMs > 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", message: "Staged audio-description results must retain private artifacts for no more than 24 hours.", path: ["expiresAtMs"] });
  }
  if (
    value.evidence.runId !== value.runId
    || value.evidence.projectId !== value.projectId
    || value.evidence.mediaSha256.toLowerCase() !== value.mediaSha256.toLowerCase()
    || value.evidence.captionEvidenceHash.toLowerCase() !== value.captionEvidenceHash.toLowerCase()
  ) {
    context.addIssue({ code: "custom", message: "Audio-description evidence must bind to its staged run, media, and caption-evidence base.", path: ["evidence"] });
  }
  const frameIds = new Set(value.evidence.frames.map((frame) => frame.evidenceId));
  const generatedIds = new Set<string>();
  const requirementIds = new Set<string>();
  for (const beat of value.audioDescriptions) {
    if (generatedIds.has(beat.beatId) || beat.evidenceIds.some((evidenceId) => !frameIds.has(evidenceId))) {
      context.addIssue({ code: "custom", message: "Audio-description proposals must have unique ids and resolve retained frame evidence.", path: ["audioDescriptions"] });
    }
    generatedIds.add(beat.beatId);
  }
  for (const requirement of value.extendedDescriptionRequirements) {
    if (requirementIds.has(requirement.requirementId) || requirement.evidenceIds.some((evidenceId) => !frameIds.has(evidenceId))) {
      context.addIssue({ code: "custom", message: "Extended-description requirements must have unique ids and resolve retained frame evidence.", path: ["extendedDescriptionRequirements"] });
    }
    requirementIds.add(requirement.requirementId);
  }
});

export const CueEvidenceBindingSchema = z.object({
  cueId: IdentifierSchema,
  itemId: IdentifierSchema,
  itemRevision: z.number().int().positive(),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

/**
 * Durable reverse link for a Human evidence reconciliation. Generated source
 * packages omit it; every package created by VerifyItemEvidence must carry it.
 */
export const HumanEvidenceVerificationSchema = z.object({
  kind: z.literal("HumanEvidenceVerification"),
  eventId: IdentifierSchema,
  sourcePackageId: IdentifierSchema,
  actor: z.object({ type: z.literal("Human"), id: IdentifierSchema }).strict(),
  itemId: IdentifierSchema,
  itemRevision: ProjectRevisionSchema,
}).strict();

const assertVerificationArtifactIds = (
  value: {
    readonly packageId: string;
    readonly verification?: unknown;
    readonly bindings: readonly { readonly evidenceIds: readonly string[] }[];
  },
  context: z.RefinementCtx,
): void => {
  if (value.verification === undefined) return;
  if (!isVerificationPackageId(value.packageId)) {
    context.addIssue({ code: "custom", message: "Human verification package ids must use the canonical artifact grammar.", path: ["packageId"] });
  }
  for (const [bindingIndex, binding] of value.bindings.entries()) {
    for (const [evidenceIndex, evidenceId] of binding.evidenceIds.entries()) {
      if (!isVerificationPackageId(evidenceId)) {
        context.addIssue({
          code: "custom",
          message: "Human verification evidence ids must use the canonical artifact grammar.",
          path: ["bindings", bindingIndex, "evidenceIds", evidenceIndex],
        });
      }
    }
  }
};

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
  verification: HumanEvidenceVerificationSchema.optional(),
  evidence: CaptionEvidenceBundleSchema,
  cueBindings: z.array(CueEvidenceBindingSchema).max(MAX_LOCAL_CAPTION_CUES),
}).strict().superRefine((value, context) => {
  assertVerificationArtifactIds({ packageId: value.packageId, verification: value.verification, bindings: value.cueBindings }, context);
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

export const AudioDescriptionEvidenceBindingSchema = z.object({
  beatId: IdentifierSchema,
  itemId: IdentifierSchema,
  itemRevision: z.number().int().positive(),
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

export const ExtendedDescriptionRequirementEvidenceBindingSchema = z.object({
  requirementId: IdentifierSchema,
  evidenceIds: z.array(IdentifierSchema).min(1).max(128),
}).strict();

/**
 * Compact visual evidence retained after a Human adopts an AD run. It never
 * contains source video or synthesized TTS audio—only hashes, timestamps,
 * provider provenance, and the evidence links the reviewer can inspect.
 */
export const LocalAudioDescriptionEvidencePackageSchema = z.object({
  packageId: IdentifierSchema,
  runId: IdentifierSchema,
  projectId: IdentifierSchema,
  mediaSha256: Sha256Schema,
  expectedProjectRevision: ProjectRevisionSchema,
  expectedQualityProfileRevision: ProjectRevisionSchema,
  captionEvidenceHash: Sha256Schema,
  retainedAtMs: SafeTimestampSchema,
  outputSha256: Sha256Schema.optional(),
  verification: HumanEvidenceVerificationSchema.optional(),
  evidence: AudioDescriptionEvidenceBundleSchema,
  beatBindings: z.array(AudioDescriptionEvidenceBindingSchema).max(MAX_STAGED_AUDIO_DESCRIPTIONS),
  requirementBindings: z.array(ExtendedDescriptionRequirementEvidenceBindingSchema).max(MAX_STAGED_EXTENDED_DESCRIPTION_REQUIREMENTS),
}).strict().superRefine((value, context) => {
  assertVerificationArtifactIds({ packageId: value.packageId, verification: value.verification, bindings: value.beatBindings }, context);
  if (
    value.evidence.runId !== value.runId
    || value.evidence.projectId !== value.projectId
    || value.evidence.mediaSha256.toLowerCase() !== value.mediaSha256.toLowerCase()
    || value.evidence.captionEvidenceHash.toLowerCase() !== value.captionEvidenceHash.toLowerCase()
  ) {
    context.addIssue({ code: "custom", message: "Local AD evidence must bind to its exact run, project, media, and caption-evidence base." });
  }
  const frames = new Set(value.evidence.frames.map((frame) => frame.evidenceId));
  const seenBeatIds = new Set<string>();
  for (const binding of value.beatBindings) {
    if (binding.itemId !== binding.beatId || seenBeatIds.has(binding.beatId) || binding.evidenceIds.some((evidenceId) => !frames.has(evidenceId))) {
      context.addIssue({ code: "custom", message: "Local AD beat evidence bindings must uniquely resolve retained frame evidence.", path: ["beatBindings"] });
    }
    seenBeatIds.add(binding.beatId);
  }
  const seenRequirementIds = new Set<string>();
  for (const binding of value.requirementBindings) {
    if (seenRequirementIds.has(binding.requirementId) || binding.evidenceIds.some((evidenceId) => !frames.has(evidenceId))) {
      context.addIssue({ code: "custom", message: "Local extended-description bindings must uniquely resolve retained frame evidence.", path: ["requirementBindings"] });
    }
    seenRequirementIds.add(binding.requirementId);
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
export type CaptionEvidenceProjection = z.infer<typeof CaptionEvidenceProjectionSchema>;
export type AudioDescriptionGenerationRunReceipt = z.infer<typeof AudioDescriptionGenerationRunReceiptSchema>;
export type CaptionEvidenceWord = z.infer<typeof CaptionEvidenceWordSchema>;
export type UncertaintySpan = z.infer<typeof UncertaintySpanSchema>;
export type GenerationProviderProvenance = z.infer<typeof GenerationProviderProvenanceSchema>;
export type CaptionEvidenceBundle = z.infer<typeof CaptionEvidenceBundleSchema>;
export type StagedCaptionCue = z.infer<typeof StagedCaptionCueSchema>;
export type StagedGenerationResult = z.infer<typeof StagedGenerationResultSchema>;
export type AudioDescriptionEvidenceBundle = z.infer<typeof AudioDescriptionEvidenceBundleSchema>;
export type StagedAudioDescriptionBeat = z.infer<typeof StagedAudioDescriptionBeatSchema>;
export type ExtendedDescriptionRequirement = z.infer<typeof ExtendedDescriptionRequirementSchema>;
export type StagedAudioDescriptionGenerationResult = z.infer<typeof StagedAudioDescriptionGenerationResultSchema>;
export type LocalCaptionEvidencePackage = z.infer<typeof LocalCaptionEvidencePackageSchema>;
export type LocalAudioDescriptionEvidencePackage = z.infer<typeof LocalAudioDescriptionEvidencePackageSchema>;
