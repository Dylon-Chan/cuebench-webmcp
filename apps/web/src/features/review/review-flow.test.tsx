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
import { useRef, useState } from "react";
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
    evidence: [
      {
        evidenceId: "evidence-c01-r1",
        projectId: "review-project",
        mediaSha256: "a".repeat(64),
        itemId: "c01",
        itemRevision: 1,
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

const objectedProject = (): CaptionProject => applyCommand(selectedProject(), {
  type: "ObjectItem",
  actor: human,
  itemId: "c01",
  expectedItemRevision: 1,
  expectedProjectRevision: 2,
  reason: "Fixture objection for navigation testing.",
}).project;

const sustainedProject = (): CaptionProject => applyCommand(selectedProject(), {
  type: "SustainItem",
  actor: human,
  itemId: "c01",
  expectedItemRevision: 1,
  expectedProjectRevision: 2,
}).project;

const largeReviewProject = (): CaptionProject => {
  const project = createProject({
    projectId: "large-review-project",
    title: "Large review docket fixture",
    media: {
      sourceId: "large-review-video",
      sha256: "b".repeat(64),
      durationMs: 100_000,
      relinkState: "Linked",
    },
    captions: Array.from({ length: 500 }, (_, index) => ({
      kind: "CaptionCue" as const,
      itemId: `c${String(index + 1).padStart(3, "0")}`,
      state: "Proposed" as const,
      startMs: index * 200,
      endMs: (index + 1) * 200,
      text: `Fixture cue ${index + 1}.`,
      speaker: null,
      actor: { type: "CueBenchAI" as const, id: "cuebench-ai" },
      cause: "fixture",
    })),
  });
  return applyCommand(project, {
    type: "SelectItem",
    actor: human,
    itemId: "c500",
    expectedItemRevision: 1,
    expectedProjectRevision: 1,
  }).project;
};

interface ReviewHarnessProps {
  readonly initialProject?: CaptionProject;
  readonly onSeek?: (mediaTimeMs: number) => void;
  readonly onCommand?: (command: DomainCommand, result: CommandResult) => void;
  readonly onReadNativePlayheadMs?: () => number;
}

function ReviewHarness({ initialProject = reviewProject(), onSeek = vi.fn(), onCommand, onReadNativePlayheadMs }: ReviewHarnessProps) {
  const [project, setProject] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const reviewNavigationRef = useRef<(itemId: string, sourceLabel: string) => void>(() => undefined);
  const executeCommand = (command: DomainCommand): CommandResult => {
    const result = applyCommand(projectRef.current, command);
    onCommand?.(command, result);
    if (result.error === undefined) {
      projectRef.current = result.project;
      setProject(result.project);
    }
    return result;
  };

  return (
    <>
      <ReviewDocket
        project={project}
        onCommand={executeCommand}
        onSeekToMediaTime={onSeek}
        onRegisterItemNavigation={(navigate) => { reviewNavigationRef.current = navigate; }}
        {...(onReadNativePlayheadMs === undefined ? {} : { onReadNativePlayheadMs })}
      />
      <CourtRecord project={project} onSelectItem={(itemId) => reviewNavigationRef.current(itemId, `Court Record item ${itemId.toUpperCase()}`)} />
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

  it("keeps a dirty draft in the docket, blocks rulings, and requires an explicit discard before changing items", async () => {
    render(<ReviewHarness initialProject={selectedProject()} />);

    fireEvent.change(screen.getByLabelText("Caption text for C01"), {
      target: { value: "Unsaved caption draft." },
    });

    expect(screen.getByRole("button", { name: "Object selected revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sustain selected revision" })).toBeDisabled();
    expect(screen.getByText(/save or discard the draft before a human ruling/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    const dialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    expect(within(dialog).getByRole("button", { name: /save changes and continue/i })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel navigation/i }));
    expect(screen.getByLabelText("Caption text for C01")).toHaveValue("Unsaved caption draft.");

    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard draft and continue/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /selected caption c02/i })).toBeVisible());
  });

  it("replaces the dirty-navigation dialog with one Sustained revision confirmation", async () => {
    render(<ReviewHarness initialProject={sustainedProject()} />);
    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Corrected sustained draft." } });
    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    const dirtyDialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    fireEvent.click(within(dirtyDialog).getByRole("button", { name: /save changes and continue/i }));

    expect(await screen.findByRole("dialog", { name: /revise sustained caption c01/i })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /unsaved review draft/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Proposed revision" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /selected caption c02/i })).toBeVisible());
  });

  it("offers complete semantic caption controls for legal split and adjacent merge commands", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} />);

    fireEvent.change(screen.getByLabelText("Split point for Caption C01"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Split Caption C01" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SplitCue",
      cueId: "c01",
      splitMs: 2_000,
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
    }), expect.anything()));
  });

  it("merges only the actual adjacent caption with expected revisions", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "Merge Caption C01 with C02" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "MergeCue",
      cueId: "c01",
      adjacentCueId: "c02",
      expectedItemRevision: 1,
      expectedAdjacentItemRevision: 1,
      expectedProjectRevision: 2,
    }), expect.anything()));
  });

  it("uses the native playhead as a numeric, validated caption split point", async () => {
    const onCommand = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onCommand={onCommand} onReadNativePlayheadMs={() => 2_000} />);

    fireEvent.click(screen.getByRole("button", { name: "Use native playhead for split" }));
    expect(screen.getByLabelText("Split point for Caption C01")).toHaveValue(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Split Caption C01" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "SplitCue",
      splitMs: 2_000,
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
    }), expect.anything()));
  });

  it("renders immutable payload details and focuses a retained evidence binding without fabricating its window", async () => {
    const onSeek = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onSeek={onSeek} />);

    fireEvent.click(screen.getByRole("button", { name: "Show immutable payload for C01 r1" }));
    expect(screen.getAllByText("Dr. Nguyen introduces Gibbs free energy.").at(-1)).toBeVisible();
    expect(screen.getByText("1,000–3,500 ms")).toBeVisible();
    expect(screen.getByText("Speaker: Dr. Nguyen")).toBeVisible();
    expect(screen.getByText(/no bounded evidence window was captured/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open evidence evidence-c01-r1" }));
    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_000));
    expect(document.getElementById("evidence-evidence-c01-r1")).toHaveFocus();
  });

  it("clears an incompatible filter before a finding reveals and focuses its target", async () => {
    const onSeek = vi.fn();
    const project = objectedProject();
    const finding = project.validationRun?.findings.find((candidate) => candidate.target.type === "item" && candidate.target.itemId === "c01");
    if (finding === undefined) throw new Error("Expected a fixture-backed C01 quality finding.");
    render(<ReviewHarness initialProject={project} onSeek={onSeek} />);

    fireEvent.click(screen.getByRole("button", { name: "Proposed" }));
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`focus finding ${finding.findingId}`, "i") })[0]!);

    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_000));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /select caption c01/i })).toHaveFocus();
  });

  it("routes Court Record item targets through the same dirty-draft confirmation", async () => {
    const c2Selected = applyCommand(selectedProject(), {
      type: "SelectItem",
      actor: human,
      itemId: "c02",
      expectedItemRevision: 1,
      expectedProjectRevision: 2,
    }).project;
    render(<ReviewHarness initialProject={c2Selected} />);

    fireEvent.change(screen.getByLabelText("Caption text for C02"), { target: { value: "Unsaved c02 draft." } });
    const record = screen.getByRole("region", { name: "Court Record" });
    fireEvent.click(within(record).getByRole("button", { name: "Select current C01 r1" }));
    expect(await screen.findByRole("dialog", { name: /unsaved review draft/i })).toBeVisible();
    expect(screen.getByLabelText("Caption text for C02")).toHaveValue("Unsaved c02 draft.");
  });

  it("keeps the Court Record history reachable through its Show all control", () => {
    let project = reviewProject();
    for (const itemId of ["c01", "c02", "c01", "c02", "c01"]) {
      project = applyCommand(project, {
        type: "SelectItem",
        actor: human,
        itemId,
        expectedItemRevision: 1,
        expectedProjectRevision: project.projectRevision,
      }).project;
    }
    render(<CourtRecord project={project} onSelectItem={vi.fn()} />);

    const record = screen.getByRole("region", { name: "Court Record" });
    expect(within(record).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(within(record).getByRole("button", { name: "Show all 5" }));
    expect(within(record).getAllByRole("listitem")).toHaveLength(5);
    expect(within(record).getByRole("button", { name: "Show latest" })).toBeVisible();
  });

  it("keeps Object and Sustained-revision dialogs open when a command returns null or throws", async () => {
    const project = sustainedProject();
    const nullCommand = vi.fn(() => null as unknown as CommandResult);
    const { unmount } = render(
      <ReviewDocket project={project} onCommand={nullCommand} onSeekToMediaTime={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Changed sustained caption." } });
    fireEvent.click(screen.getByRole("button", { name: "Save caption revision" }));
    const sustainedDialog = await screen.findByRole("dialog", { name: /revise sustained caption c01/i });
    fireEvent.click(within(sustainedDialog).getByRole("button", { name: "Create Proposed revision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not return an accepted result/i);
    expect(screen.getByRole("dialog", { name: /revise sustained caption c01/i })).toBeVisible();
    fireEvent.click(within(screen.getByRole("dialog", { name: /revise sustained caption c01/i })).getByRole("button", { name: "Cancel" }));

    const throwingCommand = vi.fn(() => { throw new Error("Store offline"); });
    unmount();
    render(<ReviewDocket project={selectedProject()} onCommand={throwingCommand} onSeekToMediaTime={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Object selected revision" }));
    const objectDialog = await screen.findByRole("dialog", { name: /object caption c01/i });
    fireEvent.change(within(objectDialog).getByLabelText("Reason for objecting to Caption C01"), { target: { value: "Needs source review." } });
    fireEvent.click(within(objectDialog).getByRole("button", { name: "Confirm objection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Store offline");
    expect(screen.getByRole("dialog", { name: /object caption c01/i })).toBeVisible();
  });

  it("marks invalid draft fields accessibly and windows only long semantic dockets while retaining selected focus", async () => {
    const { unmount: unmountInvalidDraft } = render(<ReviewHarness initialProject={selectedProject()} />);
    fireEvent.change(screen.getByLabelText("Start time for Caption C01"), { target: { value: "3500" } });
    fireEvent.change(screen.getByLabelText("End time for Caption C01"), { target: { value: "2000" } });
    expect(screen.getByLabelText("Start time for Caption C01")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/start time must be earlier than end time/i)).toBeVisible();

    unmountInvalidDraft();
    const { unmount } = render(<ReviewHarness initialProject={largeReviewProject()} />);
    const list = screen.getAllByRole("list", { name: "Review items" }).at(-1);
    expect(list).toHaveAttribute("aria-label", "Review items");
    expect(within(list!).getAllByRole("listitem").length).toBeLessThan(80);
    await waitFor(() => expect(within(list!).getByRole("button", { name: /select caption c500/i })).toHaveFocus());
    unmount();
  });
});
