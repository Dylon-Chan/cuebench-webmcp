import { fireEvent, render, screen } from "@testing-library/react";
import { createProject, type CaptionProject } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";

const timelineProject = (): CaptionProject => createProject({
  projectId: "timeline-project",
  title: "Timeline lesson",
  media: {
    sourceId: "lesson-video",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "c01",
    state: "Proposed",
    startMs: 10_000,
    endMs: 15_000,
    text: "Dr. Nguyen introduces Gibbs free energy.",
    speaker: "Dr. Nguyen",
    actor: { type: "CueBenchAI", id: "cuebench-ai" },
    cause: "fixture",
  }],
  audioDescriptions: [{
    kind: "AudioDescriptionBeat",
    itemId: "ad01",
    state: "Proposed",
    startMs: 20_000,
    endMs: 24_000,
    description: "A downward energy curve appears beside the lecturer.",
    actor: { type: "CueBenchAI", id: "cuebench-ai" },
    cause: "fixture",
  }],
});

const renderTimeline = (overrides: Partial<React.ComponentProps<typeof Timeline>> = {}) => {
  const onCommand = vi.fn().mockResolvedValue(undefined);
  const seekToMediaTime = vi.fn();
  const view = render(
    <Timeline
      project={timelineProject()}
      playheadMs={12_000}
      seekToMediaTime={seekToMediaTime}
      onCommand={onCommand}
      viewportWidth={900}
      {...overrides}
    />,
  );
  return { ...view, onCommand, seekToMediaTime };
};

describe("Timeline", () => {
  it("keeps cue selection and video seeking on the same Media Time", () => {
    const { onCommand, seekToMediaTime } = renderTimeline();

    fireEvent.click(screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i }));

    expect(seekToMediaTime).toHaveBeenCalledWith(10_000);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SelectItem",
      itemId: "c01",
      expectedItemRevision: 1,
    }));
    expect(screen.getByTestId("timeline-playhead")).toHaveAttribute("data-media-time-ms", "12000");
  });

  it("commits exactly one integer timing command when a drag ends", () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("button", { name: "Adjust start of caption C01" });
    const surface = screen.getByTestId("timeline-surface");
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 900, height: 200, right: 900, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 110 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "AdjustCueTiming",
      cueId: "c01",
      startMs: expect.any(Number),
    }));
    const command = onCommand.mock.calls[0]?.[0] as { startMs: number };
    expect(Number.isInteger(command.startMs)).toBe(true);
  });

  it("uses one keyboard-release commit and retains semantic alternatives to the canvas", () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("button", { name: "Adjust end of caption C01" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", cueId: "c01" }));
    expect(screen.getByTestId("waveform-canvas")).toBeInstanceOf(HTMLCanvasElement);
    expect(screen.getByRole("slider", { name: "Seek source media" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^audio description ad01:/i })).toBeVisible();
  });

  it("reprojects lanes when the viewport width changes", () => {
    const { rerender } = renderTimeline({ viewportWidth: 600 });
    const cue = screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i });
    const narrowLeft = cue.closest("li")?.style.left;

    rerender(
      <Timeline
        project={timelineProject()}
        playheadMs={12_000}
        seekToMediaTime={vi.fn()}
        onCommand={vi.fn()}
        viewportWidth={1_200}
      />,
    );

    expect(cue.closest("li")?.style.left).not.toBe(narrowLeft);
  });
});
