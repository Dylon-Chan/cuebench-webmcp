/**
 * The deterministic half of CueBench's audio-description production pass.
 *
 * This module deliberately keeps visual interpretation behind an injected
 * provider port.  It owns the things a model must never improvise: bounded
 * evidence windows, duplicate elimination, speech-gap placement, and the
 * durable window checkpoint that prevents a recovered run from issuing a
 * second billable proposal request.
 */

import { canonicalHash } from "@cuebench/domain";

const WINDOW_MIN_MS = 45_000;
const WINDOW_MAX_MS = 90_000;
const WINDOW_OVERLAP_MS = 6_000;
const MAX_WINDOW_COUNT = 32;
export const MAX_AD_EVIDENCE_FRAMES = 12;
export const MAX_AD_PROPOSALS_PER_WINDOW = 24;
export const MAX_AD_PROPOSALS = 256;
export const MAX_AD_CAPTION_CONTEXT = 500;

const clone = <Value>(value: Value): Value => structuredClone(value);

export interface AudioDescriptionCaptionContext {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly state: "Proposed" | "AgentReady" | "Objected" | "Sustained";
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface AudioDescriptionFrame {
  readonly evidenceId: string;
  readonly atMs: number;
  readonly key: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export interface AudioDescriptionWindow {
  readonly windowId: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface AudioDescriptionPlacementIntent {
  /** A media-time anchor only; the deterministic placer selects the actual gap. */
  readonly anchorMs: number;
  readonly desiredDurationMs: number;
}

export interface AudioDescriptionProposal {
  readonly proposalId: string;
  readonly windowId: string;
  readonly text: string;
  readonly rationale: string;
  /** IDs must resolve to the bounded frame/scene/caption evidence passed to this run. */
  readonly evidenceIds: readonly string[];
  readonly placementIntent: AudioDescriptionPlacementIntent;
}

export interface ProposedAudioDescriptionBeat extends AudioDescriptionProposal {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ExtendedDescriptionRequirement {
  readonly requirementId: string;
  readonly proposalId: string;
  readonly windowId: string;
  readonly text: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  /** Human review context, never a provider assertion about the media. */
  readonly reason: "no-compatible-speech-gap" | "requires-human-judgment" | "insufficient-visual-evidence";
}

export interface AudioDescriptionPlacementResult {
  readonly beats: readonly ProposedAudioDescriptionBeat[];
  readonly extendedDescriptionRequirements: readonly ExtendedDescriptionRequirement[];
}

export interface ScopedAudioDescriptionResultIdentities {
  readonly frames: readonly {
    readonly evidenceId: string;
    readonly atMs: number;
    readonly sha256: string;
    readonly mimeType: string;
  }[];
  readonly beats: readonly {
    readonly beatId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly description: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly extendedDescriptionRequirements: readonly {
    readonly requirementId: string;
    readonly text: string;
    readonly rationale: string;
    readonly evidenceIds: readonly string[];
    readonly reason: ExtendedDescriptionRequirement["reason"];
  }[];
}

/**
 * Window/provider identities are only local to one provider call. Scope every
 * staged ID to the durable run before it can enter append-only project state.
 * A frame gets a deterministic alias for each beat binding so project-level
 * provenance (which has one item target per evidence ID) remains resolvable
 * for every review item. Requirement-only citations reuse the first beat
 * alias when possible; the production boundary rejects an over-cap alias set.
 */
export const scopeAudioDescriptionResultIdentities = async (input: {
  readonly runId: string;
  readonly placed: AudioDescriptionPlacementResult;
  readonly frames: readonly Pick<AudioDescriptionFrame, "evidenceId" | "atMs" | "sha256" | "mimeType">[];
}): Promise<ScopedAudioDescriptionResultIdentities> => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.runId)) {
    throw new Error("CueBench cannot scope audio-description output for an invalid run identity.");
  }
  const scopedId = (kind: "beat" | "requirement" | "frame", source: Readonly<Record<string, unknown>>): string =>
    `ad-${kind}-${canonicalHash("cuebench.audio-description.output-identity.v1", { version: 1, runId: input.runId, kind, source }).slice("sha256:".length, "sha256:".length + 48)}`;
  const frameBySourceId = new Map<string, Pick<AudioDescriptionFrame, "evidenceId" | "atMs" | "sha256" | "mimeType">>();
  for (const frame of input.frames) {
    if (frameBySourceId.has(frame.evidenceId)) throw new Error("CueBench visual evidence has duplicate source frame identities.");
    frameBySourceId.set(frame.evidenceId, frame);
  }
  const frames: ScopedAudioDescriptionResultIdentities["frames"][number][] = [];
  const firstBeatFrameIdBySourceId = new Map<string, string>();
  const scopedFrameIdByBinding = new Map<string, string>();
  const scopedFrame = (
    sourceId: string,
    binding: Readonly<Record<string, unknown>>,
  ): string => {
    const bindingKey = canonicalHash("cuebench.audio-description.frame-binding.v1", { sourceId, binding });
    const existing = scopedFrameIdByBinding.get(bindingKey);
    if (existing !== undefined) return existing;
    const frame = frameBySourceId.get(sourceId);
    if (frame === undefined) throw new Error("CueBench could not scope a cited visual frame that was not retained for this run.");
    const evidenceId = scopedId("frame", {
      sourceEvidenceId: sourceId,
      atMs: frame.atMs,
      sha256: frame.sha256.toLowerCase(),
      mimeType: frame.mimeType,
      binding,
    });
    scopedFrameIdByBinding.set(bindingKey, evidenceId);
    frames.push({ evidenceId, atMs: frame.atMs, sha256: frame.sha256.toLowerCase(), mimeType: frame.mimeType });
    return evidenceId;
  };
  const beats = input.placed.beats.map((beat, index) => ({
    beatId: scopedId("beat", {
      ordinal: index,
      proposalId: beat.proposalId,
      windowId: beat.windowId,
      startMs: beat.startMs,
      endMs: beat.endMs,
      text: beat.text,
      evidenceIds: [...beat.evidenceIds],
    }),
    startMs: beat.startMs,
    endMs: beat.endMs,
    description: beat.text,
    evidenceIds: beat.evidenceIds.map((sourceId) => {
      const evidenceId = scopedFrame(sourceId, {
        target: "beat",
        ordinal: index,
        proposalId: beat.proposalId,
        windowId: beat.windowId,
      });
      if (!firstBeatFrameIdBySourceId.has(sourceId)) firstBeatFrameIdBySourceId.set(sourceId, evidenceId);
      return evidenceId;
    }),
  }));
  const extendedDescriptionRequirements = input.placed.extendedDescriptionRequirements.map((requirement, index) => ({
    requirementId: scopedId("requirement", {
      ordinal: index,
      requirementId: requirement.requirementId,
      proposalId: requirement.proposalId,
      windowId: requirement.windowId,
      text: requirement.text,
      evidenceIds: [...requirement.evidenceIds],
      reason: requirement.reason,
    }),
    text: requirement.text,
    rationale: requirement.rationale,
    evidenceIds: requirement.evidenceIds.map((sourceId) => (
      firstBeatFrameIdBySourceId.get(sourceId)
      ?? scopedFrame(sourceId, {
        target: "requirement",
        ordinal: index,
        proposalId: requirement.proposalId,
        windowId: requirement.windowId,
      })
    )),
    reason: requirement.reason,
  }));
  return {
    frames: [...frames].sort((left, right) => left.atMs - right.atMs || left.evidenceId.localeCompare(right.evidenceId)),
    beats,
    extendedDescriptionRequirements,
  };
};

export interface AudioDescriptionGenerationStartRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly targetTrack: "AudioDescriptions";
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly durationMs: number;
  /** A bounded, adopted caption-evidence projection. Empty is a hard precondition failure. */
  readonly captions: readonly AudioDescriptionCaptionContext[];
  readonly sceneTimestamps: readonly number[];
  readonly frames: readonly AudioDescriptionFrame[];
  readonly qualityProfileRules?: Readonly<Record<string, unknown>>;
}

export interface AudioDescriptionWindowInput {
  readonly runId: string;
  readonly window: AudioDescriptionWindow;
  readonly captions: readonly AudioDescriptionCaptionContext[];
  readonly sceneTimestamps: readonly number[];
  readonly frames: readonly AudioDescriptionFrame[];
  readonly speechGaps: readonly SpeechGap[];
}

export interface AudioDescriptionGenerationDependencies {
  readonly proposeWindow: (input: AudioDescriptionWindowInput) => Promise<readonly AudioDescriptionProposal[]>;
  readonly clock?: () => number;
}

export interface SpeechGap {
  readonly startMs: number;
  readonly endMs: number;
}

export interface StagedAudioDescriptionGenerationResult {
  readonly runId: string;
  readonly projectId: string;
  readonly targetTrack: "AudioDescriptions";
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly beats: readonly ProposedAudioDescriptionBeat[];
  readonly extendedDescriptionRequirements: readonly ExtendedDescriptionRequirement[];
  readonly createdAtMs: number;
}

export interface AudioDescriptionRunStage {
  readonly stage: "Queued" | "AnalyzingVisuals" | "PlacingAudioDescriptions" | "AwaitingAdoption" | "Cancelled" | "Failed";
  readonly atMs: number;
}

interface PersistedAudioDescriptionRun {
  readonly request: AudioDescriptionGenerationStartRequest;
  readonly stageHistory: readonly AudioDescriptionRunStage[];
  readonly proposalsByWindow: Readonly<Record<string, readonly AudioDescriptionProposal[]>>;
  readonly staged?: StagedAudioDescriptionGenerationResult;
  readonly cancelled: boolean;
}

export interface AudioDescriptionRunStore {
  readonly initialise: (request: AudioDescriptionGenerationStartRequest) => Promise<PersistedAudioDescriptionRun>;
  readonly read: (runId: string) => Promise<PersistedAudioDescriptionRun | null>;
  readonly save: (run: PersistedAudioDescriptionRun) => Promise<void>;
}

const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const interval = (startMs: number, endMs: number): SpeechGap | null => (
  validTime(startMs) && validTime(endMs) && endMs > startMs ? { startMs, endMs } : null
);

const sortedCaptions = (captions: readonly AudioDescriptionCaptionContext[]): readonly AudioDescriptionCaptionContext[] => [...captions]
  .filter((caption) => interval(caption.startMs, caption.endMs) !== null)
  .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.itemId.localeCompare(right.itemId));

