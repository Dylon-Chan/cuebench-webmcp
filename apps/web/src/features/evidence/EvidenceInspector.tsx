import type { CaptionProject, EvidenceProvenance } from "@cuebench/domain";
import type { ReviewIndexes, ReviewableItem } from "../review/review-utils";
import {
  evidenceAnchorId,
  evidenceForItem,
  itemAccessibleLabel,
} from "../review/review-utils";

/**
 * Task 11 can provide bounded local evidence through this resolver without
 * changing review state or treating remote processing artifacts as project
 * truth. Returning null means the Local Evidence Package did not retain it.
 */
export interface LocalEvidenceWindow {
  readonly evidenceId: string;
  readonly source: "LocalEvidencePackage";
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface EvidenceContentResolver {
  resolve(evidence: EvidenceProvenance): LocalEvidenceWindow | null;
}

export interface EvidenceInspectorProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
  readonly indexes: ReviewIndexes;
  readonly contentResolver?: EvidenceContentResolver;
  readonly onFocusEvidence: (evidenceId: string) => void;
}

/**
 * Provenance is canonical even when the bounded source window is not retained.
 * No transcript, representative frame, confidence, or media segment is shown
 * unless a Local Evidence Package resolver supplies that exact content.
 */
export function EvidenceInspector({ project, item, indexes, contentResolver, onFocusEvidence }: EvidenceInspectorProps) {
  if (item === null) {
    return (
      <section className="evidence-inspector" aria-labelledby="evidence-inspector-heading">
        <h3 id="evidence-inspector-heading">Evidence</h3>
        <p>Select a cue or audio-description beat to inspect its retained evidence provenance.</p>
      </section>
    );
  }

  const evidence = evidenceForItem(indexes, item.itemId);
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
            const boundedWindow = contentResolver?.resolve(entry) ?? null;
            return (
              <li id={evidenceAnchorId(entry.evidenceId)} key={entry.evidenceId} tabIndex={-1}>
                <strong>{entry.evidenceId}</strong>
                <span>{current ? `Current revision r${entry.itemRevision}` : `Revision r${entry.itemRevision}`}</span>
                <span>{currentMedia ? "Current media binding" : "Historical media binding"}</span>
                {boundedWindow === null ? (
                  <span className="evidence-inspector__missing">No bounded evidence window was captured in the Local Evidence Package for this provenance link.</span>
                ) : (
                  <span className="evidence-inspector__window">{boundedWindow.source} · {boundedWindow.label} · {boundedWindow.startMs}–{boundedWindow.endMs} ms</span>
                )}
                <button className="text-button" type="button" onClick={() => onFocusEvidence(entry.evidenceId)}>Focus this evidence</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
