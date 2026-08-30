import type { AudioDescriptionBeat } from "@cuebench/domain";
import type { KeyboardEvent, PointerEvent } from "react";
import type { TimeTransform } from "./time-transform";
import { formatMediaTime } from "./time-transform";
import type { TimelineEditEdge, TimelineEditPreview } from "./lane-types";

export interface AdLaneProps {
  readonly beats: readonly AudioDescriptionBeat[];
  readonly transform: TimeTransform;
  readonly selectedItemId: string | null;
  readonly editPreview: TimelineEditPreview | null;
  readonly onActivate: (beat: AudioDescriptionBeat) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>, beat: AudioDescriptionBeat, edge: TimelineEditEdge) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onKeyboardAdjust: (event: KeyboardEvent<HTMLButtonElement>, beat: AudioDescriptionBeat, edge: TimelineEditEdge) => void;
  readonly onKeyboardCommit: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const previewTiming = (beat: AudioDescriptionBeat, preview: TimelineEditPreview | null) => preview?.itemId === beat.itemId
  ? preview
  : beat.current;

export function AdLane({
  beats,
  transform,
  selectedItemId,
  editPreview,
  onActivate,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyboardAdjust,
  onKeyboardCommit,
}: AdLaneProps) {
  return (
    <section className="timeline-lane timeline-lane--audio-description" aria-labelledby="ad-lane-heading">
      <div className="timeline-lane__label"><h3 id="ad-lane-heading">Audio description</h3><span>{beats.length} beats</span></div>
      <ol className="timeline-lane__items" aria-label="Audio-description beat timing controls">
        {beats.map((beat) => {
          const timing = previewTiming(beat, editPreview);
          const left = transform.msToX(timing.startMs);
          const width = Math.max(8, transform.msToX(timing.endMs) - left);
          const selected = selectedItemId === beat.itemId;
          const label = `Audio description ${beat.itemId.toUpperCase()}: ${beat.current.description}`;
          return (
            <li
              key={beat.itemId}
              className="timeline-item timeline-item--audio-description"
              data-selected={selected || undefined}
              data-preview={editPreview?.itemId === beat.itemId || undefined}
              style={{ left: `${left}px`, width: `${width}px` }}
            >
              <button className="timeline-item__body" type="button" onClick={() => onActivate(beat)} aria-label={label}>
                <strong>{beat.itemId.toUpperCase()}</strong>
                <span>{beat.current.description}</span>
                <small>{formatMediaTime(timing.startMs)} → {formatMediaTime(timing.endMs)}</small>
              </button>
              <button
                className="timeline-item__handle timeline-item__handle--start"
                type="button"
                aria-label={`Adjust start of audio description ${beat.itemId.toUpperCase()}`}
                onPointerDown={(event) => onPointerDown(event, beat, "start")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onKeyDown={(event) => onKeyboardAdjust(event, beat, "start")}
                onKeyUp={onKeyboardCommit}
              />
              <button
                className="timeline-item__handle timeline-item__handle--end"
                type="button"
                aria-label={`Adjust end of audio description ${beat.itemId.toUpperCase()}`}
                onPointerDown={(event) => onPointerDown(event, beat, "end")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onKeyDown={(event) => onKeyboardAdjust(event, beat, "end")}
                onKeyUp={onKeyboardCommit}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
