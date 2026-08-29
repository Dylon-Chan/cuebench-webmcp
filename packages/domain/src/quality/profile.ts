import type { QualityProfile } from "../model";

export interface CaptionQualityRules {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly maxReadingSpeedCps: number;
  readonly maxLineLength: number;
  readonly maxLineCount: number;
  readonly maxGapMs: number;
  readonly minSpeakerTransitionGapMs: number;
}

export interface AudioDescriptionQualityRules {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly maxGapMs: number;
  readonly forbidDialogueCollision: boolean;
}

export interface EducationProfileRules {
  readonly caption: CaptionQualityRules;
  readonly audioDescription: AudioDescriptionQualityRules;
}

const educationRules = {
  caption: {
    minDurationMs: 500,
    maxDurationMs: 7_000,
    maxReadingSpeedCps: 20,
    maxLineLength: 42,
    maxLineCount: 2,
    maxGapMs: 5_000,
    minSpeakerTransitionGapMs: 0,
  },
  audioDescription: {
    minDurationMs: 500,
    maxDurationMs: 10_000,
    maxGapMs: 15_000,
    forbidDialogueCollision: true,
  },
} satisfies EducationProfileRules;

/** The human-editable default profile for the teacher-led Core workflow. */
export const EDUCATION_PROFILE: QualityProfile = {
  profileId: "education-quality",
  revision: 1,
  name: "Education Quality Profile",
  rules: educationRules,
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const numberFrom = (
  source: Readonly<Record<string, unknown>>,
  names: readonly string[],
  fallback: number,
  minimum: number,
): number => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= minimum) return value;
  }
  return fallback;
};

const booleanFrom = (
  source: Readonly<Record<string, unknown>>,
  names: readonly string[],
  fallback: boolean,
): boolean => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") return value;
  }
  return fallback;
};

/**
 * Profiles are intentionally stored as extensible JSON-like records. Resolve
 * known settings defensively so an incomplete proposal still receives the
 * stable Education defaults and unknown future settings do not change Core.
 */
export const resolveEducationProfileRules = (
  source: Readonly<Record<string, unknown>>,
): EducationProfileRules => {
  const caption = asRecord(source.caption);
  const audioDescription = asRecord(source.audioDescription ?? source.ad);
  const defaults = educationRules;
  return {
    caption: {
      minDurationMs: numberFrom(caption, ["minDurationMs", "minimumDurationMs"], defaults.caption.minDurationMs, 1),
      maxDurationMs: numberFrom(caption, ["maxDurationMs", "maximumDurationMs"], defaults.caption.maxDurationMs, 1),
      maxReadingSpeedCps: numberFrom(caption, ["maxReadingSpeedCps", "maximumReadingSpeedCps"], defaults.caption.maxReadingSpeedCps, 0.01),
      maxLineLength: numberFrom(caption, ["maxLineLength", "maximumLineLength"], defaults.caption.maxLineLength, 1),
      maxLineCount: numberFrom(caption, ["maxLineCount", "maximumLineCount"], defaults.caption.maxLineCount, 1),
      maxGapMs: numberFrom(caption, ["maxGapMs", "maximumGapMs"], defaults.caption.maxGapMs, 0),
      minSpeakerTransitionGapMs: numberFrom(caption, ["minSpeakerTransitionGapMs", "minimumSpeakerTransitionGapMs"], defaults.caption.minSpeakerTransitionGapMs, 0),
    },
    audioDescription: {
      minDurationMs: numberFrom(audioDescription, ["minDurationMs", "minimumDurationMs"], defaults.audioDescription.minDurationMs, 1),
      maxDurationMs: numberFrom(audioDescription, ["maxDurationMs", "maximumDurationMs"], defaults.audioDescription.maxDurationMs, 1),
      maxGapMs: numberFrom(audioDescription, ["maxGapMs", "maximumGapMs"], defaults.audioDescription.maxGapMs, 0),
      forbidDialogueCollision: booleanFrom(audioDescription, ["forbidDialogueCollision", "avoidDialogueCollision"], defaults.audioDescription.forbidDialogueCollision),
    },
  };
};
