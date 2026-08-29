import type {
  Actor,
  CertificationSnapshot,
  GenerationTargetTrack,
  MediaSourceSnapshot,
  ProjectItemKind,
  ReviewState,
  ValidationSnapshot,
} from "@cuebench/contracts";

export type ItemId = string;
export type ProfileRevision = number;

export interface RevisionBase {
  readonly itemId: ItemId;
  readonly itemRevision: number;
  readonly state: ReviewState;
  readonly startMs: number;
  readonly endMs: number;
  readonly actor: Actor;
  readonly cause: string;
  readonly parentItemRevision: number | null;
}

export interface CaptionCueRevision extends RevisionBase {
  readonly kind: "CaptionCue";
  readonly text: string;
  readonly speaker: string | null;
}

export interface AudioDescriptionBeatRevision extends RevisionBase {
  readonly kind: "AudioDescriptionBeat";
  readonly description: string;
}

export interface CaptionCue {
  readonly itemId: ItemId;
  readonly kind: "CaptionCue";
  readonly revisions: readonly CaptionCueRevision[];
  readonly current: CaptionCueRevision;
  /** A merged cue remains recoverable in the item map but is no longer live in track order. */
  readonly mergedIntoItemId: ItemId | null;
}

export interface AudioDescriptionBeat {
  readonly itemId: ItemId;
  readonly kind: "AudioDescriptionBeat";
  readonly revisions: readonly AudioDescriptionBeatRevision[];
  readonly current: AudioDescriptionBeatRevision;
}

export interface CaptionTrack {
  readonly kind: "Captions";
  readonly order: readonly ItemId[];
  readonly items: Readonly<Record<ItemId, CaptionCue>>;
}

export interface AudioDescriptionTrack {
  readonly kind: "AudioDescriptions";
  readonly order: readonly ItemId[];
  readonly items: Readonly<Record<ItemId, AudioDescriptionBeat>>;
}

export interface AudioDescriptionGap {
  readonly gapId: string;
  readonly gapRevision: number;
  readonly state: "Available" | "Consumed";
  readonly startMs: number;
  readonly endMs: number;
}

export interface ItemSelection {
  readonly itemId: ItemId;
  readonly itemRevision: number;
  readonly kind: ProjectItemKind;
}

export interface GapSelection {
  readonly itemId: ItemId;
  readonly itemRevision: number;
  readonly kind: "AudioDescriptionGap";
  readonly state: "Available";
}

export type Selection = ItemSelection | GapSelection;

export interface QualityProfile {
  readonly profileId: string;
  readonly revision: ProfileRevision;
  readonly name: string;
  readonly rules: Readonly<Record<string, unknown>>;
}

export interface WarningWaiver {
  readonly findingId: string;
  readonly reason: string;
  readonly actor: Actor;
  readonly projectRevision: number;
}

export interface GenerationLease {
  readonly runId: string;
  readonly targetTrack: GenerationTargetTrack;
  readonly actor: Actor;
}

