import { describe, expect, it } from "vitest";
import { applyCommand } from "./index";
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
      expectedProjectRevision: 2,
    });
    expect(merged.error).toBeUndefined();
    expect(merged.project.captions.order).toEqual(["c05", "c06"]);
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
});
