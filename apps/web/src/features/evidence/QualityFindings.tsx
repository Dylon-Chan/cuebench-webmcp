import type { CaptionProject, QualityFinding } from "@cuebench/domain";
import type { ReviewIndexes, ReviewableItem } from "../review/review-utils";
import { findingsForItem, indexReviewData } from "../review/review-utils";

export interface QualityFindingsProps {
  readonly project: CaptionProject;
  readonly item?: ReviewableItem | null;
  readonly indexes?: ReviewIndexes;
  readonly onFocusFinding: (finding: QualityFinding) => void;
  readonly disabled?: boolean;
}

const findingScope = (finding: QualityFinding): string => {
  if (finding.target.type === "project") return "Project";
  if (finding.target.type === "item") return `${finding.target.itemId.toUpperCase()} r${finding.target.itemRevision}`;
  if (finding.target.type === "extended-description-requirement") return `Extended description ${finding.target.requirementId.toUpperCase()}`;
  return `${finding.target.first.itemId.toUpperCase()} r${finding.target.first.itemRevision} + ${finding.target.second.itemId.toUpperCase()} r${finding.target.second.itemRevision}`;
};

export function QualityFindings({ project, item = null, indexes, onFocusFinding, disabled = false }: QualityFindingsProps) {
  const resolvedIndexes = indexes ?? indexReviewData(project);
  const findings = item === null
    ? project.validationRun?.findings ?? []
    : findingsForItem(resolvedIndexes, item.itemId);
  const validationMessage = project.validation.status === "NotRun"
    ? "No validation run has been recorded."
    : project.validation.status === "Stale"
      ? "The displayed findings belong to a stale validation run. Revalidate before certification."
      : null;

  return (
    <section className="quality-findings" aria-labelledby={item === null ? "quality-findings-heading" : `quality-findings-${item.itemId}`}>
      <div className="panel-heading">
        <h3 id={item === null ? "quality-findings-heading" : `quality-findings-${item.itemId}`}>Quality findings</h3>
        <span>{findings.length}</span>
      </div>
      {validationMessage === null ? null : <p className="quality-findings__state">{validationMessage}</p>}
      {findings.length === 0 ? (
        <p>{item === null ? "No findings are attached to the available validation run." : "No findings are attached to this item in the available validation run."}</p>
      ) : (
        <ul className="quality-findings__list" aria-label={item === null ? "Quality findings" : `Quality findings for ${item.itemId.toUpperCase()}`}>
          {findings.map((finding) => (
            <li className={`quality-findings__item quality-findings__item--${finding.severity}`} key={finding.findingId}>
              <div>
                <strong>{finding.severity === "blocker" ? "Blocking finding" : "Warning"}</strong>
                <p>{finding.message}</p>
                <span>{findingScope(finding)} · {finding.ruleId}</span>
              </div>
              <button
                type="button"
                onClick={() => onFocusFinding(finding)}
                disabled={disabled || finding.target.type === "project" || finding.target.type === "extended-description-requirement"}
                aria-label={`Focus finding ${finding.findingId}: ${finding.message}`}
              >
                Focus
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
