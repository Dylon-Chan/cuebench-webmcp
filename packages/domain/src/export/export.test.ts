import { describe, expect, it } from "vitest";
import {
  applyCommand,
  buildTrackFilename,
  createProject,
  formatSrtTimestamp,
  formatVttTimestamp,
  parseTrack,
  prepareCertificationReview,
  prepareTrackExport,
  serializeTrack,
  TrackParseError,
  TrackSerializationError,
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

  it("emits a standards-conforming VTT header and obtains AD identity from caller context", () => {
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
    expect(vtt).toMatch(/^WEBVTT\n\n/);
    expect(vtt).toMatch(/\n$/);
    expect(vtt).not.toContain("X-CUEBENCH-TRACK");
    expect(adVtt).toMatch(/^WEBVTT\n\n/);
    expect(adVtt).not.toContain("X-CUEBENCH-TRACK");
    expect(adText).toContain("CUEBENCH-AD-TEXT\nX-CUEBENCH-TRACK: AudioDescriptions");
    expect(verifyRoundTrip(captions, parseTrack(vtt, "vtt"))).toEqual({ ok: true });
    expect(verifyRoundTrip(descriptions, parseTrack(adVtt, "vtt", { trackKind: "AudioDescriptions" }))).toEqual({ ok: true });
    expect(verifyRoundTrip(descriptions, parseTrack(adText, "ad-text"))).toEqual({ ok: true });
  });

  it("rejects a VTT header that omits the mandatory blank separator", () => {
    expect(() => parseTrack([
      "WEBVTT",
      "X-CUEBENCH-TRACK: Captions",
      "",
      "cue-1",
      "00:00:01.000 --> 00:00:02.000",
      "A caption.",
    ].join("\n"), "vtt")).toThrow(TrackParseError);
  });

  it("round-trips interior backslashes and multiline text, but rejects unrepresentable blank payload lines", () => {
    const project = fixtureProject();
    const cue = project.captions.items.c05;
    if (cue === undefined) throw new Error("fixture item missing");
    const captions = {
      ...project.captions,
      items: {
        ...project.captions.items,
        c05: {
          ...cue,
          current: { ...cue.current, text: "C:\\work\\cue\\N\nsecond \\ line" },
        },
      },
    };

    for (const format of ["vtt", "srt"] as const) {
      const text = serializeTrack(captions, format);
      expect(verifyRoundTrip(captions, parseTrack(text, format))).toEqual({ ok: true });
    }
    const blankLineCaptions = {
      ...captions,
      items: {
        ...captions.items,
        c05: { ...captions.items.c05!, current: { ...captions.items.c05!.current, text: "first\n\nthird" } },
      },
    };
    expect(() => serializeTrack(blankLineCaptions, "vtt")).toThrow(TrackSerializationError);
    expect(() => serializeTrack(blankLineCaptions, "srt")).toThrow(TrackSerializationError);
  });

  it("reports unsupported metadata instead of silently dropping it", () => {
    expect(() => parseTrack([
      "WEBVTT",
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

  it("exports the immutable current certification snapshot rather than a changed draft", () => {
    const human = { type: "Human" as const, id: "teacher" };
    let project = createProject({
      projectId: "certified-export",
      title: "Certified export",
      media: { sourceId: "source", sha256: "c".repeat(64), durationMs: 60_000, relinkState: "Linked" },
      captions: [{
        kind: "CaptionCue",
        itemId: "c01",
        state: "Sustained",
        startMs: 1_000,
        endMs: 3_000,
        text: "This sustained caption contains sufficient reviewable text for certification.",
        speaker: "Dr. Nguyen",
        actor: human,
        cause: "fixture",
      }],
      evidence: [{
        evidenceId: "e01",
        projectId: "certified-export",
        mediaSha256: "c".repeat(64),
        itemId: "c01",
        itemRevision: 1,
      }],
    });
    project = applyCommand(project, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: project.projectRevision,
    }).project;
    for (const warning of project.validationRun?.warnings ?? []) {
      project = applyCommand(project, {
        type: "WaiveWarning",
        actor: human,
        findingId: warning.findingId,
        reason: "Reviewed warning.",
        expectedProjectRevision: project.projectRevision,
      }).project;
    }
    project = applyCommand(project, {
      type: "CertifyProject",
      actor: human,
      certificationId: "cert-1",
      certifiedAtMs: 1_700_000_000_000,
      expectedReadinessHash: prepareCertificationReview(project).readinessHash,
      expectedProjectRevision: project.projectRevision,
    }).project;
    const cue = project.captions.items.c01;
    if (cue === undefined) throw new Error("fixture cue missing");
    const changedDraft = {
      ...project,
      captions: {
        ...project.captions,
        items: { ...project.captions.items, c01: { ...cue, current: { ...cue.current, text: "Changed only in draft." } } },
      },
    };

    const certified = prepareTrackExport({
      project: changedDraft,
      trackKind: "Captions",
      format: "vtt",
      disposition: "certified",
    });
    const draft = prepareTrackExport({
      project: changedDraft,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });

    expect(certified.filename).toBe("certified-export.certified.vtt");
    expect(certified.text).toContain("This sustained caption contains sufficient reviewable text for certification.");
    expect(certified.text).not.toContain("Changed only in draft.");
    expect(draft.text).toContain("Changed only in draft.");
    expect(certified.serializedTextHash).toMatch(/^sha256:/);
    expect(certified.roundTrip).toEqual({ ok: true });
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
