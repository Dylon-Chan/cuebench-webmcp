import { CaptionProjectAggregateSchema } from "@cuebench/contracts";
import type { Actor } from "@cuebench/contracts";
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
    ...(aggregate.validationHistory === undefined
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
  ReleaseGenerationRun: ["CueBenchAI", "System"],
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
  "MarkItemAgentReady",
  "ObjectItem",
  "SustainItem",
]);

const statefulItemCourtEventTypes = new Set([
  "AdjustCueTiming",
  "SplitCue",
  "MergeCue",
  "ReviseCue",
  "AdjustAudioDescriptionTiming",
  "ReviseAudioDescription",
  "ProposeAudioDescriptionInGap",
  "MarkItemAgentReady",
  "ObjectItem",
  "SustainItem",
]);

const semanticRevisionCauseTypes = new Set([
  "AdjustCueTiming",
  "SplitCue",
  "MergeCue",
  "ReviseCue",
  "AdjustAudioDescriptionTiming",
  "ReviseAudioDescription",
  "ProposeAudioDescriptionInGap",
]);

const sameActor = (left: Actor, right: Actor): boolean => left.type === right.type && left.id === right.id;

const itemForCourtEvent = (project: CaptionProject, event: DomainEvent): CaptionCue | AudioDescriptionBeat => {
  requireAggregate(event.itemId !== undefined, `Court Record ${event.type} requires an item id.`);
  const item = project.captions.items[event.itemId] ?? project.audioDescriptions.items[event.itemId];
  requireAggregate(item !== undefined, `Court Record ${event.type} references an unknown item.`);
  return item;
};

const revisionClaim = (item: CaptionCue | AudioDescriptionBeat, itemRevision: number): string =>
  `${item.kind}\u0000${item.itemId}\u0000${itemRevision}`;

const assertCourtRecord = (
  project: CaptionProject,
  options: CaptionProjectAggregateValidationOptions,
): void => {
  const legacy = options.allowLegacyCourtRecord === true;
  const events = project.courtRecord;
  unique(events.map((event) => event.eventId), "Court Record event ids");
  if (events.length === 0) return;

  const claimedRevisions = new Set<string>();
  let previousRevision = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    requireAggregate(
      event.projectRevision >= (legacy ? 1 : 2) && event.projectRevision <= project.projectRevision,
      "Court Record event has an illegal project revision.",
    );
    requireAggregate(event.projectRevision >= previousRevision, "Court Record events must be ordered by project revision.");
    previousRevision = event.projectRevision;

    if (!legacy) {
      requireAggregate(
        events.length === project.projectRevision - 1
          && event.projectRevision === index + 2
          && event.eventId === `${project.projectId}:${event.projectRevision}:${index + 1}`,
        "Court Record must contain the canonical, complete command history.",
      );
    }

    const allowedActors = courtActors[event.type];
    requireAggregate(
      allowedActors !== undefined || legacy,
      `Court Record event type ${event.type} is not a known durable command.`,
    );
    if (allowedActors !== undefined) {
      requireAggregate(
        allowedActors.includes(event.actor.type),
        `Court Record ${event.type} has invalid actor provenance.`,
      );
    }
    if (!legacy && event.type !== "ObjectItem") {
      requireAggregate(event.detail === undefined, `Court Record ${event.type} cannot carry arbitrary detail.`);
    }

    if (event.type === "FocusGap") {
      requireAggregate(event.itemId !== undefined && project.audioDescriptionGaps[event.itemId] !== undefined, "Court Record FocusGap references an unknown gap.");
    } else if (itemCourtEventTypes.has(event.type)) {
      const item = itemForCourtEvent(project, event);
      if (statefulItemCourtEventTypes.has(event.type)) {
        const matchingRevision = item.revisions.find((revision) => {
          if (claimedRevisions.has(revisionClaim(item, revision.itemRevision)) || !sameActor(revision.actor, event.actor)) return false;
          if (event.type === "MarkItemAgentReady") return revision.state === "AgentReady" && (legacy || revision.cause === event.type);
          if (event.type === "ObjectItem") {
            return revision.state === "Objected" && (legacy || (event.detail !== undefined && revision.cause === event.detail));
          }
          if (event.type === "SustainItem") return revision.state === "Sustained" && (legacy || revision.cause === event.type);
          return legacy || revision.cause === event.type;
        });
        requireAggregate(matchingRevision !== undefined, `Court Record ${event.type} has no matching legal item transition.`);
        claimedRevisions.add(revisionClaim(item, matchingRevision.itemRevision));
        if (event.type === "ObjectItem" && !legacy) {
          requireAggregate(
            typeof event.detail === "string" && event.detail.trim().length > 0 && event.detail === matchingRevision.cause,
            "Court Record objection detail does not bind its item transition.",
          );
        }
      }
    }
  }

  if (legacy) return;
  for (const item of [...Object.values(project.captions.items), ...Object.values(project.audioDescriptions.items)]) {
    for (const revision of item.revisions) {
      const recordedTransition = revision.itemRevision > 1
        && (revision.state === "AgentReady" || revision.state === "Objected" || revision.state === "Sustained" || semanticRevisionCauseTypes.has(revision.cause));
      const proposedInGap = revision.itemRevision === 1 && revision.cause === "ProposeAudioDescriptionInGap";
      if (recordedTransition || proposedInGap) {
        requireAggregate(
          claimedRevisions.has(revisionClaim(item, revision.itemRevision)),
          "Item revision is missing its Court Record transition.",
        );
      }
    }
  }

  /** The final command's visible selection must still be reflected by the durable projection. */
  const last = events.at(-1)!;
  if (last.type === "FocusGap") {
    requireAggregate(
      last.itemId !== undefined
        && project.selectedItem !== null
        && project.selectedItem.kind === "AudioDescriptionGap"
        && project.selectedItem.itemId === last.itemId,
      "Final Court Record gap focus does not match the current selection.",
    );
  } else if (last.type === "SelectItem" || last.type === "FocusItem" || statefulItemCourtEventTypes.has(last.type)) {
    const item = itemForCourtEvent(project, last);
    requireAggregate(
      project.selectedItem !== null
        && project.selectedItem.kind === item.kind
        && project.selectedItem.itemId === item.itemId
        && project.selectedItem.itemRevision === item.current.itemRevision,
      "Final Court Record item transition does not match the current selection.",
    );
  }
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
  return clone(normalized);
};
