import { describe, expect, it, vi } from "vitest";
import {
  AudioDescriptionGenerationRunner,
  InMemoryAudioDescriptionRunStore,
  buildAudioDescriptionWindows,
  placeAudioDescriptionProposals,
  scopeAudioDescriptionResultIdentities,
  selectEvidenceFrames,
  type AudioDescriptionGenerationDependencies,
  type AudioDescriptionGenerationStartRequest,
} from "./ad-generation";

const digest = (character: string): string => character.repeat(64);

const caption = (input: { readonly itemId: string; readonly startMs: number; readonly endMs: number; readonly text: string }) => ({
  ...input,
  itemRevision: 1,
  state: "Sustained" as const,
});

const request: AudioDescriptionGenerationStartRequest = {
  runId: "run-ad-1",
  projectId: "project-ad-1",
  targetTrack: "AudioDescriptions",
  expectedProjectRevision: 7,
  expectedQualityProfileRevision: 2,
  mediaSha256: digest("a"),
  durationMs: 180_000,
  captions: [
    caption({ itemId: "cue-1", startMs: 2_000, endMs: 21_000, text: "Dr. Nguyen explains the first equation." }),
    caption({ itemId: "cue-2", startMs: 31_000, endMs: 55_000, text: "The class compares the two energy curves." }),
    caption({ itemId: "cue-3", startMs: 90_000, endMs: 122_000, text: "The lecturer returns to the graph." }),
  ],
  sceneTimestamps: [0, 18_000, 49_000, 88_000, 118_000, 155_000],
  frames: Array.from({ length: 14 }, (_, index) => ({
    evidenceId: `frame-${index + 1}`,
    atMs: index * 12_000,
    key: `prepared/operation/thumbnails/${index + 1}.webp`,
    sha256: digest(String(index % 10)),
    mimeType: "image/webp",
    byteLength: 1_024,
  })),
  qualityProfileRules: {
    audioDescription: {
      minDurationMs: 500,
      maxDurationMs: 10_000,
      forbidDialogueCollision: true,
    },
  },
};

