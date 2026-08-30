import type {
  AudioDescriptionBeat,
  AudioDescriptionGap,
  CaptionCue,
  CaptionProject,
  QualityProfile,
} from "../model";
import type { ReviewState } from "@cuebench/contracts";
import { canonicalHash, tupleHash } from "./hash";
import { resolveEducationProfileRules } from "./profile";

export type FindingSeverity = "blocker" | "warning";

export type QualityFindingTarget =
  | {
      readonly type: "project";
      readonly projectId: string;
      /** Project-wide rules bind the project revision that was evaluated. */
      readonly projectRevision: number;
    }
  | {
      readonly type: "item";
      readonly kind: "CaptionCue" | "AudioDescriptionBeat";
      readonly itemId: string;
      readonly itemRevision: number;
    }
  | {
      readonly type: "pair";
      readonly first: {
        readonly kind: "CaptionCue" | "AudioDescriptionBeat";
        readonly itemId: string;
        readonly itemRevision: number;
      };
      readonly second: {
        readonly kind: "CaptionCue" | "AudioDescriptionBeat";
        readonly itemId: string;
        readonly itemRevision: number;
      };
    };

export interface QualityFinding {
  /** Short alias for consumers that render generic finding lists. */
  readonly id: string;
  readonly findingId: string;
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly target: QualityFindingTarget;
}

export interface ValidationInputItem {
  readonly kind: "CaptionCue" | "AudioDescriptionBeat";
  readonly itemId: string;
  readonly itemRevision: number;
  readonly state: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string | null;
  readonly mergedIntoItemId?: string | null;
}

export interface ValidationInputEvidence {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly mediaSha256: string;
  readonly itemId: string | null;
  readonly itemRevision: number | null;
}

export interface ValidationInputSnapshot {
  readonly projectId: string;
  /** Retained for audit; it is deliberately excluded from the semantic input hash. */
  readonly projectRevision: number;
  readonly media: {
    readonly sourceId: string;
    readonly sha256: string;
    readonly durationMs: number;
    readonly relinkState: string;
  };
  readonly evidence: readonly ValidationInputEvidence[];
  readonly qualityProfile: {
    readonly profileId: string;
    readonly revision: number;
    readonly name: string;
    readonly rules: Readonly<Record<string, unknown>>;
  };
  readonly captions: {
    readonly order: readonly string[];
    readonly items: readonly ValidationInputItem[];
  };
  readonly audioDescriptions: {
    readonly order: readonly string[];
    readonly items: readonly ValidationInputItem[];
  };
  readonly audioDescriptionGaps: readonly {
    readonly gapId: string;
    readonly gapRevision: number;
    readonly state: string;
    readonly startMs: number;
    readonly endMs: number;
  }[];
}

export interface ValidationRun {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly input: ValidationInputSnapshot;
  readonly inputHash: string;
  readonly findings: readonly QualityFinding[];
  readonly blockers: readonly QualityFinding[];
  readonly warnings: readonly QualityFinding[];
  readonly blockerCount: number;
  readonly warningCount: number;
}

/** A synchronous deterministic hash for equality checks and input snapshots. */
export const stableHash = (value: unknown): string => canonicalHash("cuebench.validation-value.v1", value);

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const compareNumber = (left: number, right: number): number => left < right ? -1 : left > right ? 1 : 0;

const liveCaptionItems = (project: CaptionProject): readonly CaptionCue[] =>
  Object.values(project.captions.items)
    .filter((item) => item.mergedIntoItemId === null)
    .sort((left, right) => compareText(left.itemId, right.itemId));

const liveAudioDescriptionItems = (project: CaptionProject): readonly AudioDescriptionBeat[] =>
  Object.values(project.audioDescriptions.items)
    .sort((left, right) => compareText(left.itemId, right.itemId));

const temporalItems = <Item extends CaptionCue | AudioDescriptionBeat>(items: readonly Item[]): readonly Item[] =>
  [...items].sort((left, right) => {
    const start = compareNumber(left.current.startMs, right.current.startMs);
    if (start !== 0) return start;
    const end = compareNumber(left.current.endMs, right.current.endMs);
    return end !== 0 ? end : compareText(left.itemId, right.itemId);
  });

