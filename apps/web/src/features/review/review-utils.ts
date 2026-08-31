import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  CommandResult,
  DomainEvent,
  DomainCommand,
  EvidenceProvenance,
  QualityFinding,
} from "@cuebench/domain";
import type { Actor } from "@cuebench/contracts";

export type ReviewableItem = CaptionCue | AudioDescriptionBeat;
/** Runtime adapters can fail closed with null; callers must never treat that as success. */
export type ReviewCommandExecutor = (command: DomainCommand) => CommandResult | null | Promise<CommandResult | null>;

export const humanReviewActor: Actor = { type: "Human", id: "human" };

export interface ReviewDraft {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly prose: string;
  readonly speaker: string;
  readonly startMs: string;
  readonly endMs: string;
  /** Caption-only operation state. Generated defaults are clean; a visible change is a draft. */
  readonly splitMs: string;
  readonly newCueId: string;
}

export interface ReviewDraftValidity {
  readonly proseError: string | null;
  readonly timingError: string | null;
  readonly splitError: string | null;
}

export interface ReviewIndexes {
  readonly evidenceByItem: ReadonlyMap<string, readonly EvidenceProvenance[]>;
  readonly findingsByItem: ReadonlyMap<string, readonly QualityFinding[]>;
  readonly projectFindings: readonly QualityFinding[];
}

export const orderedReviewItems = (project: CaptionProject): readonly ReviewableItem[] => [
  ...project.captions.order.flatMap((itemId) => {
    const item = project.captions.items[itemId];
    return item === undefined || item.mergedIntoItemId !== null ? [] : [item];
  }),
  ...project.audioDescriptions.order.flatMap((itemId) => {
    const item = project.audioDescriptions.items[itemId];
    return item === undefined ? [] : [item];
  }),
];

export const reviewItemForId = (project: CaptionProject, itemId: string): ReviewableItem | null => (
  project.captions.items[itemId] ?? project.audioDescriptions.items[itemId] ?? null
);

export const itemTypeLabel = (item: ReviewableItem): string => (
  item.kind === "CaptionCue" ? "Caption" : "Audio description"
);

export const itemAccessibleLabel = (item: ReviewableItem): string => `${itemTypeLabel(item)} ${item.itemId.toUpperCase()}`;

export const itemProse = (item: ReviewableItem): string => (
  item.kind === "CaptionCue" ? item.current.text : item.current.description
);

const splitDraftDefaults = (item: ReviewableItem): Pick<ReviewDraft, "splitMs" | "newCueId"> => (
  item.kind === "CaptionCue"
    ? {
        splitMs: String(Math.floor((item.current.startMs + item.current.endMs) / 2)),
        newCueId: `${item.itemId}-split-r${item.current.itemRevision + 1}`,
      }
    : { splitMs: "", newCueId: "" }
);

export const reviewDraftForItem = (item: ReviewableItem): ReviewDraft => ({
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  prose: itemProse(item),
  speaker: item.kind === "CaptionCue" ? item.current.speaker ?? "" : "",
  startMs: String(item.current.startMs),
  endMs: String(item.current.endMs),
  ...splitDraftDefaults(item),
});

