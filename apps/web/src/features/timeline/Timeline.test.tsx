import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
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

const adjacentOneSecondCueProject = (): CaptionProject => createProject({
  projectId: "exact-width-project",
  title: "Exact timeline width",
  media: {
    sourceId: "exact-width-video",
    sha256: "b".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [
    {
      kind: "CaptionCue",
      itemId: "c01",
      state: "Proposed",
      startMs: 10_000,
      endMs: 11_000,
      text: "One second cue.",
      speaker: "Dr. Nguyen",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
    {
      kind: "CaptionCue",
      itemId: "c02",
      state: "Proposed",
      startMs: 11_000,
      endMs: 12_000,
      text: "Adjacent cue.",
      speaker: "Dr. Nguyen",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
  ],
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
  it("delegates item selection to a review authority when one owns a dirty draft", () => {
    const onRequestItemNavigation = vi.fn();
    const { onCommand } = renderTimeline({ onRequestItemNavigation });

    fireEvent.click(screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i }));

    expect(onRequestItemNavigation).toHaveBeenCalledWith("c01", "timeline caption C01");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("locks the production reviewDraftActive command path before a timing edit can be issued", () => {
    const { onCommand } = renderTimeline({ reviewDraftActive: true });
    const cue = screen.getByRole("button", { name: /caption c01: dr\. nguyen introduces/i });
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });

    expect(cue).toBeDisabled();
    expect(handle).toBeDisabled();
    expect(screen.getByText(/save, discard, or cancel the visible review draft/i)).toHaveAttribute("role", "status");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(onCommand).not.toHaveBeenCalled();
  });

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

  it("continues tracking a drag after intent is established, but does not commit after returning to its original timing", () => {
    const { onCommand } = renderTimeline();
    const handle = screen.getByRole("slider", { name: "Adjust start of caption C01" });
    const surface = screen.getByTestId("timeline-surface");
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 900, height: 200, right: 900, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 });
    expect(screen.getByTestId("timeline-preview-feedback")).toHaveTextContent("0:13.000");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(screen.getByTestId("timeline-preview-feedback")).toHaveTextContent("0:10.000 to 0:15.000");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 });

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
    expect(handle).toHaveAttribute("aria-valuemax", "14999");
    expect(handle).toHaveAttribute("aria-valuenow", "10000");
    expect(handle).toHaveAttribute("aria-valuetext", "Start time 0:10.000");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 });
    expect(screen.getByTestId("timeline-preview-feedback")).toHaveTextContent("Caption C01 start preview");
  });

  it("keeps projected one-second cue bounds exact at 90 seconds / 900 pixels without overlap", () => {
    renderTimeline({ project: adjacentOneSecondCueProject() });
    const first = screen.getByRole("button", { name: /caption c01: one second cue/i }).closest("li");
    const second = screen.getByRole("button", { name: /caption c02: adjacent cue/i }).closest("li");
    if (first === null || second === null) throw new Error("Expected projected cue lane items.");

    expect(first.style.left).toBe("100px");
    expect(first.style.width).toBe("10px");
    expect(second.style.left).toBe("110px");
    expect(second.style.width).toBe("10px");
    expect(Number.parseFloat(first.style.left) + Number.parseFloat(first.style.width)).toBeLessThanOrEqual(Number.parseFloat(second.style.left));
    expect(readFileSync(`${process.cwd()}/src/styles/index.css`, "utf8")).toMatch(/\.timeline-item\s*\{[^}]*min-width:\s*0;/s);
  });

  it("uses a 44px mobile finding target while retaining its centered timestamp marker", () => {
    const stylesheet = readFileSync(`${process.cwd()}/src/styles/index.css`, "utf8");
    const mobileStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 540px)"));

    expect(mobileStyles).toContain(".timeline-finding { width: 44px; min-width: 44px; height: 44px; min-height: 44px; }");
    expect(mobileStyles).toContain(".timeline-finding::before { top: 17px; left: 17px; }");
  });

  it("uses legal Caption and audio-description slider bounds and commits each supported key once", async () => {
    const { onCommand } = renderTimeline();
    const captionStart = screen.getByRole("slider", { name: "Adjust start of caption C01" });
    const captionEnd = screen.getByRole("slider", { name: "Adjust end of caption C01" });
    const adStart = screen.getByRole("slider", { name: "Adjust start of audio description AD01" });
    const adEnd = screen.getByRole("slider", { name: "Adjust end of audio description AD01" });

    expect(captionStart).toHaveAttribute("aria-valuemin", "0");
    expect(captionStart).toHaveAttribute("aria-valuemax", "14999");
    expect(captionEnd).toHaveAttribute("aria-valuemin", "10001");
    expect(captionEnd).toHaveAttribute("aria-valuemax", "90000");
    expect(adStart).toHaveAttribute("aria-valuemax", "23999");
    expect(adEnd).toHaveAttribute("aria-valuemin", "20001");

    fireEvent.keyDown(captionStart, { key: "ArrowLeft" });
    fireEvent.keyUp(captionStart, { key: "ArrowLeft" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", startMs: 9_900 }));

    fireEvent.keyDown(captionStart, { key: "ArrowDown" });
    fireEvent.keyUp(captionStart, { key: "ArrowDown" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", startMs: 9_900 }));

    fireEvent.keyDown(captionEnd, { key: "ArrowRight" });
    fireEvent.keyUp(captionEnd, { key: "ArrowRight" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", endMs: 15_100 }));

    fireEvent.keyDown(captionEnd, { key: "End" });
    fireEvent.keyUp(captionEnd, { key: "End" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(4));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustCueTiming", endMs: 90_000 }));

    fireEvent.keyDown(adStart, { key: "ArrowUp" });
    fireEvent.keyUp(adStart, { key: "ArrowUp" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(5));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustAudioDescriptionTiming", startMs: 20_100 }));

    fireEvent.keyDown(adEnd, { key: "Home" });
    fireEvent.keyUp(adEnd, { key: "Home" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(6));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AdjustAudioDescriptionTiming", endMs: 20_001 }));
    expect(screen.getByTestId("timeline-accepted-feedback")).toHaveTextContent("Audio description AD01 timing updated");
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
