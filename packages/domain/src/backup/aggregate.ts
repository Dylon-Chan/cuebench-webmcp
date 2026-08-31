import {
  CaptionProjectAggregateSchema,
  countJsonNodes,
  MAX_LOCAL_CAPTION_CUES,
  MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES,
  MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_WORDS,
  MAX_LOCAL_CAPTION_EVIDENCE_WORDS,
  MAX_PORTABLE_PROJECT_JSON_NODES,
} from "@cuebench/contracts";
import type { Actor } from "@cuebench/contracts";
import { exportProjectBackup } from "./schema";
import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  DomainEvent,
  EvidenceProvenance,
  ProjectCertification,
} from "../model";
import { canonicalSerialize } from "../quality/hash";
import {
  applicableWarningWaivers,
  certificationReadinessHashForSnapshot,
  certificationSnapshotHashFor,
  upgradeLegacyCertificationSnapshot,
  verifyCertificationSnapshot,
} from "../quality/certification";
import {
  buildValidationInput,
  currentValidationRun,
  semanticValidationInput,
  validateValidationInput,
  validationInputHash,
  validationInputHashFor,
  type ValidationInputSnapshot,
  type ValidationRun,
} from "../quality/validate";

/** Raised before an untrusted aggregate can become an editable import preview. */
export class CaptionProjectAggregateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CaptionProjectAggregateError";
  }
}

/**
 * Only the storage v0 migration may opt into a deliberately incomplete Court
 * Record. Current v1 import always proves the complete command history.
 */
export interface CaptionProjectAggregateValidationOptions {
  readonly allowLegacyCourtRecord?: boolean;
  /**
   * Set only after a current-v1 manifest has authenticated an original
   * aggregate that predates durable `validationHistory`. The compatibility
   * marker must be captured before the missing field is backfilled.
   */
  readonly allowPreHistoryValidationReplay?: boolean;
}

const clone = <Value>(value: Value): Value => structuredClone(value);
const sameValue = (left: unknown, right: unknown): boolean => canonicalSerialize(left) === canonicalSerialize(right);

const requireAggregate: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new CaptionProjectAggregateError(message);
};

