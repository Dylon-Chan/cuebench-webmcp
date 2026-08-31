import {
  CaptionEvidenceBundleSchema,
  countJsonNodes,
  MAX_LOCAL_CAPTION_CUES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES,
  MAX_LOCAL_CAPTION_EVIDENCE_WORDS,
  StagedGenerationResultSchema,
  StrictGenerationProviderProvenanceSchema,
  type CaptionEvidenceBundle,
  type CaptionEvidenceWord,
  type GenerationProviderProvenance,
  type GenerationRunStatus,
  type StagedCaptionCue,
  type StagedGenerationResult,
  type UncertaintySpan,
} from "@cuebench/contracts";
import { canonicalSerialize, resolveEducationProfileRules } from "@cuebench/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { MediaPreparation, MediaPreparationRequest, PreparedMediaManifest } from "../probe";
import {
  R2GenerationRunRecordStore,
  verifyGenerationRunReceipt,
  type GenerationRunArtifactReference,
  type GenerationRunRecord,
  type GenerationRunRecordStore,
} from "../generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "../env";
import { MediaContainerPreparationService } from "../probe";
import { fixtureMediaPreparation } from "../media-preparation-fixture";
import { verifyUploadReceipt } from "../uploads";
import {
  createOpenAIProvider,
  OpenAIProviderError,
  reconcileChunkSeamWords,
  sha256Hex,
  splitWavForOpenAITranscription,
  type ProviderCallProvenance,
  type ReconciliationRequest,
} from "../openai/client";
import { alignCaptionEvidence, normalizeForAlignment } from "../openai/transcription";
import {
  applyReconciliationWindowResults,
  createReconciliationWindows,
  reconcileCaptionEvidence,
  reconcileCaptionEvidenceWindow,
  type ReconciliationWindowResult,
} from "../openai/reconcile";

const DAY_MS = 24 * 60 * 60 * 1_000;
const clone = <Value>(value: Value): Value => structuredClone(value);
const sha256 = /^[0-9a-f]{64}$/i;
/** Keep Workflow-cached provider step output far below Cloudflare's 1 MiB cap. */
export const MAX_BILLABLE_WORKFLOW_STEP_RESULT_BYTES = 64 * 1024;

/**
 * Stage only a result that can become a canonical browser Local Evidence
 * Package. The staged R2 artifact may be larger for recovery bookkeeping,
 * but adoption must never discover a paid result cannot fit local storage.
 */
const assertCanonicalEvidencePackageBudget = (input: {
  readonly runId: string;
  readonly projectId: string;
  readonly mediaSha256: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly retainedAtMs: number;
  readonly evidence: CaptionEvidenceBundle;
  readonly captions: readonly StagedCaptionCue[];
}): void => {
  const localPackage = {
    packageId: `generation-${input.runId}`,
    runId: input.runId,
    projectId: input.projectId,
    mediaSha256: input.mediaSha256.toLowerCase(),
    expectedProjectRevision: input.expectedProjectRevision,
    expectedQualityProfileRevision: input.expectedQualityProfileRevision,
    retainedAtMs: input.retainedAtMs,
    // The final digest is not known until after this check, but every valid
    // SHA-256 has the same canonical serialized byte and node footprint.
    outputSha256: "0".repeat(64),
    evidence: input.evidence,
    cueBindings: input.captions.map((cue) => ({
      cueId: cue.cueId,
      itemId: cue.cueId,
      itemRevision: 1,
      evidenceIds: [...cue.evidenceIds],
    })),
  };
  const canonical = canonicalSerialize(localPackage);
  if (new TextEncoder().encode(canonical).byteLength > MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES) {
    throw new Error("CueBench cannot stage a canonical Local Evidence Package over 6 MiB.");
  }
  if (countJsonNodes(localPackage) > MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES) {
    throw new Error("CueBench cannot stage a canonical Local Evidence Package beyond the portable JSON-node budget.");
  }
};

export interface GenerationStartRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly targetTrack: "Captions";
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  /** Browser-canonical source digest, bound into the signed run receipt. */
  readonly mediaSha256: string;
  /** Receipt-bound browser source facts that the authoritative manifest must prove. */
  readonly sourceByteLength: number;
  readonly sourceDurationMs: number;
  /** The exact profile snapshot held by the browser when it acquired the lease. */
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
  readonly operation: Omit<MediaPreparationRequest, "idempotencyKey">;
}

export interface PreparedAudio {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly durationMs: number;
  readonly contentType: string;
}

export interface PreparedMediaManifestContents {
  readonly source: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly durationMs: number;
  };
  readonly normalizedAudio: PreparedAudio;
}

export interface SpeakerSegment {
  readonly id?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string;
  readonly text: string;
}

export interface TimestampedWord {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** An overlapped OpenAI chunk disagreed at this word boundary. */
  readonly chunkSeamConflict?: boolean;
}

export interface TranscriptionProvenance {
  readonly model: string;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly requestMetadata?: Readonly<Record<string, string>>;
  readonly warnings?: readonly string[];
  /** Measured around the concrete provider invocation, never guessed from a status poll. */
  readonly timing?: { readonly startedAtMs: number; readonly completedAtMs: number; readonly durationMs: number };
}

/** Each billable pass is checkpointed independently before the other begins. */
export interface DiarizationTranscription {
  readonly speakerSegments: readonly SpeakerSegment[];
  readonly provenance: TranscriptionProvenance;
}

/** Each billable pass is checkpointed independently before the other begins. */
export interface WordTimestampTranscription {
  readonly words: readonly TimestampedWord[];
  readonly provenance: TranscriptionProvenance;
}

/**
 * A single outbound transcription request. The request contains no audio
 * bytes: its durable identity is rebuilt from the immutable R2 WAV whenever a
 * Workflow resumes. This keeps both Workflow state and step input bounded.
 */
export interface GenerationTranscriptionRequest {
  readonly requestKey: string;
  readonly index: number;
  readonly offsetMs: number;
  readonly endMs: number;
  readonly overlapWithPreviousMs: number;
}

/** A hydrated request result passed to the deterministic aggregation ports. */
interface GenerationTranscriptionCheckpoint<Value> {
  readonly requestKey: string;
  readonly value: Value;
}

/** Durable state retains a content-addressed ref when the record store supports it. */
interface PersistedGenerationTranscriptionCheckpoint<Value> {
  readonly requestKey: string;
  readonly value?: Value;
  readonly artifactRef?: GenerationRunArtifactReference;
}

/**
 * Optional request-level transcription port. Production implements it for
 * every OpenAI WAV chunk. The legacy whole-pass port remains for small
 * fixtures, but it is never used by the live/chunked adapter.
 */
export interface ResumableTranscriptionDependencies {
  readonly requests: (input: {
    readonly runId: string;
    readonly audio: PreparedAudio;
  }) => Promise<readonly GenerationTranscriptionRequest[]>;
  readonly diarizeRequest: (input: {
    readonly runId: string;
    readonly audio: PreparedAudio;
    readonly request: GenerationTranscriptionRequest;
  }) => Promise<DiarizationTranscription>;
  readonly wordTimestampRequest: (input: {
    readonly runId: string;
    readonly audio: PreparedAudio;
    readonly request: GenerationTranscriptionRequest;
  }) => Promise<WordTimestampTranscription>;
  readonly aggregateDiarization: (input: {
    readonly runId: string;
    readonly audio: PreparedAudio;
    readonly requests: readonly GenerationTranscriptionRequest[];
    readonly results: readonly GenerationTranscriptionCheckpoint<DiarizationTranscription>[];
  }) => Promise<DiarizationTranscription>;
  readonly aggregateWordTimestamps: (input: {
    readonly runId: string;
    readonly audio: PreparedAudio;
    readonly requests: readonly GenerationTranscriptionRequest[];
    readonly results: readonly GenerationTranscriptionCheckpoint<WordTimestampTranscription>[];
  }) => Promise<WordTimestampTranscription>;
}

export interface GenerationReconciliationRequest {
  readonly requestKey: string;
  readonly window: ReconciliationRequest;
}

export interface GenerationReconciliationCheckpoint extends ReconciliationWindowResult {
  readonly requestKey: string;
  readonly timing?: ReconciliationResult["provenance"]["timing"];
}

interface PersistedGenerationReconciliationCheckpoint {
  readonly requestKey: string;
  readonly value?: GenerationReconciliationCheckpoint;
  readonly artifactRef?: GenerationRunArtifactReference;
}

/** Request-level foreground Responses API port, one durable step per window. */
export interface ResumableReconciliationDependencies {
  readonly requests: (input: {
    readonly runId: string;
    readonly alignedWords: readonly AlignedCaptionWord[];
    readonly uncertaintySpans: readonly UncertaintySpan[];
  }) => Promise<readonly GenerationReconciliationRequest[]>;
  readonly reconcileRequest: (input: {
    readonly runId: string;
    readonly request: GenerationReconciliationRequest;
  }) => Promise<GenerationReconciliationCheckpoint>;
  readonly aggregate: (input: {
    readonly runId: string;
    readonly alignedWords: readonly AlignedCaptionWord[];
    readonly uncertaintySpans: readonly UncertaintySpan[];
    readonly requests: readonly GenerationReconciliationRequest[];
    readonly results: readonly GenerationReconciliationCheckpoint[];
  }) => Promise<ReconciliationResult>;
}

export type AlignedCaptionWord = CaptionEvidenceWord;

export interface ReconciliationResult {
  readonly words: readonly AlignedCaptionWord[];
  readonly provenance: {
    readonly model: string;
    readonly requestHash: string;
    readonly responseHash: string;
    readonly store: boolean;
    readonly requestMetadata?: Readonly<Record<string, string>>;
    readonly warnings?: readonly string[];
    readonly timing?: { readonly startedAtMs: number; readonly completedAtMs: number; readonly durationMs: number };
    readonly disposition?: "executed" | "skipped";
    readonly skippedReason?: "no-uncertainty";
  };
}

export interface CaptionGenerationDependencies {
  /** Only this runner calls the Task 12 preparation capability. */
  readonly preparation: MediaPreparation;
  readonly artifacts: {
    readonly readManifest: (manifest: PreparedMediaManifest) => Promise<PreparedMediaManifestContents>;
  };
  readonly transcription: {
    readonly diarize: (input: {
      readonly runId: string;
      readonly audio: PreparedAudio;
    }) => Promise<DiarizationTranscription>;
    readonly wordTimestamps: (input: {
      readonly runId: string;
      readonly audio: PreparedAudio;
    }) => Promise<WordTimestampTranscription>;
    readonly resumable?: ResumableTranscriptionDependencies;
  };
  readonly reconciliation: {
    readonly reconcile: (input: {
      readonly runId: string;
      readonly alignedWords: readonly AlignedCaptionWord[];
      readonly uncertaintySpans: readonly UncertaintySpan[];
    }) => Promise<ReconciliationResult>;
    readonly resumable?: ResumableReconciliationDependencies;
  };
  readonly clock?: () => number;
}

