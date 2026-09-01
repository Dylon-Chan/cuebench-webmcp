import { describe, expect, it } from "vitest";
import {
  applyCommand,
  canonicalHash,
  certificationSnapshotHashFor,
  createProject,
  detectCertificationSnapshotHashVersion,
  intermediateCertificationSnapshotHashFor,
  legacyCertificationSnapshotHashFor,
  prepareCertificationReview,
  upgradeLegacyCertificationSnapshot,
  verifyIntermediateCertificationSnapshot,
  verifyCertificationSnapshot,
  type CaptionProject,
  type DomainCommand,
} from "../index";
import { fixtureProject } from "../../test/fixtures";

const system = { type: "System" as const, id: "validator" };
const human = { type: "Human" as const, id: "teacher" };

const sustainedProject = (): CaptionProject => createProject({
  projectId: "certification-project",
  title: "Certified lesson",
  media: {
    sourceId: "media-certified",
    sha256: "c".repeat(64),
    durationMs: 60_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "c01",
    state: "Sustained",
    startMs: 1_000,
    endMs: 3_000,
    text: "Dr. Nguyen explains Gibbs free energy.",
    speaker: "Dr. Nguyen",
    actor: human,
    cause: "fixture",
  }],
  evidence: [{
    evidenceId: "evidence-1",
    projectId: "certification-project",
    mediaSha256: "c".repeat(64),
    itemId: "c01",
    itemRevision: 1,
  }],
});

const validate = (project: CaptionProject) => applyCommand(project, {
  type: "ValidateProject",
  actor: system,
  expectedProjectRevision: project.projectRevision,
});

const certificationCommand = (
  project: CaptionProject,
  expectedReadinessHash: string,
): Extract<DomainCommand, { readonly type: "CertifyProject" }> => ({
  type: "CertifyProject",
  actor: human,
  expectedProjectRevision: project.projectRevision,
  expectedReadinessHash,
  certificationId: "certification-1",
  certifiedAtMs: 1_700_000_000_000,
});

