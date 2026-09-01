import {
  countJsonNodes,
  MAX_LOCAL_CAPTION_CUES,
  MAX_LOCAL_AUDIO_DESCRIPTION_EVIDENCE_PACKAGES,
  MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_WORDS,
  MAX_LOCAL_CAPTION_EVIDENCE_WORDS,
  MAX_PORTABLE_PROJECT_JSON_NODES,
  isVerificationPackageId,
  type Actor,
  type CaptionEvidenceWord,
  type CertificationSnapshot,
  type LocalCaptionEvidencePackage,
  type LocalAudioDescriptionEvidencePackage,
  type ReviewState,
  type StagedCaptionCue,
  type ValidationSnapshot,
} from "@cuebench/contracts";
import { exportProjectBackup } from "./backup/schema";
import { canonicalSerialize } from "./quality/hash";
import { captionEvidenceProjectionForAudioDescription } from "./audio-description-evidence";
import type { DomainCommand } from "./commands";
import { domainError, type DomainError } from "./errors";
import {
  createCertificationSnapshot,
  prepareCertificationReview,
} from "./quality/certification";
import { prepareTrackExport } from "./export/round-trip";
import { currentValidationRun, validateProject } from "./quality/validate";
import type {
  AudioDescriptionBeat,
  AudioDescriptionGenerationLeaseBase,
  AudioDescriptionBeatRevision,
  AudioDescriptionGap,
  CaptionCue,
  CaptionGenerationLeaseBase,
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

interface CaptionInterval {
  readonly startMs: number;
  readonly endMs: number;
}

const intersects = (left: CaptionInterval, right: CaptionInterval): boolean => (
  left.startMs < right.endMs && right.startMs < left.endMs
);

/** Merge protection ranges once so partitioning is deterministic at touching boundaries. */
const mergedIntervals = (intervals: readonly CaptionInterval[]): readonly CaptionInterval[] => {
  const result: CaptionInterval[] = [];
  for (const interval of [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)) {
    const previous = result.at(-1);
    if (previous !== undefined && interval.startMs <= previous.endMs) {
      result[result.length - 1] = { startMs: previous.startMs, endMs: Math.max(previous.endMs, interval.endMs) };
    } else result.push({ ...interval });
  }
  return result;
};

const remainingIntervals = (cue: CaptionInterval, protectedIntervals: readonly CaptionInterval[]): readonly CaptionInterval[] => {
  let cursor = cue.startMs;
  const remaining: CaptionInterval[] = [];
  for (const protectedInterval of protectedIntervals) {
    if (!intersects(cue, protectedInterval)) continue;
    const startMs = Math.max(cue.startMs, protectedInterval.startMs);
    const endMs = Math.min(cue.endMs, protectedInterval.endMs);
    if (cursor < startMs) remaining.push({ startMs: cursor, endMs: startMs });
    cursor = Math.max(cursor, endMs);
  }
  if (cursor < cue.endMs) remaining.push({ startMs: cursor, endMs: cue.endMs });
  return remaining;
};

/**
 * Generated full-media evidence must never overwrite a human Sustained cue.
 * We retain only fully evidenced proposal portions outside protected intervals;
 * a word straddling a human boundary is omitted rather than guessed/split.
 */
const partitionGeneratedCaptions = (
  captions: readonly StagedCaptionCue[],
  words: readonly CaptionEvidenceWord[],
  protectedIntervals: readonly CaptionInterval[],
): readonly StagedCaptionCue[] | null => {
  const wordsById = new Map(words.map((word) => [word.evidenceId, word]));
  const partitions: StagedCaptionCue[] = [];
  for (const cue of captions) {
    const sourceWords = cue.evidenceIds.map((evidenceId) => wordsById.get(evidenceId));
    if (sourceWords.some((word) => word === undefined)) return null;
    const remaining = remainingIntervals(cue, protectedIntervals);
    if (remaining.length === 1 && remaining[0]!.startMs === cue.startMs && remaining[0]!.endMs === cue.endMs) {
      partitions.push({ ...cue, evidenceIds: [...cue.evidenceIds] });
      continue;
    }
    for (const [partIndex, interval] of remaining.entries()) {
      const partWords = sourceWords
        .filter((word): word is CaptionEvidenceWord => word !== undefined)
        .filter((word) => word.startMs >= interval.startMs && word.endMs <= interval.endMs)
        .sort((left, right) => left.startMs - right.startMs || left.sourceWordIndex - right.sourceWordIndex);
      if (partWords.length === 0) continue;
      const cueId = `${cue.cueId}-part-${partIndex + 1}`;
      if (cueId.length > 200) return null;
      const text = partWords.map((word) => word.text.trim()).filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
      if (text === "") continue;
      partitions.push({
        cueId,
        startMs: Math.max(interval.startMs, partWords[0]!.startMs),
        endMs: Math.min(interval.endMs, partWords.at(-1)!.endMs),
        text,
        speaker: cue.speaker,
        evidenceIds: partWords.map((word) => word.evidenceId),
      });
    }
  }
  const ordered = [...partitions].sort((left, right) => (
    left.startMs - right.startMs || left.endMs - right.endMs || left.cueId.localeCompare(right.cueId)
  ));
  const seenEvidence = new Set<string>();
  for (const [index, cue] of ordered.entries()) {
    if (
      cue.endMs <= cue.startMs
      || protectedIntervals.some((interval) => intersects(cue, interval))
      || (index > 0 && ordered[index - 1]!.endMs > cue.startMs)
      || cue.evidenceIds.some((evidenceId) => seenEvidence.has(evidenceId))
    ) return null;
    for (const evidenceId of cue.evidenceIds) seenEvidence.add(evidenceId);
  }
  return ordered;
};

/** Evidence supporting a live human Sustained cue is never an eviction candidate. */
const packageSupportsLiveSustainedCue = (project: CaptionProject, entry: LocalCaptionEvidencePackage): boolean => (
  entry.cueBindings.some((binding) => {
    const item = project.captions.items[binding.itemId];
    return item?.mergedIntoItemId === null
      && item.current.state === "Sustained"
      && item.current.itemRevision === binding.itemRevision;
  })
);

/**
 * The import gate bounds the entire compact backup envelope, including Court
 * Record, retained revisions/findings, and metadata—not just the transcript
 * package. Export owns the exact wire serialization, so adoption probes that
 * same boundary before any impossible aggregate can be committed.
 */
const fitsPortableBackupEnvelope = (project: CaptionProject): boolean => {
  if (countJsonNodes(project) > MAX_PORTABLE_PROJECT_JSON_NODES) return false;
  try {
    exportProjectBackup(project);
    return true;
  } catch {
    return false;
  }
};

/**
 * The persistent schema bounds Local Evidence Packages to four. Keep every
 * package still needed by a live Sustained cue; discard only unreferenced
 * history, and surface a safe adoption block if that bound cannot hold it.
 */
const retainLocalEvidencePackages = (
  project: CaptionProject,
  candidates: readonly LocalCaptionEvidencePackage[],
  requiredRunId: string,
): readonly LocalCaptionEvidencePackage[] | null => {
  const protectedIds = new Set(candidates
    .filter((entry) => packageSupportsLiveSustainedCue(project, entry) || entry.verification !== undefined)
    .map((entry) => entry.packageId));
  let expandedProtection = true;
  while (expandedProtection) {
    expandedProtection = false;
    for (const entry of candidates) {
      const sourcePackageId = entry.verification?.sourcePackageId;
      if (protectedIds.has(entry.packageId) && sourcePackageId !== undefined && !protectedIds.has(sourcePackageId)) {
        protectedIds.add(sourcePackageId);
        expandedProtection = true;
      }
    }
  }
  if (protectedIds.size > MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES) return null;
  // Keep newer unreferenced history first, then evict it oldest-first until
  // every shared portable budget holds. A package referenced by a live
  // Sustained cue and the result currently being adopted are never evictable.
  const retained = [...candidates]
    .sort((left, right) => {
      const leftProtected = protectedIds.has(left.packageId);
      const rightProtected = protectedIds.has(right.packageId);
      if (leftProtected !== rightProtected) return leftProtected ? -1 : 1;
      return right.retainedAtMs - left.retainedAtMs || right.runId.localeCompare(left.runId);
    });
  const fitsPortableBudget = (): boolean => (
    retained.length <= MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES
    && retained.reduce((total, entry) => total + entry.evidence.words.length, 0) <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_WORDS
    && new TextEncoder().encode(canonicalSerialize(retained)).byteLength <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES
    && countJsonNodes(retained) <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES
  );
  while (!fitsPortableBudget()) {
    const evictIndex = retained
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.runId !== requiredRunId && !protectedIds.has(entry.packageId))
      .sort((left, right) => (
        left.entry.retainedAtMs - right.entry.retainedAtMs
        || left.entry.runId.localeCompare(right.entry.runId)
      ))
      .at(0)?.index;
    if (evictIndex === undefined) return null;
    retained.splice(evictIndex, 1);
  }
  // The result being adopted is mandatory evidence, not evictable history.
  if (!retained.some((entry) => entry.runId === requiredRunId)) return null;
  return retained.sort((left, right) => left.retainedAtMs - right.retainedAtMs || left.runId.localeCompare(right.runId));
};

