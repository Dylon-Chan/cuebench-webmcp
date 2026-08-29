import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  QualityProfile,
} from "../model";
import { resolveEducationProfileRules } from "./profile";

export type FindingSeverity = "blocker" | "warning";

export type QualityFindingTarget =
  | {
      readonly type: "project";
      readonly projectId: string;
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

const stableSerialize = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `bigint:${value.toString()}`;
    case "number":
      return Number.isFinite(value) ? `number:${String(value)}` : `number:${String(value)}`;
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "object": {
      if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
      const object = value as Readonly<Record<string, unknown>>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
    }
    default:
      return `${typeof value}:${String(value)}`;
  }
};

/** A synchronous, runtime-independent hash for stable local snapshot identifiers. */
export const stableHash = (value: unknown): string => {
  const serialized = stableSerialize(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
};

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const currentCaptionItems = (project: CaptionProject): readonly CaptionCue[] =>
  project.captions.order.flatMap((itemId) => {
    const item = project.captions.items[itemId];
    return item === undefined || item.mergedIntoItemId !== null ? [] : [item];
  });

const currentAudioDescriptionItems = (project: CaptionProject): readonly AudioDescriptionBeat[] =>
  project.audioDescriptions.order.flatMap((itemId) => {
    const item = project.audioDescriptions.items[itemId];
    return item === undefined ? [] : [item];
  });

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

const semanticValidationInput = (input: ValidationInputSnapshot) => ({
  projectId: input.projectId,
  media: input.media,
  qualityProfile: input.qualityProfile,
  captions: input.captions,
  audioDescriptions: input.audioDescriptions,
  audioDescriptionGaps: input.audioDescriptionGaps,
});

export const validationInputHash = (project: CaptionProject): string =>
  stableHash(semanticValidationInput(buildValidationInput(project)));

const isFiniteInteger = (value: number) => Number.isSafeInteger(value);
const hasBounds = (project: CaptionProject, startMs: number, endMs: number) =>
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

const targetRevisionKey = (target: QualityFindingTarget): string => {
  if (target.type === "project") return `project:${target.projectId}`;
  if (target.type === "item") return `${target.kind}:${target.itemId}@${target.itemRevision}`;
  const part = (item: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat";
    readonly itemId: string;
    readonly itemRevision: number;
  }) => `${item.kind}:${item.itemId}@${item.itemRevision}`;
  return `${part(target.first)}|${part(target.second)}`;
};

export const findingIdFor = (
  ruleId: string,
  profile: Pick<QualityProfile, "profileId" | "revision">,
  target: QualityFindingTarget,
): string => `${ruleId}:${profile.profileId}@${profile.revision}:${targetRevisionKey(target)}`;

const normalizedText = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const textLength = (text: string) => [...text].length;
const lineLength = (line: string) => [...line].length;

const isOverlapping = (
  first: { readonly startMs: number; readonly endMs: number },
  second: { readonly startMs: number; readonly endMs: number },
) => first.startMs < second.endMs && second.startMs < first.endMs;

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
    findings.push({
      id: findingId,
      findingId,
      ruleId,
      severity,
      message,
      target,
    });
  };
  const projectTarget: QualityFindingTarget = { type: "project", projectId: project.projectId };
  const rules = resolveEducationProfileRules(project.qualityProfile.rules);
  const captionItems = currentCaptionItems(project);
  const audioDescriptionItems = currentAudioDescriptionItems(project);

  if (
    project.media.relinkState !== "Linked"
    || !Number.isSafeInteger(project.media.durationMs)
    || project.media.durationMs < 0
    || !/^[0-9a-f]{64}$/i.test(project.media.sha256)
  ) add("evidence.stale", "blocker", "Current media evidence is unavailable or no longer linked.", projectTarget);

  const checkTrackStructure = (
    kind: "caption" | "audio-description",
    order: readonly string[],
    ids: readonly string[],
  ) => {
    const seen = new Set<string>();
    for (const itemId of order) {
      if (seen.has(itemId) || !ids.includes(itemId)) {
        add(`${kind}.ordering`, "blocker", "Track order contains a duplicate or unresolved item.", projectTarget);
        break;
      }
      seen.add(itemId);
    }
    if (ids.some((itemId) => !seen.has(itemId))) {
      add(`${kind}.ordering`, "blocker", "Track contains a live item that is absent from its order.", projectTarget);
    }
  };
  checkTrackStructure("caption", project.captions.order, captionItems.map((item) => item.itemId));
  checkTrackStructure("audio-description", project.audioDescriptions.order, audioDescriptionItems.map((item) => item.itemId));

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

  for (let index = 1; index < captionItems.length; index += 1) {
    const previous = captionItems[index - 1]!;
    const current = captionItems[index]!;
    if (!hasBounds(project, previous.current.startMs, previous.current.endMs) || !hasBounds(project, current.current.startMs, current.current.endMs)) continue;
    const target = pairTarget(previous, current);
    if (current.current.startMs < previous.current.startMs) {
      add("caption.ordering", "blocker", "Caption order must follow ascending start times.", target);
    }
    if (isOverlapping(previous.current, current.current)) {
      add("caption.no-overlap", "blocker", "Caption cues may not overlap.", target);
    }
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

  for (let index = 1; index < audioDescriptionItems.length; index += 1) {
    const previous = audioDescriptionItems[index - 1]!;
    const current = audioDescriptionItems[index]!;
    if (!hasBounds(project, previous.current.startMs, previous.current.endMs) || !hasBounds(project, current.current.startMs, current.current.endMs)) continue;
    const target = pairTarget(previous, current);
    if (current.current.startMs < previous.current.startMs) {
      add("audio-description.ordering", "blocker", "Audio-description order must follow ascending start times.", target);
    }
    if (isOverlapping(previous.current, current.current)) {
      add("audio-description.no-overlap", "blocker", "Audio-description beats may not overlap.", target);
    }
    if (current.current.startMs - previous.current.endMs > rules.audioDescription.maxGapMs) {
      add("audio-description.gap", "warning", "Audio-description gap exceeds the selected profile limit.", target);
    }
  }

  if (rules.audioDescription.forbidDialogueCollision) {
    for (const beat of audioDescriptionItems) {
      if (!hasBounds(project, beat.current.startMs, beat.current.endMs)) continue;
      for (const cue of captionItems) {
        if (!hasBounds(project, cue.current.startMs, cue.current.endMs)) continue;
        if (isOverlapping(beat.current, cue.current)) {
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
    inputHash: stableHash(semanticValidationInput(input)),
    findings,
    blockers,
    warnings,
    blockerCount: blockers.length,
    warningCount: warnings.length,
  };
};

export const currentValidationRun = (project: CaptionProject): ValidationRun | undefined => {
  const run = project.validationRun;
  if (project.validation.status !== "Current" || run === null) return undefined;
  return run.inputHash === validationInputHash(project) ? run : undefined;
};

export const currentProjectItems = (
  project: CaptionProject,
): readonly (CaptionCue | AudioDescriptionBeat)[] => [
  ...currentCaptionItems(project),
  ...currentAudioDescriptionItems(project),
];
