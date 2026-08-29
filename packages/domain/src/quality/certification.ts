import type {
  CaptionProject,
  ProjectCertification,
  WarningWaiver,
} from "../model";
import { canonicalHash, tupleHash } from "./hash";
import {
  buildValidationInput,
  currentValidationRun,
  stableHash,
  validateProject,
  validateValidationInput,
  validationInputHash,
  validationInputHashFor,
  type QualityFinding,
  type ValidationInputSnapshot,
  type ValidationRun,
} from "./validate";

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const SHA256_HASH = /^sha256:[0-9a-f]{64}$/;
/** Raw media digests retain MediaSourceSnapshot's case-insensitive wire compatibility. */
const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * A hash format is reported only after its digest and all snapshot semantics
 * have been recomputed. `2-unversioned` is the short-lived 69d6e59 format.
 */
export type CertificationSnapshotHashVersion = 1 | "2-unversioned" | 2;

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

const inputItemRevisions = (input: ValidationInputSnapshot): ProjectCertification["itemRevisions"] => [
  ...input.captions.items,
  ...input.audioDescriptions.items,
].map((item) => ({
  kind: item.kind,
  itemId: item.itemId,
  itemRevision: item.itemRevision,
}));

const countInputItemStates = (input: ValidationInputSnapshot): ItemStateCounts => {
  const counts: { Proposed: number; AgentReady: number; Objected: number; Sustained: number } = {
    Proposed: 0,
    AgentReady: 0,
    Objected: 0,
    Sustained: 0,
  };
  for (const item of [...input.captions.items, ...input.audioDescriptions.items]) {
    if (item.state === "Proposed" || item.state === "AgentReady" || item.state === "Objected" || item.state === "Sustained") {
      counts[item.state] += 1;
    }
  }
  return counts;
};

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

const readinessHashFor = (content: {
  readonly media: ProjectCertification["media"];
  readonly evidence: ProjectCertification["evidence"];
  readonly itemRevisions: ProjectCertification["itemRevisions"];
  readonly qualityProfile: ProjectCertification["qualityProfile"];
  readonly validationRun: ValidationRun;
  readonly applicableWarningWaivers: readonly WarningWaiver[];
  readonly currentBlockerFindingIds: readonly string[];
  readonly unwaivedWarningFindingIds: readonly string[];
  readonly staleValidationCauseCodes: readonly ValidationStaleCauseCode[];
  readonly itemStateCounts: ItemStateCounts;
}): string => canonicalHash("cuebench.certification-readiness.v1", {
  media: content.media,
  evidence: content.evidence,
  itemRevisions: content.itemRevisions,
  qualityProfile: content.qualityProfile,
  validationRun: semanticValidationRun(content.validationRun),
  applicableWarningWaivers: content.applicableWarningWaivers,
  currentBlockerFindingIds: content.currentBlockerFindingIds,
  unwaivedWarningFindingIds: content.unwaivedWarningFindingIds,
  staleValidationCauses: content.staleValidationCauseCodes,
  itemStateCounts: content.itemStateCounts,
});

export const prepareCertificationReview = (project: CaptionProject): CertificationReadiness => {
  const currentRun = currentValidationRun(project);
  const evaluatedRun = currentRun ?? validateProject(project);
  const currentBlockers = evaluatedRun.findings.filter((finding) => finding.severity === "blocker");
  const currentWarnings = evaluatedRun.findings.filter((finding) => finding.severity === "warning");
  const applicableWaivers = applicableWarningWaivers(project, currentWarnings);
  const waivedFindingIds = new Set(applicableWaivers.map((waiver) => waiver.findingId));
  const unwaivedWarnings = currentWarnings.filter((warning) => !waivedFindingIds.has(warning.findingId));
  const staleValidationCauses = validationStaleCauses(project);
  const itemStateCounts = countInputItemStates(evaluatedRun.input);
  const readinessHash = readinessHashFor({
    media: project.media,
    evidence: canonicalEvidence(project),
    itemRevisions: inputItemRevisions(evaluatedRun.input),
    qualityProfile: project.qualityProfile,
    validationRun: evaluatedRun,
    applicableWarningWaivers: applicableWaivers,
    currentBlockerFindingIds: currentBlockers.map((finding) => finding.findingId),
    unwaivedWarningFindingIds: unwaivedWarnings.map((finding) => finding.findingId),
    staleValidationCauseCodes: staleValidationCauses.map((cause) => cause.code),
    itemStateCounts,
  });
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
  const warnings = validationRun.findings.filter((finding) => finding.severity === "warning");
  const content: Omit<ProjectCertification, "certificationSnapshotHash"> = {
    certificationId: input.certificationId,
    readinessHash: readiness.readinessHash,
    certifiedAtMs: input.certifiedAtMs,
    actor: clone(input.actor),
    media: clone(project.media),
    evidence: clone(canonicalEvidence(project)),
    itemRevisions: clone(inputItemRevisions(validationRun.input)),
    qualityProfile: clone(project.qualityProfile),
    validationRun: clone(validationRun),
    warningWaivers: clone(applicableWarningWaivers(project, warnings)),
  };
  return {
    ...content,
    certificationSnapshotHash: certificationSnapshotHashFor(content),
  };
};

