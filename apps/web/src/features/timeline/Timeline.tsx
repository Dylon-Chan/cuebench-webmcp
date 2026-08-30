import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  DomainCommand,
  QualityFinding,
} from "@cuebench/domain";
import type { Actor } from "@cuebench/contracts";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { AdLane } from "./AdLane";
import { CaptionLane } from "./CaptionLane";
import type { TimelineEditEdge, TimelineEditPreview, TimelineLaneItem } from "./lane-types";
import { WaveformCanvas, type WaveformPeakPyramid } from "./WaveformCanvas";
import { clampMediaTime, clampTimelineZoom, createTimeTransform, formatMediaTime } from "./time-transform";

export type TimelineCommandExecutor = (command: DomainCommand) => void | Promise<unknown>;

export interface TimelineProps {
  readonly project: CaptionProject;
  readonly playheadMs: number;
  readonly seekToMediaTime: (mediaTimeMs: number) => void;
  readonly onCommand: TimelineCommandExecutor;
  readonly actor?: Actor;
  readonly peakPyramid?: WaveformPeakPyramid | null;
  /** A deterministic test and embed seam; production measures its own container. */
  readonly viewportWidth?: number;
  readonly onSelectionChange?: (itemId: string) => void;
}

interface TimelineViewport {
  readonly zoom: number;
  readonly viewportStartMs: number;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly edge: TimelineEditEdge;
}

const humanActor: Actor = { type: "Human", id: "human" };
const keyboardNudgeMs = 100;
const keyboardLargeNudgeMs = 1_000;

const defined = <Value,>(value: Value | undefined): value is Value => value !== undefined;

const captionCues = (project: CaptionProject): readonly CaptionCue[] => project.captions.order
  .map((itemId) => project.captions.items[itemId])
  .filter(defined);

const audioDescriptionBeats = (project: CaptionProject): readonly AudioDescriptionBeat[] => project.audioDescriptions.order
  .map((itemId) => project.audioDescriptions.items[itemId])
  .filter(defined);

const itemForFinding = (project: CaptionProject, finding: QualityFinding): TimelineLaneItem | null => {
  const target = finding.target;
  const itemId = target.type === "item" ? target.itemId : target.type === "pair" ? target.first.itemId : null;
  if (itemId === null) return null;
  return project.captions.items[itemId] ?? project.audioDescriptions.items[itemId] ?? null;
};

const clampPreviewTiming = (
  item: TimelineLaneItem,
  edge: TimelineEditEdge,
  candidateMs: number,
  durationMs: number,
): Pick<TimelineEditPreview, "startMs" | "endMs"> => {
  const current = item.current;
  const candidate = clampMediaTime(candidateMs, durationMs);
  if (edge === "start") {
    return { startMs: Math.min(candidate, current.endMs - 1), endMs: current.endMs };
  }
  return { startMs: current.startMs, endMs: Math.max(candidate, current.startMs + 1) };
};

const timelineTicks = (visibleDurationMs: number, startMs: number, endMs: number): readonly number[] => {
  const intervals = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000];
  const interval = intervals.find((candidate) => visibleDurationMs / candidate <= 8) ?? intervals.at(-1)!;
  const first = Math.ceil(startMs / interval) * interval;
  const ticks: number[] = [];
  for (let time = first; time <= endMs; time += interval) ticks.push(time);
  return ticks;
};

function useTimelineWidth(surfaceRef: React.RefObject<HTMLDivElement | null>, viewportWidth: number | undefined): number {
  const [measuredWidth, setMeasuredWidth] = useState(viewportWidth ?? 720);

  useLayoutEffect(() => {
    if (viewportWidth !== undefined) {
      setMeasuredWidth(Math.max(1, Math.trunc(viewportWidth)));
      return undefined;
    }
    const surface = surfaceRef.current;
    if (surface === null) return undefined;
    const measure = () => setMeasuredWidth(Math.max(1, Math.round(surface.getBoundingClientRect().width) || 720));
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surfaceRef, viewportWidth]);

  return measuredWidth;
}

