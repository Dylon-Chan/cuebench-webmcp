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

export interface Selection {
  readonly itemId: ItemId;
  readonly itemRevision: number;
  readonly kind: ProjectItemKind;
}

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
}

export interface CaptionProject {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly title: string;
  readonly media: MediaSourceSnapshot;
  readonly captions: CaptionTrack;
  readonly audioDescriptions: AudioDescriptionTrack;
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
}

const initialValidation = (): ValidationSnapshot => ({
  status: "NotRun",
  blockerCount: 0,
  warningCount: 0,
});

const initialCertification = (): CertificationSnapshot => ({ status: "NotCertified" });

export const createProject = (input: CreateProjectInput): CaptionProject => {
  const captions: Record<string, CaptionCue> = {};
  const captionOrder: string[] = [];
  for (const source of input.captions ?? []) {
    const revision: CaptionCueRevision = {
      ...source,
      itemRevision: 1,
      parentItemRevision: null,
    };
    captions[revision.itemId] = {
      itemId: revision.itemId,
      kind: "CaptionCue",
      revisions: [revision],
      current: revision,
    };
    captionOrder.push(revision.itemId);
  }

  const audioDescriptions: Record<string, AudioDescriptionBeat> = {};
  const audioDescriptionOrder: string[] = [];
  for (const source of input.audioDescriptions ?? []) {
    const revision: AudioDescriptionBeatRevision = {
      ...source,
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

  return {
    contractVersion: 1,
    projectId: input.projectId,
    projectRevision: 1,
    title: input.title,
    media: input.media,
    captions: { kind: "Captions", order: captionOrder, items: captions },
    audioDescriptions: {
      kind: "AudioDescriptions",
      order: audioDescriptionOrder,
      items: audioDescriptions,
    },
    selectedItem: null,
    validation: initialValidation(),
    certification: initialCertification(),
    qualityProfile: {
      profileId: input.profile?.profileId ?? "education-quality",
      revision: input.profile?.revision ?? 1,
      name: input.profile?.name ?? "Education Quality Profile",
      rules: input.profile?.rules ?? {},
    },
    warningWaivers: {},
    activeGenerationRun: null,
    courtRecord: [],
  };
};
