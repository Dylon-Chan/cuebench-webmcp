import type {
  AudioDescriptionBeat,
  CaptionCue,
  CaptionProject,
  CommandResult,
  DomainCommand,
  QualityFinding,
} from "@cuebench/domain";
import type { Actor } from "@cuebench/contracts";
import {
  useCallback,
  useEffect,
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
import {
  TIMELINE_WAVEFORM_HEIGHT_PX,
  WaveformCanvas,
  type WaveformPeakPyramid,
} from "./WaveformCanvas";
import {
  clampMediaTime,
  clampTimelineViewportStart,
  clampTimelineZoom,
  createTimeTransform,
  formatMediaTime,
  visibleTimelineDurationMs,
} from "./time-transform";

export type TimelineCommandExecutor = (command: DomainCommand) => CommandResult | Promise<CommandResult>;

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
  /** Lets a review owner guard cross-surface selection before the timeline mutates it. */
  readonly onRequestItemNavigation?: (itemId: string, sourceLabel: string) => void;
  /** A visible draft elsewhere owns the review authority boundary. */
  readonly reviewDraftActive?: boolean;
  /** Lets the review editor rebase a clean draft after this canonical timing edit. */
  readonly onCanonicalItemRevision?: (itemId: string, previousItemRevision: number, project: CaptionProject) => void;
}

interface TimelineViewport {
  readonly zoom: number;
  readonly viewportStartMs: number;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly itemId: string;
  readonly edge: TimelineEditEdge;
  readonly initialStartMs: number;
  readonly initialEndMs: number;
  readonly expectedItemRevision: number;
  readonly expectedProjectRevision: number;
  readonly grabOffsetMs: number;
  readonly originClientX: number;
  hasMoved: boolean;
}

const humanActor: Actor = { type: "Human", id: "human" };
const keyboardNudgeMs = 100;
const keyboardLargeNudgeMs = 1_000;
const dragThresholdPx = 3;
const isTimingAdjustmentKey = (key: string): boolean => ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(key);

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

const itemForProject = (project: CaptionProject, itemId: string): TimelineLaneItem | null => (
  project.captions.items[itemId] ?? project.audioDescriptions.items[itemId] ?? null
);