/** The AD workflow derives its own dialogue-free intervals; it never trusts model timing. */
export const deriveSpeechGaps = (input: {
  readonly durationMs: number;
  readonly captions: readonly AudioDescriptionCaptionContext[];
}): readonly SpeechGap[] => {
  if (!validTime(input.durationMs) || input.durationMs === 0) return [];
  const gaps: SpeechGap[] = [];
  let cursor = 0;
  for (const caption of sortedCaptions(input.captions)) {
    const startMs = Math.min(input.durationMs, Math.max(0, caption.startMs));
    const endMs = Math.min(input.durationMs, Math.max(startMs, caption.endMs));
    const gap = interval(cursor, startMs);
    if (gap !== null) gaps.push(gap);
    cursor = Math.max(cursor, endMs);
  }
  const finalGap = interval(cursor, input.durationMs);
  if (finalGap !== null) gaps.push(finalGap);
  return gaps;
};

const countContextTransitions = (
  startMs: number,
  endMs: number,
  captions: readonly AudioDescriptionCaptionContext[],
  sceneTimestamps: readonly number[],
): number => (
  captions.filter((caption) => caption.startMs >= startMs && caption.startMs < endMs).length
  + sceneTimestamps.filter((timestamp) => timestamp >= startMs && timestamp < endMs).length
);

