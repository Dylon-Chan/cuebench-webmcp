import { describe, expect, it } from "vitest";
import { applyCommand, createProject, type CaptionProject, type DomainCommand } from "./index";
import { fixtureProject } from "../test/fixtures";

describe("domain reducer", () => {
  it("editing a Sustained cue creates a Proposed revision without erasing history", () => {
    const project = fixtureProject({
      cueState: "Sustained",
      itemRevision: 3,
      projectRevision: 9,
    });
    const result = applyCommand(project, {
      type: "ReviseCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c05",
      expectedItemRevision: 3,
      expectedProjectRevision: 9,
      patch: { text: "Dr. Nguyen explains Gibbs free energy." },
    });
    expect(result.project.captions.items.c05?.revisions).toHaveLength(4);
    expect(result.project.captions.items.c05?.current.state).toBe("Proposed");
    expect(result.events[0]?.actor.type).toBe("BrowserAgent");
  });

  it("rejects a Browser Agent ruling without changing the project", () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const result = applyCommand(project, {
      type: "SustainItem",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(result.error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("requires a scoped selection when supplied and keeps failures byte-identical", () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const result = applyCommand(project, {
      type: "AdjustCueTiming",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c05",
      expectedSelectionId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
      startDeltaMs: 100,
      endDeltaMs: 100,
    });
    expect(result.error?.code).toBe("STALE_SELECTION");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("focuses an item atomically and increments the project revision once", () => {
    const result = applyCommand(fixtureProject(), {
      type: "FocusItem",
      actor: { type: "Human", id: "teacher" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(result.project.projectRevision).toBe(2);
    expect(result.project.selectedItem).toMatchObject({ itemId: "c05", itemRevision: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.project.courtRecord).toHaveLength(1);
  });

  it("allows only the authoring Browser Agent to attest a current Proposed revision", () => {
    const project = fixtureProject();
    const accepted = applyCommand(project, {
      type: "MarkItemAgentReady",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(accepted.project.captions.items.c05?.current.state).toBe("AgentReady");
    expect(accepted.project.captions.items.c05?.revisions).toHaveLength(2);

    const rejected = applyCommand(project, {
      type: "MarkItemAgentReady",
      actor: { type: "BrowserAgent", id: "another-agent" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(rejected.error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
  });

  it("rejects invalid, non-adjacent merges and preserves all stable items", () => {
    const project = fixtureProject();
    const result = applyCommand(project, {
      type: "MergeCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c05",
      cueId: "c05",
      adjacentCueId: "missing",
      expectedItemRevision: 1,
      expectedAdjacentItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
    expect(Object.keys(result.project.captions.items)).toEqual(["c05", "c06"]);
  });

  it("leases only the target track and blocks profile changes while a run is active", () => {
    const run = applyCommand(fixtureProject(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-1",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const caption = applyCommand(run, {
      type: "ReviseCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c05",
      cueId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
      patch: { text: "Changed" },
    });
    expect(caption.error?.code).toBe("TARGET_TRACK_LEASE_CONFLICT");
    const ad = applyCommand(run, {
      type: "ReviseAudioDescription",
      actor: { type: "Human", id: "teacher" },
      itemId: "ad01",
      beatId: "ad01",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
      patch: { description: "An energy curve appears." },
    });
    expect(ad.error).toBeUndefined();
    const profile = applyCommand(run, {
      type: "ApplyProfile",
      actor: { type: "Human", id: "teacher" },
      profileId: "education-quality",
      name: "Education Quality Profile",
      rules: {},
      expectedProjectRevision: 2,
    });
    expect(profile.error?.code).toBe("TARGET_TRACK_LEASE_CONFLICT");
  });

  it("stales validation and certification after semantic timing changes without losing historic certification", () => {
    const project = {
      ...fixtureProject(),
      validation: { status: "Current" as const, blockerCount: 0, warningCount: 1 },
      certification: { status: "Current" as const, certificationId: "cert-1" },
    };
    const result = applyCommand(project, {
      type: "AdjustCueTiming",
      actor: { type: "Human", id: "teacher" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
      startDeltaMs: 50,
      endDeltaMs: 50,
    });
    expect(result.project.validation.status).toBe("Stale");
    expect(result.project.certification).toEqual({ status: "Stale", certificationId: "cert-1" });
  });

  it("splits a cue into stable identities and only merges adjacent successor cues", () => {
    const split = applyCommand(fixtureProject(), {
      type: "SplitCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c05",
      splitMs: 2_000,
      newCueId: "c05b",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    });
    expect(split.error).toBeUndefined();
    expect(split.project.captions.order).toEqual(["c05", "c05b", "c06"]);
    const merged = applyCommand(split.project, {
      type: "MergeCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c05",
      adjacentCueId: "c05b",
      expectedItemRevision: 2,
      expectedAdjacentItemRevision: 1,
      expectedProjectRevision: 2,
    });
    expect(merged.error).toBeUndefined();
    expect(merged.project.captions.order).toEqual(["c05", "c06"]);
    expect(merged.project.captions.items.c05b).toMatchObject({ mergedIntoItemId: "c05" });
    expect(merged.project.captions.items.c05b?.revisions).toHaveLength(2);
  });

  it("limits rulings, warning waivers, and media relinks to humans", () => {
    const actor = { type: "BrowserAgent" as const, id: "browser-agent" };
    const project = fixtureProject();
    expect(applyCommand(project, {
      type: "ObjectItem", actor, itemId: "c05", expectedItemRevision: 1,
      expectedProjectRevision: 1, reason: "Incorrect name",
    }).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
    expect(applyCommand(project, {
      type: "WaiveWarning", actor, findingId: "warning-1", reason: "Intentional pacing",
      expectedProjectRevision: 1,
    }).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
    expect(applyCommand(project, {
      type: "RelinkMedia", actor, expectedProjectRevision: 1,
      media: { sourceId: "media-2", sha256: "b".repeat(64), durationMs: 60_000 },
    }).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
  });

  it("proposes a gap beat and records deterministic Court Record events", () => {
    const proposal = applyCommand(fixtureProject(), {
      type: "ProposeAudioDescriptionInGap",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      gapId: "gap-1",
      beatId: "ad02",
      startMs: 9_000,
      endMs: 11_000,
      description: "A graph label highlights delta G.",
      expectedProjectRevision: 1,
    });
    expect(proposal.project.audioDescriptions.items.ad02?.current.state).toBe("Proposed");
    const record = applyCommand(proposal.project, {
      type: "AppendCourtRecord",
      actor: { type: "System", id: "system" },
      eventType: "ValidationMigrated",
      detail: "Schema version 1",
      deterministic: true,
      expectedProjectRevision: 2,
    });
    expect(record.events[0]).toMatchObject({ type: "ValidationMigrated", detail: "Schema version 1" });
  });

  it("stale-guards both merge revisions and preserves the rejected project byte-for-byte", () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const result = applyCommand(project, {
      type: "MergeCue",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      cueId: "c05",
      adjacentCueId: "c06",
      expectedItemRevision: 1,
      expectedAdjacentItemRevision: 2,
      expectedProjectRevision: 1,
    });
    expect(result.error?.code).toBe("STALE_ITEM");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("leases review-state mutations on the target track", () => {
    const leased = applyCommand(fixtureProject(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-1",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    for (const command of [
      { type: "MarkItemAgentReady" as const, actor: { type: "BrowserAgent" as const, id: "browser-agent" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2 },
      { type: "SustainItem" as const, actor: { type: "Human" as const, id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2 },
    ]) {
      expect(applyCommand(leased, command).error?.code).toBe("TARGET_TRACK_LEASE_CONFLICT");
    }
  });

  it("checks selected item id, kind, and revision, then refreshes selection for review revisions", () => {
    const focused = applyCommand(fixtureProject(), {
      type: "FocusItem", actor: { type: "Human", id: "teacher" }, itemId: "c05",
      expectedItemRevision: 1, expectedProjectRevision: 1,
    }).project;
    const sustained = applyCommand(focused, {
      type: "SustainItem", actor: { type: "Human", id: "teacher" }, itemId: "c05",
      expectedSelectionId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2,
    });
    expect(sustained.project.selectedItem).toMatchObject({ itemId: "c05", kind: "CaptionCue", itemRevision: 2 });
    const staleSelection: CaptionProject = {
      ...sustained.project,
      selectedItem: { itemId: "c05", kind: "CaptionCue", itemRevision: 1 },
    };
    const stale = applyCommand(staleSelection, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedSelectionId: "c05", expectedItemRevision: 2, expectedProjectRevision: 3,
      patch: { text: "Current selection is stale." },
    });
    expect(stale.error?.code).toBe("STALE_SELECTION");

    const wrongKind: CaptionProject = { ...focused, selectedItem: { itemId: "c05", itemRevision: 1, kind: "AudioDescriptionBeat" } };
    expect(applyCommand(wrongKind, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedSelectionId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2,
      patch: { text: "Wrong selection kind." },
    }).error?.code).toBe("STALE_SELECTION");
  });

  it("uses selected gap identity, revision, and availability when a scoped gap proposal is supplied", () => {
    const gap = applyCommand(fixtureProject(), {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1",
      gapRevision: 4, expectedProjectRevision: 1,
    }).project;
    const result = applyCommand(gap, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "BrowserAgent", id: "browser-agent" },
      gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 4,
      beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "A graph appears.",
      expectedProjectRevision: 2,
    });
    expect(result.error).toBeUndefined();
    expect(applyCommand(gap, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "BrowserAgent", id: "browser-agent" },
      gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 3,
      beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "A graph appears.",
      expectedProjectRevision: 2,
    }).error?.code).toBe("STALE_SELECTION");
  });

  it("rejects conflicting aliases, short media relinks, and non-system Court Record authority", () => {
    const project = fixtureProject();
    expect(applyCommand(project, {
      type: "AdjustCueTiming", actor: { type: "Human", id: "teacher" }, itemId: "c05", cueId: "c06",
      expectedItemRevision: 1, expectedProjectRevision: 1, startDeltaMs: 1, endDeltaMs: 1,
    }).error?.code).toBe("INVALID_ARGUMENT");
    expect(applyCommand(project, {
      type: "ReviseAudioDescription", actor: { type: "Human", id: "teacher" }, itemId: "ad01",
      expectedItemRevision: 1, expectedProjectRevision: 1, patch: { description: "Updated." },
    }).error).toBeUndefined();
    expect(applyCommand(project, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, expectedProjectRevision: 1,
      media: { sourceId: "media-2", sha256: "b".repeat(64), durationMs: 2_000 },
    }).error?.code).toBe("INVALID_ARGUMENT");
    const forbidden: DomainCommand = {
      type: "AppendCourtRecord", actor: { type: "CueBenchAI", id: "cuebench-ai" },
      eventType: "ValidationMigrated", deterministic: true, expectedProjectRevision: 1,
    };
    expect(applyCommand(project, forbidden).error?.code).toBe("INVALID_ARGUMENT");
    const forged = {
      type: "AppendCourtRecord", actor: { type: "System", id: "system" },
      eventType: "SustainItem", deterministic: true, expectedProjectRevision: 1,
    } as unknown as DomainCommand;
    expect(applyCommand(project, forged).error?.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects invalid initial timings and nonchronological merges", () => {
    expect(() => createProject({
      projectId: "bad", title: "Bad timing", media: { sourceId: "m", sha256: "c".repeat(64), durationMs: 1_000, relinkState: "Linked" },
      captions: [{ kind: "CaptionCue", itemId: "c1", state: "Proposed", startMs: 100, endMs: 1_001, text: "Bad", speaker: null, actor: { type: "Human", id: "teacher" }, cause: "test" }],
    })).toThrow(RangeError);
    const project = fixtureProject();
    const c06 = project.captions.items.c06!;
    const nonchronological: CaptionProject = {
      ...project,
      captions: { ...project.captions, items: { ...project.captions.items, c06: { ...c06, current: { ...c06.current, startMs: 0, endMs: 900 } } } },
    };
    expect(applyCommand(nonchronological, {
      type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06",
      expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1,
    }).error?.code).toBe("INVALID_ARGUMENT");
  });
});
