import { CaptionProjectAggregateSchema } from "@cuebench/contracts";
import type { Actor } from "@cuebench/contracts";
import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  EvidenceProvenance,
  ProjectCertification,
} from "../model";
import { canonicalSerialize } from "../quality/hash";
import {
  applicableWarningWaivers,
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
  type ValidationRun,
} from "../quality/validate";

/** Raised before an untrusted aggregate can become an editable import preview. */
export class CaptionProjectAggregateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CaptionProjectAggregateError";
  }
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

const assertRelationships = (project: CaptionProject): void => {
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
  unique(project.courtRecord.map((event) => event.eventId), "Court Record event ids");
  for (const event of project.courtRecord) {
    requireAggregate(event.projectRevision <= project.projectRevision, "Court Record event is from a future project revision.");
  }
  for (const [findingId, waiver] of Object.entries(project.warningWaivers)) {
    requireAggregate(
      findingId === waiver.findingId && waiver.projectRevision <= project.projectRevision && waiver.actor.type === "Human",
      "Warning waiver is invalid.",
    );
  }
  assertCertificationPointer(project);
};

/**
 * Converts authenticated legacy certification hash encodings, parses the
 * complete public aggregate shape, and proves all cross-record invariants.
 * It is intentionally in domain so public import does not need a storage
 * dependency or optional adapter to validate untrusted v1 JSON.
 */
export const validateCaptionProjectAggregate = (value: unknown): CaptionProject => {
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
  assertRelationships(project);
  return clone(project);
};
