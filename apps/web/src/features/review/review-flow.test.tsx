import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  applyCommand,
  createProject,
  domainError,
  validateProject,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecord } from "./CourtRecord";
import type { NarrationPreviewGateway } from "./NarrationPreview";
import { createDocketWindowLayout, ReviewDocket } from "./ReviewDocket";
import { orderedReviewItems } from "./review-utils";
import type { EvidenceContentResolver } from "../evidence/EvidenceInspector";

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
      text: `Fixture cue ${index + 1}. ${"Complete retained test prose. ".repeat((index % 5) + 1)}`,
      speaker: null,
      actor: { type: "CueBenchAI" as const, id: "cuebench-ai" },
      cause: "fixture",
    })),
    evidence: Array.from({ length: 250 }, (_, index) => ({
      evidenceId: `fixture-evidence-${index + 1}`,
      projectId: "large-review-project",
      mediaSha256: "b".repeat(64),
      itemId: `c${String(index * 2 + 1).padStart(3, "0")}`,
      itemRevision: 1,
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
  readonly evidenceContentResolver?: EvidenceContentResolver;
  readonly onTimelineRebaseReady?: (
    rebase: (itemId: string, previousItemRevision: number, project: CaptionProject) => void,
    acceptProject: (project: CaptionProject) => void,
  ) => void;
  readonly commandOverride?: (command: DomainCommand, result: CommandResult) => CommandResult;
  readonly narrationPreviewGateway?: NarrationPreviewGateway;
  readonly onBrowserAgentFocusReady?: (focus: (input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number; readonly evidenceId?: string; readonly visualEpoch?: number; readonly signal?: AbortSignal }) => Promise<boolean>) => void;
  readonly onBrowserAgentSelectionPreflightReady?: (prepare: (input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number; readonly evidenceId?: string; readonly signal?: AbortSignal }) => Promise<boolean>) => void;
  readonly onProjectReady?: (current: () => CaptionProject, replace: (project: CaptionProject) => void) => void;
}

function ReviewHarness({ initialProject = reviewProject(), onSeek = vi.fn(), onCommand, onReadNativePlayheadMs, evidenceContentResolver, onTimelineRebaseReady, commandOverride, narrationPreviewGateway, onBrowserAgentFocusReady, onBrowserAgentSelectionPreflightReady, onProjectReady }: ReviewHarnessProps) {
  const [project, setProject] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const reviewNavigationRef = useRef<(itemId: string, sourceLabel: string) => void>(() => undefined);
  const reviewRevisionFocusRef = useRef<(itemId: string, itemRevision: number, sourceLabel: string) => void>(() => undefined);
  const executeCommand = (command: DomainCommand): CommandResult => {
    const defaultResult = applyCommand(projectRef.current, command);
    const result = commandOverride?.(command, defaultResult) ?? defaultResult;
    onCommand?.(command, result);
    // ProjectStore reconciles a newer canonical project even when the command
    // itself is rejected as stale. Keep this harness faithful to that command
    // adapter so retry tests exercise the actual review boundary.
    if (result.project.projectRevision >= projectRef.current.projectRevision) {
      projectRef.current = result.project;
      setProject(result.project);
    }
    return result;
  };

  useEffect(() => {
    onProjectReady?.(() => projectRef.current, (nextProject) => {
      projectRef.current = nextProject;
      setProject(nextProject);
    });
  }, [onProjectReady]);

  return (
    <>
      <ReviewDocket
        project={project}
        onCommand={executeCommand}
        onSeekToMediaTime={onSeek}
        onRegisterItemNavigation={(navigate) => { reviewNavigationRef.current = navigate; }}
        onRegisterItemRevisionFocus={(focus) => { reviewRevisionFocusRef.current = focus; }}
        onRegisterBrowserAgentFocus={(focus) => { onBrowserAgentFocusReady?.(focus); }}
        onRegisterBrowserAgentSelectionPreflight={(prepare) => { onBrowserAgentSelectionPreflightReady?.(prepare); }}
        onRegisterCanonicalTimelineEdit={(rebase) => onTimelineRebaseReady?.(rebase, (nextProject) => { projectRef.current = nextProject; setProject(nextProject); })}
        {...(evidenceContentResolver === undefined ? {} : { evidenceContentResolver })}
        {...(onReadNativePlayheadMs === undefined ? {} : { onReadNativePlayheadMs })}
        {...(narrationPreviewGateway === undefined ? {} : { narrationPreviewGateway })}
      />
      <CourtRecord project={project} onSelectItem={(itemId) => reviewNavigationRef.current(itemId, `Court Record item ${itemId.toUpperCase()}`)} onFocusItemRevision={(itemId, itemRevision) => reviewRevisionFocusRef.current(itemId, itemRevision, `Court Record ${itemId.toUpperCase()} r${itemRevision}`)} />
    </>
  );
}

