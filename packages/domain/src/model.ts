import type {
  Actor,
  CertificationSnapshot,
  GenerationTargetTrack,
  LocalAudioDescriptionEvidencePackage,
  LocalCaptionEvidencePackage,
  MediaSourceSnapshot,
  ProjectItemKind,
  ReviewState,
  ValidationSnapshot,
} from "@cuebench/contracts";
import { EDUCATION_PROFILE } from "./quality/profile";
import type { ValidationRun } from "./quality/validate";

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
  /** A replaced AI draft remains auditable but must never render/export again. */
  readonly supersededByRunId: string | null;
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

/**
 * A durable binding between a piece of review evidence and the exact media
 * and optional item revision it supports.  Evidence is intentionally small:
 * its content can live elsewhere while this provenance remains auditable.
 */
export interface EvidenceProvenance {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly mediaSha256: string;
  readonly itemId: ItemId | null;
  readonly itemRevision: number | null;
}

export interface CertificationItemRevision {
  readonly kind: "CaptionCue" | "AudioDescriptionBeat";
  readonly itemId: ItemId;
  readonly itemRevision: number;
}

/**
 * The immutable record behind the lightweight current/stale certification
 * pointer exposed in contracts. Historical records are never rewritten.
 */
export interface ProjectCertification {
  readonly certificationId: string;
  /** SHA-256 hash of this immutable human certification record. */
  readonly certificationSnapshotHash: string;
  readonly readinessHash: string;
  readonly certifiedAtMs: number;
  readonly actor: Actor;
  readonly media: MediaSourceSnapshot;
  readonly evidence: readonly EvidenceProvenance[];
  readonly itemRevisions: readonly CertificationItemRevision[];
  readonly qualityProfile: QualityProfile;
  readonly validationRun: ValidationRun;
  readonly warningWaivers: readonly WarningWaiver[];
}

export interface GenerationLease {
  readonly runId: string;
  readonly targetTrack: GenerationTargetTrack;
  readonly actor: Actor;
  /**
   * Captured exactly when CueBench acquires the lease.  This narrow fence lets
   * unrelated audio-description work continue while blocking adoption if the
   * caption target, media, or profile changes.
   *
   * Optional only for legacy persisted leases. Those leases can be released,
   * but never adopted because they lack a trustworthy base state.
   */
  readonly base?: GenerationLeaseBase;
}

/** Caption and AD bases deliberately have no overlapping track-only fields. */
export interface CaptionGenerationLeaseBase {
  readonly targetTrack: "Captions";
  readonly expectedProjectRevision: number;
  readonly mediaSha256: string;
  readonly qualityProfileRevision: number;
  readonly captionOrder: readonly ItemId[];
  readonly captionItems: readonly {
    readonly itemId: ItemId;
    readonly itemRevision: number;
    readonly state: ReviewState;
    readonly mergedIntoItemId: ItemId | null;
  }[];
}

export interface AudioDescriptionGenerationLeaseBase {
  readonly targetTrack: "AudioDescriptions";
  readonly expectedProjectRevision: number;
  readonly mediaSha256: string;
  readonly qualityProfileRevision: number;
  /** Canonical hash of the exact bounded retained-caption projection. */
  readonly captionEvidenceHash: string;
  readonly captionEvidencePackageIds: readonly string[];
  readonly audioDescriptionOrder: readonly ItemId[];
  readonly audioDescriptionRequirementIds: readonly string[];
  readonly audioDescriptionItems: readonly {
    readonly itemId: ItemId;
    readonly itemRevision: number;
    readonly state: ReviewState;
    readonly supersededByRunId: string | null;
  }[];
}

export type GenerationLeaseBase = CaptionGenerationLeaseBase | AudioDescriptionGenerationLeaseBase;

/** A model suggestion that needs extended human-authored treatment. */
export interface AudioDescriptionRequirement {
  readonly requirementId: string;
  readonly runId: string;
  /** Review context only; validation never treats this as a fact about media. */
  readonly text: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  readonly reason: "no-compatible-speech-gap" | "requires-human-judgment" | "insufficient-visual-evidence";
  readonly createdAtMs: number;
}

export interface DomainEvent {
  readonly eventId: string;
  readonly projectRevision: number;
  readonly type: string;
  readonly actor: Actor;
  readonly itemId?: string;
  readonly detail?: string;
  /** Immutable Human verification binding; present only on VerifyItemEvidence. */
  readonly verificationPackageId?: string;
  /** Exact media root independently retained after evidence packages are tombstoned. */
  readonly verificationMediaSha256?: string;
}

/**
 * Immutable proof that an exact exported text payload parsed back to the
 * selected source track. This is persisted project history, not UI-supplied
 * Impact Summary input.
 */
export interface ExportRoundTripEvidence {
  readonly exportId: string;
  readonly projectRevision: number;
  readonly trackKind: "Captions" | "AudioDescriptions";
  readonly format: "vtt" | "srt" | "ad-txt";
  readonly disposition: "draft" | "certified";
  readonly verifiedAtMs: number;
  readonly serializedTextHash: string;
  readonly roundTrip: { readonly ok: true };
}

