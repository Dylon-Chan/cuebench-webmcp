import { createProject, type CaptionCue, type CaptionCueRevision, type CaptionProject } from "../src/index";

export const fixtureProject = (options: {
  cueState?: "Proposed" | "AgentReady" | "Objected" | "Sustained";
  itemRevision?: number;
  projectRevision?: number;
} = {}): CaptionProject => {
  const itemRevision = options.itemRevision ?? 1;
  const currentState = options.cueState ?? "Proposed";
  const project = createProject({
    projectId: "project-1",
    title: "Gibbs free energy lecture",
    media: {
      sourceId: "media-1",
      sha256: "a".repeat(64),
      durationMs: 60_000,
      relinkState: "Linked",
    },
    captions: [
      {
        kind: "CaptionCue",
        itemId: "c05",
        state: currentState,
        startMs: 1_000,
        endMs: 3_000,
        text: "Doctor Nguyen explains free energy.",
        speaker: "Dr. Nguyen",
        actor: { type: "BrowserAgent", id: "browser-agent" },
        cause: "fixture",
      },
      {
        kind: "CaptionCue",
        itemId: "c06",
        state: "Proposed",
        startMs: 3_000,
        endMs: 5_000,
        text: "The reaction is spontaneous.",
        speaker: "Dr. Nguyen",
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
        description: "A diagram shows the energy curve.",
        actor: { type: "CueBenchAI", id: "cuebench-ai" },
        cause: "fixture",
      },
    ],
  });
  const base = project.captions.items.c05;
  if (base === undefined) throw new Error("fixture cue missing");
  const revisions: CaptionCueRevision[] = [];
  for (let revision = 1; revision <= itemRevision; revision += 1) {
    revisions.push({
      ...base.current,
      itemRevision: revision,
      state: revision === itemRevision ? currentState : "Proposed",
      parentItemRevision: revision === 1 ? null : revision - 1,
    });
  }
  const cue: CaptionCue = { ...base, revisions, current: revisions[revisions.length - 1]! };
  return {
    ...project,
    projectRevision: options.projectRevision ?? 1,
    captions: { ...project.captions, items: { ...project.captions.items, c05: cue } },
  };
};