const clampPreviewTiming = (
  item: TimelineLaneItem,
  edge: TimelineEditEdge,
  candidateMs: number,
  durationMs: number,
  initialTiming?: Pick<TimelineEditPreview, "startMs" | "endMs">,
): Pick<TimelineEditPreview, "startMs" | "endMs"> => {
  const current = initialTiming ?? item.current;
  const candidate = clampMediaTime(candidateMs, durationMs);
  if (edge === "start") return { startMs: Math.min(candidate, current.endMs - 1), endMs: current.endMs };
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

const commandErrorMessage = (error: unknown): string => error instanceof Error && error.message.length > 0
  ? error.message
  : "CueBench could not apply this timeline change. The canonical project state was retained.";

const normalizeViewport = (viewport: TimelineViewport, durationMs: number): TimelineViewport => {
  const zoom = clampTimelineZoom(viewport.zoom);
  return {
    zoom,
    viewportStartMs: clampTimelineViewportStart({ durationMs, zoom, viewportStartMs: viewport.viewportStartMs }),
  };
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

/**
 * The timeline is a projection only. Every mutation crosses the same domain
 * command boundary as WebMCP, and native video remains the sole media clock.
 */
export function Timeline({
  project,
  playheadMs,
  seekToMediaTime,
  onCommand,
  actor = humanActor,
  peakPyramid,
  viewportWidth,
  onSelectionChange,
  onRequestItemNavigation,
  reviewDraftActive = false,
  onCanonicalItemRevision,
}: TimelineProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<PointerDrag | null>(null);
  const editPreviewRef = useRef<TimelineEditPreview | null>(null);
  const commandPendingRef = useRef(false);
  const commandEpochRef = useRef(0);
  const widthPx = useTimelineWidth(surfaceRef, viewportWidth);
  const [viewport, setViewport] = useState<TimelineViewport>({ zoom: 1, viewportStartMs: 0 });
  const [editPreview, setEditPreviewState] = useState<TimelineEditPreview | null>(null);
  const [isCommandPending, setIsCommandPending] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [acceptedFeedback, setAcceptedFeedback] = useState<string | null>(null);
  const [focusAfterAcceptedItemId, setFocusAfterAcceptedItemId] = useState<string | null>(null);
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
    [transform.visibleDurationMs, transform.visibleEndMs, transform.visibleStartMs],
  );

  useEffect(() => {
    setViewport((current) => {
      const next = normalizeViewport(current, project.media.durationMs);
      return next.zoom === current.zoom && next.viewportStartMs === current.viewportStartMs ? current : next;
    });
  }, [project.media.durationMs]);

  useEffect(() => {
    if (isCommandPending || focusAfterAcceptedItemId === null) return;
    itemButtonRefs.current.get(focusAfterAcceptedItemId)?.focus();
    setFocusAfterAcceptedItemId(null);
  }, [focusAfterAcceptedItemId, isCommandPending]);

  const setEditPreview = useCallback((nextPreview: TimelineEditPreview | null) => {
    editPreviewRef.current = nextPreview;
    setEditPreviewState(nextPreview);
  }, []);

  const registerItemButton = useCallback((itemId: string, element: HTMLButtonElement | null) => {
    if (element === null) itemButtonRefs.current.delete(itemId);
    else itemButtonRefs.current.set(itemId, element);
  }, []);

  const itemForId = useCallback((itemId: string): TimelineLaneItem | null => itemForProject(project, itemId), [project]);

  const executeTimelineCommand = useCallback(async (command: DomainCommand): Promise<CommandResult | null> => {
    if (commandPendingRef.current) return null;
    const epoch = commandEpochRef.current + 1;
    commandEpochRef.current = epoch;
    commandPendingRef.current = true;
    setIsCommandPending(true);
    setCommandFeedback(null);
    setAcceptedFeedback(null);
    try {
      const result = await onCommand(command);
      if (epoch !== commandEpochRef.current) return null;
      if (result.error !== undefined) setCommandFeedback(result.error.message);
      return result;
    } catch (error) {
      if (epoch === commandEpochRef.current) setCommandFeedback(commandErrorMessage(error));
      return null;
    } finally {
      if (epoch === commandEpochRef.current) {
        commandPendingRef.current = false;
        setIsCommandPending(false);
      }
    }
  }, [onCommand]);

  const selectItem = useCallback((item: TimelineLaneItem) => {
    if (commandPendingRef.current) return;
    if (onRequestItemNavigation !== undefined) {
      onRequestItemNavigation(item.itemId, `timeline ${item.kind === "CaptionCue" ? "caption" : "audio-description"} ${item.itemId.toUpperCase()}`);
      return;
    }
    const command: DomainCommand = {
      type: "SelectItem",
      actor,
      itemId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
    };
    void (async () => {
      const result = await executeTimelineCommand(command);
      if (result === null || result.error !== undefined) return;
      const canonicalItem = itemForProject(result.project, item.itemId);
      if (canonicalItem === null) return;
      seekToMediaTime(canonicalItem.current.startMs);
      onSelectionChange?.(canonicalItem.itemId);
      setFocusAfterAcceptedItemId(canonicalItem.itemId);
    })();
  }, [actor, executeTimelineCommand, onRequestItemNavigation, onSelectionChange, project.projectRevision, seekToMediaTime]);

  const commitPreview = useCallback(() => {
    if (commandPendingRef.current || reviewDraftActive) return;
    const preview = editPreviewRef.current;
    if (preview === null) return;
    setEditPreview(null);
    const unchangedItem = itemForId(preview.itemId);
    if (
      unchangedItem === null
      || (unchangedItem.current.startMs === preview.startMs && unchangedItem.current.endMs === preview.endMs)
    ) return;
    const command: DomainCommand = preview.kind === "CaptionCue"
      ? {
          type: "AdjustCueTiming",
          actor,
          cueId: preview.itemId,
          startMs: preview.startMs,
          endMs: preview.endMs,
          expectedItemRevision: preview.expectedItemRevision,
          expectedProjectRevision: preview.expectedProjectRevision,
        }
      : {
          type: "AdjustAudioDescriptionTiming",
          actor,
          beatId: preview.itemId,
          startMs: preview.startMs,
          endMs: preview.endMs,
          expectedItemRevision: preview.expectedItemRevision,
          expectedProjectRevision: preview.expectedProjectRevision,
        };
    void (async () => {
      const result = await executeTimelineCommand(command);
      if (result === null || result.error !== undefined) return;
      const canonicalItem = itemForProject(result.project, preview.itemId);
      if (canonicalItem === null) return;
      onCanonicalItemRevision?.(canonicalItem.itemId, preview.expectedItemRevision, result.project);
      const kind = canonicalItem.kind === "CaptionCue" ? "Caption" : "Audio description";
      setAcceptedFeedback(
        `${kind} ${canonicalItem.itemId.toUpperCase()} timing updated to ${formatMediaTime(canonicalItem.current.startMs)} to ${formatMediaTime(canonicalItem.current.endMs)}.`,
      );
    })();
  }, [actor, executeTimelineCommand, itemForId, onCanonicalItemRevision, reviewDraftActive, setEditPreview]);

  const localXForPointer = useCallback((clientX: number) => clientX - (surfaceRef.current?.getBoundingClientRect().left ?? 0), []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, item: TimelineLaneItem, edge: TimelineEditEdge) => {
    if (commandPendingRef.current || reviewDraftActive) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    const x = localXForPointer(event.clientX);
    const boundaryMs = edge === "start" ? item.current.startMs : item.current.endMs;
    dragRef.current = {
      pointerId: event.pointerId,
      itemId: item.itemId,
      edge,
      initialStartMs: item.current.startMs,
      initialEndMs: item.current.endMs,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
      grabOffsetMs: transform.xToMs(x) - boundaryMs,
      originClientX: event.clientX,
      hasMoved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [localXForPointer, project.projectRevision, reviewDraftActive, transform]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId || commandPendingRef.current) return;
    if (reviewDraftActive) {
      dragRef.current = null;
      setEditPreview(null);
      return;
    }
    if (!drag.hasMoved && Math.abs(event.clientX - drag.originClientX) < dragThresholdPx) return;
    drag.hasMoved = true;
    const item = itemForId(drag.itemId);
    if (item === null) return;
    const candidateMs = transform.xToMs(localXForPointer(event.clientX)) - drag.grabOffsetMs;
    const timing = clampPreviewTiming(item, drag.edge, candidateMs, project.media.durationMs, {
      startMs: drag.initialStartMs,
      endMs: drag.initialEndMs,
    });
    setEditPreview({
      itemId: drag.itemId,
      kind: item.kind,
      edge: drag.edge,
      expectedItemRevision: drag.expectedItemRevision,
      expectedProjectRevision: drag.expectedProjectRevision,
      ...timing,
    });
  }, [itemForId, localXForPointer, project.media.durationMs, reviewDraftActive, setEditPreview, transform]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.hasMoved) commitPreview();
  }, [commitPreview]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag !== null && drag.pointerId === event.pointerId) dragRef.current = null;
    setEditPreview(null);
  }, [setEditPreview]);

  const onKeyboardAdjust = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    item: TimelineLaneItem,
    edge: TimelineEditEdge,
  ) => {
    if (commandPendingRef.current || reviewDraftActive || !isTimingAdjustmentKey(event.key)) return;
    event.preventDefault();
    const currentPreview = editPreviewRef.current;
    const previous = currentPreview?.itemId === item.itemId && currentPreview.edge === edge
      ? currentPreview
      : {
          itemId: item.itemId,
          kind: item.kind,
          edge,
          expectedItemRevision: item.current.itemRevision,
          expectedProjectRevision: project.projectRevision,
          startMs: item.current.startMs,
          endMs: item.current.endMs,
        };
    const step = event.shiftKey ? keyboardLargeNudgeMs : keyboardNudgeMs;
    const decrement = event.key === "ArrowLeft" || event.key === "ArrowDown";
    const increment = event.key === "ArrowRight" || event.key === "ArrowUp";
    const candidate = event.key === "Home"
      ? edge === "start" ? 0 : previous.startMs + 1
      : event.key === "End"
        ? edge === "start" ? previous.endMs - 1 : project.media.durationMs
        : edge === "start"
          ? previous.startMs + (decrement ? -step : increment ? step : 0)
          : previous.endMs + (decrement ? -step : increment ? step : 0);
    const timing = clampPreviewTiming(item, edge, candidate, project.media.durationMs);
    setEditPreview({ ...previous, ...timing });
  }, [project.media.durationMs, project.projectRevision, reviewDraftActive, setEditPreview]);

  const onKeyboardCommit = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setEditPreview(null);
      return;
    }
    if (isTimingAdjustmentKey(event.key)) commitPreview();
  }, [commitPreview, setEditPreview]);

  const changeZoom = (direction: -1 | 1) => {
    setViewport((current) => {
      const nextZoom = clampTimelineZoom(current.zoom * (direction > 0 ? 2 : 0.5));
      const nextVisibleDurationMs = visibleTimelineDurationMs(project.media.durationMs, nextZoom);
      const anchorMs = clampMediaTime(playheadMs, project.media.durationMs);
      return {
        zoom: nextZoom,
        viewportStartMs: clampTimelineViewportStart({
          durationMs: project.media.durationMs,
          zoom: nextZoom,
          viewportStartMs: anchorMs - Math.floor(nextVisibleDurationMs / 2),
        }),
      };
    });
  };

  const pan = (direction: -1 | 1) => {
    setViewport((current) => ({
      zoom: current.zoom,
      viewportStartMs: clampTimelineViewportStart({
        durationMs: project.media.durationMs,
        zoom: current.zoom,
        viewportStartMs: current.viewportStartMs + direction * Math.max(1, Math.floor(visibleTimelineDurationMs(project.media.durationMs, current.zoom) / 2)),
      }),
    }));
  };

  const findingItems = project.validationRun?.findings ?? [];
  const seekInputValue = clampMediaTime(playheadMs, project.media.durationMs);
  const previewItem = editPreview === null ? null : itemForId(editPreview.itemId);
  const previewLabel = previewItem === null || editPreview === null
    ? null
    : `${previewItem.kind === "CaptionCue" ? "Caption" : "Audio description"} ${previewItem.itemId.toUpperCase()} ${editPreview.edge} preview ${formatMediaTime(editPreview.startMs)} to ${formatMediaTime(editPreview.endMs)}.`;

  return (
    <section className="timeline-shell" aria-labelledby="timeline-heading" aria-busy={isCommandPending || undefined}>
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
      <div
        ref={surfaceRef}
        className="timeline-surface"
        data-testid="timeline-surface"
        data-viewport-start-ms={viewport.viewportStartMs}
        data-visible-end-ms={transform.visibleEndMs}
      >
        <div className="timeline-waveform" role="img" aria-label="Waveform peak evidence">
          <WaveformCanvas height={TIMELINE_WAVEFORM_HEIGHT_PX} peakPyramid={peakPyramid} transform={transform} />
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
          interactionDisabled={isCommandPending || reviewDraftActive}
          onActivate={selectItem}
          onRegisterItemButton={registerItemButton}
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
          interactionDisabled={isCommandPending || reviewDraftActive}
          onActivate={selectItem}
          onRegisterItemButton={registerItemButton}
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
                disabled={isCommandPending || reviewDraftActive}
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
      {reviewDraftActive ? <p className="timeline-command-feedback" role="status" aria-live="polite">Save, discard, or cancel the visible review draft before selecting or adjusting another timeline item.</p> : null}
      {previewLabel === null ? null : <p className="timeline-preview-feedback" data-testid="timeline-preview-feedback" role="status" aria-live="polite">{previewLabel}</p>}
      {acceptedFeedback === null ? null : <p className="timeline-accepted-feedback" data-testid="timeline-accepted-feedback" role="status" aria-live="polite">{acceptedFeedback}</p>}
      {commandFeedback === null ? null : <p className="timeline-command-feedback" role="alert">{commandFeedback}</p>}
    </section>
  );
}
