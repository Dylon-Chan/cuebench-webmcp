import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import {
  CueBenchDatabase,
  describeImportedProject,
  importProject,
} from "./index";

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
        revision: 3,
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
          revision: 2,
          state: "Sustained",
          actor: { type: "Human", id: "teacher" },
        }],
        audioDescriptionBeats: [],
        history: [{
          id: "event-1",
          kind: "SustainItem",
          revision: 3,
          actor: { type: "Human", id: "teacher" },
          itemId: "c05",
        }],
      },
    });

    expect(descriptor.mode).toBe("read-write");
    if (descriptor.mode !== "read-write") throw new Error("expected writable descriptor");
    expect(descriptor.migratedFrom).toBe(0);
    expect(descriptor.project.contractVersion).toBe(1);
    expect(descriptor.project.media).toMatchObject({ sourceId: "media-1", relinkState: "Linked" });
    expect(descriptor.project.captions.items.c05?.current.itemRevision).toBe(2);
    expect(descriptor.project.courtRecord).toHaveLength(1);
  });

  it("describes newer imports as read-only and never writes them", async () => {
    const db = testDatabase();
    const incoming = { schemaVersion: 2, project: { projectId: "future-project" } };

    const descriptor = describeImportedProject(incoming);
    const imported = await importProject(db, incoming);

    expect(descriptor).toMatchObject({ mode: "read-only", readOnly: true, schemaVersion: 2 });
    expect(imported).toMatchObject({ mode: "read-only", readOnly: true });
    expect(await db.projectHeaders.count()).toBe(0);
  });
});
