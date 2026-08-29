import type {
  CaptionProject,
  ProjectCertification,
  WarningWaiver,
} from "../model";
import { canonicalHash, tupleHash } from "./hash";
import {
  buildValidationInput,
  currentProjectItems,
  currentValidationRun,
  stableHash,
  validationInputHash,
  validateProject,
  type QualityFinding,
  type ValidationRun,
} from "./validate";

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export type ValidationStaleCauseCode =
  | "NOT_RUN"
  | "STATUS_STALE"
  | "PROFILE_CHANGED"
  | "MEDIA_CHANGED"
  | "EVIDENCE_CHANGED"
  | "ITEMS_CHANGED"
  | "TRACK_STRUCTURE_CHANGED"
  | "INPUT_CHANGED";

export interface ValidationStaleCause {
  readonly code: ValidationStaleCauseCode;
  readonly message: string;
}

export interface ItemStateCounts {
  readonly Proposed: number;
  readonly AgentReady: number;
  readonly Objected: number;
  readonly Sustained: number;
}

export interface CertificationReadiness {
  /** The deterministic state hash a human certification command must echo back. */
  readonly readinessHash: string;
  readonly canCertify: boolean;
  readonly currentBlockers: readonly QualityFinding[];
  readonly unwaivedWarnings: readonly QualityFinding[];
  readonly staleValidationCauses: readonly ValidationStaleCause[];
  readonly itemStateCounts: ItemStateCounts;
  readonly validationRun: ValidationRun | null;
}

const clone = <Value>(value: Value): Value => structuredClone(value);

const sameValue = (left: unknown, right: unknown): boolean => stableHash(left) === stableHash(right);

const canonicalEvidence = (project: CaptionProject) =>
  [...project.evidence].sort((left, right) => compareText(left.evidenceId, right.evidenceId));

const validationStaleCauses = (project: CaptionProject): readonly ValidationStaleCause[] => {
  const run = project.validationRun;
  if (run === null) return [{ code: "NOT_RUN", message: "Full project validation has not been run." }];

  const causes: ValidationStaleCause[] = [];
  if (project.validation.status !== "Current") {
    causes.push({ code: "STATUS_STALE", message: "The stored validation run has been marked stale." });
  }
  const currentInput = buildValidationInput(project);
  if (
    run.input.qualityProfile.profileId !== currentInput.qualityProfile.profileId
    || run.input.qualityProfile.revision !== currentInput.qualityProfile.revision
    || run.input.qualityProfile.name !== currentInput.qualityProfile.name
    || !sameValue(run.input.qualityProfile.rules, currentInput.qualityProfile.rules)
  ) causes.push({ code: "PROFILE_CHANGED", message: "The applied quality profile changed after validation." });
  if (!sameValue(run.input.media, currentInput.media)) {
    causes.push({ code: "MEDIA_CHANGED", message: "The linked media changed after validation." });
  }
  if (!sameValue(run.input.evidence, currentInput.evidence)) {
    causes.push({ code: "EVIDENCE_CHANGED", message: "Evidence provenance changed after validation." });
  }
  if (
    !sameValue(run.input.captions.items, currentInput.captions.items)
    || !sameValue(run.input.audioDescriptions.items, currentInput.audioDescriptions.items)
  ) causes.push({ code: "ITEMS_CHANGED", message: "Current item revisions changed after validation." });
  if (
    !sameValue(run.input.captions.order, currentInput.captions.order)
    || !sameValue(run.input.audioDescriptions.order, currentInput.audioDescriptions.order)
    || !sameValue(run.input.audioDescriptionGaps, currentInput.audioDescriptionGaps)
  ) causes.push({ code: "TRACK_STRUCTURE_CHANGED", message: "Track order or description gaps changed after validation." });
  if (
    run.inputHash !== validationInputHash(project)
    && !causes.some((cause) => cause.code !== "STATUS_STALE")
  ) causes.push({ code: "INPUT_CHANGED", message: "Validation input changed after the stored run." });
  return causes;
};

const countItemStates = (project: CaptionProject): ItemStateCounts => {
  const counts: { Proposed: number; AgentReady: number; Objected: number; Sustained: number } = {
    Proposed: 0,
    AgentReady: 0,
    Objected: 0,
    Sustained: 0,
  };
  for (const item of currentProjectItems(project)) counts[item.current.state] += 1;
  return counts;
};

const waiverFor = (
  project: CaptionProject,
  finding: QualityFinding,
): WarningWaiver | undefined => project.warningWaivers[finding.findingId];