/**
 * Relationship checks use all live map entries, not the mutable order list.
 * The order list still has independent structural and semantic-order checks.
 */
const orderedLiveCaptionItems = (project: CaptionProject): readonly CaptionCue[] => {
  const seen = new Set<string>();
  const ordered: CaptionCue[] = [];
  for (const itemId of project.captions.order) {
    const item = project.captions.items[itemId];
    if (item !== undefined && item.mergedIntoItemId === null && !seen.has(itemId)) {
      seen.add(itemId);
      ordered.push(item);
    }
  }
  return ordered;
};

const orderedLiveAudioDescriptionItems = (project: CaptionProject): readonly AudioDescriptionBeat[] => {
  const seen = new Set<string>();
  const ordered: AudioDescriptionBeat[] = [];
  for (const itemId of project.audioDescriptions.order) {
    const item = project.audioDescriptions.items[itemId];
    if (item !== undefined && !seen.has(itemId)) {
      seen.add(itemId);
      ordered.push(item);
    }
  }
  return ordered;
};

const inputCaptionItem = (item: CaptionCue): ValidationInputItem => ({
  kind: "CaptionCue",
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  state: item.current.state,
  startMs: item.current.startMs,
  endMs: item.current.endMs,
  text: item.current.text,
  speaker: item.current.speaker,
  mergedIntoItemId: item.mergedIntoItemId,
});

const inputAudioDescriptionItem = (item: AudioDescriptionBeat): ValidationInputItem => ({
  kind: "AudioDescriptionBeat",
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  state: item.current.state,
  startMs: item.current.startMs,
  endMs: item.current.endMs,
  text: item.current.description,
  speaker: null,
});

export const buildValidationInput = (project: CaptionProject): ValidationInputSnapshot => ({
  projectId: project.projectId,
  projectRevision: project.projectRevision,
  media: {
    sourceId: project.media.sourceId,
    sha256: project.media.sha256,
    durationMs: project.media.durationMs,
    relinkState: project.media.relinkState,
  },
  evidence: [...project.evidence]
    .sort((left, right) => compareText(left.evidenceId, right.evidenceId))
    .map((evidence) => ({ ...evidence })),
  qualityProfile: {
    profileId: project.qualityProfile.profileId,
    revision: project.qualityProfile.revision,
    name: project.qualityProfile.name,
    rules: project.qualityProfile.rules,
  },
  captions: {
    order: [...project.captions.order],
    items: Object.values(project.captions.items)
      .sort((left, right) => compareText(left.itemId, right.itemId))
      .map(inputCaptionItem),
  },
  audioDescriptions: {
    order: [...project.audioDescriptions.order],
    items: Object.values(project.audioDescriptions.items)
      .sort((left, right) => compareText(left.itemId, right.itemId))
      .map(inputAudioDescriptionItem),
  },
  audioDescriptionGaps: Object.values(project.audioDescriptionGaps)
    .sort((left, right) => compareText(left.gapId, right.gapId))
    .map((gap) => ({ ...gap })),
});

/**
 * Validation input has audit-only project revision metadata. Every other
 * field is semantic and therefore binds a current validation run.
 */
export const semanticValidationInput = (input: ValidationInputSnapshot) => ({
  projectId: input.projectId,
  media: input.media,
  evidence: input.evidence,
  qualityProfile: input.qualityProfile,
  captions: input.captions,
  audioDescriptions: input.audioDescriptions,
  audioDescriptionGaps: input.audioDescriptionGaps,
});

export const validationInputHashFor = (input: ValidationInputSnapshot): string =>
  stableHash(semanticValidationInput(input));

export const validationInputHash = (project: CaptionProject): string =>
  validationInputHashFor(buildValidationInput(project));

const isFiniteInteger = (value: number): boolean => Number.isSafeInteger(value);
const hasBounds = (project: CaptionProject, startMs: number, endMs: number): boolean =>
  isFiniteInteger(startMs)
  && isFiniteInteger(endMs)
  && startMs >= 0
  && startMs < endMs
  && endMs <= project.media.durationMs;

