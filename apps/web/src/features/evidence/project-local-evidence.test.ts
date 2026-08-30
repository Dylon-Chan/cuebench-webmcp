import { createProject, type CaptionProject, type EvidenceProvenance } from "@cuebench/domain";
import { describe, expect, it } from "vitest";
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
          words: [{ evidenceId: evidence.evidenceId, startMs: 1_000, endMs: 1_500, text: "Welcome", speaker: "Teacher", speakerSegmentIds: ["speaker-1"], sourceWordIndex: 0 }],
          uncertaintySpans: [{
            uncertaintyId: "uncertainty-generated-1",
            reason: "speaker-gap",
            startMs: 1_000,
            endMs: 1_500,
            evidenceIds: [evidence.evidenceId],
          }],
          provenance: [
            { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null, requestMetadata: {}, warnings: [] },
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
      uncertainty: [{
        uncertaintyId: "uncertainty-generated-1",
        reason: "speaker-gap",
        startMs: 1_000,
        endMs: 1_500,
      }],
      provenance: expect.arrayContaining([expect.objectContaining({ role: "diarization", model: "fixture", store: null })]),
    }));
  });
});