const desiredWindowDuration = (input: {
  readonly startMs: number;
  readonly durationMs: number;
  readonly captions: readonly AudioDescriptionCaptionContext[];
  readonly sceneTimestamps: readonly number[];
}): number => {
  const density = countContextTransitions(
    input.startMs,
    Math.min(input.durationMs, input.startMs + WINDOW_MAX_MS),
    input.captions,
    input.sceneTimestamps,
  );
  // Dense visual/transcript change needs more local context; long quiet
  // stretches can use a larger bounded window.  Clamp makes this invariant
  // transparent and testable rather than a model-controlled choice.
  return Math.max(WINDOW_MIN_MS, Math.min(WINDOW_MAX_MS, WINDOW_MAX_MS - density * 4_500));
};

/**
 * 45–90s windows overlap by a fixed six seconds. A short source is the only
 * permitted exception to the lower bound. If advancing by that overlap would
 * leave a short tail, the final window backs up far enough to remain at least
 * 45 seconds (rather than silently issuing a tiny provider request).
 */
export const buildAudioDescriptionWindows = (input: {
  readonly durationMs: number;
  readonly captions: readonly AudioDescriptionCaptionContext[];
  readonly sceneTimestamps: readonly number[];
}): readonly AudioDescriptionWindow[] => {
  if (!validTime(input.durationMs) || input.durationMs <= 0) return [];
  const captions = sortedCaptions(input.captions);
  const scenes = [...new Set(input.sceneTimestamps.filter((value) => validTime(value) && value <= input.durationMs))].sort((a, b) => a - b);
  if (input.durationMs <= WINDOW_MIN_MS) return [{ windowId: "ad-window-1", startMs: 0, endMs: input.durationMs }];

  const windows: AudioDescriptionWindow[] = [];
  let startMs = 0;
  while (startMs < input.durationMs && windows.length < MAX_WINDOW_COUNT) {
    const remainingMs = input.durationMs - startMs;
    if (remainingMs <= WINDOW_MAX_MS) {
      if (remainingMs >= WINDOW_MIN_MS) {
        windows.push({ windowId: `ad-window-${windows.length + 1}`, startMs, endMs: input.durationMs });
        break;
      }
      const previous = windows.at(-1);
      if (previous === undefined) {
        throw new Error("CueBench could not build a valid bounded AD window for this source.");
      }
      // Preserve the normal overlap where it fits, otherwise create a wider
      // (but still bounded) overlap so the final provider call is valid. For
      // 90,001 ms this produces [0,90,000] + [45,001,90,001].
      const finalStartMs = Math.min(
        previous.endMs - WINDOW_OVERLAP_MS,
        input.durationMs - WINDOW_MIN_MS,
      );
      if (
        finalStartMs <= previous.startMs
        || finalStartMs < 0
        || input.durationMs - finalStartMs < WINDOW_MIN_MS
        || input.durationMs - finalStartMs > WINDOW_MAX_MS
      ) throw new Error("CueBench could not build a valid final bounded AD window.");
      windows.push({ windowId: `ad-window-${windows.length + 1}`, startMs: finalStartMs, endMs: input.durationMs });
      break;
    }
    const desired = desiredWindowDuration({ startMs, durationMs: input.durationMs, captions, sceneTimestamps: scenes });
    const endMs = Math.min(input.durationMs, startMs + desired);
    windows.push({ windowId: `ad-window-${windows.length + 1}`, startMs, endMs });
    if (endMs === input.durationMs) break;
    const nextStart = endMs - WINDOW_OVERLAP_MS;
    if (nextStart <= startMs) throw new Error("CueBench could not progress its bounded AD evidence windows.");
    startMs = nextStart;
  }
  if (windows.length === MAX_WINDOW_COUNT && windows.at(-1)?.endMs !== input.durationMs) {
    throw new Error("CueBench cannot process this source within its bounded AD window budget.");
  }
  return windows;
};

