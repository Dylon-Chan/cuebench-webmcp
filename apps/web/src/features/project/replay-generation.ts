import {
  GenerationRunStatusSchema,
  StagedGenerationResultSchema,
  type GenerationProviderProvenance,
  type GenerationRunStatus,
  type StagedGenerationResult,
} from "@cuebench/contracts";
import {
  canonicalSerialize,
  currentValidationRun,
  sha256Hex,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import referenceProjectFixture from "../../../../../tools/sample/reference-project.json";
import referenceTranscriptFixture from "../../../../../tools/sample/reference-transcript.json";
import replayEventsFixture from "../../../../../tools/sample/replay-events.json";
import type { GenerationClientReceipt } from "../generation/generation-client";

const aiActor = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const systemActor = { type: "System" as const, id: "validator" };
const maxRetentionMs = 24 * 60 * 60 * 1_000;

export const DEMONSTRATION_REPLAY_LABEL = "Demonstration replay" as const;
export const DEMONSTRATION_REPLAY_RUN_ID = "demonstration-replay-captions-v1" as const;

export const DEMONSTRATION_REPLAY_STAGE_SEQUENCE = [
  "Queued",
  "PreparingMedia",
  "Transcribing",
  "AligningEvidence",
  "ReconcilingTranscript",
  "SegmentingCaptions",
  "AwaitingAdoption",
  "Completed",
] as const satisfies readonly GenerationRunStatus["stage"][];

export const SAMPLE_MEDIA_SHA256 = referenceProjectFixture.media.sha256.toLowerCase();
export const SAMPLE_MEDIA_DURATION_MS = referenceProjectFixture.media.durationMs;
export const DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256 = replayEventsFixture.fixtureContentSha256.toLowerCase();

type CaptionGenerationAdoptionCommand = Extract<DomainCommand, {
  readonly type: "AdoptCaptionGenerationResult";
}>;

export interface DemonstrationReplayStore {
  readonly getSnapshot: () => {
    readonly project: CaptionProject | null;
    readonly mode?: "durable" | "temporary" | null;
  };
  readonly executeCommand: (command: DomainCommand, expectedProjectId?: string) => Promise<CommandResult>;
  readonly persistCaptionGenerationReceipt: (runId: string, receipt: GenerationClientReceipt) => Promise<void>;
  readonly deleteCaptionGenerationReceipt?: (runId: string) => Promise<void>;
  readonly loadCaptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly adoptStagedCaptionGenerationResult: (command: CaptionGenerationAdoptionCommand) => Promise<CommandResult>;
  readonly getCloudProjectOwnerCapability?: (projectId: string) => Promise<string | null>;
}

export interface DemonstrationReplayResult {
  readonly label: typeof DEMONSTRATION_REPLAY_LABEL;
  readonly provider: { readonly kind: "deterministic-replay"; readonly live: false };
  readonly runId: string;
  readonly stagedResultSha256: string;
  /** Stable across project ids/revisions; distinct from the bound adoption payload hash. */
  readonly fixtureContentSha256: string;
  readonly expectedFindingRuleIds: readonly string[];
  readonly project: CaptionProject;
}

export interface DemonstrationReplayInput {
  readonly project: CaptionProject;
  readonly store: DemonstrationReplayStore;
  readonly onStatus?: (status: GenerationRunStatus) => void;
  /** UI-only pacing. Tests and non-visual consumers may leave this at zero. */
  readonly stageDelayMs?: number;
  /** Test seam for the current local replay retention envelope. */
  readonly clock?: () => number;
}

type ReplayCheckpointPhase = "staged" | "acknowledged";

interface DemonstrationReplayCheckpoint {
  readonly version: 1;
  readonly phase: ReplayCheckpointPhase;
  readonly fixtureContentSha256: string;
  readonly stagedResultSha256: string;
  readonly stagedCreatedAtMs: number;
  readonly stagedExpiresAtMs: number;
  readonly recordedCreatedAtMs: number;
  readonly recordedExpiresAtMs: number;
}

type DemonstrationReplayReceipt = GenerationClientReceipt & {
  readonly demonstrationReplay: DemonstrationReplayCheckpoint;
};

interface TranscriptSegmentFixture {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string | null;
  readonly text: string;
  readonly spoken: boolean;
}

interface ReplayCaptionFixture {
  readonly cueId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string | null;
  readonly segmentIds: readonly string[];
}

interface ReplayStageFixture {
  readonly stage: GenerationRunStatus["stage"];
  readonly progress?: number;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const requireCommandSuccess = (result: CommandResult, operation: string): CommandResult => {
  if (result.error === undefined) return result;
  return fail(`${operation}: ${result.error.message}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const fixtureSegments = (): readonly TranscriptSegmentFixture[] => {
  const candidate: unknown = referenceTranscriptFixture;
  if (!isRecord(candidate) || candidate.schemaVersion !== 1 || !Array.isArray(candidate.segments)) {
    return fail("CueBench's checked-in reference transcript is invalid.");
  }
  const segments: TranscriptSegmentFixture[] = [];
  for (const value of candidate.segments) {
    if (
      !isRecord(value)
      || typeof value.id !== "string"
      || typeof value.startMs !== "number"
      || typeof value.endMs !== "number"
      || (typeof value.speaker !== "string" && value.speaker !== null)
      || typeof value.text !== "string"
      || typeof value.spoken !== "boolean"
      || !Number.isSafeInteger(value.startMs)
      || !Number.isSafeInteger(value.endMs)
      || value.startMs < 0
      || value.endMs <= value.startMs
    ) return fail("CueBench's checked-in reference transcript contains an invalid segment.");
    segments.push({
      id: value.id,
      startMs: value.startMs,
      endMs: value.endMs,
      speaker: value.speaker,
      text: value.text,
      spoken: value.spoken,
    });
  }
  return segments;
};

const fixtureStages = (): readonly ReplayStageFixture[] => {
  const candidate: unknown = replayEventsFixture;
  if (
    !isRecord(candidate)
    || candidate.schemaVersion !== 1
    || candidate.label !== DEMONSTRATION_REPLAY_LABEL
    || !isRecord(candidate.provider)
    || candidate.provider.kind !== "deterministic-replay"
    || candidate.provider.live !== false
    || !Array.isArray(candidate.stages)
  ) return fail("CueBench's deterministic demonstration replay fixture is invalid.");
  const stages: ReplayStageFixture[] = candidate.stages.map((value) => {
    if (!isRecord(value) || typeof value.stage !== "string") {
      return fail("CueBench's demonstration replay has an invalid stage record.");
    }
    const stage = value.stage as GenerationRunStatus["stage"];
    const progress = value.progress;
    if (progress !== undefined && (typeof progress !== "number" || progress < 0 || progress > 1)) {
      return fail("CueBench's demonstration replay has invalid stage progress.");
    }
    return progress === undefined ? { stage } : { stage, progress };
  });
  if (canonicalSerialize(stages.map((entry) => entry.stage)) !== canonicalSerialize(DEMONSTRATION_REPLAY_STAGE_SEQUENCE)) {
    return fail("CueBench's demonstration replay stage sequence changed unexpectedly.");
  }
  return stages;
};

const fixtureCaptions = (): readonly ReplayCaptionFixture[] => {
  const candidate: unknown = replayEventsFixture;
  if (!isRecord(candidate) || !Array.isArray(candidate.captions)) {
    return fail("CueBench's deterministic demonstration replay has no caption fixture.");
  }
  return candidate.captions.map((value) => {
    if (
      !isRecord(value)
      || typeof value.cueId !== "string"
      || typeof value.startMs !== "number"
      || typeof value.endMs !== "number"
      || typeof value.text !== "string"
      || (typeof value.speaker !== "string" && value.speaker !== null)
      || !Array.isArray(value.segmentIds)
      || value.segmentIds.some((id) => typeof id !== "string")
    ) return fail("CueBench's deterministic demonstration replay contains an invalid caption.");
    return {
      cueId: value.cueId,
      startMs: value.startMs,
      endMs: value.endMs,
      text: value.text,
      speaker: value.speaker,
      segmentIds: value.segmentIds as string[],
    };
  });
};

const fixtureString = (name: "runId"): string => {
  const candidate: unknown = replayEventsFixture;
  if (!isRecord(candidate) || typeof candidate[name] !== "string") {
    return fail(`CueBench's deterministic demonstration replay has no ${name}.`);
  }
  return candidate[name];
};

const fixtureInteger = (name: "recordedCreatedAtMs" | "recordedExpiresAtMs"): number => {
  const candidate: unknown = replayEventsFixture;
  if (!isRecord(candidate) || typeof candidate[name] !== "number" || !Number.isSafeInteger(candidate[name])) {
    return fail(`CueBench's deterministic demonstration replay has no valid ${name}.`);
  }
  return candidate[name];
};

const replayFixtureWithoutDeclaredHash = (): Readonly<Record<string, unknown>> => {
  const candidate: unknown = replayEventsFixture;
  if (!isRecord(candidate)) return fail("CueBench's deterministic demonstration replay fixture is invalid.");
  const fixture: Record<string, unknown> = { ...candidate };
  delete fixture.fixtureContentSha256;
  return fixture;
};

const fixtureExpectedFindingRuleIds = (): readonly string[] => {
  const candidate: unknown = replayEventsFixture;
  if (
    !isRecord(candidate)
    || !Array.isArray(candidate.expectedFindingRuleIds)
    || candidate.expectedFindingRuleIds.some((ruleId) => typeof ruleId !== "string")
  ) return fail("CueBench's deterministic demonstration replay has invalid expected findings.");
  return [...candidate.expectedFindingRuleIds] as string[];
};

const tokenText = (text: string): readonly string[] => text.trim().split(/\s+/u).filter(Boolean);

const fixtureEvidence = (
  project: CaptionProject,
  runId: string,
  segments: readonly TranscriptSegmentFixture[],
) => {
  let sourceWordIndex = 0;
  let firstNguyenCorrected = false;
  const evidenceIdsBySegment = new Map<string, string[]>();
  const words = segments.flatMap((segment) => {
    if (!segment.spoken) return [];
    const tokens = tokenText(segment.text);
    const evidenceIds: string[] = [];
    const segmentWords = tokens.map((sourceText, tokenIndex) => {
      const evidenceId = `gibbs-word-${String(sourceWordIndex + 1).padStart(3, "0")}`;
      evidenceIds.push(evidenceId);
      const startMs = segment.startMs + Math.floor((tokenIndex * (segment.endMs - segment.startMs)) / tokens.length);
      const endMs = segment.startMs + Math.floor(((tokenIndex + 1) * (segment.endMs - segment.startMs)) / tokens.length);
      const isFirstNguyen = !firstNguyenCorrected && /^Nguyen[.,]?$/u.test(sourceText);
      if (isFirstNguyen) firstNguyenCorrected = true;
      const word = {
        evidenceId,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        text: isFirstNguyen ? sourceText.replace("Nguyen", "Wynn") : sourceText,
        ...(isFirstNguyen ? { sourceText } : {}),
        speaker: segment.speaker,
        speakerSegmentIds: [segment.id],
        sourceWordIndex,
      };
      sourceWordIndex += 1;
      return word;
    });
    evidenceIdsBySegment.set(segment.id, evidenceIds);
    return segmentWords;
  });

  const speakerSegments = segments.filter((segment) => segment.spoken).map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: segment.speaker ?? "Unknown",
    text: segment.text,
  }));
  const reconciledWord = words.find((word) => word.sourceText !== undefined);
  if (reconciledWord === undefined) return fail("The reference transcript no longer contains the proper-name challenge.");

  const profileRulesSha256 = sha256Hex(canonicalSerialize(project.qualityProfile.rules));
  const transcriptHash = sha256Hex(canonicalSerialize(referenceTranscriptFixture));
  const replayHash = sha256Hex(canonicalSerialize(replayFixtureWithoutDeclaredHash()));
  const provenanceFor = (
    role: GenerationProviderProvenance["role"],
    ordinal: number,
  ): GenerationProviderProvenance => ({
    role,
    model: `cuebench-demonstration-fixture-${role}-v1`,
    requestHash: sha256Hex(`${transcriptHash}:${role}:request`),
    responseHash: sha256Hex(`${replayHash}:${role}:response`),
    store: null,
    requestMetadata: {
      replayLabel: DEMONSTRATION_REPLAY_LABEL,
      network: "not-used",
      source: "checked-in-reference-fixture",
      recordedCreatedAtMs: String(fixtureInteger("recordedCreatedAtMs")),
      recordedExpiresAtMs: String(fixtureInteger("recordedExpiresAtMs")),
    },
    warnings: ["Recorded fixture provenance: no live provider request was made."],
    provenanceVersion: 2,
    disposition: "executed",
    skippedReason: null,
    provider: "fixture",
    mode: "fixture",
    endpoint: {
      path: `/fixture/demonstration-replay/${role}`,
      method: "FIXTURE",
      parameters: { sample: "gibbs-free-energy-sample-v1" },
    },
    prompt: null,
    structuredOutput: null,
    qualityProfile: {
      revision: project.qualityProfile.revision,
      rulesSha256: profileRulesSha256,
    },
    timing: {
      startedAtMs: fixtureInteger("recordedCreatedAtMs") + ordinal * 100,
      completedAtMs: fixtureInteger("recordedCreatedAtMs") + ordinal * 100 + 25,
      durationMs: 25,
    },
    usage: { kind: "audio-duration", seconds: SAMPLE_MEDIA_DURATION_MS / 1_000 },
    cost: { kind: "unavailable", reason: "Deterministic checked-in fixture; no provider billing." },
    sourceMediaSha256: project.media.sha256.toLowerCase(),
  });

  return {
    contractVersion: 1 as const,
    runId,
    projectId: project.projectId,
    mediaSha256: project.media.sha256.toLowerCase(),
    preparedManifest: {
      key: `demonstration-replay/${runId}/prepared-manifest.json`,
      sha256: transcriptHash,
    },
    normalizedAudio: {
      key: `demonstration-replay/${runId}/normalized-audio.wav`,
      sha256: sha256Hex(`${project.media.sha256.toLowerCase()}:normalized-audio`),
      byteLength: referenceProjectFixture.media.byteLength,
      durationMs: project.media.durationMs,
      contentType: "audio/wav",
    },
    words,
    speakerSegments,
    uncertaintySpans: [{
      uncertaintyId: "gibbs-uncertainty-proper-name",
      reason: "text-conflict" as const,
      startMs: reconciledWord.startMs,
      endMs: reconciledWord.endMs,
      evidenceIds: [reconciledWord.evidenceId],
    }],
    provenance: [
      provenanceFor("diarization", 1),
      provenanceFor("word-timestamps", 2),
      provenanceFor("reconciliation", 3),
    ],
    evidenceIdsBySegment,
  };
};