describe("human certification", () => {
  it("verifies persisted certification hashes, human authority, and immutable item bindings", () => {
    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    const snapshot = applyCommand(
      validated.project,
      certificationCommand(validated.project, readiness.readinessHash),
    ).project.certifications[0];
    if (snapshot === undefined) throw new Error("Expected certification snapshot.");

    expect(verifyCertificationSnapshot(snapshot)).toBe(true);
    expect(snapshot.certificationSnapshotHash).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
    expect(detectCertificationSnapshotHashVersion(snapshot)).toBe(2);
    expect(upgradeLegacyCertificationSnapshot(snapshot)).toEqual(snapshot);
    expect(verifyCertificationSnapshot({
      ...snapshot,
      actor: { type: "BrowserAgent", id: "browser-agent" },
    })).toBe(false);
    expect(verifyCertificationSnapshot({
      ...snapshot,
      certificationSnapshotHash: `sha256:${"0".repeat(64)}`,
    })).toBe(false);
    expect(detectCertificationSnapshotHashVersion({
      ...snapshot,
      certificationSnapshotHash: `sha256:v2:${"0".repeat(64)}`,
    })).toBeNull();
    expect(verifyCertificationSnapshot({
      ...snapshot,
      itemRevisions: [...snapshot.itemRevisions, snapshot.itemRevisions[0]!],
    })).toBe(false);
  });

  it("authenticates current, intermediate, and legacy hashes by recomputation before upgrade", () => {
    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    const snapshot = applyCommand(
      validated.project,
      certificationCommand(validated.project, readiness.readinessHash),
    ).project.certifications[0];
    if (snapshot === undefined) throw new Error("Expected certification snapshot.");
    const legacy = {
      ...snapshot,
      certificationSnapshotHash: legacyCertificationSnapshotHashFor(snapshot),
    };
    const intermediate = {
      ...snapshot,
      certificationSnapshotHash: (() => {
        const historicalContent = { ...snapshot };
        Reflect.deleteProperty(historicalContent, "certificationSnapshotHash");
        return canonicalHash("cuebench.certification-snapshot.v2", historicalContent);
      })(),
    };

    expect(detectCertificationSnapshotHashVersion(legacy)).toBe(1);
    expect(verifyCertificationSnapshot(legacy)).toBe(false);
    const upgraded = upgradeLegacyCertificationSnapshot(legacy);
    expect(upgraded).toBeDefined();
    expect(upgraded?.certificationSnapshotHash).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
    expect(verifyCertificationSnapshot(upgraded!)).toBe(true);
    expect(upgraded).toEqual(snapshot);

    expect(detectCertificationSnapshotHashVersion(intermediate)).toBe("2-unversioned");
    expect(intermediateCertificationSnapshotHashFor(snapshot)).toBe(intermediate.certificationSnapshotHash);
    expect(verifyIntermediateCertificationSnapshot(intermediate)).toBe(true);
    expect(verifyCertificationSnapshot(intermediate)).toBe(false);
    expect(upgradeLegacyCertificationSnapshot(intermediate)).toEqual(snapshot);

    const evidence = legacy.evidence[0];
    if (evidence === undefined) throw new Error("Expected legacy evidence.");
    expect(upgradeLegacyCertificationSnapshot({
      ...legacy,
      evidence: [{ ...evidence, mediaSha256: "d".repeat(64) }],
    })).toBeUndefined();
    const intermediateTampered = {
      ...intermediate,
      evidence: [{ ...evidence, mediaSha256: "d".repeat(64) }],
    };
    expect(detectCertificationSnapshotHashVersion(intermediateTampered)).toBeNull();
    expect(upgradeLegacyCertificationSnapshot(intermediateTampered)).toBeUndefined();
  });

  it("recomputes the complete certified validation input and binds every immutable snapshot field", () => {
    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    const snapshot = applyCommand(
      validated.project,
      certificationCommand(validated.project, readiness.readinessHash),
    ).project.certifications[0];
    if (snapshot === undefined) throw new Error("Expected certification snapshot.");

    const snapshotContent = <Snapshot extends typeof snapshot>(candidate: Snapshot) => ({
      certificationId: candidate.certificationId,
      readinessHash: candidate.readinessHash,
      certifiedAtMs: candidate.certifiedAtMs,
      actor: candidate.actor,
      media: candidate.media,
      evidence: candidate.evidence,
      itemRevisions: candidate.itemRevisions,
      qualityProfile: candidate.qualityProfile,
      validationRun: candidate.validationRun,
      warningWaivers: candidate.warningWaivers,
    });
    const rehash = <Snapshot extends typeof snapshot>(candidate: Snapshot) => {
      const content = snapshotContent(candidate);
      return { ...candidate, certificationSnapshotHash: certificationSnapshotHashFor(content) };
    };
    const firstEvidence = snapshot.evidence[0];
    const firstInputCaption = snapshot.validationRun.input.captions.items[0];
    if (firstEvidence === undefined || firstInputCaption === undefined) throw new Error("Expected certified inputs.");

    const evidenceTampered = rehash({
      ...snapshot,
      evidence: [{ ...firstEvidence, mediaSha256: "d".repeat(64) }],
    });
    const findingTampered = rehash({
      ...snapshot,
      validationRun: {
        ...snapshot.validationRun,
        findings: [{
          id: "forged-finding",
          findingId: "forged-finding",
          ruleId: "forged.rule",
          severity: "warning" as const,
          message: "Forged finding.",
          target: { type: "project" as const, projectId: snapshot.validationRun.projectId, projectRevision: snapshot.validationRun.projectRevision },
        }],
        blockers: [],
        warnings: [{
          id: "forged-finding",
          findingId: "forged-finding",
          ruleId: "forged.rule",
          severity: "warning" as const,
          message: "Forged finding.",
          target: { type: "project" as const, projectId: snapshot.validationRun.projectId, projectRevision: snapshot.validationRun.projectRevision },
        }],
        blockerCount: 0,
        warningCount: 1,
      },
    });
    const waiverTampered = rehash({
      ...snapshot,
      warningWaivers: [{
        findingId: "forged-finding",
        reason: "Forged waiver.",
        actor: human,
        projectRevision: snapshot.validationRun.projectRevision,
      }],
    });
    const omittedItem = rehash({ ...snapshot, itemRevisions: [] });
    const stateTampered = rehash({
      ...snapshot,
      validationRun: {
        ...snapshot.validationRun,
        input: {
          ...snapshot.validationRun.input,
          captions: {
            ...snapshot.validationRun.input.captions,
            items: [{ ...firstInputCaption, state: "Proposed" }],
          },
        },
      },
    });
    const readinessTampered = rehash({ ...snapshot, readinessHash: `sha256:${"0".repeat(64)}` });

    for (const candidate of [
      evidenceTampered,
      findingTampered,
      waiverTampered,
      omittedItem,
      stateTampered,
      readinessTampered,
    ]) expect(verifyCertificationSnapshot(candidate)).toBe(false);

    const actorTampered = { ...snapshot, actor: { type: "Human" as const, id: "another-teacher" } };
    const timeTampered = { ...snapshot, certifiedAtMs: snapshot.certifiedAtMs + 1 };
    expect(certificationSnapshotHashFor(snapshotContent(actorTampered))).not.toBe(snapshot.certificationSnapshotHash);
    expect(certificationSnapshotHashFor(snapshotContent(timeTampered))).not.toBe(snapshot.certificationSnapshotHash);
    expect(verifyCertificationSnapshot(actorTampered)).toBe(false);
    expect(verifyCertificationSnapshot(timeTampered)).toBe(false);
    expect(verifyCertificationSnapshot({ ...snapshot, certificationSnapshotHash: `sha256:${"0".repeat(64)}` })).toBe(false);
  });

  it("does not allow blockers to be waived and requires a Human and reason for warnings", () => {
    const preparedWarning = validate(fixtureProject());
    const warning = preparedWarning.project.validationRun?.findings.find(
      (finding) => finding.severity === "warning",
    );
    if (warning === undefined) throw new Error("Expected a warning.");

    expect(applyCommand(preparedWarning.project, {
      type: "WaiveWarning",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      findingId: warning.findingId,
      reason: "Intentional pacing.",
      expectedProjectRevision: preparedWarning.project.projectRevision,
    }).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");

    expect(applyCommand(preparedWarning.project, {
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: " ",
      expectedProjectRevision: preparedWarning.project.projectRevision,
    }).error?.code).toBe("INVALID_ARGUMENT");

    const overlapping = fixtureProject();
    const c06 = overlapping.captions.items.c06;
    if (c06 === undefined) throw new Error("Fixture cue c06 is missing.");
    const blocked = validate({
      ...overlapping,
      captions: {
        ...overlapping.captions,
        items: { ...overlapping.captions.items, c06: { ...c06, current: { ...c06.current, startMs: 2_500 } } },
      },
    });
    const blocker = blocked.project.validationRun?.findings.find(
      (finding) => finding.severity === "blocker",
    );
    if (blocker === undefined) throw new Error("Expected a blocker.");

    expect(applyCommand(blocked.project, {
      type: "WaiveWarning",
      actor: human,
      findingId: blocker.findingId,
      reason: "Cannot waive this.",
      expectedProjectRevision: blocked.project.projectRevision,
    }).error?.code).toBe("VALIDATION_BLOCKER");
  });

  it("marks validation stale when a human applies a new profile", () => {
    const validated = validate(sustainedProject());
    const result = applyCommand(validated.project, {
      type: "ApplyProfile",
      actor: human,
      profileId: "education-quality",
      name: "Education Quality Profile",
      rules: { caption: { maximumReadingSpeedCps: 18 } },
      expectedProjectRevision: validated.project.projectRevision,
    });

    expect(result.error).toBeUndefined();
    expect(result.project.validation.status).toBe("Stale");
    expect(prepareCertificationReview(result.project).staleValidationCauses).not.toHaveLength(0);
  });

  it("requires one current Sustained item and the exact readiness hash", () => {
    const unreviewed = validate(fixtureProject());
    const unreviewedReadiness = prepareCertificationReview(unreviewed.project);
    expect(unreviewedReadiness.itemStateCounts.Sustained).toBe(0);
    expect(applyCommand(
      unreviewed.project,
      certificationCommand(unreviewed.project, unreviewedReadiness.readinessHash),
    ).error?.code).toBe("CERTIFICATION_OUT_OF_DATE");

    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    expect(readiness.canCertify).toBe(true);
    expect(applyCommand(
      validated.project,
      certificationCommand(validated.project, "different-readiness-hash"),
    ).error?.code).toBe("CERTIFICATION_OUT_OF_DATE");

    expect(applyCommand(validated.project, {
      ...certificationCommand(validated.project, readiness.readinessHash),
      actor: { type: "BrowserAgent", id: "browser-agent" },
    }).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
  });

  it("requires each current warning to be waived before an otherwise ready project can certify", () => {
    const project = createProject({
      projectId: "warning-project",
      title: "Lesson with a reviewed exception",
      media: {
        sourceId: "warning-media",
        sha256: "d".repeat(64),
        durationMs: 60_000,
        relinkState: "Linked",
      },
      captions: [
        {
          kind: "CaptionCue",
          itemId: "c01",
          state: "Sustained",
          startMs: 1_000,
          endMs: 3_000,
          text: "A reviewed caption.",
          speaker: null,
          actor: human,
          cause: "fixture",
        },
        {
          kind: "CaptionCue",
          itemId: "c02",
          state: "Proposed",
          startMs: 3_000,
          endMs: 5_000,
          text: "An intentional exception.",
          speaker: null,
          actor: { type: "BrowserAgent", id: "browser-agent" },
          cause: "fixture",
        },
      ],
    });
    const validated = validate(project);
    const beforeWaiver = prepareCertificationReview(validated.project);
    expect(beforeWaiver.unwaivedWarnings).toHaveLength(1);
    expect(beforeWaiver.canCertify).toBe(false);

    const warning = beforeWaiver.unwaivedWarnings[0];
    if (warning === undefined) throw new Error("Expected the review-state warning.");
    const waived = applyCommand(validated.project, {
      type: "WaiveWarning",
      actor: human,
      findingId: warning.findingId,
      reason: "The person reviewed this intentional wording exception.",
      expectedProjectRevision: validated.project.projectRevision,
    });
    expect(waived.error).toBeUndefined();
    const afterWaiver = prepareCertificationReview(waived.project);
    expect(afterWaiver.unwaivedWarnings).toHaveLength(0);
    expect(afterWaiver.canCertify).toBe(true);
    expect(applyCommand(
      waived.project,
      certificationCommand(waived.project, afterWaiver.readinessHash),
    ).error).toBeUndefined();
  });

  it("preserves an immutable snapshot but stales current certification after a relevant edit", () => {
    const validated = validate(sustainedProject());
    const readiness = prepareCertificationReview(validated.project);
    const certified = applyCommand(
      validated.project,
      certificationCommand(validated.project, readiness.readinessHash),
    );
    expect(certified.error).toBeUndefined();
    expect(certified.project.certification.status).toBe("Current");
    const snapshot = certified.project.certifications[0];
    if (snapshot === undefined) throw new Error("Expected a certification snapshot.");
    expect(snapshot).toMatchObject({
      readinessHash: readiness.readinessHash,
      media: { sha256: "c".repeat(64) },
      itemRevisions: [{ itemId: "c01", itemRevision: 1 }],
      qualityProfile: { revision: 1 },
      actor: human,
      certifiedAtMs: 1_700_000_000_000,
    });
    expect(snapshot.certificationSnapshotHash).toMatch(/^sha256:v2:[0-9a-f]{64}$/);
    expect(snapshot.validationRun.findings).toEqual(validated.project.validationRun?.findings);
    const frozen = JSON.stringify(snapshot);

    const revised = applyCommand(certified.project, {
      type: "ReviseCue",
      actor: human,
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: certified.project.projectRevision,
      patch: { text: "Dr. Nguyen explains the free-energy equation." },
    });
    expect(revised.error).toBeUndefined();
    expect(revised.project.certification).toEqual({
      status: "Stale",
      certificationId: snapshot.certificationId,
    });
    expect(JSON.stringify(revised.project.certifications[0])).toBe(frozen);
  });
});
