import "fake-indexeddb/auto";

import Dexie from "dexie";
import {
  applyCommand,
  canonicalHash,
  createProject,
  intermediateCertificationSnapshotHashFor,
  legacyCertificationSnapshotHashFor,
  prepareCertificationReview,
  type CaptionProject,
} from "@cuebench/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CueBenchDatabase,
  StorageImmutableWriteError,
  StorageReadValidationError,
  estimateProjectStorage,
  executePersistentCommand,
  initializeProject,
  loadProject,
  loadSourceMedia,
  saveRunReceipt,
  saveSourceMedia,
} from "./index";
import { sha256Hex } from "@cuebench/domain";
import { normalizeProject } from "./database";

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

const certifiedFixtureProject = (
  projectId = "certified-storage-project",
  includeEvidence = true,
): CaptionProject => {
  let project = applyCommand(createProject({
    projectId,
    title: "Certified storage lesson",
    media: { sourceId: "media-certified", sha256: "c".repeat(64), durationMs: 60_000, relinkState: "Linked" },
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
    evidence: includeEvidence ? [{
      evidenceId: "evidence-1",
      projectId,
      mediaSha256: "c".repeat(64),
      itemId: "c01",
      itemRevision: 1,
    }] : [],
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
      reason: "The teacher explicitly reviewed this bounded exception.",
    }).project;
  }
  const certified = applyCommand(project, {
    type: "CertifyProject",
    actor: { type: "Human", id: "teacher" },
    expectedProjectRevision: project.projectRevision,
    expectedReadinessHash: prepareCertificationReview(project).readinessHash,
    certificationId: "certification-1",
    certifiedAtMs: 1_700_000_000_000,
  });
  if (certified.error !== undefined) throw new Error(`Could not build certified fixture: ${certified.error.code}`);
  return certified.project;
};

