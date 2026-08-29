import { describe, expect, it } from "vitest";
import {
  buildTrackFilename,
  formatSrtTimestamp,
  formatVttTimestamp,
  parseTrack,
  serializeTrack,
  UnsupportedTrackMetadataError,
  verifyRoundTrip,
} from "../index";
import { fixtureProject } from "../../test/fixtures";

describe("track exports", () => {
  it.each(["vtt", "srt"] as const)("round-trips %s timing and text", (format) => {
    const source = fixtureProject().captions;
    const text = serializeTrack(source, format);

    expect(verifyRoundTrip(source, parseTrack(text, format))).toEqual({ ok: true });
  });

  it("uses canonical integer-millisecond timestamp carry and each format's separator", () => {
    expect(formatVttTimestamp(3_600_001)).toBe("01:00:00.001");
    expect(formatVttTimestamp(3_599_999)).toBe("00:59:59.999");
    expect(formatSrtTimestamp(3_600_001)).toBe("01:00:00,001");

    const vtt = serializeTrack(fixtureProject().captions, "vtt");
    expect(() => parseTrack(vtt.replace("00:00:01.000", "00:00:01,000"), "vtt")).toThrow();
  });

  it("preserves VTT speakers, multiline escaped text, and AD track identity", () => {
    const project = fixtureProject();
    const cue = project.captions.items.c05;
    const ad = project.audioDescriptions.items.ad01;
    if (cue === undefined || ad === undefined) throw new Error("fixture item missing");
    const captions = {
      ...project.captions,
      items: {
        ...project.captions.items,
        c05: {
          ...cue,
          current: { ...cue.current, text: "<open> & close\nsecond line", speaker: "Dr. <Nguyen>" },
        },
      },
    };
    const descriptions = {
      ...project.audioDescriptions,
      items: {
        ...project.audioDescriptions.items,
        ad01: { ...ad, current: { ...ad.current, description: "Diagram <A>\n& annotation" } },
      },
    };

    const vtt = serializeTrack(captions, "vtt");
    const adVtt = serializeTrack(descriptions, "vtt");
    const adText = serializeTrack(descriptions, "ad-text");
    expect(vtt).toContain("&lt;open&gt; &amp; close\nsecond line");
    expect(vtt).toContain("<v Dr. &lt;Nguyen&gt;>");
    expect(adVtt).toContain("X-CUEBENCH-TRACK: AudioDescriptions");
    expect(adText).toContain("CUEBENCH-AD-TEXT\nX-CUEBENCH-TRACK: AudioDescriptions");
    expect(verifyRoundTrip(captions, parseTrack(vtt, "vtt"))).toEqual({ ok: true });
    expect(verifyRoundTrip(descriptions, parseTrack(adVtt, "vtt"))).toEqual({ ok: true });
    expect(verifyRoundTrip(descriptions, parseTrack(adText, "ad-text"))).toEqual({ ok: true });
  });

  it("reports unsupported metadata instead of silently dropping it", () => {
    expect(() => parseTrack([
      "WEBVTT",
      "X-CUEBENCH-TRACK: Captions",
      "",
      "cue-1",
      "00:00:01.000 --> 00:00:02.000 line:10%",
      "A caption.",
    ].join("\n"), "vtt")).toThrow(UnsupportedTrackMetadataError);

    const source = fixtureProject().captions;
    const srtResult = verifyRoundTrip(source, parseTrack(serializeTrack(source, "srt"), "srt"));
    expect(srtResult).toEqual({ ok: true });
  });

  it("labels draft and certified filenames explicitly", () => {
    expect(buildTrackFilename("Gibbs free energy", "vtt", "draft")).toBe("gibbs-free-energy.draft.vtt");
    expect(buildTrackFilename("Gibbs free energy", "srt", "certified")).toBe("gibbs-free-energy.certified.srt");
  });

  it("returns the first normalized round-trip difference", () => {
    const source = fixtureProject().captions;
    const parsed = parseTrack(serializeTrack(source, "vtt"), "vtt");
    const changed = {
      ...parsed,
      items: parsed.items.map((item, index) => index === 0 ? { ...item, text: "Changed." } : item),
    };

    expect(verifyRoundTrip(source, changed)).toMatchObject({
      ok: false,
      error: { code: "EXPORT_ROUND_TRIP_MISMATCH" },
      firstDifference: { index: 0, field: "text" },
    });
  });
});