export function Timeline({
  project,
  playheadMs,
  seekToMediaTime,
  onCommand,
  actor = humanActor,
  peakPyramid,
  viewportWidth,
  onSelectionChange,
}: TimelineProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const widthPx = useTimelineWidth(surfaceRef, viewportWidth);
  const [viewport, setViewport] = useState<TimelineViewport>({ zoom: 1, viewportStartMs: 0 });
  const [editPreview, setEditPreviewState] = useState<TimelineEditPreview | null>(null);
  const editPreviewRef = useRef<TimelineEditPreview | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const transform = useMemo(() => createTimeTransform({
    durationMs: project.media.durationMs,
    widthPx,
    zoom: viewport.zoom,
    viewportStartMs: viewport.viewportStartMs,
  }), [project.media.durationMs, viewport, widthPx]);
  const captions = useMemo(() => captionCues(project), [project]);
  const beats = useMemo(() => audioDescriptionBeats(project), [project]);
  const selectedItemId = project.selectedItem?.itemId ?? null;
  const ticks = useMemo(
    () => timelineTicks(transform.visibleDurationMs, transform.visibleStartMs, transform.visibleEndMs),
    [transform.visibleDurationMs, transform.visibleStartMs, transform.visibleEndMs],
  );

  const setEditPreview = useCallback((nextPreview: TimelineEditPreview | null) => {
    editPreviewRef.current = nextPreview;
    setEditPreviewState(nextPreview);
  }, []);

  const itemForId = useCallback((itemId: string): TimelineLaneItem | null => (
    project.captions.items[itemId] ?? project.audioDescriptions.items[itemId] ?? null
  ), [project.audioDescriptions.items, project.captions.items]);

  const issueCommand = useCallback((command: DomainCommand) => {
    void Promise.resolve(onCommand(command));
  }, [onCommand]);

  const selectItem = useCallback((item: TimelineLaneItem) => {
    seekToMediaTime(item.current.startMs);
    onSelectionChange?.(item.itemId);
    issueCommand({
      type: "SelectItem",
      actor,
      itemId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
    });
  }, [actor, issueCommand, onSelectionChange, project.projectRevision, seekToMediaTime]);

  const commitPreview = useCallback(() => {
    const preview = editPreviewRef.current;
    if (preview === null) return;
    setEditPreview(null);
    const unchangedItem = itemForId(preview.itemId);
    if (
      unchangedItem === null
      || (unchangedItem.current.startMs === preview.startMs && unchangedItem.current.endMs === preview.endMs)
    ) return;
    const command = preview.kind === "CaptionCue"
      ? {
          type: "AdjustCueTiming" as const,
          actor,
          cueId: preview.itemId,
          startMs: preview.startMs,
          endMs: preview.endMs,
          expectedItemRevision: preview.expectedItemRevision,
          expectedProjectRevision: preview.expectedProjectRevision,
        }
      : {
          type: "AdjustAudioDescriptionTiming" as const,
          actor,
          beatId: preview.itemId,
          startMs: preview.startMs,
          endMs: preview.endMs,
          expectedItemRevision: preview.expectedItemRevision,
          expectedProjectRevision: preview.expectedProjectRevision,
        };
    issueCommand(command);
  }, [actor, issueCommand, itemForId, setEditPreview]);

  const previewFromPointer = useCallback((item: TimelineLaneItem, edge: TimelineEditEdge, clientX: number) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const x = clientX - (bounds?.left ?? 0);
    const timing = clampPreviewTiming(item, edge, transform.xToMs(x), project.media.durationMs);
    setEditPreview({
      itemId: item.itemId,
      kind: item.kind,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
      ...timing,
    });
  }, [project.media.durationMs, project.projectRevision, setEditPreview, transform]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, item: TimelineLaneItem, edge: TimelineEditEdge) => {
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    dragRef.current = { pointerId, edge };
    event.currentTarget.setPointerCapture?.(pointerId);
    previewFromPointer(item, edge, event.clientX);
  }, [previewFromPointer]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const preview = editPreviewRef.current;
    if (drag === null || preview === null || drag.pointerId !== event.pointerId) return;
    const item = itemForId(preview.itemId);
    if (item === null) return;
    previewFromPointer(item, drag.edge, event.clientX);
  }, [itemForId, previewFromPointer]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commitPreview();
  }, [commitPreview]);

  const onPointerCancel = useCallback(() => {
    dragRef.current = null;
    setEditPreview(null);
  }, [setEditPreview]);

  const onKeyboardAdjust = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    item: TimelineLaneItem,
    edge: TimelineEditEdge,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const step = event.shiftKey ? keyboardLargeNudgeMs : keyboardNudgeMs;
    const previous = editPreviewRef.current?.itemId === item.itemId
      ? editPreviewRef.current
      : {
          itemId: item.itemId,
          kind: item.kind,
          expectedItemRevision: item.current.itemRevision,
          expectedProjectRevision: project.projectRevision,
          startMs: item.current.startMs,
          endMs: item.current.endMs,
        };
    const candidate = edge === "start" ? previous.startMs + direction * step : previous.endMs + direction * step;
    const timing = clampPreviewTiming(item, edge, candidate, project.media.durationMs);
    setEditPreview({ ...previous, ...timing });
  }, [project.media.durationMs, project.projectRevision, setEditPreview]);

  const onKeyboardCommit = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setEditPreview(null);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") commitPreview();
  }, [commitPreview, setEditPreview]);

  const changeZoom = (direction: -1 | 1) => {
    setViewport((current) => {
      const nextZoom = clampTimelineZoom(current.zoom * (direction > 0 ? 2 : 0.5));
      const nextVisibleDurationMs = Math.max(1, Math.min(project.media.durationMs, Math.ceil(project.media.durationMs / nextZoom)));
      const anchor = clampMediaTime(playheadMs, project.media.durationMs);
      return {
        zoom: nextZoom,
        viewportStartMs: anchor - Math.floor(nextVisibleDurationMs / 2),
      };
    });
  };

  const pan = (direction: -1 | 1) => {
    setViewport((current) => ({
      ...current,
      viewportStartMs: current.viewportStartMs + direction * Math.max(1, Math.floor(transform.visibleDurationMs / 2)),
    }));
  };

  const findingItems = project.validationRun?.findings ?? [];
  const seekInputValue = clampMediaTime(playheadMs, project.media.durationMs);

  return (
    <section className="timeline-shell" aria-labelledby="timeline-heading">
      <div className="region-heading region-heading--compact">
        <div><h2 id="timeline-heading">Shared timeline</h2><p>Native clock · integer Media Time</p></div>
        <div className="timeline-tools" aria-label="Timeline view controls">
          <button type="button" onClick={() => pan(-1)} aria-label="Pan timeline earlier">Earlier</button>
          <button type="button" onClick={() => changeZoom(-1)} aria-label="Zoom timeline out">−</button>
          <output aria-label="Timeline zoom">{transform.zoom}×</output>
          <button type="button" onClick={() => changeZoom(1)} aria-label="Zoom timeline in">+</button>
          <button type="button" onClick={() => pan(1)} aria-label="Pan timeline later">Later</button>
        </div>
      </div>
      <div ref={surfaceRef} className="timeline-surface" data-testid="timeline-surface">
        <div className="timeline-waveform" aria-label="Waveform peak evidence">
          <WaveformCanvas peakPyramid={peakPyramid} transform={transform} />
          <p className="timeline-waveform__status">{peakPyramid?.levels.length ? "Audio peak evidence" : "Audio peak evidence is unavailable until preparation finishes."}</p>
        </div>
        <svg className="timeline-scale" viewBox={`0 0 ${transform.widthPx} 26`} preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((time) => {
            const x = transform.msToX(time);
            return <g key={time} transform={`translate(${x} 0)`}><line y1="0" y2="26" /><text x="3" y="18">{formatMediaTime(time)}</text></g>;
          })}
        </svg>
        <CaptionLane
          cues={captions}
          transform={transform}
          selectedItemId={selectedItemId}
          editPreview={editPreview}
          onActivate={selectItem}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyboardAdjust={onKeyboardAdjust}
          onKeyboardCommit={onKeyboardCommit}
        />
        <AdLane
          beats={beats}
          transform={transform}
          selectedItemId={selectedItemId}
          editPreview={editPreview}
          onActivate={selectItem}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyboardAdjust={onKeyboardAdjust}
          onKeyboardCommit={onKeyboardCommit}
        />
        <div className="timeline-findings" aria-label="Quality finding markers">
          {findingItems.map((finding) => {
            const item = itemForFinding(project, finding);
            if (item === null) return null;
            return (
              <button
                key={finding.findingId}
                type="button"
                className={`timeline-finding timeline-finding--${finding.severity}`}
                style={{ left: `${transform.msToX(item.current.startMs)}px` }}
                onClick={() => selectItem(item)}
                aria-label={`${finding.severity} finding for ${item.itemId}: ${finding.message}`}
              >
                {finding.severity === "blocker" ? "Blocking finding" : "Warning finding"}
              </button>
            );
          })}
        </div>
        <span
          className="timeline-playhead"
          data-testid="timeline-playhead"
          data-media-time-ms={seekInputValue}
          style={{ left: `${transform.msToX(seekInputValue)}px` }}
          aria-hidden="true"
        />
      </div>
      <div className="timeline-accessible-controls">
        <label htmlFor="timeline-seek">Seek source media <output>{formatMediaTime(seekInputValue)}</output></label>
        <input
          id="timeline-seek"
          type="range"
          min={0}
          max={project.media.durationMs}
          step={1}
          value={seekInputValue}
          onChange={(event) => seekToMediaTime(Number(event.currentTarget.value))}
          aria-label="Seek source media"
        />
        <p>Use the cue and audio-description controls above to select or adjust timing. Arrow keys adjust the focused boundary; release the key to commit once.</p>
      </div>
    </section>
  );
}