export interface PersistedGenerationRun {
  readonly request: GenerationStartRequest;
  readonly stageHistory: readonly GenerationRunStatus[];
  readonly cancelled: boolean;
  /**
   * Write-ahead records for billable provider effects. OpenAI's audio API has
   * no result lookup or idempotency key, so an accepted-but-uncheckpointed
   * call is deliberately never replayed outside a Workflow-cached step.
   */
  readonly providerAttempts?: readonly GenerationProviderAttempt[];
  readonly preparedManifest?: PreparedMediaManifest;
  readonly manifest?: PreparedMediaManifestContents;
  /** Independent durable checkpoints prevent retried runs from repeating a completed billable pass. */
  readonly diarization?: DiarizationTranscription;
  readonly wordTimestamps?: WordTimestampTranscription;
  /** Request values are content-addressed R2 refs in production and cleared after aggregation. */
  readonly diarizationChunks?: readonly PersistedGenerationTranscriptionCheckpoint<DiarizationTranscription>[];
  readonly wordTimestampChunks?: readonly PersistedGenerationTranscriptionCheckpoint<WordTimestampTranscription>[];
  readonly aligned?: { readonly words: readonly AlignedCaptionWord[]; readonly uncertaintySpans: readonly UncertaintySpan[] };
  readonly reconciled?: ReconciliationResult;
  /** One bounded foreground Responses result ref per reconciliation window. */
  readonly reconciliationWindows?: readonly PersistedGenerationReconciliationCheckpoint[];
  readonly staged?: StagedGenerationResult;
}

export type BillableGenerationPass = "diarization" | "word-timestamps" | "reconciliation";

export interface GenerationProviderAttempt {
  readonly pass: BillableGenerationPass;
  /** Stable chunk/window identity; absent legacy records mean whole-pass. */
  readonly requestKey?: string;
  /** Stable idempotency evidence even where the upstream endpoint has none. */
  readonly attemptId: string;
  /** Only an explicit provider 429/5xx is provably safe to reissue. */
  readonly state: "accepted-unknown" | "retryable-failed" | "completed";
  readonly startedAtMs: number;
  readonly responseHash?: string;
}

/**
 * Cloudflare Workflow caches a successful `step.do` result. Passing this
 * executor lets a retry recover that result without contacting the provider;
 * direct/replay execution has no such proof and therefore fails closed.
 */
/**
 * The only value returned from a Cloudflare provider `step.do`. Rich provider
 * responses are first checkpointed through the R2-backed run store, then the
 * Workflow cache retains this tiny immutable pointer rather than a word-rich
 * transcript that can exceed Workflows' 1 MiB step-result limit.
 */
export interface BillableGenerationStepResult {
  readonly version: 1;
  readonly responseHash: string;
  readonly checkpoint?: GenerationRunArtifactReference;
}

export interface BillableGenerationStepExecutor {
  readonly run: (
    pass: BillableGenerationPass,
    /** Stable bounded chunk/window identity, distinct from the broad pass. */
    requestKey: string,
    work: () => Promise<BillableGenerationStepResult>,
  ) => Promise<BillableGenerationStepResult>;
}

const boundedBillableStepResult = (result: BillableGenerationStepResult): BillableGenerationStepResult => {
  if (!sha256.test(result.responseHash)) throw new Error("CueBench Workflow provider step returned an invalid response hash.");
  if (result.checkpoint !== undefined && (
    !sha256.test(result.checkpoint.sha256)
    || !Number.isSafeInteger(result.checkpoint.byteLength)
    || result.checkpoint.byteLength <= 0
    || result.checkpoint.key.length === 0
  )) throw new Error("CueBench Workflow provider step returned an invalid R2 checkpoint reference.");
  if (new TextEncoder().encode(canonicalSerialize(result)).byteLength > MAX_BILLABLE_WORKFLOW_STEP_RESULT_BYTES) {
    throw new Error("CueBench Workflow provider step result exceeds its bounded checkpoint-reference contract.");
  }
  return result;
};

export class GenerationProviderOutcomeUnknownError extends Error {
  public constructor(pass: BillableGenerationPass) {
    super(`CueBench cannot safely replay the ${pass} provider call because it may already have been accepted. Start a new generation only after reviewing this visible failed run.`);
    this.name = "GenerationProviderOutcomeUnknownError";
  }
}

/**
 * Small persistence port used by the Workflow adapter. Every transition is
 * durable before observers may see it; persisted artifacts make retries resume
 * from the last completed stage instead of repeating billable work.
 */
export interface GenerationRunStore {
  readonly initialise: (request: GenerationStartRequest) => Promise<PersistedGenerationRun>;
  readonly read: (runId: string) => Promise<PersistedGenerationRun | null>;
  readonly save: (run: PersistedGenerationRun) => Promise<void>;
  /** Present for the R2-backed Workflow adapter after a rich state checkpoint. */
  readonly workflowCheckpointReference?: (runId: string) => Promise<GenerationRunArtifactReference>;
  /** Stores one rich provider response before the Workflow step returns. */
  readonly writeProviderCheckpoint?: (runId: string, value: unknown) => Promise<GenerationRunArtifactReference>;
  /** Hydrates a request result outside the Workflow step result/state payload. */
  readonly readProviderCheckpoint?: (runId: string, reference: GenerationRunArtifactReference) => Promise<unknown | null>;
  readonly cancel: (runId: string) => Promise<void>;
}

const statusFor = (
  request: GenerationStartRequest,
  stage: GenerationRunStatus["stage"],
  extras: Readonly<Record<string, unknown>> = {},
): GenerationRunStatus => ({
  contractVersion: 1,
  runId: request.runId,
  projectId: request.projectId,
  targetTrack: "Captions",
  expectedProjectRevision: request.expectedProjectRevision,
  stage,
  ...extras,
} as GenerationRunStatus);

const appendStage = async (
  store: GenerationRunStore,
  current: PersistedGenerationRun,
  stage: GenerationRunStatus["stage"],
  extras: Readonly<Record<string, unknown>> = {},
): Promise<PersistedGenerationRun> => {
  if (current.stageHistory.at(-1)?.stage === stage) return current;
  const next: PersistedGenerationRun = { ...current, stageHistory: [...current.stageHistory, statusFor(current.request, stage, extras)] };
  await store.save(next);
  return next;
};

const isCancelled = (run: PersistedGenerationRun) => run.cancelled || run.stageHistory.at(-1)?.stage === "Cancelled";

const cancellationBoundary = async (store: GenerationRunStore, run: PersistedGenerationRun): Promise<PersistedGenerationRun | null> => {
  const current = await store.read(run.request.runId) ?? run;
  return isCancelled(current) ? appendStage(store, current, "Cancelled") : null;
};

/** Never overwrite a concurrent cancellation with an in-flight provider result. */
type PersistedArtifactPatch = {
  [Key in Exclude<keyof PersistedGenerationRun, "request" | "stageHistory" | "cancelled">]?: PersistedGenerationRun[Key] | undefined;
};

interface BillableCheckpoint {
  readonly patch: PersistedArtifactPatch;
  /** The exact rich request-output ref returned to the Workflow cache. */
  readonly stepCheckpoint?: GenerationRunArtifactReference;
}

const persistArtifacts = async (
  store: GenerationRunStore,
  run: PersistedGenerationRun,
  patch: PersistedArtifactPatch,
): Promise<PersistedGenerationRun> => {
  const latest = await store.read(run.request.runId) ?? run;
  if (isCancelled(latest)) return latest;
  const next = { ...latest } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(next, key);
    else next[key] = value;
  }
  await store.save(next as unknown as PersistedGenerationRun);
  return next as unknown as PersistedGenerationRun;
};

/**
 * The staged evidence and its adoption-visible stage share one durable write.
 * It also repairs an interrupted legacy write on resume without rerunning any
 * provider stage, while respecting a cancellation that arrived meanwhile.
 */
const persistStagedForAdoption = async (
  store: GenerationRunStore,
  run: PersistedGenerationRun,
  staged: StagedGenerationResult,
): Promise<PersistedGenerationRun> => {
  const latest = await store.read(run.request.runId) ?? run;
  if (isCancelled(latest)) return latest;
  const stageHistory = latest.stageHistory.at(-1)?.stage === "AwaitingAdoption"
    ? latest.stageHistory
    : [...latest.stageHistory, statusFor(latest.request, "AwaitingAdoption")];
  const next: PersistedGenerationRun = {
    ...latest,
    staged,
    stageHistory,
  };
  await store.save(next);
  return next;
};

/**
 * Adapter to the one tested two-pass alignment implementation. Generation
 * keeps its public evidence ids stable per run while preserving every shared
 * uncertainty and diarization link; it never reimplements tie-breaking here.
 */
