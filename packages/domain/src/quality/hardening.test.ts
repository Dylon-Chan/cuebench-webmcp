import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createCertificationSnapshot,
  createProject,
  currentProjectItems,
  findingIdFor,
  prepareCertificationReview,
  sha256Hex,
  validateProject,
  type CaptionCue,
  type CaptionProject,
  type DomainCommand,
  type QualityFindingTarget,
} from "../index";
import { fixtureProject } from "../../test/fixtures";

const human = { type: "Human" as const, id: "teacher" };
const system = { type: "System" as const, id: "validator" };

const sustainedProject = (): CaptionProject => createProject({
  projectId: "hardening-project",
  title: "Hardening lesson",
  media: {
    sourceId: "hardening-media",
    sha256: "e".repeat(64),
    durationMs: 60_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "c01",
    state: "Sustained",
    startMs: 1_000,
    endMs: 3_000,
    text: "A human-reviewed caption.",
    speaker: "Teacher",
    actor: human,
    cause: "fixture",
  }],
});

const validate = (project: CaptionProject) => applyCommand(project, {
  type: "ValidateProject",
  actor: system,
  expectedProjectRevision: project.projectRevision,
});

const addMapOnlyCaption = (project: CaptionProject): CaptionProject => {
  const source = project.captions.items.c01;
  if (source === undefined) throw new Error("Fixture cue c01 is missing.");
  const current = {
    ...source.current,
    itemId: "c02",
    itemRevision: 1,
    state: "Proposed" as const,
    startMs: 4_000,
    endMs: 6_000,
    text: "A map-only proposed caption.",
    actor: { type: "BrowserAgent" as const, id: "browser-agent" },
    parentItemRevision: null,
  };
  const extra: CaptionCue = {
    itemId: "c02",
    kind: "CaptionCue",
    revisions: [current],
    current,
    mergedIntoItemId: null,
  };
  return {
    ...project,
    captions: {
      ...project.captions,
      items: { ...project.captions.items, c02: extra },
    },
  };
};