export interface CaptionProject {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly projectRevision: number;
  /** Optional only for legacy backups made before local creation timestamps. */
  readonly createdAtMs?: number;
  readonly title: string;
  readonly media: MediaSourceSnapshot;
  /**
   * Append-only evidence-binding history. Item revisions never rewrite a
   * binding. An explicit retained-evidence verification appends new provenance
   * for the exact current revision while earlier bindings remain auditable.
   */
  readonly evidence: readonly EvidenceProvenance[];
  /** Bounded adopted transcript evidence, included in local backup and review. */
  readonly localEvidencePackages: readonly LocalCaptionEvidencePackage[];
  /** Compact adopted visual evidence; never includes source media or narration preview audio. */
  readonly localAudioDescriptionEvidencePackages: readonly LocalAudioDescriptionEvidencePackage[];
  readonly captions: CaptionTrack;
  readonly audioDescriptions: AudioDescriptionTrack;
  /** Deterministic review findings for model-suggested extended descriptions. */
  readonly audioDescriptionRequirements: Readonly<Record<string, AudioDescriptionRequirement>>;
  readonly audioDescriptionGaps: Readonly<Record<string, AudioDescriptionGap>>;
  readonly selectedItem: Selection | null;
  readonly validation: ValidationSnapshot;
  /** Full deterministic run retained for readiness and immutable certification. */
  readonly validationRun: ValidationRun | null;
  /** Append-only validation history, including the initial run. */
  readonly validationHistory: readonly ValidationRun[];
  readonly certification: CertificationSnapshot;
  readonly certifications: readonly ProjectCertification[];
  readonly qualityProfile: QualityProfile;
  readonly warningWaivers: Readonly<Record<string, WarningWaiver>>;
  readonly activeGenerationRun: GenerationLease | null;
  readonly courtRecord: readonly DomainEvent[];
  /** Append-only successful export verification evidence. */
  readonly exportHistory: readonly ExportRoundTripEvidence[];
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
  readonly evidence?: readonly EvidenceProvenance[];
  readonly localEvidencePackages?: readonly LocalCaptionEvidencePackage[];
  readonly localAudioDescriptionEvidencePackages?: readonly LocalAudioDescriptionEvidencePackage[];
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
  const itemIds = new Set<string>();
  for (const item of [...(input.captions ?? []), ...(input.audioDescriptions ?? [])]) {
    if (knownIds.has(item.itemId)) throw new RangeError("Project item ids must be unique.");
    knownIds.add(item.itemId);
    itemIds.add(item.itemId);
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
  const evidenceIds = new Set<string>();
  for (const evidence of input.evidence ?? []) {
    if (!evidence.evidenceId.trim() || evidenceIds.has(evidence.evidenceId)) {
      throw new RangeError("Evidence ids must be unique and non-empty.");
    }
    evidenceIds.add(evidence.evidenceId);
    if (evidence.projectId !== input.projectId) {
      throw new RangeError("Evidence must bind to its project.");
    }
    if (!/^[0-9a-f]{64}$/i.test(evidence.mediaSha256)) {
      throw new RangeError("Evidence media hashes must be SHA-256 values.");
    }
    if ((evidence.itemId === null) !== (evidence.itemRevision === null)) {
      throw new RangeError("Evidence item id and revision must be present together.");
    }
    if (evidence.itemId !== null) {
      const itemRevision = evidence.itemRevision;
      if (
        !itemIds.has(evidence.itemId)
        || itemRevision === null
        || !Number.isSafeInteger(itemRevision)
        || itemRevision <= 0
      ) {
        throw new RangeError("Evidence item bindings must identify a project item revision.");
      }
    }
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
      supersededByRunId: null,
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
    evidence: clone(input.evidence ?? []),
    localEvidencePackages: clone(input.localEvidencePackages ?? []),
    localAudioDescriptionEvidencePackages: clone(input.localAudioDescriptionEvidencePackages ?? []),
    captions: { kind: "Captions", order: captionOrder, items: captions },
    audioDescriptions: {
      kind: "AudioDescriptions",
      order: audioDescriptionOrder,
      items: audioDescriptions,
    },
    audioDescriptionRequirements: {},
    audioDescriptionGaps,
    selectedItem: null,
    validation: initialValidation(),
    certification: initialCertification(),
    qualityProfile: {
      profileId: input.profile?.profileId ?? EDUCATION_PROFILE.profileId,
      revision: input.profile?.revision ?? EDUCATION_PROFILE.revision,
      name: input.profile?.name ?? EDUCATION_PROFILE.name,
      rules: clone(input.profile?.rules ?? EDUCATION_PROFILE.rules),
    },
    warningWaivers: {},
    validationRun: null,
    validationHistory: [],
    activeGenerationRun: null,
    certifications: [],
    courtRecord: [],
    exportHistory: [],
  };
};