export const alignSpeakerSegmentsToWords = (input: {
  readonly runId: string;
  readonly words: readonly TimestampedWord[];
  readonly speakerSegments: readonly SpeakerSegment[];
}): { readonly words: readonly AlignedCaptionWord[]; readonly uncertaintySpans: readonly UncertaintySpan[] } => {
  const shared = alignCaptionEvidence({
    text: input.speakerSegments.map((segment) => segment.text).join(" "),
    durationMs: Math.max(0, ...input.speakerSegments.map((segment) => segment.endMs), ...input.words.map((word) => word.endMs)),
    segments: input.speakerSegments.map((segment, index) => ({
      id: segment.id?.trim() || `speaker-${index + 1}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker: segment.speaker,
      text: segment.text,
    })),
  }, {
    text: input.words.map((word) => word.text).join(" "),
    words: input.words.map((word) => ({
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text,
    })),
  });
  const idBySharedId = new Map<string, string>();
  const seamConflictByWordPassIndex = new Set(
    input.words
      .map((word, index) => ({ ...word, index }))
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.text.localeCompare(right.text) || left.index - right.index)
      .flatMap((word, index) => word.chunkSeamConflict ? [index] : []),
  );
  const words = shared.words.map((word) => {
    const evidenceId = `word-${input.runId}-${word.wordPassIndex + 1}`;
    idBySharedId.set(word.id, evidenceId);
    return {
      evidenceId,
      sourceWordIndex: word.wordPassIndex,
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text.trim(),
      // Reconciliation may later change `text`; the bounded original Whisper
      // token remains in the adopted Local Evidence Package for audit.
      sourceText: word.text.trim(),
      speaker: word.speaker,
      speakerSegmentIds: [...word.diarizationSegmentIds],
    };
  });
  const mappedUncertainty = shared.uncertaintySpans.map((span, index) => ({
    uncertaintyId: `uncertainty-${input.runId}-${index + 1}`,
    startMs: span.startMs,
    endMs: span.endMs,
    reason: span.reason === "NoSpeakerEvidence"
      ? "speaker-gap" as const
      : span.reason === "TranscriptDisagreement"
        ? "text-conflict" as const
        : "speaker-conflict" as const,
    evidenceIds: [
      ...span.wordIds.map((id) => idBySharedId.get(id)).filter((id): id is string => id !== undefined),
      ...span.diarizationSegmentIds,
    ],
  }));
  const seamUncertainty = words.flatMap((word) => (
    seamConflictByWordPassIndex.has(word.sourceWordIndex)
      ? [{
          uncertaintyId: `uncertainty-${input.runId}-seam-${word.sourceWordIndex + 1}`,
          startMs: word.startMs,
          endMs: word.endMs,
          reason: "timestamp-gap" as const,
          evidenceIds: [word.evidenceId],
        }]
      : []
  ));
  return {
    words,
    uncertaintySpans: [...mappedUncertainty, ...seamUncertainty],
  };
};

/** Pure deterministic Education-profile segmentation; no model controls cue boundaries. */
export const segmentEducationCaptions = (input: {
  readonly runId: string;
  readonly words: readonly AlignedCaptionWord[];
  /** Authoritative source duration from the prepared manifest, never browser UI state. */
  readonly durationMs: number;
  readonly profileRules?: Readonly<Record<string, unknown>>;
}): readonly StagedCaptionCue[] => {
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new Error("CueBench cannot segment captions without an authoritative media duration.");
  }
  const rules = resolveEducationProfileRules(input.profileRules ?? {}).caption;
  const buckets: AlignedCaptionWord[][] = [];
  let bucket: AlignedCaptionWord[] = [];
  const maxCharacters = rules.maxLineLength * rules.maxLineCount;
  const flush = () => {
    if (bucket.length === 0) return;
    buckets.push(bucket);
    bucket = [];
  };
  for (const word of [...input.words].sort((left, right) => left.startMs - right.startMs || left.sourceWordIndex - right.sourceWordIndex)) {
    if (
      !Number.isSafeInteger(word.startMs)
      || !Number.isSafeInteger(word.endMs)
      || word.startMs < 0
      || word.endMs <= word.startMs
      || word.endMs > input.durationMs
    ) throw new Error("CueBench received word timing outside the authoritative media duration.");
    const prospectiveText = [...bucket, word].map((value) => value.text.trim()).join(" ");
    const first = bucket[0] ?? word;
    const exceedsDuration = word.endMs - first.startMs > rules.maxDurationMs;
    const exceedsCharacters = prospectiveText.length > maxCharacters;
    const speakerTransition = bucket.length > 0 && word.speaker !== null && bucket.at(-1)?.speaker !== null && word.speaker !== bucket.at(-1)?.speaker;
    if (bucket.length > 0 && (exceedsDuration || exceedsCharacters || speakerTransition)) flush();
    bucket.push(word);
  }
  flush();

  // A speaker/length split can happen between overlapping word intervals.
  // Repartition those neighbours rather than publishing overlapping cues.
  for (let index = 0; index + 1 < buckets.length;) {
    const current = buckets[index]!;
    const next = buckets[index + 1]!;
    if (current.at(-1)!.endMs > next[0]!.startMs) {
      buckets.splice(index, 2, [...current, ...next]);
      if (index > 0) index -= 1;
      continue;
    }
    index += 1;
  }

  const result: StagedCaptionCue[] = [];
  for (const [index, words] of buckets.entries()) {
    const first = words[0]!;
    const last = words.at(-1)!;
    const nextStart = buckets[index + 1]?.[0]?.startMs ?? input.durationMs;
    if (nextStart <= first.startMs) {
      throw new Error("CueBench cannot safely partition caption boundaries at this media timestamp.");
    }
    const desiredEnd = Math.max(last.endMs, first.startMs + Math.min(rules.minDurationMs, rules.maxDurationMs));
    // A final cue or close following boundary may be shorter than profile
    // minimum; temporal safety and no overlap take precedence.
    const endMs = Math.min(desiredEnd, nextStart, input.durationMs);
    const text = words.map((word) => word.text.trim()).join(" ").replaceAll(/\s+/g, " ").trim();
    if (text.length === 0 || endMs <= first.startMs || endMs < last.endMs) {
      throw new Error("CueBench cannot safely segment captions within the authoritative media duration.");
    }
    const speakers = new Set(words.map((word) => word.speaker).filter((speaker): speaker is string => speaker !== null));
    result.push({
      cueId: `caption-${input.runId}-${result.length + 1}`,
      startMs: first.startMs,
      endMs,
      text,
      speaker: speakers.size === 1 ? [...speakers][0]! : null,
      evidenceIds: words.map((word) => word.evidenceId),
    });
  }
  for (const [index, cue] of result.entries()) {
    const next = result[index + 1];
    if (cue.startMs < 0 || cue.endMs > input.durationMs || cue.endMs <= cue.startMs || (next !== undefined && cue.endMs > next.startMs)) {
      throw new Error("CueBench segmented overlapping or out-of-range captions.");
    }
  }
  return result;
};

const metadataUsage = (metadata: Readonly<Record<string, string>>): GenerationProviderProvenance["usage"] => {
  const serialized = metadata.usage;
  if (serialized === undefined) return { kind: "unavailable", reason: "provider-usage-not-reported" };
  try {
    const value = JSON.parse(serialized) as Partial<ProviderCallProvenance["usage"]> | null;
    if (value?.audioSeconds !== null && typeof value?.audioSeconds === "number" && Number.isFinite(value.audioSeconds) && value.audioSeconds >= 0) {
      return { kind: "audio-duration", seconds: value.audioSeconds };
    }
    const tokens = [value?.inputTokens, value?.outputTokens, value?.totalTokens];
    if (tokens.some((entry) => entry === null || (typeof entry === "number" && Number.isInteger(entry) && entry >= 0))) {
      return {
        kind: "tokens",
        inputTokens: typeof value?.inputTokens === "number" ? value.inputTokens : null,
        outputTokens: typeof value?.outputTokens === "number" ? value.outputTokens : null,
        totalTokens: typeof value?.totalTokens === "number" ? value.totalTokens : null,
      };
    }
  } catch {
    // Raw metadata is untrusted recovery input; retain a truthful absence.
  }
  return { kind: "unavailable", reason: "provider-usage-not-reported" };
};

const providerParameters = (metadata: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const omitted = new Set(["provider", "providerResponseId", "usage", "disposition"]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !omitted.has(key)));
};

const providerProvenance = async (
  role: GenerationProviderProvenance["role"],
  source: TranscriptionProvenance | ReconciliationResult["provenance"],
  context: {
    readonly qualityProfileRevision: number;
    readonly qualityProfileRulesSha256: string;
    readonly sourceMediaSha256: string;
    readonly fallbackNowMs: number;
  },
): Promise<GenerationProviderProvenance> => {
  const metadata = source.requestMetadata ?? {};
  const skipped = "disposition" in source
    ? source.disposition === "skipped"
    : metadata.disposition === "skipped-no-uncertainty";
  if (skipped) {
    return StrictGenerationProviderProvenanceSchema.parse({
      role,
      model: "not-invoked",
      requestHash: source.requestHash,
      responseHash: source.responseHash,
      store: null,
      requestMetadata: metadata,
      warnings: [...(source.warnings ?? [])],
      provenanceVersion: 2,
      disposition: "skipped",
      skippedReason: "no-uncertainty",
      provider: null,
      mode: null,
      endpoint: null,
      prompt: null,
      structuredOutput: null,
      qualityProfile: { revision: context.qualityProfileRevision, rulesSha256: context.qualityProfileRulesSha256 },
      timing: null,
      usage: { kind: "unavailable", reason: "provider-not-invoked" },
      cost: { kind: "unavailable", reason: "provider-not-invoked" },
      sourceMediaSha256: context.sourceMediaSha256,
    });
  }
  const provider = metadata.provider === "openai" ? "openai" : "fixture";
  const endpoint = {
    path: metadata.endpoint ?? "fixture://cuebench",
    method: metadata.method === "POST" ? "POST" as const : "FIXTURE" as const,
    parameters: providerParameters(metadata),
  };
  const instructionsSha256 = metadata.instructionsSha256;
  const structuredOutputSchemaSha256 = metadata.structuredOutputSchemaSha256;
  const timing = source.timing ?? {
    startedAtMs: context.fallbackNowMs,
    completedAtMs: context.fallbackNowMs,
    durationMs: 0,
  };
  return StrictGenerationProviderProvenanceSchema.parse({
    role,
    model: source.model,
    requestHash: source.requestHash,
    responseHash: source.responseHash,
    store: "store" in source ? source.store : null,
    requestMetadata: metadata,
    warnings: [...(source.warnings ?? [])],
    provenanceVersion: 2,
    disposition: "executed",
    skippedReason: null,
    provider,
    mode: provider === "openai" ? "live" : "fixture",
    endpoint,
    prompt: instructionsSha256 === undefined ? null : {
      version: metadata.promptVersion ?? "cuebench-reconciliation-v1",
      sha256: instructionsSha256,
    },
    structuredOutput: structuredOutputSchemaSha256 === undefined ? null : {
      version: metadata.structuredOutputSchemaVersion ?? "cuebench-reconciliation-schema-v1",
      sha256: structuredOutputSchemaSha256,
      strict: true,
    },
    qualityProfile: { revision: context.qualityProfileRevision, rulesSha256: context.qualityProfileRulesSha256 },
    timing,
    usage: metadataUsage(metadata),
    cost: { kind: "unavailable", reason: "provider-pricing-not-resolved" },
    sourceMediaSha256: context.sourceMediaSha256,
  });
};

const validPreparedAudio = (audio: PreparedAudio, operationKey: string): boolean => (
  sha256.test(audio.sha256)
  && typeof audio.key === "string" && audio.key === `prepared/${operationKey}/audio/${audio.sha256.toLowerCase()}.wav`
  && Number.isSafeInteger(audio.byteLength) && audio.byteLength > 0
  && Number.isSafeInteger(audio.durationMs) && audio.durationMs >= 0
  && typeof audio.contentType === "string" && audio.contentType.length > 0
);

const matchesAuthoritativeSource = (manifest: PreparedMediaManifestContents, request: GenerationStartRequest): boolean => (
  sha256.test(manifest.source.sha256)
  && manifest.source.sha256.toLowerCase() === request.mediaSha256.toLowerCase()
  && manifest.source.byteLength === request.sourceByteLength
  && manifest.source.durationMs === request.sourceDurationMs
);

const WHOLE_PASS_REQUEST_KEY = "whole-pass";
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 3;
/** A <=30 MiB normalized WAV can require at most two <=25 MiB OpenAI parts. */
const MAX_RESUMABLE_TRANSCRIPTION_REQUESTS = 2;
/** 5k retained words are split into bounded reconciliation windows; leave a small proof margin. */
const MAX_RESUMABLE_RECONCILIATION_REQUESTS = 128;

const providerRequestKey = (attempt: GenerationProviderAttempt): string => attempt.requestKey ?? WHOLE_PASS_REQUEST_KEY;

const providerAttemptsFor = (
  run: PersistedGenerationRun,
  pass: BillableGenerationPass,
  requestKey = WHOLE_PASS_REQUEST_KEY,
): readonly GenerationProviderAttempt[] => (
  (run.providerAttempts ?? []).filter((attempt) => attempt.pass === pass && providerRequestKey(attempt) === requestKey)
);

const providerAttempt = (
  run: PersistedGenerationRun,
  pass: BillableGenerationPass,
  requestKey = WHOLE_PASS_REQUEST_KEY,
): GenerationProviderAttempt | undefined => providerAttemptsFor(run, pass, requestKey).at(-1);

const providerAttemptId = (
  request: GenerationStartRequest,
  pass: BillableGenerationPass,
  requestKey: string,
  attemptNumber: number,
): string => (
  `generation:${request.operation.operationKey}:${request.runId}:${pass}:${requestKey}:${attemptNumber}`
);

/** Persist intent before crossing a billable provider boundary. */
const beginProviderAttempt = async (
  store: GenerationRunStore,
  run: PersistedGenerationRun,
  pass: BillableGenerationPass,
  requestKey: string,
  nowMs: number,
): Promise<PersistedGenerationRun> => {
  const latest = await store.read(run.request.runId) ?? run;
  if (isCancelled(latest)) return latest;
  const existing = providerAttempt(latest, pass, requestKey);
  if (existing?.state === "accepted-unknown") throw new GenerationProviderOutcomeUnknownError(pass);
  if (existing?.state === "completed") return latest;
  const attempts = providerAttemptsFor(latest, pass, requestKey);
  if (attempts.length >= MAX_PROVIDER_ATTEMPTS_PER_REQUEST) {
    throw new Error(`CueBench exhausted the bounded retry budget for ${pass} ${requestKey}.`);
  }
  const next: PersistedGenerationRun = {
    ...latest,
    providerAttempts: [
      ...(latest.providerAttempts ?? []),
      {
        pass,
        requestKey,
        attemptId: providerAttemptId(latest.request, pass, requestKey, attempts.length + 1),
        state: "accepted-unknown",
        startedAtMs: nowMs,
      },
    ],
  };
  await store.save(next);
  return next;
};

const completeProviderAttempt = (
  run: PersistedGenerationRun,
  pass: BillableGenerationPass,
  requestKey: string,
  responseHash: string,
): readonly GenerationProviderAttempt[] => {
  const candidates = providerAttemptsFor(run, pass, requestKey);
  const active = candidates.at(-1);
  if (active === undefined || active.state === "completed") return run.providerAttempts ?? [];
  return (run.providerAttempts ?? []).map((attempt) => (
    attempt.attemptId === active.attemptId
      ? { ...attempt, state: "completed" as const, responseHash }
      : attempt
  ));
};

const markProviderAttemptRetryableFailure = (
  run: PersistedGenerationRun,
  pass: BillableGenerationPass,
  requestKey: string,
): readonly GenerationProviderAttempt[] => {
  const active = providerAttempt(run, pass, requestKey);
  if (active === undefined || active.state !== "accepted-unknown") return run.providerAttempts ?? [];
  return (run.providerAttempts ?? []).map((attempt) => (
    attempt.attemptId === active.attemptId
      ? { ...attempt, state: "retryable-failed" as const }
      : attempt
  ));
};

/** Only an explicit pre-acceptance rejection (currently HTTP 429) may replay. */
const isExplicitRetryableProviderFailure = (error: unknown): error is OpenAIProviderError => (
  error instanceof OpenAIProviderError && error.safeToReplay
);

const transcriptionCheckpoints = <Value>(
  run: PersistedGenerationRun,
  field: "diarizationChunks" | "wordTimestampChunks",
): readonly PersistedGenerationTranscriptionCheckpoint<Value>[] => (
  ((field === "diarizationChunks" ? run.diarizationChunks : run.wordTimestampChunks) ?? []) as readonly PersistedGenerationTranscriptionCheckpoint<Value>[]
);

const upsertTranscriptionCheckpoint = <Value>(
  values: readonly PersistedGenerationTranscriptionCheckpoint<Value>[],
  next: PersistedGenerationTranscriptionCheckpoint<Value>,
): readonly PersistedGenerationTranscriptionCheckpoint<Value>[] => {
  const index = values.findIndex((value) => value.requestKey === next.requestKey);
  if (index < 0) return [...values, clone(next)];
  return values.map((value, candidate) => candidate === index ? clone(next) : value);
};

const upsertRequestCheckpoint = <Value extends { readonly requestKey: string }>(
  values: readonly Value[],
  next: Value,
): readonly Value[] => {
  const index = values.findIndex((value) => value.requestKey === next.requestKey);
  if (index < 0) return [...values, clone(next)];
  return values.map((value, candidate) => candidate === index ? clone(next) : value);
};

const validRequestPlan = (
  requests: readonly { readonly requestKey: string }[],
  maximum: number,
): boolean => (
  requests.length <= maximum
  && requests.every((request) => /^[a-z][a-z0-9-]{0,63}$/u.test(request.requestKey))
  && new Set(requests.map((request) => request.requestKey)).size === requests.length
);

/**
 * The deterministic core of the Cloudflare Workflow. It is deliberately
 * dependency-injected so fixture mode exercises exact durable semantics with
 * no OpenAI key or outbound network access.
 */
export class CaptionGenerationRunner {
  public constructor(
    private readonly store: GenerationRunStore,
    private readonly dependencies: CaptionGenerationDependencies,
    private readonly billableSteps?: BillableGenerationStepExecutor,
  ) {}

  /**
   * Put one rich request response before returning from `step.do`. Production
   * keeps only the opaque ref in evolving state; test/in-memory adapters keep
   * the value inline without changing the durable execution algorithm.
   */
  private async persistRequestValue<Value>(
    runId: string,
    requestKey: string,
    value: Value,
  ): Promise<{
    readonly checkpoint: PersistedGenerationTranscriptionCheckpoint<Value>;
    readonly stepCheckpoint?: GenerationRunArtifactReference;
  }> {
    if (this.store.writeProviderCheckpoint === undefined) {
      return { checkpoint: { requestKey, value: clone(value) } };
    }
    const artifactRef = await this.store.writeProviderCheckpoint(runId, value);
    return { checkpoint: { requestKey, artifactRef }, stepCheckpoint: artifactRef };
  }

  private async hydrateTranscriptionResults<Value>(input: {
    readonly runId: string;
    readonly run: PersistedGenerationRun;
    readonly field: "diarizationChunks" | "wordTimestampChunks";
    readonly requests: readonly GenerationTranscriptionRequest[];
  }): Promise<readonly GenerationTranscriptionCheckpoint<Value>[]> {
    const checkpoints = transcriptionCheckpoints<Value>(input.run, input.field);
    const byRequest = new Map(checkpoints.map((checkpoint) => [checkpoint.requestKey, checkpoint]));
    const results: GenerationTranscriptionCheckpoint<Value>[] = [];
    for (const request of input.requests) {
      const checkpoint = byRequest.get(request.requestKey);
      if (checkpoint === undefined) throw new Error("CueBench transcription request checkpoint is incomplete.");
      if (checkpoint.value !== undefined) {
        results.push({ requestKey: checkpoint.requestKey, value: clone(checkpoint.value) });
        continue;
      }
      if (checkpoint.artifactRef === undefined || this.store.readProviderCheckpoint === undefined) {
        throw new Error("CueBench transcription request checkpoint is not durably recoverable.");
      }
      const value = await this.store.readProviderCheckpoint(input.runId, checkpoint.artifactRef);
      if (value === null) throw new Error("CueBench transcription request checkpoint is unavailable.");
      results.push({ requestKey: checkpoint.requestKey, value: value as Value });
    }
    return results;
  }

  private async hydrateReconciliationResults(input: {
    readonly runId: string;
    readonly run: PersistedGenerationRun;
    readonly requests: readonly GenerationReconciliationRequest[];
  }): Promise<readonly GenerationReconciliationCheckpoint[]> {
    const byRequest = new Map((input.run.reconciliationWindows ?? []).map((checkpoint) => [checkpoint.requestKey, checkpoint]));
    const results: GenerationReconciliationCheckpoint[] = [];
    for (const request of input.requests) {
      const checkpoint = byRequest.get(request.requestKey);
      if (checkpoint === undefined) throw new Error("CueBench reconciliation window checkpoint is incomplete.");
      if (checkpoint.value !== undefined) {
        results.push(clone(checkpoint.value));
        continue;
      }
      if (checkpoint.artifactRef === undefined || this.store.readProviderCheckpoint === undefined) {
        throw new Error("CueBench reconciliation window checkpoint is not durably recoverable.");
      }
      const value = await this.store.readProviderCheckpoint(input.runId, checkpoint.artifactRef);
      if (value === null || typeof value !== "object") throw new Error("CueBench reconciliation window checkpoint is unavailable.");
      results.push(value as GenerationReconciliationCheckpoint);
    }
    return results;
  }

  /**
   * The write-ahead attempt is created inside the Workflow step callback. A
   * successful Workflow retry receives the cached value without invoking this
   * callback; a non-cached retry sees `accepted-unknown` and fails closed.
   */
  private async runBillable<Value>(input: {
    readonly run: PersistedGenerationRun;
    readonly pass: BillableGenerationPass;
    readonly requestKey?: string;
    readonly invoke: (run: PersistedGenerationRun) => Promise<Value>;
    readonly responseHash: (value: Value) => string;
    readonly checkpoint: (value: Value) => Promise<BillableCheckpoint> | BillableCheckpoint;
  }): Promise<PersistedGenerationRun> {
    const requestKey = input.requestKey ?? WHOLE_PASS_REQUEST_KEY;
    const work = async (): Promise<BillableGenerationStepResult> => {
      const current = await this.store.read(input.run.request.runId) ?? input.run;
      const previous = providerAttempt(current, input.pass, requestKey);
      if (previous?.state === "completed") {
        const checkpoint = this.store.workflowCheckpointReference === undefined
          ? undefined
          : await this.store.workflowCheckpointReference(input.run.request.runId);
        return boundedBillableStepResult({
          version: 1,
          responseHash: previous.responseHash ?? "0".repeat(64),
          ...(checkpoint === undefined ? {} : { checkpoint }),
        });
      }
      const begun = await beginProviderAttempt(
        this.store,
        current,
        input.pass,
        requestKey,
        this.dependencies.clock?.() ?? Date.now(),
      );
      if (isCancelled(begun)) throw new Error("CueBench caption generation was cancelled before its provider call.");
      let value: Value;
      try {
        value = await input.invoke(begun);
      } catch (error) {
        // Only an explicit OpenAI 429 response proves that no result was
        // accepted. A network/timeout/5xx/protocol ambiguity deliberately
        // remains accepted-unknown and cannot be replayed.
        if (isExplicitRetryableProviderFailure(error)) {
          await persistArtifacts(this.store, begun, {
            providerAttempts: markProviderAttemptRetryableFailure(begun, input.pass, requestKey),
          });
        }
        throw error;
      }
      const responseHash = input.responseHash(value);
      // This save occurs inside `step.do`, before its tiny serializable return
      // value. Production request checkpoints put the rich response under a
      // separate content-addressed provider-result key; workflow state keeps
      // only that ref and the Workflow cache never contains transcript data.
      const persisted = await input.checkpoint(value);
      await persistArtifacts(this.store, begun, persisted.patch);
      const checkpoint = persisted.stepCheckpoint ?? (this.store.workflowCheckpointReference === undefined
        ? undefined
        : await this.store.workflowCheckpointReference(input.run.request.runId));
      return boundedBillableStepResult({
        version: 1,
        responseHash,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
    };
    let outcome: BillableGenerationStepResult;
    try {
      outcome = this.billableSteps === undefined
        ? await work()
        : await this.billableSteps.run(input.pass, requestKey, work);
      outcome = boundedBillableStepResult(outcome);
    } catch (error) {
      // Upstream audio APIs offer neither an idempotency key nor a result
      // lookup. Any failed/missing step result could represent an accepted
      // billable request, so automatic rerun would risk double spend.
      if (error instanceof GenerationProviderOutcomeUnknownError || isExplicitRetryableProviderFailure(error)) throw error;
      const latest = await this.store.read(input.run.request.runId) ?? input.run;
      if (isCancelled(latest)) throw error;
      throw new GenerationProviderOutcomeUnknownError(input.pass);
    }
    const latest = await this.store.read(input.run.request.runId) ?? input.run;
    if (isCancelled(latest)) return latest;
    const existing = providerAttempt(latest, input.pass, requestKey);
    if (existing === undefined) {
      throw new Error("CueBench lost its durable billable provider-attempt record.");
    }
    if (this.billableSteps !== undefined && this.store.workflowCheckpointReference !== undefined) {
      if (outcome.checkpoint === undefined) {
        throw new Error("CueBench Workflow provider step did not return its bounded R2 checkpoint reference.");
      }
      if (this.store.readProviderCheckpoint !== undefined) {
        const richCheckpoint = await this.store.readProviderCheckpoint(input.run.request.runId, outcome.checkpoint);
        if (richCheckpoint === null) {
          const durableReference = await this.store.workflowCheckpointReference(input.run.request.runId);
          if (
            durableReference === undefined
            || durableReference.key !== outcome.checkpoint.key
            || durableReference.sha256 !== outcome.checkpoint.sha256
            || durableReference.byteLength !== outcome.checkpoint.byteLength
          ) throw new Error("CueBench Workflow provider step checkpoint is not durably recoverable.");
        }
      } else {
        const durableReference = await this.store.workflowCheckpointReference(input.run.request.runId);
        if (
          durableReference === undefined
          || durableReference.key !== outcome.checkpoint.key
          || durableReference.sha256 !== outcome.checkpoint.sha256
          || durableReference.byteLength !== outcome.checkpoint.byteLength
        ) throw new Error("CueBench Workflow provider step checkpoint is not durably recoverable.");
      }
    }
    if (existing.state === "completed") return latest;
    return persistArtifacts(this.store, latest, {
      providerAttempts: completeProviderAttempt(latest, input.pass, requestKey, outcome.responseHash),
    });
  }

  /**
   * Journals each immutable WAV chunk independently. A later chunk may fail
   * and be retried, but earlier completed chunks are never sent again.
   */
  private async runResumableTranscriptionPass<Value>(input: {
    readonly run: PersistedGenerationRun;
    readonly pass: "diarization" | "word-timestamps";
    readonly field: "diarizationChunks" | "wordTimestampChunks";
    readonly requests: readonly GenerationTranscriptionRequest[];
    readonly invoke: (run: PersistedGenerationRun, request: GenerationTranscriptionRequest) => Promise<Value>;
    readonly responseHash: (value: Value) => string;
    readonly aggregate: (
      run: PersistedGenerationRun,
      requests: readonly GenerationTranscriptionRequest[],
      results: readonly GenerationTranscriptionCheckpoint<Value>[],
    ) => Promise<PersistedGenerationRun>;
  }): Promise<PersistedGenerationRun> {
    if (!validRequestPlan(input.requests, MAX_RESUMABLE_TRANSCRIPTION_REQUESTS) || input.requests.length === 0) {
      throw new Error("CueBench received an invalid bounded transcription request plan.");
    }
    let current = input.run;
    for (const request of input.requests) {
      const latest = await this.store.read(current.request.runId) ?? current;
      if (isCancelled(latest)) return latest;
      const checkpoint = transcriptionCheckpoints<Value>(latest, input.field).find((value) => value.requestKey === request.requestKey);
      const attempt = providerAttempt(latest, input.pass, request.requestKey);
      if (checkpoint !== undefined && attempt?.state === "completed") {
        current = latest;
        continue;
      }
      current = await this.runBillable({
        run: latest,
        pass: input.pass,
        requestKey: request.requestKey,
        invoke: (run) => input.invoke(run, request),
        responseHash: input.responseHash,
        checkpoint: async (value) => {
          const persisted = await this.persistRequestValue(latest.request.runId, request.requestKey, value);
          const existing = transcriptionCheckpoints<Value>(latest, input.field);
          const next = upsertTranscriptionCheckpoint(existing, persisted.checkpoint);
          return {
            patch: input.field === "diarizationChunks"
              ? { diarizationChunks: next as readonly PersistedGenerationTranscriptionCheckpoint<DiarizationTranscription>[] }
              : { wordTimestampChunks: next as readonly PersistedGenerationTranscriptionCheckpoint<WordTimestampTranscription>[] },
            ...(persisted.stepCheckpoint === undefined ? {} : { stepCheckpoint: persisted.stepCheckpoint }),
          };
        },
      });
    }
    const latest = await this.store.read(current.request.runId) ?? current;
    if (isCancelled(latest)) return latest;
    const results = await this.hydrateTranscriptionResults<Value>({
      runId: latest.request.runId,
      run: latest,
      field: input.field,
      requests: input.requests,
    });
    return input.aggregate(latest, input.requests, results);
  }

  /** Mirrors chunk journaling for every bounded foreground reconciliation window. */
  private async runResumableReconciliation(
    run: PersistedGenerationRun,
    dependencies: ResumableReconciliationDependencies,
  ): Promise<PersistedGenerationRun> {
    const requests = await dependencies.requests({
      runId: run.request.runId,
      alignedWords: run.aligned!.words,
      uncertaintySpans: run.aligned!.uncertaintySpans,
    });
    if (!validRequestPlan(requests, MAX_RESUMABLE_RECONCILIATION_REQUESTS)) {
      throw new Error("CueBench received an invalid bounded reconciliation request plan.");
    }
    let current = run;
    for (const request of requests) {
      const latest = await this.store.read(current.request.runId) ?? current;
      if (isCancelled(latest)) return latest;
      const checkpoint = latest.reconciliationWindows?.find((value) => value.requestKey === request.requestKey);
      const attempt = providerAttempt(latest, "reconciliation", request.requestKey);
      if (checkpoint !== undefined && attempt?.state === "completed") {
        current = latest;
        continue;
      }
      current = await this.runBillable({
        run: latest,
        pass: "reconciliation",
        requestKey: request.requestKey,
        invoke: (currentRun) => dependencies.reconcileRequest({ runId: currentRun.request.runId, request }),
        responseHash: (value) => value.provenance.responseHash,
        checkpoint: async (value) => {
          const persisted = await this.persistRequestValue(latest.request.runId, request.requestKey, value);
          const checkpoint: PersistedGenerationReconciliationCheckpoint = {
            requestKey: request.requestKey,
            ...(persisted.checkpoint.value === undefined ? {} : { value: persisted.checkpoint.value }),
            ...(persisted.checkpoint.artifactRef === undefined ? {} : { artifactRef: persisted.checkpoint.artifactRef }),
          };
          return {
            patch: {
              reconciliationWindows: upsertRequestCheckpoint(
                latest.reconciliationWindows ?? [],
                checkpoint,
              ),
            },
            ...(persisted.stepCheckpoint === undefined ? {} : { stepCheckpoint: persisted.stepCheckpoint }),
          };
        },
      });
    }
    const latest = await this.store.read(current.request.runId) ?? current;
    if (isCancelled(latest)) return latest;
    const results = await this.hydrateReconciliationResults({
      runId: latest.request.runId,
      run: latest,
      requests,
    });
    const reconciled = await dependencies.aggregate({
      runId: latest.request.runId,
      alignedWords: latest.aligned!.words,
      uncertaintySpans: latest.aligned!.uncertaintySpans,
      requests,
      results,
    });
    return persistArtifacts(this.store, latest, { reconciled, reconciliationWindows: undefined });
  }

  public async run(request: GenerationStartRequest): Promise<void> {
    let run = await this.store.initialise(request);
    if (run.request.projectId !== request.projectId || run.request.expectedProjectRevision !== request.expectedProjectRevision) {
      throw new Error("CueBench generation run identity conflict.");
    }
    if (run.stageHistory.at(-1)?.stage === "Cancelled") return;
    if (run.staged !== undefined) {
      if (await cancellationBoundary(this.store, run) !== null) return;
      await persistStagedForAdoption(this.store, run, run.staged);
      return;
    }
    try {
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.preparedManifest === undefined) {
        run = await appendStage(this.store, run, "PreparingMedia", { progress: 0 });
        const preparedManifest = await this.dependencies.preparation.prepare({
          ...request.operation,
          idempotencyKey: `prepare:${request.operation.operationKey}`,
        });
        run = await persistArtifacts(this.store, run, { preparedManifest });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.manifest === undefined) {
        const manifest = await this.dependencies.artifacts.readManifest(run.preparedManifest!);
        if (!validPreparedAudio(manifest.normalizedAudio, request.operation.operationKey) || !matchesAuthoritativeSource(manifest, request)) {
          throw new Error("CueBench prepared media manifest does not match this signed source identity.");
        }
        run = await persistArtifacts(this.store, run, { manifest: clone(manifest) });
      }

      // An accepted-unknown attempt with a durable response is exactly the
      // small crash window that a cached Workflow step repairs: rerun the
      // step to receive its bounded reference, then mark the attempt complete
      // without invoking OpenAI again. Legacy checkpointed output without an
      // attempt record remains usable and is never replayed.
      if (run.diarization === undefined || providerAttempt(run, "diarization")?.state === "accepted-unknown") {
        run = await appendStage(this.store, run, "Transcribing", { progress: 0 });
        const resumable = this.dependencies.transcription.resumable;
        run = resumable === undefined
          ? await this.runBillable({
            run,
            pass: "diarization",
            invoke: (current) => this.dependencies.transcription.diarize({ runId: request.runId, audio: current.manifest!.normalizedAudio }),
            responseHash: (value) => value.provenance.responseHash,
            checkpoint: (value) => ({ patch: { diarization: clone(value) } }),
          })
          : await this.runResumableTranscriptionPass({
            run,
            pass: "diarization",
            field: "diarizationChunks",
            requests: await resumable.requests({ runId: request.runId, audio: run.manifest!.normalizedAudio }),
            invoke: (current, chunk) => resumable.diarizeRequest({ runId: current.request.runId, audio: current.manifest!.normalizedAudio, request: chunk }),
            responseHash: (value) => value.provenance.responseHash,
            aggregate: async (latest, chunkRequests, results) => {
              const value = await resumable.aggregateDiarization({
                runId: request.runId,
                audio: latest.manifest!.normalizedAudio,
                requests: chunkRequests,
                results,
              });
              return persistArtifacts(this.store, latest, { diarization: value, diarizationChunks: undefined });
            },
          });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.wordTimestamps === undefined || providerAttempt(run, "word-timestamps")?.state === "accepted-unknown") {
        run = await appendStage(this.store, run, "Transcribing", { progress: 0.5 });
        const resumable = this.dependencies.transcription.resumable;
        run = resumable === undefined
          ? await this.runBillable({
            run,
            pass: "word-timestamps",
            invoke: (current) => this.dependencies.transcription.wordTimestamps({ runId: request.runId, audio: current.manifest!.normalizedAudio }),
            responseHash: (value) => value.provenance.responseHash,
            checkpoint: (value) => ({ patch: { wordTimestamps: clone(value) } }),
          })
          : await this.runResumableTranscriptionPass({
            run,
            pass: "word-timestamps",
            field: "wordTimestampChunks",
            requests: await resumable.requests({ runId: request.runId, audio: run.manifest!.normalizedAudio }),
            invoke: (current, chunk) => resumable.wordTimestampRequest({ runId: current.request.runId, audio: current.manifest!.normalizedAudio, request: chunk }),
            responseHash: (value) => value.provenance.responseHash,
            aggregate: async (latest, chunkRequests, results) => {
              const value = await resumable.aggregateWordTimestamps({
                runId: request.runId,
                audio: latest.manifest!.normalizedAudio,
                requests: chunkRequests,
                results,
              });
              return persistArtifacts(this.store, latest, { wordTimestamps: value, wordTimestampChunks: undefined });
            },
          });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.aligned === undefined) {
        run = await appendStage(this.store, run, "AligningEvidence", { progress: 0 });
        run = await persistArtifacts(this.store, run, { aligned: alignSpeakerSegmentsToWords({ runId: request.runId, words: run.wordTimestamps!.words, speakerSegments: run.diarization!.speakerSegments }) });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.reconciled === undefined || providerAttempt(run, "reconciliation")?.state === "accepted-unknown") {
        run = await appendStage(this.store, run, "ReconcilingTranscript", { progress: 0 });
        const resumable = this.dependencies.reconciliation.resumable;
        run = resumable === undefined
          ? await this.runBillable({
            run,
            pass: "reconciliation",
            invoke: (current) => this.dependencies.reconciliation.reconcile({
              runId: request.runId,
              alignedWords: current.aligned!.words,
              uncertaintySpans: current.aligned!.uncertaintySpans,
            }),
            responseHash: (value) => value.provenance.responseHash,
            checkpoint: (value) => ({ patch: { reconciled: clone(value) } }),
          })
          : await this.runResumableReconciliation(run, resumable);
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.reconciled!.words.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
        throw new Error("CueBench cannot stage evidence beyond the bounded Local Evidence Package.");
      }
      if (run.diarization!.speakerSegments.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
        throw new Error("CueBench cannot stage diarization evidence beyond the bounded Local Evidence Package.");
      }

      run = await appendStage(this.store, run, "SegmentingCaptions", { progress: 0 });
      const captions = segmentEducationCaptions({
        runId: request.runId,
        words: run.reconciled!.words,
        durationMs: run.manifest!.source.durationMs,
        ...(request.qualityProfileRules === undefined ? {} : { profileRules: request.qualityProfileRules }),
      });
      if (captions.length > MAX_LOCAL_CAPTION_CUES) {
        throw new Error("CueBench cannot stage a caption result beyond the backup-safe cue bound.");
      }
      const createdAtMs = this.dependencies.clock?.() ?? Date.now();
      const qualityProfileRulesSha256 = await sha256Hex(canonicalSerialize(request.qualityProfileRules ?? {}));
      const provenanceContext = {
        qualityProfileRevision: request.expectedQualityProfileRevision,
        qualityProfileRulesSha256,
        sourceMediaSha256: request.mediaSha256.toLowerCase(),
        fallbackNowMs: createdAtMs,
      };
      const evidence: CaptionEvidenceBundle = CaptionEvidenceBundleSchema.parse({
        contractVersion: 1,
        runId: request.runId,
        projectId: request.projectId,
        mediaSha256: request.mediaSha256,
        preparedManifest: run.preparedManifest,
        normalizedAudio: run.manifest!.normalizedAudio,
        words: run.reconciled!.words,
        speakerSegments: run.diarization!.speakerSegments.map((segment, index) => ({
          // This is intentionally identical to the id normalization used by
          // alignSpeakerSegmentsToWords, so every retained word pointer is
          // resolvable after the private R2 run prefix is deleted.
          id: segment.id?.trim() || `speaker-${index + 1}`,
          startMs: segment.startMs,
          endMs: segment.endMs,
          speaker: segment.speaker.trim(),
          text: segment.text.trim().slice(0, 1_000),
        })),
        uncertaintySpans: run.aligned!.uncertaintySpans,
        provenance: await Promise.all([
          providerProvenance("diarization", run.diarization!.provenance, provenanceContext),
          providerProvenance("word-timestamps", run.wordTimestamps!.provenance, provenanceContext),
          providerProvenance("reconciliation", run.reconciled!.provenance, provenanceContext),
        ]),
      });
      assertCanonicalEvidencePackageBudget({
        runId: request.runId,
        projectId: request.projectId,
        mediaSha256: request.mediaSha256,
        expectedProjectRevision: request.expectedProjectRevision,
        expectedQualityProfileRevision: request.expectedQualityProfileRevision,
        retainedAtMs: createdAtMs,
        evidence,
        captions,
      });
      const expiresAtMs = createdAtMs + DAY_MS;
      const outputSha256 = await sha256Hex(canonicalSerialize({
        contractVersion: 1,
        runId: request.runId,
        projectId: request.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: request.expectedProjectRevision,
        expectedQualityProfileRevision: request.expectedQualityProfileRevision,
        evidence,
        captions,
        createdAtMs,
        expiresAtMs,
      }));
      const staged = StagedGenerationResultSchema.parse({
        contractVersion: 1,
        runId: request.runId,
        projectId: request.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: request.expectedProjectRevision,
        expectedQualityProfileRevision: request.expectedQualityProfileRevision,
        evidence,
        captions,
        outputSha256,
        createdAtMs,
        expiresAtMs,
      });
      if (await cancellationBoundary(this.store, run) !== null) return;
      // This one write is the all-or-nothing staging boundary. A complete
      // result becomes visible for human adoption in the same durable state;
      // no crash window can strand a private staged result behind an older
      // status or expose a partial cue set.
      await persistStagedForAdoption(this.store, run, staged);
    } catch (error) {
      const current = await this.store.read(request.runId) ?? run;
      if (isCancelled(current)) {
        await appendStage(this.store, current, "Cancelled");
        return;
      }
      await appendStage(this.store, current, "Failed", {
        code: "GENERATION_STAGE_FAILED",
        message: error instanceof Error ? error.message : "CueBench caption generation failed.",
        retryable: typeof error === "object" && error !== null && "retryable" in error && (error as { readonly retryable?: unknown }).retryable === true,
      });
      if (typeof error === "object" && error !== null && "retryable" in error && (error as { readonly retryable?: unknown }).retryable === true) {
        throw error;
      }
    }
  }
}

/** Fixture store used in unit tests and local replay; production maps it to Workflow/R2 state. */
export class InMemoryGenerationRunStore implements GenerationRunStore {
  private readonly runs = new Map<string, PersistedGenerationRun>();

  public async initialise(request: GenerationStartRequest): Promise<PersistedGenerationRun> {
    const existing = this.runs.get(request.runId);
    if (existing !== undefined) return clone(existing);
    const created: PersistedGenerationRun = { request: clone(request), stageHistory: [statusFor(request, "Queued")], cancelled: false };
    this.runs.set(request.runId, clone(created));
    return created;
  }

  public async read(runId: string): Promise<PersistedGenerationRun | null> {
    const found = this.runs.get(runId);
    return found === undefined ? null : clone(found);
  }

  public async save(run: PersistedGenerationRun): Promise<void> {
    this.runs.set(run.request.runId, clone(run));
  }

  public async cancel(runId: string): Promise<void> {
    const current = this.runs.get(runId);
    if (current !== undefined) this.runs.set(runId, { ...current, cancelled: true });
  }

  public stageHistory(runId: string): readonly GenerationRunStatus[] {
    return clone(this.runs.get(runId)?.stageHistory ?? []);
  }

  public async stagedResult(runId: string): Promise<StagedGenerationResult | null> {
    return clone(this.runs.get(runId)?.staged ?? null);
  }
}

/**
 * Adapts the private route record to the Workflow runner. `save` always writes
 * the externally visible stage together with internal resume state, so an R2
 * record cannot expose a stage that has not first become durable.
 */
export class GenerationRunRecordBackedStore implements GenerationRunStore {
  public constructor(
    private readonly records: GenerationRunRecordStore,
    private readonly identity: Pick<GenerationRunRecord["claims"], "operationKey" | "runId">,
  ) {}

  private async record(): Promise<GenerationRunRecord> {
    const found = await this.records.load(this.identity);
    if (found === null) throw new Error("CueBench generation recovery record is unavailable.");
    return found;
  }

  private state(record: GenerationRunRecord): PersistedGenerationRun | null {
    const value = record.workflowState;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Partial<PersistedGenerationRun>;
    if (
      candidate.request === undefined
      || !Array.isArray(candidate.stageHistory)
      || typeof candidate.cancelled !== "boolean"
    ) return null;
    // R2 stores the staged result in a separate immutable artifact. Older
    // snapshots may still include it inline, but resume always sees one
    // coherent state without duplicating word-rich result arrays.
    return {
      ...candidate,
      ...(candidate.staged === undefined && record.stagedResult !== undefined ? { staged: record.stagedResult } : {}),
    } as PersistedGenerationRun;
  }

  public async initialise(request: GenerationStartRequest): Promise<PersistedGenerationRun> {
    const record = await this.record();
    const existing = this.state(record);
    if (existing !== null) return { ...clone(existing), cancelled: existing.cancelled || record.cancelled };
    const created: PersistedGenerationRun = {
      request: clone(request),
      stageHistory: [record.status],
      cancelled: record.cancelled,
    };
    await this.records.save({ ...record, workflowState: created, updatedAtMs: Date.now() });
    return created;
  }

  public async read(runId: string): Promise<PersistedGenerationRun | null> {
    if (runId !== this.identity.runId) return null;
    const record = await this.record();
    const state = this.state(record);
    return state === null ? null : { ...clone(state), cancelled: state.cancelled || record.cancelled };
  }

  public async save(run: PersistedGenerationRun): Promise<void> {
    if (run.request.runId !== this.identity.runId) throw new Error("CueBench generation state does not match its receipt.");
    const record = await this.record();
    const visible = run.stageHistory.at(-1) ?? record.status;
    const { staged, ...workflowState } = clone(run);
    await this.records.save({
      ...record,
      status: visible,
      cancelled: record.cancelled || run.cancelled,
      workflowState,
      ...(staged === undefined ? {} : { stagedResult: staged }),
      updatedAtMs: Date.now(),
    });
  }

  /**
   * Reads the compact R2 reference produced by the immediately preceding
   * state save. This is deliberately separate from `read`, which hydrates
   * rich private data for runner logic and must never become a Workflow step
   * result.
   */
  public async workflowCheckpointReference(runId: string): Promise<GenerationRunArtifactReference> {
    if (runId !== this.identity.runId) throw new Error("CueBench generation checkpoint does not match its receipt.");
    const record = await this.record();
    if (record.workflowStateRef === undefined) {
      throw new Error("CueBench generation state checkpoint is not durably compacted.");
    }
    return clone(record.workflowStateRef);
  }

  public async writeProviderCheckpoint(runId: string, value: unknown): Promise<GenerationRunArtifactReference> {
    if (runId !== this.identity.runId || this.records.writeProviderCheckpoint === undefined) {
      throw new Error("CueBench provider checkpoint storage is unavailable for this generation run.");
    }
    return this.records.writeProviderCheckpoint({ claims: this.identity, value });
  }

  public async readProviderCheckpoint(runId: string, reference: GenerationRunArtifactReference): Promise<unknown | null> {
    if (runId !== this.identity.runId || this.records.readProviderCheckpoint === undefined) return null;
    return this.records.readProviderCheckpoint({ claims: this.identity, reference });
  }

  public async cancel(runId: string): Promise<void> {
    if (runId !== this.identity.runId) return;
    const record = await this.record();
    const state = this.state(record);
    await this.records.save({
      ...record,
      cancelled: true,
      ...(state === null ? {} : { workflowState: { ...state, cancelled: true } }),
      updatedAtMs: Date.now(),
    });
  }
}

const MAX_MANIFEST_BYTES = 128 * 1024;
/** Task 12's immutable normalized WAV is capped independently of OpenAI parts. */
export { MAX_OPENAI_TRANSCRIPTION_BYTES } from "../openai/client";
const MAX_NORMALIZED_AUDIO_BYTES = 30 * 1024 * 1024;
const positiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface PreparedManifestJson {
  readonly metadata?: {
    readonly sha256?: unknown;
    readonly duration_ms?: unknown;
    readonly byte_length?: unknown;
  };
  readonly normalized_audio?: {
    readonly key?: unknown;
    readonly sha256?: unknown;
    readonly byte_length?: unknown;
  };
}

const preparedOperationKey = (reference: PreparedMediaManifest): string | null => {
  const match = reference.key.match(/^prepared\/([a-f0-9]{64})\/manifests\/([a-f0-9]{64})\.json$/);
  return match !== null && match[1] !== undefined && match[2] !== undefined && match[2] === reference.sha256.toLowerCase()
    ? match[1]
    : null;
};

export const exactPreparedManifest = async (
  bucket: R2Bucket,
  reference: PreparedMediaManifest,
): Promise<PreparedMediaManifestContents> => {
  const operationKey = preparedOperationKey(reference);
  if (operationKey === null || !sha256.test(reference.sha256)) {
    throw new Error("CueBench prepared media manifest reference is invalid.");
  }
  const object = await bucket.get(reference.key);
  if (object === null || object.size > MAX_MANIFEST_BYTES) throw new Error("CueBench prepared media manifest is unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== reference.sha256) throw new Error("CueBench prepared media manifest integrity check failed.");
  let parsed: PreparedManifestJson;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifestJson; } catch { throw new Error("CueBench prepared media manifest is invalid."); }
  const audio = parsed.normalized_audio;
  const durationMs = parsed.metadata?.duration_ms;
  const sourceSha256 = parsed.metadata?.sha256;
  const sourceByteLength = parsed.metadata?.byte_length;
  const audioKey = audio?.key;
  const audioSha256 = audio?.sha256;
  const audioByteLength = audio?.byte_length;
  if (
    typeof audioKey !== "string" || audioKey !== `prepared/${operationKey}/audio/${typeof audioSha256 === "string" ? audioSha256.toLowerCase() : ""}.wav`
    || typeof audioSha256 !== "string" || !sha256.test(audioSha256)
    || !positiveSafeInteger(audioByteLength) || audioByteLength > MAX_NORMALIZED_AUDIO_BYTES
    || typeof sourceSha256 !== "string" || !sha256.test(sourceSha256)
    || !positiveSafeInteger(sourceByteLength)
    || !positiveSafeInteger(durationMs)
  ) throw new Error("CueBench prepared media manifest is invalid.");
  return {
    source: {
      sha256: sourceSha256.toLowerCase(),
      byteLength: sourceByteLength,
      durationMs,
    },
    normalizedAudio: {
      key: audioKey,
      sha256: audioSha256.toLowerCase(),
      byteLength: audioByteLength,
      durationMs,
      contentType: "audio/wav",
    },
  };
};

export const privateAudioBytes = async (bucket: R2Bucket, audio: PreparedAudio): Promise<Uint8Array> => {
  const object = await bucket.get(audio.key);
  if (
    object === null
    || object.size !== audio.byteLength
    || object.size > MAX_NORMALIZED_AUDIO_BYTES
    || object.httpMetadata?.contentType !== audio.contentType
    || object.customMetadata?.sha256?.toLowerCase() !== audio.sha256.toLowerCase()
  ) {
    throw new Error("CueBench normalized private audio is unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== audio.sha256) throw new Error("CueBench normalized private audio integrity check failed.");
  return bytes;
};

const usageMetadata = (usage: ProviderCallProvenance["usage"]): Readonly<Record<string, string>> => (
  usage === null ? {} : { usage: JSON.stringify(usage) }
);

const transcriptProvenance = (
  value: ProviderCallProvenance,
  timing: TranscriptionProvenance["timing"],
): TranscriptionProvenance => ({
  model: value.model,
  requestHash: value.requestHash,
  responseHash: value.rawResponseSha256,
  requestMetadata: {
    ...(value.requestMetadata ?? {}),
    provider: value.provider,
    ...(value.providerResponseId === null ? {} : { providerResponseId: value.providerResponseId }),
    ...usageMetadata(value.usage),
  },
  warnings: value.warnings ?? [],
  ...(timing === undefined ? {} : { timing }),
});

const aggregateProviderUsage = (provenance: readonly ProviderCallProvenance[]): ProviderCallProvenance["usage"] => {
  if (provenance.some((entry) => entry.usage === null)) return null;
  const value = (field: keyof NonNullable<ProviderCallProvenance["usage"]>): number | null => {
    const entries = provenance.map((entry) => entry.usage?.[field] ?? null);
    return entries.some((entry) => entry === null) ? null : entries.reduce<number>((total, entry) => total + (entry ?? 0), 0);
  };
  return {
    inputTokens: value("inputTokens"),
    outputTokens: value("outputTokens"),
    totalTokens: value("totalTokens"),
    audioSeconds: value("audioSeconds"),
  };
};

const reconcileProvenance = async (
  runId: string,
  provenance: readonly ProviderCallProvenance[],
  timing?: ReconciliationResult["provenance"]["timing"],
): Promise<ReconciliationResult["provenance"]> => {
  if (provenance.length === 0) {
    const hash = await sha256Hex(`cuebench:reconcile-skipped:${runId}`);
    return {
      model: "gpt-5.6-terra",
      requestHash: hash,
      responseHash: hash,
      store: false,
      requestMetadata: { disposition: "skipped-no-uncertainty" },
      warnings: [],
      disposition: "skipped",
      skippedReason: "no-uncertainty",
    };
  }
  const first = provenance[0]!;
  const warnings = [...new Set(provenance.flatMap((entry) => entry.warnings ?? []))].slice(0, 32);
  return {
    model: first.model,
    requestHash: await sha256Hex(provenance.map((entry) => entry.requestHash).join(":")),
    responseHash: await sha256Hex(provenance.map((entry) => entry.rawResponseSha256).join(":")),
    store: false,
    requestMetadata: {
      ...(first.requestMetadata ?? {}),
      provider: first.provider,
      windowCount: String(provenance.length),
      requestBatchHash: await sha256Hex(provenance.map((entry) => entry.requestHash).join(":")),
      responseBatchHash: await sha256Hex(provenance.map((entry) => entry.rawResponseSha256).join(":")),
      ...usageMetadata(aggregateProviderUsage(provenance)),
    },
    warnings,
    ...(timing === undefined ? {} : { timing }),
    disposition: "executed",
  };
};

const reconciliationEvidenceFor = (
  alignedWords: readonly AlignedCaptionWord[],
  uncertaintySpans: readonly UncertaintySpan[],
) => {
  const knownWordIds = new Set(alignedWords.map((word) => word.evidenceId));
  return {
    words: alignedWords.map((word) => ({
      id: word.evidenceId,
      text: word.text,
      normalizedText: normalizeForAlignment(word.text),
      startMs: word.startMs,
      endMs: word.endMs,
      speaker: word.speaker,
      diarizationSegmentIds: word.speakerSegmentIds,
      wordPassIndex: word.sourceWordIndex,
    })),
    uncertaintySpans: uncertaintySpans.map((span) => ({
      id: span.uncertaintyId,
      reason: span.reason === "text-conflict" ? "TranscriptDisagreement" as const : span.reason === "speaker-gap" ? "NoSpeakerEvidence" as const : "AmbiguousSpeakerEvidence" as const,
      startMs: span.startMs,
      endMs: span.endMs,
      wordIds: span.evidenceIds.filter((id) => knownWordIds.has(id)),
      diarizationSegmentIds: span.evidenceIds.filter((id) => !knownWordIds.has(id)),
    })).filter((span) => span.wordIds.length > 0),
  };
};

const aggregateChunkTranscriptionProvenance = async (
  results: readonly { readonly provenance: TranscriptionProvenance }[],
  requests: readonly GenerationTranscriptionRequest[],
): Promise<TranscriptionProvenance> => {
  const first = results[0]?.provenance;
  if (first === undefined || results.length !== requests.length) {
    throw new Error("CueBench transcription chunk checkpoint is incomplete.");
  }
  const timings = results.map((result) => result.provenance.timing).filter((timing): timing is NonNullable<TranscriptionProvenance["timing"]> => timing !== undefined);
  const timing = timings.length === 0 ? undefined : {
    startedAtMs: Math.min(...timings.map((value) => value.startedAtMs)),
    completedAtMs: Math.max(...timings.map((value) => value.completedAtMs)),
    durationMs: Math.max(...timings.map((value) => value.completedAtMs)) - Math.min(...timings.map((value) => value.startedAtMs)),
  };
  const layout = requests.map((request) => ({
    index: request.index,
    offsetMs: request.offsetMs,
    endMs: request.endMs,
    overlapWithPreviousMs: request.overlapWithPreviousMs,
  }));
  return {
    model: first.model,
    requestHash: await sha256Hex(results.map((result) => result.provenance.requestHash).join(":")),
    responseHash: await sha256Hex(results.map((result) => result.provenance.responseHash).join(":")),
    requestMetadata: {
      ...(first.requestMetadata ?? {}),
      sourceAudioChunking: "wav-overlap-frame-aligned",
      sourceAudioChunkCount: String(requests.length),
      sourceAudioChunkOverlapMs: String(Math.max(0, ...requests.map((request) => request.overlapWithPreviousMs))),
      sourceAudioChunkLayoutSha256: await sha256Hex(canonicalSerialize(layout)),
    },
    warnings: [...new Set(results.flatMap((result) => result.provenance.warnings ?? []))].slice(0, 32),
    ...(timing === undefined ? {} : { timing }),
  };
};

const captionDependenciesFor = (env: WorkerEnv, bucket: R2Bucket): CaptionGenerationDependencies => {
  const settings = resolveWorkerSettings(env);
  if (env.MEDIA_PREPARER === undefined || settings.mediaJobSigning === undefined) {
    throw new Error("CueBench media preparation is not configured for generation.");
  }
  const provider = createOpenAIProvider({
    ...(env.CUEBENCH_OPENAI_MODE === undefined ? {} : { CUEBENCH_OPENAI_MODE: env.CUEBENCH_OPENAI_MODE }),
    ...(env.OPENAI_API_KEY === undefined ? {} : { OPENAI_API_KEY: env.OPENAI_API_KEY }),
    ...(env.OPENAI_BASE_URL === undefined ? {} : { CUEBENCH_OPENAI_BASE_URL: env.OPENAI_BASE_URL }),
    ...(env.CUEBENCH_RECONCILIATION_MODEL === undefined ? {} : { CUEBENCH_RECONCILIATION_MODEL: env.CUEBENCH_RECONCILIATION_MODEL }),
  });
  const preparation = fixtureMediaPreparation(env, settings.mediaJobSigning)
    ?? new MediaContainerPreparationService(env.MEDIA_PREPARER, settings.mediaJobSigning);
  const chunkPlan = async (audio: PreparedAudio): Promise<readonly GenerationTranscriptionRequest[]> => {
    const chunks = splitWavForOpenAITranscription({
      bytes: await privateAudioBytes(bucket, audio),
      contentType: audio.contentType,
      durationMs: audio.durationMs,
      fileName: "normalized.wav",
    });
    return chunks.map((chunk, index) => ({
      requestKey: `chunk-${index + 1}`,
      index,
      offsetMs: chunk.offsetMs,
      endMs: chunk.endMs,
      overlapWithPreviousMs: chunk.overlapWithPreviousMs,
    }));
  };
  const chunkFor = async (audio: PreparedAudio, request: GenerationTranscriptionRequest) => {
    const chunks = splitWavForOpenAITranscription({
      bytes: await privateAudioBytes(bucket, audio),
      contentType: audio.contentType,
      durationMs: audio.durationMs,
      fileName: "normalized.wav",
    });
    const chunk = chunks[request.index];
    if (
      chunk === undefined
      || request.requestKey !== `chunk-${request.index + 1}`
      || chunk.offsetMs !== request.offsetMs
      || chunk.endMs !== request.endMs
      || chunk.overlapWithPreviousMs !== request.overlapWithPreviousMs
    ) throw new Error("CueBench transcription chunk plan changed during durable resume.");
    return chunk;
  };
  return {
    preparation,
    artifacts: { readManifest: (manifest) => exactPreparedManifest(bucket, manifest) },
    transcription: {
      diarize: async ({ audio }) => {
        const startedAtMs = Date.now();
        const diarization = await provider.diarize({
          bytes: await privateAudioBytes(bucket, audio),
          contentType: audio.contentType,
          durationMs: audio.durationMs,
          fileName: "normalized.wav",
        });
        const completedAtMs = Date.now();
        return {
          speakerSegments: diarization.value.segments.map((segment) => ({
            id: segment.id,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speaker: segment.speaker,
            text: segment.text,
          })),
          provenance: transcriptProvenance(diarization, { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs }),
        };
      },
      wordTimestamps: async ({ audio }) => {
        const startedAtMs = Date.now();
        const wordTimestamps = await provider.wordTimestamps({
          bytes: await privateAudioBytes(bucket, audio),
          contentType: audio.contentType,
          durationMs: audio.durationMs,
          fileName: "normalized.wav",
        });
        const completedAtMs = Date.now();
        return {
          words: wordTimestamps.value.words.map((word) => ({
            startMs: word.startMs,
            endMs: word.endMs,
            text: word.text,
            ...(word.chunkSeamConflict ? { chunkSeamConflict: true } : {}),
          })),
          provenance: transcriptProvenance(wordTimestamps, { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs }),
        };
      },
      resumable: {
        requests: async ({ audio }) => chunkPlan(audio),
        diarizeRequest: async ({ audio, request: chunkRequest }) => {
          const chunk = await chunkFor(audio, chunkRequest);
          const startedAtMs = Date.now();
          // `chunk.input` is bounded below the OpenAI file cap, so this is
          // exactly one external request even in the live provider.
          const diarization = await provider.diarize(chunk.input);
          const completedAtMs = Date.now();
          return {
            speakerSegments: diarization.value.segments.map((segment, index) => {
              const startMs = chunk.offsetMs + segment.startMs;
              const endMs = chunk.offsetMs + segment.endMs;
              if (startMs < chunk.offsetMs || endMs <= startMs || endMs > chunk.endMs || endMs > audio.durationMs) {
                throw new Error("CueBench received a diarization timestamp outside its bounded OpenAI chunk.");
              }
              return {
                id: `speaker-chunk-${chunkRequest.index + 1}-${index + 1}`,
                startMs,
                endMs,
                speaker: `chunk-${chunkRequest.index + 1}:${segment.speaker}`,
                text: segment.text,
              };
            }),
            provenance: transcriptProvenance(diarization, { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs }),
          };
        },
        wordTimestampRequest: async ({ audio, request: chunkRequest }) => {
          const chunk = await chunkFor(audio, chunkRequest);
          const startedAtMs = Date.now();
          // As above, this calls exactly one bounded Whisper request.
          const wordTimestamps = await provider.wordTimestamps(chunk.input);
          const completedAtMs = Date.now();
          return {
            words: wordTimestamps.value.words.map((word) => {
              const startMs = chunk.offsetMs + word.startMs;
              const endMs = chunk.offsetMs + word.endMs;
              if (startMs < chunk.offsetMs || endMs <= startMs || endMs > chunk.endMs || endMs > audio.durationMs) {
                throw new Error("CueBench received a word timestamp outside its bounded OpenAI chunk.");
              }
              return { ...word, startMs, endMs };
            }),
            provenance: transcriptProvenance(wordTimestamps, { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs }),
          };
        },
        aggregateDiarization: async ({ requests, results }) => ({
          speakerSegments: results.flatMap((result) => result.value.speakerSegments),
          provenance: {
            ...(await aggregateChunkTranscriptionProvenance(results.map((result) => result.value), requests)),
            ...(requests.length > 1 ? {
              warnings: [...new Set([
                ...results.flatMap((result) => result.value.provenance.warnings ?? []),
                "speaker-identities-are-chunk-local",
              ])].slice(0, 32),
            } : {}),
          },
        }),
        aggregateWordTimestamps: async ({ requests, results }) => {
          const words = reconcileChunkSeamWords(
            requests,
            results.map((result) => result.value.words),
          );
          const provenance = await aggregateChunkTranscriptionProvenance(results.map((result) => result.value), requests);
          return {
            words,
            provenance: {
              ...provenance,
              warnings: [...new Set([
                ...(provenance.warnings ?? []),
                ...(words.some((word) => word.chunkSeamConflict) ? ["chunk-seam-word-disagreement"] : []),
              ])].slice(0, 32),
            },
          };
        },
      },
    },
    reconciliation: {
      reconcile: async ({ runId, alignedWords, uncertaintySpans }) => {
        const startedAtMs = Date.now();
        const evidence = reconciliationEvidenceFor(alignedWords, uncertaintySpans);
        const result = await reconcileCaptionEvidence(provider, evidence);
        const completedAtMs = Date.now();
        const originalById = new Map(alignedWords.map((word) => [word.evidenceId, word]));
        return {
          words: result.words.map((word) => {
            const original = originalById.get(word.id);
            if (original === undefined) throw new Error("CueBench reconciliation returned an unknown evidence word.");
            return { ...original, text: word.text };
          }),
          provenance: await reconcileProvenance(runId, result.provenance, result.provenance.length === 0
            ? undefined
            : { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs }),
        };
      },
      resumable: {
        requests: async ({ alignedWords, uncertaintySpans }) => (
          createReconciliationWindows(reconciliationEvidenceFor(alignedWords, uncertaintySpans)).map((window, index) => ({
            requestKey: `window-${index + 1}`,
            window,
          }))
        ),
        reconcileRequest: async ({ request: windowRequest }) => {
          const startedAtMs = Date.now();
          const result = await reconcileCaptionEvidenceWindow(provider, windowRequest.window);
          const completedAtMs = Date.now();
          return {
            ...result,
            requestKey: windowRequest.requestKey,
            timing: { startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs },
          };
        },
        aggregate: async ({ runId, alignedWords, uncertaintySpans, results }) => {
          const evidence = reconciliationEvidenceFor(alignedWords, uncertaintySpans);
          const result = applyReconciliationWindowResults(evidence, results);
          const originalById = new Map(alignedWords.map((word) => [word.evidenceId, word]));
          const timings = results.map((entry) => entry.timing).filter((timing): timing is NonNullable<GenerationReconciliationCheckpoint["timing"]> => timing !== undefined);
          const timing = timings.length === 0 ? undefined : {
            startedAtMs: Math.min(...timings.map((value) => value.startedAtMs)),
            completedAtMs: Math.max(...timings.map((value) => value.completedAtMs)),
            durationMs: Math.max(...timings.map((value) => value.completedAtMs)) - Math.min(...timings.map((value) => value.startedAtMs)),
          };
          return {
            words: result.words.map((word) => {
              const original = originalById.get(word.id);
              if (original === undefined) throw new Error("CueBench reconciliation returned an unknown evidence word.");
              return { ...original, text: word.text };
            }),
            provenance: await reconcileProvenance(runId, result.provenance, timing),
          };
        },
      },
    },
  };
};

export interface CaptionGenerationRunWorkflowParameters {
  /** Signed generation capability; each Workflow instance owns exactly one run. */
  readonly generationReceipt: string;
  /** Private upload capability retained only in the run record and Workflow params. */
  readonly uploadReceipt: string;
}

/**
 * Legacy upload completion retains a no-provider accounting instance while
 * Task 11's conservative reservation reconciles. It never invokes prepare;
 * generation itself always uses the run-specific parameter shape above.
 */
export interface UploadAccountingWorkflowParameters {
  readonly receipt: string;
  readonly objectKey: string;
}

export type CaptionGenerationWorkflowParameters = CaptionGenerationRunWorkflowParameters | UploadAccountingWorkflowParameters;

/**
 * Actual Cloudflare Workflow binding. Upload completion never creates this
 * instance: the generation route creates one deterministic instance per run.
 * This makes an adopted/cancelled run restartable with a new run id rather
 * than stranding a later start behind a completed one-shot Workflow.
 */
export class CaptionGenerationWorkflow extends WorkflowEntrypoint<WorkerEnv, CaptionGenerationWorkflowParameters> {
  public override async run(event: Readonly<WorkflowEvent<CaptionGenerationWorkflowParameters>>, step: WorkflowStep): Promise<void> {
    if (!("generationReceipt" in event.payload)) {
      // This compatibility instance deliberately performs no media preparation
      // or provider call. The generation route creates the only Workflow that
      // can touch Task 12's prepare capability.
      return;
    }
    const payload: CaptionGenerationRunWorkflowParameters = event.payload;
    const verified = await step.do("verify caption-generation receipt", async () => {
      const settings = resolveWorkerSettings(this.env);
      const [generation, upload] = await Promise.all([
        verifyGenerationRunReceipt(payload.generationReceipt, settings, Date.now()),
        verifyUploadReceipt(payload.uploadReceipt, settings, Date.now()),
      ]);
      if (
        generation.operationKey !== upload.operationKey
        || generation.operationId !== upload.operationId
        || generation.objectKey !== upload.objectKey
        || generation.sessionKey !== upload.sessionKey
        || generation.sourceByteLength !== upload.media.byteLength
        || generation.sourceDurationMs !== upload.media.durationMs
      ) throw new Error("CueBench generation receipt does not match its private upload.");
      return { generation, uploadMedia: upload.media, uploadExpiresAtMs: upload.expiresAtMs };
    });
    const claims = verified.generation;
    if (this.env.PROCESSING_BUCKET === undefined) throw new Error("CueBench private generation storage is not configured.");
    const records = new R2GenerationRunRecordStore(this.env.PROCESSING_BUCKET);
    const record = await records.load(claims);
    if (
      record === null
      || record.receipt !== payload.generationReceipt
      || record.uploadReceipt !== payload.uploadReceipt
    ) throw new Error("CueBench generation recovery record is unavailable.");
    if (verified.uploadMedia.contentType !== "video/mp4" && verified.uploadMedia.contentType !== "video/webm") {
      throw new Error("CueBench generation receipt has an unsupported private media type.");
    }
    const billableSteps: BillableGenerationStepExecutor = {
      // A successful Workflows step retains its serializable provider response
      // through a later R2 checkpoint crash. With retries disabled, an
      // accepted-but-unsaved request cannot be silently replayed by Workers.
      // Cloudflare requires a complete retry policy. One permitted retry is
      // safe here: the write-ahead provider-attempt fence causes a retried
      // callback to fail closed before it can issue a second billable call.
      run: (pass, requestKey, work) => step.do(`caption provider ${pass}:${requestKey}`, {
        retries: { limit: 1, delay: "1 second", backoff: "constant" },
        timeout: "5 minutes",
      }, work),
    };
    const runner = new CaptionGenerationRunner(
      new GenerationRunRecordBackedStore(records, claims),
      captionDependenciesFor(this.env, this.env.PROCESSING_BUCKET),
      billableSteps,
    );
    await runner.run({
      runId: claims.runId,
      projectId: claims.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: claims.expectedProjectRevision,
      expectedQualityProfileRevision: claims.expectedQualityProfileRevision,
      mediaSha256: claims.mediaSha256,
      sourceByteLength: claims.sourceByteLength,
      sourceDurationMs: claims.sourceDurationMs,
      ...(record.qualityProfileRules === undefined ? {} : { qualityProfileRules: record.qualityProfileRules }),
      operation: {
        operationId: claims.operationId,
        operationKey: claims.operationKey,
        objectKey: claims.objectKey,
        inputByteLength: verified.uploadMedia.byteLength,
        inputContentType: verified.uploadMedia.contentType,
        operationReceipt: payload.uploadReceipt,
        receiptExpiresAtMs: verified.uploadExpiresAtMs,
      },
    });
  }
}