const itemTarget = (item: CaptionCue | AudioDescriptionBeat): QualityFindingTarget => ({
  type: "item",
  kind: item.kind,
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
});

const pairTarget = (
  first: CaptionCue | AudioDescriptionBeat,
  second: CaptionCue | AudioDescriptionBeat,
): QualityFindingTarget => ({
  type: "pair",
  first: {
    kind: first.kind,
    itemId: first.itemId,
    itemRevision: first.current.itemRevision,
  },
  second: {
    kind: second.kind,
    itemId: second.itemId,
    itemRevision: second.current.itemRevision,
  },
});

const targetParts = (target: QualityFindingTarget): readonly string[] => {
  if (target.type === "project") {
    return ["target", "project", target.projectId, String(target.projectRevision)];
  }
  if (target.type === "item") {
    return ["target", "item", target.kind, target.itemId, String(target.itemRevision)];
  }
  return [
    "target",
    "pair",
    "first",
    target.first.kind,
    target.first.itemId,
    String(target.first.itemRevision),
    "second",
    target.second.kind,
    target.second.itemId,
    String(target.second.itemRevision),
  ];
};

/**
 * Finding IDs bind rule, profile revision, and target revision using a
 * length-prefixed tuple before SHA-256. Delimiter-like item ids cannot alias
 * another pair or target.
 */
export const findingIdFor = (
  ruleId: string,
  profile: Pick<QualityProfile, "profileId" | "revision">,
  target: QualityFindingTarget,
): string => tupleHash("cuebench.finding.v1", [
  "rule",
  ruleId,
  "profile",
  profile.profileId,
  "profileRevision",
  String(profile.revision),
  ...targetParts(target),
]);

/**
 * A display/audit finding id intentionally includes evaluated revisions. This
 * separate identity answers a different question for the local Impact
 * Summary: whether the same rule still affects the same project/item pair
 * after a later revision has been evaluated.
 */
export const findingIdentityFor = (finding: Pick<QualityFinding, "ruleId" | "target">): string => {
  const target = finding.target;
  if (target.type === "project") {
    return tupleHash("cuebench.finding-identity.v1", ["rule", finding.ruleId, "target", "project", target.projectId]);
  }
  if (target.type === "item") {
    return tupleHash("cuebench.finding-identity.v1", [
      "rule",
      finding.ruleId,
      "target",
      "item",
      target.kind,
      target.itemId,
    ]);
  }
  const pair = [target.first, target.second]
    .map((item) => [item.kind, item.itemId] as const)
    .sort(([leftKind, leftId], [rightKind, rightId]) => leftKind.localeCompare(rightKind) || leftId.localeCompare(rightId));
  return tupleHash("cuebench.finding-identity.v1", [
    "rule",
    finding.ruleId,
    "target",
    "pair",
    ...pair.flat(),
  ]);
};

const normalizedText = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const textLength = (text: string): number => [...text].length;
const lineLength = (line: string): number => [...line].length;

const isOverlapping = (
  first: { readonly startMs: number; readonly endMs: number },
  second: { readonly startMs: number; readonly endMs: number },
): boolean => first.startMs < second.endMs && second.startMs < first.endMs;

