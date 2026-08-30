import {
  CaptionEvidenceBundleSchema,
  MAX_LOCAL_CAPTION_EVIDENCE_WORDS,
  StagedGenerationResultSchema,
  type CaptionEvidenceBundle,
  type CaptionEvidenceWord,
  type GenerationProviderProvenance,
  type GenerationRunStatus,
  type StagedCaptionCue,
  type StagedGenerationResult,
  type UncertaintySpan,
} from "@cuebench/contracts";
import { resolveEducationProfileRules } from "@cuebench/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { MediaPreparation, MediaPreparationRequest, PreparedMediaManifest } from "../probe";
import {
  R2GenerationRunRecordStore,
  verifyGenerationRunReceipt,
  type GenerationRunRecord,
  type GenerationRunRecordStore,
} from "../generation-routes";
import { resolveWorkerSettings, type WorkerEnv } from "../env";
import { MediaContainerPreparationService } from "../probe";
import { fixtureMediaPreparation } from "../media-preparation-fixture";
import { verifyUploadReceipt } from "../uploads";
import {
  createOpenAIProvider,
  sha256Hex,
  type ProviderCallProvenance,
} from "../openai/client";
import { alignCaptionEvidence, normalizeForAlignment } from "../openai/transcription";
import { reconcileCaptionEvidence } from "../openai/reconcile";

const DAY_MS = 24 * 60 * 60 * 1_000;
const clone = <Value>(value: Value): Value => structuredClone(value);
const sha256 = /^[0-9a-f]{64}$/i;

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
}

export interface TranscriptionProvenance {
  readonly model: string;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly requestMetadata?: Readonly<Record<string, string>>;
  readonly warnings?: readonly string[];
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
  };
  readonly reconciliation: {
    readonly reconcile: (input: {
      readonly runId: string;
      readonly alignedWords: readonly AlignedCaptionWord[];
      readonly uncertaintySpans: readonly UncertaintySpan[];
    }) => Promise<ReconciliationResult>;
  };
  readonly clock?: () => number;
}