const semanticValidationRun = (run: ValidationRun) => ({
  projectId: run.projectId,
  profileId: run.profileId,
  profileRevision: run.profileRevision,
  /** The hash binds the complete semantic input while ignoring audit-only revision metadata. */
  inputHash: run.inputHash,
  findings: run.findings,
  blockerCount: run.blockerCount,
  warningCount: run.warningCount,
});

export const applicableWarningWaivers = (
  project: CaptionProject,
  warnings: readonly QualityFinding[],
): readonly WarningWaiver[] => warnings
  .map((warning) => waiverFor(project, warning))
  .filter((waiver): waiver is WarningWaiver => waiver !== undefined)
  .sort((left, right) => compareText(left.findingId, right.findingId));

export const prepareCertificationReview = (project: CaptionProject): CertificationReadiness => {
  const currentRun = currentValidationRun(project);
  const evaluatedRun = currentRun ?? validateProject(project);
  const currentBlockers = evaluatedRun.findings.filter((finding) => finding.severity === "blocker");
  const currentWarnings = evaluatedRun.findings.filter((finding) => finding.severity === "warning");
  const applicableWaivers = applicableWarningWaivers(project, currentWarnings);
  const waivedFindingIds = new Set(applicableWaivers.map((waiver) => waiver.findingId));
  const unwaivedWarnings = currentWarnings.filter((warning) => !waivedFindingIds.has(warning.findingId));
  const staleValidationCauses = validationStaleCauses(project);
  const itemStateCounts = countItemStates(project);
  const readinessContent = {
    media: project.media,
    evidence: canonicalEvidence(project),
    itemRevisions: currentProjectItems(project).map((item) => ({
      kind: item.kind,
      itemId: item.itemId,
      itemRevision: item.current.itemRevision,
    })),
    qualityProfile: project.qualityProfile,
    validationRun: semanticValidationRun(evaluatedRun),
    applicableWarningWaivers: applicableWaivers,
    currentBlockerFindingIds: currentBlockers.map((finding) => finding.findingId),
    unwaivedWarningFindingIds: unwaivedWarnings.map((finding) => finding.findingId),
    staleValidationCauses: staleValidationCauses.map((cause) => cause.code),
    itemStateCounts,
  };
  const readinessHash = canonicalHash("cuebench.certification-readiness.v1", readinessContent);
  return {
    readinessHash,
    canCertify: currentBlockers.length === 0
      && unwaivedWarnings.length === 0
      && staleValidationCauses.length === 0
      && itemStateCounts.Sustained > 0,
    currentBlockers,
    unwaivedWarnings,
    staleValidationCauses,
    itemStateCounts,
    validationRun: currentRun ?? null,
  };
};

export const createCertificationSnapshot = (
  project: CaptionProject,
  readiness: CertificationReadiness,
  input: {
    readonly certificationId: string;
    readonly certifiedAtMs: number;
    readonly actor: ProjectCertification["actor"];
  },
): ProjectCertification => {
  const validationRun = currentValidationRun(project);
  if (validationRun === undefined) throw new Error("Certification requires a current validation run.");
  if (input.actor.type !== "Human") throw new Error("Certification requires a Human actor.");
  if (!Number.isSafeInteger(input.certifiedAtMs) || input.certifiedAtMs <= 0) {
    throw new RangeError("Certification requires a positive integer timestamp.");
  }
  const actor = clone(input.actor);
  const evidence = canonicalEvidence(project);
  const warnings = validationRun.findings.filter((finding) => finding.severity === "warning");
  const certificationSnapshotHash = tupleHash("cuebench.certification-snapshot.v1", [
    "readinessHash",
    readiness.readinessHash,
    "certificationId",
    input.certificationId,
    "actorType",
    actor.type,
    "actorId",
    actor.id,
    "certifiedAtMs",
    String(input.certifiedAtMs),
  ]);
  return {
    certificationId: input.certificationId,
    certificationSnapshotHash,
    readinessHash: readiness.readinessHash,
    certifiedAtMs: input.certifiedAtMs,
    actor,
    media: clone(project.media),
    evidence: clone(evidence),
    itemRevisions: currentProjectItems(project).map((item) => ({
      kind: item.kind,
      itemId: item.itemId,
      itemRevision: item.current.itemRevision,
    })),
    qualityProfile: clone(project.qualityProfile),
    validationRun: clone(validationRun),
    warningWaivers: clone(applicableWarningWaivers(project, warnings)),
  };
};
