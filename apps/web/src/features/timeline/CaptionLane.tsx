import type { CaptionCue } from "@cuebench/domain";
import type { KeyboardEvent, PointerEvent } from "react";
import type { TimeTransform } from "./time-transform";
import { formatMediaTime } from "./time-transform";
import type { TimelineEditEdge, TimelineEditPreview } from "./lane-types";

export interface CaptionLaneProps {
  readonly cues: readonly CaptionCue[];
  readonly transform: TimeTransform;
  readonly selectedItemId: string | null;
  readonly editPreview: TimelineEditPreview | null;
  readonly onActivate: (cue: CaptionCue) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>, cue: CaptionCue, edge: TimelineEditEdge) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onKeyboardAdjust: (event: KeyboardEvent<HTMLButtonElement>, cue: CaptionCue, edge: TimelineEditEdge) => void;
  readonly onKeyboardCommit: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const previewTiming = (cue: CaptionCue, preview: TimelineEditPreview | null) => preview?.itemId === cue.itemId
  ? preview
  : cue.current;

export function CaptionLane({
  cues,
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
}: CaptionLaneProps) {
  return (
    <section className="timeline-lane timeline-lane--captions" aria-labelledby="caption-lane-heading">
      <div className="timeline-lane__label"><h3 id="caption-lane-heading">Captions</h3><span>{cues.length} cues</span></div>
      <ol className="timeline-lane__items" aria-label="Caption cue timing controls">
        {cues.map((cue) => {
          const timing = previewTiming(cue, editPreview);
          const left = transform.msToX(timing.startMs);
          const width = Math.max(8, transform.msToX(timing.endMs) - left);
          const selected = selectedItemId === cue.itemId;
          const label = `Caption ${cue.itemId.toUpperCase()}: ${cue.current.text}`;
          return (
            <li
              key={cue.itemId}
              className="timeline-item timeline-item--caption"
              data-selected={selected || undefined}
              data-preview={editPreview?.itemId === cue.itemId || undefined}
              style={{ left: `${left}px`, width: `${width}px` }}
            >
              <button className="timeline-item__body" type="button" onClick={() => onActivate(cue)} aria-label={label}>
                <strong>{cue.itemId.toUpperCase()}</strong>
                <span>{cue.current.text}</span>
                <small>{formatMediaTime(timing.startMs)} → {formatMediaTime(timing.endMs)}</small>
              </button>
              <button
                className="timeline-item__handle timeline-item__handle--start"
                type="button"
                aria-label={`Adjust start of caption ${cue.itemId.toUpperCase()}`}
                onPointerDown={(event) => onPointerDown(event, cue, "start")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onKeyDown={(event) => onKeyboardAdjust(event, cue, "start")}
                onKeyUp={onKeyboardCommit}
              />
              <button
                className="timeline-item__handle timeline-item__handle--end"
                type="button"
                aria-label={`Adjust end of caption ${cue.itemId.toUpperCase()}`}
                onPointerDown={(event) => onPointerDown(event, cue, "end")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onKeyDown={(event) => onKeyboardAdjust(event, cue, "end")}
                onKeyUp={onKeyboardCommit}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