/**
 * Frames are selected from the prep service's immutable thumbnail list.
 * Stable chronological selection means a model can neither request additional
 * frames nor make an evidence set differ on a retry.
 */
export const selectEvidenceFrames = (input: {
  readonly window: AudioDescriptionWindow;
  readonly frames: readonly AudioDescriptionFrame[];
}): readonly AudioDescriptionFrame[] => {
  const unique = new Map<string, AudioDescriptionFrame>();
  for (const frame of input.frames) {
    if (
      !frame.evidenceId.trim()
      || !validTime(frame.atMs)
      || frame.atMs < input.window.startMs
      || frame.atMs > input.window.endMs
      || !frame.key.trim()
      || !/^[0-9a-f]{64}$/iu.test(frame.sha256)
      || frame.byteLength <= 0
    ) continue;
    const existing = unique.get(frame.evidenceId);
    if (existing === undefined || frame.atMs < existing.atMs || frame.atMs === existing.atMs && frame.key.localeCompare(existing.key) < 0) {
      unique.set(frame.evidenceId, clone(frame));
    }
  }
  const ordered = [...unique.values()].sort((left, right) => left.atMs - right.atMs || left.evidenceId.localeCompare(right.evidenceId));
  if (ordered.length <= MAX_AD_EVIDENCE_FRAMES) return ordered;
  // Spread a capped selection across the time range rather than taking only
  // the first thumbnails. `Math.floor` makes the choice completely stable.
  const selected: AudioDescriptionFrame[] = [];
  for (let index = 0; index < MAX_AD_EVIDENCE_FRAMES; index += 1) {
    selected.push(ordered[Math.floor((index * (ordered.length - 1)) / (MAX_AD_EVIDENCE_FRAMES - 1))]!);
  }
  return selected;
};

