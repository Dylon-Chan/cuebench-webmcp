import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  applyCommand,
  createProject,
  domainError,
  validateProject,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecord } from "./CourtRecord";
import { ReviewDocket } from "./ReviewDocket";

const human = { type: "Human" as const, id: "human" };

const reviewProject = (): CaptionProject => {
  const project = createProject({
    projectId: "review-project",
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
  const validationRun = validateProject(project);
  return {
    ...project,
    validation: {
      status: "Current",
      blockerCount: validationRun.blockerCount,
      warningCount: validationRun.warningCount,
    },
    validationRun,
  };
};

const selectedProject = (project = reviewProject()): CaptionProject => applyCommand(project, {
  type: "SelectItem",
  actor: human,
  itemId: "c01",
  expectedItemRevision: 1,
  expectedProjectRevision: project.projectRevision,
}).project;

interface ReviewHarnessProps {
  readonly initialProject?: CaptionProject;
  readonly onSeek?: (mediaTimeMs: number) => void;
  readonly onCommand?: (command: DomainCommand, result: CommandResult) => void;
}

function ReviewHarness({ initialProject = reviewProject(), onSeek = vi.fn(), onCommand }: ReviewHarnessProps) {
  const [project, setProject] = useState(initialProject);
  const executeCommand = (command: DomainCommand): CommandResult => {
    const result = applyCommand(project, command);
    onCommand?.(command, result);
    if (result.error === undefined) setProject(result.project);
    return result;
  };

  return (
    <>
      <ReviewDocket project={project} onCommand={executeCommand} onSeekToMediaTime={onSeek} />
      <CourtRecord project={project} />
    </>
  );
}

describe("Review docket human-authority flow", () => {
  it("focuses a finding by selecting its item, seeking the shared video, and retaining stable focus", async () => {
    const onSeek = vi.fn();
    const onCommand = vi.fn();
    render(<ReviewHarness onSeek={onSeek} onCommand={onCommand} />);

    const finding = reviewProject().validationRun?.findings.find((candidate) => (
      candidate.target.type === "item" && candidate.target.itemId === "c01"
    ));
    if (finding === undefined) throw new Error("Expected a fixture-backed C01 quality finding.");

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`focus finding ${finding.findingId}`, "i") }));

    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_000));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SelectItem",
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: 1,
    }), expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("Selected Caption C01");
    expect(screen.getByRole("button", { name: /select caption c01/i })).toHaveFocus();
  });

  it("requires an accessible reason before a human can Object, then records the guarded ruling", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "Object selected revision" }));
    const dialog = await screen.findByRole("dialog", { name: /object caption c01/i });
    const confirm = within(dialog).getByRole("button", { name: "Confirm objection" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Reason for objecting to Caption C01"), {
      target: { value: "The proper name needs review against the source evidence." },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ObjectItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
      reason: "The proper name needs review against the source evidence.",
    }), expect.anything()));
    expect(screen.getByRole("status")).toHaveTextContent("Objected Caption C01");
    expect(document.querySelector(".review-state--objected")).toBeVisible();
  });

  it("records Sustain as a Human-attributed Court Record event and never offers an agent ruling", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} />);

    expect(screen.queryByRole("button", { name: /agent.*sustain/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sustain selected revision" }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SustainItem",
      actor: human,
      itemId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
    }), expect.anything()));
    expect(screen.getByRole("status")).toHaveTextContent("Sustained Caption C01");
    const record = screen.getByRole("region", { name: "Court Record" });
    expect(within(record).getByText("Sustain item")).toBeVisible();
    expect(within(record).getAllByText("Human · human").at(-1)).toBeVisible();
  });

  it("requires confirmation before revising a Sustained item and makes its new immutable revision Proposed", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "Sustain selected revision" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sustain selected revision" })).toBeDisabled());

    fireEvent.change(screen.getByLabelText("Caption text for C01"), {
      target: { value: "Dr. Nguyen introduces Gibbs free energy to the class." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save caption revision" }));
    const dialog = await screen.findByRole("dialog", { name: /revise sustained caption c01/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Proposed revision" }));

    await waitFor(() => expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "ReviseCue",
      actor: human,
      itemId: "c01",
      cueId: "c01",
      expectedItemRevision: 2,
      expectedProjectRevision: 3,
    }), expect.anything()));
    expect(screen.getByRole("status")).toHaveTextContent("Created Proposed revision for Caption C01");
    expect(document.querySelector(".review-state--proposed")).toBeVisible();
    expect(screen.getByText("r3")).toBeVisible();
  });

  it("offers semantic, keyboard-operable docket equivalents for timeline selection, seek, and timing adjustment", () => {
    render(<ReviewHarness initialProject={selectedProject()} />);

    const list = screen.getByRole("list", { name: "Review items" });
    expect(within(list).getByRole("button", { name: /select caption c01/i })).toBeVisible();
    expect(within(list).getByRole("button", { name: /select caption c02/i })).toBeVisible();
    expect(within(list).getByRole("button", { name: /select audio description ad01/i })).toBeVisible();
    expect(screen.getByLabelText("Start time for Caption C01")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("End time for Caption C01")).toHaveAttribute("type", "number");
    expect(screen.getByRole("button", { name: "Apply timing for Caption C01" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Seek Caption C01 in source video" })).toBeVisible();
  });

  it("announces stale conflicts through an assertive live region without pretending a failed ruling succeeded", async () => {
    const project = selectedProject();
    const onCommand = vi.fn((command: DomainCommand): CommandResult => ({
      project,
      events: [],
      error: domainError("STALE_PROJECT", `Project revision ${command.expectedProjectRevision} is no longer current.`),
    }));
    render(
      <ReviewDocket
        project={project}
        onCommand={onCommand}
        onSeekToMediaTime={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sustain selected revision" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Project revision 2 is no longer current.");
    expect(document.querySelector(".review-state--sustained")).not.toBeInTheDocument();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SustainItem",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
    }));
  });
});
