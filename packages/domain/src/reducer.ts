import type { Actor, CertificationSnapshot, ReviewState, ValidationSnapshot } from "@cuebench/contracts";
import type { DomainCommand } from "./commands";
import { domainError, type DomainError } from "./errors";
import type {
  AudioDescriptionBeat,
  AudioDescriptionBeatRevision,
  AudioDescriptionGap,
  CaptionCue,
  CaptionCueRevision,
  CaptionProject,
  DomainEvent,
  GenerationLease,
  ItemSelection,
  Selection,
} from "./model";

export interface CommandResult {
  readonly project: CaptionProject;
  readonly events: readonly DomainEvent[];
  readonly error?: DomainError;
}

type CommandSuccess = Omit<CommandResult, "error">;

const fail = (project: CaptionProject, code: DomainError["code"], message: string): CommandResult => ({
  project,
  events: [],
  error: domainError(code, message),
});

const hasHumanAuthority = (actor: Actor) => actor.type === "Human";
const isFiniteInteger = (value: number) => Number.isSafeInteger(value);
const hasValidTime = (project: CaptionProject, startMs: number, endMs: number) =>
  isFiniteInteger(startMs) && isFiniteInteger(endMs) && startMs >= 0 && startMs < endMs && endMs <= project.media.durationMs;

const staleProject = (project: CaptionProject, expected: number) =>
  project.projectRevision !== expected
    ? domainError("STALE_PROJECT", "The project revision is no longer current.")
    : undefined;

const selectFor = (item: CaptionCue | AudioDescriptionBeat): ItemSelection => ({
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  kind: item.kind,
});

const eventFor = (project: CaptionProject, command: DomainCommand, itemId?: string): DomainEvent => ({
  eventId: `${project.projectId}:${project.projectRevision + 1}:${project.courtRecord.length + 1}`,
  projectRevision: project.projectRevision + 1,
  type: command.type === "AppendCourtRecord" ? command.eventType : command.type,
  actor: clone(command.actor),
  ...(itemId === undefined ? {} : { itemId }),
  ...(command.type === "ObjectItem"
      ? { detail: command.reason }
      : {}),
});

const commit = (
  project: CaptionProject,
  command: DomainCommand,
  change: Omit<Partial<CaptionProject>, "projectRevision" | "courtRecord">,
  itemId?: string,
): CommandSuccess => {
  const event = eventFor(project, command, itemId);
  return {
    project: {
      ...project,
      ...change,
      projectRevision: project.projectRevision + 1,
      courtRecord: [...project.courtRecord, event],
    },
    events: [event],
  };
};

const itemAt = (project: CaptionProject, itemId: string): CaptionCue | AudioDescriptionBeat | undefined =>
  project.captions.items[itemId] ?? project.audioDescriptions.items[itemId];

const selectionMatches = (
  selection: Selection | null,
  item: CaptionCue | AudioDescriptionBeat,
  expectedSelectionId: string | undefined,
  expectedItemRevision: number,
) => expectedSelectionId === undefined || (
  selection !== null
  && expectedSelectionId === item.itemId
  && selection.kind === item.kind
  && selection.itemId === expectedSelectionId
  && selection.itemRevision === expectedItemRevision
);

const requireItem = (
  project: CaptionProject,
  command: Extract<DomainCommand, { readonly expectedItemRevision: number }> & { readonly itemId: string },
  expectedKind?: "CaptionCue" | "AudioDescriptionBeat",
): CaptionCue | AudioDescriptionBeat | DomainError => {
  const item = itemAt(project, command.itemId);
  if (item === undefined) return domainError("NOT_FOUND", "The requested item does not exist.");
  if (item.kind === "CaptionCue" && item.mergedIntoItemId !== null) {
    return domainError("STALE_ITEM", "The requested cue has been merged into another cue.");
  }
  if (expectedKind !== undefined && item.kind !== expectedKind) return domainError("INVALID_ARGUMENT", "The command targets the wrong track.");
  if (item.current.itemRevision !== command.expectedItemRevision) return domainError("STALE_ITEM", "The item revision is no longer current.");
  if (!selectionMatches(project.selectedItem, item, command.expectedSelectionId, command.expectedItemRevision)) {
    return domainError("STALE_SELECTION", "The selected item is no longer current.");
  }
  return item;
};

