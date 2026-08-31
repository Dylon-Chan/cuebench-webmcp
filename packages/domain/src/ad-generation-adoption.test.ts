import type {
  LocalCaptionEvidencePackage,
  StagedAudioDescriptionGenerationResult,
} from "@cuebench/contracts";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  captionEvidenceProjectionForAudioDescription,
  createProject,
  exportProjectBackup,
  previewProjectImport,
  validateProject,
  type CaptionProject,
} from "./index";

const human = { type: "Human" as const, id: "teacher" };
const ai = { type: "CueBenchAI" as const, id: "cuebench-ai" };

const projectWithCaptionEvidence = (): CaptionProject => {
  const project = createProject({
    projectId: "ad-project",
    title: "Audio-description adoption fixture",
    media: { sourceId: "source", sha256: "a".repeat(64), durationMs: 30_000, relinkState: "Linked" },
    captions: [{
      kind: "CaptionCue",
      itemId: "c01",
      state: "Sustained",
      startMs: 1_000,
      endMs: 3_000,
      text: "The lecturer introduces the energy diagram.",
      speaker: "Teacher",
      actor: human,
      cause: "fixture",
    }, {
      // This is intentionally human-authored after the retained word package.
      // It must still fence dialogue for an AD run even though no word-level
      // evidence can be attached to it.
      kind: "CaptionCue",
      itemId: "c02-manual",
      state: "Sustained",
      startMs: 15_000,
      endMs: 17_000,
      text: "Dr. Nguyen names the reaction pathway.",
      speaker: "Teacher",
      actor: human,
      cause: "fixture",
    }],
    audioDescriptions: [
      {
        kind: "AudioDescriptionBeat",
        itemId: "ad-ai",
        state: "Proposed",
        startMs: 4_000,
        endMs: 5_000,
        description: "An early automated description.",
        actor: ai,
        cause: "fixture",
      },
      {
        kind: "AudioDescriptionBeat",
        itemId: "ad-manual",
        state: "Proposed",
        startMs: 6_000,
        endMs: 7_000,
        description: "A teacher-authored description remains in review.",
        actor: human,
        cause: "fixture",
      },
      {
        kind: "AudioDescriptionBeat",
        itemId: "ad-sustained",
        state: "Sustained",
        startMs: 8_000,
        endMs: 9_000,
        description: "A sustained human-reviewed description.",
        actor: human,
        cause: "fixture",
      },
    ],
    evidence: [{
      evidenceId: "word-1",
      projectId: "ad-project",
      mediaSha256: "a".repeat(64),
      itemId: "c01",
      itemRevision: 1,
    }],
  });
  const localEvidence: LocalCaptionEvidencePackage = {
    packageId: "generation-caption-run-1",
    runId: "caption-run-1",
    projectId: project.projectId,
    mediaSha256: project.media.sha256,
    expectedProjectRevision: project.projectRevision,
    expectedQualityProfileRevision: project.qualityProfile.revision,
    retainedAtMs: 1_700_000_000_000,
    evidence: {
      contractVersion: 1,
      runId: "caption-run-1",
      projectId: project.projectId,
      mediaSha256: project.media.sha256,
      preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
      normalizedAudio: { key: "prepared/a/audio/c.wav", sha256: "c".repeat(64), byteLength: 4, durationMs: 30_000, contentType: "audio/wav" },
      words: [{ evidenceId: "word-1", sourceWordIndex: 0, startMs: 1_000, endMs: 1_500, text: "The", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
      speakerSegments: [{ id: "speaker-1", startMs: 1_000, endMs: 1_500, speaker: "Teacher", text: "The" }],
      uncertaintySpans: [],
      provenance: [
        { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] },
        { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "1".repeat(64), store: false, requestMetadata: {}, warnings: [] },
      ],
    },
    cueBindings: [{ cueId: "c01", itemId: "c01", itemRevision: 1, evidenceIds: ["word-1"] }],
  };
  return { ...project, localEvidencePackages: [localEvidence] };
};

const stagedFor = (leased: CaptionProject): StagedAudioDescriptionGenerationResult => {
  const projection = captionEvidenceProjectionForAudioDescription(leased);
  if (projection === null) throw new Error("Fixture must retain caption evidence before staging audio descriptions.");
  return {
    contractVersion: 1,
    runId: "ad-run-1",
    projectId: leased.projectId,
    targetTrack: "AudioDescriptions",
    expectedProjectRevision: leased.projectRevision,
    expectedQualityProfileRevision: leased.qualityProfile.revision,
    mediaSha256: leased.media.sha256,
    captionEvidenceHash: projection.hash,
    evidence: {
      contractVersion: 1,
      runId: "ad-run-1",
      projectId: leased.projectId,
      mediaSha256: leased.media.sha256,
      captionEvidenceHash: projection.hash,
      preparedManifest: { key: "prepared/a/manifests/b.json", sha256: "b".repeat(64) },
      frames: [{ evidenceId: "frame-1", atMs: 12_000, sha256: "c".repeat(64), mimeType: "image/webp" }],
      sceneBoundaries: [12_000],
      provenance: [{ role: "audio-description", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: false, requestMetadata: {}, warnings: [] }],
    },
    audioDescriptions: [{
      beatId: "ad-generated-1",
      startMs: 12_000,
      endMs: 13_500,
      description: "A descending energy curve fills the screen.",
      evidenceIds: ["frame-1"],
    }],
    extendedDescriptionRequirements: [{
      requirementId: "edr-ad-run-1-1",
      text: "A detailed molecular animation appears.",
      rationale: "It cannot fit in any dialogue-free gap.",
      evidenceIds: ["frame-1"],
      reason: "no-compatible-speech-gap",
    }],
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_086_400_000,
  };
};

describe("audio-description generation adoption", () => {
  it("projects every live caption as a stale-bound dialogue fence, including a manual cue without words", () => {
    const project = projectWithCaptionEvidence();
    const projection = captionEvidenceProjectionForAudioDescription(project);
    expect(projection?.projection.captions).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "c02-manual", evidenceIds: [], startMs: 15_000, endMs: 17_000 }),
    ]));

    // The projection hash changes when that manual cue changes, so a result
    // generated before a human correction cannot silently adopt afterwards.
    const corrected = {
      ...project,
      captions: {
        ...project.captions,
        items: {
          ...project.captions.items,
          "c02-manual": {
            ...project.captions.items["c02-manual"]!,
            current: { ...project.captions.items["c02-manual"]!.current, text: "Dr. Nguyen corrects the reaction pathway." },
          },
        },
      },
    };
    expect(captionEvidenceProjectionForAudioDescription(corrected)?.hash).not.toBe(projection?.hash);
  });

  it("requires retained caption evidence before an AD target lease can begin", () => {
    const bare = createProject({
      projectId: "bare-ad-project",
      title: "No evidence",
      media: { sourceId: "source", sha256: "a".repeat(64), durationMs: 20_000, relinkState: "Linked" },
      captions: [{ kind: "CaptionCue", itemId: "c01", state: "Proposed", startMs: 1_000, endMs: 2_000, text: "Caption without retained evidence.", speaker: null, actor: ai, cause: "fixture" }],
    });
    const start = applyCommand(bare, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-run-1",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: bare.projectRevision,
    });
    expect(start.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("records an explicit BrowserAgent audio-description-run release without fabricating Human authority", () => {
    const initial = projectWithCaptionEvidence();
    const leased = applyCommand(initial, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-browser-agent-cancel",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: initial.projectRevision,
    }).project;

    const released = applyCommand(leased, {
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      runId: "ad-browser-agent-cancel",
      expectedProjectRevision: leased.projectRevision,
    });

    expect(released.error).toBeUndefined();
    expect(released.project.activeGenerationRun).toBeNull();
    expect(released.project.courtRecord.at(-1)).toMatchObject({
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
    });
  });

  it("atomically adopts only an evidence-bound AD result, protects sustained/manual beats, and records deterministic extended-description findings", () => {
    const initial = projectWithCaptionEvidence();
    const started = applyCommand(initial, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-run-1",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: initial.projectRevision,
    });
    expect(started.error).toBeUndefined();
    const leased = started.project;
    const staged = stagedFor(leased);

    const unconfirmed = applyCommand(leased, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: false,
      result: staged,
    });
    expect(unconfirmed.error?.code).toBe("CONFIRMATION_DECLINED");

    const adopted = applyCommand(leased, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: staged,
    });
    expect(adopted.error).toBeUndefined();
    expect(adopted.project.activeGenerationRun).toBeNull();
    expect(adopted.project.audioDescriptions.items["ad-manual"]?.current.description).toContain("teacher-authored");
    expect(adopted.project.audioDescriptions.items["ad-sustained"]?.current.state).toBe("Sustained");
    expect(adopted.project.audioDescriptions.items["ad-ai"]?.supersededByRunId).toBe("ad-run-1");
    expect(adopted.project.audioDescriptions.items["ad-generated-1"]?.current.state).toBe("Proposed");
    expect(adopted.project.audioDescriptionRequirements["edr-ad-run-1-1"]?.evidenceIds).toEqual(["frame-1"]);
    expect(adopted.project.localAudioDescriptionEvidencePackages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "ad-run-1",
        captionEvidenceHash: staged.captionEvidenceHash,
        evidence: expect.objectContaining({ frames: [expect.objectContaining({ evidenceId: "frame-1" })] }),
      }),
    ]));
    expect(adopted.project.evidence).toContainEqual({
      evidenceId: "frame-1",
      projectId: leased.projectId,
      mediaSha256: leased.media.sha256,
      itemId: "ad-generated-1",
      itemRevision: 1,
    });
    expect(validateProject(adopted.project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "audio-description.extended-requirement", severity: "warning" }),
    ]));
    expect(previewProjectImport(exportProjectBackup(adopted.project), { actor: human })).toMatchObject({ mode: "preview" });
  });

  it("adopts a human-confirmed replacement with run-scoped output IDs and permits one retained frame to support multiple beats", () => {
    const initial = projectWithCaptionEvidence();
    const leasedA = applyCommand(initial, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-run-a",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: initial.projectRevision,
    }).project;
    const stagedA = stagedFor(leasedA);
    const adoptedA = applyCommand(leasedA, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-a",
      expectedProjectRevision: leasedA.projectRevision,
      expectedQualityProfileRevision: leasedA.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: {
        ...stagedA,
        runId: "ad-run-a",
        evidence: { ...stagedA.evidence, runId: "ad-run-a", frames: [{ ...stagedA.evidence.frames[0]!, evidenceId: "ad-frame-a" }] },
        audioDescriptions: [{ ...stagedA.audioDescriptions[0]!, beatId: "ad-beat-a", evidenceIds: ["ad-frame-a"] }],
        extendedDescriptionRequirements: [{ ...stagedA.extendedDescriptionRequirements[0]!, requirementId: "ad-requirement-a", evidenceIds: ["ad-frame-a"] }],
      },
    });
    expect(adoptedA.error).toBeUndefined();

    const leasedB = applyCommand(adoptedA.project, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-run-b",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: adoptedA.project.projectRevision,
    }).project;
    const stagedB = stagedFor(leasedB);
    const adoptedB = applyCommand(leasedB, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-b",
      expectedProjectRevision: leasedB.projectRevision,
      expectedQualityProfileRevision: leasedB.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: {
        ...stagedB,
        runId: "ad-run-b",
        evidence: { ...stagedB.evidence, runId: "ad-run-b", frames: [{ ...stagedB.evidence.frames[0]!, evidenceId: "ad-frame-b" }] },
        audioDescriptions: [{
          ...stagedB.audioDescriptions[0]!,
          beatId: "ad-beat-b-1",
          evidenceIds: ["ad-frame-b"],
        }, {
          ...stagedB.audioDescriptions[0]!,
          beatId: "ad-beat-b-2",
          startMs: 13_500,
          endMs: 15_000,
          description: "The same curve highlights the activation barrier.",
          evidenceIds: ["ad-frame-b"],
        }],
        extendedDescriptionRequirements: [{
          ...stagedB.extendedDescriptionRequirements[0]!,
          requirementId: "ad-requirement-b",
          evidenceIds: ["ad-frame-b"],
        }],
      },
    });

    expect(adoptedB.error).toBeUndefined();
    expect(adoptedB.project.audioDescriptions.items["ad-beat-a"]?.supersededByRunId).toBe("ad-run-b");
    expect(adoptedB.project.audioDescriptions.items["ad-beat-b-1"]?.current.state).toBe("Proposed");
    expect(adoptedB.project.audioDescriptions.items["ad-beat-b-2"]?.current.state).toBe("Proposed");
    expect(adoptedB.project.localAudioDescriptionEvidencePackages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "ad-run-b",
        beatBindings: expect.arrayContaining([
          expect.objectContaining({ itemId: "ad-beat-b-1", evidenceIds: ["ad-frame-b"] }),
          expect.objectContaining({ itemId: "ad-beat-b-2", evidenceIds: ["ad-frame-b"] }),
        ]),
      }),
    ]));
  });

  it("carries retained visual bindings through human state rulings and clears their provenance on media relink", () => {
    const initial = projectWithCaptionEvidence();
    const leased = applyCommand(initial, {
      type: "StartGenerationRun", actor: ai, runId: "ad-run-1", targetTrack: "AudioDescriptions", expectedProjectRevision: initial.projectRevision,
    }).project;
    const adopted = applyCommand(leased, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: stagedFor(leased),
    }).project;
    const objected = applyCommand(adopted, {
      type: "ObjectItem",
      actor: human,
      itemId: "ad-generated-1",
      expectedItemRevision: 1,
      expectedProjectRevision: adopted.projectRevision,
      reason: "Use a clearer visual description.",
    });
    expect(objected.error).toBeUndefined();
    const sustained = applyCommand(objected.project, {
      type: "SustainItem",
      actor: human,
      itemId: "ad-generated-1",
      expectedItemRevision: 2,
      expectedProjectRevision: objected.project.projectRevision,
    });
    expect(sustained.error).toBeUndefined();
    expect(sustained.project.localAudioDescriptionEvidencePackages[0]?.beatBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "ad-generated-1", itemRevision: 3, evidenceIds: ["frame-1"] }),
    ]));
    expect(sustained.project.evidence).toContainEqual(expect.objectContaining({ evidenceId: "frame-1", itemRevision: 3 }));

    const relinked = applyCommand(sustained.project, {
      type: "RelinkMedia",
      actor: human,
      expectedProjectRevision: sustained.project.projectRevision,
      media: { sourceId: "replacement", sha256: "b".repeat(64), durationMs: 30_000 },
    });
    expect(relinked.error).toBeUndefined();
    expect(relinked.project.localAudioDescriptionEvidencePackages).toEqual([]);
    expect(relinked.project.audioDescriptionRequirements).toEqual({});
    // Durable evidence history is append-only. The old-media hash leaves the
    // frame stale and non-resolvable after the active AD package is cleared.
    expect(relinked.project.evidence).toContainEqual(expect.objectContaining({
      evidenceId: "frame-1",
      mediaSha256: "a".repeat(64),
    }));
  });

  it("rejects a staged AD result if the signed caption-evidence base has changed", () => {
    const initial = projectWithCaptionEvidence();
    const leased = applyCommand(initial, {
      type: "StartGenerationRun",
      actor: ai,
      runId: "ad-run-1",
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: initial.projectRevision,
    }).project;
    const result = applyCommand(leased, {
      type: "AdoptAudioDescriptionGenerationResult",
      actor: ai,
      runId: "ad-run-1",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      confirmedProposedReplacement: true,
      result: { ...stagedFor(leased), captionEvidenceHash: "f".repeat(64) },
    });
    expect(result.error?.code).toBe("MEDIA_HASH_MISMATCH");
  });
});