interface ReplayStagedBinding {
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

const normalizedFixtureContent = (stagedResult: StagedGenerationResult): Readonly<Record<string, unknown>> => {
  const normalized = structuredClone(stagedResult) as unknown as Record<string, unknown>;
  delete normalized.outputSha256;
  delete normalized.projectId;
  delete normalized.expectedProjectRevision;
  delete normalized.expectedQualityProfileRevision;
  delete normalized.createdAtMs;
  delete normalized.expiresAtMs;
  normalized.recordedEnvelope = {
    createdAtMs: fixtureInteger("recordedCreatedAtMs"),
    expiresAtMs: fixtureInteger("recordedExpiresAtMs"),
  };
  const evidence = normalized.evidence;
  if (!isRecord(evidence)) return fail("The demonstration replay could not normalize its evidence fixture.");
  const normalizedEvidence = evidence as Record<string, unknown>;
  delete normalizedEvidence.projectId;
  if (!Array.isArray(normalizedEvidence.provenance)) {
    return fail("The demonstration replay could not normalize its provider provenance.");
  }
  normalizedEvidence.provenance = normalizedEvidence.provenance.map((entry) => {
    if (!isRecord(entry)) return fail("The demonstration replay contains invalid provider provenance.");
    const stable = { ...entry } as Record<string, unknown>;
    delete stable.qualityProfile;
    return stable;
  });
  return normalized;
};

const fixtureContentSha256For = (stagedResult: StagedGenerationResult): string => (
  sha256Hex(canonicalSerialize(normalizedFixtureContent(stagedResult)))
);

const stagedResultFor = (
  project: CaptionProject,
  runId: string,
  binding: ReplayStagedBinding,
): StagedGenerationResult => {
  const segments = fixtureSegments();
  const evidenceWithIndex = fixtureEvidence(project, runId, segments);
  const { evidenceIdsBySegment, ...evidence } = evidenceWithIndex;
  const wordsById = new Map(evidence.words.map((word) => [word.evidenceId, word]));
  const captions = fixtureCaptions().map((caption) => ({
    cueId: caption.cueId,
    startMs: caption.startMs,
    endMs: caption.endMs,
    text: caption.text,
    speaker: caption.speaker,
    evidenceIds: caption.segmentIds.flatMap((segmentId) => {
      const evidenceIds = evidenceIdsBySegment.get(segmentId);
      return (evidenceIds ?? fail(`Caption ${caption.cueId} references unknown transcript segment ${segmentId}.`))
        .filter((evidenceId) => {
          const word = wordsById.get(evidenceId) ?? fail(`Caption ${caption.cueId} references missing evidence ${evidenceId}.`);
          return word.startMs >= caption.startMs && word.endMs <= caption.endMs;
        });
    }),
  }));
  const payload = {
    contractVersion: 1 as const,
    runId,
    projectId: project.projectId,
    targetTrack: "Captions" as const,
    expectedProjectRevision: binding.expectedProjectRevision,
    expectedQualityProfileRevision: binding.expectedQualityProfileRevision,
    evidence,
    captions,
    createdAtMs: binding.createdAtMs,
    expiresAtMs: binding.expiresAtMs,
  };
  const stagedResult = StagedGenerationResultSchema.parse({
    ...payload,
    outputSha256: sha256Hex(canonicalSerialize(payload)),
  });
  const computedFixtureHash = fixtureContentSha256For(stagedResult);
  if (!/^[0-9a-f]{64}$/u.test(DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256)) {
    return fail("CueBench's demonstration replay fixture content hash is invalid.");
  }
  if (computedFixtureHash !== DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256) {
    return fail(`CueBench's demonstration replay fixture content changed; expected ${DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256}, computed ${computedFixtureHash}.`);
  }
  return stagedResult;
};

const statusFor = (
  stageFixture: ReplayStageFixture,
  projectId: string,
  runId: string,
  expectedProjectRevision: number,
  adoptedProjectRevision?: number,
): GenerationRunStatus => {
  const candidate = {
    contractVersion: 1,
    runId,
    projectId,
    targetTrack: "Captions",
    expectedProjectRevision,
    stage: stageFixture.stage,
    ...(stageFixture.progress === undefined ? {} : { progress: stageFixture.progress }),
    ...(stageFixture.stage === "Completed" ? { adoptedProjectRevision } : {}),
  };
  return GenerationRunStatusSchema.parse(candidate);
};

const hasExactReplayCaptions = (project: CaptionProject): boolean => {
  const captions = fixtureCaptions();
  if (
    project.captions.order.length !== captions.length
    || project.captions.order.some((cueId, index) => cueId !== captions[index]?.cueId)
  ) return false;
  for (const caption of captions) {
    const item = project.captions.items[caption.cueId];
    if (
      item === undefined
      || item.mergedIntoItemId !== null
      || item.revisions.length !== 1
      || item.current.itemRevision !== 1
      || item.current.startMs !== caption.startMs
      || item.current.endMs !== caption.endMs
      || item.current.text !== caption.text
      || item.current.speaker !== caption.speaker
      || item.current.state !== "Proposed"
      || item.current.actor.type !== "CueBenchAI"
      || item.current.actor.id !== aiActor.id
    ) return false;
  }
  const evidencePackage = project.localEvidencePackages.find((entry) => entry.runId === DEMONSTRATION_REPLAY_RUN_ID);
  return evidencePackage?.packageId === `generation-${DEMONSTRATION_REPLAY_RUN_ID}`
    && project.courtRecord.filter((event) => event.type === "AdoptCaptionGenerationResult").length === 1;
};

/**
 * Durable completion projection for reload UI. The short-lived replay
 * receipt is deliberately absent here; the adopted evidence package and
 * append-only Court Record are the canonical proof that validation followed
 * this exact replay adoption.
 */
export const hasCompletedDemonstrationReplay = (project: CaptionProject): boolean => {
  const adoption = project.courtRecord.find((event) => (
    event.type === "AdoptCaptionGenerationResult"
    && event.actor.type === "CueBenchAI"
    && event.actor.id === aiActor.id
    && event.detail === `generation:${DEMONSTRATION_REPLAY_RUN_ID}`
  ));
  return adoption !== undefined
    && project.localEvidencePackages.some((entry) => (
      entry.runId === DEMONSTRATION_REPLAY_RUN_ID
      && entry.packageId === `generation-${DEMONSTRATION_REPLAY_RUN_ID}`
    ))
    && project.courtRecord.some((event) => (
      event.type === "ValidateProject"
      && event.actor.type === "System"
      && event.projectRevision > adoption.projectRevision
    ));
};

const replayReceiptFrom = (
  value: unknown,
  project: CaptionProject,
  ownerCapability: string,
): DemonstrationReplayReceipt | null => {
  if (!isRecord(value) || !isRecord(value.demonstrationReplay)) return null;
  const checkpoint = value.demonstrationReplay;
  if (
    value.version !== 1
    || value.runId !== DEMONSTRATION_REPLAY_RUN_ID
    || value.projectId !== project.projectId
    || value.mediaSha256 !== project.media.sha256.toLowerCase()
    || value.sourceDurationMs !== project.media.durationMs
    || value.projectOwnerCapability !== ownerCapability.toLowerCase()
    || checkpoint.version !== 1
    || (checkpoint.phase !== "staged" && checkpoint.phase !== "acknowledged")
    || checkpoint.fixtureContentSha256 !== DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256
    || typeof checkpoint.stagedResultSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(checkpoint.stagedResultSha256)
    || typeof checkpoint.stagedCreatedAtMs !== "number"
    || !Number.isSafeInteger(checkpoint.stagedCreatedAtMs)
    || typeof checkpoint.stagedExpiresAtMs !== "number"
    || !Number.isSafeInteger(checkpoint.stagedExpiresAtMs)
    || checkpoint.stagedExpiresAtMs <= checkpoint.stagedCreatedAtMs
    || checkpoint.recordedCreatedAtMs !== fixtureInteger("recordedCreatedAtMs")
    || checkpoint.recordedExpiresAtMs !== fixtureInteger("recordedExpiresAtMs")
  ) return null;
  return value as unknown as DemonstrationReplayReceipt;
};

const isReplayCheckpointConsistent = (
  project: CaptionProject,
  receipt: DemonstrationReplayReceipt,
): boolean => {
  const hasCaptions = Object.keys(project.captions.items).length > 0;
  if (!hasCaptions) {
    const activeRun = project.activeGenerationRun;
    const leaseBase = activeRun?.base;
    return receipt.demonstrationReplay.phase === "staged"
      && activeRun?.runId === DEMONSTRATION_REPLAY_RUN_ID
      && activeRun.targetTrack === "Captions"
      && leaseBase?.targetTrack === "Captions"
      && receipt.expectedProjectRevision === leaseBase.expectedProjectRevision
      && receipt.expectedQualityProfileRevision === leaseBase.qualityProfileRevision;
  }
  if (!hasExactReplayCaptions(project) || project.activeGenerationRun !== null) return false;
  const adoption = receipt.adoption;
  return adoption?.status === "adopted"
    && adoption.localEvidencePackageId === `generation-${DEMONSTRATION_REPLAY_RUN_ID}`
    && adoption.adoptedProjectRevision <= project.projectRevision;
};

const assertReplayPreconditions = (input: DemonstrationReplayInput): void => {
  const snapshot = input.store.getSnapshot();
  if (snapshot.mode !== "durable") {
    fail("Demonstration replay requires durable browser storage; temporary projects are not eligible.");
  }
  if (
    snapshot.project === null
    || snapshot.project.projectId !== input.project.projectId
    || snapshot.project.projectRevision !== input.project.projectRevision
  ) fail("Demonstration replay requires the current unchanged browser project.");
  if (
    input.project.media.sha256.toLowerCase() !== SAMPLE_MEDIA_SHA256
    || input.project.media.durationMs !== SAMPLE_MEDIA_DURATION_MS
  ) fail("Demonstration replay runs only against CueBench's checked-in Gibbs lesson.");
  if (
    input.project.activeGenerationRun !== null
    && (
      input.project.activeGenerationRun.runId !== DEMONSTRATION_REPLAY_RUN_ID
      || input.project.activeGenerationRun.targetTrack !== "Captions"
    )
  ) {
    fail("Demonstration replay cannot replace a different active generation run.");
  }
  fixtureStages();
  fixtureSegments();
  fixtureCaptions();
};

/** True only for this exact unfinished local fixture checkpoint and owner capability. */
export const hasResumableDemonstrationReplay = async (
  project: CaptionProject,
  store: DemonstrationReplayStore,
): Promise<boolean> => {
  const snapshot = store.getSnapshot();
  if (
    snapshot.mode !== "durable"
    || snapshot.project?.projectId !== project.projectId
    || snapshot.project.projectRevision !== project.projectRevision
    || project.media.sha256.toLowerCase() !== SAMPLE_MEDIA_SHA256
    || project.media.durationMs !== SAMPLE_MEDIA_DURATION_MS
  ) return false;
  const ownerCapability = await store.getCloudProjectOwnerCapability?.(project.projectId) ?? null;
  if (ownerCapability === null || !/^[0-9a-f]{64}$/iu.test(ownerCapability)) return false;
  const receipt = replayReceiptFrom(
    await store.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID),
    project,
    ownerCapability,
  );
  return receipt !== null && isReplayCheckpointConsistent(project, receipt);
};

