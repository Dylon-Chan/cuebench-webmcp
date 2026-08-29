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
    const project = applyCommand(fixtureProject(), {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1",
      expectedGapRevision: 1, expectedProjectRevision: 1,
    }).project;
    const proposal = applyCommand(project, {
      type: "ProposeAudioDescriptionInGap",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      gapId: "gap-1",
      expectedSelectionId: "gap-1",
      expectedGapRevision: 1,
      beatId: "ad02",
      startMs: 9_000,
      endMs: 11_000,
      description: "A graph label highlights delta G.",
      expectedProjectRevision: 2,
    });
    expect(proposal.project.audioDescriptions.items.ad02?.current.state).toBe("Proposed");
    const record = applyCommand(proposal.project, {
      type: "AppendCourtRecord",
      actor: { type: "System", id: "system" },
      eventType: "ValidationMigrated",
      deterministic: true,
      expectedProjectRevision: 3,
    });
    expect(record.events[0]).toMatchObject({ type: "ValidationMigrated", actor: { type: "System", id: "system" } });
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

  it("binds a scoped selection to its mutation target rather than another same-kind item", () => {
    const focused = applyCommand(fixtureProject(), {
      type: "FocusItem", actor: { type: "Human", id: "teacher" }, itemId: "c05",
      expectedItemRevision: 1, expectedProjectRevision: 1,
    }).project;
    const before = JSON.stringify(focused);
    const result = applyCommand(focused, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c06",
      expectedSelectionId: "c05", expectedItemRevision: 1, expectedProjectRevision: 2,
      patch: { text: "This must not edit c06." },
    });
    expect(result.error?.code).toBe("STALE_SELECTION");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("uses selected gap identity, revision, and availability when a scoped gap proposal is supplied", () => {
    const gap = applyCommand(fixtureProject(), {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1",
      expectedGapRevision: 1, expectedProjectRevision: 1,
    }).project;
    const result = applyCommand(gap, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "BrowserAgent", id: "browser-agent" },
      gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 1,
      beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "A graph appears.",
      expectedProjectRevision: 2,
    });
    expect(result.error).toBeUndefined();
    expect(applyCommand(gap, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "BrowserAgent", id: "browser-agent" },
      gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 2,
      beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "A graph appears.",
      expectedProjectRevision: 2,
    }).error?.code).toBe("STALE_SELECTION");
    expect(applyCommand(result.project, {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1",
      expectedGapRevision: 2, expectedProjectRevision: 3,
    }).error?.code).toBe("STALE_SELECTION");
  });

  it("requires a known focused available gap for every gap proposal", () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const result = applyCommand(project, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "Human", id: "teacher" },
      gapId: "invented-gap", expectedSelectionId: "invented-gap", expectedGapRevision: 1,
      beatId: "ad02", startMs: 9_000, endMs: 11_000, description: "No invented gaps.",
      expectedProjectRevision: 1,
    });
    expect(result.error?.code).toBe("STALE_SELECTION");
    expect(JSON.stringify(result.project)).toBe(before);
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

  it("rejects invalid source cue intervals before merge without mutating the project", () => {
    const project = fixtureProject();
    const left = project.captions.items.c05!;
    const right = project.captions.items.c06!;
    const invalidLeft: CaptionProject = {
      ...project,
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c05: { ...left, current: { ...left.current, endMs: left.current.startMs } },
        },
      },
    };
    const invalidRight: CaptionProject = {
      ...project,
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          c06: { ...right, current: { ...right.current, startMs: 4_000, endMs: 3_500 } },
        },
      },
    };
    const invalidLeftBefore = JSON.stringify(invalidLeft);
    const before = JSON.stringify(invalidRight);
    const leftResult = applyCommand(invalidLeft, {
      type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06",
      expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1,
    });
    const result = applyCommand(invalidRight, {
      type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06",
      expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1,
    });
    expect(leftResult.error?.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(leftResult.project)).toBe(invalidLeftBefore);
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("merges to an interval containing both source cues when the right cue ends inside the left", () => {
    const project = fixtureProject();
    const c06 = project.captions.items.c06!;
    const contained: CaptionProject = {
      ...project,
      captions: { ...project.captions, items: { ...project.captions.items, c06: { ...c06, current: { ...c06.current, startMs: 1_500, endMs: 2_500 } } } },
    };
    const result = applyCommand(contained, {
      type: "MergeCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", adjacentCueId: "c06",
      expectedItemRevision: 1, expectedAdjacentItemRevision: 1, expectedProjectRevision: 1,
    });
    expect(result.error).toBeUndefined();
    expect(result.project.captions.items.c05?.current).toMatchObject({ startMs: 1_000, endMs: 3_000 });
  });

  it("does not store forged semantic payloads on deterministic System events", () => {
    const forged = {
      type: "AppendCourtRecord", actor: { type: "System", id: "system" }, eventType: "ValidationMigrated",
      deterministic: true, expectedProjectRevision: 1,
      detail: "Human sustained every cue", payload: { certificationId: "forged", ruling: "Sustained" },
    } as unknown as DomainCommand;
    const result = applyCommand(fixtureProject(), forged);
    expect(result.error).toBeUndefined();
    expect(result.events[0]).toMatchObject({ type: "ValidationMigrated" });
    expect("detail" in (result.events[0] ?? {})).toBe(false);
    expect("payload" in (result.events[0] ?? {})).toBe(false);
  });

  it("rejects unknown Court Record item references without mutating the project", () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const unknown = applyCommand(project, {
      type: "AppendCourtRecord", actor: { type: "System", id: "system" }, eventType: "ValidationMigrated",
      itemId: "missing", deterministic: true, expectedProjectRevision: 1,
    });
    expect(unknown.error?.code).toBe("NOT_FOUND");
    expect(JSON.stringify(unknown.project)).toBe(before);

    const known = applyCommand(project, {
      type: "AppendCourtRecord", actor: { type: "System", id: "system" }, eventType: "ValidationMigrated",
      itemId: "c05", deterministic: true, expectedProjectRevision: 1,
    });
    expect(known.error).toBeUndefined();
    expect(known.events[0]?.itemId).toBe("c05");
  });

  it("clones split actor identity before storing the successor revision", () => {
    const actor = { type: "BrowserAgent" as const, id: "browser-agent" };
    const result = applyCommand(fixtureProject(), {
      type: "SplitCue", actor, cueId: "c05", newCueId: "c05b", splitMs: 2_000,
      expectedItemRevision: 1, expectedProjectRevision: 1,
    });
    actor.id = "mutated-agent";
    expect(result.project.captions.items.c05b?.current.actor.id).toBe("browser-agent");
    expect(result.project.captions.items.c05b?.revisions[0]?.actor.id).toBe("browser-agent");
  });

  it("rejects media relinks that would place consumed historical gaps out of bounds", () => {
    const project = fixtureProject();
    const historical: CaptionProject = {
      ...project,
      audioDescriptionGaps: { ...project.audioDescriptionGaps, "gap-1": { ...project.audioDescriptionGaps["gap-1"]!, state: "Consumed", startMs: 12_000, endMs: 13_000 } },
    };
    const result = applyCommand(historical, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, expectedProjectRevision: 1,
      media: { sourceId: "short", sha256: "b".repeat(64), durationMs: 10_000 },
    });
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects media relinks when an old cue revision is out of bounds without mutating state", () => {
    const fixture = fixtureProject();
    const project: CaptionProject = {
      ...fixture,
      audioDescriptionGaps: {
        ...fixture.audioDescriptionGaps,
        "gap-1": { ...fixture.audioDescriptionGaps["gap-1"]!, endMs: 10_000 },
      },
    };
    const longRevision = applyCommand(project, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedItemRevision: 1, expectedProjectRevision: 1, patch: { endMs: 12_000 },
    });
    const currentRevision = applyCommand(longRevision.project, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedItemRevision: 2, expectedProjectRevision: 2, patch: { endMs: 3_000 },
    });
    const before = JSON.stringify(currentRevision.project);
    const result = applyCommand(currentRevision.project, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, expectedProjectRevision: 3,
      media: { sourceId: "short", sha256: "b".repeat(64), durationMs: 10_000 },
    });

    expect(result.error).toMatchObject({ code: "INVALID_ARGUMENT", message: "Media duration must contain every stored item revision and gap." });
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("rejects media relinks when an old AD revision is out of bounds without mutating state", () => {
    const fixture = fixtureProject();
    const project: CaptionProject = {
      ...fixture,
      audioDescriptionGaps: {
        ...fixture.audioDescriptionGaps,
        "gap-1": { ...fixture.audioDescriptionGaps["gap-1"]!, endMs: 10_000 },
      },
    };
    const longRevision = applyCommand(project, {
      type: "ReviseAudioDescription", actor: { type: "Human", id: "teacher" }, beatId: "ad01",
      expectedItemRevision: 1, expectedProjectRevision: 1, patch: { endMs: 12_000 },
    });
    const currentRevision = applyCommand(longRevision.project, {
      type: "ReviseAudioDescription", actor: { type: "Human", id: "teacher" }, beatId: "ad01",
      expectedItemRevision: 2, expectedProjectRevision: 2, patch: { endMs: 8_000 },
    });
    const before = JSON.stringify(currentRevision.project);
    const result = applyCommand(currentRevision.project, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, expectedProjectRevision: 3,
      media: { sourceId: "short", sha256: "b".repeat(64), durationMs: 10_000 },
    });

    expect(result.error).toMatchObject({ code: "INVALID_ARGUMENT", message: "Media duration must contain every stored item revision and gap." });
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("allows media relinks at the exact boundary for current and historical item revisions and gaps", () => {
    const fixture = fixtureProject();
    const project: CaptionProject = {
      ...fixture,
      audioDescriptionGaps: {
        ...fixture.audioDescriptionGaps,
        "gap-1": { ...fixture.audioDescriptionGaps["gap-1"]!, endMs: 10_000 },
      },
    };
    const longCueRevision = applyCommand(project, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedItemRevision: 1, expectedProjectRevision: 1, patch: { endMs: 10_000 },
    });
    const currentCueRevision = applyCommand(longCueRevision.project, {
      type: "ReviseCue", actor: { type: "Human", id: "teacher" }, cueId: "c05",
      expectedItemRevision: 2, expectedProjectRevision: 2, patch: { endMs: 3_000 },
    });
    const currentAdRevision = applyCommand(currentCueRevision.project, {
      type: "ReviseAudioDescription", actor: { type: "Human", id: "teacher" }, beatId: "ad01",
      expectedItemRevision: 1, expectedProjectRevision: 3, patch: { endMs: 10_000 },
    });
    const result = applyCommand(currentAdRevision.project, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, expectedProjectRevision: 4,
      media: { sourceId: "boundary", sha256: "b".repeat(64), durationMs: 10_000 },
    });

    expect(result.error).toBeUndefined();
    expect(result.project.media.durationMs).toBe(10_000);
  });

  it("requires proposed AD timing to fit inside the selected gap without consuming it on rejection", () => {
    const focused = applyCommand(fixtureProject(), {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedGapRevision: 1, expectedProjectRevision: 1,
    }).project;
    const before = JSON.stringify(focused);
    const result = applyCommand(focused, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 1,
      beatId: "ad02", startMs: 8_000, endMs: 10_000, description: "Too early for this gap.", expectedProjectRevision: 2,
    });
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
    expect(result.project.audioDescriptionGaps["gap-1"]?.state).toBe("Available");
    expect(JSON.stringify(result.project)).toBe(before);
  });

  it("enforces initial actor/state authority and global IDs for split and AD additions", () => {
    expect(() => createProject({
      projectId: "bad-actor", title: "Bad actor", media: { sourceId: "m", sha256: "c".repeat(64), durationMs: 1_000, relinkState: "Linked" },
      captions: [{ kind: "CaptionCue", itemId: "c1", state: "Sustained", startMs: 0, endMs: 500, text: "Bad", speaker: null, actor: { type: "BrowserAgent", id: "agent" }, cause: "test" }],
    })).toThrow(RangeError);
    expect(() => createProject({
      projectId: "duplicate", title: "Duplicate", media: { sourceId: "m", sha256: "c".repeat(64), durationMs: 1_000, relinkState: "Linked" },
      captions: [{ kind: "CaptionCue", itemId: "same", state: "Proposed", startMs: 0, endMs: 500, text: "One", speaker: null, actor: { type: "Human", id: "teacher" }, cause: "test" }],
      audioDescriptions: [{ kind: "AudioDescriptionBeat", itemId: "same", state: "Proposed", startMs: 500, endMs: 900, description: "Two", actor: { type: "Human", id: "teacher" }, cause: "test" }],
    })).toThrow(RangeError);
    const project = fixtureProject();
    expect(applyCommand(project, {
      type: "SplitCue", actor: { type: "Human", id: "teacher" }, cueId: "c05", newCueId: "ad01", splitMs: 2_000,
      expectedItemRevision: 1, expectedProjectRevision: 1,
    }).error?.code).toBe("INVALID_ARGUMENT");
    const focused = applyCommand(project, {
      type: "FocusGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedGapRevision: 1, expectedProjectRevision: 1,
    }).project;
    expect(applyCommand(focused, {
      type: "ProposeAudioDescriptionInGap", actor: { type: "Human", id: "teacher" }, gapId: "gap-1", expectedSelectionId: "gap-1", expectedGapRevision: 1,
      beatId: "c05", startMs: 9_000, endMs: 11_000, description: "Duplicate item id.", expectedProjectRevision: 2,
    }).error?.code).toBe("INVALID_ARGUMENT");
  });

  it("deep-clones caller-owned media, profile rules, actors, and Court Record payloads", () => {
    const media = { sourceId: "media-1", sha256: "a".repeat(64), durationMs: 60_000, relinkState: "Linked" as const };
    const rules: Record<string, unknown> = { nested: { maxLines: 2 } };
    const actor = { type: "Human" as const, id: "teacher" };
    const project = createProject({
      projectId: "clone", title: "Clone", media, profile: { profileId: "p", name: "P", rules },
      captions: [{ kind: "CaptionCue", itemId: "c1", state: "Proposed", startMs: 0, endMs: 1_000, text: "Text", speaker: null, actor, cause: "test" }],
    });
    (media as { durationMs: number }).durationMs = 1;
    ((rules.nested as { maxLines: number }).maxLines) = 99;
    actor.id = "mutated";
    expect(project.media.durationMs).toBe(60_000);
    expect((project.qualityProfile.rules.nested as { maxLines: number }).maxLines).toBe(2);
    expect(project.captions.items.c1?.current.actor.id).toBe("teacher");
    const recordActor = { type: "System" as const, id: "system" };
    const recorded = applyCommand(project, {
      type: "AppendCourtRecord", actor: recordActor, eventType: "ValidationMigrated", deterministic: true, expectedProjectRevision: 1,
    });
    recordActor.id = "mutated-system";
    expect(recorded.events[0]?.actor.id).toBe("system");

    const revisedActor = { type: "BrowserAgent" as const, id: "browser-agent" };
    const revised = applyCommand(project, {
      type: "ReviseCue", actor: revisedActor, cueId: "c1", expectedItemRevision: 1, expectedProjectRevision: 1,
      patch: { text: "Revision clone." },
    });
    revisedActor.id = "changed-agent";
    expect(revised.project.captions.items.c1?.current.actor.id).toBe("browser-agent");

    const profileRules: Record<string, unknown> = { nested: { maxLines: 3 } };
    const profiled = applyCommand(project, {
      type: "ApplyProfile", actor: { type: "Human", id: "teacher" }, profileId: "p2", name: "P2", rules: profileRules, expectedProjectRevision: 1,
    });
    ((profileRules.nested as { maxLines: number }).maxLines) = 99;
    expect((profiled.project.qualityProfile.rules.nested as { maxLines: number }).maxLines).toBe(3);

    const replacement = { sourceId: "replacement", sha256: "b".repeat(64), durationMs: 60_000 };
    const relinked = applyCommand(project, {
      type: "RelinkMedia", actor: { type: "Human", id: "teacher" }, media: replacement, expectedProjectRevision: 1,
    });
    replacement.durationMs = 1;
    expect(relinked.project.media.durationMs).toBe(60_000);
  });

  it("stales validation and certification for all review states and waivers", () => {
    const certified = { ...fixtureProject(), validation: { status: "Current" as const, blockerCount: 0, warningCount: 1 }, certification: { status: "Current" as const, certificationId: "cert-1" } };
    const mark = applyCommand(certified, { type: "MarkItemAgentReady", actor: { type: "BrowserAgent", id: "browser-agent" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 });
    expect(mark.project.validation.status).toBe("Stale");
    const objected = applyCommand(certified, { type: "ObjectItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1, reason: "Reason" });
    expect(objected.project.certification.status).toBe("Stale");
    const sustained = applyCommand(certified, { type: "SustainItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: 1 });
    expect(sustained.project.validation.status).toBe("Stale");
    const waived = applyCommand(certified, { type: "WaiveWarning", actor: { type: "Human", id: "teacher" }, findingId: "w1", reason: "Reason", expectedProjectRevision: 1 });
    expect(waived.project.certification.status).toBe("Stale");
  });

  it("preserves current validation but stales current certification for a warning waiver", () => {
    const project: CaptionProject = {
      ...fixtureProject(),
      validation: { status: "Current", blockerCount: 0, warningCount: 1 },
      certification: { status: "Current", certificationId: "cert-1" },
    };
    const result = applyCommand(project, {
      type: "WaiveWarning", actor: { type: "Human", id: "teacher" }, findingId: "w1", reason: "Intentional pacing",
      expectedProjectRevision: 1,
    });
    expect(result.error).toBeUndefined();
    expect(result.project.validation.status).toBe("Current");
    expect(result.project.validation).toEqual(project.validation);
    expect(result.project.certification).toEqual({ status: "Stale", certificationId: "cert-1" });
  });
});
