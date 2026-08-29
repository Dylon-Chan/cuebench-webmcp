import { describe, expect, it } from "vitest";
import { serializeTrack } from "@cuebench/domain";
import { fixtureAudioDescriptionTrack, fixtureCaptionTrack, fixtureProject } from "./project";
import expectedSrt from "./expected/lesson.srt?raw";
import expectedVtt from "./expected/lesson.vtt?raw";

describe("golden timed-text fixtures", () => {
  it("matches the standards-conforming VTT and SRT byte-for-byte", () => {
    const captions = fixtureCaptionTrack();
    expect(serializeTrack(captions, "vtt")).toBe(expectedVtt);
    expect(serializeTrack(captions, "srt")).toBe(expectedSrt);
  });
});
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