describe("CueBenchDatabase", () => {
  it("persists project revision and Court Record atomically", async () => {
    const db = testDatabase();
    await initializeProject(db, fixtureProject());

    const result = await executePersistentCommand(db, "project-1", humanSustainCommand());
    const saved = await loadProject(db, "project-1");

    expect(result.error).toBeUndefined();
    expect(saved?.projectRevision).toBe(2);
    expect(saved?.courtRecord.at(-1)?.type).toBe("SustainItem");
    expect(saved?.captions.items.c05?.current.state).toBe("Sustained");
    expect(saved).toEqual(result.project);
  });

  it("initializes once and appends immutable revisions and Court Record rows", async () => {
    const db = testDatabase();
    await initializeProject(db, fixtureProject());
    const originalRevisions = await db.revisions.where("projectId").equals("project-1").toArray();

    await expect(initializeProject(db, fixtureProject())).rejects.toBeInstanceOf(StorageImmutableWriteError);
    await executePersistentCommand(db, "project-1", humanSustainCommand());

    const revisions = await db.revisions.where("projectId").equals("project-1").toArray();
    expect(revisions).toEqual(expect.arrayContaining(originalRevisions));
    expect(revisions).toHaveLength(originalRevisions.length + 1);
    expect(await db.courtRecord.where("projectId").equals("project-1").count()).toBe(1);
  });

  it("appends versioned evidence and validation findings without replacing prior immutable rows", async () => {
    const db = testDatabase();
    const project = {
      ...fixtureProject(),
      evidence: [{
        evidenceId: "evidence-1",
        projectId: "project-1",
        mediaSha256: "a".repeat(64),
        itemId: "c05",
        itemRevision: 1,
      }],
    } as CaptionProject;
    await initializeProject(db, project);

    await executePersistentCommand(db, "project-1", humanSustainCommand());
    const evidenceHistory = await db.evidence.where("projectId").equals("project-1").toArray();
    expect(evidenceHistory).toHaveLength(2);
    expect(evidenceHistory.map((row) => row.version).sort()).toEqual([1, 2]);
    expect((await loadProject(db, "project-1"))?.evidence[0]?.itemRevision).toBe(2);

    const validation = await executePersistentCommand(db, "project-1", {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 2,
    });
    expect(validation.error).toBeUndefined();
    const firstFindingCount = await db.findings.where("projectId").equals("project-1").count();
    const secondValidation = await executePersistentCommand(db, "project-1", {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 3,
    });
    expect(secondValidation.error).toBeUndefined();
    expect(await db.findings.where("projectId").equals("project-1").count()).toBeGreaterThan(firstFindingCount);
  });

  it("retains stale evidence provenance when a human relinks media", async () => {
    const db = testDatabase();
    const project = {
      ...fixtureProject(),
      evidence: [{
        evidenceId: "evidence-1",
        projectId: "project-1",
        mediaSha256: "a".repeat(64),
        itemId: "c05",
        itemRevision: 1,
      }],
    } as CaptionProject;
    await initializeProject(db, project);

    const relinked = await executePersistentCommand(db, "project-1", {
      type: "RelinkMedia",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: 1,
      media: { sourceId: "media-2", sha256: "b".repeat(64), durationMs: 60_000 },
    });

    expect(relinked.error).toBeUndefined();
    const restored = await loadProject(db, "project-1");
    expect(restored?.media.sha256).toBe("b".repeat(64));
    expect(restored?.evidence[0]?.mediaSha256).toBe("a".repeat(64));
    expect(restored?.validation.status).toBe("NotRun");
  });

  it("rolls every normalized write back when a Court Record write fails", async () => {
    const db = testDatabase();
    await initializeProject(db, fixtureProject());

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
    await initializeProject(db, fixtureProject());

    const [first, second] = await Promise.all([
      executePersistentCommand(db, "project-1", humanSustainCommand()),
      executePersistentCommand(db, "project-1", humanSustainCommand()),
    ]);

    expect([first.error?.code, second.error?.code].filter((code) => code === undefined)).toHaveLength(1);
    expect([first.error?.code, second.error?.code]).toContain("STALE_PROJECT");
    expect((await loadProject(db, "project-1"))?.projectRevision).toBe(2);
  });

  it("uses the persisted revision as a compare-and-swap across two Dexie connections", async () => {
    const databaseName = `cuebench-storage-cross-tab-${databaseNumber += 1}`;
    const firstTab = new CueBenchDatabase(databaseName);
    const secondTab = new CueBenchDatabase(databaseName);
    databases.push(firstTab, secondTab);
    await initializeProject(firstTab, fixtureProject());

    const [first, second] = await Promise.all([
      executePersistentCommand(firstTab, "project-1", humanSustainCommand()),
      executePersistentCommand(secondTab, "project-1", humanSustainCommand()),
    ]);

    expect([first.error?.code, second.error?.code].filter((code) => code === undefined)).toHaveLength(1);
    expect([first.error?.code, second.error?.code]).toContain("STALE_PROJECT");
    expect((await loadProject(secondTab, "project-1"))?.projectRevision).toBe(2);
  });

  it("upgrades a physical Dexie v1 database without confusing it with the backup schema version", async () => {
    const databaseName = `cuebench-storage-physical-v1-${databaseNumber += 1}`;
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({
      projectHeaders: "&projectId, projectRevision, updatedAtMs",
      items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
      revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
      findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
      evidence: "&key, projectId, evidenceId, [projectId+evidenceId]",
      courtRecord: "&key, projectId, eventId, projectRevision, [projectId+eventId]",
      certifications: "&key, projectId, certificationId, [projectId+certificationId]",
      sourceBlobs: "&key, projectId, sourceId, sha256, [projectId+sha256], [projectId+sourceId]",
      narrationBlobs: "&key, projectId, beatId, itemRevision, [projectId+beatId+itemRevision]",
      runReceipts: "&key, projectId, runId, [projectId+runId]",
      settings: "&key, updatedAtMs",
    });
    await legacy.open();
    const aggregate = {
      ...fixtureProject(),
      evidence: [{
        evidenceId: "evidence-1",
        projectId: "project-1",
        mediaSha256: "a".repeat(64),
        itemId: "c05",
        itemRevision: 1,
      }],
    } as CaptionProject;
    const normalized = normalizeProject(aggregate, { createdAtMs: 1, updatedAtMs: 1 });
    const legacyHeader = { ...normalized.header } as Record<string, unknown>;
    Reflect.deleteProperty(legacyHeader, "evidenceOrder");
    const legacyEvidence = normalized.evidence.map((row) => ({
      key: JSON.stringify([row.projectId, row.evidenceId]),
      projectId: row.projectId,
      evidenceId: row.evidenceId,
      sequence: row.sequence,
      evidence: row.evidence,
    }));
    await legacy.table("projectHeaders").add(legacyHeader);
    await legacy.table("items").bulkAdd([...normalized.items]);
    await legacy.table("revisions").bulkAdd([...normalized.revisions]);
    await legacy.table("findings").bulkAdd([...normalized.findings]);
    await legacy.table("evidence").bulkAdd(legacyEvidence);
    await legacy.table("courtRecord").bulkAdd([...normalized.courtRecord]);
    await legacy.table("certifications").bulkAdd([...normalized.certifications]);
    legacy.close();

    const upgraded = new CueBenchDatabase(databaseName);
    databases.push(upgraded);
    await upgraded.open();

    expect(await loadProject(upgraded, "project-1")).toEqual(aggregate);
    const result = await executePersistentCommand(upgraded, "project-1", humanSustainCommand());
    expect(result.error).toBeUndefined();
    expect((await upgraded.evidence.where("projectId").equals("project-1").toArray()).map((row) => row.version).sort()).toEqual([1, 2]);
    expect(await loadProject(upgraded, "project-1")).toEqual(result.project);
  });

  it("migrates every valid mixed v1 header and evidence row without rewriting v2-shaped rows", async () => {
    const databaseName = `cuebench-storage-physical-v1-mixed-${databaseNumber += 1}`;
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({
      projectHeaders: "&projectId, projectRevision, updatedAtMs",
      items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
      revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
      findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
      evidence: "&key, projectId, evidenceId, [projectId+evidenceId]",
      courtRecord: "&key, projectId, eventId, projectRevision, [projectId+eventId]",
      certifications: "&key, projectId, certificationId, [projectId+certificationId]",
      sourceBlobs: "&key, projectId, sourceId, sha256, [projectId+sha256], [projectId+sourceId]",
      narrationBlobs: "&key, projectId, beatId, itemRevision, [projectId+beatId+itemRevision]",
      runReceipts: "&key, projectId, runId, [projectId+runId]",
      settings: "&key, updatedAtMs",
    });
    await legacy.open();
    const currentHeaderLegacyEvidence = {
      ...fixtureProject(),
      projectId: "mixed-current-header",
      evidence: [{
        evidenceId: "evidence-current-header",
        projectId: "mixed-current-header",
        mediaSha256: "a".repeat(64),
        itemId: "c05",
        itemRevision: 1,
      }],
    } as CaptionProject;
    const legacyHeaderCurrentEvidence = {
      ...fixtureProject(),
      projectId: "mixed-legacy-header",
      evidence: [{
        evidenceId: "evidence-legacy-header",
        projectId: "mixed-legacy-header",
        mediaSha256: "a".repeat(64),
        itemId: "c05",
        itemRevision: 1,
      }],
    } as CaptionProject;
    const currentRows = normalizeProject(currentHeaderLegacyEvidence, { createdAtMs: 1, updatedAtMs: 1 });
    const legacyRows = normalizeProject(legacyHeaderCurrentEvidence, { createdAtMs: 2, updatedAtMs: 2 });
    const legacyHeader = { ...legacyRows.header } as Record<string, unknown>;
    Reflect.deleteProperty(legacyHeader, "evidenceOrder");
    const legacyEvidence = currentRows.evidence.map((row) => ({
      key: JSON.stringify([row.projectId, row.evidenceId]),
      projectId: row.projectId,
      evidenceId: row.evidenceId,
      sequence: row.sequence,
      evidence: row.evidence,
    }));
    await legacy.table("projectHeaders").bulkAdd([currentRows.header, legacyHeader]);
    await legacy.table("items").bulkAdd([...currentRows.items, ...legacyRows.items]);
    await legacy.table("revisions").bulkAdd([...currentRows.revisions, ...legacyRows.revisions]);
    await legacy.table("findings").bulkAdd([...currentRows.findings, ...legacyRows.findings]);
    await legacy.table("evidence").bulkAdd([...legacyEvidence, ...legacyRows.evidence]);
    await legacy.table("courtRecord").bulkAdd([...currentRows.courtRecord, ...legacyRows.courtRecord]);
    await legacy.table("certifications").bulkAdd([...currentRows.certifications, ...legacyRows.certifications]);
    legacy.close();

    const upgraded = new CueBenchDatabase(databaseName);
    databases.push(upgraded);
    await upgraded.open();
    expect(await upgraded.projectHeaders.get(currentHeaderLegacyEvidence.projectId)).toEqual(currentRows.header);
    expect(await upgraded.evidence.get(legacyRows.evidence[0]!.key)).toEqual(legacyRows.evidence[0]);
    expect(await loadProject(upgraded, currentHeaderLegacyEvidence.projectId)).toEqual(currentHeaderLegacyEvidence);
    expect(await loadProject(upgraded, legacyHeaderCurrentEvidence.projectId)).toEqual(legacyHeaderCurrentEvidence);
    const result = await executePersistentCommand(upgraded, legacyHeaderCurrentEvidence.projectId, humanSustainCommand());
    expect(result.error).toBeUndefined();
    expect(await loadProject(upgraded, legacyHeaderCurrentEvidence.projectId)).toEqual(result.project);
  });

  it("upgrades only verified legacy certification rows from a physical v1 database", async () => {
    const aggregate = certifiedFixtureProject("legacy-certified-storage");
    const snapshot = aggregate.certifications[0];
    if (snapshot === undefined) throw new Error("Certified fixture is missing its snapshot.");
    const normalized = normalizeProject(aggregate, { createdAtMs: 1, updatedAtMs: 1 });
    const legacyHeader = { ...normalized.header } as Record<string, unknown>;
    Reflect.deleteProperty(legacyHeader, "evidenceOrder");
    const legacyEvidence = normalized.evidence.map((row) => ({
      key: JSON.stringify([row.projectId, row.evidenceId]),
      projectId: row.projectId,
      evidenceId: row.evidenceId,
      sequence: row.sequence,
      evidence: row.evidence,
    }));
    const legacyCertificationRows = normalized.certifications.map((row) => ({
      ...row,
      certification: {
        ...row.certification,
        certificationSnapshotHash: legacyCertificationSnapshotHashFor(snapshot),
      },
    }));
    const seed = async (databaseName: string, certifications = legacyCertificationRows) => {
      const raw = new Dexie(databaseName);
      raw.version(1).stores({
        projectHeaders: "&projectId, projectRevision, updatedAtMs",
        items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
        revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
        findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
        evidence: "&key, projectId, evidenceId, [projectId+evidenceId]",
        courtRecord: "&key, projectId, eventId, projectRevision, [projectId+eventId]",
        certifications: "&key, projectId, certificationId, [projectId+certificationId]",
        sourceBlobs: "&key, projectId, sourceId, sha256, [projectId+sha256], [projectId+sourceId]",
        narrationBlobs: "&key, projectId, beatId, itemRevision, [projectId+beatId+itemRevision]",
        runReceipts: "&key, projectId, runId, [projectId+runId]",
        settings: "&key, updatedAtMs",
      });
      await raw.open();
      await raw.table("projectHeaders").add(legacyHeader);
      await raw.table("items").bulkAdd([...normalized.items]);
      await raw.table("revisions").bulkAdd([...normalized.revisions]);
      await raw.table("findings").bulkAdd([...normalized.findings]);
      await raw.table("evidence").bulkAdd(legacyEvidence);
      await raw.table("courtRecord").bulkAdd([...normalized.courtRecord]);
      await raw.table("certifications").bulkAdd(certifications);
      raw.close();
    };

    const validName = `cuebench-storage-legacy-certified-${databaseNumber += 1}`;
    await seed(validName);
    const upgraded = new CueBenchDatabase(validName);
    databases.push(upgraded);
    await upgraded.open();
    expect(await loadProject(upgraded, aggregate.projectId)).toEqual(aggregate);

    const evidence = legacyCertificationRows[0]?.certification.evidence[0];
    if (evidence === undefined) throw new Error("Legacy fixture is missing certification evidence.");
    const tamperedRows = legacyCertificationRows.map((row) => ({
      ...row,
      certification: {
        ...row.certification,
        evidence: [{ ...evidence, mediaSha256: "d".repeat(64) }],
      },
    }));
    const tamperedName = `cuebench-storage-legacy-certified-tampered-${databaseNumber += 1}`;
    await seed(tamperedName, tamperedRows);
    const tampered = new CueBenchDatabase(tamperedName);
    databases.push(tampered);
    await expect(tampered.open()).rejects.toThrow(/certification/i);
  });

  it("upgrades authenticated intermediate certification rows from physical Dexie v2 to v3", async () => {
    const aggregate = certifiedFixtureProject("intermediate-certified-physical-v2");
    const snapshot = aggregate.certifications[0];
    if (snapshot === undefined) throw new Error("Certified fixture is missing its snapshot.");
    const normalized = normalizeProject(aggregate, { createdAtMs: 1, updatedAtMs: 1 });
    const intermediateRows = normalized.certifications.map((row) => ({
      ...row,
      certification: {
        ...row.certification,
        certificationSnapshotHash: (() => {
          const historicalContent = { ...snapshot };
          Reflect.deleteProperty(historicalContent, "certificationSnapshotHash");
          return canonicalHash("cuebench.certification-snapshot.v2", historicalContent);
        })(),
      },
    }));
    expect(intermediateCertificationSnapshotHashFor(snapshot)).toBe(
      intermediateRows[0]?.certification.certificationSnapshotHash,
    );
    const seed = async (
      databaseName: string,
      certifications: readonly (typeof intermediateRows)[number][] = intermediateRows,
    ) => {
      const raw = new Dexie(databaseName);
      raw.version(2).stores({
        projectHeaders: "&projectId, projectRevision, [projectId+projectRevision], updatedAtMs",
        items: "&key, projectId, itemId, [projectId+itemId], kind, currentItemRevision",
        revisions: "&key, projectId, itemId, itemRevision, [projectId+itemId], [projectId+itemId+itemRevision], kind",
        findings: "&key, projectId, scope, findingId, [projectId+scope], [projectId+scope+findingId]",
        evidence: "&key, projectId, evidenceId, version, [projectId+evidenceId], [projectId+evidenceId+version]",
        courtRecord: "&key, projectId, eventId, projectRevision, [projectId+eventId]",
        certifications: "&key, projectId, certificationId, [projectId+certificationId]",
        sourceBlobs: "&key, projectId, sourceId, sha256, [projectId+sha256], [projectId+sourceId]",
        narrationBlobs: "&key, projectId, beatId, itemRevision, [projectId+beatId+itemRevision]",
        runReceipts: "&key, projectId, runId, [projectId+runId]",
        settings: "&key, updatedAtMs",
      });
      await raw.open();
      await raw.table("projectHeaders").add(normalized.header);
      await raw.table("items").bulkAdd([...normalized.items]);
      await raw.table("revisions").bulkAdd([...normalized.revisions]);
      await raw.table("findings").bulkAdd([...normalized.findings]);
      await raw.table("evidence").bulkAdd([...normalized.evidence]);
      await raw.table("courtRecord").bulkAdd([...normalized.courtRecord]);
      await raw.table("certifications").bulkAdd(certifications);
      raw.close();
    };

    const intermediateName = `cuebench-storage-intermediate-v2-${databaseNumber += 1}`;
    await seed(intermediateName);
    const upgraded = new CueBenchDatabase(intermediateName);
    databases.push(upgraded);
    await upgraded.open();
    expect(upgraded.verno).toBe(3);
    expect(await upgraded.certifications.get(normalized.certifications[0]!.key)).toEqual(normalized.certifications[0]);
    expect(await loadProject(upgraded, aggregate.projectId)).toEqual(aggregate);

    const currentName = `cuebench-storage-current-v2-${databaseNumber += 1}`;
    await seed(currentName, normalized.certifications);
    const current = new CueBenchDatabase(currentName);
    databases.push(current);
    await current.open();
    expect(await current.certifications.get(normalized.certifications[0]!.key)).toEqual(normalized.certifications[0]);

    const evidence = intermediateRows[0]?.certification.evidence[0];
    if (evidence === undefined) throw new Error("Intermediate fixture is missing certification evidence.");
    const tamperedRows = intermediateRows.map((row) => ({
      ...row,
      certification: {
        ...row.certification,
        evidence: [{ ...evidence, mediaSha256: "d".repeat(64) }],
      },
    }));
    const tamperedName = `cuebench-storage-intermediate-v2-tampered-${databaseNumber += 1}`;
    await seed(tamperedName, tamperedRows);
    const tampered = new CueBenchDatabase(tamperedName);
    databases.push(tampered);
    await expect(tampered.open()).rejects.toThrow(/certification/i);
  });

  it("rejects malformed normalized records at the read boundary", async () => {
    const db = testDatabase();
    await initializeProject(db, fixtureProject());
    await db.projectHeaders.update("project-1", { projectRevision: "not-a-revision" } as never);

    await expect(loadProject(db, "project-1")).rejects.toBeInstanceOf(StorageReadValidationError);
  });

  it("preserves user-facing text byte-for-byte while rejecting noncanonical identifiers", async () => {
    const db = testDatabase();
    const project = fixtureProject();
    const cue = project.captions.items.c05;
    if (cue === undefined) throw new Error("Fixture cue is missing.");
    const exactCause = "  Exact retained cause.  ";
    const exactProject = {
      ...project,
      title: "  Exact retained title.  ",
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c05: {
            ...cue,
            revisions: cue.revisions.map((revision) => ({ ...revision, cause: exactCause })),
            current: { ...cue.current, cause: exactCause },
          },
        },
      },
      courtRecord: [{
        eventId: "event-1",
        projectRevision: 1,
        type: "  Exact retained event type.  ",
        actor: { type: "System" as const, id: "fixture-system" },
        detail: "  Exact retained event detail.  ",
      }],
    } as CaptionProject;

    await initializeProject(db, exactProject);
    const restored = await loadProject(db, "project-1");
    expect(restored).toEqual(exactProject);

    await expect(initializeProject(testDatabase(), {
      ...fixtureProject(),
      projectId: " project-1 ",
    } as CaptionProject)).rejects.toBeInstanceOf(StorageReadValidationError);
  });

  it("rejects globally colliding item identities and duplicate immutable identities before initialization", async () => {
    const db = testDatabase();
    const project = fixtureProject();
    const ad = project.audioDescriptions.items.ad01;
    if (ad === undefined) throw new Error("Fixture AD beat is missing.");
    const collidingAudioDescription = {
      ...ad,
      itemId: "c05",
      revisions: ad.revisions.map((revision) => ({ ...revision, itemId: "c05" })),
      current: { ...ad.current, itemId: "c05" },
    };
    const collision = {
      ...project,
      audioDescriptions: {
        ...project.audioDescriptions,
        order: ["c05"],
        items: { c05: collidingAudioDescription },
      },
    } as CaptionProject;
    await expect(initializeProject(db, collision)).rejects.toBeInstanceOf(StorageReadValidationError);

    const duplicateEvidence = {
      ...project,
      evidence: [
        { evidenceId: "e1", projectId: "project-1", mediaSha256: "a".repeat(64), itemId: "c05", itemRevision: 1 },
        { evidenceId: "e1", projectId: "project-1", mediaSha256: "a".repeat(64), itemId: "c05", itemRevision: 1 },
      ],
    } as CaptionProject;
    await expect(initializeProject(testDatabase(), duplicateEvidence)).rejects.toBeInstanceOf(StorageReadValidationError);

    const sustained = applyCommand(project, humanSustainCommand()).project;
    const duplicateEvents = { ...sustained, courtRecord: [sustained.courtRecord[0]!, sustained.courtRecord[0]!] };
    await expect(initializeProject(testDatabase(), duplicateEvents)).rejects.toBeInstanceOf(StorageReadValidationError);

    const cue = project.captions.items.c05;
    if (cue === undefined) throw new Error("Fixture cue is missing.");
    const duplicateRevision = {
      ...project,
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c05: {
            ...cue,
            revisions: [...cue.revisions, { ...cue.current, itemRevision: 1, parentItemRevision: null }],
          },
        },
      },
    } as CaptionProject;
    await expect(initializeProject(testDatabase(), duplicateRevision)).rejects.toBeInstanceOf(StorageReadValidationError);

    const validated = applyCommand(project, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    }).project;
    const firstFinding = validated.validationRun?.findings[0];
    if (firstFinding === undefined || validated.validationRun === null) throw new Error("Fixture must produce a finding.");
    const duplicateFinding = {
      ...validated,
      validationRun: {
        ...validated.validationRun,
        findings: [...validated.validationRun.findings, firstFinding],
      },
    } as CaptionProject;
    await expect(initializeProject(testDatabase(), duplicateFinding)).rejects.toBeInstanceOf(StorageReadValidationError);
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

    const snapshot = certified.project.certifications[0];
    if (snapshot === undefined) throw new Error("Certification snapshot is missing.");
    await expect(initializeProject(testDatabase(), {
      ...certified.project,
      certifications: [snapshot, snapshot],
    } as CaptionProject)).rejects.toBeInstanceOf(StorageReadValidationError);

    await initializeProject(db, certified.project);
    const saved = await loadProject(db, "certification-project");

    expect(saved?.evidence).toHaveLength(1);
    expect(saved?.validationRun?.findings).toEqual(certified.project.validationRun?.findings);
    expect(saved?.certifications).toHaveLength(1);
    expect(saved?.certifications[0]?.validationRun.findings).toEqual(
      certified.project.certifications[0]?.validationRun.findings,
    );
    expect(await db.findings.where("projectId").equals("certification-project").count()).toBe(
      certified.project.validationRun?.findings.length ?? 0,
    );
    expect(saved).toEqual(certified.project);

    await db.projectHeaders.update("certification-project", { warningWaivers: {} } as never);
    await expect(loadProject(db, "certification-project")).rejects.toBeInstanceOf(StorageReadValidationError);
    await db.projectHeaders.update("certification-project", {
      warningWaivers: certified.project.warningWaivers,
    } as never);
    await db.projectHeaders.update("certification-project", {
      certification: { status: "Current", certificationId: "missing-certification" },
    } as never);
    await expect(loadProject(db, "certification-project")).rejects.toBeInstanceOf(StorageReadValidationError);
  });

  it("appends a human certification through the persistent command boundary", async () => {
    const db = testDatabase();
    const reviewed = createProject({
      projectId: "command-certification-project",
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
        projectId: "command-certification-project",
        mediaSha256: "c".repeat(64),
        itemId: "c01",
        itemRevision: 1,
      }],
    });
    await initializeProject(db, reviewed);
    let current = (await executePersistentCommand(db, reviewed.projectId, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: 1,
    })).project;
    for (const warning of current.validationRun?.warnings ?? []) {
      const waived = await executePersistentCommand(db, reviewed.projectId, {
        type: "WaiveWarning",
        actor: { type: "Human", id: "teacher" },
        expectedProjectRevision: current.projectRevision,
        findingId: warning.findingId,
        reason: "The teacher explicitly reviewed this bounded exception.",
      });
      expect(waived.error).toBeUndefined();
      current = waived.project;
    }
    const readiness = prepareCertificationReview(current);
    const certified = await executePersistentCommand(db, reviewed.projectId, {
      type: "CertifyProject",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: current.projectRevision,
      expectedReadinessHash: readiness.readinessHash,
      certificationId: "command-certification-1",
      certifiedAtMs: 1_700_000_000_000,
    });

    expect(certified.error).toBeUndefined();
    expect(await db.certifications.where("projectId").equals(reviewed.projectId).count()).toBe(1);
    expect((await loadProject(db, reviewed.projectId))).toEqual(certified.project);
  });

  it("binds a current certification only to waivers applicable to its current warning ids", async () => {
    const db = testDatabase();
    const initial = certifiedFixtureProject("historical-waiver-project", false);
    const initialWaiverIds = Object.keys(initial.warningWaivers);
    expect(initialWaiverIds.length).toBeGreaterThan(0);
    await initializeProject(db, initial);

    let current = (await executePersistentCommand(db, initial.projectId, {
      type: "ReviseCue",
      actor: { type: "Human", id: "teacher" },
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: initial.projectRevision,
      patch: { text: "y".repeat(80) },
    })).project;
    current = (await executePersistentCommand(db, initial.projectId, {
      type: "SustainItem",
      actor: { type: "Human", id: "teacher" },
      itemId: "c01",
      expectedItemRevision: 2,
      expectedProjectRevision: current.projectRevision,
    })).project;
    current = (await executePersistentCommand(db, initial.projectId, {
      type: "ValidateProject",
      actor: { type: "System", id: "validator" },
      expectedProjectRevision: current.projectRevision,
    })).project;
    const currentWarningIds = current.validationRun?.warnings.map((warning) => warning.findingId) ?? [];
    expect(currentWarningIds.some((id) => !initialWaiverIds.includes(id))).toBe(true);
    for (const findingId of currentWarningIds) {
      current = (await executePersistentCommand(db, initial.projectId, {
        type: "WaiveWarning",
        actor: { type: "Human", id: "teacher" },
        expectedProjectRevision: current.projectRevision,
        findingId,
        reason: "The current warning was reviewed after the edit.",
      })).project;
    }
    const certified = await executePersistentCommand(db, initial.projectId, {
      type: "CertifyProject",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: current.projectRevision,
      expectedReadinessHash: prepareCertificationReview(current).readinessHash,
      certificationId: "certification-after-edit",
      certifiedAtMs: 1_700_000_000_001,
    });

    expect(certified.error).toBeUndefined();
    expect(Object.keys(certified.project.warningWaivers)).toEqual(expect.arrayContaining(initialWaiverIds));
    expect(certified.project.certifications.at(-1)?.warningWaivers.map((waiver) => waiver.findingId)).toEqual(
      [...currentWarningIds].sort(),
    );
    expect(await loadProject(db, initial.projectId)).toEqual(certified.project);
  });

  it("deduplicates source blobs by project and source hash and estimates bytes", async () => {
    const db = testDatabase();
    const bytes = new TextEncoder().encode("source-video");
    const blob = new Blob([bytes], { type: "video/mp4" });
    const expectedHash = sha256Hex(bytes);

    const [first, second] = await Promise.all([
      saveSourceMedia(db, "project-1", {
        sourceId: "media-1",
        blob,
        fileName: "lesson.mp4",
      }),
      saveSourceMedia(db, "project-1", {
        sourceId: "another-id",
        blob,
        fileName: "renamed.mp4",
      }),
    ]);
    const estimate = await estimateProjectStorage(db, "project-1");

    expect(first.key).toBe(second.key);
    expect(first.sha256).toBe(expectedHash);
    expect(await db.sourceBlobs.where("projectId").equals("project-1").count()).toBe(1);
    expect(estimate.sourceBlobBytes).toBe(blob.size);
    expect(estimate.totalBytes).toBeGreaterThanOrEqual(blob.size);
  });

  it("computes media hashes, rejects mismatched claims, and verifies source bytes at read time", async () => {
    const db = testDatabase();
    const bytes = new TextEncoder().encode("verified source bytes");
    const actualHash = sha256Hex(bytes);
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      const first = await saveSourceMedia(db, "project-1", { sourceId: "media-1", blob: new Blob([bytes]) });
      expect(digest).toHaveBeenCalledTimes(1);
      const digestCallsBeforeDuplicate = digest.mock.calls.length;
      const duplicate = await saveSourceMedia(db, "project-1", {
        sourceId: "media-alias",
        blob: new Blob([bytes]),
        sha256: actualHash.toUpperCase(),
      });
      expect(duplicate.key).toBe(first.key);
      expect(digest).toHaveBeenCalledTimes(digestCallsBeforeDuplicate + 1);
      await expect(saveSourceMedia(db, "project-1", {
        sourceId: "media-bad",
        blob: new Blob([bytes]),
        sha256: "0".repeat(64),
      })).rejects.toThrow("does not match");

      const row = await db.sourceBlobs.get(first.key);
      if (row === undefined) throw new Error("Stored source missing.");
      const digestCallsBeforeVerifiedRead = digest.mock.calls.length;
      await expect(loadSourceMedia(db, "project-1", actualHash)).resolves.toMatchObject({ key: first.key });
      expect(digest).toHaveBeenCalledTimes(digestCallsBeforeVerifiedRead + 1);
      await db.sourceBlobs.put({ ...row, byteLength: row.byteLength + 1 });
      await expect(loadSourceMedia(db, "project-1", actualHash)).rejects.toBeInstanceOf(StorageReadValidationError);
      const replacement = new Blob([new Uint8Array(row.byteLength).fill(1)], { type: row.contentType });
      await db.sourceBlobs.put({ ...row, blob: replacement, byteLength: replacement.size });
      await expect(loadSourceMedia(db, "project-1", actualHash)).rejects.toBeInstanceOf(StorageReadValidationError);
    } finally {
      digest.mockRestore();
    }
  });

  it("rejects a source blob whose stored primary key no longer binds its hash", async () => {
    const db = testDatabase();
    const bytes = new TextEncoder().encode("source key integrity");
    const saved = await saveSourceMedia(db, "project-1", { sourceId: "media-1", blob: new Blob([bytes]) });
    await db.sourceBlobs.put({ ...saved, sha256: "b".repeat(64) });

    await expect(loadSourceMedia(db, "project-1", "media-1")).rejects.toBeInstanceOf(StorageReadValidationError);
  });

  it("accepts only versioned JSON-compatible run receipts", async () => {
    const db = testDatabase();
    await saveRunReceipt(db, "project-1", "run-1", {
      version: 1,
      payload: { signedCapability: "opaque", expiresAtMs: 1_700_000_000_000 },
    });
    await expect(saveRunReceipt(db, "project-1", "run-2", {
      version: 1,
      payload: { counter: 1n },
    })).rejects.toThrow();
    const cyclic: { version: number; payload: { self?: unknown } } = { version: 1, payload: {} };
    cyclic.payload.self = cyclic;
    await expect(saveRunReceipt(db, "project-1", "run-3", cyclic)).rejects.toThrow();
  });
});