const proposalKey = (proposal: AudioDescriptionProposal): string => `${proposal.text.trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase("en-US")}\u0000${[...proposal.evidenceIds].sort().join("\u0000")}`;

const sortedProposals = (proposals: readonly AudioDescriptionProposal[]): readonly AudioDescriptionProposal[] => [...proposals]
  .filter((proposal) => (
    proposal.proposalId.trim().length > 0
    && proposal.proposalId.length <= 200
    && proposal.windowId.trim().length > 0
    && proposal.text.trim().length > 0
    && proposal.text.trim().length <= 1_000
    && proposal.rationale.trim().length > 0
    && proposal.rationale.trim().length <= 2_000
    && proposal.evidenceIds.length > 0
    && proposal.evidenceIds.length <= 64
    && validTime(proposal.placementIntent.anchorMs)
    && validTime(proposal.placementIntent.desiredDurationMs)
    && proposal.placementIntent.desiredDurationMs > 0
  ))
  .sort((left, right) => left.windowId.localeCompare(right.windowId)
    || left.placementIntent.anchorMs - right.placementIntent.anchorMs
    || left.proposalId.localeCompare(right.proposalId));

const subtractInterval = (gaps: readonly SpeechGap[], occupied: SpeechGap): readonly SpeechGap[] => gaps.flatMap((gap) => {
  if (occupied.endMs <= gap.startMs || occupied.startMs >= gap.endMs) return [gap];
  const output: SpeechGap[] = [];
  const left = interval(gap.startMs, Math.max(gap.startMs, occupied.startMs));
  const right = interval(Math.min(gap.endMs, occupied.endMs), gap.endMs);
  if (left !== null) output.push(left);
  if (right !== null) output.push(right);
  return output;
});

const gapDistance = (gap: SpeechGap, anchorMs: number): number => (
  anchorMs < gap.startMs ? gap.startMs - anchorMs : anchorMs > gap.endMs ? anchorMs - gap.endMs : 0
);

const selectCompatibleGap = (gaps: readonly SpeechGap[], anchorMs: number, durationMs: number): SpeechGap | null => {
  const candidates = gaps.filter((gap) => gap.endMs - gap.startMs >= durationMs);
  return candidates.sort((left, right) => gapDistance(left, anchorMs) - gapDistance(right, anchorMs)
    || left.startMs - right.startMs
    || left.endMs - right.endMs)[0] ?? null;
};

/**
 * Removes duplicate model proposals and converts every remaining timing
 * intent to a non-overlapping human-reviewable beat. No compatible gap means
 * a requirement, never a silent dialogue collision or a guessed overlap.
 */
