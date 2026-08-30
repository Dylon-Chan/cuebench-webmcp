import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM, createTimeTransform } from "./time-transform";

describe("TimeTransform", () => {
  it("round-trips visible Media Time through pixel space without creating float project time", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 15 * 60 * 1_000 }),
      fc.integer({ min: 120, max: 2_400 }),
      fc.integer({ min: 0, max: 10_000 }),
      (durationMs, widthPx, seed) => {
        const transform = createTimeTransform({ durationMs, widthPx });
        const mediaTimeMs = seed % (durationMs + 1);
        const returnedMs = transform.xToMs(transform.msToX(mediaTimeMs));

        expect(Number.isInteger(returnedMs)).toBe(true);
        expect(Math.abs(returnedMs - mediaTimeMs)).toBeLessThanOrEqual(1);
      },
    ));
  });

  it("clamps zoom and returns integer Media Time from fractional pixels", () => {
    const minimum = createTimeTransform({ durationMs: 90_000, widthPx: 900, zoom: 0.01 });
    const maximum = createTimeTransform({ durationMs: 90_000, widthPx: 900, zoom: 999 });

    expect(minimum.zoom).toBe(MIN_TIMELINE_ZOOM);
    expect(maximum.zoom).toBe(MAX_TIMELINE_ZOOM);
    expect(Number.isInteger(maximum.xToMs(123.456))).toBe(true);
    expect(maximum.xToMs(-500)).toBe(0);
    expect(maximum.xToMs(9_999_999)).toBe(90_000);
  });

  it("preserves the visible media window when its viewport is resized", () => {
    const transform = createTimeTransform({
      durationMs: 90_000,
      widthPx: 600,
      zoom: 4,
      viewportStartMs: 25_000,
    });
    const resized = transform.resize(1_200);

    expect(resized.widthPx).toBe(1_200);
    expect(resized.visibleStartMs).toBe(transform.visibleStartMs);
    expect(resized.visibleDurationMs).toBe(transform.visibleDurationMs);
    expect(resized.xToMs(resized.msToX(30_000))).toBe(30_000);
  });
});
