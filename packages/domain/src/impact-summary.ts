import type { CaptionProject, DomainEvent } from "./model";
import type { QualityFinding, ValidationRun } from "./quality/validate";
import type { RoundTripResult } from "./export/round-trip";

export interface FindingSummary {
  readonly total: number;
  readonly blockerCount: number;
  readonly warningCount: number;
  readonly findings: readonly QualityFinding[];
}

export interface ReviewStateCounts {
  readonly Proposed: number;
  readonly AgentReady: number;
  readonly Objected: number;
  readonly Sustained: number;
}

export interface HumanInterventionSummary {
  readonly count: number;
  readonly events: readonly DomainEvent[];
}

export interface ImpactSummary {
  readonly initialFindings: FindingSummary;
  readonly resolvedFindings: FindingSummary;
  readonly reviewStateCounts: ReviewStateCounts;
  readonly humanInterventions: HumanInterventionSummary;
  readonly certificationState: CaptionProject["certification"]["status"];
  readonly roundTripResult: RoundTripResult | null;
  readonly timeToCertificationMs?: number;
}

export interface BuildImpactSummaryOptions {
  /** A real local persistence timestamp, never an estimate or wall-clock fallback. */
  readonly projectCreatedAtMs?: number;
  /** The latest actual export verification result that the caller chose to retain. */
  readonly roundTripResult?: RoundTripResult;
}

const emptyFindingSummary = (): FindingSummary => ({ total: 0, blockerCount: 0, warningCount: 0, findings: [] });

const summaryFor = (findings: readonly QualityFinding[]): FindingSummary => ({
  total: findings.length,
  blockerCount: findings.filter((finding) => finding.severity === "blocker").length,
  warningCount: findings.filter((finding) => finding.severity === "warning").length,
  findings: structuredClone(findings),
});

const isValidationRun = (value: unknown): value is ValidationRun =>
  typeof value === "object"
  && value !== null
  && "inputHash" in value
  && typeof value.inputHash === "string"
  && "projectRevision" in value
  && typeof value.projectRevision === "number";

const validationHistory = (project: CaptionProject): readonly ValidationRun[] => {
  const candidates: readonly unknown[] = [
    ...(project.validationRun === null ? [] : [project.validationRun]),
    ...project.certifications.map((certification) => certification.validationRun),
  ];
  const byHash = new Map<string, ValidationRun>();
  for (const run of candidates) {
    if (!isValidationRun(run)) continue;
    const existing = byHash.get(run.inputHash);
    if (existing === undefined || run.projectRevision < existing.projectRevision) byHash.set(run.inputHash, run);
  }
  return [...byHash.values()].sort((left, right) => left.projectRevision - right.projectRevision);
};

const currentCertification = (project: CaptionProject) => {
  const pointer = project.certification;
  return pointer.status === "Current"
    ? project.certifications.find((certification) => certification.certificationId === pointer.certificationId)
    : undefined;
};

const timestamp = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const stateCountsFor = (project: CaptionProject): ReviewStateCounts => {
  const counts: { Proposed: number; AgentReady: number; Objected: number; Sustained: number } = {
    Proposed: 0,
    AgentReady: 0,
    Objected: 0,
    Sustained: 0,
  };
  const seen = new Set<string>();
  for (const id of project.captions.order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = project.captions.items[id];
    if (item !== undefined && item.mergedIntoItemId === null) counts[item.current.state] += 1;
  }
  for (const id of project.audioDescriptions.order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = project.audioDescriptions.items[id];
    if (item !== undefined) counts[item.current.state] += 1;
  }
  return counts;
};

/**
 * Computes only facts already recorded in this project. In particular, this
 * function never inspects a clock, estimates time saved, or produces a legal,
 * accessibility, compliance, or industry-comparison score.
 */
export const buildImpactSummary = (
  project: CaptionProject,
  options: BuildImpactSummaryOptions = {},
): ImpactSummary => {
  const history = validationHistory(project);
  const initial = history[0]?.findings ?? [];
  const current = project.validationRun?.findings ?? currentCertification(project)?.validationRun?.findings ?? [];
  const currentIds = new Set(current.map((finding) => finding.findingId));
  const resolved = initial.filter((finding) => !currentIds.has(finding.findingId));
  const humanEvents = project.courtRecord.filter((event) => event.actor.type === "Human");
  const certification = currentCertification(project);
  const createdAt = timestamp(options.projectCreatedAtMs ?? project.createdAtMs);
  const timeToCertificationMs = certification === undefined || createdAt === undefined || certification.certifiedAtMs < createdAt
    ? undefined
    : certification.certifiedAtMs - createdAt;
  return {
    initialFindings: initial.length === 0 ? emptyFindingSummary() : summaryFor(initial),
    resolvedFindings: resolved.length === 0 ? emptyFindingSummary() : summaryFor(resolved),
    reviewStateCounts: stateCountsFor(project),
    humanInterventions: { count: humanEvents.length, events: structuredClone(humanEvents) },
    certificationState: project.certification.status,
    roundTripResult: options.roundTripResult === undefined ? null : structuredClone(options.roundTripResult),
    ...(timeToCertificationMs === undefined ? {} : { timeToCertificationMs }),
  };
};
