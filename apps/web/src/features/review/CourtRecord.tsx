import type { CaptionProject } from "@cuebench/domain";
import { useState } from "react";
import { actorLabel, eventLabel, reviewItemForId } from "./review-utils";

export interface CourtRecordProps {
  readonly project: CaptionProject;
  /** Selection is delegated to ReviewDocket so an event cannot discard a dirty draft. */
  readonly onSelectItem?: (itemId: string) => void;
}

const compactRecordLength = 4;

/** Append-only event ledger; no event timestamp is invented when the domain has none. */
export function CourtRecord({ project, onSelectItem }: CourtRecordProps) {
  const [showAll, setShowAll] = useState(false);
  const hasHiddenHistory = project.courtRecord.length > compactRecordLength;
  const events = showAll || !hasHiddenHistory
    ? project.courtRecord
    : project.courtRecord.slice(-compactRecordLength);

  return (
    <section className="court-record" aria-labelledby="court-record-heading">
      <div className="region-heading region-heading--compact">
        <div><h2 id="court-record-heading">Court Record</h2><p>Append-only project provenance</p></div>
        {hasHiddenHistory ? (
          <button className="header-button" type="button" onClick={() => setShowAll((current) => !current)}>
            {showAll ? "Show latest" : `Show all ${project.courtRecord.length}`}
          </button>
        ) : null}
      </div>
      {events.length === 0 ? (
        <div className="court-record__empty">
          <span className="record-rule" aria-hidden="true" />
          <p>No project events recorded yet.</p>
        </div>
      ) : (
        <ol className="court-record__entries" aria-label="Court Record entries">
          {events.map((event) => {
            const item = event.itemId === undefined ? null : reviewItemForId(project, event.itemId);
            return (
            <li key={event.eventId} data-project-revision={event.projectRevision}>
              <div className="court-record__event">
                <strong>{eventLabel(event.type)}</strong>
                <a href="#review-docket-heading" aria-label={`Open the Review Docket from Court Record project revision ${event.projectRevision}`}>Project r{event.projectRevision}</a>
              </div>
              <span className="court-record__actor">{actorLabel(event.actor)}</span>
              {event.itemId === undefined ? null : item === null ? <span>Item {event.itemId.toUpperCase()} is not present in the current project.</span> : (
                <button className="court-record__item-link" type="button" onClick={() => onSelectItem?.(item.itemId)} disabled={onSelectItem === undefined}>
                  Select current {item.itemId.toUpperCase()} r{item.current.itemRevision}
                </button>
              )}
              {event.detail === undefined ? null : <p>Reason: {event.detail}</p>}
            </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
