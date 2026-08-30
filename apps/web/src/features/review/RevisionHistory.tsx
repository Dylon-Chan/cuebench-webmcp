import type { ReviewableItem } from "./review-utils";
import { actorLabel, reviewStateLabel } from "./review-utils";

export interface RevisionHistoryProps {
  readonly item: ReviewableItem | null;
}

export function RevisionHistory({ item }: RevisionHistoryProps) {
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
          return (
            <li key={revision.itemRevision} aria-current={current ? "true" : undefined}>
              <div>
                <strong>r{revision.itemRevision}</strong>
                <span className={`review-state review-state--${revision.state.toLowerCase()}`}>{reviewStateLabel(revision.state)}</span>
              </div>
              <p>{actorLabel(revision.actor)} · {revision.cause}</p>
              <small>{revision.parentItemRevision === null ? "Root revision" : `Parent r${revision.parentItemRevision}`}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
