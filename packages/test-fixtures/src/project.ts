import { createProject, type CaptionProject } from "@cuebench/domain";

export const fixtureProject = (): CaptionProject => createProject({
  projectId: "lesson-project",
  title: "Gibbs free energy lesson",
  media: {
    sourceId: "lesson-video",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [
    {
      kind: "CaptionCue",
      itemId: "c01",
      state: "Proposed",
      startMs: 1_000,
      endMs: 3_500,
      text: "Dr. Nguyen introduces Gibbs free energy.",
      speaker: "Dr. Nguyen",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
    {
      kind: "CaptionCue",
      itemId: "c02",
      state: "Proposed",
      startMs: 3_500,
      endMs: 5_000,
      text: "The diagram is silent for a moment.",
      speaker: null,
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
  ],
  audioDescriptions: [
    {
      kind: "AudioDescriptionBeat",
      itemId: "ad01",
      state: "Proposed",
      startMs: 6_000,
      endMs: 8_000,
      description: "A downward energy curve appears beside the lecturer.",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
  ],
});

export const fixtureCaptionTrack = () => fixtureProject().captions;
export const fixtureAudioDescriptionTrack = () => fixtureProject().audioDescriptions;