export interface DomainEvent {
  readonly eventId: string;
  readonly projectRevision: number;
  readonly type: string;
  readonly actor: Actor;
  readonly itemId?: string;
  readonly detail?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface CaptionProject {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly title: string;
  readonly media: MediaSourceSnapshot;
  readonly captions: CaptionTrack;
  readonly audioDescriptions: AudioDescriptionTrack;
  readonly audioDescriptionGaps: Readonly<Record<string, AudioDescriptionGap>>;
  readonly selectedItem: Selection | null;
  readonly validation: ValidationSnapshot;
  readonly certification: CertificationSnapshot;
  readonly qualityProfile: QualityProfile;
  readonly warningWaivers: Readonly<Record<string, WarningWaiver>>;
  readonly activeGenerationRun: GenerationLease | null;
  readonly courtRecord: readonly DomainEvent[];
}

export interface CreateProjectInput {
  readonly projectId: string;
  readonly title: string;
  readonly media: MediaSourceSnapshot;
  readonly profile?: Omit<QualityProfile, "revision"> & { readonly revision?: number };
  readonly captions?: readonly Omit<CaptionCueRevision, "itemRevision" | "parentItemRevision">[];
  readonly audioDescriptions?: readonly Omit<
    AudioDescriptionBeatRevision,
    "itemRevision" | "parentItemRevision"
  >[];
  readonly audioDescriptionGaps?: readonly AudioDescriptionGap[];
}

const initialValidation = (): ValidationSnapshot => ({
  status: "NotRun",
  blockerCount: 0,
  warningCount: 0,
});

const initialCertification = (): CertificationSnapshot => ({ status: "NotCertified" });

const hasValidInitialTiming = (durationMs: number, startMs: number, endMs: number) =>
  Number.isSafeInteger(durationMs)
  && Number.isSafeInteger(startMs)
  && Number.isSafeInteger(endMs)
  && durationMs >= 0
  && startMs >= 0
  && startMs < endMs
  && endMs <= durationMs;

const assertInitialProjectInvariant = (input: CreateProjectInput) => {
  if (!Number.isSafeInteger(input.media.durationMs) || input.media.durationMs < 0) {
    throw new RangeError("Media duration must be a non-negative integer.");
  }
  const knownIds = new Set<string>();
  for (const item of [...(input.captions ?? []), ...(input.audioDescriptions ?? [])]) {
    if (knownIds.has(item.itemId)) throw new RangeError("Project item ids must be unique.");
    knownIds.add(item.itemId);
    if (!hasValidInitialTiming(input.media.durationMs, item.startMs, item.endMs)) {
      throw new RangeError("Project item timing must be integer milliseconds within media bounds.");
    }
    if (!isInitialActorStateValid(item.actor, item.state)) {
      throw new RangeError("Initial item actor is not permitted for its review state.");
    }
  }
  for (const gap of input.audioDescriptionGaps ?? []) {
    if (knownIds.has(gap.gapId)) throw new RangeError("Project ids must be globally unique.");
    knownIds.add(gap.gapId);
    if (
      !Number.isSafeInteger(gap.gapRevision)
      || gap.gapRevision <= 0
      || !hasValidInitialTiming(input.media.durationMs, gap.startMs, gap.endMs)
    ) throw new RangeError("Audio-description gaps must have valid integer timing and revision.");
  }
};

const isInitialActorStateValid = (actor: Actor, state: ReviewState) => {
  if (!actor.id.trim() || actor.type === "System") return false;
  if (state === "AgentReady") return actor.type === "BrowserAgent";
  if (state === "Objected" || state === "Sustained") return actor.type === "Human";
  return state === "Proposed";
};

const clone = <Value>(value: Value): Value => structuredClone(value);

export const createProject = (input: CreateProjectInput): CaptionProject => {
  assertInitialProjectInvariant(input);
  const captions: Record<string, CaptionCue> = {};
  const captionOrder: string[] = [];
  for (const source of input.captions ?? []) {
    const revision: CaptionCueRevision = {
      ...source,
      actor: clone(source.actor),
      itemRevision: 1,
      parentItemRevision: null,
    };
    captions[revision.itemId] = {
      itemId: revision.itemId,
      kind: "CaptionCue",
      revisions: [revision],
      current: revision,
      mergedIntoItemId: null,
    };
    captionOrder.push(revision.itemId);
  }

  const audioDescriptions: Record<string, AudioDescriptionBeat> = {};
  const audioDescriptionOrder: string[] = [];
  for (const source of input.audioDescriptions ?? []) {
    const revision: AudioDescriptionBeatRevision = {
      ...source,
      actor: clone(source.actor),
      itemRevision: 1,
      parentItemRevision: null,
    };
    audioDescriptions[revision.itemId] = {
      itemId: revision.itemId,
      kind: "AudioDescriptionBeat",
      revisions: [revision],
      current: revision,
    };
    audioDescriptionOrder.push(revision.itemId);
  }

  const audioDescriptionGaps: Record<string, AudioDescriptionGap> = {};
  for (const gap of input.audioDescriptionGaps ?? []) {
    audioDescriptionGaps[gap.gapId] = clone(gap);
  }

  return {
    contractVersion: 1,
    projectId: input.projectId,
    projectRevision: 1,
    title: input.title,
    media: clone(input.media),
    captions: { kind: "Captions", order: captionOrder, items: captions },
    audioDescriptions: {
      kind: "AudioDescriptions",
      order: audioDescriptionOrder,
      items: audioDescriptions,
    },
    audioDescriptionGaps,
    selectedItem: null,
    validation: initialValidation(),
    certification: initialCertification(),
    qualityProfile: {
      profileId: input.profile?.profileId ?? "education-quality",
      revision: input.profile?.revision ?? 1,
      name: input.profile?.name ?? "Education Quality Profile",
      rules: clone(input.profile?.rules ?? {}),
    },
    warningWaivers: {},
    activeGenerationRun: null,
    courtRecord: [],
  };
};
