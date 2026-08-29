import type { Actor, CertificationSnapshot, ReviewState, ValidationSnapshot } from "@cuebench/contracts";
import type { DomainCommand } from "./commands";
import { domainError, type DomainError } from "./errors";
import type {
  AudioDescriptionBeat,
  AudioDescriptionBeatRevision,
  CaptionCue,
  CaptionCueRevision,
  CaptionProject,
  DomainEvent,
  GenerationLease,
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

const selectFor = (item: CaptionCue | AudioDescriptionBeat): Selection => ({
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  kind: item.kind,
});

const eventFor = (project: CaptionProject, command: DomainCommand, itemId?: string): DomainEvent => ({
  eventId: `${project.projectId}:${project.projectRevision + 1}:${project.courtRecord.length + 1}`,
  projectRevision: project.projectRevision + 1,
  type: command.type === "AppendCourtRecord" ? command.eventType : command.type,
  actor: command.actor,
  ...(itemId === undefined ? {} : { itemId }),
  ...(command.type === "AppendCourtRecord" && command.detail !== undefined
    ? { detail: command.detail }
    : command.type === "ObjectItem"
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

const requireItem = (
  project: CaptionProject,
  command: Extract<DomainCommand, { readonly expectedItemRevision: number }> & { readonly itemId: string },
  expectedKind?: "CaptionCue" | "AudioDescriptionBeat",
): CaptionCue | AudioDescriptionBeat | DomainError => {
  const item = itemAt(project, command.itemId);
  if (item === undefined) return domainError("NOT_FOUND", "The requested item does not exist.");
  if (expectedKind !== undefined && item.kind !== expectedKind) return domainError("INVALID_ARGUMENT", "The command targets the wrong track.");
  if (item.current.itemRevision !== command.expectedItemRevision) return domainError("STALE_ITEM", "The item revision is no longer current.");
  if (command.expectedSelectionId !== undefined && project.selectedItem?.itemId !== command.expectedSelectionId) {
    return domainError("STALE_SELECTION", "The selected item is no longer current.");
  }
  return item;
};

const withStaleArtifacts = (project: CaptionProject): Pick<CaptionProject, "validation" | "certification"> => {
  const validation: ValidationSnapshot = project.validation.status === "NotRun"
    ? project.validation
    : { ...project.validation, status: "Stale" };
  const certification: CertificationSnapshot = project.certification.status === "Current"
    ? { ...project.certification, status: "Stale" }
    : project.certification;
  return { validation, certification };
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
    actor,
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
    actor,
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

const itemCommandId = (command: DomainCommand): string | undefined => {
  if ("itemId" in command && typeof command.itemId === "string") return command.itemId;
  if ("cueId" in command && typeof command.cueId === "string") return command.cueId;
  if ("beatId" in command && typeof command.beatId === "string") return command.beatId;
  return undefined;
};

const sameBrowserAgent = (actor: Actor, authoredBy: Actor) =>
  actor.type === "BrowserAgent" && authoredBy.type === "BrowserAgent" && actor.id === authoredBy.id;

export const applyCommand = (project: CaptionProject, command: DomainCommand): CommandResult => {
  const projectError = staleProject(project, command.expectedProjectRevision);
  if (projectError !== undefined) return { project, events: [], error: projectError };

  const rawItemId = itemCommandId(command);
  if (command.type === "SelectItem" || command.type === "FocusItem") {
    const item = itemAt(project, command.itemId);
    if (item === undefined) return fail(project, "NOT_FOUND", "The requested item does not exist.");
    if (command.expectedItemRevision !== undefined && item.current.itemRevision !== command.expectedItemRevision) {
      return fail(project, "STALE_ITEM", "The item revision is no longer current.");
    }
    return commit(project, command, { selectedItem: selectFor(item) }, item.itemId);
  }

  if (command.type === "StartGenerationRun") {
    if (project.activeGenerationRun !== null) return fail(project, "TARGET_TRACK_LEASE_CONFLICT", "A generation run is already active.");
    if (command.actor.type !== "CueBenchAI") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI starts a generation run.");
    const activeGenerationRun: GenerationLease = { runId: command.runId, targetTrack: command.targetTrack, actor: command.actor };
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
      qualityProfile: { profileId: command.profileId, revision: project.qualityProfile.revision + 1, name: command.name, rules: command.rules },
      ...withStaleArtifacts(project),
    });
  }
  if (command.type === "RelinkMedia") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may relink media.");
    if (project.activeGenerationRun !== null) return fail(project, "TARGET_TRACK_LEASE_CONFLICT", "Media cannot change while a generation run is active.");
    if (!isFiniteInteger(command.media.durationMs) || command.media.durationMs < 0) return fail(project, "INVALID_ARGUMENT", "Media duration must be a non-negative integer.");
    return commit(project, command, { media: { ...command.media, relinkState: "Linked" }, ...withStaleArtifacts(project) });
  }
  if (command.type === "WaiveWarning") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may waive a warning.");
    if (!command.findingId.trim() || !command.reason.trim()) return fail(project, "INVALID_ARGUMENT", "A warning waiver needs a finding and reason.");
    return commit(project, command, { warningWaivers: { ...project.warningWaivers, [command.findingId]: { findingId: command.findingId, reason: command.reason, actor: command.actor, projectRevision: project.projectRevision + 1 } } });
  }
  if (command.type === "AppendCourtRecord") {
    if (command.actor.type === "System" && command.deterministic !== true) return fail(project, "INVALID_ARGUMENT", "System Court Record events must be deterministic.");
    return commit(project, command, {}, command.itemId);
  }
  if (command.type === "ProposeAudioDescriptionInGap") {
    const leaseError = assertMutable(project, "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (command.expectedSelectionId !== undefined && project.selectedItem?.itemId !== command.expectedSelectionId) return fail(project, "STALE_SELECTION", "The selected gap is no longer current.");
    if (project.audioDescriptions.items[command.beatId] !== undefined) return fail(project, "INVALID_ARGUMENT", "The proposed beat id already exists.");
    if (!hasValidTime(project, command.startMs, command.endMs) || !command.description.trim()) return fail(project, "INVALID_ARGUMENT", "The proposed beat needs valid timing and description.");
    if (command.actor.type === "System") return fail(project, "INVALID_ARGUMENT", "System cannot author semantic work.");
    const current: AudioDescriptionBeatRevision = { kind: "AudioDescriptionBeat", itemId: command.beatId, itemRevision: 1, state: "Proposed", startMs: command.startMs, endMs: command.endMs, description: command.description, actor: command.actor, cause: "ProposeAudioDescriptionInGap", parentItemRevision: null };
    const item: AudioDescriptionBeat = { itemId: command.beatId, kind: "AudioDescriptionBeat", revisions: [current], current };
    return commit(project, command, { audioDescriptions: { ...project.audioDescriptions, order: [...project.audioDescriptions.order, item.itemId], items: { ...project.audioDescriptions.items, [item.itemId]: item } }, selectedItem: selectFor(item), ...withStaleArtifacts(project) }, item.itemId);
  }

  if (rawItemId === undefined) return fail(project, "INVALID_ARGUMENT", "The command needs an item id.");
  const expectedItemCommand = { ...command, itemId: rawItemId } as Extract<DomainCommand, { readonly expectedItemRevision: number }> & { readonly itemId: string };
  const item = requireItem(project, expectedItemCommand);
  if ("code" in item) return { project, events: [], error: item };

  if (command.type === "MarkItemAgentReady") {
    if (!sameBrowserAgent(command.actor, item.current.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only the Browser Agent that authored this revision may mark it Agent Ready.");
    if (item.current.state !== "Proposed") return fail(project, "INVALID_ARGUMENT", "Only Proposed work may be marked Agent Ready.");
    if (item.kind === "CaptionCue") return commit(project, command, { captions: replaceCaption(project, appendCaptionRevision(item, command.actor, "AgentReady", command.type)) }, item.itemId);
    return commit(project, command, { audioDescriptions: replaceAudioDescription(project, appendAudioDescriptionRevision(item, command.actor, "AgentReady", command.type)) }, item.itemId);
  }
  if (command.type === "ObjectItem" || command.type === "SustainItem") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may issue a ruling.");
    if (command.type === "ObjectItem" && !command.reason.trim()) return fail(project, "INVALID_ARGUMENT", "An objection requires a reason.");
    const state: ReviewState = command.type === "ObjectItem" ? "Objected" : "Sustained";
    const cause = command.type === "ObjectItem" ? command.reason : command.type;
    if (item.kind === "CaptionCue") return commit(project, command, { captions: replaceCaption(project, appendCaptionRevision(item, command.actor, state, cause)) }, item.itemId);
    return commit(project, command, { audioDescriptions: replaceAudioDescription(project, appendAudioDescriptionRevision(item, command.actor, state, cause)) }, item.itemId);
  }

  if (command.type === "AdjustCueTiming" || command.type === "ReviseCue" || command.type === "SplitCue" || command.type === "MergeCue") {
    if (item.kind !== "CaptionCue") return fail(project, "INVALID_ARGUMENT", "The command targets the wrong track.");
    const leaseError = assertMutable(project, "Captions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (command.actor.type === "System") return fail(project, "INVALID_ARGUMENT", "System cannot author semantic work.");
    if (command.type === "SplitCue") {
      if (command.cueId !== item.itemId || project.captions.items[command.newCueId] !== undefined || !isFiniteInteger(command.splitMs) || command.splitMs <= item.current.startMs || command.splitMs >= item.current.endMs) return fail(project, "INVALID_ARGUMENT", "A split must create a new id inside the current cue.");
      const left = appendCaptionRevision(item, command.actor, "Proposed", command.type, { endMs: command.splitMs });
      const rightCurrent: CaptionCueRevision = { ...item.current, itemId: command.newCueId, itemRevision: 1, state: "Proposed", startMs: command.splitMs, actor: command.actor, cause: command.type, parentItemRevision: null };
      const right: CaptionCue = { itemId: command.newCueId, kind: "CaptionCue", revisions: [rightCurrent], current: rightCurrent };
      const index = project.captions.order.indexOf(item.itemId);
      const order = [...project.captions.order]; order.splice(index + 1, 0, right.itemId);
      return commit(project, command, { captions: { ...project.captions, order, items: { ...project.captions.items, [left.itemId]: left, [right.itemId]: right } }, selectedItem: selectFor(left), ...withStaleArtifacts(project) }, item.itemId);
    }
    if (command.type === "MergeCue") {
      if (command.cueId !== item.itemId) return fail(project, "INVALID_ARGUMENT", "The merge cue must be the selected cue.");
      const right = project.captions.items[command.adjacentCueId];
      const currentIndex = project.captions.order.indexOf(item.itemId);
      if (right === undefined || project.captions.order[currentIndex + 1] !== right.itemId) return fail(project, "INVALID_ARGUMENT", "Cues may merge only with their adjacent successor.");
      if (right.current.state === "Sustained" && !hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may alter Sustained work.");
      const merged = appendCaptionRevision(item, command.actor, "Proposed", command.type, { endMs: right.current.endMs, text: `${item.current.text} ${right.current.text}`.trim() });
      const items = { ...project.captions.items };
      delete items[right.itemId];
      return commit(project, command, { captions: { ...project.captions, order: project.captions.order.filter((id) => id !== right.itemId), items: { ...items, [merged.itemId]: merged } }, selectedItem: selectFor(merged), ...withStaleArtifacts(project) }, item.itemId);
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
    if (command.type === "ReviseAudioDescription" && command.beatId !== item.itemId) return fail(project, "INVALID_ARGUMENT", "The revision targets the wrong beat.");
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
