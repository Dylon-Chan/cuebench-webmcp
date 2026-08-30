import type { CaptionProject } from "@cuebench/domain";
import type { ReviewableItem } from "../review/review-utils";
import {
  evidenceAnchorId,
  evidenceForItem,
  itemAccessibleLabel,
} from "../review/review-utils";

export interface EvidenceInspectorProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
}

/**
 * The browser retains only compact, auditable evidence provenance here. It
 * deliberately does not fabricate transcript text, frames, or confidence
 * values that are not present in the canonical local evidence package.
 */
export function EvidenceInspector({ project, item }: EvidenceInspectorProps) {
  if (item === null) {
    return (
      <section className="evidence-inspector" aria-labelledby="evidence-inspector-heading">
        <h3 id="evidence-inspector-heading">Evidence</h3>
        <p>Select a cue or audio-description beat to inspect its retained evidence provenance.</p>
      </section>
    );
  }

  const evidence = evidenceForItem(project, item);
  return (
    <section className="evidence-inspector" aria-labelledby="evidence-inspector-heading">
      <div className="panel-heading">
        <h3 id="evidence-inspector-heading">Evidence</h3>
        <span>{evidence.length} retained link{evidence.length === 1 ? "" : "s"}</span>
      </div>
      {evidence.length === 0 ? (
        <p>No retained evidence provenance is bound to {itemAccessibleLabel(item)}.</p>
      ) : (
        <ul className="evidence-inspector__list" aria-label={`Evidence links for ${itemAccessibleLabel(item)}`}>
          {evidence.map((entry) => {
            const current = entry.itemRevision === item.current.itemRevision;
            const currentMedia = entry.mediaSha256 === project.media.sha256;
            return (
              <li id={evidenceAnchorId(entry.evidenceId)} key={entry.evidenceId}>
                <strong>{entry.evidenceId}</strong>
                <span>{current ? `Current revision r${entry.itemRevision}` : `Revision r${entry.itemRevision}`}</span>
                <span>{currentMedia ? "Current media binding" : "Historical media binding"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