export const placeAudioDescriptionProposals = (input: {
  readonly durationMs: number;
  readonly captions: readonly AudioDescriptionCaptionContext[];
  readonly proposals: readonly AudioDescriptionProposal[];
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly forbidDialogueCollision: boolean;
}): AudioDescriptionPlacementResult => {
  const minDurationMs = Math.max(1, Math.floor(input.minDurationMs));
  const maxDurationMs = Math.max(minDurationMs, Math.floor(input.maxDurationMs));
  const beats: ProposedAudioDescriptionBeat[] = [];
  const requirements: ExtendedDescriptionRequirement[] = [];
  const seen = new Set<string>();
  let gaps = input.forbidDialogueCollision
    ? deriveSpeechGaps({ durationMs: input.durationMs, captions: input.captions })
    : [interval(0, input.durationMs)].filter((candidate): candidate is SpeechGap => candidate !== null);

  for (const proposal of sortedProposals(input.proposals).slice(0, MAX_AD_PROPOSALS)) {
    const key = proposalKey(proposal);
    if (seen.has(key)) continue;
    seen.add(key);
    const desiredDurationMs = Math.min(maxDurationMs, proposal.placementIntent.desiredDurationMs);
    if (desiredDurationMs < minDurationMs) {
      requirements.push({
        requirementId: `extended-${proposal.proposalId}`,
        proposalId: proposal.proposalId,
        windowId: proposal.windowId,
        text: proposal.text.trim(),
        rationale: proposal.rationale.trim(),
        evidenceIds: [...proposal.evidenceIds],
        reason: "requires-human-judgment",
      });
      continue;
    }
    const gap = selectCompatibleGap(gaps, proposal.placementIntent.anchorMs, desiredDurationMs);
    if (gap === null) {
      requirements.push({
        requirementId: `extended-${proposal.proposalId}`,
        proposalId: proposal.proposalId,
        windowId: proposal.windowId,
        text: proposal.text.trim(),
        rationale: proposal.rationale.trim(),
        evidenceIds: [...proposal.evidenceIds],
        reason: "no-compatible-speech-gap",
      });
      continue;
    }
    const startMs = gap.startMs;
    const endMs = startMs + desiredDurationMs;
    const occupied = { startMs, endMs };
    beats.push({
      ...clone(proposal),
      text: proposal.text.trim(),
      rationale: proposal.rationale.trim(),
      evidenceIds: [...new Set(proposal.evidenceIds)].sort(),
      startMs,
      endMs,
    });
    gaps = subtractInterval(gaps, occupied);
  }
  return {
    beats: beats.sort((left, right) => left.startMs - right.startMs || left.proposalId.localeCompare(right.proposalId)),
    extendedDescriptionRequirements: requirements.sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
  };
};

const appendStage = (
  run: PersistedAudioDescriptionRun,
  stage: AudioDescriptionRunStage["stage"],
  nowMs: number,
): PersistedAudioDescriptionRun => (
  run.stageHistory.at(-1)?.stage === stage
    ? run
    : { ...run, stageHistory: [...run.stageHistory, { stage, atMs: nowMs }] }
);

const validRunRequest = (request: AudioDescriptionGenerationStartRequest): void => {
  if (
    request.targetTrack !== "AudioDescriptions"
    || !request.runId.trim()
    || !request.projectId.trim()
    || !/^[0-9a-f]{64}$/iu.test(request.mediaSha256)
    || !validTime(request.durationMs)
    || request.durationMs === 0
    || request.captions.length === 0
    || request.captions.length > MAX_AD_CAPTION_CONTEXT
    || request.frames.length > 256
    || request.sceneTimestamps.length > 512
  ) throw new Error("CueBench AD generation requires bounded caption evidence and media facts.");
};

/** A small fixture store that mirrors durable window checkpoint semantics. */
export class InMemoryAudioDescriptionRunStore implements AudioDescriptionRunStore {
  private readonly runs = new Map<string, PersistedAudioDescriptionRun>();

  public async initialise(request: AudioDescriptionGenerationStartRequest): Promise<PersistedAudioDescriptionRun> {
    const existing = this.runs.get(request.runId);
    if (existing !== undefined) {
      if (existing.request.projectId !== request.projectId || existing.request.mediaSha256.toLowerCase() !== request.mediaSha256.toLowerCase()) {
        throw new Error("CueBench AD generation run identity conflict.");
      }
      return clone(existing);
    }
    const run: PersistedAudioDescriptionRun = {
      request: clone(request),
      stageHistory: [{ stage: "Queued", atMs: 0 }],
      proposalsByWindow: {},
      cancelled: false,
    };
    this.runs.set(request.runId, clone(run));
    return clone(run);
  }

  public async read(runId: string): Promise<PersistedAudioDescriptionRun | null> {
    const run = this.runs.get(runId);
    return run === undefined ? null : clone(run);
  }

  public async save(run: PersistedAudioDescriptionRun): Promise<void> {
    const current = this.runs.get(run.request.runId);
    if (current?.cancelled === true) return;
    this.runs.set(run.request.runId, clone(run));
  }

  public stageHistory(runId: string): readonly AudioDescriptionRunStage[] {
    return clone(this.runs.get(runId)?.stageHistory ?? []);
  }

  public async stagedResult(runId: string): Promise<StagedAudioDescriptionGenerationResult | null> {
    return clone(this.runs.get(runId)?.staged ?? null);
  }
}

/**
 * Durable run driver. A production adapter can implement AudioDescriptionRunStore
 * with the existing R2 record/checkpoint primitives; the business algorithm
 * remains identical in fixtures and live deployments.
 */