export const validateProject = (project: CaptionProject): ValidationRun => {
  const findings: QualityFinding[] = [];
  const findingIds = new Set<string>();
  const add = (
    ruleId: string,
    severity: FindingSeverity,
    message: string,
    target: QualityFindingTarget,
  ) => {
    const findingId = findingIdFor(ruleId, project.qualityProfile, target);
    if (findingIds.has(findingId)) return;
    findingIds.add(findingId);
    findings.push({ id: findingId, findingId, ruleId, severity, message, target });
  };
  const projectTarget: QualityFindingTarget = {
    type: "project",
    projectId: project.projectId,
    projectRevision: project.projectRevision,
  };
  const rules = resolveEducationProfileRules(project.qualityProfile.rules);
  const captionItems = liveCaptionItems(project);
  const audioDescriptionItems = liveAudioDescriptionItems(project);
  const temporalCaptionItems = temporalItems(captionItems);
  const temporalAudioDescriptionItems = temporalItems(audioDescriptionItems);

  if (
    project.media.relinkState !== "Linked"
    || !Number.isSafeInteger(project.media.durationMs)
    || project.media.durationMs < 0
    || !/^[0-9a-f]{64}$/i.test(project.media.sha256)
  ) add("evidence.stale", "blocker", "Current media evidence is unavailable or no longer linked.", projectTarget);

  const currentItemsById = new Map<string, CaptionCue | AudioDescriptionBeat>(
    currentProjectItems(project).map((item) => [item.itemId, item]),
  );
  for (const evidence of project.evidence) {
    const boundItem = evidence.itemId === null ? undefined : currentItemsById.get(evidence.itemId);
    const target = boundItem === undefined ? projectTarget : itemTarget(boundItem);
    const stale = evidence.projectId !== project.projectId
      || evidence.mediaSha256 !== project.media.sha256
      || (evidence.itemId === null) !== (evidence.itemRevision === null)
      || (evidence.itemId !== null && (
        boundItem === undefined || boundItem.current.itemRevision !== evidence.itemRevision
      ));
    if (stale) {
      add("evidence.stale", "blocker", "Evidence provenance no longer matches the current project, media, or item revision.", target);
    }
  }

  const checkTrackStructure = (
    kind: "caption" | "audio-description",
    order: readonly string[],
    resolve: (itemId: string) => CaptionCue | AudioDescriptionBeat | undefined,
    isLive: (item: CaptionCue | AudioDescriptionBeat) => boolean,
    liveItems: readonly (CaptionCue | AudioDescriptionBeat)[],
  ) => {
    const seenLiveIds = new Set<string>();
    for (const itemId of order) {
      const item = resolve(itemId);
      if (item === undefined) {
        add(`${kind}.ordering`, "blocker", "Track order contains a duplicate or unresolved item.", projectTarget);
        add(`${kind}.order-missing-item`, "blocker", "Track order references an item absent from its item map.", projectTarget);
      } else if (!isLive(item)) {
        add(`${kind}.ordering`, "blocker", "Track order contains a duplicate or unresolved item.", projectTarget);
        add(`${kind}.order-nonlive-item`, "blocker", "Track order references an item that is no longer live.", projectTarget);
      } else if (seenLiveIds.has(itemId)) {
        add(`${kind}.ordering`, "blocker", "Track order contains a duplicate or unresolved item.", projectTarget);
        add(`${kind}.order-duplicate`, "blocker", "Track order references the same live item more than once.", projectTarget);
      } else {
        seenLiveIds.add(itemId);
      }
    }
    for (const item of liveItems) {
      if (!seenLiveIds.has(item.itemId)) {
        add(`${kind}.ordering`, "blocker", "Track contains a live item that is absent from its order.", projectTarget);
        add(`${kind}.order-omitted-item`, "blocker", "A live item is absent from its track order.", projectTarget);
        add(`${kind}.map-extra-item`, "blocker", "The item map contains a live item not represented by track order.", projectTarget);
      }
    }
  };
  checkTrackStructure(
    "caption",
    project.captions.order,
    (itemId) => project.captions.items[itemId],
    (item) => item.kind !== "CaptionCue" || item.mergedIntoItemId === null,
    captionItems,
  );
  checkTrackStructure(
    "audio-description",
    project.audioDescriptions.order,
    (itemId) => project.audioDescriptions.items[itemId],
    () => true,
    audioDescriptionItems,
  );

  const seenCaptionText = new Map<string, CaptionCue>();
  for (const cue of captionItems) {
    const target = itemTarget(cue);
    if (!hasBounds(project, cue.current.startMs, cue.current.endMs)) {
      add("caption.timing-bounds", "blocker", "Caption timing must be integer milliseconds within the linked media.", target);
    } else {
      const durationMs = cue.current.endMs - cue.current.startMs;
      if (durationMs < rules.caption.minDurationMs || durationMs > rules.caption.maxDurationMs) {
        add("caption.duration", "warning", "Caption duration falls outside the selected profile range.", target);
      }
      const readingSpeed = textLength(cue.current.text) / (durationMs / 1_000);
      if (readingSpeed > rules.caption.maxReadingSpeedCps) {
        add("caption.reading-speed", "warning", "Caption reading speed exceeds the selected profile limit.", target);
      }
    }
    if (!cue.current.text.trim()) {
      add("caption.empty", "blocker", "Caption text cannot be empty.", target);
    } else {
      const lines = cue.current.text.split(/\r\n|\n|\r/);
      if (lines.length > rules.caption.maxLineCount) {
        add("caption.line-count", "warning", "Caption has more lines than the selected profile allows.", target);
      }
      if (lines.some((line) => lineLength(line) > rules.caption.maxLineLength)) {
        add("caption.line-length", "warning", "Caption has a line longer than the selected profile allows.", target);
      }
      const normalized = normalizedText(cue.current.text);
      const duplicateOf = seenCaptionText.get(normalized);
      if (duplicateOf !== undefined) {
        add("caption.duplicate", "warning", "Caption duplicates an earlier caption after whitespace normalization.", pairTarget(duplicateOf, cue));
      } else seenCaptionText.set(normalized, cue);
    }
    if (cue.current.state === "Objected") {
      add("review.objected-revision", "blocker", "An Objected caption revision must be resolved before certification.", target);
    } else if (cue.current.state !== "Sustained") {
      add("review.unreviewed-revision", "warning", "Caption revision has not been Sustained by a human.", target);
    }
  }

  const orderedCaptionItems = orderedLiveCaptionItems(project);
  for (let index = 1; index < orderedCaptionItems.length; index += 1) {
    const previous = orderedCaptionItems[index - 1]!;
    const current = orderedCaptionItems[index]!;
    if (hasBounds(project, previous.current.startMs, previous.current.endMs)
      && hasBounds(project, current.current.startMs, current.current.endMs)
      && current.current.startMs < previous.current.startMs) {
      add("caption.ordering", "blocker", "Caption order must follow ascending start times.", pairTarget(previous, current));
    }
  }
  for (let index = 1; index < temporalCaptionItems.length; index += 1) {
    const previous = temporalCaptionItems[index - 1]!;
    const current = temporalCaptionItems[index]!;
    if (!hasBounds(project, previous.current.startMs, previous.current.endMs) || !hasBounds(project, current.current.startMs, current.current.endMs)) continue;
    const target = pairTarget(previous, current);
    const gapMs = current.current.startMs - previous.current.endMs;
    if (gapMs > rules.caption.maxGapMs) {
      add("caption.gap", "warning", "Caption gap exceeds the selected profile limit.", target);
    }
    if (
      previous.current.speaker !== null
      && current.current.speaker !== null
      && previous.current.speaker !== current.current.speaker
      && gapMs < rules.caption.minSpeakerTransitionGapMs
    ) add("caption.speaker-transition", "warning", "Speaker transition does not meet the selected profile spacing.", target);
  }
  if (rules.caption.overlapPolicy === "block") {
    for (let firstIndex = 0; firstIndex < temporalCaptionItems.length; firstIndex += 1) {
      const first = temporalCaptionItems[firstIndex]!;
      if (!hasBounds(project, first.current.startMs, first.current.endMs)) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < temporalCaptionItems.length; secondIndex += 1) {
        const second = temporalCaptionItems[secondIndex]!;
        if (hasBounds(project, second.current.startMs, second.current.endMs) && isOverlapping(first.current, second.current)) {
          add("caption.no-overlap", "blocker", "Caption cues may not overlap under the selected profile.", pairTarget(first, second));
        }
      }
    }
  }

  const seenAudioDescriptionText = new Map<string, AudioDescriptionBeat>();
  for (const beat of audioDescriptionItems) {
    const target = itemTarget(beat);
    if (!hasBounds(project, beat.current.startMs, beat.current.endMs)) {
      add("audio-description.timing-bounds", "blocker", "Audio-description timing must be integer milliseconds within the linked media.", target);
    } else {
      const durationMs = beat.current.endMs - beat.current.startMs;
      if (durationMs < rules.audioDescription.minDurationMs || durationMs > rules.audioDescription.maxDurationMs) {
        add("audio-description.duration", "warning", "Audio-description duration falls outside the selected profile range.", target);
      }
    }
    if (!beat.current.description.trim()) {
      add("audio-description.empty", "blocker", "Audio-description text cannot be empty.", target);
    } else {
      const normalized = normalizedText(beat.current.description);
      const duplicateOf = seenAudioDescriptionText.get(normalized);
      if (duplicateOf !== undefined) {
        add("audio-description.duplicate", "warning", "Audio description duplicates an earlier beat after whitespace normalization.", pairTarget(duplicateOf, beat));
      } else seenAudioDescriptionText.set(normalized, beat);
    }
    if (beat.current.state === "Objected") {
      add("review.objected-revision", "blocker", "An Objected audio-description revision must be resolved before certification.", target);
    } else if (beat.current.state !== "Sustained") {
      add("review.unreviewed-revision", "warning", "Audio-description revision has not been Sustained by a human.", target);
    }
  }

  const orderedAudioDescriptionItems = orderedLiveAudioDescriptionItems(project);
  for (let index = 1; index < orderedAudioDescriptionItems.length; index += 1) {
    const previous = orderedAudioDescriptionItems[index - 1]!;
    const current = orderedAudioDescriptionItems[index]!;
    if (hasBounds(project, previous.current.startMs, previous.current.endMs)
      && hasBounds(project, current.current.startMs, current.current.endMs)
      && current.current.startMs < previous.current.startMs) {
      add("audio-description.ordering", "blocker", "Audio-description order must follow ascending start times.", pairTarget(previous, current));
    }
  }
  for (let index = 1; index < temporalAudioDescriptionItems.length; index += 1) {
    const previous = temporalAudioDescriptionItems[index - 1]!;
    const current = temporalAudioDescriptionItems[index]!;
    if (!hasBounds(project, previous.current.startMs, previous.current.endMs) || !hasBounds(project, current.current.startMs, current.current.endMs)) continue;
    if (current.current.startMs - previous.current.endMs > rules.audioDescription.maxGapMs) {
      add("audio-description.gap", "warning", "Audio-description gap exceeds the selected profile limit.", pairTarget(previous, current));
    }
  }
  if (rules.audioDescription.overlapPolicy === "block") {
    for (let firstIndex = 0; firstIndex < temporalAudioDescriptionItems.length; firstIndex += 1) {
      const first = temporalAudioDescriptionItems[firstIndex]!;
      if (!hasBounds(project, first.current.startMs, first.current.endMs)) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < temporalAudioDescriptionItems.length; secondIndex += 1) {
        const second = temporalAudioDescriptionItems[secondIndex]!;
        if (hasBounds(project, second.current.startMs, second.current.endMs) && isOverlapping(first.current, second.current)) {
          add("audio-description.no-overlap", "blocker", "Audio-description beats may not overlap under the selected profile.", pairTarget(first, second));
        }
      }
    }
  }

  if (rules.audioDescription.forbidDialogueCollision) {
    for (const beat of temporalAudioDescriptionItems) {
      if (!hasBounds(project, beat.current.startMs, beat.current.endMs)) continue;
      for (const cue of temporalCaptionItems) {
        if (hasBounds(project, cue.current.startMs, cue.current.endMs) && isOverlapping(beat.current, cue.current)) {
          add("audio-description.dialogue-collision", "warning", "Audio description overlaps foreground dialogue.", pairTarget(cue, beat));
        }
      }
    }
  }

  findings.sort((left, right) => compareText(left.findingId, right.findingId));
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const input = buildValidationInput(project);
  return {
    projectId: project.projectId,
    projectRevision: project.projectRevision,
    profileId: project.qualityProfile.profileId,
    profileRevision: project.qualityProfile.revision,
    input,
    inputHash: validationInputHashFor(input),
    findings,
    blockers,
    warnings,
    blockerCount: blockers.length,
    warningCount: warnings.length,
  };
};

