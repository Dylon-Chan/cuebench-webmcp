import { describe, expect, it } from "vitest";
import type { LocalCaptionEvidencePackage } from "@cuebench/contracts";
import {
  applyCommand,
  createCertificationSnapshot,
  createProject,
  currentProjectItems,
  findingIdFor,
  prepareCertificationReview,
  sha256Hex,
  validateProject,
  verifyCertificationSnapshot,
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

const generatedEvidenceProject = (): CaptionProject => {
  const project = createProject({
    projectId: "generated-evidence-project",
    title: "Generated evidence lesson",
    media: {
      sourceId: "generated-evidence-media",
      sha256: "9".repeat(64),
      durationMs: 60_000,
      relinkState: "Linked",
    },
    captions: [{
      kind: "CaptionCue",
      itemId: "c01",
      state: "Proposed",
      startMs: 1_000,
      endMs: 3_000,
      text: "Grounded caption.",
      speaker: "Teacher",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cause: "generated",
    }],
    evidence: [{
      evidenceId: "generated-c01-evidence",
      projectId: "generated-evidence-project",
      mediaSha256: "9".repeat(64),
      itemId: "c01",
      itemRevision: 1,
    }],
  });
  const localEvidence: LocalCaptionEvidencePackage = {
    packageId: "generation-caption-source",
    runId: "caption-source",
    projectId: project.projectId,
    mediaSha256: project.media.sha256,
    expectedProjectRevision: project.projectRevision,
    expectedQualityProfileRevision: project.qualityProfile.revision,
    retainedAtMs: 1_700_000_000_000,
    evidence: {
      contractVersion: 1,
      runId: "caption-source",
      projectId: project.projectId,
      mediaSha256: project.media.sha256,
      preparedManifest: { key: "prepared/source/manifest.json", sha256: "a".repeat(64) },
      normalizedAudio: { key: "prepared/source/audio.wav", sha256: "b".repeat(64), byteLength: 4, durationMs: 60_000, contentType: "audio/wav" },
      words: [{ evidenceId: "generated-c01-evidence", sourceWordIndex: 0, startMs: 1_000, endMs: 3_000, text: "caption", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
      speakerSegments: [{ id: "speaker-1", startMs: 1_000, endMs: 3_000, speaker: "Teacher", text: "caption" }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "c".repeat(64), responseHash: "d".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "e".repeat(64), responseHash: "f".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 1, evidenceIds: ["generated-c01-evidence"] }],
  };
  return { ...project, localEvidencePackages: [localEvidence] };
};

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

  it("keeps state-transition evidence immutable and requires explicit verification before certification", () => {
    const generated = generatedEvidenceProject();
    const originalBinding = generated.evidence[0];
    if (originalBinding === undefined) throw new Error("Expected generated evidence binding.");

    const agentReady = applyCommand(generated, {
      type: "MarkItemAgentReady",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
    });
    expect(agentReady.error).toBeUndefined();
    expect(originalBinding.itemRevision).toBe(1);
    expect(agentReady.project.evidence).toEqual([originalBinding]);
    expect(validateProject(agentReady.project).findings.some((finding) => finding.ruleId === "evidence.stale")).toBe(true);

    const sustained = applyCommand(agentReady.project, {
      type: "SustainItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 2,
      expectedProjectRevision: agentReady.project.projectRevision,
    });
    expect(sustained.error).toBeUndefined();
    expect(sustained.project.evidence).toEqual([originalBinding]);
    expect(validateProject(sustained.project).findings.some((finding) => finding.ruleId === "evidence.stale")).toBe(true);

    const verified = applyCommand(sustained.project, {
      type: "VerifyItemEvidence",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 3,
      expectedProjectRevision: sustained.project.projectRevision,
      sourcePackageId: "generation-caption-source",
      verificationPackageId: "state-review-verification",
      verificationEvidenceIds: ["state-review-verification-word-1"],
      verifiedAtMs: 1_700_000_000_000,
    });
    expect(verified.error).toBeUndefined();
    expect(verified.project.evidence[0]).toEqual(originalBinding);
    expect(verified.project.evidence[1]).toMatchObject({ itemId: "c01", itemRevision: 3 });

    const validated = validate(verified.project);
    const readiness = prepareCertificationReview(validated.project);
    expect(readiness.canCertify).toBe(true);
    expect(applyCommand(validated.project, {
      type: "CertifyProject",
      actor: human,
      expectedProjectRevision: validated.project.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "generated-evidence-certification",
      certifiedAtMs: 1_700_000_000_000,
    }).error).toBeUndefined();
  });

  it("keeps each historical binding unchanged through an objection", () => {
    const generated = generatedEvidenceProject();
    const objected = applyCommand(generated, {
      type: "ObjectItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
      reason: "The interpretation needs correction.",
    });
    expect(objected.error).toBeUndefined();
    expect(objected.project.evidence).toEqual(generated.evidence);
    expect(objected.project.localEvidencePackages).toEqual(generated.localEvidencePackages);
    const evidenceFindings = validateProject(objected.project).findings.filter(
      (finding) => finding.ruleId === "evidence.stale",
    );
    expect(evidenceFindings).toHaveLength(1);
    expect(validateProject(objected.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "review.objected-revision", severity: "blocker" }),
    ]));
  });

  it("leaves evidence stale after text or timing revisions", () => {
    const generated = generatedEvidenceProject();
    const textRevised = applyCommand(generated, {
      type: "ReviseCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
      patch: { text: "A semantically revised caption." },
    });
    expect(textRevised.error).toBeUndefined();
    expect(textRevised.project.evidence[0]?.itemRevision).toBe(1);
    expect(validateProject(textRevised.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
    ]));
    const textThenAgentReady = applyCommand(textRevised.project, {
      type: "MarkItemAgentReady",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c01",
      expectedItemRevision: 2,
      expectedProjectRevision: textRevised.project.projectRevision,
    });
    expect(textThenAgentReady.error).toBeUndefined();
    expect(textThenAgentReady.project.evidence[0]?.itemRevision).toBe(1);
    expect(validateProject(textThenAgentReady.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
    ]));

    const timingRevised = applyCommand(generated, {
      type: "AdjustCueTiming",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
      startDeltaMs: 100,
      endDeltaMs: 100,
    });
    expect(timingRevised.error).toBeUndefined();
    expect(timingRevised.project.evidence[0]?.itemRevision).toBe(1);
    expect(validateProject(timingRevised.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
    ]));
  });

  it("keeps semantic evidence stale through a Human ruling until an explicit retained-evidence verification appends new history", () => {
    const generated = generatedEvidenceProject();
    const revised = applyCommand(generated, {
      type: "ReviseCue",
      actor: human,
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
      patch: { text: "Corrected caption." },
    });
    expect(revised.error).toBeUndefined();
    expect(validateProject(revised.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
    ]));

    const sustained = applyCommand(revised.project, {
      type: "SustainItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 2,
      expectedProjectRevision: revised.project.projectRevision,
    });
    expect(sustained.error).toBeUndefined();
    expect(sustained.project.evidence).toEqual(generated.evidence);
    expect(sustained.project.localEvidencePackages).toEqual(generated.localEvidencePackages);
    expect(validateProject(sustained.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "evidence.stale", severity: "blocker" }),
    ]));

    const verified = applyCommand(sustained.project, {
      type: "VerifyItemEvidence",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 3,
      expectedProjectRevision: sustained.project.projectRevision,
      sourcePackageId: "generation-caption-source",
      verificationPackageId: "verification-c01-r3",
      verificationEvidenceIds: ["verification-c01-r3-word-1"],
      verifiedAtMs: 1_700_000_001_000,
    });
    expect(verified.error).toBeUndefined();
    expect(verified.project.evidence).toEqual([
      generated.evidence[0],
      {
        evidenceId: "verification-c01-r3-word-1",
        projectId: generated.projectId,
        mediaSha256: generated.media.sha256,
        itemId: "c01",
        itemRevision: 3,
      },
    ]);
    expect(verified.project.localEvidencePackages[0]).toEqual(generated.localEvidencePackages[0]);
    expect(verified.project.localEvidencePackages[1]).toMatchObject({
      packageId: "verification-c01-r3",
      runId: "caption-source",
      expectedProjectRevision: sustained.project.projectRevision,
      retainedAtMs: 1_700_000_001_000,
      cueBindings: [{
        cueId: "c01",
        itemId: "c01",
        itemRevision: 3,
        evidenceIds: ["verification-c01-r3-word-1"],
      }],
      evidence: { words: [{ evidenceId: "verification-c01-r3-word-1" }] },
    });
    expect(validateProject(verified.project).findings.some((finding) => finding.ruleId === "evidence.stale")).toBe(false);

    const validated = validate(verified.project);
    const readiness = prepareCertificationReview(validated.project);
    expect(readiness.canCertify).toBe(true);
    const certified = applyCommand(validated.project, {
      type: "CertifyProject",
      actor: human,
      expectedProjectRevision: validated.project.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "verified-evidence-certification",
      certifiedAtMs: 1_700_000_002_000,
    });
    expect(certified.error).toBeUndefined();
    expect(certified.project.certifications[0]?.evidence).toEqual(verified.project.evidence);
    expect(certified.project.certifications[0]).toBeDefined();
    expect(verifyCertificationSnapshot(certified.project.certifications[0]!)).toBe(true);
  });

  it("rejects unsafe verification package and evidence identifiers before creating Court Record history", () => {
    const generated = generatedEvidenceProject();
    const sustained = applyCommand(generated, {
      type: "SustainItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: generated.projectRevision,
    });
    if (sustained.error !== undefined) throw new Error(sustained.error.message);
    for (const identity of [
      { verificationPackageId: "verification package", verificationEvidenceIds: ["safe-evidence"] },
      { verificationPackageId: "safe-package", verificationEvidenceIds: ["evidence with spaces"] },
    ]) {
      const rejected = applyCommand(sustained.project, {
        type: "VerifyItemEvidence",
        actor: human,
        itemId: "c01",
        expectedItemRevision: 2,
        expectedProjectRevision: sustained.project.projectRevision,
        sourcePackageId: "generation-caption-source",
        ...identity,
        verifiedAtMs: 1_700_000_001_000,
      });
      expect(rejected.error?.code).toBe("INVALID_ARGUMENT");
      expect(rejected.project).toBe(sustained.project);
      expect(rejected.project.courtRecord).toHaveLength(sustained.project.courtRecord.length);
    }
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
    expect(first.certificationSnapshotHash).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
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