export const integerValue = (value: string): number | null => {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Text, speaker, and timing form fields which can be saved as one revision. */
export const reviewDraftHasContentChanges = (item: ReviewableItem | null, draft: ReviewDraft | null): boolean => {
  if (item === null || draft === null || draft.itemId !== item.itemId) return false;
  return draft.prose !== itemProse(item)
    || (item.kind === "CaptionCue" && draft.speaker !== (item.current.speaker ?? ""))
    || draft.startMs !== String(item.current.startMs)
    || draft.endMs !== String(item.current.endMs);
};

/**
 * A split form starts with generated values. They are deliberately not dirty
 * until a person changes one of the visible operation fields. This keeps a
 * clean caption editable while still preventing a changed split from being
 * silently abandoned by navigation or a human ruling.
 */
export const reviewDraftHasStructuralChanges = (item: ReviewableItem | null, draft: ReviewDraft | null): boolean => {
  if (item === null || draft === null || draft.itemId !== item.itemId || item.kind !== "CaptionCue") return false;
  const defaults = splitDraftDefaults(item);
  return draft.splitMs !== defaults.splitMs || draft.newCueId !== defaults.newCueId;
};

export const reviewDraftIsDirty = (item: ReviewableItem | null, draft: ReviewDraft | null): boolean => {
  if (item === null || draft === null || draft.itemId !== item.itemId) return false;
  // A draft whose base revision changed must be resolved explicitly; treating
  // it as clean would silently replace visible, user-authored content.
  if (draft.itemRevision !== item.current.itemRevision) return true;
  return reviewDraftHasContentChanges(item, draft) || reviewDraftHasStructuralChanges(item, draft);
};

/** Checks a draft against an immutable revision, including generated split defaults. */
export const reviewDraftIsCleanForRevision = (
  draft: ReviewDraft | null,
  item: ReviewableItem,
  revision: ReviewableItem["current"],
): boolean => {
  if (draft === null || draft.itemId !== item.itemId || draft.itemRevision !== revision.itemRevision) return false;
  const revisionItem: ReviewableItem = item.kind === "CaptionCue"
    ? { ...item, current: revision as typeof item.current }
    : { ...item, current: revision as typeof item.current };
  const defaults = splitDraftDefaults(revisionItem);
  return draft.prose === (revision.kind === "CaptionCue" ? revision.text : revision.description)
    && (revision.kind !== "CaptionCue" || draft.speaker === (revision.speaker ?? ""))
    && draft.startMs === String(revision.startMs)
    && draft.endMs === String(revision.endMs)
    && draft.splitMs === defaults.splitMs
    && draft.newCueId === defaults.newCueId;
};

export const reviewDraftValidity = (project: CaptionProject, item: ReviewableItem, draft: ReviewDraft): ReviewDraftValidity => {
  const startMs = integerValue(draft.startMs);
  const endMs = integerValue(draft.endMs);
  const proseError = draft.prose.trim().length > 0 ? null : `${itemTypeLabel(item)} text is required before saving.`;
  const timingError = startMs === null || endMs === null
    ? "Start and end times must be whole milliseconds."
    : startMs < 0 || endMs > project.media.durationMs
      ? `Times must remain inside the 0–${project.media.durationMs} ms source range.`
      : startMs >= endMs
        ? "Start time must be earlier than end time."
        : null;
  const splitMs = integerValue(draft.splitMs);
  const splitError = item.kind !== "CaptionCue"
    ? null
    : splitMs === null
      ? "Split point must be a whole millisecond."
      : splitMs <= item.current.startMs || splitMs >= item.current.endMs
        ? `Split point must be after ${item.current.startMs} ms and before ${item.current.endMs} ms.`
        : draft.newCueId.trim().length === 0
          ? "A new caption identifier is required for the split."
          : reviewItemForId(project, draft.newCueId.trim()) !== null
            ? "The new caption identifier already exists in this project."
            : null;
  return { proseError, timingError, splitError };
};

export const semanticRevisionCommand = (
  project: CaptionProject,
  item: ReviewableItem,
  draft: ReviewDraft,
): DomainCommand | null => {
  if (!reviewDraftHasContentChanges(item, draft)) return null;
  const validity = reviewDraftValidity(project, item, draft);
  const startMs = integerValue(draft.startMs);
  const endMs = integerValue(draft.endMs);
  if (validity.proseError !== null || validity.timingError !== null || startMs === null || endMs === null) return null;
  if (item.kind === "CaptionCue") {
    return {
      type: "ReviseCue",
      actor: humanReviewActor,
      itemId: item.itemId,
      cueId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
      patch: {
        text: draft.prose.trim(),
        speaker: draft.speaker.trim() || null,
        startMs,
        endMs,
      },
    };
  }
  return {
    type: "ReviseAudioDescription",
    actor: humanReviewActor,
    itemId: item.itemId,
    beatId: item.itemId,
    expectedItemRevision: item.current.itemRevision,
    expectedProjectRevision: project.projectRevision,
    patch: { description: draft.prose.trim(), startMs, endMs },
  };
};

export const reviewStateLabel = (state: ReviewableItem["current"]["state"]): string => (
  state === "AgentReady" ? "Agent Ready" : state
);

export const actorLabel = (actor: Actor): string => {
  const type = actor.type === "CueBenchAI"
    ? "CueBench AI"
    : actor.type === "BrowserAgent"
      ? "Browser Agent"
      : actor.type;
  return `${type} · ${actor.id}`;
};

export const evidenceAnchorId = (evidenceId: string): string => `evidence-${encodeURIComponent(evidenceId)}`;

export const revisionFocusId = (itemId: string, itemRevision: number): string => (
  `revision-${encodeURIComponent(itemId)}-${itemRevision}`
);

export const findingTargetsItem = (finding: QualityFinding, item: ReviewableItem): boolean => {
  if (finding.target.type === "item") return finding.target.itemId === item.itemId;
  if (finding.target.type === "pair") {
    return finding.target.first.itemId === item.itemId || finding.target.second.itemId === item.itemId;
  }
  return false;
};

const appendIndexed = <Value,>(index: Map<string, Value[]>, key: string, value: Value) => {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
};

/** Builds O(n+m) lookup tables for long dockets and focused evidence views. */
export const indexReviewData = (project: CaptionProject): ReviewIndexes => {
  const evidenceByItem = new Map<string, EvidenceProvenance[]>();
  for (const evidence of project.evidence) {
    if (evidence.itemId !== null) appendIndexed(evidenceByItem, evidence.itemId, evidence);
  }
  const findingsByItem = new Map<string, QualityFinding[]>();
  const projectFindings: QualityFinding[] = [];
  for (const finding of project.validationRun?.findings ?? []) {
    if (finding.target.type === "project") {
      projectFindings.push(finding);
      continue;
    }
    if (finding.target.type === "item") {
      appendIndexed(findingsByItem, finding.target.itemId, finding);
      continue;
    }
    if (finding.target.type === "extended-description-requirement") {
      // An EDR is a deterministic project-level review obligation with links
      // to retained visual evidence, not a claim about one editable beat.
      projectFindings.push(finding);
      continue;
    }
    appendIndexed(findingsByItem, finding.target.first.itemId, finding);
    if (finding.target.second.itemId !== finding.target.first.itemId) {
      appendIndexed(findingsByItem, finding.target.second.itemId, finding);
    }
  }
  return { evidenceByItem, findingsByItem, projectFindings };
};

export const evidenceForItem = (indexes: ReviewIndexes, itemId: string): readonly EvidenceProvenance[] => (
  indexes.evidenceByItem.get(itemId) ?? []
);

export const findingsForItem = (indexes: ReviewIndexes, itemId: string): readonly QualityFinding[] => (
  indexes.findingsByItem.get(itemId) ?? []
);

export const primaryFindingItemId = (finding: QualityFinding): string | null => {
  if (finding.target.type === "item") return finding.target.itemId;
  if (finding.target.type === "pair") return finding.target.first.itemId;
  return null;
};

export const eventLabel = (type: string): string => {
  const labels: Readonly<Record<string, string>> = {
    SelectItem: "Selected item",
    FocusItem: "Focused item",
    AdjustCueTiming: "Adjusted caption timing",
    AdjustAudioDescriptionTiming: "Adjusted audio-description timing",
    SplitCue: "Split caption",
    MergeCue: "Merged captions",
    ReviseCue: "Revised caption",
    ReviseAudioDescription: "Revised audio description",
    ObjectItem: "Objected to item",
    SustainItem: "Sustain item",
    MarkItemAgentReady: "Marked item Agent Ready",
    ValidateProject: "Validated project",
    ApplyProfile: "Applied quality profile",
    CertifyProject: "Certified project",
    WaiveWarning: "Waived warning",
  };
  return labels[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const sameActor = (left: Actor, right: Actor): boolean => left.type === right.type && left.id === right.id;

const revisionMatchesCourtEvent = (event: DomainEvent, revision: ReviewableItem["current"]): boolean => {
  if (!sameActor(event.actor, revision.actor)) return false;
  if (event.type === "ObjectItem") return event.detail !== undefined && revision.cause === event.detail;
  return revision.cause === event.type;
};

/**
 * Events do not persist an item-revision field. Where their immutable actor,
 * cause, target, and occurrence sequence make a single history entry
 * derivable, return it; otherwise callers must honestly leave it unresolved.
 */
export const courtRecordRevisionForEvent = (project: CaptionProject, event: DomainEvent): number | null => {
  if (event.itemId === undefined) return null;
  const item = reviewItemForId(project, event.itemId);
  if (item === null) return null;
  const eventIndex = project.courtRecord.findIndex((candidate) => candidate.eventId === event.eventId);
  if (eventIndex < 0) return null;
  const occurrences = project.courtRecord.slice(0, eventIndex + 1).filter((candidate) => (
    candidate.itemId === event.itemId
    && candidate.type === event.type
    && sameActor(candidate.actor, event.actor)
    && candidate.detail === event.detail
  ));
  const revisions = item.revisions.filter((revision) => revisionMatchesCourtEvent(event, revision));
  const revision = revisions[occurrences.length - 1];
  return revision?.itemRevision ?? null;
};