describe("audio-description generation", () => {
  it("builds bounded adaptive overlapping windows and never gives a request more than 12 frames", () => {
    const windows = buildAudioDescriptionWindows({
      durationMs: request.durationMs,
      captions: request.captions,
      sceneTimestamps: request.sceneTimestamps,
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]).toMatchObject({ startMs: 0 });
    expect(windows.at(-1)?.endMs).toBe(request.durationMs);
    expect(windows.every((window) => window.endMs > window.startMs)).toBe(true);
    expect(windows.every((window) => window.endMs - window.startMs >= 45_000 && window.endMs - window.startMs <= 90_000)).toBe(true);
    expect(windows.slice(1).every((window, index) => window.startMs < windows[index]!.endMs)).toBe(true);

    for (const window of windows) {
      const frames = selectEvidenceFrames({ window, frames: request.frames });
      expect(frames.length).toBeLessThanOrEqual(12);
      expect(new Set(frames.map((frame) => frame.evidenceId)).size).toBe(frames.length);
    }
    expect(selectEvidenceFrames({
      window: { windowId: "frame-cap", startMs: 0, endMs: 180_000 },
      frames: request.frames,
    })).toHaveLength(12);
  });

  it("never emits a sub-45-second regular tail for a 130-second source", () => {
    const windows = buildAudioDescriptionWindows({
      durationMs: 130_000,
      captions: [],
      sceneTimestamps: [],
    });
    expect(windows).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 90_000 }),
      expect.objectContaining({ startMs: 84_000, endMs: 130_000 }),
    ]);
    expect(windows.every((window) => window.endMs - window.startMs >= 45_000 && window.endMs - window.startMs <= 90_000)).toBe(true);
  });

  it("backs up the final overlapping window when a source is just over the 90-second boundary", () => {
    const windows = buildAudioDescriptionWindows({
      durationMs: 90_001,
      captions: [],
      sceneTimestamps: [],
    });
    expect(windows[0]).toMatchObject({ startMs: 0, endMs: 90_000 });
    expect(windows.at(-1)).toMatchObject({ endMs: 90_001 });
    expect(windows.every((window) => window.endMs - window.startMs >= 45_000 && window.endMs - window.startMs <= 90_000)).toBe(true);
    expect(windows[1]?.startMs).toBe(45_001);
  });

  it("deterministically deduplicates window proposals and only places beats in compatible speech gaps", () => {
    const placed = placeAudioDescriptionProposals({
      durationMs: 15_000,
      captions: [
        caption({ itemId: "cue-1", startMs: 0, endMs: 3_000, text: "Speech one" }),
        caption({ itemId: "cue-2", startMs: 8_000, endMs: 15_000, text: "Speech two" }),
      ],
      proposals: [
        {
          proposalId: "proposal-duplicate-later",
          windowId: "window-2",
          text: "A watershed map fills the screen.",
          rationale: "The map is needed to understand the next comparison.",
          evidenceIds: ["frame-map"],
          placementIntent: { anchorMs: 4_000, desiredDurationMs: 2_500 },
        },
        {
          proposalId: "proposal-map",
          windowId: "window-1",
          text: "A watershed map fills the screen.",
          rationale: "The map is needed to understand the next comparison.",
          evidenceIds: ["frame-map"],
          placementIntent: { anchorMs: 4_000, desiredDurationMs: 2_500 },
        },
      ],
      minDurationMs: 500,
      maxDurationMs: 10_000,
      forbidDialogueCollision: true,
    });

    expect(placed.beats).toEqual([
      expect.objectContaining({ proposalId: "proposal-map", startMs: 3_000, endMs: 5_500 }),
    ]);
    expect(placed.extendedDescriptionRequirements).toEqual([]);
  });

  it("records an extended-description requirement instead of colliding with dialogue", () => {
    const placed = placeAudioDescriptionProposals({
      durationMs: 15_000,
      captions: [caption({ itemId: "cue-all", startMs: 0, endMs: 15_000, text: "Continuous speech" })],
      proposals: [{
        proposalId: "proposal-impossible",
        windowId: "window-1",
        text: "The slide reveals the calculation that the lecturer references.",
        rationale: "The calculation is essential visual information.",
        evidenceIds: ["frame-calculation"],
        placementIntent: { anchorMs: 7_500, desiredDurationMs: 3_000 },
      }],
      minDurationMs: 500,
      maxDurationMs: 10_000,
      forbidDialogueCollision: true,
    });

    expect(placed.beats).toEqual([]);
    expect(placed.extendedDescriptionRequirements).toEqual([
      expect.objectContaining({ proposalId: "proposal-impossible", reason: "no-compatible-speech-gap" }),
    ]);
  });

  it("scopes staged beats, requirements, and retained frames to the immutable run while preserving shared citations", async () => {
    const placed = {
      beats: [{
        proposalId: "window-1-proposal-a",
        windowId: "window-1",
        text: "A map fills the screen.",
        rationale: "The map explains the route.",
        evidenceIds: ["frame-1"],
        placementIntent: { anchorMs: 4_000, desiredDurationMs: 1_000 },
        startMs: 3_000,
        endMs: 4_000,
      }, {
        proposalId: "window-2-proposal-b",
        windowId: "window-2",
        text: "The same map highlights a river.",
        rationale: "The river label is essential context.",
        evidenceIds: ["frame-1"],
        placementIntent: { anchorMs: 8_000, desiredDurationMs: 1_000 },
        startMs: 7_000,
        endMs: 8_000,
      }],
      extendedDescriptionRequirements: [{
        requirementId: "extended-window-3-proposal-c",
        proposalId: "window-3-proposal-c",
        windowId: "window-3",
        text: "A detailed molecular animation appears.",
        rationale: "It cannot fit without covering dialogue.",
        evidenceIds: ["frame-1"],
        reason: "no-compatible-speech-gap" as const,
      }],
    };
    const frames = [request.frames[0]!];
    const first = await scopeAudioDescriptionResultIdentities({ runId: "ad-run-scope-a", placed, frames });
    const second = await scopeAudioDescriptionResultIdentities({ runId: "ad-run-scope-b", placed, frames });

    expect(first.beats.map((beat) => beat.beatId)).toEqual([
      expect.stringMatching(/^ad-beat-[a-f0-9]{48}$/),
      expect.stringMatching(/^ad-beat-[a-f0-9]{48}$/),
    ]);
    expect(first.extendedDescriptionRequirements[0]?.requirementId).toMatch(/^ad-requirement-[a-f0-9]{48}$/);
    expect(first.frames).toHaveLength(2);
    expect(first.frames.every((frame) => /^ad-frame-[a-f0-9]{48}$/.test(frame.evidenceId))).toBe(true);
    expect(new Set(first.beats.map((beat) => beat.beatId)).size).toBe(2);
    // One source screenshot supports several proposals, but each beat gets a
    // deterministic alias so both provenance links resolve independently.
    expect(first.beats[0]?.evidenceIds).not.toEqual(first.beats[1]?.evidenceIds);
    expect(first.beats[0]?.evidenceIds).toEqual(first.extendedDescriptionRequirements[0]?.evidenceIds);
    expect(first.beats[0]?.beatId).not.toBe(second.beats[0]?.beatId);
    expect(first.frames[0]?.evidenceId).not.toBe(second.frames[0]?.evidenceId);
  });

  it("fails closed before any hosted proposal call when caption evidence is absent", async () => {
    const propose = vi.fn();
    const store = new InMemoryAudioDescriptionRunStore();
    const runner = new AudioDescriptionGenerationRunner(store, dependencies({ propose }));

    await expect(runner.run({ ...request, captions: [] })).rejects.toThrow(/caption evidence/i);
    expect(propose).not.toHaveBeenCalled();
  });

  it("persists each bounded window and resumes without a second provider call", async () => {
    const propose = vi.fn(async ({ window }: { readonly window: { readonly windowId: string; readonly startMs: number } }) => [{
      proposalId: `proposal-${window.windowId}`,
      windowId: window.windowId,
      text: `Essential visual at ${window.startMs} milliseconds.`,
      rationale: "The visual communicates information not available in speech.",
      evidenceIds: ["frame-1"],
      placementIntent: { anchorMs: window.startMs + 24_000, desiredDurationMs: 1_500 },
    }]);
    const store = new InMemoryAudioDescriptionRunStore();
    const runner = new AudioDescriptionGenerationRunner(store, dependencies({ propose }));

    await runner.run(request);
    await runner.run(request);

    expect(propose).toHaveBeenCalledTimes(buildAudioDescriptionWindows({
      durationMs: request.durationMs,
      captions: request.captions,
      sceneTimestamps: request.sceneTimestamps,
    }).length);
    expect(store.stageHistory(request.runId).map((entry) => entry.stage)).toEqual([
      "Queued",
      "AnalyzingVisuals",
      "PlacingAudioDescriptions",
      "AwaitingAdoption",
    ]);
    expect(await store.stagedResult(request.runId)).toMatchObject({
      runId: request.runId,
      targetTrack: "AudioDescriptions",
      expectedProjectRevision: request.expectedProjectRevision,
      expectedQualityProfileRevision: request.expectedQualityProfileRevision,
    });
  });
});

const dependencies = (input: {
  readonly propose?: AudioDescriptionGenerationDependencies["proposeWindow"];
} = {}): AudioDescriptionGenerationDependencies => ({
  proposeWindow: input.propose ?? (async ({ window }) => [{
    proposalId: `proposal-${window.windowId}`,
    windowId: window.windowId,
    text: "A diagram appears beside the lecturer.",
    rationale: "The diagram carries essential information absent from speech.",
    evidenceIds: ["frame-1"],
    placementIntent: { anchorMs: window.startMs + 24_000, desiredDurationMs: 1_500 },
  }]),
  clock: () => 1_700_000_000_000,
});
