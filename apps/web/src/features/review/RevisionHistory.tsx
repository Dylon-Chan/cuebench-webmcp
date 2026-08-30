import type { CaptionProject, EvidenceProvenance } from "@cuebench/domain";
import { useEffect, useState } from "react";
import type { ReviewableItem } from "./review-utils";
import { actorLabel, evidenceAnchorId, reviewStateLabel } from "./review-utils";

export interface RevisionHistoryProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
  readonly evidence: readonly EvidenceProvenance[];
  readonly onFocusEvidence: (evidenceId: string) => void;
}

const formatMs = (value: number): string => value.toLocaleString("en-US");

/** Immutable revision payloads are disclosed on demand without reconstituting history. */
export function RevisionHistory({ project, item, evidence, onFocusEvidence }: RevisionHistoryProps) {
  const [expandedRevision, setExpandedRevision] = useState<number | null>(null);

  useEffect(() => setExpandedRevision(null), [item?.itemId]);

  if (item === null) {
    return (
      <section className="revision-history" aria-labelledby="revision-history-heading">
        <h3 id="revision-history-heading">Revision ancestry</h3>
        <p>Select an item to inspect its immutable revision chain.</p>
      </section>
    );
  }

  return (
    <section className="revision-history" aria-labelledby={`revision-history-${item.itemId}`}>
      <div className="panel-heading">
        <h3 id={`revision-history-${item.itemId}`}>Revision ancestry</h3>
        <span>{item.revisions.length} revision{item.revisions.length === 1 ? "" : "s"}</span>
      </div>
      <ol aria-label={`Revision ancestry for ${item.itemId.toUpperCase()}`}>
        {[...item.revisions].reverse().map((revision) => {
          const current = revision.itemRevision === item.current.itemRevision;
          const expanded = expandedRevision === revision.itemRevision;
          const bindings = evidence.filter((entry) => entry.itemRevision === revision.itemRevision);
          const detailsId = `revision-payload-${item.itemId}-${revision.itemRevision}`;
          return (
            <li key={revision.itemRevision} aria-current={current ? "true" : undefined}>
              <div>
                <strong>r{revision.itemRevision}</strong>
                <span className={`review-state review-state--${revision.state.toLowerCase()}`}>{reviewStateLabel(revision.state)}</span>
              </div>
              <p>{actorLabel(revision.actor)} · {revision.cause}</p>
              <small>{revision.parentItemRevision === null ? "Root revision" : `Parent r${revision.parentItemRevision}`}</small>
              <button className="text-button" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedRevision(expanded ? null : revision.itemRevision)}>
                {expanded ? `Hide immutable payload for ${item.itemId.toUpperCase()} r${revision.itemRevision}` : `Show immutable payload for ${item.itemId.toUpperCase()} r${revision.itemRevision}`}
              </button>
              {expanded ? (
                <div className="revision-history__payload" id={detailsId}>
                  <dl>
                    <div><dt>Timing</dt><dd>{formatMs(revision.startMs)}–{formatMs(revision.endMs)} ms</dd></div>
                    {revision.kind === "CaptionCue" ? <div><dt>Caption text</dt><dd>{revision.text}</dd></div> : <div><dt>Audio-description text</dt><dd>{revision.description}</dd></div>}
                    {revision.kind === "CaptionCue" ? <div><dt>Speaker</dt><dd>Speaker: {revision.speaker ?? "Unattributed"}</dd></div> : null}
                    <div><dt>Actor</dt><dd>{actorLabel(revision.actor)}</dd></div>
                    <div><dt>Cause</dt><dd>{revision.cause}</dd></div>
                    <div><dt>Parent</dt><dd>{revision.parentItemRevision === null ? "Root revision" : `r${revision.parentItemRevision}`}</dd></div>
                  </dl>
                  {bindings.length === 0 ? <p>No retained evidence binding IDs for this immutable revision.</p> : <ul aria-label={`Evidence binding IDs for ${item.itemId.toUpperCase()} r${revision.itemRevision}`}>{bindings.map((binding) => <li key={binding.evidenceId}><a href={`#${evidenceAnchorId(binding.evidenceId)}`} onClick={(event) => { event.preventDefault(); onFocusEvidence(binding.evidenceId); }}>{binding.evidenceId}</a><span>{binding.mediaSha256 === project.media.sha256 ? "Current media binding" : "Historical media binding"}</span></li>)}</ul>}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