const unique = (values: readonly string[], label: string): void => {
  requireAggregate(new Set(values).size === values.length, `${label} must be unique.`);
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

/**
 * b8/current-v1 backups persisted only their latest `validationRun`. Import
 * callers use this *before* backfill, after authenticating the v1 manifest,
 * to distinguish that exact wire shape from a current aggregate with an
 * intentionally truncated history.
 */
export const hasPreHistoryValidationReplay = (value: unknown): boolean => {
  const aggregate = record(value);
  return aggregate !== undefined
    && !Object.hasOwn(aggregate, "validationHistory")
    && aggregate.validationRun !== undefined
    && aggregate.validationRun !== null;
};

/**
 * v1 exports made before durable history fields existed are explicitly
 * normalized here. A present-but-empty history is not rewritten: only an
 * absent field represents that older wire shape.
 */
const normalizeLegacyHistories = (value: unknown): unknown => {
  const aggregate = record(value);
  if (aggregate === undefined) return value;
  const validationRun = aggregate.validationRun;
  return {
    ...aggregate,
    ...(!Object.hasOwn(aggregate, "validationHistory")
      ? { validationHistory: validationRun === undefined || validationRun === null ? [] : [validationRun] }
      : {}),
    ...(aggregate.exportHistory === undefined ? { exportHistory: [] } : {}),
  };
};

const assertRevisionActor = (actor: Actor, state: string): void => {
  requireAggregate(actor.type !== "System", "Item revisions require a named non-System actor.");
  if (state === "AgentReady") {
    requireAggregate(actor.type === "BrowserAgent", "Agent-ready revisions require BrowserAgent provenance.");
  }
  if (state === "Objected" || state === "Sustained") {
    requireAggregate(actor.type === "Human", "Objected and sustained revisions require Human provenance.");
  }
};

const assertRevisionHistory = (item: CaptionCue | AudioDescriptionBeat, project: CaptionProject): void => {
  for (let index = 0; index < item.revisions.length; index += 1) {
    const revision = item.revisions[index]!;
    requireAggregate(revision.itemId === item.itemId && revision.kind === item.kind, "Revision does not belong to its item.");
    requireAggregate(
      revision.itemRevision === index + 1 && revision.parentItemRevision === (index === 0 ? null : index),
      "Revision history must be contiguous and immutable.",
    );
    requireAggregate(
      revision.startMs >= 0 && revision.startMs < revision.endMs && revision.endMs <= project.media.durationMs,
      "Revision timing falls outside the project media duration.",
    );
    assertRevisionActor(revision.actor, revision.state);
  }
  requireAggregate(sameValue(item.revisions.at(-1), item.current), "Item current revision does not equal its immutable history tail.");
};

const assertTrackOrder = (order: readonly string[], expectedIds: readonly string[], label: string): void => {
  const actual = new Set(order);
  requireAggregate(
    actual.size === order.length && actual.size === expectedIds.length && expectedIds.every((itemId) => actual.has(itemId)),
    `${label} must contain every live item exactly once.`,
  );
};

const currentItemBindings = (project: CaptionProject): ProjectCertification["itemRevisions"] => {
  const input = buildValidationInput(project);
  return [...input.captions.items, ...input.audioDescriptions.items]
    .map((item) => ({ kind: item.kind, itemId: item.itemId, itemRevision: item.itemRevision }));
};

const canonicalEvidence = (evidence: readonly EvidenceProvenance[]): readonly EvidenceProvenance[] =>
  [...evidence].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

/** Proves retained local transcript content still resolves through project provenance. */
const assertLocalEvidencePackages = (project: CaptionProject): void => {
  unique(project.localEvidencePackages.map((entry) => entry.packageId), "Local Evidence Package ids");
  requireAggregate(project.localEvidencePackages.length <= MAX_LOCAL_CAPTION_EVIDENCE_PACKAGES, "Local Evidence Packages exceed the retained bound.");
  requireAggregate(
    new TextEncoder().encode(canonicalSerialize(project.localEvidencePackages)).byteLength <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_BYTES,
    "Local Evidence Packages exceed the backup-safe retained byte budget.",
  );
  requireAggregate(
    countJsonNodes(project.localEvidencePackages) <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_JSON_NODES,
    "Local Evidence Packages exceed the backup-safe retained JSON-node budget.",
  );
  requireAggregate(
    project.localEvidencePackages.reduce((total, entry) => total + entry.evidence.words.length, 0) <= MAX_LOCAL_CAPTION_EVIDENCE_TOTAL_WORDS,
    "Local Evidence Packages exceed the shared retained word budget.",
  );
  const projectEvidence = new Map(project.evidence.map((entry) => [entry.evidenceId, entry]));
  for (const entry of project.localEvidencePackages) {
    requireAggregate(
      entry.projectId === project.projectId && entry.mediaSha256.toLowerCase() === project.media.sha256.toLowerCase(),
      "Local Evidence Package belongs to another project or media source.",
    );
    const words = new Set(entry.evidence.words.map((word) => word.evidenceId));
    requireAggregate(entry.evidence.words.length <= MAX_LOCAL_CAPTION_EVIDENCE_WORDS, "Local Evidence Package exceeds the retained word bound.");
    requireAggregate(entry.cueBindings.length <= MAX_LOCAL_CAPTION_CUES, "Local Evidence Package exceeds the retained cue-binding bound.");
    for (const binding of entry.cueBindings) {
      const item = project.captions.items[binding.itemId];
      requireAggregate(
        item !== undefined
          && binding.cueId === binding.itemId
          && item.revisions.some((revision) => revision.itemRevision === binding.itemRevision),
        "Local Evidence Package cue binding references an unknown caption revision.",
      );
      for (const evidenceId of binding.evidenceIds) {
        const provenance = projectEvidence.get(evidenceId);
        requireAggregate(
          words.has(evidenceId)
            && provenance !== undefined
            && provenance.itemId === binding.itemId,
          "Local Evidence Package word does not resolve through canonical cue provenance.",
        );
      }
    }
  }
};

const assertValidationRun = (run: ValidationRun, project: CaptionProject, label: string): void => {
  requireAggregate(run.projectId === project.projectId && run.input.projectId === project.projectId, `${label} belongs to another project.`);
  requireAggregate(run.projectRevision === run.input.projectRevision, `${label} revision does not match its immutable input.`);
  requireAggregate(
    run.profileId === run.input.qualityProfile.profileId && run.profileRevision === run.input.qualityProfile.revision,
    `${label} profile does not match its immutable input.`,
  );
  requireAggregate(run.inputHash === validationInputHashFor(run.input), `${label} input hash is invalid.`);
  let recomputed: ValidationRun;
  try {
    recomputed = validateValidationInput(run.input);
  } catch (error) {
    throw new CaptionProjectAggregateError(`${label} input is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  requireAggregate(
    sameValue(recomputed.findings, run.findings)
      && sameValue(recomputed.blockers, run.blockers)
      && sameValue(recomputed.warnings, run.warnings)
      && recomputed.blockerCount === run.blockerCount
      && recomputed.warningCount === run.warningCount,
    `${label} findings are not the deterministic result of its input.`,
  );
};

const assertCertificationPointer = (project: CaptionProject): void => {
  unique(project.certifications.map((certification) => certification.certificationId), "Certification ids");
  for (const certification of project.certifications) {
    requireAggregate(verifyCertificationSnapshot(certification), "Certification snapshot signature or structure is invalid.");
    requireAggregate(
      certification.validationRun.projectId === project.projectId
        && certification.validationRun.input.projectId === project.projectId,
      "Certification validation run belongs to another project.",
    );
  }
  if (project.certification.status === "NotCertified") return;
  const pointer = project.certification;
  const snapshot = project.certifications.find((candidate) => candidate.certificationId === pointer.certificationId);
  if (snapshot === undefined) throw new CaptionProjectAggregateError("Certification pointer has no immutable snapshot.");
  if (project.certification.status === "Stale") return;
  requireAggregate(
    project.validation.status === "Current"
      && project.validationRun !== null
      && sameValue(snapshot.media, project.media)
      && sameValue(snapshot.evidence, canonicalEvidence(project.evidence))
      && sameValue(snapshot.itemRevisions, currentItemBindings(project))
      && sameValue(snapshot.qualityProfile, project.qualityProfile)
      && sameValue(snapshot.validationRun, project.validationRun)
      && snapshot.validationRun.inputHash === validationInputHash(project)
      && sameValue(
        semanticValidationInput(snapshot.validationRun.input),
        semanticValidationInput(buildValidationInput(project)),
      )
      && sameValue(snapshot.warningWaivers, applicableWarningWaivers(project, currentValidationRun(project)?.warnings ?? [])),
    "Current certification does not bind the current project projection.",
  );
};

const courtActors: Readonly<Record<string, readonly Actor["type"][]>> = {
  SelectItem: ["Human", "BrowserAgent", "CueBenchAI", "System"],
  FocusItem: ["Human", "BrowserAgent", "CueBenchAI", "System"],
  FocusGap: ["Human", "BrowserAgent", "CueBenchAI", "System"],
  AdjustCueTiming: ["Human", "BrowserAgent", "CueBenchAI"],
  SplitCue: ["Human", "BrowserAgent", "CueBenchAI"],
  MergeCue: ["Human", "BrowserAgent", "CueBenchAI"],
  ReviseCue: ["Human", "BrowserAgent", "CueBenchAI"],
  AdjustAudioDescriptionTiming: ["Human", "BrowserAgent", "CueBenchAI"],
  ReviseAudioDescription: ["Human", "BrowserAgent", "CueBenchAI"],
  ProposeAudioDescriptionInGap: ["Human", "BrowserAgent", "CueBenchAI"],
  MarkItemAgentReady: ["BrowserAgent"],
  ObjectItem: ["Human"],
  SustainItem: ["Human"],
  ValidateProject: ["System"],
  RecordExportRoundTrip: ["System"],
  WaiveWarning: ["Human"],
  CertifyProject: ["Human"],
  ApplyProfile: ["Human"],
  RelinkMedia: ["Human"],
  StartGenerationRun: ["CueBenchAI"],
  AdoptCaptionGenerationResult: ["CueBenchAI"],
  ReleaseGenerationRun: ["CueBenchAI", "System", "Human"],
  ExportRoundTripVerified: ["System"],
  GenerationRunStageChanged: ["System"],
  ProjectSerialized: ["System"],
  RecoveryPerformed: ["System"],
  ValidationMigrated: ["System"],
  LegacyItemRevisionPayloadHistoryUnavailable: ["System"],
};

const itemCourtEventTypes = new Set([
  "SelectItem",
  "FocusItem",
  "AdjustCueTiming",
  "SplitCue",
  "MergeCue",
  "ReviseCue",
  "AdjustAudioDescriptionTiming",
  "ReviseAudioDescription",
  "ProposeAudioDescriptionInGap",
  "AdoptCaptionGenerationResult",
  "MarkItemAgentReady",
  "ObjectItem",
  "SustainItem",
]);

const revisionChangingCourtEventTypes = new Set([
  "AdjustCueTiming",
  "SplitCue",
  "MergeCue",
  "ReviseCue",
  "AdjustAudioDescriptionTiming",
  "ReviseAudioDescription",
  "ProposeAudioDescriptionInGap",
  "AdoptCaptionGenerationResult",
  "MarkItemAgentReady",
  "ObjectItem",
  "SustainItem",
]);

const sameActor = (left: Actor, right: Actor): boolean => left.type === right.type && left.id === right.id;

type ProjectItem = CaptionCue | AudioDescriptionBeat;
type ProjectItemRevision = CaptionCue["revisions"][number] | AudioDescriptionBeat["revisions"][number];

const allItems = (project: CaptionProject): readonly ProjectItem[] => [
  ...Object.values(project.captions.items),
  ...Object.values(project.audioDescriptions.items),
];

const itemForCourtEvent = (project: CaptionProject, event: DomainEvent): ProjectItem => {
  requireAggregate(event.itemId !== undefined, `Court Record ${event.type} requires an item id.`);
  const item = project.captions.items[event.itemId] ?? project.audioDescriptions.items[event.itemId];
  requireAggregate(item !== undefined, `Court Record ${event.type} references an unknown item.`);
  return item;
};

const revisionClaim = (item: ProjectItem, itemRevision: number): string =>
  `${item.kind}\u0000${item.itemId}\u0000${itemRevision}`;

const withoutRevisionFields = (
  revision: ProjectItemRevision,
  ignored: readonly string[],
): Readonly<Record<string, unknown>> => {
  const copy: Record<string, unknown> = { ...revision };
  for (const field of ignored) Reflect.deleteProperty(copy, field);
  return copy;
};

const assertExactRevisionTransition = (
  predecessor: ProjectItemRevision,
  successor: ProjectItemRevision,
  event: DomainEvent,
  input: {
    readonly resultingState: ProjectItemRevision["state"];
    readonly cause: string;
    readonly mutableFields?: readonly string[];
    readonly predecessorStates?: readonly ProjectItemRevision["state"][];
    readonly requireSamePredecessorActor?: boolean;
  },
): void => {
  requireAggregate(
    successor.itemId === predecessor.itemId
      && successor.kind === predecessor.kind
      && successor.itemRevision === predecessor.itemRevision + 1
      && successor.parentItemRevision === predecessor.itemRevision,
    `Court Record ${event.type} does not bind adjacent immutable item revisions.`,
  );
  requireAggregate(
    successor.state === input.resultingState
      && successor.cause === input.cause
      && sameActor(successor.actor, event.actor),
    `Court Record ${event.type} does not bind its recorded actor, cause, and resulting state.`,
  );
  if (input.predecessorStates !== undefined) {
    requireAggregate(
      input.predecessorStates.includes(predecessor.state),
      `Court Record ${event.type} has an impossible predecessor review state.`,
    );
  }
  if (input.requireSamePredecessorActor === true) {
    requireAggregate(
      sameActor(predecessor.actor, event.actor),
      `Court Record ${event.type} must be performed by the authoring BrowserAgent.`,
    );
  }
  const ignored = ["itemRevision", "parentItemRevision", "state", "actor", "cause", ...(input.mutableFields ?? [])];
  requireAggregate(
    sameValue(withoutRevisionFields(predecessor, ignored), withoutRevisionFields(successor, ignored)),
    `Court Record ${event.type} changes fields outside its legal predecessor-to-successor diff.`,
  );
};

const nextUnclaimedSuccessor = (
  item: ProjectItem,
  claimed: ReadonlySet<string>,
  predicate: (revision: ProjectItemRevision) => boolean,
  event: DomainEvent,
): { readonly predecessor: ProjectItemRevision; readonly successor: ProjectItemRevision } => {
  for (let index = 1; index < item.revisions.length; index += 1) {
    const successor = item.revisions[index]!;
    if (!claimed.has(revisionClaim(item, successor.itemRevision)) && predicate(successor)) {
      return { predecessor: item.revisions[index - 1]!, successor };
    }
  }
  throw new CaptionProjectAggregateError(`Court Record ${event.type} has no matching immutable item successor.`);
};

const claimRevision = (claimed: Set<string>, item: ProjectItem, revision: ProjectItemRevision, event: DomainEvent): void => {
  const key = revisionClaim(item, revision.itemRevision);
  requireAggregate(!claimed.has(key), `Court Record ${event.type} reuses an immutable item successor.`);
  claimed.add(key);
};

const assertCurrentRevisionEvent = (
  project: CaptionProject,
  event: DomainEvent,
  claimed: Set<string>,
): void => {
  if (event.type === "AdoptCaptionGenerationResult") {
    const runId = event.detail?.startsWith("generation:") === true ? event.detail.slice("generation:".length) : null;
    requireAggregate(
      (runId !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(runId)) || event.detail === undefined,
      "Court Record adoption must retain a canonical generation run id.",
    );
    const created = Object.values(project.captions.items).filter((item) => {
      const initial = item.revisions[0]!;
      return initial.itemRevision === 1
        && initial.parentItemRevision === null
        && initial.state === "Proposed"
        // b13 used an unscoped cause/detail. Its manifest remains
        // authenticated, so import may preserve it read-write; new output is
        // always run-scoped and receives the stronger one-event proof below.
        && initial.cause === (runId === null ? "AdoptCaptionGenerationResult" : `AdoptCaptionGenerationResult:${runId}`)
        && sameActor(initial.actor, event.actor);
    });
    if (event.itemId === undefined) {
      // A genuine silent-media result is an explicit, complete generation
      // adoption with no caption item/revision transition. Its run-scoped
      // Local Evidence Package remains the durable proof, rather than forcing
      // an impossible synthetic cue into exports/backups.
      requireAggregate(runId !== null, "An itemless Court Record adoption must retain its canonical generation run id.");
      requireAggregate(created.length === 0, "An itemless Court Record adoption cannot create caption revisions.");
      requireAggregate(
        project.localEvidencePackages.some((entry) => entry.runId === runId && entry.cueBindings.length === 0),
        "An itemless Court Record adoption has no matching silent Local Evidence Package.",
      );
      return;
    }
    const primary = itemForCourtEvent(project, event);
    requireAggregate(primary.kind === "CaptionCue", "Court Record adoption must target its first generated caption.");
    requireAggregate(created.length > 0 && created.some((item) => item.itemId === primary.itemId), "Court Record adoption has no matching generated caption set.");
    if (runId !== null) {
      for (const item of created) claimRevision(claimed, item, item.revisions[0]!, event);
    }
    return;
  }
  if (!revisionChangingCourtEventTypes.has(event.type)) return;
  const item = itemForCourtEvent(project, event);
  const successorFor = (
    predicate: (revision: ProjectItemRevision) => boolean,
  ) => nextUnclaimedSuccessor(item, claimed, predicate, event);
  const standard = (
    resultingState: ProjectItemRevision["state"],
    cause: string,
    mutableFields: readonly string[] = [],
    predecessorStates?: readonly ProjectItemRevision["state"][],
    requireSamePredecessorActor?: boolean,
  ) => {
    const pair = successorFor((revision) =>
      revision.state === resultingState && revision.cause === cause && sameActor(revision.actor, event.actor));
    assertExactRevisionTransition(pair.predecessor, pair.successor, event, {
      resultingState,
      cause,
      mutableFields,
      ...(predecessorStates === undefined ? {} : { predecessorStates }),
      ...(requireSamePredecessorActor === undefined ? {} : { requireSamePredecessorActor }),
    });
    claimRevision(claimed, item, pair.successor, event);
    return pair;
  };

  if (event.type === "MarkItemAgentReady") {
    standard("AgentReady", event.type, [], ["Proposed"], true);
    return;
  }
  if (event.type === "ObjectItem") {
    requireAggregate(typeof event.detail === "string" && event.detail.trim().length > 0, "Court Record objection requires its durable reason.");
    standard("Objected", event.detail);
    return;
  }
  if (event.type === "SustainItem") {
    standard("Sustained", event.type);
    return;
  }
  if (event.type === "AdjustCueTiming") {
    requireAggregate(item.kind === "CaptionCue", "Court Record AdjustCueTiming must target a caption.");
    standard("Proposed", event.type, ["startMs", "endMs"]);
    return;
  }
  if (event.type === "ReviseCue") {
    requireAggregate(item.kind === "CaptionCue", "Court Record ReviseCue must target a caption.");
    standard("Proposed", event.type, ["text", "speaker", "startMs", "endMs"]);
    return;
  }
  if (event.type === "AdjustAudioDescriptionTiming") {
    requireAggregate(item.kind === "AudioDescriptionBeat", "Court Record AdjustAudioDescriptionTiming must target an audio description.");
    standard("Proposed", event.type, ["startMs", "endMs"]);
    return;
  }
  if (event.type === "ReviseAudioDescription") {
    requireAggregate(item.kind === "AudioDescriptionBeat", "Court Record ReviseAudioDescription must target an audio description.");
    standard("Proposed", event.type, ["description", "startMs", "endMs"]);
    return;
  }
  if (event.type === "ProposeAudioDescriptionInGap") {
    requireAggregate(item.kind === "AudioDescriptionBeat", "Court Record ProposeAudioDescriptionInGap must target an audio description.");
    const initial = item.revisions[0]!;
    requireAggregate(
      initial.itemRevision === 1
        && initial.parentItemRevision === null
        && initial.state === "Proposed"
        && initial.cause === event.type
        && sameActor(initial.actor, event.actor),
      "Court Record ProposeAudioDescriptionInGap does not bind its created audio-description revision.",
    );
    const consumedGap = Object.values(project.audioDescriptionGaps).some((gap) =>
      gap.state === "Consumed" && initial.startMs >= gap.startMs && initial.endMs <= gap.endMs);
    requireAggregate(consumedGap, "Court Record ProposeAudioDescriptionInGap has no matching consumed gap.");
    claimRevision(claimed, item, initial, event);
    return;
  }
  if (event.type === "SplitCue") {
    requireAggregate(item.kind === "CaptionCue", "Court Record SplitCue must target a caption.");
    const pair = standard("Proposed", event.type, ["endMs"]);
    const predecessor = pair.predecessor as CaptionCue["revisions"][number];
    const successor = pair.successor as CaptionCue["revisions"][number];
    requireAggregate(
      successor.endMs > predecessor.startMs && successor.endMs < predecessor.endMs,
      "Court Record SplitCue has an impossible left-cue timing transition.",
    );
    const rightCandidates = Object.values(project.captions.items).filter((candidate) => {
      const initial = candidate.revisions[0]!;
      return candidate.itemId !== item.itemId
        && !claimed.has(revisionClaim(candidate, initial.itemRevision))
        && initial.itemRevision === 1
        && initial.parentItemRevision === null
        && initial.state === "Proposed"
        && initial.cause === event.type
        && sameActor(initial.actor, event.actor)
        && initial.startMs === successor.endMs
        && initial.endMs === predecessor.endMs
        && initial.text === predecessor.text
        && initial.speaker === predecessor.speaker;
    });
    requireAggregate(rightCandidates.length === 1, "Court Record SplitCue has no unique matching created right cue.");
    claimRevision(claimed, rightCandidates[0]!, rightCandidates[0]!.revisions[0]!, event);
    return;
  }
  if (event.type === "MergeCue") {
    requireAggregate(item.kind === "CaptionCue", "Court Record MergeCue must target a caption.");
    const pair = standard("Proposed", event.type, ["endMs", "text"]);
    const predecessor = pair.predecessor as CaptionCue["revisions"][number];
    const successor = pair.successor as CaptionCue["revisions"][number];
    const rightCandidates = Object.values(project.captions.items).flatMap((candidate) => candidate.revisions.slice(1).map((successor, index) => ({
      item: candidate,
      predecessor: candidate.revisions[index]!,
      successor,
    }))).filter((candidate) =>
      candidate.item.itemId !== item.itemId
      && candidate.item.mergedIntoItemId === item.itemId
      && !claimed.has(revisionClaim(candidate.item, candidate.successor.itemRevision))
      && candidate.successor.state === "Proposed"
      && candidate.successor.cause === `MergedInto:${item.itemId}`
      && sameActor(candidate.successor.actor, event.actor));
    requireAggregate(rightCandidates.length === 1, "Court Record MergeCue has no unique matching merged-right cue transition.");
    const right = rightCandidates[0]!;
    assertExactRevisionTransition(right.predecessor, right.successor, event, {
      resultingState: "Proposed",
      cause: `MergedInto:${item.itemId}`,
    });
    if (right.predecessor.state === "Sustained") {
      requireAggregate(event.actor.type === "Human", "Only a Human may merge a sustained right cue.");
    }
    requireAggregate(
      right.predecessor.startMs >= predecessor.startMs
        && successor.endMs === Math.max(predecessor.endMs, right.predecessor.endMs)
        && successor.text === `${predecessor.text} ${right.predecessor.text}`.trim(),
      "Court Record MergeCue does not bind the exact predecessor-to-successor merge diff.",
    );
    claimRevision(claimed, right.item, right.successor, event);
    return;
  }
  throw new CaptionProjectAggregateError(`Court Record ${event.type} is not a supported revision transition.`);
};

const assertLegacyCourtRecord = (project: CaptionProject, events: readonly DomainEvent[]): void => {
  let previousRevision = 0;
  for (const event of events) {
    requireAggregate(
      event.projectRevision >= 1 && event.projectRevision <= project.projectRevision,
      "Legacy Court Record event has an illegal project revision.",
    );
    requireAggregate(event.projectRevision >= previousRevision, "Legacy Court Record events must be ordered by project revision.");
    previousRevision = event.projectRevision;
    /** The aggregate schema already proves a known Actor shape; legacy event semantics are opaque. */
    requireAggregate(event.actor.id.trim().length > 0, "Legacy Court Record actor must be named.");
  }
};

const assertSideHistoryEvents = (
  project: CaptionProject,
  events: readonly DomainEvent[],
  options: CaptionProjectAggregateValidationOptions,
): void => {
  const eventsOf = (type: string) => events.filter((event) => event.type === type);

  const validations = eventsOf("ValidateProject");
  if (options.allowPreHistoryValidationReplay === true) {
    requireAggregate(
      validations.length >= project.validationHistory.length,
      "Pre-history validation replay cannot omit the retained durable validation run.",
    );
  } else {
    requireAggregate(validations.length === project.validationHistory.length, "Validation history and Court Record ValidateProject events must agree.");
  }
  const retainedValidationEventIds = new Set<string>();
  for (const run of project.validationHistory) {
    const matching = validations.filter((event) => event.projectRevision === run.projectRevision);
    requireAggregate(
      matching.length === 1,
      "Each durable validation run requires one matching Court Record ValidateProject event.",
    );
    retainedValidationEventIds.add(matching[0]!.eventId);
  }
  if (options.allowPreHistoryValidationReplay === true) {
    const oldestRetainedRevision = project.validationHistory[0]?.projectRevision;
    for (const event of validations) {
      if (retainedValidationEventIds.has(event.eventId)) continue;
      requireAggregate(
        oldestRetainedRevision !== undefined && event.projectRevision < oldestRetainedRevision,
        "Pre-history validation replay may contain only older unmatched System ValidateProject events.",
      );
    }
  }

  const exports = eventsOf("RecordExportRoundTrip");
  requireAggregate(exports.length === project.exportHistory.length, "Export verification history and Court Record events must agree.");
  for (const exported of project.exportHistory) {
    requireAggregate(
      exports.filter((event) => event.projectRevision === exported.projectRevision + 1).length === 1,
      "Each export verification requires one matching Court Record event.",
    );
  }

  const waivers = Object.values(project.warningWaivers);
  const waiverEvents = eventsOf("WaiveWarning");
  const currentWaiverEventIds = new Set<string>();
  for (const waiver of waivers) {
    const matching = waiverEvents.filter((event) => event.projectRevision === waiver.projectRevision && sameActor(event.actor, waiver.actor));
    requireAggregate(
      matching.length === 1 && !currentWaiverEventIds.has(matching[0]!.eventId),
      "Each current warning waiver requires its latest matching Court Record event.",
    );
    currentWaiverEventIds.add(matching[0]!.eventId);
  }
  /**
   * A finding id is intentionally not embedded in a DomainEvent. Repeated
   * waivers therefore leave historical Human events after the map projects
   * only the latest waiver for that finding. Each unmatched event still needs
   * a durable earlier validation containing at least one warning.
   */
  for (const event of waiverEvents) {
    if (currentWaiverEventIds.has(event.eventId)) continue;
    requireAggregate(
      project.validationHistory.some((run) => run.projectRevision < event.projectRevision && run.warnings.length > 0),
      "Historical warning waiver has no durable warning validation predecessor.",
    );
  }

  const certificationEvents = eventsOf("CertifyProject");
  requireAggregate(certificationEvents.length === project.certifications.length, "Certification history and Court Record events must agree.");
  for (let index = 0; index < project.certifications.length; index += 1) {
    const certification = project.certifications[index]!;
    const event = certificationEvents[index];
    requireAggregate(
      event !== undefined
        && sameActor(event.actor, certification.actor)
        && event.projectRevision > certification.validationRun.projectRevision,
      "Each certification requires its ordered Human Court Record event.",
    );
  }
};

/**
 * Older v1 aggregates retained only the latest validation payload. That is
 * the sole gap we can safely replay after a manifest authenticates the
 * original pre-history shape. Other command types without durable projection
 * data (for example ApplyProfile or app lifecycle events) must be migrated
 * manually instead of being trusted as editable import history.
 */
const assertPreHistoryCompatibilityEvents = (project: CaptionProject, events: readonly DomainEvent[]): void => {
  const provenEventTypes = new Set<string>([
    ...revisionChangingCourtEventTypes,
    "RecordExportRoundTrip",
    "WaiveWarning",
    "CertifyProject",
  ]);
  const retainedValidationRevisions = new Set(project.validationHistory.map((run) => run.projectRevision));
  const oldestRetainedValidationRevision = project.validationHistory[0]?.projectRevision;

  for (const event of events) {
    if (provenEventTypes.has(event.type)) continue;
    if (event.type === "ValidateProject") {
      requireAggregate(
        event.actor.type === "System"
          && (
            retainedValidationRevisions.has(event.projectRevision)
            || (oldestRetainedValidationRevision !== undefined && event.projectRevision < oldestRetainedValidationRevision)
          ),
        "Authenticated pre-history v1 may replay only ordered System ValidateProject events without durable validation history.",
      );
      continue;
    }
    throw new CaptionProjectAggregateError(
      `Authenticated pre-history v1 cannot prove Court Record ${event.type}; import requires manual migration.`,
    );
  }
};

const assertCurrentCourtRecord = (
  project: CaptionProject,
  events: readonly DomainEvent[],
  options: CaptionProjectAggregateValidationOptions,
): void => {
  requireAggregate(
    events.length === project.projectRevision - 1,
    "Current v1 Court Record must contain one event for every post-creation project revision.",
  );
  if (events.length === 0) return;

  const claimed = new Set<string>();
  let projectedSelection: { readonly kind: "CaptionCue" | "AudioDescriptionBeat" | "AudioDescriptionGap"; readonly itemId: string } | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    requireAggregate(
      event.projectRevision === index + 2
        && event.eventId === `${project.projectId}:${event.projectRevision}:${index + 1}`,
      "Current v1 Court Record must be ordered, complete, and canonically identified.",
    );
    const allowedActors = courtActors[event.type];
    requireAggregate(allowedActors !== undefined && event.type !== "LegacyItemRevisionPayloadHistoryUnavailable", `Court Record event type ${event.type} is not a current durable command.`);
    requireAggregate(allowedActors.includes(event.actor.type), `Court Record ${event.type} has invalid actor provenance.`);
    if (event.type !== "ObjectItem" && event.type !== "AdoptCaptionGenerationResult") {
      requireAggregate(event.detail === undefined, `Court Record ${event.type} cannot carry arbitrary detail.`);
    }

    let eventItem: ProjectItem | undefined;
    if (event.type === "FocusGap") {
      requireAggregate(event.itemId !== undefined && project.audioDescriptionGaps[event.itemId] !== undefined, "Court Record FocusGap references an unknown gap.");
      projectedSelection = { kind: "AudioDescriptionGap", itemId: event.itemId };
    } else if (itemCourtEventTypes.has(event.type) && !(event.type === "AdoptCaptionGenerationResult" && event.itemId === undefined)) {
      eventItem = itemForCourtEvent(project, event);
    } else if (["ValidateProject", "RecordExportRoundTrip", "WaiveWarning", "CertifyProject", "ApplyProfile", "RelinkMedia", "StartGenerationRun", "ReleaseGenerationRun"].includes(event.type)) {
      requireAggregate(event.itemId === undefined, `Court Record ${event.type} cannot target an item.`);
    }
    assertCurrentRevisionEvent(project, event, claimed);
    if (eventItem !== undefined && (
      event.type === "SelectItem"
      || event.type === "FocusItem"
      || revisionChangingCourtEventTypes.has(event.type)
    )) {
      projectedSelection = { kind: eventItem.kind, itemId: eventItem.itemId };
    }
  }

  for (const item of allItems(project)) {
    for (const successor of item.revisions.slice(1)) {
      requireAggregate(
        claimed.has(revisionClaim(item, successor.itemRevision)),
        "Every successor item revision requires its exact Court Record transition.",
      );
    }
  }
  for (const item of Object.values(project.audioDescriptions.items)) {
    const initial = item.revisions[0]!;
    if (initial.cause === "ProposeAudioDescriptionInGap") {
      requireAggregate(claimed.has(revisionClaim(item, initial.itemRevision)), "Proposed-in-gap audio description is missing its Court Record event.");
    }
  }

  assertSideHistoryEvents(project, events, options);
  if (options.allowPreHistoryValidationReplay === true) {
    assertPreHistoryCompatibilityEvents(project, events);
  }
  if (projectedSelection === null) {
    requireAggregate(
      project.selectedItem === null,
      "Court Record selection history does not match the current project selection.",
    );
  } else {
    requireAggregate(
      project.selectedItem !== null
        && project.selectedItem.kind === projectedSelection.kind
        && project.selectedItem.itemId === projectedSelection.itemId,
      "Court Record selection history does not match the current project selection.",
    );
  }
};

const assertCourtRecord = (
  project: CaptionProject,
  options: CaptionProjectAggregateValidationOptions,
): void => {
  const legacy = options.allowLegacyCourtRecord === true;
  const events = project.courtRecord;
  unique(events.map((event) => event.eventId), "Court Record event ids");
  if (legacy) {
    assertLegacyCourtRecord(project, events);
    return;
  }
  /** Current-v1 count is checked before an empty record can be accepted. */
  assertCurrentCourtRecord(project, events, options);
};

const normalizedMedia = <Media extends { readonly sha256: string }>(media: Media): Media => ({
  ...media,
  sha256: media.sha256.toLowerCase(),
});

const normalizedEvidence = <Evidence extends { readonly mediaSha256: string }>(
  evidence: readonly Evidence[],
): readonly Evidence[] => evidence.map((entry) => ({ ...entry, mediaSha256: entry.mediaSha256.toLowerCase() }));

const normalizedValidationInput = (input: ValidationInputSnapshot): ValidationInputSnapshot => ({
  ...input,
  media: normalizedMedia(input.media),
  evidence: normalizedEvidence(input.evidence),
});

const normalizedValidationRun = (run: ValidationRun): ValidationRun =>
  validateValidationInput(normalizedValidationInput(run.input));

const normalizedCertification = (certification: ProjectCertification): ProjectCertification => {
  const { certificationSnapshotHash: _previousHash, ...content } = certification;
  void _previousHash;
  const withoutHash: Omit<ProjectCertification, "certificationSnapshotHash"> = {
    ...content,
    media: normalizedMedia(certification.media),
    evidence: normalizedEvidence(certification.evidence),
    validationRun: normalizedValidationRun(certification.validationRun),
  };
  const readinessHash = certificationReadinessHashForSnapshot({
    ...withoutHash,
    certificationSnapshotHash: `sha256:v2:${"0".repeat(64)}`,
  });
  const normalizedContent = { ...withoutHash, readinessHash };
  return {
    ...normalizedContent,
    certificationSnapshotHash: certificationSnapshotHashFor(normalizedContent),
  };
};

/** Normalizes only raw media-digest casing after the original aggregate authenticates. */
const normalizeMediaDigestCasing = (project: CaptionProject): CaptionProject => ({
  ...project,
  media: normalizedMedia(project.media),
  evidence: normalizedEvidence(project.evidence),
  validationRun: project.validationRun === null ? null : normalizedValidationRun(project.validationRun),
  validationHistory: project.validationHistory.map(normalizedValidationRun),
  certifications: project.certifications.map(normalizedCertification),
});

const assertRelationships = (
  project: CaptionProject,
  options: CaptionProjectAggregateValidationOptions,
): void => {
  const globalIds = new Set<string>();
  const claimGlobalId = (id: string) => {
    requireAggregate(!globalIds.has(id), "Caption, audio-description, and gap ids must be globally unique.");
    globalIds.add(id);
  };
  for (const [itemId, item] of Object.entries(project.captions.items)) {
    requireAggregate(item.itemId === itemId, "Caption item map key does not match its item id.");
    claimGlobalId(itemId);
    assertRevisionHistory(item, project);
    requireAggregate(
      item.mergedIntoItemId === null || (
        item.mergedIntoItemId !== item.itemId && project.captions.items[item.mergedIntoItemId] !== undefined
      ),
      "Merged caption target is invalid.",
    );
  }
  for (const [itemId, item] of Object.entries(project.audioDescriptions.items)) {
    requireAggregate(item.itemId === itemId, "Audio-description item map key does not match its item id.");
    claimGlobalId(itemId);
    assertRevisionHistory(item, project);
  }
  assertTrackOrder(
    project.captions.order,
    Object.values(project.captions.items).filter((item) => item.mergedIntoItemId === null).map((item) => item.itemId),
    "Caption order",
  );
  assertTrackOrder(
    project.audioDescriptions.order,
    Object.values(project.audioDescriptions.items).map((item) => item.itemId),
    "Audio-description order",
  );
  for (const [gapId, gap] of Object.entries(project.audioDescriptionGaps)) {
    claimGlobalId(gapId);
    requireAggregate(
      gap.gapId === gapId && gap.startMs >= 0 && gap.startMs < gap.endMs && gap.endMs <= project.media.durationMs,
      "Audio-description gap is invalid.",
    );
  }
  unique(project.evidence.map((entry) => entry.evidenceId), "Evidence ids");
  for (const evidence of project.evidence) {
    requireAggregate(evidence.projectId === project.projectId, "Evidence belongs to another project.");
    if (evidence.itemId !== null) {
      const item = project.captions.items[evidence.itemId] ?? project.audioDescriptions.items[evidence.itemId];
      requireAggregate(
        item !== undefined && item.revisions.some((revision) => revision.itemRevision === evidence.itemRevision),
        "Evidence references an unknown item revision.",
      );
    }
  }
  assertLocalEvidencePackages(project);
  requireAggregate(
    countJsonNodes(project) <= MAX_PORTABLE_PROJECT_JSON_NODES,
    "CaptionProject exceeds the browser backup JSON-node budget.",
  );
  if (project.selectedItem !== null) {
    if (project.selectedItem.kind === "AudioDescriptionGap") {
      const gap = project.audioDescriptionGaps[project.selectedItem.itemId];
      requireAggregate(
        gap !== undefined && gap.state === "Available" && gap.gapRevision === project.selectedItem.itemRevision,
        "Selected gap is no longer current.",
      );
    } else {
      const item = project.captions.items[project.selectedItem.itemId]
        ?? project.audioDescriptions.items[project.selectedItem.itemId];
      requireAggregate(
        item !== undefined
          && item.kind === project.selectedItem.kind
          && item.current.itemRevision === project.selectedItem.itemRevision,
        "Selected item is no longer current.",
      );
    }
  }
  requireAggregate(
    project.validation.status !== "Current" || project.validationRun !== null,
    "Current validation has no persisted validation run.",
  );
  if (project.validationRun !== null) {
    assertValidationRun(project.validationRun, project, "Validation run");
  }
  if (project.validation.status === "Current") {
    const current = currentValidationRun(project);
    requireAggregate(
      current !== undefined
        && project.validation.blockerCount === project.validationRun!.blockerCount
        && project.validation.warningCount === project.validationRun!.warningCount,
      "Current validation does not bind the current project projection.",
    );
  }
  let previousValidationRevision = 0;
  for (const run of project.validationHistory) {
    assertValidationRun(run, project, "Validation history");
    requireAggregate(
      run.projectRevision > previousValidationRevision && run.projectRevision <= project.projectRevision,
      "Validation history must be ordered and cannot contain future runs.",
    );
    previousValidationRevision = run.projectRevision;
  }
  if (project.validationRun !== null) {
    requireAggregate(
      project.validationHistory.some((run) => sameValue(run, project.validationRun)),
      "Validation history must retain the current persisted run.",
    );
  }
  unique(project.exportHistory.map((record) => record.exportId), "Export verification ids");
  for (const exportRecord of project.exportHistory) {
    requireAggregate(exportRecord.projectRevision <= project.projectRevision, "Export verification belongs to a future project revision.");
  }
  if (project.activeGenerationRun !== null) {
    requireAggregate(project.activeGenerationRun.actor.type === "CueBenchAI", "Only CueBench AI may hold a generation write lease.");
  }
  for (const [findingId, waiver] of Object.entries(project.warningWaivers)) {
    requireAggregate(
      findingId === waiver.findingId && waiver.projectRevision <= project.projectRevision && waiver.actor.type === "Human",
      "Warning waiver is invalid.",
    );
  }
  assertCertificationPointer(project);
  assertCourtRecord(project, options);
};

/**
 * Converts authenticated legacy certification hash encodings, parses the
 * complete public aggregate shape, and proves all cross-record invariants.
 * It is intentionally in domain so public import does not need a storage
 * dependency or optional adapter to validate untrusted v1 JSON.
 */
export const validateCaptionProjectAggregate = (
  value: unknown,
  options: CaptionProjectAggregateValidationOptions = {},
): CaptionProject => {
  const parsed = CaptionProjectAggregateSchema.safeParse(normalizeLegacyHistories(value));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CaptionProjectAggregateError(`Invalid CaptionProject aggregate: ${issue?.message ?? "unknown shape"}.`);
  }
  const parsedProject = parsed.data as unknown as CaptionProject;
  const upgradedCertifications = parsedProject.certifications.map((certification) => {
    const upgraded = upgradeLegacyCertificationSnapshot(certification);
    if (upgraded === undefined) throw new CaptionProjectAggregateError("Certification snapshot cannot be verified for import.");
    return upgraded;
  });
  const project: CaptionProject = { ...parsedProject, certifications: upgradedCertifications };
  /** Authenticate original case-sensitive hashes before canonicalizing raw digests. */
  assertRelationships(project, options);
  const normalized = normalizeMediaDigestCasing(project);
  assertRelationships(normalized, options);
  try {
    // Validate the exact compact envelope a browser later imports, rather
    // than treating the evidence-only budget as a proxy for Court Record,
    // revision, finding, and metadata growth.
    exportProjectBackup(normalized);
  } catch (error) {
    throw new CaptionProjectAggregateError(error instanceof Error
      ? `CaptionProject exceeds the portable backup byte budget: ${error.message}`
      : "CaptionProject exceeds the portable backup byte budget.");
  }
  return clone(normalized);
};
