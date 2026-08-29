import "fake-indexeddb/auto";

import { applyCommand, createProject } from "@cuebench/domain";
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
    expect(descriptor.project.projectRevision).toBe(3);
    expect(descriptor.project.captions.items.c05?.revisions).toHaveLength(1);
    expect(descriptor.project.captions.items.c05?.current.itemRevision).toBe(1);
    expect(descriptor.project.courtRecord).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: "event-1",
        type: "SustainItem",
        projectRevision: 3,
        actor: { type: "Human", id: "teacher" },
        itemId: "c05",
        detail: "The teacher sustained the cue after review.",
      }),
      expect.objectContaining({
        type: "LegacyItemRevisionPayloadHistoryUnavailable",
        projectRevision: 3,
        actor: { type: "System", id: "cuebench-migration" },
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