const checkpointFor = (
  phase: ReplayCheckpointPhase,
  stagedResult: StagedGenerationResult,
): DemonstrationReplayCheckpoint => ({
  version: 1,
  phase,
  fixtureContentSha256: DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256,
  stagedResultSha256: stagedResult.outputSha256 ?? fail("The demonstration replay staged result has no output hash."),
  stagedCreatedAtMs: stagedResult.createdAtMs,
  stagedExpiresAtMs: stagedResult.expiresAtMs,
  recordedCreatedAtMs: fixtureInteger("recordedCreatedAtMs"),
  recordedExpiresAtMs: fixtureInteger("recordedExpiresAtMs"),
});

const assertExpectedFindings = (project: CaptionProject, expectedFindingRuleIds: readonly string[]): void => {
  const actualFindingRuleIds = new Set(project.validationRun?.findings.map((finding) => finding.ruleId) ?? []);
  if (expectedFindingRuleIds.some((ruleId) => !actualFindingRuleIds.has(ruleId))) {
    fail("The demonstration replay no longer produces its documented deterministic validation findings.");
  }
};

/**
 * Replays the checked-in Gibbs lesson through the same durable domain and
 * storage adoption seams as live generation. It never contacts a provider,
 * never claims live model work, and deliberately stops at Proposed captions:
 * Sustain, Object, and Certify remain Human-only UI decisions.
 */