describe("quality hardening regressions", () => {
  it("uses a standards-compliant SHA-256 implementation for certification hashing", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("validates live item maps independently from order and blocks incomplete track projection", () => {
    const mapOnly = addMapOnlyCaption(sustainedProject());
    const run = validateProject(mapOnly);

    expect(run.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "caption.ordering", severity: "blocker" }),
      expect.objectContaining({ ruleId: "review.unreviewed-revision", target: expect.objectContaining({ itemId: "c02" }) }),
    ]));

    const validated = validate(mapOnly);
    const readiness = prepareCertificationReview(validated.project);
    expect(readiness.itemStateCounts).toMatchObject({ Sustained: 1, Proposed: 1 });
    expect(currentProjectItems(validated.project).map((item) => item.itemId)).toEqual(["c01", "c02"]);
    expect(applyCommand(validated.project, {
      type: "CertifyProject",
      actor: human,
      expectedProjectRevision: validated.project.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "map-order-certification",
      certifiedAtMs: 1_700_000_000_000,
    }).error?.code).toBe("VALIDATION_BLOCKER");
  });

  it("reports duplicate, unresolved, and omitted track order entries", () => {
    const mapOnly = addMapOnlyCaption(sustainedProject());
    const malformed: CaptionProject = {
      ...mapOnly,
      captions: { ...mapOnly.captions, order: ["c01", "c01", "missing"] },
    };
    const ruleIds = new Set(validateProject(malformed).findings.map((finding) => finding.ruleId));
    expect(ruleIds).toContain("caption.order-duplicate");
    expect(ruleIds).toContain("caption.order-missing-item");
    expect(ruleIds).toContain("caption.order-omitted-item");
  });

  it("clones valid evidence provenance and identifies obsolete media, project, and item bindings", () => {
    const evidence = [
      {
        evidenceId: "e-project",
        projectId: "evidence-project",
        mediaSha256: "f".repeat(64),
        itemId: null,
        itemRevision: null,
      },
      {
        evidenceId: "e-cue",
        projectId: "evidence-project",
        mediaSha256: "f".repeat(64),
        itemId: "c01",
        itemRevision: 1,
      },
    ];
    const project = createProject({
      projectId: "evidence-project",
      title: "Evidence lesson",
      media: {
        sourceId: "evidence-media",
        sha256: "f".repeat(64),
        durationMs: 60_000,
        relinkState: "Linked",
      },
      captions: [{
        kind: "CaptionCue",
        itemId: "c01",
        state: "Sustained",
        startMs: 1_000,
        endMs: 3_000,
        text: "Evidence-linked caption.",
        speaker: null,
        actor: human,
        cause: "fixture",
      }],
      evidence,
    });
    evidence[0]!.mediaSha256 = "0".repeat(64);
    expect(project.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: "e-project", mediaSha256: "f".repeat(64) }),
    ]));
    expect(validateProject(project).findings.some((finding) => finding.ruleId === "evidence.stale")).toBe(false);

    const validated = validate(project);
    const readiness = prepareCertificationReview(validated.project);
    const certified = applyCommand(validated.project, {
      type: "CertifyProject",
      actor: human,
      expectedProjectRevision: validated.project.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "evidence-certification",
      certifiedAtMs: 1_700_000_000_000,
    });
    expect(certified.error).toBeUndefined();
    const snapshot = certified.project.certifications[0];
    if (snapshot === undefined) throw new Error("Expected evidence certification snapshot.");
    expect(snapshot.evidence).toEqual([...project.evidence].sort(
      (left, right) => left.evidenceId.localeCompare(right.evidenceId),
    ));
    const frozenSnapshot = JSON.stringify(snapshot);
    const relinked = applyCommand(certified.project, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: certified.project.projectRevision,
      media: { sourceId: "replacement-media", sha256: "0".repeat(64), durationMs: 60_000 },
    });
    expect(relinked.project.certification.status).toBe("Stale");
    expect(JSON.stringify(relinked.project.certifications[0])).toBe(frozenSnapshot);

    const staleMedia: CaptionProject = {
      ...project,
      evidence: [{ ...project.evidence[0]!, mediaSha256: "0".repeat(64) }, project.evidence[1]!],
    };
    const staleProject: CaptionProject = {
      ...project,
      evidence: [{ ...project.evidence[0]!, projectId: "other-project" }, project.evidence[1]!],
    };
    const staleItem: CaptionProject = {
      ...project,
      evidence: [project.evidence[0]!, { ...project.evidence[1]!, itemRevision: 2 }],
    };
    for (const candidate of [staleMedia, staleProject, staleItem]) {
      expect(validateProject(candidate).findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
      ]));
    }

    expect(() => createProject({
      projectId: "invalid-evidence-project",
      title: "Invalid evidence",
      media: { sourceId: "media", sha256: "1".repeat(64), durationMs: 1_000, relinkState: "Linked" },
      evidence: [{
        evidenceId: "bad",
        projectId: "other-project",
        mediaSha256: "1".repeat(64),
        itemId: null,
        itemRevision: null,
      }],
    })).toThrow();
  });

  it("requires a current validation warning before a Human can waive it", () => {
    const noRun = fixtureProject();
    const noRunBefore = JSON.stringify(noRun);
    const absent = applyCommand(noRun, {
      type: "WaiveWarning",
      actor: human,
      findingId: "predicted-warning",
      reason: "Intentional.",
      expectedProjectRevision: noRun.projectRevision,
    });
    expect(absent.error?.code).toBe("CERTIFICATION_OUT_OF_DATE");
    expect(JSON.stringify(absent.project)).toBe(noRunBefore);

    const validated = validate(fixtureProject());
    const arbitraryBefore = JSON.stringify(validated.project);
    const arbitrary = applyCommand(validated.project, {
      type: "WaiveWarning",
      actor: human,
      findingId: "arbitrary-warning-id",
      reason: "Intentional.",
      expectedProjectRevision: validated.project.projectRevision,
    });
    expect(arbitrary.error?.code).toBe("NOT_FOUND");
    expect(JSON.stringify(arbitrary.project)).toBe(arbitraryBefore);

    const warning = validated.project.validationRun?.warnings[0];
    if (warning === undefined) throw new Error("Expected a validation warning.");
    const stale = applyCommand(validated.project, {
      type: "ApplyProfile",
      actor: human,
      profileId: "new-profile",
      name: "New profile",
      rules: {},
      expectedProjectRevision: validated.project.projectRevision,
    }).project;
    const staleBefore = JSON.stringify(stale);
    const staleWaiver = applyCommand(stale, {
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: "Predicted before a fresh run.",
      expectedProjectRevision: stale.projectRevision,
    });
    expect(staleWaiver.error?.code).toBe("CERTIFICATION_OUT_OF_DATE");
    expect(JSON.stringify(staleWaiver.project)).toBe(staleBefore);
  });

  it("uses separate deterministic readiness and SHA-256 certification snapshot hashes", () => {
    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    const actor = { type: "Human" as const, id: "teacher" };
    const first = createCertificationSnapshot(validated.project, readiness, {
      certificationId: "hash-certification",
      certifiedAtMs: 1_700_000_000_000,
      actor,
    });
    actor.id = "changed-after-snapshot";
    const changedActor = createCertificationSnapshot(validated.project, readiness, {
      certificationId: "hash-certification",
      certifiedAtMs: 1_700_000_000_000,
      actor,
    });
    const changedTime = createCertificationSnapshot(validated.project, readiness, {
      certificationId: "hash-certification",
      certifiedAtMs: 1_700_000_000_001,
      actor: human,
    });

    expect(first.readinessHash).toBe(readiness.readinessHash);
    expect(first.certificationSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.actor).toEqual({ type: "Human", id: "teacher" });
    expect(changedActor.certificationSnapshotHash).not.toBe(first.certificationSnapshotHash);
    expect(changedTime.certificationSnapshotHash).not.toBe(first.certificationSnapshotHash);

    const missingTimestamp = applyCommand(validated.project, {
      type: "CertifyProject",
      actor: human,
      expectedProjectRevision: validated.project.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "missing-time",
    } as unknown as DomainCommand);
    expect(missingTimestamp.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("uses collision-safe finding ids and honors explicit caption and AD overlap policies", () => {
    const project = fixtureProject({ overlappingCues: true });
    const defaultCaption = validateProject(project);
    expect(defaultCaption.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "caption.no-overlap", severity: "blocker" }),
    ]));
    const allowedCaption = validateProject({
      ...project,
      qualityProfile: { ...project.qualityProfile, rules: { caption: { overlapPolicy: "allow" } } },
    });
    expect(allowedCaption.findings.some((finding) => finding.ruleId === "caption.no-overlap")).toBe(false);

    const ad01 = project.audioDescriptions.items.ad01;
    if (ad01 === undefined) throw new Error("Fixture AD beat is missing.");
    const ad02 = {
      ...ad01,
      itemId: "ad02",
      revisions: [{ ...ad01.current, itemId: "ad02", itemRevision: 1, startMs: 7_000, endMs: 9_000, parentItemRevision: null }],
      current: { ...ad01.current, itemId: "ad02", itemRevision: 1, startMs: 7_000, endMs: 9_000, parentItemRevision: null },
    };
    const overlappingAd: CaptionProject = {
      ...project,
      audioDescriptions: {
        ...project.audioDescriptions,
        order: ["ad01", "ad02"],
        items: { ...project.audioDescriptions.items, ad02 },
      },
    };
    expect(validateProject(overlappingAd).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "audio-description.no-overlap", severity: "blocker" }),
    ]));
    expect(validateProject({
      ...overlappingAd,
      qualityProfile: { ...overlappingAd.qualityProfile, rules: { audioDescription: { overlapPolicy: "allow" } } },
    }).findings.some((finding) => finding.ruleId === "audio-description.no-overlap")).toBe(false);

    const pairA: QualityFindingTarget = {
      type: "pair",
      first: { kind: "CaptionCue", itemId: "a|AudioDescriptionBeat:b", itemRevision: 1 },
      second: { kind: "CaptionCue", itemId: "c", itemRevision: 2 },
    };
    const pairB: QualityFindingTarget = {
      type: "pair",
      first: { kind: "CaptionCue", itemId: "a", itemRevision: 1 },
      second: { kind: "AudioDescriptionBeat", itemId: "b|CaptionCue:c", itemRevision: 2 },
    };
    expect(findingIdFor("caption.no-overlap", project.qualityProfile, pairA)).not.toBe(
      findingIdFor("caption.no-overlap", project.qualityProfile, pairB),
    );
    expect(findingIdFor("caption.ordering", project.qualityProfile, {
      type: "project",
      projectId: project.projectId,
      projectRevision: 1,
    })).not.toBe(findingIdFor("caption.ordering", project.qualityProfile, {
      type: "project",
      projectId: project.projectId,
      projectRevision: 2,
    }));
  });
});
