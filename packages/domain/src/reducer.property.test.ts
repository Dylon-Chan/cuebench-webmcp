import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyCommand, type CaptionProject, type DomainCommand } from "./index";
import { fixtureProject } from "../test/fixtures";

interface AcceptedCommandCase {
  readonly type: DomainCommand["type"];
  readonly apply: () => { readonly project: CaptionProject; readonly command: DomainCommand };
}

const acceptedTask2CommandCases: readonly AcceptedCommandCase[] = [
  {
    type: "SelectItem",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "SelectItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "FocusItem",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "FocusItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "AdjustCueTiming",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "AdjustCueTiming", actor: { type: "Human", id: "teacher" }, cueId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1, startDeltaMs: 1, endDeltaMs: 1 },
    }),
  },
  {
    type: "SplitCue",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "SplitCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", newCueId: "c05-split", splitMs: 2_000, expectedItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "MergeCue",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06", expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "ReviseCue",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1, patch: { text: "Revised caption." } },
    }),
  },
  {
    type: "AdjustAudioDescriptionTiming",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "AdjustAudioDescriptionTiming", actor: { type: "Human", id: "teacher" }, beatId: "ad01", expectedItemRevision: 1, expectedProjectRevision: 1, startDeltaMs: 1, endDeltaMs: 1 },
    }),
  },
  {
    type: "ReviseAudioDescription",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "ReviseAudioDescription", actor: { type: "Human", id: "teacher" }, beatId: "ad01", expectedItemRevision: 1, expectedProjectRevision: 1, patch: { description: "Revised description." } },
    }),
  },
  {
    type: "FocusGap",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedGapRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "ProposeAudioDescriptionInGap",
    apply: () => {
      const project = applyCommand(fixtureProject(), {
        type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedGapRevision: 1, expectedProjectRevision: 1,
      }).project;
      return {
        project,
        command: { type: "ProposeAudioDescriptionInGap", actor: { type: "BrowserAgent", id: "browser-agent" }, gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 1, beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "A graph appears.", expectedProjectRevision: 2 },
      };
    },
  },
  {
    type: "MarkItemAgentReady",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "MarkItemAgentReady", actor: { type: "BrowserAgent", id: "browser-agent" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "ObjectItem",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "ObjectItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1, reason: "Needs review." },
    }),
  },
  {
    type: "SustainItem",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "SustainItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "WaiveWarning",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "WaiveWarning", actor: { type: "Human", id: "teacher" }, findingId: "w1", reason: "Intentional pacing.", expectedProjectRevision: 1 },
    }),
  },
  {
    type: "ApplyProfile",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "ApplyProfile", actor: { type: "Human", id: "teacher" }, profileId: "profile-2", name: "Profile 2", rules: {}, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "RelinkMedia",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, media: { sourceId: "media-2", sha256: "b".repeat(64), durationMs: 60_000 }, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "AppendCourtRecord",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "AppendCourtRecord", actor: { type: "System", id: "system" }, eventType: "ValidationMigrated", itemId: "c05", deterministic: true, expectedProjectRevision: 1 },
    }),
  },
  {
    type: "StartGenerationRun",
    apply: () => ({
      project: fixtureProject(),
      command: { type: "StartGenerationRun", actor: { type: "CueBenchAI", id: "cuebench-ai" }, runId: "run-1", targetTrack: "Captions", expectedProjectRevision: 1 },
    }),
  },
  {
    type: "ReleaseGenerationRun",
    apply: () => {
      const project = applyCommand(fixtureProject(), {
        type: "StartGenerationRun", actor: { type: "CueBenchAI", id: "cuebench-ai" }, runId: "run-1", targetTrack: "Captions", expectedProjectRevision: 1,
      }).project;
      return {
        project,
        command: { type: "ReleaseGenerationRun", actor: { type: "System", id: "system" }, runId: "run-1", expectedProjectRevision: 2 },
      };
    },
  },
];

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
        const project = fixtureProject();
        const split = applyCommand(project, {
          type: "SplitCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", newCueId: "c05-split",
          splitMs, expectedItemRevision: 1, expectedProjectRevision: 1,
        });
        expect(split.error).toBeUndefined();
        expect(split.project.projectRevision).toBe(project.projectRevision + 1);
        expect(split.events).toHaveLength(1);
        expect(split.project.courtRecord).toHaveLength(project.courtRecord.length + 1);
        const merged = applyCommand(split.project, {
          type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c05-split",
          expectedItemRevision: 2, expectedAdjacentItemRevision: 1, expectedProjectRevision: 2,
        });
        expect(merged.error).toBeUndefined();
        expect(merged.project.projectRevision).toBe(split.project.projectRevision + 1);
        expect(merged.events).toHaveLength(1);
        expect(merged.project.courtRecord).toHaveLength(split.project.courtRecord.length + 1);
        expect(merged.project.captions.items["c05-split"]?.mergedIntoItemId).toBe("c05");
      }),
    );
  });

  it("never shortens a merged cue below either source end", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_001, max: 2_999 }), (containedEnd) => {
        const project = fixtureProject();
        const c06 = project.captions.items.c06!;
        const contained = {
          ...project,
          captions: { ...project.captions, items: { ...project.captions.items, c06: { ...c06, current: { ...c06.current, startMs: 1_000, endMs: containedEnd } } } },
        };
        const result = applyCommand(contained, {
          type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06",
          expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1,
        });
        expect(result.error).toBeUndefined();
        expect(result.project.captions.items.c05?.current.endMs).toBe(3_000);
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

  it("increments the project revision exactly once for accepted cue timing commands", () => {
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

  it("increments exactly once for every accepted Task 2 command discriminant", () => {
    for (const commandCase of acceptedTask2CommandCases) {
      fc.assert(
        fc.property(fc.constant(commandCase), ({ type, apply }) => {
          const { project, command } = apply();
          const result = applyCommand(project, command);
          expect(command.type).toBe(type);
          expect(result.error).toBeUndefined();
          expect(result.project.projectRevision).toBe(project.projectRevision + 1);
          expect(result.events).toHaveLength(1);
          expect(result.project.courtRecord).toHaveLength(project.courtRecord.length + 1);
          expect(result.events[0]).toEqual(result.project.courtRecord.at(-1));
        }),
        { numRuns: 10 },
      );
    }
  });
});
