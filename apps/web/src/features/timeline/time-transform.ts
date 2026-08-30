/** Canonical coordinate projection for every visual timeline operation. */
export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 64;

export interface TimeTransformOptions {
  readonly durationMs: number;
  readonly widthPx: number;
  readonly zoom?: number;
  readonly viewportStartMs?: number;
}

export interface TimeTransform {
  readonly durationMs: number;
  readonly widthPx: number;
  readonly zoom: number;
  readonly visibleStartMs: number;
  readonly visibleDurationMs: number;
  readonly visibleEndMs: number;
  msToX: (mediaTimeMs: number) => number;
  xToMs: (x: number) => number;
  resize: (widthPx: number) => TimeTransform;
}

export interface TimelineViewportBoundsOptions {
  readonly durationMs: number;
  readonly zoom?: number;
  readonly viewportStartMs: number;
}

const finiteInteger = (value: number, fallback = 0): number => Number.isFinite(value)
  ? Math.trunc(value)
  : fallback;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export const clampTimelineZoom = (zoom: number | undefined): number => clamp(
  Number.isFinite(zoom) ? zoom ?? MIN_TIMELINE_ZOOM : MIN_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  MAX_TIMELINE_ZOOM,
);

export const clampMediaTime = (mediaTimeMs: number, durationMs: number): number => clamp(
  finiteInteger(Math.round(mediaTimeMs)),
  0,
  Math.max(0, finiteInteger(durationMs)),
);

export const visibleTimelineDurationMs = (durationMs: number, zoom: number | undefined): number => {
  const normalizedDurationMs = Math.max(0, finiteInteger(durationMs));
  if (normalizedDurationMs === 0) return 0;
  return Math.max(1, Math.min(normalizedDurationMs, Math.ceil(normalizedDurationMs / clampTimelineZoom(zoom))));
};

/** Clamp the stored viewport state, not only a derived rendering projection. */
export const clampTimelineViewportStart = ({
  durationMs,
  zoom,
  viewportStartMs,
}: TimelineViewportBoundsOptions): number => {
  const normalizedDurationMs = Math.max(0, finiteInteger(durationMs));
  const visibleDurationMs = visibleTimelineDurationMs(normalizedDurationMs, zoom);
  return clamp(finiteInteger(viewportStartMs), 0, Math.max(0, normalizedDurationMs - visibleDurationMs));
};

export const formatMediaTime = (mediaTimeMs: number): string => {
  const value = Math.max(0, finiteInteger(mediaTimeMs));
  const milliseconds = value % 1_000;
  const wholeSeconds = Math.floor(value / 1_000);
  const seconds = wholeSeconds % 60;
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
};

/**
 * Maps integer Media Time to the current viewport. It deliberately contains
 * no React state, media clock, or mutable project data so drawing, hit testing,
 * keyboard edits, and WebMCP timing all share the same arithmetic.
 */
export const createTimeTransform = (options: TimeTransformOptions): TimeTransform => {
  const durationMs = Math.max(0, finiteInteger(options.durationMs));
  const widthPx = Math.max(1, finiteInteger(options.widthPx, 1));
  const zoom = clampTimelineZoom(options.zoom);
  const visibleDurationMs = visibleTimelineDurationMs(durationMs, zoom);
  const visibleStartMs = clampTimelineViewportStart({
    durationMs,
    zoom,
    viewportStartMs: options.viewportStartMs ?? 0,
  });
  const visibleEndMs = visibleStartMs + visibleDurationMs;

  const msToX = (mediaTimeMs: number): number => {
    if (visibleDurationMs === 0) return 0;
    return ((finiteInteger(mediaTimeMs) - visibleStartMs) / visibleDurationMs) * widthPx;
  };

  const xToMs = (x: number): number => {
    if (visibleDurationMs === 0) return 0;
    const candidate = visibleStartMs + (Number.isFinite(x) ? x : 0) / widthPx * visibleDurationMs;
    return clampMediaTime(candidate, durationMs);
  };

  return {
    durationMs,
    widthPx,
    zoom,
    visibleStartMs,
    visibleDurationMs,
    visibleEndMs,
    msToX,
    xToMs,
    resize: (nextWidthPx) => createTimeTransform({
      durationMs,
      widthPx: nextWidthPx,
      zoom,
      viewportStartMs: visibleStartMs,
    }),
  };
};
