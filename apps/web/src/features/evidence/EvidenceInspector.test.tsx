import { fireEvent, render, screen } from "@testing-library/react";
import { createProject, type CaptionProject } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import { indexReviewData } from "../review/review-utils";
import { EvidenceInspector } from "./EvidenceInspector";
import { projectLocalEvidenceContentResolver } from "./project-local-evidence";

const digest = "a".repeat(64);

const evidenceProject = (): CaptionProject => {
  const base = createProject({
    projectId: "inspector-evidence-project",
    title: "Inspector evidence fixture",
    media: { sourceId: "source", sha256: digest, durationMs: 10_000, relinkState: "Linked" },
    captions: [{
      kind: "CaptionCue",
      itemId: "caption-1",
      state: "Proposed",
      startMs: 1_000,
      endMs: 2_000,
      text: "Welcome",
      speaker: "Teacher",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    }],
  });
  return {
    ...base,
    evidence: [{
      evidenceId: "word-1",
      projectId: base.projectId,
      mediaSha256: digest,
      itemId: "caption-1",
      itemRevision: 1,
    }],
    localEvidencePackages: [{
      packageId: "run-1",
      runId: "run-1",
      projectId: base.projectId,
      mediaSha256: digest,
      expectedProjectRevision: base.projectRevision,
      expectedQualityProfileRevision: base.qualityProfile.revision,
      retainedAtMs: 1,
      outputSha256: "9".repeat(64),
      evidence: {
        contractVersion: 1,
        runId: "run-1",
        projectId: base.projectId,
        mediaSha256: digest,
        preparedManifest: { key: "prepared/a/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/a/audio.wav", sha256: "c".repeat(64), byteLength: 44, durationMs: 10_000, contentType: "audio/wav" },
        words: [{ evidenceId: "word-1", sourceWordIndex: 0, startMs: 1_000, endMs: 1_500, text: "Welcome", sourceText: "Welcomme", speaker: "Teacher", speakerSegmentIds: ["speaker-1"] }],
        speakerSegments: [{ id: "speaker-1", startMs: 1_000, endMs: 1_500, speaker: "Teacher", text: "Welcomme" }],
        uncertaintySpans: [{ uncertaintyId: "uncertainty-1", reason: "text-conflict", startMs: 1_000, endMs: 1_500, evidenceIds: ["word-1"] }],
        provenance: [
          {
            role: "diarization",
            model: "gpt-4o-transcribe-diarize",
            requestHash: "d".repeat(64),
            responseHash: "e".repeat(64),
            store: null,
            requestMetadata: { requestedModel: "gpt-4o-transcribe-diarize" },
            warnings: ["speaker-identities-are-chunk-local"],
            provenanceVersion: 2,
            disposition: "executed",
            skippedReason: null,
            provider: "openai",
            mode: "live",
            endpoint: { path: "/v1/audio/transcriptions", method: "POST", parameters: { responseFormat: "diarized_json" } },
            prompt: null,
            structuredOutput: null,
            qualityProfile: { revision: base.qualityProfile.revision, rulesSha256: "f".repeat(64) },
            timing: { startedAtMs: 1, completedAtMs: 3, durationMs: 2 },
            usage: { kind: "audio-duration", seconds: 0.5 },
            cost: { kind: "unavailable", reason: "not-priced" },
            sourceMediaSha256: digest,
          },
          {
            role: "word-timestamps",
            model: "whisper-1",
            requestHash: "1".repeat(64),
            responseHash: "2".repeat(64),
            store: null,
            requestMetadata: {},
            warnings: [],
          },
        ],
      },
      cueBindings: [{ cueId: "caption-1", itemId: "caption-1", itemRevision: 1, evidenceIds: ["word-1"] }],
    }],
  };
};

describe("EvidenceInspector", () => {
  it("surfaces bounded pre-reconciliation source text, diarization excerpts, and full v2 provenance", () => {
    const project = evidenceProject();
    const item = project.captions.items["caption-1"]!;
    render(
      <EvidenceInspector
        project={project}
        item={item}
        indexes={indexReviewData(project)}
        contentResolver={projectLocalEvidenceContentResolver(project)}
        onFocusEvidence={vi.fn()}
      />,
    );

    expect(screen.getByText(/Original transcript: Welcomme/)).toBeVisible();
    expect(screen.getByText(/Speaker source: Teacher: Welcomme/)).toBeVisible();
    expect(screen.getByText(new RegExp(`Staged output: ${"9".repeat(64)}`))).toBeVisible();
    const disclosure = screen.getByText("Resolved provider provenance");
    fireEvent.click(disclosure);
    expect(screen.getByLabelText("Resolved provider provenance")).toHaveTextContent("POST /v1/audio/transcriptions");
    expect(screen.getByLabelText("Resolved provider provenance")).toHaveTextContent("responseFormat=diarized_json");
    expect(screen.getByLabelText("Resolved provider provenance")).toHaveTextContent("profile r1");
    expect(screen.getByLabelText("Resolved provider provenance")).toHaveTextContent("speaker-identities-are-chunk-local");
  });
});
