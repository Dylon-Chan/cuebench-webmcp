import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import referenceProject from "../../../../../tools/sample/reference-project.json";
import replayEvents from "../../../../../tools/sample/replay-events.json";

const repositoryRoot = resolve(import.meta.dirname, "../../../../..");
const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("checked-in Gibbs lesson build inputs", () => {
  it("pins the lossless narration mix and every authored build input by hash", () => {
    const input = referenceProject.buildInputs;
    const audioPath = resolve(repositoryRoot, input.audioTrack.path);
    const svgPath = resolve(repositoryRoot, input.slideSvg.path);
    const transcriptPath = resolve(repositoryRoot, input.transcript.path);
    const replayPath = resolve(repositoryRoot, input.replayEvents.path);
    const dockerfilePath = resolve(repositoryRoot, input.ffmpegImage.dockerfilePath);

    expect(existsSync(audioPath)).toBe(true);
    expect(statSync(audioPath).size).toBe(input.audioTrack.byteLength);
    expect(sha256File(audioPath)).toBe(input.audioTrack.sha256);
    expect(sha256File(svgPath)).toBe(input.slideSvg.sha256);
    expect(sha256File(transcriptPath)).toBe(input.transcript.sha256);
    expect(sha256File(replayPath)).toBe(input.replayEvents.sha256);
    expect(sha256File(dockerfilePath)).toBe(input.ffmpegImage.dockerfileSha256);
    expect(input.audioTrack.codec).toBe("flac");
    expect(input.audioTrack.sampleRateHz).toBe(48_000);
    expect(input.audioTrack.channels).toBe(2);
    expect(input.audioTrack.creationEnvironment).toMatch(/macOS 26\.5\.1 \(25F80\).*Samantha.*Daniel.*no separate licensing representation/i);

    const buildDriver = readFileSync(resolve(repositoryRoot, "tools/sample/build-sample.ts"), "utf8");
    expect(buildDriver).not.toContain("/usr/bin/say");
    expect(buildDriver).not.toContain("synthesizeSpeech");
    expect(buildDriver.match(/buildOnce\(options\.image, "gibbs-free-energy\.mp4"\)/gu)).toHaveLength(2);
  });

  it("scopes network requirements precisely and never presents the replay as a live provider", () => {
    expect(referenceProject.provenance).toMatchObject({
      playbackNetworkRequired: false,
      replayNetworkRequired: false,
      cleanBuildNetworkRequired: true,
      verifyRequiresCachedPinnedImage: true,
      providerAccountRequired: false,
    });
    expect(referenceProject.provenance).not.toHaveProperty("networkRequired");
    expect(referenceProject.expected.provider).toEqual({ kind: "deterministic-replay", live: false });
    expect(referenceProject.expected.fixtureContentSha256).toBe(replayEvents.fixtureContentSha256);
  });

  it("contains exactly one deliberate Education Profile duration violation", () => {
    const overlong = replayEvents.captions.filter((cue) => cue.endMs - cue.startMs > 7_000);
    expect(overlong).toHaveLength(1);
    expect(overlong[0]?.cueId).toBe("gibbs-cue-07");
    expect(referenceProject.expected.captionCount).toBe(replayEvents.captions.length);
  });
});