const reviewStates = new Set<ReviewState>(["Proposed", "AgentReady", "Objected", "Sustained"]);

/**
 * Rebuilds the minimum aggregate required by the deterministic rule engine
 * from an immutable validation input. This is intentionally pure: callers
 * can verify stored validation findings without trusting a serialized result.
 */
const projectFromValidationInput = (input: ValidationInputSnapshot): CaptionProject => {
  const actor = { type: "System" as const, id: "validation-input" };
  const captions: Record<string, CaptionCue> = {};
  const audioDescriptions: Record<string, AudioDescriptionBeat> = {};
  const gaps: Record<string, AudioDescriptionGap> = {};
  for (const item of input.captions.items) {
    if (item.kind !== "CaptionCue" || !reviewStates.has(item.state as ReviewState)) {
      throw new TypeError("Validation input contains an invalid caption item.");
    }
    const revision = {
      kind: "CaptionCue" as const,
      itemId: item.itemId,
      itemRevision: item.itemRevision,
      state: item.state as ReviewState,
      startMs: item.startMs,
      endMs: item.endMs,
      text: item.text,
      speaker: item.speaker,
      actor,
      cause: "Validation input reconstruction.",
      parentItemRevision: null,
    };
    captions[item.itemId] = {
      itemId: item.itemId,
      kind: "CaptionCue",
      revisions: [revision],
      current: revision,
      mergedIntoItemId: item.mergedIntoItemId ?? null,
    };
  }
  for (const item of input.audioDescriptions.items) {
    if (item.kind !== "AudioDescriptionBeat" || !reviewStates.has(item.state as ReviewState)) {
      throw new TypeError("Validation input contains an invalid audio-description item.");
    }
    const revision = {
      kind: "AudioDescriptionBeat" as const,
      itemId: item.itemId,
      itemRevision: item.itemRevision,
      state: item.state as ReviewState,
      startMs: item.startMs,
      endMs: item.endMs,
      description: item.text,
      actor,
      cause: "Validation input reconstruction.",
      parentItemRevision: null,
    };
    audioDescriptions[item.itemId] = {
      itemId: item.itemId,
      kind: "AudioDescriptionBeat",
      revisions: [revision],
      current: revision,
    };
  }
  for (const gap of input.audioDescriptionGaps) {
    if (gap.state !== "Available" && gap.state !== "Consumed") {
      throw new TypeError("Validation input contains an invalid audio-description gap.");
    }
    gaps[gap.gapId] = { ...gap, state: gap.state };
  }
  return {
    contractVersion: 1,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    title: "Validation input reconstruction",
    media: { ...input.media } as CaptionProject["media"],
    evidence: input.evidence.map((evidence) => ({ ...evidence })),
    localEvidencePackages: [],
    captions: { kind: "Captions", order: [...input.captions.order], items: captions },
    audioDescriptions: { kind: "AudioDescriptions", order: [...input.audioDescriptions.order], items: audioDescriptions },
    audioDescriptionGaps: gaps,
    selectedItem: null,
    validation: { status: "NotRun", blockerCount: 0, warningCount: 0 },
    validationRun: null,
    validationHistory: [],
    certification: { status: "NotCertified" },
    certifications: [],
    qualityProfile: {
      profileId: input.qualityProfile.profileId,
      revision: input.qualityProfile.revision,
      name: input.qualityProfile.name,
      rules: structuredClone(input.qualityProfile.rules),
    },
    warningWaivers: {},
    activeGenerationRun: null,
    courtRecord: [],
    exportHistory: [],
  };
};

/** Re-evaluates a stored validation input without trusting stored findings. */
export const validateValidationInput = (input: ValidationInputSnapshot): ValidationRun =>
  validateProject(projectFromValidationInput(input));

export const currentValidationRun = (project: CaptionProject): ValidationRun | undefined => {
  const run = project.validationRun;
  if (project.validation.status !== "Current" || run === null) return undefined;
  return run.inputHash === validationInputHash(project) ? run : undefined;
};

/** Every live map entry contributes to validation, readiness, and certification. */
export const currentProjectItems = (
  project: CaptionProject,
): readonly (CaptionCue | AudioDescriptionBeat)[] => [
  ...liveCaptionItems(project),
  ...liveAudioDescriptionItems(project),
];
