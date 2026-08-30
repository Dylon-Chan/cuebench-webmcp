import type { CaptionProject } from "@cuebench/domain";
import { useState } from "react";
import {
  actorLabel,
  courtRecordRevisionForEvent,
  eventLabel,
  reviewItemForId,
} from "./review-utils";

export interface CourtRecordProps {
  readonly project: CaptionProject;
  /** Selection is delegated to ReviewDocket so an event cannot discard a dirty draft. */
  readonly onSelectItem?: (itemId: string) => void;
  /** Derived historical targets open the exact immutable revision when possible. */
  readonly onFocusItemRevision?: (itemId: string, itemRevision: number) => void;
}

const compactRecordLength = 4;
const actorKey = (actor: { readonly type: string; readonly id: string }): string => `${actor.type}:${actor.id}`;
const recordEventId = (eventId: string): string => `court-record-event-${encodeURIComponent(eventId)}`;

/** Append-only event ledger; no event timestamp is invented when the domain has none. */
export function CourtRecord({ project, onSelectItem, onFocusItemRevision }: CourtRecordProps) {
  const [showAll, setShowAll] = useState(false);
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const filteredRecord = actorFilter === null
    ? project.courtRecord
    : project.courtRecord.filter((event) => actorKey(event.actor) === actorFilter);
  const hasHiddenHistory = filteredRecord.length > compactRecordLength;
  const events = showAll || !hasHiddenHistory
    ? filteredRecord
    : filteredRecord.slice(-compactRecordLength);
  const activeActor = actorFilter === null ? null : project.courtRecord.find((event) => actorKey(event.actor) === actorFilter)?.actor ?? null;

  return (
    <section className="court-record" aria-labelledby="court-record-heading">
      <div className="region-heading region-heading--compact">
        <div>
          <h2 id="court-record-heading">Court Record</h2>
          <p>{activeActor === null ? "Append-only project provenance" : `Append-only provenance filtered to ${actorLabel(activeActor)}`}</p>
        </div>
        <div className="court-record__controls">
          {actorFilter === null ? null : <button className="header-button" type="button" onClick={() => { setActorFilter(null); setShowAll(true); }}>Clear actor filter</button>}
          {hasHiddenHistory ? (
            <button className="header-button" type="button" onClick={() => setShowAll((current) => !current)}>
              {showAll ? "Show latest" : `Show all ${filteredRecord.length}`}
            </button>
          ) : null}
        </div>
      </div>
      {events.length === 0 ? (
        <div className="court-record__empty">
          <span className="record-rule" aria-hidden="true" />
          <p>No project events recorded for this actor.</p>
        </div>
      ) : (
        <ol className="court-record__entries" aria-label="Court Record entries">
          {events.map((event) => {
            const item = event.itemId === undefined ? null : reviewItemForId(project, event.itemId);
            const historicalRevision = courtRecordRevisionForEvent(project, event);
            const eventAnchor = recordEventId(event.eventId);
            const eventActorKey = actorKey(event.actor);
            return (
              <li id={eventAnchor} key={event.eventId} tabIndex={-1} data-project-revision={event.projectRevision}>
                <div className="court-record__event">
                  <strong>{eventLabel(event.type)}</strong>
                  <a
                    href={`#${eventAnchor}`}
                    aria-label={`Focus Court Record project revision ${event.projectRevision}`}
                    onClick={(clickEvent) => {
                      clickEvent.preventDefault();
                      document.getElementById(eventAnchor)?.focus();
                    }}
                  >Project r{event.projectRevision}</a>
                </div>
                <button
                  className="court-record__actor"
                  type="button"
                  aria-pressed={actorFilter === eventActorKey}
                  aria-label={`Filter Court Record to ${actorLabel(event.actor)}`}
                  onClick={() => { setActorFilter(eventActorKey); setShowAll(true); }}
                >{actorLabel(event.actor)}</button>
                {event.itemId === undefined ? null : item === null ? <span>Item {event.itemId.toUpperCase()} is not present in the current project.</span> : (
                  <div className="court-record__item-actions">
                    {historicalRevision === null ? null : <button className="court-record__item-link" type="button" onClick={() => onFocusItemRevision?.(item.itemId, historicalRevision)} disabled={onFocusItemRevision === undefined}>
                      Open {item.itemId.toUpperCase()} r{historicalRevision} in revision ancestry
                    </button>}
                    <button className="court-record__item-link" type="button" onClick={() => onSelectItem?.(item.itemId)} disabled={onSelectItem === undefined}>
                      Select current {item.itemId.toUpperCase()} r{item.current.itemRevision}
                    </button>
                  </div>
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
