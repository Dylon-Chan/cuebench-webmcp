import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyCommand } from "./index";
import { fixtureProject } from "../test/fixtures";

describe("domain reducer properties", () => {
  it("preserves canonical timing bounds for accepted timing commands", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59_998 }),
        fc.integer({ min: 1, max: 60_000 }),
        (first, second) => {
          const startMs = Math.min(first, second - 1);
          const endMs = Math.max(first + 1, second);
          fc.pre(startMs < endMs && endMs <= 60_000);
          const result = applyCommand(fixtureProject(), {
            type: "AdjustCueTiming",
            actor: { type: "Human", id: "teacher" },
            itemId: "c05",
            expectedItemRevision: 1,
            expectedProjectRevision: 1,
            startMs,
            endMs,
          });
          if (result.error === undefined) {
            const cue = result.project.captions.items.c05?.current;
            expect(cue).toBeDefined();
            expect(cue?.startMs).toBeGreaterThanOrEqual(0);
            expect(cue?.startMs).toBeLessThan(cue?.endMs ?? 0);
            expect(cue?.endMs).toBeLessThanOrEqual(result.project.media.durationMs);
          }
        },
      ),
    );
  });

  it("preserves canonical timing bounds for accepted AD timing commands", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59_998 }),
        fc.integer({ min: 1, max: 60_000 }),
        (first, second) => {
          const startMs = Math.min(first, second - 1);
          const endMs = Math.max(first + 1, second);
          fc.pre(startMs < endMs && endMs <= 60_000);
          const result = applyCommand(fixtureProject(), {
            type: "AdjustAudioDescriptionTiming",
            actor: { type: "Human", id: "teacher" }, beatId: "ad01",
            expectedItemRevision: 1, expectedProjectRevision: 1, startMs, endMs,
          });
          if (result.error === undefined) {
            const beat = result.project.audioDescriptions.items.ad01?.current;
            expect(beat?.startMs).toBeGreaterThanOrEqual(0);
            expect(beat?.startMs).toBeLessThan(beat?.endMs ?? 0);
            expect(beat?.endMs).toBeLessThanOrEqual(result.project.media.durationMs);
          }
        },
      ),
    );
  });

  it("never changes serialized state for stale expected revisions", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), (staleRevision) => {
        const project = fixtureProject();
        const before = JSON.stringify(project);
        const result = applyCommand(project, {
          type: "ReviseCue",
          actor: { type: "BrowserAgent", id: "browser-agent" },
          itemId: "c05",
          cueId: "c05",
          expectedItemRevision: 1,
          expectedProjectRevision: staleRevision,
          patch: { text: "Stale change" },
        });
        expect(result.error?.code).toBe("STALE_PROJECT");
        expect(JSON.stringify(result.project)).toBe(before);
      }),
    );
  });

  it("never changes serialized state for stale item and scoped selection revisions", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), (staleRevision) => {
        const focused = applyCommand(fixtureProject(), {
          type: "FocusItem", actor: { type: "Human", id: "teacher" }, itemId: "c05",
          expectedItemRevision: 1, expectedProjectRevision: 1,
        }).project;
        const before = JSON.stringify(focused);
        const staleItem = applyCommand(focused, {
          type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
          expectedSelectionId: "c05", expectedItemRevision: staleRevision, expectedProjectRevision: 2,
          patch: { text: "Stale item." },
        });
        expect(staleItem.error?.code).toBe("STALE_ITEM");
        expect(JSON.stringify(staleItem.project)).toBe(before);
        const staleSelection = applyCommand(focused, {
          type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c06",
          expectedSelectionId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2,
          patch: { text: "Stale selection." },
        });
        expect(staleSelection.error?.code).toBe("STALE_SELECTION");
        expect(JSON.stringify(staleSelection.project)).toBe(before);
      }),
    );
  });

  it("accepts valid split/merge pairs and preserves both identities", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_001, max: 2_999 }), (splitMs) => {
        const split = applyCommand(fixtureProject(), {
          type: "SplitCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", newCueId: "c05-split",
          splitMs, expectedItemRevision: 1, expectedProjectRevision: 1,
        });
        expect(split.error).toBeUndefined();
        const merged = applyCommand(split.project, {
          type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c05-split",
          expectedItemRevision: 2, expectedAdjacentItemRevision: 1, expectedProjectRevision: 2,
        });
        expect(merged.error).toBeUndefined();
        expect(merged.project.captions.items["c05-split"]?.mergedIntoItemId).toBe("c05");
      }),
    );
  });

  it("rejects authority and target-lease violations without state changes", () => {
    fc.assert(
      fc.property(fc.constantFrom("Captions" as const, "AudioDescriptions" as const), (targetTrack) => {
        const project = fixtureProject();
        const before = JSON.stringify(project);
        const ruling = applyCommand(project, {
          type: "SustainItem", actor: { type: "BrowserAgent", id: "browser-agent" }, itemId: "c05",
          expectedItemRevision: 1, expectedProjectRevision: 1,
        });
        expect(ruling.error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
        expect(JSON.stringify(ruling.project)).toBe(before);
        const leased = applyCommand(project, {
          type: "StartGenerationRun", actor: { type: "CueBenchAI", id: "cuebench-ai" }, runId: "run", targetTrack,
          expectedProjectRevision: 1,
        }).project;
        const itemId = targetTrack === "Captions" ? "c05" : "ad01";
        const mutation = applyCommand(leased, {
          type: "MarkItemAgentReady", actor: { type: "BrowserAgent", id: "browser-agent" }, itemId,
          expectedItemRevision: 1, expectedProjectRevision: 2,
        });
        expect(mutation.error?.code).toBe("TARGET_TRACK_LEASE_CONFLICT");
      }),
    );
  });

  it("increments the project revision exactly once for every accepted command", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (delta) => {
        const project = fixtureProject();
        const result = applyCommand(project, {
          type: "AdjustCueTiming",
          actor: { type: "Human", id: "teacher" },
          itemId: "c05",
          expectedItemRevision: 1,
          expectedProjectRevision: 1,
          startDeltaMs: delta,
          endDeltaMs: delta,
        });
        expect(result.error).toBeUndefined();
        expect(result.project.projectRevision).toBe(project.projectRevision + 1);
        expect(result.events).toHaveLength(1);
        expect(result.project.courtRecord).toHaveLength(project.courtRecord.length + 1);
      }),
    );
  });

  it("increments exactly once across several accepted command variants", () => {
    fc.assert(
      fc.property(fc.constantFrom("focus", "ad", "waive", "record"), (variant) => {
        const project = fixtureProject();
        const command = variant === "focus"
          ? { type: "FocusItem" as const, actor: { type: "Human" as const, id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 }
          : variant === "ad"
            ? { type: "AdjustAudioDescriptionTiming" as const, actor: { type: "Human" as const, id: "teacher" }, beatId: "ad01", expectedItemRevision: 1, expectedProjectRevision: 1, startDeltaMs: 1, endDeltaMs: 1 }
            : variant === "waive"
              ? { type: "WaiveWarning" as const, actor: { type: "Human" as const, id: "teacher" }, findingId: "w1", reason: "Reason", expectedProjectRevision: 1 }
              : { type: "AppendCourtRecord" as const, actor: { type: "System" as const, id: "system" }, eventType: "ValidationMigrated" as const, deterministic: true, expectedProjectRevision: 1 };
        const result = applyCommand(project, command);
        expect(result.error).toBeUndefined();
        expect(result.project.projectRevision).toBe(2);
        expect(result.events).toHaveLength(1);
      }),
    );
  });
});