/** Visual evidence used by a live Sustained AD beat is never evicted. */
const audioDescriptionPackageSupportsLiveSustainedBeat = (
  project: CaptionProject,
  entry: LocalAudioDescriptionEvidencePackage,
): boolean => entry.beatBindings.some((binding) => {
  const item = project.audioDescriptions.items[binding.itemId];
  return item?.supersededByRunId === null
    && item.current.state === "Sustained"
    && item.current.itemRevision === binding.itemRevision;
});

const retainLocalAudioDescriptionEvidencePackages = (
  project: CaptionProject,
  candidates: readonly LocalAudioDescriptionEvidencePackage[],
  requiredRunId: string,
): readonly LocalAudioDescriptionEvidencePackage[] | null => {
  const protectedIds = new Set(candidates
    .filter((entry) => audioDescriptionPackageSupportsLiveSustainedBeat(project, entry) || entry.verification !== undefined)
    .map((entry) => entry.packageId));
  let expandedProtection = true;
  while (expandedProtection) {
    expandedProtection = false;
    for (const entry of candidates) {
      const sourcePackageId = entry.verification?.sourcePackageId;
      if (protectedIds.has(entry.packageId) && sourcePackageId !== undefined && !protectedIds.has(sourcePackageId)) {
        protectedIds.add(sourcePackageId);
        expandedProtection = true;
      }
    }
  }
  if (protectedIds.size > MAX_LOCAL_AUDIO_DESCRIPTION_EVIDENCE_PACKAGES) return null;
  const retained = [...candidates].sort((left, right) => (
    left.retainedAtMs - right.retainedAtMs || left.runId.localeCompare(right.runId)
  ));
  while (retained.length > MAX_LOCAL_AUDIO_DESCRIPTION_EVIDENCE_PACKAGES) {
    const evictIndex = retained.findIndex((entry) => (
      entry.runId !== requiredRunId && !protectedIds.has(entry.packageId)
    ));
    if (evictIndex < 0) return null;
    retained.splice(evictIndex, 1);
  }
  return retained.some((entry) => entry.runId === requiredRunId) ? retained : null;
};

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
  ...(command.type === "VerifyItemEvidence" ? {
    verificationPackageId: command.verificationPackageId,
    verificationMediaSha256: project.media.sha256.toLowerCase(),
  } : {}),
  ...(command.type === "ObjectItem"
    ? { detail: command.reason }
    : command.type === "AdoptCaptionGenerationResult" || command.type === "AdoptAudioDescriptionGenerationResult"
      // Persist the immutable run identity in Court Record rather than
      // relying on a short-lived Worker receipt to reconstruct a backup.
      ? { detail: `generation:${command.runId}` }
      : command.type === "RelinkMedia"
        ? { detail: `media:${project.media.sha256.toLowerCase()}:${command.media.sha256.toLowerCase()}` }
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

const allItemRevisionsFit = (
  items: readonly (CaptionCue | AudioDescriptionBeat)[],
  project: CaptionProject,
) => items.every((item) =>
  hasValidTime(project, item.current.startMs, item.current.endMs)
  && item.revisions.every((revision) => hasValidTime(project, revision.startMs, revision.endMs)));

const allTimesFit = (project: CaptionProject, durationMs: number) => {
  const relinkedProject: CaptionProject = { ...project, media: { ...project.media, durationMs } };
  return allItemRevisionsFit([
    ...Object.values(project.captions.items),
    ...Object.values(project.audioDescriptions.items),
  ], relinkedProject)
    && Object.values(project.audioDescriptionGaps).every((gap) =>
      hasValidTime(relinkedProject, gap.startMs, gap.endMs));
};

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

const captionLeaseBase = (
  project: CaptionProject,
  expectedProjectRevision: number,
): CaptionGenerationLeaseBase => ({
  targetTrack: "Captions",
  expectedProjectRevision,
  mediaSha256: project.media.sha256.toLowerCase(),
  qualityProfileRevision: project.qualityProfile.revision,
  captionOrder: [...project.captions.order],
  captionItems: Object.values(project.captions.items)
    .map((item) => ({
      itemId: item.itemId,
      itemRevision: item.current.itemRevision,
      state: item.current.state,
      mergedIntoItemId: item.mergedIntoItemId,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId)),
});

const captionBaseMatches = (project: CaptionProject, base: CaptionGenerationLeaseBase): boolean => {
  if (base.captionOrder.length !== project.captions.order.length || base.captionOrder.some((itemId, index) => itemId !== project.captions.order[index])) {
    return false;
  }
  const current = captionLeaseBase(project, base.expectedProjectRevision);
  return current.captionItems.length === base.captionItems.length
    && current.captionItems.every((item, index) => {
      const expected = base.captionItems[index];
      return expected !== undefined
        && item.itemId === expected.itemId
        && item.itemRevision === expected.itemRevision
        && item.state === expected.state
        && item.mergedIntoItemId === expected.mergedIntoItemId;
    });
};

const audioDescriptionLeaseBase = (
  project: CaptionProject,
  expectedProjectRevision: number,
): AudioDescriptionGenerationLeaseBase | null => {
  const captionEvidence = captionEvidenceProjectionForAudioDescription(project, expectedProjectRevision);
  if (captionEvidence === null) return null;
  return {
    targetTrack: "AudioDescriptions",
    expectedProjectRevision,
    mediaSha256: project.media.sha256.toLowerCase(),
    qualityProfileRevision: project.qualityProfile.revision,
    captionEvidenceHash: captionEvidence.hash,
    captionEvidencePackageIds: [...captionEvidence.projection.localEvidencePackageIds],
    audioDescriptionOrder: [...project.audioDescriptions.order],
    audioDescriptionRequirementIds: Object.keys(project.audioDescriptionRequirements).sort((left, right) => left.localeCompare(right)),
    audioDescriptionItems: Object.values(project.audioDescriptions.items)
      .map((item) => ({
        itemId: item.itemId,
        itemRevision: item.current.itemRevision,
        state: item.current.state,
        supersededByRunId: item.supersededByRunId,
      }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  };
};

const audioDescriptionBaseMatches = (
  project: CaptionProject,
  base: AudioDescriptionGenerationLeaseBase,
): boolean => {
  const current = audioDescriptionLeaseBase(project, base.expectedProjectRevision);
  if (current === null) return false;
  return (
    current.mediaSha256 === base.mediaSha256
    && current.qualityProfileRevision === base.qualityProfileRevision
    && current.captionEvidenceHash === base.captionEvidenceHash
    && current.captionEvidencePackageIds.length === base.captionEvidencePackageIds.length
    && current.captionEvidencePackageIds.every((value, index) => value === base.captionEvidencePackageIds[index])
    && current.audioDescriptionOrder.length === base.audioDescriptionOrder.length
    && current.audioDescriptionOrder.every((value, index) => value === base.audioDescriptionOrder[index])
    && current.audioDescriptionRequirementIds.length === base.audioDescriptionRequirementIds.length
    && current.audioDescriptionRequirementIds.every((value, index) => value === base.audioDescriptionRequirementIds[index])
    && current.audioDescriptionItems.length === base.audioDescriptionItems.length
    && current.audioDescriptionItems.every((item, index) => {
      const expected = base.audioDescriptionItems[index];
      return expected !== undefined
        && item.itemId === expected.itemId
        && item.itemRevision === expected.itemRevision
        && item.state === expected.state
        && item.supersededByRunId === expected.supersededByRunId;
    })
  );
};

const hasUniqueVerificationIdentifiers = (values: readonly string[]): boolean => (
  values.length > 0
  && values.every(isVerificationPackageId)
  && new Set(values).size === values.length
);

export const applyCommand = (project: CaptionProject, command: DomainCommand): CommandResult => {
  // Generation adoption/release deliberately fence the leased target state,
  // not the whole project revision. This permits a Human's unrelated
  // audio-description work to coexist with an in-flight caption run.
  if (
    command.type !== "AdoptCaptionGenerationResult"
    && command.type !== "AdoptAudioDescriptionGenerationResult"
    && command.type !== "ReleaseGenerationRun"
  ) {
    const projectError = staleProject(project, command.expectedProjectRevision);
    if (projectError !== undefined) return { project, events: [], error: projectError };
  }

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
    const expectedProjectRevision = project.projectRevision + 1;
    const base = command.targetTrack === "Captions"
      ? captionLeaseBase(project, expectedProjectRevision)
      : audioDescriptionLeaseBase(project, expectedProjectRevision);
    if (base === null) {
      return fail(project, "INVALID_ARGUMENT", "Audio-description generation requires current locally retained caption evidence.");
    }
    const activeGenerationRun: GenerationLease = {
      runId: command.runId,
      targetTrack: command.targetTrack,
      actor: clone(command.actor),
      // The lease becomes visible in the incremented project revision that
      // the Worker signs into its generation receipt.
      base,
    };
    return commit(project, command, { activeGenerationRun });
  }
  if (command.type === "AdoptCaptionGenerationResult") {
    if (command.actor.type !== "CueBenchAI") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI may adopt its complete caption generation result.");
    if (project.activeGenerationRun?.runId !== command.runId || project.activeGenerationRun.targetTrack !== "Captions") {
      return fail(project, "STALE_RUN", "The matching caption generation run is no longer active.");
    }
    const leaseBase = project.activeGenerationRun.base;
    if (leaseBase === undefined || leaseBase.targetTrack !== "Captions") {
      return fail(project, "STALE_RUN", "This legacy caption generation lease has no safe base-state fence. Discard it before starting a new run.");
    }
    if (
      command.expectedProjectRevision !== leaseBase.expectedProjectRevision
      || command.result.expectedProjectRevision !== leaseBase.expectedProjectRevision
      || command.expectedQualityProfileRevision !== leaseBase.qualityProfileRevision
      || command.result.expectedQualityProfileRevision !== leaseBase.qualityProfileRevision
      || project.qualityProfile.revision !== leaseBase.qualityProfileRevision
    ) {
      return fail(project, "STALE_PROJECT", "The Quality Profile changed after caption generation started.");
    }
    if (
      command.result.runId !== command.runId
      || command.result.projectId !== project.projectId
      || command.result.targetTrack !== "Captions"
      || command.result.evidence.projectId !== project.projectId
      || command.result.evidence.runId !== command.runId
      || command.result.evidence.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || project.media.sha256.toLowerCase() !== leaseBase.mediaSha256
      || !captionBaseMatches(project, leaseBase)
    ) return fail(project, "MEDIA_HASH_MISMATCH", "The staged evidence does not bind to this exact project media and revision.");
    if (command.result.evidence.words.length > MAX_LOCAL_CAPTION_EVIDENCE_WORDS) {
      return fail(project, "INVALID_ARGUMENT", "The staged caption evidence exceeds CueBench's bounded Local Evidence Package.");
    }
    if (command.result.captions.length > MAX_LOCAL_CAPTION_CUES) {
      return fail(project, "INVALID_ARGUMENT", "The staged caption result exceeds CueBench's bounded backup-safe cue count.");
    }

    const existingProposed = Object.values(project.captions.items)
      .filter((item) => item.mergedIntoItemId === null && item.current.state === "Proposed");
    if (existingProposed.length > 0 && !command.confirmedProposedReplacement) {
      return fail(project, "CONFIRMATION_DECLINED", "Replacing existing Proposed captions requires visible human confirmation.");
    }
    // Never lay AI proposals across a human Sustained interval. We also
    // protect any other live non-Proposed cue so the resulting canonical
    // caption timeline remains export/validation-safe, not merely review-safe.
    const protectedIntervals = mergedIntervals(Object.values(project.captions.items)
      .filter((item) => item.mergedIntoItemId === null && item.current.state !== "Proposed")
      .map((item) => ({ startMs: item.current.startMs, endMs: item.current.endMs })));
    const effectiveCaptions = partitionGeneratedCaptions(
      command.result.captions,
      command.result.evidence.words,
      protectedIntervals,
    );
    if (effectiveCaptions === null) {
      return fail(project, "INVALID_ARGUMENT", "CueBench cannot adopt generated captions that overlap protected human caption intervals.");
    }
    if (command.result.captions.length > 0 && effectiveCaptions.length === 0) {
      return fail(project, "INVALID_ARGUMENT", "CueBench cannot adopt a generated caption result wholly covered by protected human caption intervals.");
    }
    const globallyKnownIds = new Set([
      ...Object.keys(project.captions.items),
      ...Object.keys(project.audioDescriptions.items),
      ...Object.keys(project.audioDescriptionGaps),
    ]);
    const generatedIds = new Set<string>();
    for (const cue of effectiveCaptions) {
      if (
        !cue.cueId.trim()
        || cue.cueId.length > 200
        || globallyKnownIds.has(cue.cueId)
        || generatedIds.has(cue.cueId)
        || !hasValidTime(project, cue.startMs, cue.endMs)
        || !cue.text.trim()
        || cue.evidenceIds.length === 0
      ) return fail(project, "INVALID_ARGUMENT", "The staged caption result contains an invalid or conflicting proposal.");
      generatedIds.add(cue.cueId);
    }
    const firstGeneratedId = effectiveCaptions[0]?.cueId;
    if (existingProposed.length > 0 && firstGeneratedId === undefined) {
      return fail(project, "INVALID_ARGUMENT", "An empty staged result cannot replace existing Proposed captions.");
    }
    const generatedItems: Readonly<Record<string, CaptionCue>> = Object.fromEntries(effectiveCaptions.map((cue) => {
      const current: CaptionCueRevision = {
        itemId: cue.cueId,
        kind: "CaptionCue",
        itemRevision: 1,
        state: "Proposed",
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        speaker: cue.speaker,
        actor: clone(command.actor),
        // A run-scoped cause lets aggregate import prove which Court Record
        // adoption event created each cue after older packages are pruned.
        cause: `AdoptCaptionGenerationResult:${command.runId}`,
        parentItemRevision: null,
      };
      const item: CaptionCue = { itemId: cue.cueId, kind: "CaptionCue", revisions: [current], current, mergedIntoItemId: null };
      return [cue.cueId, item];
    }));
    const replacedItems = firstGeneratedId === undefined ? project.captions.items : Object.fromEntries(Object.entries(project.captions.items).map(([itemId, item]) => [
      itemId,
      existingProposed.some((candidate) => candidate.itemId === itemId)
        ? { ...item, mergedIntoItemId: firstGeneratedId }
        : item,
    ]));
    const availableEvidenceIds = new Set(command.result.evidence.words.map((word) => word.evidenceId));
    const generatedEvidence = effectiveCaptions.flatMap((cue) => cue.evidenceIds.map((evidenceId) => ({
      evidenceId,
      projectId: project.projectId,
      mediaSha256: project.media.sha256.toLowerCase(),
      itemId: cue.cueId,
      itemRevision: 1,
    })));
    if (
      generatedEvidence.some((entry) => !availableEvidenceIds.has(entry.evidenceId))
      || new Set(generatedEvidence.map((entry) => entry.evidenceId)).size !== generatedEvidence.length
      || generatedEvidence.some((entry) => entry.evidenceId.length > 200)
      || generatedEvidence.some((entry) => project.evidence.some((existing) => existing.evidenceId === entry.evidenceId))
    ) return fail(project, "INVALID_ARGUMENT", "The staged caption evidence conflicts with project evidence.");
    const firstGenerated = firstGeneratedId === undefined ? undefined : generatedItems[firstGeneratedId];
    let retainedEvidence = retainLocalEvidencePackages(project, [
      ...project.localEvidencePackages.filter((entry) => entry.runId !== command.runId),
      {
        packageId: `generation-${command.runId}`,
        runId: command.runId,
        projectId: project.projectId,
        mediaSha256: project.media.sha256.toLowerCase(),
        expectedProjectRevision: leaseBase.expectedProjectRevision,
        expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
        retainedAtMs: command.result.createdAtMs,
        ...(command.result.outputSha256 === undefined ? {} : { outputSha256: command.result.outputSha256 }),
        evidence: clone(command.result.evidence),
        cueBindings: effectiveCaptions.map((cue) => ({
          cueId: cue.cueId,
          itemId: cue.cueId,
          itemRevision: 1,
          evidenceIds: [...cue.evidenceIds],
        })),
      },
    ], command.runId);
    if (retainedEvidence === null) {
      return fail(project, "INVALID_ARGUMENT", "CueBench cannot adopt this result because the Local Evidence Package budget is already required by live Sustained captions.");
    }
    const commitAdoption = (localEvidencePackages: readonly LocalCaptionEvidencePackage[]): CommandSuccess => commit(project, command, {
      captions: {
        ...project.captions,
        order: [
          ...project.captions.order.filter((itemId) => !existingProposed.some((item) => item.itemId === itemId)),
          ...effectiveCaptions.map((cue) => cue.cueId),
        ].sort((left, right) => {
          const leftCue = generatedItems[left] ?? project.captions.items[left];
          const rightCue = generatedItems[right] ?? project.captions.items[right];
          return (leftCue?.current.startMs ?? 0) - (rightCue?.current.startMs ?? 0)
            || (leftCue?.current.endMs ?? 0) - (rightCue?.current.endMs ?? 0)
            || left.localeCompare(right);
        }),
        items: { ...replacedItems, ...generatedItems },
      },
      evidence: [...project.evidence, ...generatedEvidence],
      localEvidencePackages,
      activeGenerationRun: null,
      ...(firstGenerated === undefined ? {} : { selectedItem: selectFor(firstGenerated) }),
      ...withStaleArtifacts(project),
    }, firstGeneratedId);
    let adopted = commitAdoption(retainedEvidence);
    // Existing, unreferenced evidence may be the only expendable part of an
    // otherwise valid project. Re-evaluate the *whole* export after each
    // deterministic oldest-first eviction; never evict the just-adopted run
    // or a package needed by a live Sustained cue.
    while (!fitsPortableBackupEnvelope(adopted.project)) {
      const evict = retainedEvidence
        .filter((entry) => entry.runId !== command.runId && !packageSupportsLiveSustainedCue(project, entry))
        .sort((left, right) => left.retainedAtMs - right.retainedAtMs || left.runId.localeCompare(right.runId))
        .at(0);
      if (evict === undefined) {
        return fail(project, "INVALID_ARGUMENT", "CueBench cannot adopt this result because the complete portable backup would exceed its JSON-node or 10 MB byte budget.");
      }
      retainedEvidence = retainedEvidence.filter((entry) => entry.packageId !== evict.packageId);
      adopted = commitAdoption(retainedEvidence);
    }
    return adopted;
  }
  if (command.type === "AdoptAudioDescriptionGenerationResult") {
    if (command.actor.type !== "CueBenchAI") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI may adopt its complete audio-description generation result.");
    if (project.activeGenerationRun?.runId !== command.runId || project.activeGenerationRun.targetTrack !== "AudioDescriptions") {
      return fail(project, "STALE_RUN", "The matching audio-description generation run is no longer active.");
    }
    const leaseBase = project.activeGenerationRun.base;
    if (leaseBase === undefined || leaseBase.targetTrack !== "AudioDescriptions") {
      return fail(project, "STALE_RUN", "This legacy audio-description lease has no safe base-state fence. Discard it before starting a new run.");
    }
    if (
      command.expectedProjectRevision !== leaseBase.expectedProjectRevision
      || command.result.expectedProjectRevision !== leaseBase.expectedProjectRevision
      || command.expectedQualityProfileRevision !== leaseBase.qualityProfileRevision
      || command.result.expectedQualityProfileRevision !== leaseBase.qualityProfileRevision
      || project.qualityProfile.revision !== leaseBase.qualityProfileRevision
      || project.media.sha256.toLowerCase() !== leaseBase.mediaSha256
      || !audioDescriptionBaseMatches(project, leaseBase)
    ) {
      return fail(project, "STALE_PROJECT", "The audio-description target or Quality Profile changed after generation started.");
    }
    if (
      command.result.runId !== command.runId
      || command.result.projectId !== project.projectId
      || command.result.targetTrack !== "AudioDescriptions"
      || command.result.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || command.result.captionEvidenceHash.toLowerCase() !== leaseBase.captionEvidenceHash
      || command.result.evidence.runId !== command.runId
      || command.result.evidence.projectId !== project.projectId
      || command.result.evidence.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || command.result.evidence.captionEvidenceHash.toLowerCase() !== leaseBase.captionEvidenceHash
    ) {
      return fail(project, "MEDIA_HASH_MISMATCH", "The staged audio-description evidence does not bind to this exact retained caption-evidence base.");
    }

    const replaceableProposed = Object.values(project.audioDescriptions.items).filter((item) => (
      item.supersededByRunId === null
      && item.current.state === "Proposed"
      && item.current.actor.type === "CueBenchAI"
    ));
    if (replaceableProposed.length > 0 && !command.confirmedProposedReplacement) {
      return fail(project, "CONFIRMATION_DECLINED", "Replacing existing CueBench-AI Proposed audio descriptions requires visible human confirmation.");
    }

    const protectedIntervals = mergedIntervals(Object.values(project.audioDescriptions.items)
      .filter((item) => item.supersededByRunId === null && !replaceableProposed.some((candidate) => candidate.itemId === item.itemId))
      .map((item) => ({ startMs: item.current.startMs, endMs: item.current.endMs })));
    const knownFrameIds = new Set(command.result.evidence.frames.map((frame) => frame.evidenceId));
    const globalIds = new Set([
      ...Object.keys(project.captions.items),
      ...Object.keys(project.audioDescriptions.items),
      ...Object.keys(project.audioDescriptionGaps),
      ...Object.keys(project.audioDescriptionRequirements),
    ]);
    const generatedIds = new Set<string>();
    for (const beat of command.result.audioDescriptions) {
      if (
        !beat.beatId.trim()
        || globalIds.has(beat.beatId)
        || generatedIds.has(beat.beatId)
        || !hasValidTime(project, beat.startMs, beat.endMs)
        || !beat.description.trim()
        || beat.evidenceIds.length === 0
        // A bounded immutable screenshot may explain several distinct beats
        // (for example, a persistent chart across two gaps). This validates
        // every citation without forcing duplicate frame objects or silently
        // dropping a later proposal from the same evidence package.
        || beat.evidenceIds.some((evidenceId) => !knownFrameIds.has(evidenceId))
        || protectedIntervals.some((interval) => intersects(beat, interval))
      ) return fail(project, "INVALID_ARGUMENT", "The staged audio-description result contains an invalid or protected proposal.");
      generatedIds.add(beat.beatId);
    }
    if (replaceableProposed.length > 0 && command.result.audioDescriptions.length === 0) {
      return fail(project, "INVALID_ARGUMENT", "An empty staged result cannot replace existing CueBench-AI Proposed audio descriptions.");
    }
    const requirementIds = new Set<string>();
    for (const requirement of command.result.extendedDescriptionRequirements) {
      if (
        !requirement.requirementId.trim()
        || globalIds.has(requirement.requirementId)
        || requirementIds.has(requirement.requirementId)
        || requirement.evidenceIds.some((evidenceId) => !knownFrameIds.has(evidenceId))
      ) return fail(project, "INVALID_ARGUMENT", "The staged extended-description requirement is invalid or conflicts with project state.");
      requirementIds.add(requirement.requirementId);
    }

    const generatedItems: Readonly<Record<string, AudioDescriptionBeat>> = Object.fromEntries(command.result.audioDescriptions.map((beat) => {
      const current: AudioDescriptionBeatRevision = {
        itemId: beat.beatId,
        kind: "AudioDescriptionBeat",
        itemRevision: 1,
        state: "Proposed",
        startMs: beat.startMs,
        endMs: beat.endMs,
        description: beat.description,
        actor: clone(command.actor),
        cause: `AdoptAudioDescriptionGenerationResult:${command.runId}`,
        parentItemRevision: null,
      };
      return [beat.beatId, {
        itemId: beat.beatId,
        kind: "AudioDescriptionBeat" as const,
        revisions: [current],
        current,
        supersededByRunId: null,
      }];
    }));
    const supersededItems: Readonly<Record<string, AudioDescriptionBeat>> = Object.fromEntries(
      Object.entries(project.audioDescriptions.items).map(([itemId, item]) => [
        itemId,
        replaceableProposed.some((candidate) => candidate.itemId === itemId)
          ? { ...item, supersededByRunId: command.runId }
          : item,
      ]),
    );
    const firstGeneratedId = command.result.audioDescriptions[0]?.beatId;
    const evidenceBinding = new Map<string, { readonly itemId: string | null; readonly itemRevision: number | null }>();
    for (const beat of command.result.audioDescriptions) {
      for (const evidenceId of beat.evidenceIds) evidenceBinding.set(evidenceId, { itemId: beat.beatId, itemRevision: 1 });
    }
    for (const requirement of command.result.extendedDescriptionRequirements) {
      for (const evidenceId of requirement.evidenceIds) {
        if (!evidenceBinding.has(evidenceId)) evidenceBinding.set(evidenceId, { itemId: null, itemRevision: null });
      }
    }
    const generatedEvidence = [...evidenceBinding.entries()].map(([evidenceId, binding]) => ({
      evidenceId,
      projectId: project.projectId,
      mediaSha256: project.media.sha256.toLowerCase(),
      itemId: binding.itemId,
      itemRevision: binding.itemRevision,
    }));
    if (generatedEvidence.some((entry) => project.evidence.some((existing) => existing.evidenceId === entry.evidenceId))) {
      return fail(project, "INVALID_ARGUMENT", "The staged audio-description evidence conflicts with existing project evidence.");
    }
    const generatedRequirements = Object.fromEntries(command.result.extendedDescriptionRequirements.map((requirement) => [
      requirement.requirementId,
      {
        requirementId: requirement.requirementId,
        runId: command.runId,
        text: requirement.text,
        rationale: requirement.rationale,
        evidenceIds: [...requirement.evidenceIds],
        reason: requirement.reason,
        createdAtMs: command.result.createdAtMs,
      },
    ]));
    const localAudioDescriptionEvidencePackages = retainLocalAudioDescriptionEvidencePackages(project, [
      ...project.localAudioDescriptionEvidencePackages.filter((entry) => entry.runId !== command.runId),
      {
        // A run id is already a bounded canonical identifier and is unique in
        // this per-track package collection.
        packageId: command.runId,
        runId: command.runId,
        projectId: project.projectId,
        mediaSha256: project.media.sha256.toLowerCase(),
        expectedProjectRevision: leaseBase.expectedProjectRevision,
        expectedQualityProfileRevision: leaseBase.qualityProfileRevision,
        captionEvidenceHash: leaseBase.captionEvidenceHash,
        retainedAtMs: command.result.createdAtMs,
        ...(command.result.outputSha256 === undefined ? {} : { outputSha256: command.result.outputSha256 }),
        evidence: clone(command.result.evidence),
        beatBindings: command.result.audioDescriptions.map((beat) => ({
          beatId: beat.beatId,
          itemId: beat.beatId,
          itemRevision: 1,
          evidenceIds: [...beat.evidenceIds],
        })),
        requirementBindings: command.result.extendedDescriptionRequirements.map((requirement) => ({
          requirementId: requirement.requirementId,
          evidenceIds: [...requirement.evidenceIds],
        })),
      },
    ], command.runId);
    if (localAudioDescriptionEvidencePackages === null) {
      return fail(project, "INVALID_ARGUMENT", "CueBench cannot adopt this result because compact visual evidence required by Sustained audio descriptions would exceed the portable package limit.");
    }
    const firstGenerated = firstGeneratedId === undefined ? undefined : generatedItems[firstGeneratedId];
    return commit(project, command, {
      audioDescriptions: {
        ...project.audioDescriptions,
        order: [
          ...project.audioDescriptions.order.filter((itemId) => !replaceableProposed.some((item) => item.itemId === itemId)),
          ...command.result.audioDescriptions.map((beat) => beat.beatId),
        ].sort((left, right) => {
          const leftBeat = generatedItems[left] ?? project.audioDescriptions.items[left];
          const rightBeat = generatedItems[right] ?? project.audioDescriptions.items[right];
          return (leftBeat?.current.startMs ?? 0) - (rightBeat?.current.startMs ?? 0)
            || (leftBeat?.current.endMs ?? 0) - (rightBeat?.current.endMs ?? 0)
            || left.localeCompare(right);
        }),
        items: { ...supersededItems, ...generatedItems },
      },
      audioDescriptionRequirements: { ...project.audioDescriptionRequirements, ...generatedRequirements },
      evidence: [...project.evidence, ...generatedEvidence],
      localAudioDescriptionEvidencePackages,
      activeGenerationRun: null,
      ...(firstGenerated === undefined ? {} : { selectedItem: selectFor(firstGenerated) }),
      ...withStaleArtifacts(project),
    }, firstGeneratedId);
  }
  if (command.type === "ReleaseGenerationRun") {
    if (project.activeGenerationRun?.runId !== command.runId) return fail(project, "STALE_RUN", "The generation run is no longer active.");
    // A Browser Agent may record the cancellation it actually initiated. This
    // does not grant it any Human-only ruling/certification authority; it
    // preserves the truthful Court Record actor for a terminal run release.
    if (command.actor.type !== "System" && command.actor.type !== "CueBenchAI" && command.actor.type !== "Human" && command.actor.type !== "BrowserAgent") return fail(project, "INVALID_ARGUMENT", "Only CueBench AI, System, a Browser Agent cancellation, or an authenticated Human may release a generation run.");
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
    if (!allTimesFit(project, command.media.durationMs)) return fail(project, "INVALID_ARGUMENT", "Media duration must contain every stored item revision and gap.");
    const sameMediaContent = command.media.sha256.toLowerCase() === project.media.sha256.toLowerCase();
    // Transcript words and visual frames are evidence of one exact source
    // hash. A source-id-only relink to the same content retains its authenticated
    // package chain; replacement content tombstones every active binding while
    // leaving immutable evidence history available for audit.
    return commit(project, command, {
      media: { ...clone(command.media), relinkState: "Linked" },
      localEvidencePackages: sameMediaContent ? project.localEvidencePackages : [],
      localAudioDescriptionEvidencePackages: sameMediaContent ? project.localAudioDescriptionEvidencePackages : [],
      audioDescriptionRequirements: sameMediaContent ? project.audioDescriptionRequirements : {},
      // Evidence rows are append-only audit history in durable storage. Their
      // old media hash makes them stale and non-resolvable for the relinked
      // source; clearing the local packages/EDRs above removes every active
      // AD provenance binding without trying to rewrite that history.
      evidence: project.evidence,
      ...withStaleArtifacts(project),
    });
  }
  if (command.type === "ValidateProject") {
    if (command.actor.type !== "System") return fail(project, "INVALID_ARGUMENT", "Only System may persist deterministic validation.");
    // The command commit itself creates the revision being validated. This
    // keeps project-target finding IDs bound to the persisted post-run state.
    const validationRun = validateProject({ ...project, projectRevision: project.projectRevision + 1 });
    return commit(project, command, {
      validation: {
        status: "Current",
        blockerCount: validationRun.blockerCount,
        warningCount: validationRun.warningCount,
      },
      validationRun: clone(validationRun),
      validationHistory: [...project.validationHistory, clone(validationRun)],
    });
  }
  if (command.type === "RecordExportRoundTrip") {
    if (command.actor.type !== "System") {
      return fail(project, "INVALID_ARGUMENT", "Only System may record deterministic export verification.");
    }
    if (!command.exportId.trim() || project.exportHistory.some((record) => record.exportId === command.exportId)) {
      return fail(project, "INVALID_ARGUMENT", "Export verification ids must be unique and non-empty.");
    }
    if (
      (command.trackKind !== "Captions" && command.trackKind !== "AudioDescriptions")
      || !["vtt", "srt", "ad-txt"].includes(command.format)
      || (command.disposition !== "draft" && command.disposition !== "certified")
      || !isFiniteInteger(command.verifiedAtMs)
      || command.verifiedAtMs < 0
      || typeof command.text !== "string"
    ) return fail(project, "INVALID_ARGUMENT", "Export verification must contain an exact exported payload.");
    let prepared: ReturnType<typeof prepareTrackExport>;
    try {
      prepared = prepareTrackExport({
        project,
        trackKind: command.trackKind,
        format: command.format,
        disposition: command.disposition,
      });
    } catch (error) {
      return fail(project, "INVALID_ARGUMENT", error instanceof Error ? error.message : "Export verification could not be prepared.");
    }
    if (!prepared.roundTrip.ok || command.text !== prepared.text) {
      return fail(project, "INVALID_ARGUMENT", "Export verification text does not match the independently verified project export.");
    }
    return commit(project, command, {
      exportHistory: [...project.exportHistory, {
        exportId: command.exportId,
        projectRevision: project.projectRevision,
        trackKind: command.trackKind,
        format: command.format,
        disposition: command.disposition,
        verifiedAtMs: command.verifiedAtMs,
        serializedTextHash: prepared.serializedTextHash,
        roundTrip: { ok: true },
      }],
    });
  }
  if (command.type === "WaiveWarning") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may waive a warning.");
    if (!command.findingId.trim() || !command.reason.trim()) return fail(project, "INVALID_ARGUMENT", "A warning waiver needs a finding and reason.");
    const validationRun = currentValidationRun(project);
    if (validationRun === undefined) {
      return fail(project, "CERTIFICATION_OUT_OF_DATE", "A warning may be waived only from a current validation run.");
    }
    const storedFinding = validationRun.findings.find(
      (candidate) => candidate.findingId === command.findingId,
    );
    if (storedFinding?.severity === "blocker") return fail(project, "VALIDATION_BLOCKER", "Blocking violations cannot be waived.");
    if (storedFinding === undefined || storedFinding.severity !== "warning") {
      return fail(project, "NOT_FOUND", "The warning is not part of the current validation run.");
    }
    return commit(project, command, { warningWaivers: { ...project.warningWaivers, [command.findingId]: { findingId: command.findingId, reason: command.reason, actor: clone(command.actor), projectRevision: project.projectRevision + 1 } }, ...withStaleCertification(project) });
  }
  if (command.type === "CertifyProject") {
    if (!hasHumanAuthority(command.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may certify a project.");
    if (!command.expectedReadinessHash.trim()) return fail(project, "INVALID_ARGUMENT", "Certification requires the expected readiness hash.");
    const readiness = prepareCertificationReview(project);
    if (command.expectedReadinessHash !== readiness.readinessHash) {
      return fail(project, "CERTIFICATION_OUT_OF_DATE", "Certification readiness changed; prepare review again.");
    }
    if (!readiness.canCertify) {
      if (readiness.currentBlockers.length > 0) return fail(project, "VALIDATION_BLOCKER", "Blocking validation findings must be resolved before certification.");
      return fail(project, "CERTIFICATION_OUT_OF_DATE", "Certification requires current validation, no unwaived warnings, and a Sustained item.");
    }
    if (command.certificationId !== undefined && !command.certificationId.trim()) {
      return fail(project, "INVALID_ARGUMENT", "Certification id cannot be empty.");
    }
    const certificationId = command.certificationId === undefined
      ? `certification-${readiness.readinessHash}`
      : command.certificationId.trim();
    if (project.certifications.some((snapshot) => snapshot.certificationId === certificationId)) {
      return fail(project, "INVALID_ARGUMENT", "Certification id already exists.");
    }
    const certifiedAtMs = command.certifiedAtMs;
    if (!isFiniteInteger(certifiedAtMs) || certifiedAtMs <= 0) {
      return fail(project, "INVALID_ARGUMENT", "Certification timestamp must be a positive integer.");
    }
    const certification = createCertificationSnapshot(project, readiness, {
      certificationId,
      certifiedAtMs,
      actor: command.actor,
    });
    return commit(project, command, {
      certification: { status: "Current", certificationId },
      certifications: [...project.certifications, certification],
    });
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
    const item: AudioDescriptionBeat = { itemId: command.beatId, kind: "AudioDescriptionBeat", revisions: [current], current, supersededByRunId: null };
    const consumedGap: AudioDescriptionGap = { ...gap, gapRevision: gap.gapRevision + 1, state: "Consumed" };
    return commit(project, command, { audioDescriptions: { ...project.audioDescriptions, order: [...project.audioDescriptions.order, item.itemId], items: { ...project.audioDescriptions.items, [item.itemId]: item } }, audioDescriptionGaps: { ...project.audioDescriptionGaps, [gap.gapId]: consumedGap }, selectedItem: selectFor(item), ...withStaleArtifacts(project) }, item.itemId);
  }

  const rawItemId = resolvedItemId(command);
  if (typeof rawItemId !== "string") return { project, events: [], error: rawItemId };
  const expectedItemCommand = { ...command, itemId: rawItemId } as Extract<DomainCommand, { readonly expectedItemRevision: number }> & { readonly itemId: string };
  const item = requireItem(project, expectedItemCommand);
  if ("code" in item) return { project, events: [], error: item };

  if (command.type === "VerifyItemEvidence") {
    if (!hasHumanAuthority(command.actor)) {
      return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only a human may verify retained evidence for a reviewed revision.");
    }
    if (item.current.state !== "Sustained") {
      return fail(project, "INVALID_ARGUMENT", "Retained evidence may be verified only for the exact current Sustained revision.");
    }
    if (
      !isVerificationPackageId(command.verificationPackageId)
      || !hasUniqueVerificationIdentifiers(command.verificationEvidenceIds)
      || !isFiniteInteger(command.verifiedAtMs)
      || command.verifiedAtMs <= 0
      || project.localEvidencePackages.some((entry) => entry.packageId === command.verificationPackageId)
      || project.localAudioDescriptionEvidencePackages.some((entry) => entry.packageId === command.verificationPackageId)
      || command.verificationEvidenceIds.some((evidenceId) => project.evidence.some((entry) => entry.evidenceId === evidenceId))
    ) return fail(project, "INVALID_ARGUMENT", "Evidence verification needs unique bounded package, provenance, and timestamp identifiers.");

    if (item.kind === "CaptionCue") {
      const sourcePackage = project.localEvidencePackages.find((entry) => entry.packageId === command.sourcePackageId);
      const sourceBinding = sourcePackage?.cueBindings.find((binding) => binding.itemId === item.itemId);
      if (
        sourcePackage === undefined
        || sourceBinding === undefined
        || sourcePackage.projectId !== project.projectId
        || sourcePackage.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
        || sourceBinding.evidenceIds.length !== command.verificationEvidenceIds.length
      ) return fail(project, "NOT_FOUND", "The retained caption evidence package cannot verify this revision.");
      const wordsById = new Map(sourcePackage.evidence.words.map((word) => [word.evidenceId, word]));
      const sourceWords = sourceBinding.evidenceIds.map((evidenceId) => wordsById.get(evidenceId));
      if (sourceWords.some((word) => word === undefined)) {
        return fail(project, "INVALID_ARGUMENT", "The retained caption evidence binding no longer resolves to its source words.");
      }
      const evidenceIdMap = new Map(sourceBinding.evidenceIds.map((sourceEvidenceId, index) => (
        [sourceEvidenceId, command.verificationEvidenceIds[index]!] as const
      )));
      const verifiedWords = sourceWords.map((word) => ({
        ...clone(word!),
        evidenceId: evidenceIdMap.get(word!.evidenceId)!,
      }));
      const speakerSegmentIds = new Set(verifiedWords.flatMap((word) => word.speakerSegmentIds));
      const uncertaintySpans = sourcePackage.evidence.uncertaintySpans
        .filter((span) => span.evidenceIds.every((evidenceId) => evidenceIdMap.has(evidenceId)))
        .map((span) => ({ ...clone(span), evidenceIds: span.evidenceIds.map((evidenceId) => evidenceIdMap.get(evidenceId)!) }));
      const sourcePackageWithoutOutputHash = clone(sourcePackage);
      Reflect.deleteProperty(sourcePackageWithoutOutputHash, "outputSha256");
      const verificationPackage: LocalCaptionEvidencePackage = {
        ...clone(sourcePackageWithoutOutputHash),
        packageId: command.verificationPackageId,
        expectedProjectRevision: project.projectRevision,
        retainedAtMs: command.verifiedAtMs,
        verification: {
          kind: "HumanEvidenceVerification",
          eventId: `${project.projectId}:${project.projectRevision + 1}:${project.courtRecord.length + 1}`,
          sourcePackageId: command.sourcePackageId,
          actor: { type: "Human", id: command.actor.id },
          itemId: item.itemId,
          itemRevision: item.current.itemRevision,
        },
        evidence: {
          ...clone(sourcePackage.evidence),
          words: verifiedWords,
          ...(sourcePackage.evidence.speakerSegments === undefined ? {} : {
            speakerSegments: sourcePackage.evidence.speakerSegments
              .filter((segment) => speakerSegmentIds.has(segment.id))
              .map(clone),
          }),
          uncertaintySpans,
        },
        cueBindings: [{
          cueId: item.itemId,
          itemId: item.itemId,
          itemRevision: item.current.itemRevision,
          evidenceIds: [...command.verificationEvidenceIds],
        }],
      };
      const candidateProject: CaptionProject = {
        ...project,
        evidence: [...project.evidence, ...command.verificationEvidenceIds.map((evidenceId) => ({
          evidenceId,
          projectId: project.projectId,
          mediaSha256: project.media.sha256.toLowerCase(),
          itemId: item.itemId,
          itemRevision: item.current.itemRevision,
        }))],
        localEvidencePackages: [...project.localEvidencePackages, verificationPackage],
      };
      if (
        candidateProject.localEvidencePackages.length > MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES
        || !fitsPortableBackupEnvelope(candidateProject)
      ) return fail(project, "INVALID_ARGUMENT", "The verified caption evidence would exceed CueBench's portable retained-evidence budget.");
      return commit(project, command, {
        evidence: candidateProject.evidence,
        localEvidencePackages: candidateProject.localEvidencePackages,
        ...withStaleArtifacts(project),
      }, item.itemId);
    }

    const sourcePackage = project.localAudioDescriptionEvidencePackages.find((entry) => entry.packageId === command.sourcePackageId);
    const sourceBinding = sourcePackage?.beatBindings.find((binding) => binding.itemId === item.itemId);
    if (
      sourcePackage === undefined
      || sourceBinding === undefined
      || sourcePackage.projectId !== project.projectId
      || sourcePackage.mediaSha256.toLowerCase() !== project.media.sha256.toLowerCase()
      || sourceBinding.evidenceIds.length !== command.verificationEvidenceIds.length
    ) return fail(project, "NOT_FOUND", "The retained audio-description evidence package cannot verify this revision.");
    const framesById = new Map(sourcePackage.evidence.frames.map((frame) => [frame.evidenceId, frame]));
    const sourceFrames = sourceBinding.evidenceIds.map((evidenceId) => framesById.get(evidenceId));
    if (sourceFrames.some((frame) => frame === undefined)) {
      return fail(project, "INVALID_ARGUMENT", "The retained audio-description binding no longer resolves to its source frames.");
    }
    const verifiedFrames = sourceFrames.map((frame, index) => ({
      ...clone(frame!),
      evidenceId: command.verificationEvidenceIds[index]!,
    }));
    const sourcePackageWithoutOutputHash = clone(sourcePackage);
    Reflect.deleteProperty(sourcePackageWithoutOutputHash, "outputSha256");
    const verificationPackage: LocalAudioDescriptionEvidencePackage = {
      ...clone(sourcePackageWithoutOutputHash),
      packageId: command.verificationPackageId,
      expectedProjectRevision: project.projectRevision,
      retainedAtMs: command.verifiedAtMs,
      verification: {
        kind: "HumanEvidenceVerification",
        eventId: `${project.projectId}:${project.projectRevision + 1}:${project.courtRecord.length + 1}`,
        sourcePackageId: command.sourcePackageId,
        actor: { type: "Human", id: command.actor.id },
        itemId: item.itemId,
        itemRevision: item.current.itemRevision,
      },
      evidence: { ...clone(sourcePackage.evidence), frames: verifiedFrames },
      beatBindings: [{
        beatId: item.itemId,
        itemId: item.itemId,
        itemRevision: item.current.itemRevision,
        evidenceIds: [...command.verificationEvidenceIds],
      }],
      requirementBindings: [],
    };
    const candidateProject: CaptionProject = {
      ...project,
      evidence: [...project.evidence, ...command.verificationEvidenceIds.map((evidenceId) => ({
        evidenceId,
        projectId: project.projectId,
        mediaSha256: project.media.sha256.toLowerCase(),
        itemId: item.itemId,
        itemRevision: item.current.itemRevision,
      }))],
      localAudioDescriptionEvidencePackages: [...project.localAudioDescriptionEvidencePackages, verificationPackage],
    };
    if (
      candidateProject.localAudioDescriptionEvidencePackages.length > MAX_LOCAL_AUDIO_DESCRIPTION_EVIDENCE_PACKAGES
      || !fitsPortableBackupEnvelope(candidateProject)
    ) return fail(project, "INVALID_ARGUMENT", "The verified audio-description evidence would exceed CueBench's portable retained-evidence budget.");
    return commit(project, command, {
      evidence: candidateProject.evidence,
      localAudioDescriptionEvidencePackages: candidateProject.localAudioDescriptionEvidencePackages,
      ...withStaleArtifacts(project),
    }, item.itemId);
  }

  if (command.type === "MarkItemAgentReady") {
    const leaseError = assertMutable(project, item.kind === "CaptionCue" ? "Captions" : "AudioDescriptions");
    if (leaseError !== undefined) return { project, events: [], error: leaseError };
    if (!sameBrowserAgent(command.actor, item.current.actor)) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "Only the Browser Agent that authored this revision may mark it Agent Ready.");
    if (item.current.state !== "Proposed") return fail(project, "INVALID_ARGUMENT", "Only Proposed work may be marked Agent Ready.");
    if (item.kind === "CaptionCue") {
      const revised = appendCaptionRevision(item, command.actor, "AgentReady", command.type);
      return commit(project, command, {
        captions: replaceCaption(project, revised),
        selectedItem: selectFor(revised),
        ...withStaleArtifacts(project),
      }, item.itemId);
    }
    const revised = appendAudioDescriptionRevision(item, command.actor, "AgentReady", command.type);
    return commit(project, command, {
      audioDescriptions: replaceAudioDescription(project, revised),
      selectedItem: selectFor(revised),
      ...withStaleArtifacts(project),
    }, item.itemId);
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
      return commit(project, command, {
        captions: replaceCaption(project, revised),
        selectedItem: selectFor(revised),
        ...withStaleArtifacts(project),
      }, item.itemId);
    }
    const revised = appendAudioDescriptionRevision(item, command.actor, state, cause);
    return commit(project, command, {
      audioDescriptions: replaceAudioDescription(project, revised),
      selectedItem: selectFor(revised),
      ...withStaleArtifacts(project),
    }, item.itemId);
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
      if (
        (item.current.state === "Sustained" || right.current.state === "Sustained")
        && !hasHumanAuthority(command.actor)
        && command.confirmedSustainedReopen !== true
      ) return fail(project, "HUMAN_AUTHORITY_REQUIRED", "A visible human confirmation is required before a Browser Agent reopens Sustained work.");
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
