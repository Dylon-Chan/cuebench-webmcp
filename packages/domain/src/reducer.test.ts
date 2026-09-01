import { describe, expect, it } from "vitest";
import type { LocalCaptionEvidencePackage, StagedGenerationResult } from "@cuebench/contracts";
import { applyCommand, createProject, prepareTrackExport, validateProject, type CaptionProject, type DomainCommand } from "./index";
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

  it("requires the explicit visible-confirmation marker for a BrowserAgent merge when either source cue is Sustained", () => {
    const sustained = applyCommand(fixtureProject(), {
      type: "SustainItem",
      actor: { type: "Human", id: "teacher" },
      itemId: "c05",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    }).project;
    const command = {
      type: "MergeCue" as const,
      actor: { type: "BrowserAgent" as const, id: "browser-agent" },
      itemId: "c05",
      cueId: "c05",
      adjacentCueId: "c06",
      expectedItemRevision: 2,
      expectedAdjacentItemRevision: 1,
      expectedProjectRevision: sustained.projectRevision,
    };
    const before = JSON.stringify(sustained);
    expect(applyCommand(sustained, command).error?.code).toBe("HUMAN_AUTHORITY_REQUIRED");
    expect(JSON.stringify(sustained)).toBe(before);

    const accepted = applyCommand(sustained, { ...command, confirmedSustainedReopen: true });
    expect(accepted.error).toBeUndefined();
    expect(accepted.project.captions.items.c05?.current.state).toBe("Proposed");
    expect(accepted.project.courtRecord.at(-1)?.actor).toEqual(command.actor);
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

  it("records an explicit BrowserAgent caption-run release without fabricating Human authority", () => {
    const leased = applyCommand(fixtureProject(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "caption-browser-agent-cancel",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;

    const released = applyCommand(leased, {
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      runId: "caption-browser-agent-cancel",
      expectedProjectRevision: leased.projectRevision,
    });

    expect(released.error).toBeUndefined();
    expect(released.project.activeGenerationRun).toBeNull();
    expect(released.project.courtRecord.at(-1)).toMatchObject({
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
    });
  });

  it("requires confirmation to replace Proposed cues, preserves Sustained cues, and releases only the matching caption lease", () => {
    const leased = applyCommand(fixtureProject({ cueState: "Sustained" }), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-adopt-1",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const staged: StagedGenerationResult = {
      contractVersion: 1,
      runId: "run-adopt-1",
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: "run-adopt-1",
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 1_000, contentType: "audio/wav" },
        words: [{ evidenceId: "word-1", sourceWordIndex: 0, startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "gpt-4o-transcribe-diarize", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "whisper-1", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [{ cueId: "generated-1", startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", evidenceIds: ["word-1"] }],
    };
    const rejected = applyCommand(leased, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-adopt-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: false,
      result: staged,
    });
    expect(rejected.error?.code).toBe("CONFIRMATION_DECLINED");

    const adopted = applyCommand(leased, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-adopt-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });
    expect(adopted.error).toBeUndefined();
    expect(adopted.project.activeGenerationRun).toBeNull();
    expect(adopted.project.captions.items.c05?.current.state).toBe("Sustained");
    expect(adopted.project.captions.items.c06?.mergedIntoItemId).toBe("generated-1");
    expect(adopted.project.captions.order).toContain("c05");
    expect(adopted.project.captions.order).toContain("generated-1");
    expect(adopted.project.evidence).toContainEqual({
      evidenceId: "word-1",
      projectId: leased.projectId,
      mediaSha256: leased.media.sha256,
      itemId: "generated-1",
      itemRevision: 1,
    });
    expect(adopted.project.localEvidencePackages).toHaveLength(1);
    expect(adopted.project.localEvidencePackages[0]).toMatchObject({
      runId: "run-adopt-1",
      cueBindings: [{ cueId: "generated-1", itemId: "generated-1", evidenceIds: ["word-1"] }],
      evidence: { words: [{ evidenceId: "word-1", text: "Generated" }] },
    });
  });

  it("never evicts Local Evidence Packages referenced by live Sustained cues and prunes only unreferenced history", () => {
    const base = fixtureProject({ cueState: "Sustained" });
    const evidencePackage = (runId: string, retainedAtMs: number, bindSustained: boolean): LocalCaptionEvidencePackage => ({
      packageId: `generation-${runId}`,
      runId,
      projectId: base.projectId,
      mediaSha256: base.media.sha256,
      expectedProjectRevision: base.projectRevision,
      expectedQualityProfileRevision: base.qualityProfile.revision,
      retainedAtMs,
      evidence: {
        contractVersion: 1,
        runId,
        projectId: base.projectId,
        mediaSha256: base.media.sha256,
        preparedManifest: { key: `prepared/${runId}/manifest.json`, sha256: "b".repeat(64) },
        normalizedAudio: { key: `prepared/${runId}/audio.wav`, sha256: "c".repeat(64), byteLength: 4, durationMs: base.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: `${runId}-word`, sourceWordIndex: 0, startMs: 1_000, endMs: 1_500, text: "Sustained", speaker: "Teacher", speakerSegmentIds: [`${runId}-speaker`] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      cueBindings: bindSustained
        ? [{ cueId: "c05", itemId: "c05", itemRevision: 1, evidenceIds: [`${runId}-word`] }]
        : [],
    });
    const stagedFor = (leased: CaptionProject): StagedGenerationResult => ({
      contractVersion: 1,
      runId: "run-retention-new",
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_010_000,
      expiresAtMs: 1_700_086_410_000,
      evidence: {
        contractVersion: 1,
        runId: "run-retention-new",
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/new/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/new/audio.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: leased.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: "new-word", sourceWordIndex: 0, startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", speakerSegmentIds: ["new-speaker"] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [{ cueId: "retention-generated", startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", evidenceIds: ["new-word"] }],
    });
    const adopt = (project: CaptionProject) => {
      const leased = applyCommand(project, {
        type: "StartGenerationRun",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId: "run-retention-new",
        targetTrack: "Captions",
        expectedProjectRevision: project.projectRevision,
      }).project;
      return applyCommand(leased, {
        type: "AdoptCaptionGenerationResult",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        runId: "run-retention-new",
        expectedProjectRevision: leased.projectRevision,
        expectedQualityProfileRevision: leased.qualityProfile.revision,
        confirmedProposedReplacement: true,
        result: stagedFor(leased),
      });
    };

    const blocked = adopt({
      ...base,
      localEvidencePackages: [1, 2, 3, 4].map((index) => evidencePackage(`sustained-${index}`, index, true)),
    });
    expect(blocked.error?.code).toBe("INVALID_ARGUMENT");
    expect(blocked.project.localEvidencePackages.map((entry) => entry.runId)).toEqual([
      "sustained-1", "sustained-2", "sustained-3", "sustained-4",
    ]);

    const retained = adopt({
      ...base,
      localEvidencePackages: [
        evidencePackage("sustained-1", 1, true),
        evidencePackage("sustained-2", 2, true),
        evidencePackage("sustained-3", 3, true),
        evidencePackage("old-unreferenced-1", 4, false),
        evidencePackage("old-unreferenced-2", 5, false),
      ],
    });
    expect(retained.error).toBeUndefined();
    expect(retained.project.localEvidencePackages.map((entry) => entry.runId)).toEqual([
      "sustained-1", "sustained-2", "sustained-3", "run-retention-new",
    ]);

    const fullUnreferencedHistory: LocalCaptionEvidencePackage = {
      ...evidencePackage("word-budget-old", 1, false),
      evidence: {
        ...evidencePackage("word-budget-old", 1, false).evidence,
        words: Array.from({ length: 2_700 }, (_, index) => ({
          evidenceId: `word-budget-old-${index}`,
          sourceWordIndex: index,
          startMs: index * 2,
          endMs: index * 2 + 1,
          text: "History",
          speaker: "Teacher",
          speakerSegmentIds: [],
        })),
      },
    };
    const prunedForSharedPortableBudget = adopt({
      ...base,
      localEvidencePackages: [fullUnreferencedHistory],
    });
    expect(prunedForSharedPortableBudget.error).toBeUndefined();
    // The current package must remain adoptable, so an unreferenced retained
    // package is evicted when its 2,700 words would otherwise make the
    // portable aggregate exceed the shared evidence/node budget.
    expect(prunedForSharedPortableBudget.project.localEvidencePackages.map((entry) => entry.runId)).toEqual([
      "run-retention-new",
    ]);
  });

  const sustainedPartitionCases = [
    { label: "start", cueId: "start-overlap", startMs: 500, endMs: 1_500, words: [[500, 900, "Before"], [1_100, 1_400, "Protected"]], expectedIds: ["start-overlap-part-1"] },
    { label: "middle", cueId: "middle-overlap", startMs: 500, endMs: 3_500, words: [[500, 900, "Before"], [1_100, 1_400, "Protected"], [3_100, 3_400, "After"]], expectedIds: ["middle-overlap-part-1", "middle-overlap-part-2"] },
    { label: "end", cueId: "end-overlap", startMs: 2_500, endMs: 3_500, words: [[2_600, 2_900, "Protected"], [3_100, 3_400, "After"]], expectedIds: ["end-overlap-part-1"] },
  ] satisfies readonly {
    readonly label: string;
    readonly cueId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly words: readonly (readonly [number, number, string])[];
    readonly expectedIds: readonly string[];
  }[];
  it.each(sustainedPartitionCases)("partitions generated $label overlap around a Sustained cue before adoption/export", ({ cueId, startMs, endMs, words, expectedIds }) => {
    const leased = applyCommand(fixtureProject({ cueState: "Sustained" }), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: `run-${cueId}`,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const evidenceWords = words.map(([wordStartMs, wordEndMs, text], index) => ({
      evidenceId: `${cueId}-word-${index + 1}`,
      sourceWordIndex: index,
      startMs: wordStartMs,
      endMs: wordEndMs,
      text,
      speaker: "Teacher",
      speakerSegmentIds: ["speaker-1"],
    }));
    const staged: StagedGenerationResult = {
      contractVersion: 1,
      runId: `run-${cueId}`,
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: `run-${cueId}`,
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: leased.media.durationMs, contentType: "audio/wav" },
        words: evidenceWords,
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [{ cueId, startMs, endMs, text: words.map(([, , value]) => value).join(" "), speaker: "Teacher", evidenceIds: evidenceWords.map((word) => word.evidenceId) }],
    };
    const adopted = applyCommand(leased, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: staged.runId,
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });

    expect(adopted.error).toBeUndefined();
    expect(adopted.project.captions.items.c05?.current.state).toBe("Sustained");
    expect(adopted.project.captions.order.filter((itemId) => itemId.startsWith(cueId))).toEqual(expectedIds);
    const sustained = adopted.project.captions.items.c05!.current;
    for (const generatedId of expectedIds) {
      const generated = adopted.project.captions.items[generatedId]!.current;
      expect(generated.endMs <= sustained.startMs || generated.startMs >= sustained.endMs).toBe(true);
    }
    expect(validateProject(adopted.project).findings.some((finding) => finding.ruleId === "caption.no-overlap" && finding.severity === "blocker")).toBe(false);
    expect(prepareTrackExport({ project: adopted.project, trackKind: "Captions", format: "vtt", disposition: "draft" }).roundTrip).toEqual({ ok: true });
  });

  it("removes canonical local caption evidence when a Human relinks different media", () => {
    const original = fixtureProject();
    const retained: LocalCaptionEvidencePackage = {
      packageId: "generation-retained-run",
      runId: "retained-run",
      projectId: original.projectId,
      mediaSha256: original.media.sha256,
      expectedProjectRevision: original.projectRevision,
      expectedQualityProfileRevision: original.qualityProfile.revision,
      retainedAtMs: 1_700_000_000_000,
      evidence: {
        contractVersion: 1,
        runId: "retained-run",
        projectId: original.projectId,
        mediaSha256: original.media.sha256,
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: original.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: "retained-word", sourceWordIndex: 0, startMs: 0, endMs: 1_000, text: "Retained", speaker: "Teacher", speakerSegmentIds: ["speaker-retained"] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: null, requestMetadata: {}, warnings: [] },
        ],
      },
      cueBindings: [],
    };
    const project: CaptionProject = { ...original, localEvidencePackages: [retained] };

    const relinked = applyCommand(project, {
      type: "RelinkMedia",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: project.projectRevision,
      media: { sourceId: "different-source", sha256: "9".repeat(64), durationMs: project.media.durationMs },
    });

    expect(relinked.error).toBeUndefined();
    expect(relinked.project.localEvidencePackages).toEqual([]);
  });

  it("rebases caption adoption across an unrelated audio-description edit while fencing the leased caption base", () => {
    const leased = applyCommand(fixtureProject(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-rebase-1",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const editedElsewhere = applyCommand(leased, {
      type: "ReviseAudioDescription",
      actor: { type: "Human", id: "teacher" },
      itemId: "ad01",
      beatId: "ad01",
      expectedItemRevision: 1,
      expectedProjectRevision: leased.projectRevision,
      patch: { description: "The teacher writes the answer on the board." },
    }).project;
    const staged: StagedGenerationResult = {
      contractVersion: 1,
      runId: "run-rebase-1",
      projectId: editedElsewhere.projectId,
      targetTrack: "Captions",
      // This is the revision captured when the target-track lease was acquired,
      // not the unrelated audio-description edit that followed it.
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: editedElsewhere.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: "run-rebase-1",
        projectId: editedElsewhere.projectId,
        mediaSha256: editedElsewhere.media.sha256,
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 1_000, contentType: "audio/wav" },
        words: [{ evidenceId: "word-rebase-1", sourceWordIndex: 0, startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "gpt-4o-transcribe-diarize", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "whisper-1", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [{ cueId: "generated-rebase-1", startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", evidenceIds: ["word-rebase-1"] }],
    };
    const adopted = applyCommand(editedElsewhere, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-rebase-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: editedElsewhere.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });

    expect(adopted.error).toBeUndefined();
    expect(adopted.project.audioDescriptions.items.ad01?.current.description).toBe("The teacher writes the answer on the board.");
    expect(adopted.project.activeGenerationRun).toBeNull();
  });

  it("rejects a staged caption result after its leased caption base was changed and lets a Human release the stale lease", () => {
    const leased = applyCommand(fixtureProject(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-stale-base-1",
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    // Models a restored/browser-conflict state: normal caption commands are
    // already blocked by the lease, but adoption must still fail closed.
    const unsafeCaptionChange: CaptionProject = {
      ...leased,
      captions: {
        ...leased.captions,
        items: {
          ...leased.captions.items,
          c05: {
            ...leased.captions.items.c05!,
            current: { ...leased.captions.items.c05!.current, itemRevision: 2, text: "Changed outside this lease." },
          },
        },
      },
      projectRevision: leased.projectRevision + 1,
    };
    const staged = {
      contractVersion: 1,
      runId: "run-stale-base-1",
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_086_400_000,
      evidence: {
        contractVersion: 1,
        runId: "run-stale-base-1",
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 1_000, contentType: "audio/wav" },
        words: [{ evidenceId: "word-stale-1", sourceWordIndex: 0, startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "gpt-4o-transcribe-diarize", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
          { role: "word-timestamps", model: "whisper-1", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        ],
      },
      captions: [{ cueId: "generated-stale-1", startMs: 6_000, endMs: 7_000, text: "Generated", speaker: "Teacher", evidenceIds: ["word-stale-1"] }],
    } satisfies StagedGenerationResult;
    const rejected = applyCommand(unsafeCaptionChange, {
      type: "AdoptCaptionGenerationResult",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "run-stale-base-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });
    expect(rejected.error?.code).toBe("MEDIA_HASH_MISMATCH");
    const released = applyCommand(unsafeCaptionChange, {
      type: "ReleaseGenerationRun",
      actor: { type: "Human", id: "teacher" },
      runId: "run-stale-base-1",
      expectedProjectRevision: leased.projectRevision,
    });
    expect(released.error).toBeUndefined();
    expect(released.project.activeGenerationRun).toBeNull();
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
    const validated = applyCommand(fixtureProject(), {
      type: "ValidateProject", actor: { type: "System", id: "validator" }, expectedProjectRevision: 1,
    }).project;
    const warning = validated.validationRun?.warnings[0];
    if (warning === undefined) throw new Error("Expected a validation warning.");
    const certified = { ...validated, certification: { status: "Current" as const, certificationId: "cert-1" } };
    const mark = applyCommand(certified, { type: "MarkItemAgentReady", actor: { type: "BrowserAgent", id: "browser-agent" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: certified.projectRevision });
    expect(mark.project.validation.status).toBe("Stale");
    const objected = applyCommand(certified, { type: "ObjectItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: certified.projectRevision, reason: "Reason" });
    expect(objected.project.certification.status).toBe("Stale");
    const sustained = applyCommand(certified, { type: "SustainItem", actor: { type: "Human", id: "teacher" }, itemId: "c05", expectedItemRevision: 1, expectedProjectRevision: certified.projectRevision });
    expect(sustained.project.validation.status).toBe("Stale");
    const waived = applyCommand(certified, { type: "WaiveWarning", actor: { type: "Human", id: "teacher" }, findingId: warning.findingId, reason: "Reason", expectedProjectRevision: certified.projectRevision });
    expect(waived.error).toBeUndefined();
    expect(waived.project.certification.status).toBe("Stale");
  });

  it("preserves current validation but stales current certification for a warning waiver", () => {
    const validated = applyCommand(fixtureProject(), {
      type: "ValidateProject", actor: { type: "System", id: "validator" }, expectedProjectRevision: 1,
    }).project;
    const warning = validated.validationRun?.warnings[0];
    if (warning === undefined) throw new Error("Expected a validation warning.");
    const project: CaptionProject = {
      ...validated,
      certification: { status: "Current", certificationId: "cert-1" },
    };
    const result = applyCommand(project, {
      type: "WaiveWarning", actor: { type: "Human", id: "teacher" }, findingId: warning.findingId, reason: "Intentional pacing",
      expectedProjectRevision: project.projectRevision,
    });
    expect(result.error).toBeUndefined();
    expect(result.project.validation.status).toBe("Current");
    expect(result.project.validation).toEqual(project.validation);
    expect(result.project.certification).toEqual({ status: "Stale", certificationId: "cert-1" });
  });
});
