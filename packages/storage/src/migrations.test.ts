import "fake-indexeddb/auto";

import {
  applyCommand,
  canonicalHash,
  createProject,
  intermediateCertificationSnapshotHashFor,
  legacyCertificationSnapshotHashFor,
  prepareCertificationReview,
} from "@cuebench/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CueBenchDatabase,
  describeImportedProject,
} from "./index";
import * as storage from "./index";

let databaseNumber = 0;
const databases: CueBenchDatabase[] = [];

const testDatabase = (): CueBenchDatabase => {
  const db = new CueBenchDatabase(`cuebench-migration-test-${databaseNumber += 1}`);
  databases.push(db);
  return db;
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

describe("project schema migrations", () => {
  it("migrates a realistic v0 media and item shape to v1", () => {
    const descriptor = describeImportedProject({
      schemaVersion: 0,
      project: {
        projectId: "project-1",
        revision: 5,
        name: "Gibbs free energy lecture",
        sourceMedia: {
          id: "media-1",
          hash: "a".repeat(64),
          durationMs: 60_000,
          linked: true,
        },
        captionCues: [{
          id: "c05",
          startMs: 1_000,
          endMs: 3_000,
          text: "Doctor Nguyen explains free energy.",
          speaker: "Dr. Nguyen",
          revision: 3,
          state: "Sustained",
          actor: { type: "Human", id: "teacher" },
        }],
        audioDescriptionBeats: [{
          id: "ad01",
          startMs: 4_000,
          endMs: 6_000,
          description: "A graph appears beside the lecturer.",
          revision: 4,
          state: "Sustained",
          actor: { type: "Human", id: "teacher" },
        }],
        history: [{
          id: "event-1",
          kind: "SustainItem",
          revision: 5,
          actor: { type: "Human", id: "teacher" },
          itemId: "c05",
          detail: "The teacher sustained the cue after review.",
        }],
      },
    });

    expect(descriptor.mode).toBe("preview");
    if (descriptor.mode !== "preview") throw new Error("expected preview descriptor");
    expect(descriptor.migratedFrom).toBe(0);
    expect(descriptor.requiresHumanConfirmation).toBe(true);
    expect(descriptor.project.contractVersion).toBe(1);
    expect(descriptor.project.media).toMatchObject({ sourceId: "media-1", relinkState: "Missing" });
    expect(descriptor.project.projectRevision).toBe(5);
    expect(descriptor.project.captions.items.c05?.revisions).toHaveLength(1);
    expect(descriptor.project.captions.items.c05?.current.itemRevision).toBe(1);
    expect(descriptor.project.courtRecord).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: "event-1",
        type: "SustainItem",
        projectRevision: 5,
        actor: { type: "Human", id: "teacher" },
        itemId: "c05",
        detail: "The teacher sustained the cue after review.",
      }),
      expect.objectContaining({
        type: "LegacyItemRevisionPayloadHistoryUnavailable",
        projectRevision: 5,
        actor: { type: "System", id: "cuebench-migration" },
        detail: "Legacy v0 omits 5 prior item revision payload(s); each migrated item retains only its explicit current payload as revision 1.",
      }),
    ]));
    expect(storage).not.toHaveProperty("importProject");
  });

  it("never reports backed-up v1 media as linked and stales derived artifacts", () => {
    const validated = applyCommand(createProject({
      projectId: "preview-project",
      title: "Preview only",
      media: { sourceId: "source-1", sha256: "a".repeat(64), durationMs: 60_000, relinkState: "Linked" },
      captions: [{
        kind: "CaptionCue",
        itemId: "c01",
        state: "Sustained",
        startMs: 1_000,
        endMs: 3_000,
        text: "A reviewed caption.",
        speaker: null,
        actor: { type: "Human", id: "teacher" },
        cause: "fixture",
      }],
    }), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    });
    expect(validated.error).toBeUndefined();
    const current = describeImportedProject({
      schemaVersion: 1,
      project: validated.project,
    });

    expect(current.mode).toBe("preview");
    if (current.mode !== "preview") throw new Error("Expected preview descriptor.");
    expect(current.project.media.relinkState).toBe("Missing");
    expect(current.project.validation.status).toBe("Stale");
  });

  it("upgrades authenticated legacy and intermediate certifications in a v1 preview before marking it stale", () => {
    let project = applyCommand(createProject({
      projectId: "legacy-certified-preview",
      title: "Legacy certified preview",
      media: { sourceId: "source-1", sha256: "c".repeat(64), durationMs: 60_000, relinkState: "Linked" },
      captions: [{
        kind: "CaptionCue",
        itemId: "c01",
        state: "Sustained",
        startMs: 1_000,
        endMs: 3_000,
        text: "x".repeat(80),
        speaker: null,
        actor: { type: "Human", id: "teacher" },
        cause: "fixture",
      }],
      evidence: [{
        evidenceId: "evidence-1",
        projectId: "legacy-certified-preview",
        mediaSha256: "c".repeat(64),
        itemId: "c01",
        itemRevision: 1,
      }],
    }), {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    for (const warning of project.validationRun?.warnings ?? []) {
      project = applyCommand(project, {
        type: "WaiveWarning",
        actor: { type: "Human", id: "teacher" },
        expectedProjectRevision: project.projectRevision,
        findingId: warning.findingId,
        reason: "Reviewed legacy exception.",
      }).project;
    }
    const certified = applyCommand(project, {
      type: "CertifyProject",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: project.projectRevision,
      expectedReadinessHash: prepareCertificationReview(project).readinessHash,
      certificationId: "legacy-certification-1",
      certifiedAtMs: 1_700_000_000_000,
    }).project;
    const snapshot = certified.certifications[0];
    if (snapshot === undefined) throw new Error("Expected certification snapshot.");
    const legacyProject = {
      ...certified,
      certifications: [{
        ...snapshot,
        certificationSnapshotHash: legacyCertificationSnapshotHashFor(snapshot),
      }],
    };

    const descriptor = describeImportedProject({ schemaVersion: 1, project: legacyProject });

    if (descriptor.mode !== "preview") throw new Error("Expected preview descriptor.");
    expect(descriptor.project.media.relinkState).toBe("Missing");
    expect(descriptor.project.certification.status).toBe("Stale");
    expect(descriptor.project.certifications[0]?.certificationSnapshotHash).toMatch(/^sha256:v2:/);

    const legacyEvidence = legacyProject.certifications[0]?.evidence[0];
    if (legacyEvidence === undefined) throw new Error("Expected legacy certification evidence.");
    expect(() => describeImportedProject({
      schemaVersion: 1,
      project: {
        ...legacyProject,
        certifications: [{
          ...legacyProject.certifications[0]!,
          evidence: [{ ...legacyEvidence, mediaSha256: "d".repeat(64) }],
        }],
      },
    })).toThrow(/certification/i);

    const intermediateProject = {
      ...certified,
      certifications: [{
        ...snapshot,
        certificationSnapshotHash: (() => {
          const historicalContent = { ...snapshot };
          Reflect.deleteProperty(historicalContent, "certificationSnapshotHash");
          return canonicalHash("cuebench.certification-snapshot.v2", historicalContent);
        })(),
      }],
    };
    const intermediate = describeImportedProject({ schemaVersion: 1, project: intermediateProject });
    if (intermediate.mode !== "preview") throw new Error("Expected intermediate preview descriptor.");
    expect(intermediateCertificationSnapshotHashFor(snapshot)).toBe(
      intermediateProject.certifications[0]?.certificationSnapshotHash,
    );
    expect(intermediate.project.certifications[0]?.certificationSnapshotHash).toBe(snapshot.certificationSnapshotHash);

    const intermediateEvidence = intermediateProject.certifications[0]?.evidence[0];
    if (intermediateEvidence === undefined) throw new Error("Expected intermediate certification evidence.");
    expect(() => describeImportedProject({
      schemaVersion: 1,
      project: {
        ...intermediateProject,
        certifications: [{
          ...intermediateProject.certifications[0]!,
          evidence: [{ ...intermediateEvidence, mediaSha256: "d".repeat(64) }],
        }],
      },
    })).toThrow(/certification/i);

    const current = describeImportedProject({ schemaVersion: 1, project: certified });
    if (current.mode !== "preview") throw new Error("Expected current preview descriptor.");
    expect(current.project.certifications[0]?.certificationSnapshotHash).toBe(snapshot.certificationSnapshotHash);
  });

  it("does not fabricate an unavailable-history marker when every v0 item has only its current payload", () => {
    const descriptor = describeImportedProject({
      schemaVersion: 0,
      project: {
        projectId: "single-revision-project",
        revision: 2,
        name: "Single revision lesson",
        sourceMedia: { id: "source-1", hash: "b".repeat(64), durationMs: 10_000, linked: false },
        captionCues: [{
          id: "c01",
          startMs: 0,
          endMs: 1_000,
          text: "Only current payload.",
          speaker: null,
          revision: 1,
          state: "Sustained",
          actor: { type: "Human", id: "teacher" },
        }],
        history: [{
          id: "event-1",
          kind: "SustainItem",
          revision: 2,
          actor: { type: "Human", id: "teacher" },
          itemId: "c01",
          detail: "Preserved exactly.",
        }],
      },
    });

    if (descriptor.mode !== "preview") throw new Error("Expected preview descriptor.");
    expect(descriptor.project.courtRecord).toEqual([{
      eventId: "event-1",
      type: "SustainItem",
      projectRevision: 2,
      actor: { type: "Human", id: "teacher" },
      itemId: "c01",
      detail: "Preserved exactly.",
    }]);
  });

  it("describes newer imports as read-only and never writes them", async () => {
    const db = testDatabase();
    const incoming = { schemaVersion: 2, project: { projectId: "future-project" } };

    const descriptor = describeImportedProject(incoming);

    expect(descriptor).toMatchObject({ mode: "read-only", readOnly: true, schemaVersion: 2 });
    expect(await db.projectHeaders.count()).toBe(0);
  });
});