export class AudioDescriptionGenerationRunner {
  public constructor(
    private readonly store: AudioDescriptionRunStore,
    private readonly dependencies: AudioDescriptionGenerationDependencies,
  ) {}

  public async run(request: AudioDescriptionGenerationStartRequest): Promise<void> {
    validRunRequest(request);
    let run = await this.store.initialise(request);
    if (run.staged !== undefined || run.cancelled) return;
    const now = () => this.dependencies.clock?.() ?? Date.now();
    const windows = buildAudioDescriptionWindows({
      durationMs: request.durationMs,
      captions: request.captions,
      sceneTimestamps: request.sceneTimestamps,
    });
    if (windows.length === 0) throw new Error("CueBench AD generation could not build a bounded evidence plan.");
    const speechGaps = deriveSpeechGaps({ durationMs: request.durationMs, captions: request.captions });

    run = appendStage(run, "AnalyzingVisuals", now());
    await this.store.save(run);
    for (const window of windows) {
      const latest = await this.store.read(request.runId) ?? run;
      if (latest.cancelled) return;
      if (latest.proposalsByWindow[window.windowId] !== undefined) {
        run = latest;
        continue;
      }
      const frames = selectEvidenceFrames({ window, frames: request.frames });
      const captions = sortedCaptions(request.captions).filter((caption) => caption.endMs >= window.startMs - WINDOW_OVERLAP_MS && caption.startMs <= window.endMs + WINDOW_OVERLAP_MS);
      const proposals = await this.dependencies.proposeWindow({
        runId: request.runId,
        window,
        captions: captions.slice(0, MAX_AD_CAPTION_CONTEXT),
        sceneTimestamps: request.sceneTimestamps.filter((scene) => scene >= window.startMs && scene <= window.endMs),
        frames,
        speechGaps: speechGaps.filter((gap) => gap.endMs >= window.startMs && gap.startMs <= window.endMs),
      });
      if (proposals.length > MAX_AD_PROPOSALS_PER_WINDOW) {
        throw new Error("CueBench AD provider exceeded the bounded per-window proposal limit.");
      }
      run = {
        ...latest,
        proposalsByWindow: { ...latest.proposalsByWindow, [window.windowId]: clone(proposals) },
      };
      // This is the durable checkpoint immediately after one provider call.
      // A recovered run sees the window value and never calls it a second time.
      await this.store.save(run);
    }
    const latest = await this.store.read(request.runId) ?? run;
    if (latest.cancelled) return;
    run = appendStage(latest, "PlacingAudioDescriptions", now());
    await this.store.save(run);
    const rules = audioDescriptionRules(request.qualityProfileRules);
    const placed = placeAudioDescriptionProposals({
      durationMs: request.durationMs,
      captions: request.captions,
      proposals: windows.flatMap((window) => latest.proposalsByWindow[window.windowId] ?? []),
      ...rules,
    });
    const staged: StagedAudioDescriptionGenerationResult = {
      runId: request.runId,
      projectId: request.projectId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: request.expectedProjectRevision,
      expectedQualityProfileRevision: request.expectedQualityProfileRevision,
      mediaSha256: request.mediaSha256.toLowerCase(),
      beats: placed.beats,
      extendedDescriptionRequirements: placed.extendedDescriptionRequirements,
      createdAtMs: now(),
    };
    run = appendStage({ ...run, staged }, "AwaitingAdoption", now());
    await this.store.save(run);
  }
}

const numberRule = (source: Readonly<Record<string, unknown>> | undefined, name: string, fallback: number): number => {
  const value = source?.[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const audioDescriptionRules = (rules: Readonly<Record<string, unknown>> | undefined) => {
  const source = typeof rules?.audioDescription === "object" && rules.audioDescription !== null && !Array.isArray(rules.audioDescription)
    ? rules.audioDescription as Readonly<Record<string, unknown>>
    : undefined;
  const minDurationMs = numberRule(source, "minDurationMs", 500);
  const maxDurationMs = Math.max(minDurationMs, numberRule(source, "maxDurationMs", 10_000));
  const forbidDialogueCollision = source?.forbidDialogueCollision === undefined ? true : source.forbidDialogueCollision === true;
  return { minDurationMs, maxDurationMs, forbidDialogueCollision };
};
