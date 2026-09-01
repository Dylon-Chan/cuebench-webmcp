import type { AudioDescriptionBeat } from "@cuebench/domain";
import type { KeyboardEvent, PointerEvent } from "react";
import type { TimeTransform } from "./time-transform";
import { formatMediaTime } from "./time-transform";
import type { TimelineEditEdge, TimelineEditPreview } from "./lane-types";

const maximumHandleTargetPx = 44;

export interface AdLaneProps {
  readonly beats: readonly AudioDescriptionBeat[];
  readonly transform: TimeTransform;
  readonly selectedItemId: string | null;
  readonly editPreview: TimelineEditPreview | null;
  readonly interactionDisabled: boolean;
  readonly onActivate: (beat: AudioDescriptionBeat) => void;
  readonly onRegisterItemButton: (itemId: string, element: HTMLButtonElement | null) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>, beat: AudioDescriptionBeat, edge: TimelineEditEdge) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
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
  interactionDisabled,
  onActivate,
  onRegisterItemButton,
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
          const width = transform.msToX(timing.endMs) - left;
          const startHandleMustInset = left < maximumHandleTargetPx;
          const endHandleMustInset = left + width > transform.widthPx - maximumHandleTargetPx;
          const selected = selectedItemId === beat.itemId;
          const label = `Audio description ${beat.itemId.toUpperCase()}: ${beat.current.description}`;
          return (
            <li
              key={beat.itemId}
              className="timeline-item timeline-item--audio-description"
              data-selected={selected || undefined}
              data-preview={editPreview?.itemId === beat.itemId || undefined}
              data-inset-start-handle={startHandleMustInset || undefined}
              data-inset-end-handle={endHandleMustInset || undefined}
              style={{ left: `${left}px`, width: `${width}px` }}
            >
              <button
                ref={(element) => onRegisterItemButton(beat.itemId, element)}
                className="timeline-item__body"
                type="button"
                onClick={() => onActivate(beat)}
                aria-label={label}
                aria-current={selected ? "true" : undefined}
                disabled={interactionDisabled}
              >
                <strong>{beat.itemId.toUpperCase()}</strong>
                <span>{beat.current.description}</span>
                <small>{formatMediaTime(timing.startMs)} → {formatMediaTime(timing.endMs)}</small>
              </button>
              <button
                className="timeline-item__handle timeline-item__handle--start"
                type="button"
                role="slider"
                aria-label={`Adjust start of audio description ${beat.itemId.toUpperCase()}`}
                aria-valuemin={0}
                aria-valuemax={timing.endMs - 1}
                aria-valuenow={timing.startMs}
                aria-valuetext={`Start time ${formatMediaTime(timing.startMs)}`}
                aria-orientation="horizontal"
                disabled={interactionDisabled}
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
                role="slider"
                aria-label={`Adjust end of audio description ${beat.itemId.toUpperCase()}`}
                aria-valuemin={timing.startMs + 1}
                aria-valuemax={transform.durationMs}
                aria-valuenow={timing.endMs}
                aria-valuetext={`End time ${formatMediaTime(timing.endMs)}`}
                aria-orientation="horizontal"
                disabled={interactionDisabled}
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
