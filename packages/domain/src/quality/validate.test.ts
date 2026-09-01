import { describe, expect, it } from "vitest";
import {
  EDUCATION_PROFILE,
  validateProject,
  type CaptionProject,
} from "../index";
import { fixtureProject } from "../../test/fixtures";

const withCurrentCue = (
  project: CaptionProject,
  cueId: "c05" | "c06",
  patch: Partial<CaptionProject["captions"]["items"]["c05"]["current"]>,
): CaptionProject => {
  const cue = project.captions.items[cueId];
  if (cue === undefined) throw new Error(`Fixture cue ${cueId} is missing.`);
  return {
    ...project,
    captions: {
      ...project.captions,
      items: {
        ...project.captions.items,
        [cueId]: { ...cue, current: { ...cue.current, ...patch } },
      },
    },
  };
};

describe("deterministic quality validation", () => {
  it("reports blockers and warnable findings separately", () => {
    const run = validateProject(fixtureProject({ overlappingCues: true, readingSpeed: 24 }));

    expect(run.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "caption.no-overlap", severity: "blocker" }),
      expect.objectContaining({ ruleId: "caption.reading-speed", severity: "warning" }),
    ]));
    expect(run.blockerCount).toBeGreaterThan(0);
    expect(run.warningCount).toBeGreaterThan(0);
  });

  it("uses stable finding ids derived from the rule, target revision, and profile revision", () => {
    const project = fixtureProject();
    const first = validateProject(project);
    const second = validateProject(structuredClone(project));
    expect(second.findings.map((finding) => finding.findingId)).toEqual(
      first.findings.map((finding) => finding.findingId),
    );

    const changedProfile: CaptionProject = {
      ...project,
      qualityProfile: { ...EDUCATION_PROFILE, revision: EDUCATION_PROFILE.revision + 1 },
    };
    const changed = validateProject(changedProfile);
    expect(changed.findings.map((finding) => finding.findingId)).not.toEqual(
      first.findings.map((finding) => finding.findingId),
    );
  });

  it("validates bounds, empty items, duplicates, dialogue collisions, stale evidence, and review state", () => {
    const project = fixtureProject();
    const c05 = project.captions.items.c05;
    const c06 = project.captions.items.c06;
    const ad01 = project.audioDescriptions.items.ad01;
    if (c05 === undefined || c06 === undefined || ad01 === undefined) throw new Error("Fixture items are missing.");
    const duplicate = withCurrentCue(project, "c06", { text: c05.current.text });
    const malformed: CaptionProject = {
      ...project,
      media: { ...project.media, relinkState: "Missing" },
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c05: { ...c05, current: { ...c05.current, endMs: 0, text: "" } },
          c06: { ...c06, current: { ...c06.current, text: c05.current.text } },
        },
      },
      audioDescriptions: {
        ...project.audioDescriptions,
        items: {
          ...project.audioDescriptions.items,
          ad01: { ...ad01, current: { ...ad01.current, startMs: 2_000, endMs: 4_000 } },
        },
      },
    };

    const ruleIds = new Set(validateProject(malformed).findings.map((finding) => finding.ruleId));
    for (const ruleId of [
      "caption.timing-bounds",
      "caption.empty",
      "audio-description.dialogue-collision",
      "evidence.stale",
      "review.unreviewed-revision",
    ]) expect(ruleIds).toContain(ruleId);
    expect(validateProject(duplicate).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "caption.duplicate", severity: "warning" }),
    ]));
  });

  it("applies configured duration, line, gap, speaker-transition, and ordering rules", () => {
    const project = fixtureProject();
    const c05 = project.captions.items.c05;
    const c06 = project.captions.items.c06;
    if (c05 === undefined || c06 === undefined) throw new Error("Fixture cues are missing.");
    const configured: CaptionProject = {
      ...project,
      qualityProfile: {
        ...project.qualityProfile,
        rules: {
          caption: {
            maxGapMs: 1_000,
            minSpeakerTransitionGapMs: 3_000,
          },
        },
      },
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c05: {
            ...c05,
            current: {
              ...c05.current,
              endMs: 1_400,
              text: `${"A deliberately overlong caption line ".repeat(2)}\nsecond\nthird`,
            },
          },
          c06: {
            ...c06,
            current: {
              ...c06.current,
              startMs: 4_000,
              speaker: "Prof. Rao",
            },
          },
        },
      },
    };

    const ruleIds = new Set(validateProject(configured).findings.map((finding) => finding.ruleId));
    for (const ruleId of [
      "caption.duration",
      "caption.line-length",
      "caption.line-count",
      "caption.gap",
      "caption.speaker-transition",
    ]) expect(ruleIds).toContain(ruleId);

    const unordered: CaptionProject = {
      ...configured,
      captions: { ...configured.captions, order: ["c06", "c05"] },
    };
    expect(validateProject(unordered).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "caption.ordering", severity: "blocker" }),
    ]));
  });
});
