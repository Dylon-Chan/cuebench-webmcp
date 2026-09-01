import {
  createProject,
  exportProjectBackup,
  previewProjectImport,
  type CaptionProject,
  type EvidenceProvenance,
} from "@cuebench/domain";
import { describe, expect, it } from "vitest";
import { resolveValidatedEvidenceWindow } from "./EvidenceInspector";
import { projectLocalEvidenceContentResolver } from "./project-local-evidence";

const digest = "a".repeat(64);

describe("project local evidence resolver", () => {
  it("resolves an adopted cue's real word id from canonical project/backup state", () => {
    const base = createProject({
      projectId: "evidence-project",
      title: "Evidence fixture",
      media: { sourceId: "source", sha256: digest, durationMs: 10_000, relinkState: "Linked" },
      captions: [{
        kind: "CaptionCue",
        itemId: "generated-cue",
        state: "Proposed",
        startMs: 1_000,
        endMs: 2_000,
        text: "Welcome",
        speaker: "Teacher",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        cause: "fixture",
      }],
    });
    const evidence: EvidenceProvenance = {
      evidenceId: "word-generated-1",
      projectId: base.projectId,
      mediaSha256: digest,
      itemId: "generated-cue",
      itemRevision: 1,
    };
    const project: CaptionProject = {
      ...base,
      evidence: [evidence],
      localEvidencePackages: [{
        packageId: "generation-run-1",
        runId: "run-1",
        projectId: base.projectId,
        mediaSha256: digest,
        expectedProjectRevision: base.projectRevision,
        expectedQualityProfileRevision: base.qualityProfile.revision,
        retainedAtMs: 1,
        evidence: {
          contractVersion: 1,
          runId: "run-1",
          projectId: base.projectId,
          mediaSha256: digest,
          preparedManifest: { key: "prepared/a/manifest.json", sha256: "b".repeat(64) },
          normalizedAudio: { key: "prepared/a/audio.wav", sha256: "c".repeat(64), byteLength: 1, durationMs: 10_000, contentType: "audio/wav" },
          words: [{ evidenceId: evidence.evidenceId, startMs: 1_000, endMs: 1_500, text: "Welcome", sourceText: "Welcomme", speaker: "Teacher", speakerSegmentIds: ["speaker-1"], sourceWordIndex: 0 }],
          speakerSegments: [{ id: "speaker-1", startMs: 1_000, endMs: 1_500, speaker: "Teacher", text: "Welcomme" }],
          uncertaintySpans: [{
            uncertaintyId: "uncertainty-generated-1",
            reason: "speaker-gap",
            startMs: 1_000,
            endMs: 1_500,
            evidenceIds: [evidence.evidenceId],
          }],
          provenance: [
            {
              role: "diarization",
              model: "fixture",
              requestHash: "d".repeat(64),
              responseHash: "e".repeat(64),
              store: null,
              requestMetadata: { mode: "fixture" },
              warnings: ["seam-overlap-deduplicated"],
              provenanceVersion: 2,
              disposition: "executed",
              skippedReason: null,
              provider: "fixture",
              mode: "fixture",
              endpoint: { path: "/v1/audio/transcriptions", method: "FIXTURE", parameters: { response_format: "diarized_json" } },
              prompt: null,
              structuredOutput: null,
              qualityProfile: { revision: base.qualityProfile.revision, rulesSha256: "1".repeat(64) },
              timing: { startedAtMs: 1, completedAtMs: 2, durationMs: 1 },
              usage: { kind: "audio-duration", seconds: 0.5 },
              cost: { kind: "unavailable", reason: "fixture" },
              sourceMediaSha256: digest,
            },
            { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null, requestMetadata: {}, warnings: [] },
          ],
        },
        cueBindings: [{ cueId: "generated-cue", itemId: "generated-cue", itemRevision: 1, evidenceIds: [evidence.evidenceId] }],
      }],
    };

    expect(projectLocalEvidenceContentResolver(project).resolve(evidence)).toEqual(expect.objectContaining({
      evidenceId: "word-generated-1",
      label: "Teacher: Welcome",
      startMs: 1_000,
      endMs: 1_500,
      sourceText: "Welcomme",
      speakerEvidence: [{ id: "speaker-1", speaker: "Teacher", text: "Welcomme", startMs: 1_000, endMs: 1_500 }],
      uncertainty: [{
        uncertaintyId: "uncertainty-generated-1",
        reason: "speaker-gap",
        startMs: 1_000,
        endMs: 1_500,
      }],
      provenance: expect.arrayContaining([expect.objectContaining({ role: "diarization", model: "fixture", store: null, provenanceVersion: 2 })]),
    }));
  });

  it("resolves adopted visual-frame evidence after a portable backup round trip", () => {
    const base = createProject({
      projectId: "ad-evidence-project",
      title: "Visual evidence fixture",
      media: { sourceId: "source", sha256: digest, durationMs: 10_000, relinkState: "Linked" },
      audioDescriptions: [{
        kind: "AudioDescriptionBeat",
        itemId: "ad-visual-1",
        state: "Proposed",
        startMs: 4_000,
        endMs: 5_000,
        description: "A descending curve fills the diagram.",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        cause: "fixture",
      }],
    });
    const evidence: EvidenceProvenance = {
      evidenceId: "frame-visual-1",
      projectId: base.projectId,
      mediaSha256: digest,
      itemId: "ad-visual-1",
      itemRevision: 1,
    };
    const adopted: CaptionProject = {
      ...base,
      evidence: [evidence],
      localAudioDescriptionEvidencePackages: [{
        packageId: "ad-run-1",
        runId: "ad-run-1",
        projectId: base.projectId,
        mediaSha256: digest,
        expectedProjectRevision: base.projectRevision,
        expectedQualityProfileRevision: base.qualityProfile.revision,
        captionEvidenceHash: "b".repeat(64),
        retainedAtMs: 1,
        outputSha256: "c".repeat(64),
        evidence: {
          contractVersion: 1,
          runId: "ad-run-1",
          projectId: base.projectId,
          mediaSha256: digest,
          captionEvidenceHash: "b".repeat(64),
          preparedManifest: { key: "prepared/ad/manifest.json", sha256: "d".repeat(64) },
          frames: [{ evidenceId: evidence.evidenceId, atMs: 4_500, sha256: "e".repeat(64), mimeType: "image/webp" }],
          sceneBoundaries: [4_500],
          provenance: [{
            role: "audio-description",
            model: "fixture",
            requestHash: "f".repeat(64),
            responseHash: "0".repeat(64),
            store: false,
            requestMetadata: {},
            warnings: [],
          }],
        },
        beatBindings: [{ beatId: "ad-visual-1", itemId: "ad-visual-1", itemRevision: 1, evidenceIds: [evidence.evidenceId] }],
        requirementBindings: [],
      }],
    };

    const preview = previewProjectImport(exportProjectBackup(adopted), {
      actor: { type: "Human", id: "teacher" },
      relinkedMedia: { sourceId: "relinked", sha256: digest, durationMs: 10_000 },
    });
    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") throw new Error("Expected an import preview.");
    const resolver = projectLocalEvidenceContentResolver(preview.project);
    const resolved = resolver.resolve(evidence);

    expect(resolved).toEqual(expect.objectContaining({
      source: "LocalAudioDescriptionEvidencePackage",
      evidenceId: evidence.evidenceId,
      label: "Visual frame at 4500 ms",
      startMs: 4_499,
      endMs: 4_501,
      stagedOutputSha256: "c".repeat(64),
      sourceText: null,
      speakerEvidence: [],
      uncertainty: [],
      provenance: [expect.objectContaining({ role: "audio-description", model: "fixture" })],
    }));
    expect(resolveValidatedEvidenceWindow(preview.project, evidence, resolver)).toEqual(expect.objectContaining({
      status: "available",
      window: expect.objectContaining({
        source: "LocalAudioDescriptionEvidencePackage",
        evidenceId: evidence.evidenceId,
      }),
    }));
  });
});
