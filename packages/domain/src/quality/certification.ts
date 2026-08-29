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

const SHA256_HASH = /^sha256:[0-9a-f]{64}$/;

const semanticValidationInput = (input: ValidationRun["input"]) => ({
  projectId: input.projectId,
  media: input.media,
  evidence: input.evidence,
  qualityProfile: input.qualityProfile,
  captions: input.captions,
  audioDescriptions: input.audioDescriptions,
  audioDescriptionGaps: input.audioDescriptionGaps,
});

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
  const certificationSnapshotHash = certificationSnapshotHashFor({
    readinessHash: readiness.readinessHash,
    certificationId: input.certificationId,
    actor,
    certifiedAtMs: input.certifiedAtMs,
  });
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

export const certificationSnapshotHashFor = (input: {
  readonly readinessHash: string;
  readonly certificationId: string;
  readonly actor: ProjectCertification["actor"];
  readonly certifiedAtMs: number;
}): string => tupleHash("cuebench.certification-snapshot.v1", [
    "readinessHash",
    input.readinessHash,
    "certificationId",
    input.certificationId,
    "actorType",
    input.actor.type,
    "actorId",
    input.actor.id,
    "certifiedAtMs",
    String(input.certifiedAtMs),
  ]);

/**
 * Verifies only the immutable record itself. Currentness is deliberately a
 * project concern, so callers additionally bind the verified id to the
 * project certification pointer.
 */
export const verifyCertificationSnapshot = (snapshot: ProjectCertification): boolean => {
  if (snapshot.actor.type !== "Human" || !snapshot.actor.id.trim() || snapshot.actor.id.trim() !== snapshot.actor.id) return false;
  if (!SHA256_HASH.test(snapshot.readinessHash) || !SHA256_HASH.test(snapshot.certificationSnapshotHash)) return false;
  if (!Number.isSafeInteger(snapshot.certifiedAtMs) || snapshot.certifiedAtMs <= 0) return false;
  if (
    !snapshot.certificationId.trim()
    || snapshot.certificationId.trim() !== snapshot.certificationId
    || !snapshot.media.sourceId.trim()
    || snapshot.media.sourceId.trim() !== snapshot.media.sourceId
    || !/^[0-9a-f]{64}$/.test(snapshot.media.sha256)
    || snapshot.media.relinkState !== "Linked"
  ) return false;
  const itemKeys = new Set<string>();
  const itemIds = new Set<string>();
  for (const item of snapshot.itemRevisions) {
    const key = `${item.kind}\u0000${item.itemId}`;
    if (
      !item.itemId.trim()
      || item.itemId.trim() !== item.itemId
      || !Number.isSafeInteger(item.itemRevision)
      || item.itemRevision <= 0
      || itemKeys.has(key)
      || itemIds.has(item.itemId)
    ) {
      return false;
    }
    itemKeys.add(key);
    itemIds.add(item.itemId);
  }
  const evidenceIds = new Set<string>();
  for (const evidence of snapshot.evidence) {
    if (
      !evidence.evidenceId.trim()
      || evidence.evidenceId.trim() !== evidence.evidenceId
      || evidenceIds.has(evidence.evidenceId)
      || evidence.projectId !== snapshot.validationRun.projectId
      || evidence.mediaSha256 !== snapshot.media.sha256
      || !/^[0-9a-f]{64}$/.test(evidence.mediaSha256)
      || (evidence.itemId === null) !== (evidence.itemRevision === null)
    ) return false;
    evidenceIds.add(evidence.evidenceId);
    if (evidence.itemId !== null && !itemIds.has(evidence.itemId)) return false;
  }
  const run = snapshot.validationRun;
  if (
    run.projectId !== run.input.projectId
    || run.profileId !== snapshot.qualityProfile.profileId
    || run.profileRevision !== snapshot.qualityProfile.revision
    || !SHA256_HASH.test(run.inputHash)
    || run.inputHash !== stableHash(semanticValidationInput(run.input))
    || !sameValue(run.input.media, snapshot.media)
    || !sameValue(run.input.evidence, snapshot.evidence)
    || !sameValue(run.input.qualityProfile, snapshot.qualityProfile)
  ) return false;
  const inputItemEntries = [
    ...run.input.captions.items,
    ...run.input.audioDescriptions.items,
  ].map((item) => [`${item.kind}\u0000${item.itemId}`, item] as const);
  const inputItems = new Map(inputItemEntries);
  if (inputItems.size !== inputItemEntries.length) return false;
  if (snapshot.itemRevisions.some((item) => inputItems.get(`${item.kind}\u0000${item.itemId}`)?.itemRevision !== item.itemRevision)) {
    return false;
  }
  const findingIds = new Set<string>();
  for (const finding of run.findings) {
    if (finding.id !== finding.findingId || !finding.findingId.trim() || findingIds.has(finding.findingId)) return false;
    findingIds.add(finding.findingId);
  }
  const blockers = run.findings.filter((finding) => finding.severity === "blocker");
  const warnings = run.findings.filter((finding) => finding.severity === "warning");
  if (
    blockers.length !== run.blockerCount
    || warnings.length !== run.warningCount
    || blockers.length !== run.blockers.length
    || warnings.length !== run.warnings.length
    || !sameValue(blockers, run.blockers)
    || !sameValue(warnings, run.warnings)
  ) return false;
  const waiverIds = new Set<string>();
  for (const waiver of snapshot.warningWaivers) {
    if (
      !waiver.findingId.trim()
      || waiver.findingId.trim() !== waiver.findingId
      || !waiver.reason.trim()
      || waiver.actor.type !== "Human"
      || !waiver.actor.id.trim()
      || waiver.actor.id.trim() !== waiver.actor.id
      || waiverIds.has(waiver.findingId)
      || !warnings.some((finding) => finding.findingId === waiver.findingId)
    ) {
      return false;
    }
    waiverIds.add(waiver.findingId);
  }
  if (blockers.length > 0 || warnings.some((warning) => !waiverIds.has(warning.findingId))) return false;
  return snapshot.certificationSnapshotHash === certificationSnapshotHashFor(snapshot);
};