const withStaleArtifacts = (project: CaptionProject): Pick<CaptionProject, "validation" | "certification"> => {
  const validation: ValidationSnapshot = project.validation.status === "NotRun"
    ? project.validation
    : { ...project.validation, status: "Stale" };
  return { validation, ...withStaleCertification(project) };
};

const withStaleCertification = (project: CaptionProject): Pick<CaptionProject, "certification"> => {
  const certification: CertificationSnapshot = project.certification.status === "Current"
    ? { ...project.certification, status: "Stale" }
    : project.certification;
  return { certification };
};

const appendCaptionRevision = (
  item: CaptionCue,
  actor: Actor,
  state: ReviewState,
  cause: string,
  patch: Partial<Pick<CaptionCueRevision, "text" | "speaker" | "startMs" | "endMs">> = {},
): CaptionCue => {
  const current = item.current;
  const revision: CaptionCueRevision = {
    ...current,
    ...patch,
    itemRevision: current.itemRevision + 1,
    state,
    actor: clone(actor),
    cause,
    parentItemRevision: current.itemRevision,
  };
  return { ...item, revisions: [...item.revisions, revision], current: revision };
};

const appendAudioDescriptionRevision = (
  item: AudioDescriptionBeat,
  actor: Actor,
  state: ReviewState,
  cause: string,
  patch: Partial<Pick<AudioDescriptionBeatRevision, "description" | "startMs" | "endMs">> = {},
): AudioDescriptionBeat => {
  const current = item.current;
  const revision: AudioDescriptionBeatRevision = {
    ...current,
    ...patch,
    itemRevision: current.itemRevision + 1,
    state,
    actor: clone(actor),
    cause,
    parentItemRevision: current.itemRevision,
  };
  return { ...item, revisions: [...item.revisions, revision], current: revision };
};

const replaceCaption = (project: CaptionProject, item: CaptionCue): CaptionProject["captions"] => ({
  ...project.captions,
  items: { ...project.captions.items, [item.itemId]: item },
});

const replaceAudioDescription = (project: CaptionProject, item: AudioDescriptionBeat): CaptionProject["audioDescriptions"] => ({
  ...project.audioDescriptions,
  items: { ...project.audioDescriptions.items, [item.itemId]: item },
});

const leased = (project: CaptionProject, track: "Captions" | "AudioDescriptions") =>
  project.activeGenerationRun?.targetTrack === track;

const assertMutable = (
  project: CaptionProject,
  track: "Captions" | "AudioDescriptions",
): DomainError | undefined => leased(project, track)
  ? domainError("TARGET_TRACK_LEASE_CONFLICT", "A generation run currently leases this track.")
  : undefined;

const resolvedItemId = (command: DomainCommand): string | DomainError => {
  const aliases = [
    "itemId" in command ? command.itemId : undefined,
    "cueId" in command ? command.cueId : undefined,
    "beatId" in command ? command.beatId : undefined,
  ].filter((id): id is string => typeof id === "string");
  if (aliases.length === 0) return domainError("INVALID_ARGUMENT", "The command needs an item id.");
  if (new Set(aliases).size !== 1) return domainError("INVALID_ARGUMENT", "Item id aliases must agree.");
  return aliases[0]!;
};

const allCurrentTimesFit = (project: CaptionProject, durationMs: number) =>
  Object.values(project.captions.items).every((item) => hasValidTime({ ...project, media: { ...project.media, durationMs } }, item.current.startMs, item.current.endMs))
  && Object.values(project.audioDescriptions.items).every((item) => hasValidTime({ ...project, media: { ...project.media, durationMs } }, item.current.startMs, item.current.endMs))
  && Object.values(project.audioDescriptionGaps).every((gap) => hasValidTime({ ...project, media: { ...project.media, durationMs } }, gap.startMs, gap.endMs));

