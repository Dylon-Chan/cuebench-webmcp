import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProject, type AudioDescriptionBeat } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NARRATION_INSTRUCTIONS,
  NarrationPreview,
  type NarrationPreviewGateway,
  type NarrationPreviewSynthesis,
} from "./NarrationPreview";

const digest = (character: string): string => character.repeat(64);

const beat = (): AudioDescriptionBeat => createProject({
  projectId: "preview-project",
  title: "Narration preview fixture",
  media: { sourceId: "source", sha256: digest("a"), durationMs: 20_000, relinkState: "Linked" },
  audioDescriptions: [{
    kind: "AudioDescriptionBeat",
    itemId: "ad01",
    state: "Proposed",
    startMs: 4_000,
    endMs: 6_500,
    description: "A watershed map fills the screen.",
    actor: { type: "CueBenchAI", id: "cuebench-ai" },
    cause: "fixture",
  }],
}).audioDescriptions.items.ad01!;

const gateway = (overrides: Partial<NarrationPreviewGateway> = {}): NarrationPreviewGateway => ({
  loadCached: vi.fn(async () => undefined),
  saveCached: vi.fn(async () => undefined),
  synthesize: vi.fn(async (): Promise<NarrationPreviewSynthesis> => ({
    blob: new Blob(["fixture narration"], { type: "audio/wav" }),
    contentType: "audio/wav",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    responseFormat: "wav",
    store: null,
    warnings: ["fixture-narration-preview"],
  })),
  measureDurationMs: vi.fn(async () => 1_750),
  createObjectUrl: vi.fn(() => "blob:cuebench:narration"),
  revokeObjectUrl: vi.fn(),
  ...overrides,
});

describe("NarrationPreview", () => {
  it("uses a complete-input cache key, measures the returned audio, and makes its non-certification boundary visible", async () => {
    const preview = gateway();
    render(<NarrationPreview projectId="preview-project" beat={beat()} gateway={preview} />);

    expect(screen.getByText(/synthetic voice preview/i)).toBeVisible();
    expect(screen.getByText(/not certification evidence/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Generate narration preview" }));

    await waitFor(() => expect(preview.synthesize).toHaveBeenCalledTimes(1));
    expect(preview.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      beatId: "ad01",
      itemRevision: 1,
      text: "A watershed map fills the screen.",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      instructions: DEFAULT_NARRATION_INSTRUCTIONS,
      responseFormat: "wav",
      speed: 1,
      cacheKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    await waitFor(() => expect(preview.saveCached).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "preview-project",
      beatId: "ad01",
      itemRevision: 1,
      measuredDurationMs: 1_750,
      cacheKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    })));
    expect(screen.getByText("1.75 s measured preview")).toBeVisible();
    expect(screen.getByText(/750 ms spare in this beat/i)).toBeVisible();
    expect(screen.getByText(/does not certify the beat/i)).toBeVisible();
    expect(screen.getByLabelText("Narration preview for AD01")).toHaveAttribute("src", "blob:cuebench:narration");
  });

  it("reports an overrun as a revision-fenced review-only fit delta", async () => {
    const preview = gateway({ measureDurationMs: vi.fn(async () => 3_000) });
    render(<NarrationPreview projectId="preview-project" beat={beat()} gateway={preview} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate narration preview" }));

    await waitFor(() => expect(screen.getByText(/overruns this beat's dialogue-free slot by 500 ms/i)).toBeVisible());
    expect(screen.getByText(/review-only delta does not certify/i)).toBeVisible();
  });

  it("reuses only a full-input cache hit and does not re-synthesize", async () => {
    const preview = gateway({
      loadCached: vi.fn(async () => ({
        blob: new Blob(["cached narration"], { type: "audio/wav" }),
        contentType: "audio/wav",
        measuredDurationMs: 2_000,
      })),
    });
    render(<NarrationPreview projectId="preview-project" beat={beat()} gateway={preview} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate narration preview" }));

    await waitFor(() => expect(preview.loadCached).toHaveBeenCalledTimes(1));
    expect(preview.synthesize).not.toHaveBeenCalled();
    expect(preview.saveCached).not.toHaveBeenCalled();
    expect(screen.getByText("2.00 s measured preview")).toBeVisible();
    expect(screen.getByText(/cached in this browser/i)).toBeVisible();
  });

  it("does not commit a late preview for an obsolete beat revision", async () => {
    const pending: { resolve?: (value: NarrationPreviewSynthesis) => void } = {};
    const preview = gateway({
      synthesize: vi.fn(() => new Promise<NarrationPreviewSynthesis>((resolve) => { pending.resolve = resolve; })),
    });
    const rendered = render(<NarrationPreview projectId="preview-project" beat={beat()} gateway={preview} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate narration preview" }));
    await waitFor(() => expect(preview.synthesize).toHaveBeenCalledTimes(1));
    const revised = {
      ...beat(),
      current: { ...beat().current, itemRevision: 2, description: "A revised map fills the screen." },
      revisions: [...beat().revisions, { ...beat().current, itemRevision: 2, description: "A revised map fills the screen.", parentItemRevision: 1 }],
    };
    rendered.rerender(<NarrationPreview projectId="preview-project" beat={revised} gateway={preview} />);
    if (pending.resolve === undefined) throw new Error("Expected narration synthesis to be pending.");
    pending.resolve({
      blob: new Blob(["late narration"], { type: "audio/wav" }),
      contentType: "audio/wav",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      responseFormat: "wav" as const,
      store: null,
      warnings: [],
    });

    await waitFor(() => expect(preview.measureDurationMs).toHaveBeenCalledTimes(1));
    expect(preview.saveCached).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Narration preview for AD01")).not.toBeInTheDocument();
    expect(screen.getByText(/changed while CueBench was preparing/i)).toBeVisible();
  });
});