/** Defensively excludes an accidental outer hash before hashing immutable content. */
const hashableCertificationContent = (
  content: Omit<ProjectCertification, "certificationSnapshotHash">,
): Omit<ProjectCertification, "certificationSnapshotHash"> => {
  const immutable = { ...content } as Record<string, unknown>;
  Reflect.deleteProperty(immutable, "certificationSnapshotHash");
  return immutable as Omit<ProjectCertification, "certificationSnapshotHash">;
};

/** Exact full-content hash emitted by the short-lived 69d6e59 storage build. */
export const intermediateCertificationSnapshotHashFor = (
  content: Omit<ProjectCertification, "certificationSnapshotHash">,
): string => canonicalHash("cuebench.certification-snapshot.v2", hashableCertificationContent(content));

/** Hashes every immutable certification field except the hash itself. */
export const certificationSnapshotHashFor = (
  content: Omit<ProjectCertification, "certificationSnapshotHash">,
): string => `sha256:v2:${intermediateCertificationSnapshotHashFor(content).slice("sha256:".length)}`;

/**
 * The historic v1 tuple is intentionally retained only to authenticate an
 * upgrade source before the full v2 verifier normalizes it.
 */
export const legacyCertificationSnapshotHashFor = (input: Pick<
  ProjectCertification,
  "readinessHash" | "certificationId" | "actor" | "certifiedAtMs"
>): string => tupleHash("cuebench.certification-snapshot.v1", [
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

const canonicalWaivers = (waivers: readonly WarningWaiver[]): readonly WarningWaiver[] =>
  [...waivers].sort((left, right) => compareText(left.findingId, right.findingId));

type ValidationInputItem = ValidationInputSnapshot["captions"]["items"][number];
type CertificationItemRevision = ProjectCertification["itemRevisions"][number];

const allInputItems = (input: ValidationInputSnapshot): readonly ValidationInputItem[] => [
  ...input.captions.items,
  ...input.audioDescriptions.items,
];

/** v1 certification snapshots bound only live cues, matching currentProjectItems(). */
const legacyInputItems = (input: ValidationInputSnapshot): readonly ValidationInputItem[] => [
  ...input.captions.items.filter((item) => item.mergedIntoItemId === null || item.mergedIntoItemId === undefined),
  ...input.audioDescriptions.items,
];

const itemRevisionsFor = (
  items: readonly ValidationInputItem[],
): readonly CertificationItemRevision[] => items.map((item) => ({
  kind: item.kind,
  itemId: item.itemId,
  itemRevision: item.itemRevision,
}));

const countItemStatesFor = (items: readonly ValidationInputItem[]): ItemStateCounts => {
  const counts: { Proposed: number; AgentReady: number; Objected: number; Sustained: number } = {
    Proposed: 0,
    AgentReady: 0,
    Objected: 0,
    Sustained: 0,
  };
  for (const item of items) {
    if (item.state === "Proposed" || item.state === "AgentReady" || item.state === "Objected" || item.state === "Sustained") {
      counts[item.state] += 1;
    }
  }
  return counts;
};

const readinessHashForSnapshotContent = (
  snapshot: ProjectCertification,
  itemRevisions: readonly CertificationItemRevision[],
  itemStateCounts: ItemStateCounts,
): string => {
  const run = snapshot.validationRun;
  const blockers = run.findings.filter((finding) => finding.severity === "blocker");
  const warnings = run.findings.filter((finding) => finding.severity === "warning");
  const waiverIds = new Set(snapshot.warningWaivers.map((waiver) => waiver.findingId));
  return readinessHashFor({
    media: snapshot.media,
    evidence: snapshot.evidence,
    itemRevisions,
    qualityProfile: snapshot.qualityProfile,
    validationRun: run,
    applicableWarningWaivers: canonicalWaivers(snapshot.warningWaivers),
    currentBlockerFindingIds: blockers.map((finding) => finding.findingId),
    unwaivedWarningFindingIds: warnings
      .filter((warning) => !waiverIds.has(warning.findingId))
      .map((warning) => warning.findingId),
    staleValidationCauseCodes: [],
    itemStateCounts,
  });
};

/**
 * Recomputes the readiness content from the immutable snapshot. It is useful
 * to storage readers as well as the verifier, which must not trust a stored
 * readiness hash merely because it has the right digest shape.
 */
export const certificationReadinessHashForSnapshot = (snapshot: ProjectCertification): string => {
  return readinessHashForSnapshotContent(
    snapshot,
    snapshot.itemRevisions,
    countInputItemStates(snapshot.validationRun.input),
  );
};

const validIdentifier = (value: string): boolean => value.trim().length > 0 && value.trim() === value;

const validActor = (actor: ProjectCertification["actor"], type?: "Human"): boolean =>
  (type === undefined || actor.type === type) && validIdentifier(actor.id);

/** Validates the snapshot contents independently of its outer hash format. */
const hasValidCertificationContents = (
  snapshot: ProjectCertification,
  expectedItems: readonly CertificationItemRevision[],
  expectedInputItems: readonly ValidationInputItem[],
): boolean => {
  if (!validActor(snapshot.actor, "Human") || !validIdentifier(snapshot.certificationId)) return false;
  if (!SHA256_HASH.test(snapshot.readinessHash)) return false;
  if (!Number.isSafeInteger(snapshot.certifiedAtMs) || snapshot.certifiedAtMs <= 0) return false;
  if (
    !validIdentifier(snapshot.media.sourceId)
    || !SHA256.test(snapshot.media.sha256)
    || snapshot.media.relinkState !== "Linked"
    || !Number.isSafeInteger(snapshot.media.durationMs)
    || snapshot.media.durationMs < 0
  ) return false;

  const run = snapshot.validationRun;
  if (
    run.projectId !== run.input.projectId
    || run.projectRevision !== run.input.projectRevision
    || run.profileId !== run.input.qualityProfile.profileId
    || run.profileRevision !== run.input.qualityProfile.revision
    || !SHA256_HASH.test(run.inputHash)
    || run.inputHash !== validationInputHashFor(run.input)
    || !sameValue(validateValidationInput(run.input), run)
    || !sameValue(snapshot.media, run.input.media)
    || !sameValue(snapshot.evidence, run.input.evidence)
    || !sameValue(snapshot.qualityProfile, run.input.qualityProfile)
  ) return false;

  if (!sameValue(snapshot.itemRevisions, expectedItems)) return false;
  const itemIds = new Set<string>();
  for (const item of expectedItems) {
    if (!validIdentifier(item.itemId) || !Number.isSafeInteger(item.itemRevision) || item.itemRevision <= 0 || itemIds.has(item.itemId)) {
      return false;
    }
    itemIds.add(item.itemId);
  }
  if (!expectedInputItems.some((item) => item.state === "Sustained")) return false;

  const evidenceIds = new Set<string>();
  for (const evidence of snapshot.evidence) {
    if (
      !validIdentifier(evidence.evidenceId)
      || evidenceIds.has(evidence.evidenceId)
      || evidence.projectId !== run.projectId
      || evidence.mediaSha256 !== snapshot.media.sha256
      || !SHA256.test(evidence.mediaSha256)
      || (evidence.itemId === null) !== (evidence.itemRevision === null)
      || (evidence.itemId !== null && (!itemIds.has(evidence.itemId)
        || evidence.itemRevision === null
        || !Number.isSafeInteger(evidence.itemRevision)
        || evidence.itemRevision <= 0))
    ) return false;
    evidenceIds.add(evidence.evidenceId);
  }

  const recomputed = validateValidationInput(run.input);
  const blockers = recomputed.blockers;
  const warnings = recomputed.warnings;
  if (blockers.length > 0) return false;
  if (!sameValue(snapshot.warningWaivers, canonicalWaivers(snapshot.warningWaivers))) return false;
  const waiverIds = new Set<string>();
  for (const waiver of snapshot.warningWaivers) {
    if (
      !validIdentifier(waiver.findingId)
      || !waiver.reason.trim()
      || !validActor(waiver.actor, "Human")
      || !Number.isSafeInteger(waiver.projectRevision)
      || waiver.projectRevision <= 0
      || waiverIds.has(waiver.findingId)
      || !warnings.some((warning) => warning.findingId === waiver.findingId)
    ) return false;
    waiverIds.add(waiver.findingId);
  }
  return waiverIds.size === warnings.length && warnings.every((warning) => waiverIds.has(warning.findingId));
};

const certificationContent = (
  snapshot: ProjectCertification,
): Omit<ProjectCertification, "certificationSnapshotHash"> => ({
  certificationId: snapshot.certificationId,
  readinessHash: snapshot.readinessHash,
  certifiedAtMs: snapshot.certifiedAtMs,
  actor: snapshot.actor,
  media: snapshot.media,
  evidence: snapshot.evidence,
  itemRevisions: snapshot.itemRevisions,
  qualityProfile: snapshot.qualityProfile,
  validationRun: snapshot.validationRun,
  warningWaivers: snapshot.warningWaivers,
});

/** Recomputes the current full snapshot semantics without trusting its hash. */
const hasVerifiedFullSnapshotContents = (snapshot: ProjectCertification): boolean => {
  try {
    const input = snapshot.validationRun.input;
    return hasValidCertificationContents(snapshot, itemRevisionsFor(allInputItems(input)), allInputItems(input))
      && snapshot.readinessHash === certificationReadinessHashForSnapshot(snapshot);
  } catch {
    return false;
  }
};

/** Recomputes the original v1 live-item semantics without trusting its hash. */
const hasVerifiedLegacySnapshotContents = (snapshot: ProjectCertification): boolean => {
  try {
    const input = snapshot.validationRun.input;
    const legacyItems = legacyInputItems(input);
    const expectedItems = itemRevisionsFor(legacyItems);
    return hasValidCertificationContents(snapshot, expectedItems, legacyItems)
      && snapshot.readinessHash === readinessHashForSnapshotContent(
        snapshot,
        expectedItems,
        countItemStatesFor(legacyItems),
      );
  } catch {
    return false;
  }
};

/** Validates the old shallow tuple plus all semantic snapshot content before migration. */
export const verifyLegacyCertificationSnapshot = (snapshot: ProjectCertification): boolean =>
  hasVerifiedLegacySnapshotContents(snapshot)
  && snapshot.certificationSnapshotHash === legacyCertificationSnapshotHashFor(snapshot);

/** Validates the exact, unversioned full-content hash emitted by 69d6e59. */
export const verifyIntermediateCertificationSnapshot = (snapshot: ProjectCertification): boolean =>
  hasVerifiedFullSnapshotContents(snapshot)
  && snapshot.certificationSnapshotHash === intermediateCertificationSnapshotHashFor(certificationContent(snapshot));

/**
 * Recomputes snapshot semantics and hashes in deterministic compatibility
 * order. This intentionally accepts no format merely because its string has
 * a familiar prefix.
 */
export const detectCertificationSnapshotHashVersion = (
  snapshot: ProjectCertification,
): CertificationSnapshotHashVersion | null => {
  if (hasVerifiedFullSnapshotContents(snapshot)) {
    const content = certificationContent(snapshot);
    if (snapshot.certificationSnapshotHash === certificationSnapshotHashFor(content)) return 2;
    if (snapshot.certificationSnapshotHash === intermediateCertificationSnapshotHashFor(content)) return "2-unversioned";
  }
  if (verifyLegacyCertificationSnapshot(snapshot)) return 1;
  return null;
};

/**
 * Recomputes every deterministic validation fact from the immutable input.
 * This deliberately does not trust serialized findings, readiness, or a
 * partial item list: only a complete, certifiable validation input verifies.
 */
export const verifyCertificationSnapshot = (snapshot: ProjectCertification): boolean =>
  detectCertificationSnapshotHashVersion(snapshot) === 2;

/**
 * Converts only authenticated compatibility snapshots to the current full
 * v2 representation. Both old formats are recomputed before rehashing.
 */
export const upgradeLegacyCertificationSnapshot = (
  snapshot: ProjectCertification,
): ProjectCertification | undefined => {
  const version = detectCertificationSnapshotHashVersion(snapshot);
  if (version === 2) return clone(snapshot);
  if (version === "2-unversioned") {
    const content = clone(certificationContent(snapshot));
    const upgraded: ProjectCertification = {
      ...content,
      certificationSnapshotHash: certificationSnapshotHashFor(content),
    };
    return verifyCertificationSnapshot(upgraded) ? upgraded : undefined;
  }
  if (version !== 1) return undefined;
  const upgradedWithoutHash: Omit<ProjectCertification, "certificationSnapshotHash"> = {
    ...certificationContent(snapshot),
    itemRevisions: clone(inputItemRevisions(snapshot.validationRun.input)),
    readinessHash: "",
  };
  const readinessHash = certificationReadinessHashForSnapshot({
    ...upgradedWithoutHash,
    certificationSnapshotHash: "sha256:v2:" + "0".repeat(64),
  });
  const content = { ...upgradedWithoutHash, readinessHash };
  const upgraded: ProjectCertification = {
    ...content,
    certificationSnapshotHash: certificationSnapshotHashFor(content),
  };
  return verifyCertificationSnapshot(upgraded) ? upgraded : undefined;
};
