import "fake-indexeddb/auto";

import {
  applyCommand,
  createProject,
  prepareCertificationReview,
  type CaptionProject,
} from "@cuebench/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CueBenchDatabase,
  StorageReadValidationError,
  estimateProjectStorage,
  executePersistentCommand,
  loadProject,
  saveProject,
  saveSourceMedia,
} from "./index";

let databaseNumber = 0;
const databases: CueBenchDatabase[] = [];

const testDatabase = (): CueBenchDatabase => {
  const db = new CueBenchDatabase(`cuebench-storage-test-${databaseNumber += 1}`);
  databases.push(db);
  return db;
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (db) => {
    db.close();
    await db.delete();
  }));
});

const fixtureProject = (): CaptionProject => createProject({
  projectId: "project-1",
  title: "Gibbs free energy lecture",
  media: {
    sourceId: "media-1",
    sha256: "a".repeat(64),
    durationMs: 60_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "c05",
    state: "Proposed",
    startMs: 1_000,
    endMs: 3_000,
    text: "Doctor Nguyen explains free energy.",
    speaker: "Dr. Nguyen",
    actor: { type: "BrowserAgent", id: "browser-agent" },
    cause: "fixture",
  }],
  audioDescriptions: [{
    kind: "AudioDescriptionBeat",
    itemId: "ad01",
    state: "Proposed",
    startMs: 6_000,
    endMs: 8_000,
    description: "A diagram shows the energy curve.",
    actor: { type: "CueBenchAI", id: "cuebench-ai" },
    cause: "fixture",
  }],
});

const humanSustainCommand = () => ({
  type: "SustainItem" as const,
  actor: { type: "Human" as const, id: "teacher" },
  itemId: "c05",
  expectedItemRevision: 1,
  expectedProjectRevision: 1,
});

describe("CueBenchDatabase", () => {
  it("persists project revision and Court Record atomically", async () => {
    const db = testDatabase();
    await saveProject(db, fixtureProject());

    const result = await executePersistentCommand(db, "project-1", humanSustainCommand());
    const saved = await loadProject(db, "project-1");

    expect(result.error).toBeUndefined();
    expect(saved?.projectRevision).toBe(2);
    expect(saved?.courtRecord.at(-1)?.type).toBe("SustainItem");
    expect(saved?.captions.items.c05?.current.state).toBe("Sustained");
  });

  it("rolls every normalized write back when a Court Record write fails", async () => {
    const db = testDatabase();
    await saveProject(db, fixtureProject());

    await expect(executePersistentCommand(db, "project-1", humanSustainCommand(), {
      beforeCourtRecordWrite: () => {
        throw new Error("injected Court Record failure");
      },
    })).rejects.toThrow("injected Court Record failure");

    const saved = await loadProject(db, "project-1");
    expect(saved?.projectRevision).toBe(1);
    expect(saved?.courtRecord).toEqual([]);
    expect(saved?.captions.items.c05?.current.state).toBe("Proposed");
  });

  it("does not lose an update when two commands race from the same revision", async () => {
    const db = testDatabase();
    await saveProject(db, fixtureProject());

    const [first, second] = await Promise.all([
      executePersistentCommand(db, "project-1", humanSustainCommand()),
      executePersistentCommand(db, "project-1", humanSustainCommand()),
    ]);

    expect([first.error?.code, second.error?.code].filter((code) => code === undefined)).toHaveLength(1);
    expect([first.error?.code, second.error?.code]).toContain("STALE_PROJECT");
    expect((await loadProject(db, "project-1"))?.projectRevision).toBe(2);
  });

  it("rejects malformed normalized records at the read boundary", async () => {
    const db = testDatabase();
    await saveProject(db, fixtureProject());
    await db.projectHeaders.update("project-1", { projectRevision: "not-a-revision" } as never);

    await expect(loadProject(db, "project-1")).rejects.toBeInstanceOf(StorageReadValidationError);
  });

  it("rehydrates normalized evidence, findings, and immutable certifications", async () => {
    const db = testDatabase();
    const reviewed = createProject({
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
        text: "x".repeat(80),
        speaker: "Dr. Nguyen",
        actor: { type: "Human", id: "teacher" },
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
    const validated = applyCommand(reviewed, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    });
    let waivedProject = validated.project;
    for (const warning of validated.project.validationRun?.warnings ?? []) {
      const waived = applyCommand(waivedProject, {
        type: "WaiveWarning",
        actor: { type: "Human", id: "teacher" },
        expectedProjectRevision: waivedProject.projectRevision,
        findingId: warning.findingId,
        reason: "The teacher explicitly reviewed this bounded exception.",
      });
      expect(waived.error).toBeUndefined();
      waivedProject = waived.project;
    }
    const readiness = prepareCertificationReview(waivedProject);
    const certified = applyCommand(waivedProject, {
      type: "CertifyProject",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: waivedProject.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "certification-1",
      certifiedAtMs: 1_700_000_000_000,
    });
    expect(certified.error).toBeUndefined();

    await saveProject(db, certified.project);
    const saved = await loadProject(db, "certification-project");

    expect(saved?.evidence).toHaveLength(1);
    expect(saved?.validationRun?.findings).toEqual(certified.project.validationRun?.findings);
    expect(saved?.certifications).toHaveLength(1);
    expect(saved?.certifications[0]?.validationRun.findings).toEqual(
      certified.project.certifications[0]?.validationRun.findings,
    );
    expect(await db.findings.where("projectId").equals("certification-project").count()).toBe(
      (certified.project.validationRun?.findings.length ?? 0)
      + (certified.project.certifications[0]?.validationRun.findings.length ?? 0),
    );
  });

  it("deduplicates source blobs by project and source hash and estimates bytes", async () => {
    const db = testDatabase();
    const blob = new Blob(["source-video"], { type: "video/mp4" });

    const [first, second] = await Promise.all([
      saveSourceMedia(db, "project-1", {
        sourceId: "media-1",
        sha256: "b".repeat(64),
        blob,
        fileName: "lesson.mp4",
      }),
      saveSourceMedia(db, "project-1", {
        sourceId: "another-id",
        sha256: "b".repeat(64),
        blob,
        fileName: "renamed.mp4",
      }),
    ]);
    const estimate = await estimateProjectStorage(db, "project-1");

    expect(first.key).toBe(second.key);
    expect(await db.sourceBlobs.where("projectId").equals("project-1").count()).toBe(1);
    expect(estimate.sourceBlobBytes).toBe(blob.size);
    expect(estimate.totalBytes).toBeGreaterThanOrEqual(blob.size);
  });
});
