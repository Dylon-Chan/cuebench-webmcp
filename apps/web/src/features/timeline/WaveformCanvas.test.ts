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
});
