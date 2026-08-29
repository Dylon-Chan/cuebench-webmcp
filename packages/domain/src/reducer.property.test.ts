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
});
