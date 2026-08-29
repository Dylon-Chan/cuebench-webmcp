import { describe, expect, it } from "vitest";
import { fixtureAudioDescriptionTrack, fixtureCaptionTrack, fixtureProject } from "./project";

describe("CueBench fixture project", () => {
  it("contains deterministic caption and AD source tracks", () => {
    expect(fixtureProject()).toMatchObject({
      projectId: "lesson-project",
      media: { durationMs: 90_000 },
    });
    expect(fixtureCaptionTrack().order).toEqual(["c01", "c02"]);
    expect(fixtureAudioDescriptionTrack().order).toEqual(["ad01"]);
  });
});