export const createDemonstrationReplay = async (
  input: DemonstrationReplayInput,
): Promise<DemonstrationReplayResult> => {
  assertReplayPreconditions(input);
  const stageDelayMs = input.stageDelayMs ?? 0;
  if (!Number.isSafeInteger(stageDelayMs) || stageDelayMs < 0 || stageDelayMs > 2_000) {
    return fail("Demonstration replay stage pacing must be between zero and two seconds.");
  }
  const runId = fixtureString("runId");
  if (runId !== DEMONSTRATION_REPLAY_RUN_ID) {
    return fail("CueBench's demonstration replay run identity changed unexpectedly.");
  }
  const ownerCapability = await input.store.getCloudProjectOwnerCapability?.(input.project.projectId) ?? null;
  if (ownerCapability === null || !/^[0-9a-f]{64}$/iu.test(ownerCapability)) {
    return fail("Demonstration replay requires the current durable browser-project owner capability.");
  }
  const nowMs = (input.clock ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return fail("Demonstration replay requires a valid current local time.");
  const storedReceipt = replayReceiptFrom(
    await input.store.loadCaptionGenerationReceipt(runId),
    input.project,
    ownerCapability,
  );
  const hasCaptions = Object.keys(input.project.captions.items).length > 0;
  if (hasCaptions && (storedReceipt === null || !isReplayCheckpointConsistent(input.project, storedReceipt))) {
    return fail("Demonstration replay never replaces existing caption work; reopen the original sample.");
  }
  if (storedReceipt !== null && !isReplayCheckpointConsistent(input.project, storedReceipt)) {
    return fail("CueBench found an inconsistent demonstration replay checkpoint and will not guess at recovery state.");
  }

  const alreadyAdopted = hasCaptions;
  let workingProject = input.project;
  let receipt: DemonstrationReplayReceipt;
  let stagedResultSha256: string;
  const stages = fixtureStages();

  if (!alreadyAdopted) {
    const started: CommandResult = input.project.activeGenerationRun?.runId === runId
      ? { project: input.project, events: [] }
      : requireCommandSuccess(await input.store.executeCommand({
        type: "StartGenerationRun",
        actor: aiActor,
        runId,
        targetTrack: "Captions",
        expectedProjectRevision: input.project.projectRevision,
      }, input.project.projectId), "CueBench could not start the demonstration replay");
    const leaseBase = started.project.activeGenerationRun?.base;
    if (leaseBase === undefined || leaseBase.targetTrack !== "Captions") {
      return fail("Demonstration replay lost its caption-generation lease before adoption.");
    }
    if (
      storedReceipt !== null
      && (
        storedReceipt.expectedProjectRevision !== leaseBase.expectedProjectRevision
        || storedReceipt.expectedQualityProfileRevision !== leaseBase.qualityProfileRevision
      )
    ) return fail("CueBench's demonstration replay checkpoint no longer matches its active caption lease.");
    const retainStoredEnvelope = storedReceipt !== null && storedReceipt.demonstrationReplay.stagedExpiresAtMs > nowMs;
    const createdAtMs = retainStoredEnvelope ? storedReceipt.demonstrationReplay.stagedCreatedAtMs : nowMs;
    const expiresAtMs = retainStoredEnvelope ? storedReceipt.demonstrationReplay.stagedExpiresAtMs : nowMs + maxRetentionMs;
    const stagedResult = stagedResultFor(started.project, runId, {
      expectedProjectRevision: leaseBase.expectedProjectRevision,
      expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
      createdAtMs,
      expiresAtMs,
    });
    stagedResultSha256 = stagedResult.outputSha256 ?? fail("The demonstration replay staged result has no output hash.");
    if (retainStoredEnvelope && storedReceipt.demonstrationReplay.stagedResultSha256 !== stagedResultSha256) {
      return fail("CueBench's saved demonstration replay hash no longer matches its staged fixture.");
    }
    receipt = {
      version: 1,
      runId,
      projectId: input.project.projectId,
      signedGenerationReceipt: "demonstration-replay-no-cloud-receipt",
      session: "demonstration-replay-no-cloud-session",
      expectedProjectRevision: leaseBase.expectedProjectRevision,
      expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
      mediaSha256: input.project.media.sha256.toLowerCase(),
      sourceByteLength: referenceProjectFixture.media.byteLength,
      sourceDurationMs: input.project.media.durationMs,
      projectOwnerCapability: ownerCapability.toLowerCase(),
      retentionExpiresAtMs: expiresAtMs,
      savedAtMs: nowMs,
      hostedArtifact: false,
      demonstrationReplay: checkpointFor("staged", stagedResult),
    };
    await input.store.persistCaptionGenerationReceipt(runId, receipt);

    for (const stage of stages.slice(0, -1)) {
      input.onStatus?.(statusFor(stage, input.project.projectId, runId, leaseBase.expectedProjectRevision));
      if (stageDelayMs === 0) await Promise.resolve();
      else await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, stageDelayMs));
    }

    const adopted = requireCommandSuccess(await input.store.adoptStagedCaptionGenerationResult({
      type: "AdoptCaptionGenerationResult",
      actor: aiActor,
      runId,
      expectedProjectRevision: leaseBase.expectedProjectRevision,
      expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
      confirmedProposedReplacement: false,
      result: stagedResult,
    }), "CueBench could not adopt the demonstration replay");
    workingProject = adopted.project;
  } else {
    if (storedReceipt === null) return fail("CueBench could not load the incomplete demonstration replay checkpoint.");
    receipt = storedReceipt;
    stagedResultSha256 = storedReceipt.demonstrationReplay.stagedResultSha256;
  }

  const adoptedProjectRevision = receipt.adoption?.adoptedProjectRevision ?? workingProject.projectRevision;
  if (receipt.demonstrationReplay.phase !== "acknowledged") {
    receipt = {
      ...receipt,
      adoption: {
        status: "adopted",
        adoptedProjectRevision,
        localEvidencePackageId: `generation-${runId}`,
        cleanupAcknowledgement: "acknowledged",
      },
      demonstrationReplay: { ...receipt.demonstrationReplay, phase: "acknowledged" },
    };
    await input.store.persistCaptionGenerationReceipt(runId, receipt);
  }

  const validated = currentValidationRun(workingProject) === undefined
    ? requireCommandSuccess(await input.store.executeCommand({
      type: "ValidateProject",
      actor: systemActor,
      expectedProjectRevision: workingProject.projectRevision,
    }, input.project.projectId), "CueBench could not validate the demonstration replay")
    : { project: workingProject, events: [] };
  const expectedFindingRuleIds = fixtureExpectedFindingRuleIds();
  assertExpectedFindings(validated.project, expectedFindingRuleIds);
  if (input.store.deleteCaptionGenerationReceipt === undefined) {
    return fail("CueBench cannot finalize a demonstration replay without deleting its local-only recovery receipt.");
  }
  await input.store.deleteCaptionGenerationReceipt(runId);
  input.onStatus?.(statusFor(
    stages.at(-1) ?? fail("The replay stage record is empty."),
    input.project.projectId,
    runId,
    receipt.expectedProjectRevision,
    validated.project.projectRevision,
  ));

  return {
    label: DEMONSTRATION_REPLAY_LABEL,
    provider: { kind: "deterministic-replay", live: false },
    runId,
    stagedResultSha256,
    fixtureContentSha256: DEMONSTRATION_REPLAY_FIXTURE_CONTENT_SHA256,
    expectedFindingRuleIds,
    project: validated.project,
  };
};
