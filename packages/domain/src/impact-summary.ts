import type { CaptionProject, DomainEvent } from "./model";
import { findingIdentityFor, type QualityFinding } from "./quality/validate";

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
  readonly roundTripResult: { readonly ok: true } | null;
  readonly timeToCertificationMs?: number;
}

const emptyFindingSummary = (): FindingSummary => ({ total: 0, blockerCount: 0, warningCount: 0, findings: [] });

const summaryFor = (findings: readonly QualityFinding[]): FindingSummary => ({
  total: findings.length,
  blockerCount: findings.filter((finding) => finding.severity === "blocker").length,
  warningCount: findings.filter((finding) => finding.severity === "warning").length,
  findings: structuredClone(findings),
});

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
): ImpactSummary => {
  const history = project.validationHistory;
  const initial = history[0]?.findings ?? [];
  const current = project.validationRun?.findings ?? currentCertification(project)?.validationRun?.findings ?? [];
  const currentIdentities = new Set(current.map(findingIdentityFor));
  const resolved = initial.filter((finding) => !currentIdentities.has(findingIdentityFor(finding)));
  const humanEvents = project.courtRecord.filter((event) => event.actor.type === "Human");
  const certification = currentCertification(project);
  const createdAt = timestamp(project.createdAtMs);
  const timeToCertificationMs = certification === undefined || createdAt === undefined || certification.certifiedAtMs < createdAt
    ? undefined
    : certification.certifiedAtMs - createdAt;
  return {
    initialFindings: initial.length === 0 ? emptyFindingSummary() : summaryFor(initial),
    resolvedFindings: resolved.length === 0 ? emptyFindingSummary() : summaryFor(resolved),
    reviewStateCounts: stateCountsFor(project),
    humanInterventions: { count: humanEvents.length, events: structuredClone(humanEvents) },
    certificationState: project.certification.status,
    roundTripResult: project.exportHistory.at(-1)?.roundTrip === undefined
      ? null
      : structuredClone(project.exportHistory.at(-1)!.roundTrip),
    ...(timeToCertificationMs === undefined ? {} : { timeToCertificationMs }),
  };
};