const systemCourtRecordEventTypes = new Set([
  "ExportRoundTripVerified",
  "GenerationRunStageChanged",
  "ProjectSerialized",
  "RecoveryPerformed",
  "ValidationMigrated",
]);

const sameBrowserAgent = (actor: Actor, authoredBy: Actor) =>
  actor.type === "BrowserAgent" && authoredBy.type === "BrowserAgent" && actor.id === authoredBy.id;

const clone = <Value>(value: Value): Value => structuredClone(value);

export const applyCommand = (project: CaptionProject, command: DomainCommand): CommandResult => {
  const projectError = staleProject(project, command.expectedProjectRevision);
  if (projectError !== undefined) return { project, events: [], error: projectError };

  if (command.type === "SelectItem" || command.type === "FocusItem") {
    const item = itemAt(project, command.itemId);
    if (item === undefined) return fail(project, "NOT_FOUND", "The requested item does not exist.");
    if (command.expectedItemRevision !== undefined && item.current.itemRevision !== command.expectedItemRevision) {
      return fail(project, "STALE_ITEM", "The item revision is no longer current.");
    }
    return commit(project, command, { selectedItem: selectFor(item) }, item.itemId);
  }

  if (command.type === "FocusGap") {
    const gap = project.audioDescriptionGaps[command.gapId];
    if (gap === undefined) return fail(project, "NOT_FOUND", "The requested gap does not exist.");
    if (gap.state !== "Available" || gap.gapRevision !== command.expectedGapRevision) {
      return fail(project, "STALE_SELECTION", "The requested gap is no longer available.");
    }
    return commit(project, command, {
      selectedItem: {
        itemId: gap.gapId,
        itemRevision: gap.gapRevision,
        kind: "AudioDescriptionGap",
        state: "Available",
      },
    }, command.gapId);
  }

  if (command.type === "StartGenerationRun") {
    if (project.activeGenerationRun !== null) return fail(project, "TARGET_TRACK_LEASE_CONFLICT", "A generation run is already active.");
    if (command.actor.type !== "CueBenchAI") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI starts a generation run.");
    const activeGenerationRun: GenerationLease = { runId: command.runId, targetTrack: command.targetTrack, actor: clone(command.actor) };
    return commit(project, command, { activeGenerationRun });
  }
  if (command.type === "ReleaseGenerationRun") {
    if (project.activeGenerationRun?.runId !== command.runId) return fail(project, "STALE_RUN", "The generation run is no longer active.");
    if (command.actor.type !== "System" && command.actor.type !== "CueBenchAI") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI or System may release a generation run.");
    return commit(project, command, { activeGenerationRun: null });
  }
  if (command.type === "ApplyProfile") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may apply a quality profile.");
    if (project.activeGenerationRun !== null) return fail(project, "TARGET_TRACK_LEASE_CONFLICT", "Profiles cannot change while a generation run is active.");
    if (!command.profileId.trim() || !command.name.trim()) return fail(project, "INVALID_ARGUMENT", "A profile id and name are required.");
    return commit(project, command, {
      qualityProfile: { profileId: command.profileId, revision: project.qualityProfile.revision + 1, name: command.name, rules: clone(command.rules) },
      ...withStaleArtifacts(project),
    });
  }
  if (command.type === "RelinkMedia") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may relink media.");
    if (project.activeGenerationRun !== null) return fail(project, "TARGET_TRACK_LEASE_CONFLICT", "Media cannot change while a generation run is active.");
    if (!isFiniteInteger(command.media.durationMs) || command.media.durationMs < 0) return fail(project, "INVALID_ARGUMENT", "Media duration must be a non-negative integer.");
    if (!allCurrentTimesFit(project, command.media.durationMs)) return fail(project, "INVALID_ARGUMENT", "Media duration must contain every current item.");
    return commit(project, command, { media: { ...clone(command.media), relinkState: "Linked" }, ...withStaleArtifacts(project) });
  }
  if (command.type === "WaiveWarning") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may waive a warning.");
    if (!command.findingId.trim() || !command.reason.trim()) return fail(project, "INVALID_ARGUMENT", "A warning waiver needs a finding and reason.");
    return commit(project, command, { warningWaivers: { ...project.warningWaivers, [command.findingId]: { findingId: command.findingId, reason: command.reason, actor: clone(command.actor), projectRevision: project.projectRevision + 1 } }, ...withStaleCertification(project) });
  }
  if (command.type === "AppendCourtRecord") {
    if (command.actor.type !== "System" || command.deterministic !== true) {
      return fail(project, "INVALID_ARGUMENT", "Only System may append a deterministic Court Record event.");
    }
    if (!systemCourtRecordEventTypes.has(command.eventType)) {
      return fail(project, "INVALID_ARGUMENT", "System Court Record event types must be deterministic application events.");
    }
    if (command.itemId !== undefined && itemAt(project, command.itemId) === undefined) {
      return fail(project, "NOT_FOUND", "The Court Record item reference does not exist.");
    }
    return commit(project, command, {}, command.itemId);
  }
  if (command.type === "ProposeAudioDescriptionInGap") {
    const leaseError = assertMutable(project, "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    const gap = project.audioDescriptionGaps[command.gapId];
    const selected = project.selectedItem;
    if (
      gap === undefined
      || gap.state !== "Available"
      || command.expectedSelectionId !== command.gapId
      || command.expectedGapRevision !== gap.gapRevision
      || selected === null
      || selected.kind !== "AudioDescriptionGap"
      || selected.state !== "Available"
      || selected.itemId !== command.gapId
      || selected.itemRevision !== gap.gapRevision
    ) return fail(project, "STALE_SELECTION", "The selected gap is no longer current.");
    if (itemAt(project, command.beatId) !== undefined || project.audioDescriptionGaps[command.beatId] !== undefined) return fail(project, "INVALID_ARGUMENT", "The proposed beat id already exists.");
    if (!hasValidTime(project, command.startMs, command.endMs) || !command.description.trim()) return fail(project, "INVALID_ARGUMENT", "The proposed beat needs valid timing and description.");
    if (command.startMs < gap.startMs || command.endMs > gap.endMs) return fail(project, "INVALID_ARGUMENT", "The proposed beat must fit inside the selected gap.");
    if (command.actor.type === "System") return fail(project, "INVALID_ARGUMENT", "System cannot author semantic work.");
    const current: AudioDescriptionBeatRevision = { kind: "AudioDescriptionBeat", itemId: command.beatId, itemRevision: 1, state: "Proposed", startMs: command.startMs, endMs: command.endMs, description: command.description, actor: clone(command.actor), cause: "ProposeAudioDescriptionInGap", parentItemRevision: null };
    const item: AudioDescriptionBeat = { itemId: command.beatId, kind: "AudioDescriptionBeat", revisions: [current], current };
    const consumedGap: AudioDescriptionGap = { ...gap, gapRevision: gap.gapRevision + 1, state: "Consumed" };
    return commit(project, command, { audioDescriptions: { ...project.audioDescriptions, order: [...project.audioDescriptions.order, item.itemId], items: { ...project.audioDescriptions.items, [item.itemId]: item } }, audioDescriptionGaps: { ...project.audioDescriptionGaps, [gap.gapId]: consumedGap }, selectedItem: selectFor(item), ...withStaleArtifacts(project) }, item.itemId);
  }

  const rawItemId = resolvedItemId(command);
  if (typeof rawItemId !== "string") return { project, events: [], error: rawItemId };
  const expectedItemCommand = { ...command, itemId: rawItemId } as Extract<DomainCommand, { readonly expectedItemRevision: number }> & { readonly itemId: string };
  const item = requireItem(project, expectedItemCommand);
  if ("code" in item) return { project, events: [], error: item };

  if (command.type === "MarkItemAgentReady") {
    const leaseError = assertMutable(project, item.kind === "CaptionCue" ? "Captions" : "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (!sameBrowserAgent(command.actor, item.current.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only the Browser Agent that authored this revision may mark it Agent Ready.");
    if (item.current.state !== "Proposed") return fail(project, "INVALID_ARGUMENT", "Only Proposed work may be marked Agent Ready.");
    if (item.kind === "CaptionCue") {
      const revised = appendCaptionRevision(item, command.actor, "AgentReady", command.type);
      return commit(project, command, { captions: replaceCaption(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
    }
    const revised = appendAudioDescriptionRevision(item, command.actor, "AgentReady", command.type);
    return commit(project, command, { audioDescriptions: replaceAudioDescription(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
  }
  if (command.type === "ObjectItem" || command.type === "SustainItem") {
    const leaseError = assertMutable(project, item.kind === "CaptionCue" ? "Captions" : "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may issue a ruling.");
    if (command.type === "ObjectItem" && !command.reason.trim()) return fail(project, "INVALID_ARGUMENT", "An objection requires a reason.");
    const state: ReviewState = command.type === "ObjectItem" ? "Objected" : "Sustained";
    const cause = command.type === "ObjectItem" ? command.reason : command.type;
    if (item.kind === "CaptionCue") {
      const revised = appendCaptionRevision(item, command.actor, state, cause);
      return commit(project, command, { captions: replaceCaption(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
    }
    const revised = appendAudioDescriptionRevision(item, command.actor, state, cause);
    return commit(project, command, { audioDescriptions: replaceAudioDescription(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
  }

  if (command.type === "AdjustCueTiming" || command.type === "ReviseCue" || command.type === "SplitCue" || command.type === "MergeCue") {
    if (item.kind !== "CaptionCue") return fail(project, "INVALID_ARGUMENT", "The command targets the wrong track.");
    const leaseError = assertMutable(project, "Captions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (command.actor.type === "System") return fail(project, "INVALID_ARGUMENT", "System cannot author semantic work.");
    if (command.type === "SplitCue") {
      if (command.cueId !== item.itemId || itemAt(project, command.newCueId) !== undefined || project.audioDescriptionGaps[command.newCueId] !== undefined || !isFiniteInteger(command.splitMs) || command.splitMs <= item.current.startMs || command.splitMs >= item.current.endMs) return fail(project, "INVALID_ARGUMENT", "A split must create a new id inside the current cue.");
      const left = appendCaptionRevision(item, command.actor, "Proposed", command.type, { endMs: command.splitMs });
      const rightCurrent: CaptionCueRevision = { ...item.current, itemId: command.newCueId, itemRevision: 1, state: "Proposed", startMs: command.splitMs, actor: clone(command.actor), cause: command.type, parentItemRevision: null };
      const right: CaptionCue = { itemId: command.newCueId, kind: "CaptionCue", revisions: [rightCurrent], current: rightCurrent, mergedIntoItemId: null };
      const index = project.captions.order.indexOf(item.itemId);
      const order = [...project.captions.order]; order.splice(index + 1, 0, right.itemId);
      return commit(project, command, { captions: { ...project.captions, order, items: { ...project.captions.items, [left.itemId]: left, [right.itemId]: right } }, selectedItem: selectFor(left), ...withStaleArtifacts(project) }, item.itemId);
    }
    if (command.type === "MergeCue") {
      if (command.cueId !== item.itemId) return fail(project, "INVALID_ARGUMENT", "The merge cue must be the selected cue.");
      const right = project.captions.items[command.adjacentCueId];
      const currentIndex = project.captions.order.indexOf(item.itemId);
      if (
        right === undefined
        || right.mergedIntoItemId !== null
        || project.captions.order[currentIndex + 1] !== right.itemId
        || right.current.itemRevision !== command.expectedAdjacentItemRevision
      ) return fail(project, right !== undefined && right.current.itemRevision !== command.expectedAdjacentItemRevision ? "STALE_ITEM" : "INVALID_ARGUMENT", "Cues may merge only with their current adjacent successor.");
      if (
        !hasValidTime(project, item.current.startMs, item.current.endMs)
        || !hasValidTime(project, right.current.startMs, right.current.endMs)
      ) return fail(project, "INVALID_ARGUMENT", "Each source cue must have valid timing before merge.");
      if (right.current.state === "Sustained" && !hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may alter Sustained work.");
      if (right.current.startMs < item.current.startMs) return fail(project, "INVALID_ARGUMENT", "Merged cues must remain in chronological order.");
      const mergedEndMs = Math.max(item.current.endMs, right.current.endMs);
      if (!hasValidTime(project, item.current.startMs, mergedEndMs)) return fail(project, "INVALID_ARGUMENT", "Merged cue timing must remain within media bounds.");
      const merged = appendCaptionRevision(item, command.actor, "Proposed", command.type, { endMs: mergedEndMs, text: `${item.current.text} ${right.current.text}`.trim() });
      const mergedRight: CaptionCue = {
        ...appendCaptionRevision(right, command.actor, "Proposed", `MergedInto:${item.itemId}`),
        mergedIntoItemId: item.itemId,
      };
      return commit(project, command, { captions: { ...project.captions, order: project.captions.order.filter((id) => id !== right.itemId), items: { ...project.captions.items, [merged.itemId]: merged, [mergedRight.itemId]: mergedRight } }, selectedItem: selectFor(merged), ...withStaleArtifacts(project) }, item.itemId);
    }
    const patch = command.type === "ReviseCue"
      ? command.patch
      : {
          startMs: command.startMs ?? item.current.startMs + (command.startDeltaMs ?? 0),
          endMs: command.endMs ?? item.current.endMs + (command.endDeltaMs ?? 0),
        };
    if (command.type === "ReviseCue" && command.cueId !== item.itemId) return fail(project, "INVALID_ARGUMENT", "The revision targets the wrong cue.");
    const startMs = patch.startMs ?? item.current.startMs;
    const endMs = patch.endMs ?? item.current.endMs;
    if (!hasValidTime(project, startMs, endMs) || (patch.text !== undefined && !patch.text.trim())) return fail(project, "INVALID_ARGUMENT", "Cue timing and text must be valid.");
    const revised = appendCaptionRevision(item, command.actor, "Proposed", command.type, patch);
    return commit(project, command, { captions: replaceCaption(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
  }

  if (command.type === "AdjustAudioDescriptionTiming" || command.type === "ReviseAudioDescription") {
    if (item.kind !== "AudioDescriptionBeat") return fail(project, "INVALID_ARGUMENT", "The command targets the wrong track.");
    const leaseError = assertMutable(project, "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (command.actor.type === "System") return fail(project, "INVALID_ARGUMENT", "System cannot author semantic work.");
    if (command.type === "ReviseAudioDescription" && command.beatId !== undefined && command.beatId !== item.itemId) return fail(project, "INVALID_ARGUMENT", "The revision targets the wrong beat.");
    const patch = command.type === "ReviseAudioDescription"
      ? command.patch
      : {
          startMs: command.startMs ?? item.current.startMs + (command.startDeltaMs ?? 0),
          endMs: command.endMs ?? item.current.endMs + (command.endDeltaMs ?? 0),
        };
    const startMs = patch.startMs ?? item.current.startMs;
    const endMs = patch.endMs ?? item.current.endMs;
    if (!hasValidTime(project, startMs, endMs) || (patch.description !== undefined && !patch.description.trim())) return fail(project, "INVALID_ARGUMENT", "Beat timing and description must be valid.");
    const revised = appendAudioDescriptionRevision(item, command.actor, "Proposed", command.type, patch);
    return commit(project, command, { audioDescriptions: replaceAudioDescription(project, revised), selectedItem: selectFor(revised), ...withStaleArtifacts(project) }, item.itemId);
  }

  return fail(project, "INVALID_ARGUMENT", "Unsupported domain command.");
};
