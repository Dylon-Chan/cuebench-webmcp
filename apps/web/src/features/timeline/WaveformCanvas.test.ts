import { describe, expect, it } from "vitest";
import { createPeakPyramid } from "./WaveformCanvas";

describe("createPeakPyramid", () => {
  it("uses exact deterministic 10 ms bucket boundaries rather than rounded sample counts", () => {
    const samples = new Float32Array(441);
    samples[220] = -0.75;

    const pyramid = createPeakPyramid([samples], 22_050);

    expect(pyramid.baseResolutionMs).toBe(10);
    expect(pyramid.levels[0]?.resolutionMs).toBe(10);
    expect(pyramid.levels[0]?.peaks[0]).toEqual({ min: 0, max: 0 });
    expect(pyramid.levels[0]?.peaks[1]).toEqual({ min: -0.75, max: 0 });
  });

  it("preserves exact all-positive extrema instead of manufacturing a zero baseline", () => {
    const samples = new Float32Array(960);
    samples.fill(0.25);
    samples[13] = 0.125;
    samples[491] = 0.875;

    const pyramid = createPeakPyramid([samples], 48_000);

    expect(pyramid.levels[0]?.peaks[0]).toEqual({ min: 0.125, max: 0.25 });
    expect(pyramid.levels[0]?.peaks[1]).toEqual({ min: 0.25, max: 0.875 });
    expect(pyramid.levels[1]?.peaks[0]).toEqual({ min: 0.125, max: 0.875 });
  });

  it("preserves exact all-negative extrema and handles an empty source", () => {
    const samples = new Float32Array(960);
    samples.fill(-0.25);
    samples[13] = -0.875;
    samples[491] = -0.0625;

    const pyramid = createPeakPyramid([samples], 48_000);

    expect(pyramid.levels[0]?.peaks[0]).toEqual({ min: -0.875, max: -0.25 });
    expect(pyramid.levels[0]?.peaks[1]).toEqual({ min: -0.25, max: -0.0625 });
    expect(createPeakPyramid([new Float32Array()], 48_000).levels).toEqual([]);
  });

  it("uses the available audio channel when another channel is empty", () => {
    const samples = new Float32Array(480);
    samples.fill(0.5);
    samples[12] = 0.25;

    const pyramid = createPeakPyramid([new Float32Array(), samples], 48_000);

    expect(pyramid.levels[0]?.peaks).toEqual([{ min: 0.25, max: 0.5 }]);
  });
});
