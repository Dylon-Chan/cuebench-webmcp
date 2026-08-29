import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createProject,
  prepareCertificationReview,
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
      snapshotHash: readiness.snapshotHash,
      media: { sha256: "c".repeat(64) },
      itemRevisions: [{ itemId: "c01", itemRevision: 1 }],
      qualityProfile: { revision: 1 },
      actor: human,
      certifiedAtMs: 1_700_000_000_000,
    });
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