export interface PersistedGenerationRun {
  readonly request: GenerationStartRequest;
  readonly stageHistory: readonly GenerationRunStatus[];
  readonly cancelled: boolean;
  readonly preparedManifest?: PreparedMediaManifest;
  readonly manifest?: PreparedMediaManifestContents;
  /** Independent durable checkpoints prevent retried runs from repeating a completed billable pass. */
  readonly diarization?: DiarizationTranscription;
  readonly wordTimestamps?: WordTimestampTranscription;
  readonly aligned?: { readonly words: readonly AlignedCaptionWord[]; readonly uncertaintySpans: readonly UncertaintySpan[] };
  readonly reconciled?: ReconciliationResult;
  readonly staged?: StagedGenerationResult;
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
const persistArtifacts = async (
  store: GenerationRunStore,
  run: PersistedGenerationRun,
  patch: Omit<Partial<PersistedGenerationRun>, "request" | "stageHistory" | "cancelled">,
): Promise<PersistedGenerationRun> => {
  const latest = await store.read(run.request.runId) ?? run;
  if (isCancelled(latest)) return latest;
  const next: PersistedGenerationRun = { ...latest, ...patch };
  await store.save(next);
  return next;
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
  const words = shared.words.map((word) => {
    const evidenceId = `word-${input.runId}-${word.wordPassIndex + 1}`;
    idBySharedId.set(word.id, evidenceId);
    return {
      evidenceId,
      sourceWordIndex: word.wordPassIndex,
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text.trim(),
      speaker: word.speaker,
      speakerSegmentIds: [...word.diarizationSegmentIds],
    };
  });
  return {
    words,
    uncertaintySpans: shared.uncertaintySpans.map((span, index) => ({
      uncertaintyId: `uncertainty-${input.runId}-${index + 1}`,
      startMs: span.startMs,
      endMs: span.endMs,
      reason: span.reason === "NoSpeakerEvidence"
        ? "speaker-gap"
        : span.reason === "TranscriptDisagreement"
          ? "text-conflict"
          : "speaker-conflict",
      evidenceIds: [
        ...span.wordIds.map((id) => idBySharedId.get(id)).filter((id): id is string => id !== undefined),
        ...span.diarizationSegmentIds,
      ],
    })),
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

const providerProvenance = (role: GenerationProviderProvenance["role"], source: TranscriptionProvenance | ReconciliationResult["provenance"]): GenerationProviderProvenance => ({
  role,
  model: source.model,
  requestHash: source.requestHash,
  responseHash: source.responseHash,
  // Audio transcription exposes no `store` option. Preserve that capability
  // truthfully instead of mislabeling it as a Responses `store:false` call.
  store: "store" in source ? source.store : null,
  requestMetadata: source.requestMetadata ?? {},
  warnings: [...(source.warnings ?? [])],
});

const validPreparedAudio = (audio: PreparedAudio): boolean => (
  sha256.test(audio.sha256)
  && typeof audio.key === "string" && audio.key.startsWith("prepared/")
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

/**
 * The deterministic core of the Cloudflare Workflow. It is deliberately
 * dependency-injected so fixture mode exercises exact durable semantics with
 * no OpenAI key or outbound network access.
 */
export class CaptionGenerationRunner {
  public constructor(
    private readonly store: GenerationRunStore,
    private readonly dependencies: CaptionGenerationDependencies,
  ) {}

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
        if (!validPreparedAudio(manifest.normalizedAudio) || !matchesAuthoritativeSource(manifest, request)) {
          throw new Error("CueBench prepared media manifest does not match this signed source identity.");
        }
        run = await persistArtifacts(this.store, run, { manifest: clone(manifest) });
      }

      if (run.diarization === undefined) {
        run = await appendStage(this.store, run, "Transcribing", { progress: 0 });
        const diarization = await this.dependencies.transcription.diarize({ runId: request.runId, audio: run.manifest!.normalizedAudio });
        run = await persistArtifacts(this.store, run, { diarization: clone(diarization) });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.wordTimestamps === undefined) {
        run = await appendStage(this.store, run, "Transcribing", { progress: 0.5 });
        const wordTimestamps = await this.dependencies.transcription.wordTimestamps({ runId: request.runId, audio: run.manifest!.normalizedAudio });
        run = await persistArtifacts(this.store, run, { wordTimestamps: clone(wordTimestamps) });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.aligned === undefined) {
        run = await appendStage(this.store, run, "AligningEvidence", { progress: 0 });
        run = await persistArtifacts(this.store, run, { aligned: alignSpeakerSegmentsToWords({ runId: request.runId, words: run.wordTimestamps!.words, speakerSegments: run.diarization!.speakerSegments }) });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.reconciled === undefined) {
        run = await appendStage(this.store, run, "ReconcilingTranscript", { progress: 0 });
        const reconciled = await this.dependencies.reconciliation.reconcile({
          runId: request.runId,
          alignedWords: run.aligned!.words,
          uncertaintySpans: run.aligned!.uncertaintySpans,
        });
        run = await persistArtifacts(this.store, run, { reconciled: clone(reconciled) });
      }
      if (await cancellationBoundary(this.store, run) !== null) return;

      if (run.reconciled!.words.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
        throw new Error("CueBench cannot stage evidence beyond the bounded Local Evidence Package.");
      }

      run = await appendStage(this.store, run, "SegmentingCaptions", { progress: 0 });
      const captions = segmentEducationCaptions({
        runId: request.runId,
        words: run.reconciled!.words,
        durationMs: run.manifest!.source.durationMs,
        ...(request.qualityProfileRules === undefined ? {} : { profileRules: request.qualityProfileRules }),
      });
      const createdAtMs = this.dependencies.clock?.() ?? Date.now();
      const evidence: CaptionEvidenceBundle = CaptionEvidenceBundleSchema.parse({
        contractVersion: 1,
        runId: request.runId,
        projectId: request.projectId,
        mediaSha256: request.mediaSha256,
        preparedManifest: run.preparedManifest,
        normalizedAudio: run.manifest!.normalizedAudio,
        words: run.reconciled!.words,
        uncertaintySpans: run.aligned!.uncertaintySpans,
        provenance: [
          providerProvenance("diarization", run.diarization!.provenance),
          providerProvenance("word-timestamps", run.wordTimestamps!.provenance),
          providerProvenance("reconciliation", run.reconciled!.provenance),
        ],
      });
      const staged = StagedGenerationResultSchema.parse({
        contractVersion: 1,
        runId: request.runId,
        projectId: request.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: request.expectedProjectRevision,
        expectedQualityProfileRevision: request.expectedQualityProfileRevision,
        evidence,
        captions,
        createdAtMs,
        expiresAtMs: createdAtMs + DAY_MS,
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
const MAX_NORMALIZED_AUDIO_BYTES = 40 * 1024 * 1024;
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

const exactPreparedManifest = async (
  bucket: R2Bucket,
  reference: PreparedMediaManifest,
): Promise<PreparedMediaManifestContents> => {
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
    typeof audioKey !== "string" || !audioKey.startsWith("prepared/")
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

const privateAudioBytes = async (bucket: R2Bucket, audio: PreparedAudio): Promise<Uint8Array> => {
  const object = await bucket.get(audio.key);
  if (object === null || object.size !== audio.byteLength || object.size > MAX_NORMALIZED_AUDIO_BYTES) {
    throw new Error("CueBench normalized private audio is unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== audio.sha256) throw new Error("CueBench normalized private audio integrity check failed.");
  return bytes;
};

const usageMetadata = (usage: ProviderCallProvenance["usage"]): Readonly<Record<string, string>> => (
  usage === null ? {} : { usage: JSON.stringify(usage) }
);

const transcriptProvenance = (value: ProviderCallProvenance): TranscriptionProvenance => ({
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
  return {
    preparation,
    artifacts: { readManifest: (manifest) => exactPreparedManifest(bucket, manifest) },
    transcription: {
      diarize: async ({ audio }) => {
        const diarization = await provider.diarize({
          bytes: await privateAudioBytes(bucket, audio),
          contentType: audio.contentType,
          durationMs: audio.durationMs,
          fileName: "normalized.wav",
        });
        return {
          speakerSegments: diarization.value.segments.map((segment) => ({
            id: segment.id,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speaker: segment.speaker,
            text: segment.text,
          })),
          provenance: transcriptProvenance(diarization),
        };
      },
      wordTimestamps: async ({ audio }) => {
        const wordTimestamps = await provider.wordTimestamps({
          bytes: await privateAudioBytes(bucket, audio),
          contentType: audio.contentType,
          durationMs: audio.durationMs,
          fileName: "normalized.wav",
        });
        return {
          words: wordTimestamps.value.words.map((word) => ({ startMs: word.startMs, endMs: word.endMs, text: word.text })),
          provenance: transcriptProvenance(wordTimestamps),
        };
      },
    },
    reconciliation: {
      reconcile: async ({ runId, alignedWords, uncertaintySpans }) => {
        const knownWordIds = new Set(alignedWords.map((word) => word.evidenceId));
        const evidence = {
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
        const result = await reconcileCaptionEvidence(provider, evidence);
        const originalById = new Map(alignedWords.map((word) => [word.evidenceId, word]));
        return {
          words: result.words.map((word) => {
            const original = originalById.get(word.id);
            if (original === undefined) throw new Error("CueBench reconciliation returned an unknown evidence word.");
            return { ...original, text: word.text };
          }),
          provenance: await reconcileProvenance(runId, result.provenance),
        };
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
    await step.do("run durable caption generation", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
      if (this.env.PROCESSING_BUCKET === undefined) throw new Error("CueBench private generation storage is not configured.");
      const records = new R2GenerationRunRecordStore(this.env.PROCESSING_BUCKET);
      const record = await records.load(claims);
      if (
        record === null
        || record.receipt !== payload.generationReceipt
        || record.uploadReceipt !== payload.uploadReceipt
      ) throw new Error("CueBench generation recovery record is unavailable.");
      const runner = new CaptionGenerationRunner(
        new GenerationRunRecordBackedStore(records, claims),
        captionDependenciesFor(this.env, this.env.PROCESSING_BUCKET),
      );
      if (verified.uploadMedia.contentType !== "video/mp4" && verified.uploadMedia.contentType !== "video/webm") {
        throw new Error("CueBench generation receipt has an unsupported private media type.");
      }
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
      return { runId: claims.runId, stage: (await records.load(claims))?.status.stage ?? "Failed" };
    });
  }
}
