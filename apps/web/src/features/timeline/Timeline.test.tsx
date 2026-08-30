import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  applyCommand,
  createProject,
  domainError,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
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

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const renderTimeline = (overrides: Partial<React.ComponentProps<typeof Timeline>> = {}) => {
  const project = overrides.project ?? timelineProject();
  const onCommand = vi.fn((command: DomainCommand) => Promise.resolve(applyCommand(project, command)));
  const seekToMediaTime = vi.fn();
  const view = render(
    <Timeline
      project={project}
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
  it("keeps cue selection and video seeking on the same Media Time after the canonical command accepts", async () => {
    const { onCommand, seekToMediaTime } = renderTimeline();

    fireEvent.click(screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i }));

    await waitFor(() => expect(seekToMediaTime).toHaveBeenCalledWith(10_000));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SelectItem",
      itemId: "c01",
      expectedItemRevision: 1,
    }));
    expect(screen.getByTestId("timeline-playhead")).toHaveAttribute("data-media-time-ms", "12000");
  });

  it("commits exactly one integer timing command when a moved drag ends without snapping its grab offset", async () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });
    const surface = screen.getByTestId("timeline-surface");
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 900, height: 200, right: 900, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 110 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 });

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "AdjustCueTiming",
      cueId: "c01",
      startMs: 11_000,
    }));
    const command = onCommand.mock.calls[0]?.[0] as { startMs: number };
    expect(Number.isInteger(command.startMs)).toBe(true);
  });

  it("uses one keyboard-release commit and retains semantic alternatives to the canvas", async () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("slider", { name: "Adjust end of caption C01" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });

    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", cueId: "c01" }));
    expect(screen.getByTestId("waveform-canvas")).toBeInstanceOf(HTMLCanvasElement);
    expect(screen.getByRole("slider", { name: "Seek source media" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^audio description ad01:/i })).toBeVisible();
  });

  it("does not commit a simple handle click, a sub-threshold movement, or a cancelled drag", () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 102 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 102 });
    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 130 });
    fireEvent.pointerCancel(handle, { pointerId: 3 });

    expect(onCommand).not.toHaveBeenCalled();
  });

  it("waits for accepted canonical state before seeking and serializes an immediate edit interaction", async () => {
    const project = timelineProject();
    const gate = deferred<CommandResult>();
    const onCommand = vi.fn((command: DomainCommand) => {
      void command;
      return gate.promise;
    });
    const { seekToMediaTime } = renderTimeline({ project, onCommand });
    const cue = screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i });
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });

    fireEvent.click(cue);

    expect(seekToMediaTime).not.toHaveBeenCalled();
    expect(handle).toBeDisabled();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 130 });
    expect(onCommand).toHaveBeenCalledTimes(1);

    const command = onCommand.mock.calls[0]?.[0];
    if (command === undefined) throw new Error("The selection command was not issued.");
    gate.resolve(applyCommand(project, command));

    await waitFor(() => expect(seekToMediaTime).toHaveBeenCalledWith(10_000));
    expect(cue).toHaveFocus();
  });

  it("surfaces a stale command without moving the authoritative video clock", async () => {
    const project = timelineProject();
    const onCommand = vi.fn(() => Promise.resolve({
      project,
      events: [],
      error: domainError("STALE_PROJECT", "The project revision is no longer current."),
    }));
    const { seekToMediaTime } = renderTimeline({ project, onCommand });

    fireEvent.click(screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The project revision is no longer current.");
    expect(seekToMediaTime).not.toHaveBeenCalled();
  });

  it("exposes selected items, timing slider values, and live timing previews semantically", () => {
    const initial = timelineProject();
    const selectedProject = applyCommand(initial, {
      type: "SelectItem",
      actor: { type: "Human", id: "human" },
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: initial.projectRevision,
    }).project;
    renderTimeline({ project: selectedProject });

    const cue = screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i });
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });
    expect(cue).toHaveAttribute("aria-current", "true");
    expect(handle).toHaveAttribute("aria-valuemin", "0");
    expect(handle).toHaveAttribute("aria-valuemax", "90000");
    expect(handle).toHaveAttribute("aria-valuenow", "10000");
    expect(handle).toHaveAttribute("aria-valuetext", "Start time 0:10.000");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 });
    expect(screen.getByTestId("timeline-preview-feedback")).toHaveTextContent("Caption C01 start preview");
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

  it("stores clamped viewport endpoints while zooming and panning", () => {
    renderTimeline({ playheadMs: 90_000 });
    const surface = screen.getByTestId("timeline-surface");

    fireEvent.click(screen.getByRole("button", { name: "Zoom timeline in" }));
    expect(surface).toHaveAttribute("data-viewport-start-ms", "45000");

    fireEvent.click(screen.getByRole("button", { name: "Pan timeline later" }));
    expect(surface).toHaveAttribute("data-viewport-start-ms", "45000");

    fireEvent.click(screen.getByRole("button", { name: "Pan timeline earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Pan timeline earlier" }));
    expect(surface).toHaveAttribute("data-viewport-start-ms", "0");
  });
});
