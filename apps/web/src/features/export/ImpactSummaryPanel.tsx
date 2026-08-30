import { buildImpactSummary, type CaptionProject } from "@cuebench/domain";

export interface ImpactSummaryPanelProps {
  readonly project: CaptionProject;
  readonly compact?: boolean;
}

/** Renders exactly the local project facts from the domain summary; it deliberately invents no estimates or compliance score. */
export function ImpactSummaryPanel({ project, compact = false }: ImpactSummaryPanelProps) {
  const summary = buildImpactSummary(project);
  return (
    <section className={`impact-summary${compact ? " impact-summary--compact" : ""}`} aria-label="Project impact summary">
      <h3>Project impact summary</h3>
      <dl>
        <div><dt>Initial findings</dt><dd>{summary.initialFindings.total} ({summary.initialFindings.blockerCount} blockers · {summary.initialFindings.warningCount} warnings)</dd></div>
        <div><dt>Resolved findings</dt><dd>{summary.resolvedFindings.total} ({summary.resolvedFindings.blockerCount} blockers · {summary.resolvedFindings.warningCount} warnings)</dd></div>
        <div><dt>Review states</dt><dd>Proposed {summary.reviewStateCounts.Proposed} · Agent Ready {summary.reviewStateCounts.AgentReady} · Objected {summary.reviewStateCounts.Objected} · Sustained {summary.reviewStateCounts.Sustained}</dd></div>
        <div><dt>Human interventions</dt><dd>{summary.humanInterventions.count}</dd></div>
        <div><dt>Certification state</dt><dd>{summary.certificationState}</dd></div>
        <div><dt>Latest round-trip result</dt><dd>{summary.roundTripResult === null ? "No verified export recorded" : "Verified"}</dd></div>
        {summary.timeToCertificationMs === undefined ? null : <div><dt>Time to certification</dt><dd>{summary.timeToCertificationMs} ms</dd></div>}
      </dl>
    </section>
  );
}