const retainedFixtureEvidence: EvidenceContentResolver = {
  resolve: (evidence) => ({
    evidenceId: evidence.evidenceId,
    source: "LocalEvidencePackage",
    label: "Fixture retained evidence window",
    startMs: 1_200,
    endMs: 2_100,
    projectId: evidence.projectId,
    mediaSha256: evidence.mediaSha256,
    itemId: evidence.itemId,
    itemRevision: evidence.itemRevision,
    sourceText: null,
    speakerEvidence: [],
    uncertainty: [],
    provenance: [],
  }),
};

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

  it("offers narration only for a selected AD beat and disables its generated preview while a human draft is unsaved", () => {
    const base = reviewProject();
    const adSelected = applyCommand(base, {
      type: "SelectItem",
      actor: human,
      itemId: "ad01",
      expectedItemRevision: 1,
      expectedProjectRevision: base.projectRevision,
    }).project;
    const narrationPreviewGateway: NarrationPreviewGateway = {
      loadCached: vi.fn(async () => undefined),
      saveCached: vi.fn(async () => undefined),
      synthesize: vi.fn(async () => { throw new Error("The disabled control must not synthesize."); }),
      measureDurationMs: vi.fn(async () => 1_000),
      createObjectUrl: vi.fn(() => "blob:cuebench:test"),
      revokeObjectUrl: vi.fn(),
    };
    render(<ReviewHarness initialProject={adSelected} narrationPreviewGateway={narrationPreviewGateway} />);

    const preview = screen.getByRole("region", { name: "Narration preview" });
    expect(within(preview).getByText(/not certification evidence/i)).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Generate narration preview" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Audio-description text for AD01"), {
      target: { value: "A revised energy curve fills the screen." },
    });

    expect(within(preview).getByRole("button", { name: "Generate narration preview" })).toBeDisabled();
    expect(narrationPreviewGateway.synthesize).not.toHaveBeenCalled();
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

  it("routes Browser Agent focus through the same dirty-draft guard and fails closed on cancellation", async () => {
    let focus: ((input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number }) => Promise<boolean>) | null = null;
    let current: (() => CaptionProject) | null = null;
    let replace: ((project: CaptionProject) => void) | null = null;
    const onCommand = vi.fn();
    render(<ReviewHarness
      initialProject={selectedProject()}
      onCommand={onCommand}
      onBrowserAgentFocusReady={(nextFocus) => { focus = nextFocus; }}
      onProjectReady={(nextCurrent, nextReplace) => { current = nextCurrent; replace = nextReplace; }}
    />);
    await waitFor(() => expect(focus).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Preserve this human C01 draft." } });

    const beforeAgentSelection = current!();
    const agentSelection = applyCommand(beforeAgentSelection, {
      type: "SelectItem",
      actor: { type: "BrowserAgent", id: "browser-agent" },
      itemId: "c02",
      expectedItemRevision: 1,
      expectedProjectRevision: beforeAgentSelection.projectRevision,
    });
    if (agentSelection.error !== undefined) throw new Error(agentSelection.error.message);
    act(() => replace!(agentSelection.project));

    const pending = focus!({ itemId: "c02", itemRevision: 1, playheadMs: 3_500 });
    const dialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel navigation/i }));
    await expect(pending).resolves.toBe(false);
    expect(onCommand).not.toHaveBeenCalled();

    // Returning to the draft proves it remained owned by C01 rather than
    // being silently rebound to the agent-selected C02 revision.
    fireEvent.click(screen.getByRole("button", { name: /select caption c01/i }));
    const returnDialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    fireEvent.click(within(returnDialog).getByRole("button", { name: /save changes and continue/i }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ReviseCue",
      itemId: "c01",
      patch: expect.objectContaining({ text: "Preserve this human C01 draft." }),
    }), expect.anything()));
  });

  it("acknowledges Browser Agent focus only after the requested evidence anchor owns DOM focus", async () => {
    let focus: ((input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number; readonly evidenceId?: string; readonly visualEpoch?: number }) => Promise<boolean>) | null = null;
    render(<ReviewHarness
      initialProject={selectedProject()}
      onBrowserAgentFocusReady={(nextFocus) => { focus = nextFocus; }}
    />);
    await waitFor(() => expect(focus).not.toBeNull());

    const accepted = await focus!({
      itemId: "c01",
      itemRevision: 1,
      playheadMs: 1_000,
      evidenceId: "evidence-c01-r1",
      visualEpoch: 41,
    });

    // No waitFor: this is the layout-ack contract consumed by the route and
    // then the WebMCP bridge before the tool may report success.
    expect(accepted).toBe(true);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(document.getElementById("evidence-evidence-c01-r1"));
  });

  it("runs Browser Agent focus preflight before selection, preserving the dirty draft and selected family on decline", async () => {
    let prepare: ((input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number }) => Promise<boolean>) | null = null;
    let current: (() => CaptionProject) | null = null;
    const onCommand = vi.fn();
    render(<ReviewHarness
      initialProject={selectedProject()}
      onCommand={onCommand}
      onBrowserAgentSelectionPreflightReady={(nextPrepare) => { prepare = nextPrepare; }}
      onProjectReady={(nextCurrent) => { current = nextCurrent; }}
    />);
    await waitFor(() => expect(prepare).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Keep this draft on C01." } });
    const before = current!();

    const pending = prepare!({ itemId: "c02", itemRevision: 1, playheadMs: 3_500 });
    const dialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    expect(current!().selectedItem).toEqual(before.selectedItem);
    expect(screen.getByLabelText("Caption text for C01")).toHaveValue("Keep this draft on C01.");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel navigation/i }));

    await expect(pending).resolves.toBe(false);
    expect(current!().selectedItem).toEqual(before.selectedItem);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("aborts a pending Browser Agent dirty-draft preflight without leaving its dialog or promise behind", async () => {
    let prepare: ((input: { readonly itemId: string; readonly itemRevision: number; readonly playheadMs: number; readonly signal?: AbortSignal }) => Promise<boolean>) | null = null;
    let current: (() => CaptionProject) | null = null;
    const onCommand = vi.fn();
    render(<ReviewHarness
      initialProject={selectedProject()}
      onCommand={onCommand}
      onBrowserAgentSelectionPreflightReady={(nextPrepare) => { prepare = nextPrepare; }}
      onProjectReady={(nextCurrent) => { current = nextCurrent; }}
    />);
    await waitFor(() => expect(prepare).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Preserve this draft while the agent stops." } });
    const before = current!();
    const controller = new AbortController();
    const pending = prepare!({ itemId: "c02", itemRevision: 1, playheadMs: 3_500, signal: controller.signal });
    await screen.findByRole("dialog", { name: /unsaved review draft/i });

    await act(async () => { controller.abort(); });
    await expect(pending).resolves.toBe(false);
    expect(screen.queryByRole("dialog", { name: /unsaved review draft/i })).not.toBeInTheDocument();
    expect(current!().selectedItem).toEqual(before.selectedItem);
    expect(screen.getByLabelText("Caption text for C01")).toHaveValue("Preserve this draft while the agent stops.");
    expect(onCommand).not.toHaveBeenCalled();
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

  it("guards a split-only structural draft from non-structural actions and navigation loss", async () => {
    render(<ReviewHarness initialProject={selectedProject()} />);

    fireEvent.change(screen.getByLabelText("Split point for Caption C01"), { target: { value: "2000" } });
    expect(screen.getByRole("button", { name: "Split Caption C01" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save caption revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge Caption C01 with C02" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Object selected revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sustain selected revision" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    const dialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    expect(within(dialog).queryByRole("button", { name: /save changes and continue/i })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/apply the split or discard/i)).toBeVisible();
    expect(screen.getByLabelText("Split point for Caption C01")).toHaveValue(2000);
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel navigation/i }));
    expect(screen.getByLabelText("Split point for Caption C01")).toHaveValue(2000);
  });

  it("does not offer Save or timing actions for a mixed timing and split draft", async () => {
    render(<ReviewHarness initialProject={selectedProject()} />);

    fireEvent.change(screen.getByLabelText("Split point for Caption C01"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("Start time for Caption C01"), { target: { value: "1100" } });

    expect(screen.getByRole("button", { name: "Split Caption C01" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply timing for Caption C01" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save caption revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge Caption C01 with C02" })).toBeDisabled();
    expect(screen.getByText(/apply the split or discard structural changes first/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    const dialog = await screen.findByRole("dialog", { name: /unsaved review draft/i });
    expect(within(dialog).queryByRole("button", { name: /save changes and continue/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Split point for Caption C01")).toHaveValue(2000);
    expect(screen.getByLabelText("Start time for Caption C01")).toHaveValue(1100);
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel navigation/i }));
    expect(screen.getByLabelText("Split point for Caption C01")).toHaveValue(2000);
    expect(screen.getByLabelText("Start time for Caption C01")).toHaveValue(1100);
  });

  it("rebases a clean docket draft after an accepted timeline timing revision without a false dirty lock", async () => {
    let timelineRebase: ((itemId: string, previousItemRevision: number, project: CaptionProject) => void) | null = null;
    let acceptProject: ((project: CaptionProject) => void) | null = null;
    const initial = selectedProject();
    render(<ReviewHarness
      initialProject={initial}
      onTimelineRebaseReady={(rebase, accept) => { timelineRebase = rebase; acceptProject = accept; }}
    />);

    await waitFor(() => expect(timelineRebase).not.toBeNull());
    const accepted = applyCommand(initial, {
      type: "AdjustCueTiming",
      actor: human,
      itemId: "c01",
      cueId: "c01",
      startMs: 1_100,
      endMs: 3_500,
      expectedItemRevision: 1,
      expectedProjectRevision: initial.projectRevision,
    });
    if (accepted.error !== undefined || timelineRebase === null || acceptProject === null) throw new Error("Expected accepted timing revision and registered docket callback.");
    act(() => {
      timelineRebase!("c01", 1, accepted.project);
    });

    await waitFor(() => expect(screen.getByLabelText("Start time for Caption C01")).toHaveValue(1100));
    // The store subscription may render one frame later than the accepted
    // timeline callback. That bridge must not turn clean timing into a stale
    // draft that requires manual discard.
    expect(screen.getByRole("button", { name: "Object selected revision" })).toBeEnabled();
    act(() => acceptProject!(accepted.project));
    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /selected caption c02/i })).toBeVisible());
    expect(screen.queryByRole("dialog", { name: /unsaved review draft/i })).not.toBeInTheDocument();
  });

  it("retries only navigation after a save is accepted and the first selection fails", async () => {
    let selectAttempts = 0;
    const commands: DomainCommand[] = [];
    const initial = selectedProject();
    render(<ReviewHarness
      initialProject={initial}
      onCommand={(command) => commands.push(command)}
      commandOverride={(command, result) => {
        if (command.type !== "SelectItem" || command.itemId !== "c02") return result;
        selectAttempts += 1;
        return selectAttempts === 1
          ? { project: initial, events: [], error: domainError("STALE_PROJECT", "Selection temporarily unavailable.") }
          : result;
      }}
    />);

    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Saved exactly once." } });
    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    fireEvent.click(await screen.findByRole("button", { name: /save changes and continue/i }));
    const retryDialog = await screen.findByRole("dialog", { name: /navigation still pending/i });
    expect(within(retryDialog).getByRole("button", { name: "Retry navigation" })).toBeVisible();
    expect(within(retryDialog).queryByRole("button", { name: /save changes and continue/i })).not.toBeInTheDocument();
    expect(commands.filter((command) => command.type === "ReviseCue")).toHaveLength(1);

    fireEvent.click(within(retryDialog).getByRole("button", { name: "Retry navigation" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /selected caption c02/i })).toBeVisible());
    expect(commands.filter((command) => command.type === "ReviseCue")).toHaveLength(1);
    expect(commands.filter((command) => command.type === "SelectItem" && command.itemId === "c02")).toHaveLength(2);
  });

  it("adopts a newer stale-selection project before retrying navigation without revising twice", async () => {
    let selectAttempts = 0;
    let remoteProject: CaptionProject | null = null;
    const commands: DomainCommand[] = [];
    const initial = selectedProject();
    render(<ReviewHarness
      initialProject={initial}
      onCommand={(command, result) => {
        commands.push(command);
        if (command.type !== "ReviseCue" || result.error !== undefined) return;
        const remoteRevision = applyCommand(result.project, {
          type: "ReviseCue",
          actor: human,
          itemId: "c02",
          cueId: "c02",
          expectedItemRevision: 1,
          expectedProjectRevision: result.project.projectRevision,
          patch: {
            text: "A newer canonical revision changed this cue.",
            startMs: 3_500,
            endMs: 5_000,
            speaker: null,
          },
        });
        if (remoteRevision.error !== undefined) throw new Error("Expected a newer canonical C02 fixture revision.");
        remoteProject = remoteRevision.project;
      }}
      commandOverride={(command, result) => {
        if (command.type !== "SelectItem" || command.itemId !== "c02") return result;
        selectAttempts += 1;
        if (selectAttempts !== 1) return result;
        if (remoteProject === null) throw new Error("Expected the saved review revision before stale selection.");
        return {
          project: remoteProject,
          events: [],
          error: domainError("STALE_PROJECT", "A newer canonical review project is available."),
        };
      }}
    />);

    fireEvent.change(screen.getByLabelText("Caption text for C01"), { target: { value: "Saved only once before retry." } });
    fireEvent.click(screen.getByRole("button", { name: /select caption c02/i }));
    fireEvent.click(await screen.findByRole("button", { name: /save changes and continue/i }));
    const retryDialog = await screen.findByRole("dialog", { name: /navigation still pending/i });
    expect(commands.filter((command) => command.type === "ReviseCue")).toHaveLength(1);
    const firstSelection = commands.filter((command): command is Extract<DomainCommand, { readonly type: "SelectItem" }> => command.type === "SelectItem");
    expect(firstSelection).toHaveLength(1);
    expect(firstSelection[0]).toEqual(expect.objectContaining({ expectedProjectRevision: initial.projectRevision + 1, expectedItemRevision: 1 }));

    fireEvent.click(within(retryDialog).getByRole("button", { name: "Retry navigation" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /selected caption c02/i })).toBeVisible());
    const selections = commands.filter((command): command is Extract<DomainCommand, { readonly type: "SelectItem" }> => command.type === "SelectItem");
    expect(selections).toHaveLength(2);
    expect(selections[1]).toEqual(expect.objectContaining({
      expectedProjectRevision: initial.projectRevision + 2,
      expectedItemRevision: 2,
    }));
    expect(commands.filter((command) => command.type === "ReviseCue")).toHaveLength(1);
  });

  it("renders immutable payload details and focuses a validated retained evidence window", async () => {
    const onSeek = vi.fn();
    render(<ReviewHarness initialProject={selectedProject()} onSeek={onSeek} evidenceContentResolver={retainedFixtureEvidence} />);

    fireEvent.click(screen.getByRole("button", { name: "Show immutable payload for C01 r1" }));
    expect(screen.getAllByText("Dr. Nguyen introduces Gibbs free energy.").at(-1)).toBeVisible();
    expect(screen.getByText("1,000–3,500 ms")).toBeVisible();
    expect(screen.getByText("Speaker: Dr. Nguyen")).toBeVisible();
    expect(screen.getByText(/fixture retained evidence window/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open evidence evidence-c01-r1" }));
    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_200));
    expect(document.getElementById("evidence-evidence-c01-r1")).toHaveFocus();
  });

  it("fails closed when a Local Evidence Package window does not match its provenance", async () => {
    const onSeek = vi.fn();
    const invalidResolver: EvidenceContentResolver = {
      resolve: (evidence) => ({
        evidenceId: `${evidence.evidenceId}-wrong`,
        source: "LocalEvidencePackage",
        label: "Mismatched fixture window",
        startMs: 1_200,
        endMs: 2_100,
        projectId: evidence.projectId,
        mediaSha256: evidence.mediaSha256,
        itemId: evidence.itemId,
        itemRevision: evidence.itemRevision,
      }),
    };
    render(<ReviewHarness initialProject={selectedProject()} onSeek={onSeek} evidenceContentResolver={invalidResolver} />);

    fireEvent.click(screen.getByRole("button", { name: "Open evidence evidence-c01-r1" }));
    expect((await screen.findAllByText(/does not match this project’s recorded provenance/i)).at(-1)).toBeVisible();
    expect(onSeek).not.toHaveBeenCalled();
    expect(document.getElementById("evidence-evidence-c01-r1")).not.toHaveFocus();
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

  it("links Court Record events to their derived immutable revision and exposes actor filtering", () => {
    const selected = selectedProject();
    const revised = applyCommand(selected, {
      type: "ReviseCue",
      actor: human,
      itemId: "c01",
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: selected.projectRevision,
      patch: { text: "A reviewed immutable revision.", startMs: 1_000, endMs: 3_500, speaker: "Dr. Nguyen" },
    });
    if (revised.error !== undefined) throw new Error("Expected fixture revision.");
    const onFocusItemRevision = vi.fn();
    render(<CourtRecord project={revised.project} onSelectItem={vi.fn()} onFocusItemRevision={onFocusItemRevision} />);

    fireEvent.click(screen.getByRole("button", { name: "Open C01 r2 in revision ancestry" }));
    expect(onFocusItemRevision).toHaveBeenCalledWith("c01", 2);
    fireEvent.click(screen.getByRole("link", { name: "Focus Court Record project revision 3" }));
    expect(document.querySelector('[data-project-revision="3"]')).toHaveFocus();
    const actorControl = screen.getAllByRole("button", { name: "Filter Court Record to Human · human" }).at(-1);
    if (actorControl === undefined) throw new Error("Expected actor control.");
    fireEvent.click(actorControl);
    expect(actorControl).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Clear actor filter" })).toBeVisible();
  });

  it("routes an exact Court Record revision link into the matching Revision History control", async () => {
    const selected = selectedProject();
    const revised = applyCommand(selected, {
      type: "ReviseCue",
      actor: human,
      itemId: "c01",
      cueId: "c01",
      expectedItemRevision: 1,
      expectedProjectRevision: selected.projectRevision,
      patch: { text: "Court target revision.", startMs: 1_000, endMs: 3_500, speaker: "Dr. Nguyen" },
    });
    if (revised.error !== undefined) throw new Error("Expected fixture revision.");
    render(<ReviewHarness initialProject={revised.project} />);

    fireEvent.click(screen.getByRole("button", { name: "Open C01 r2 in revision ancestry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide immutable payload for C01 r2" })).toHaveFocus());
    expect(screen.getByText("Court target revision.", { selector: ".revision-history__payload dd" })).toBeVisible();
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

  it("marks invalid draft fields accessibly and windows 500 variable-height semantic docket rows while retaining selected focus", async () => {
    const { unmount: unmountInvalidDraft } = render(<ReviewHarness initialProject={selectedProject()} />);
    fireEvent.change(screen.getByLabelText("Start time for Caption C01"), { target: { value: "3500" } });
    fireEvent.change(screen.getByLabelText("End time for Caption C01"), { target: { value: "2000" } });
    expect(screen.getByLabelText("Start time for Caption C01")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/start time must be earlier than end time/i)).toBeVisible();

    unmountInvalidDraft();
    const largeProject = largeReviewProject();
    const longItems = orderedReviewItems(largeProject);
    const measuredHeights = Object.fromEntries(longItems.map((item, index) => [item.itemId, 72 + (index % 7) * 37]));
    const layout = createDocketWindowLayout(longItems, measuredHeights);
    expect(layout.starts).toHaveLength(500);
    expect(layout.starts[1]).toBe((measuredHeights.c001 ?? 0) + 8);
    expect(layout.starts[2]).toBeGreaterThan(layout.starts[1]! + 72);
    expect(layout.totalHeight).toBeGreaterThan(500 * 72);

    const { unmount } = render(<ReviewHarness initialProject={largeProject} />);
    const list = screen.getAllByRole("list", { name: "Review items" }).at(-1);
    expect(list).toHaveAttribute("aria-label", "Review items");
    expect(within(list!).getAllByRole("listitem").length).toBeLessThan(80);
    await waitFor(() => expect(within(list!).getByRole("button", { name: /select caption c500/i })).toHaveFocus());
    expect(within(list!).getByText(/fixture cue 500./i)).toBeVisible();
    unmount();
  });
});
