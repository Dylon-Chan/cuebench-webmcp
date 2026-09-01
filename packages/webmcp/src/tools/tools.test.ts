import { applyCommand, createProject, type CaptionProject } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_RUN_TOOL_NAMES,
  ALWAYS_TOOL_NAMES,
  CAPTION_SELECTION_TOOL_NAMES,
  createActiveRunTools,
  createAlwaysTools,
  createCaptionSelectionTools,
  createAudioDescriptionSelectionTools,
  createGapSelectionTools,
  AUDIO_DESCRIPTION_SELECTION_TOOL_NAMES,
  GAP_SELECTION_TOOL_NAMES,
  ToolExecutionAbortedError,
  type CueBenchWebMcpRuntime,
} from "../index";

const forbiddenToolNames = [
  "sustain_selected_cue",
  "object_selected_cue",
  "certify_project",
  "apply_profile_patch",
  "waive_quality_finding",
  "relink_media",
  "import_project_backup",
  "delete_project",
  "edit_caption",
  "bulk_fix_captions",
];

const runtime = {} as CueBenchWebMcpRuntime;

const browserAgent = { type: "BrowserAgent" as const, id: "browser-agent" };
const human = { type: "Human" as const, id: "human" };

const selectedCaptionProject = (state: "Proposed" | "Objected" = "Proposed"): CaptionProject => {
  const project = createProject({
    projectId: "project-tools",
    title: "Tool fixture",
    media: {
      sourceId: "source-tools",
      sha256: "a".repeat(64),
      durationMs: 90_000,
      relinkState: "Linked",
    },
    captions: [{
      kind: "CaptionCue",
      itemId: "cue-1",
      state,
      startMs: 1_000,
      endMs: 3_000,
      text: "Initial caption.",
      speaker: "Teacher",
      actor: state === "Proposed" ? browserAgent : human,
      cause: "fixture",
    }],
  });
  return applyCommand(project, {
    type: "SelectItem",
    actor: browserAgent,
    itemId: "cue-1",
    expectedItemRevision: 1,
    expectedProjectRevision: project.projectRevision,
  }).project;
};

const runtimeFor = (
  initial: CaptionProject,
  confirmed: boolean,
): { readonly runtime: CueBenchWebMcpRuntime; readonly project: () => CaptionProject; readonly commands: readonly unknown[]; readonly confirm: ReturnType<typeof vi.fn> } => {
  let current = initial;
  const commands: unknown[] = [];
  const confirm = vi.fn().mockResolvedValue(confirmed);
  return {
    runtime: {
      browserAgent,
      getProject: () => current,
      executeCommand: async (command) => {
        commands.push(command);
        const result = applyCommand(current, command);
        current = result.project;
        return result;
      },
      getPlayheadMs: () => 1_234,
      afterVisibleChange: async () => undefined,
      requestConfirmation: confirm,
    },
    project: () => current,
    commands,
    confirm,
  };
};

const client = () => ({ signal: new AbortController().signal, markCommitted: vi.fn() });

describe("the exact CueBench Core WebMCP surface", () => {
  it("exposes only the approved always, active-run, and one-selection-family names", () => {
    expect(ALWAYS_TOOL_NAMES).toEqual([
      "inspect_project",
      "inspect_timeline_window",
      "list_quality_findings",
      "focus_quality_finding",
      "start_caption_generation",
      "start_ad_generation",
      "validate_project",
      "export_track",
      "propose_profile_patch",
      "prepare_certification_review",
    ]);
    expect(ACTIVE_RUN_TOOL_NAMES).toEqual([
      "inspect_generation_run",
      "cancel_generation_run",
    ]);
    expect(CAPTION_SELECTION_TOOL_NAMES).toEqual([
      "inspect_selected_cue_evidence",
      "adjust_selected_cue_timing",
      "split_selected_cue",
      "merge_selected_cue",
      "revise_selected_cue",
      "mark_selected_cue_agent_ready",
    ]);
    expect(AUDIO_DESCRIPTION_SELECTION_TOOL_NAMES).toEqual([
      "inspect_selected_ad_evidence",
      "adjust_selected_ad_timing",
      "revise_selected_ad_beat",
      "preview_selected_narration",
      "mark_selected_ad_agent_ready",
    ]);
    expect(GAP_SELECTION_TOOL_NAMES).toEqual([
      "inspect_selected_gap_evidence",
      "propose_ad_beat_in_gap",
    ]);

    const names = [
      ...createAlwaysTools(runtime).map((tool) => tool.name),
      ...createActiveRunTools(runtime).map((tool) => tool.name),
      ...createCaptionSelectionTools(runtime).map((tool) => tool.name),
      ...createAudioDescriptionSelectionTools(runtime).map((tool) => tool.name),
      ...createGapSelectionTools(runtime).map((tool) => tool.name),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toEqual(expect.arrayContaining(forbiddenToolNames));
  });

  it("uses strict object schemas rather than a generic editor input", () => {
    for (const tool of createAlwaysTools(runtime)) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    for (const tool of createCaptionSelectionTools(runtime)) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(createAudioDescriptionSelectionTools(runtime).find((tool) => tool.name === "preview_selected_narration")?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("marks every result that can carry project, finding, transcript, or imported prose as untrusted browser content", () => {
    const tools = [
      ...createAlwaysTools(runtime),
      ...createActiveRunTools(runtime),
      ...createCaptionSelectionTools(runtime),
      ...createAudioDescriptionSelectionTools(runtime),
      ...createGapSelectionTools(runtime),
    ];
    const namesThatCanEchoUntrustedContent = [
      "inspect_project",
      "inspect_timeline_window",
      "list_quality_findings",
      "focus_quality_finding",
      "start_caption_generation",
      "start_ad_generation",
      "export_track",
      "prepare_certification_review",
      "inspect_generation_run",
      "cancel_generation_run",
      "inspect_selected_cue_evidence",
      "adjust_selected_cue_timing",
      "split_selected_cue",
      "merge_selected_cue",
      "revise_selected_cue",
      "mark_selected_cue_agent_ready",
      "inspect_selected_ad_evidence",
      "adjust_selected_ad_timing",
      "revise_selected_ad_beat",
      "inspect_selected_gap_evidence",
      "propose_ad_beat_in_gap",
    ];
    for (const name of namesThatCanEchoUntrustedContent) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({ untrustedContentHint: true });
    }
  });

  it("surfaces an accepted-unknown generation identity as a changed, inspect-first operation", async () => {
    const initial = selectedCaptionProject("Objected");
    const markCommitted = vi.fn();
    const startGeneration = vi.fn(async (input: { readonly onCommitted?: () => void }) => {
      input.onCommitted?.();
      return {
        run: {
          runId: "caption-recovery-run",
          targetTrack: "Captions" as const,
          stage: "AcceptedUnknown",
          progress: null,
          warnings: ["Inspect this retained run before retrying."],
          retryable: true,
          code: "GENERATION_ACCEPTED_UNKNOWN",
          receiptState: "missing" as const,
        },
        lifecycle: "accepted-unknown" as const,
      };
    });
    const generationRuntime: CueBenchWebMcpRuntime = {
      browserAgent,
      getProject: () => initial,
      executeCommand: vi.fn(),
      getPlayheadMs: () => 0,
      afterVisibleChange: async () => undefined,
      startGeneration,
    };
    const tool = createAlwaysTools(generationRuntime).find((candidate) => candidate.name === "start_caption_generation");

    const result = await tool!.execute({ contractVersion: 1, expectedProjectRevision: initial.projectRevision }, {
      signal: new AbortController().signal,
      markCommitted,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { run: { runId: "caption-recovery-run", stage: "AcceptedUnknown" } },
      nextActions: ["inspect_generation_run", "inspect_project"],
    });
    expect(markCommitted).toHaveBeenCalled();
  });

  it("keeps lifecycle-pending cancellation inspectable instead of reporting an unchanged argument failure", async () => {
    const base = selectedCaptionProject("Objected");
    const active = applyCommand(base, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "caption-cancel-recovery",
      targetTrack: "Captions",
      expectedProjectRevision: base.projectRevision,
    }).project;
    const markCommitted = vi.fn();
    const cancelGeneration = vi.fn(async (input: { readonly onCommitted?: () => void }) => {
      input.onCommitted?.();
      return {
        run: {
          runId: "caption-cancel-recovery",
          targetTrack: "Captions" as const,
          stage: "LifecyclePending",
          progress: null,
          warnings: ["Cancellation recovery remains visible."],
          retryable: true,
          code: "GENERATION_LIFECYCLE_PENDING",
          receiptState: "available" as const,
        },
        lifecycle: "lifecycle-pending" as const,
      };
    });
    const generationRuntime: CueBenchWebMcpRuntime = {
      browserAgent,
      getProject: () => active,
      executeCommand: vi.fn(),
      getPlayheadMs: () => 0,
      afterVisibleChange: async () => undefined,
      cancelGeneration,
    };
    const tool = createActiveRunTools(generationRuntime).find((candidate) => candidate.name === "cancel_generation_run");

    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
      expectedRunId: "caption-cancel-recovery",
    }, { signal: new AbortController().signal, markCommitted });
    expect(result).toMatchObject({
      ok: true,
      data: { run: { runId: "caption-cancel-recovery", stage: "LifecyclePending" } },
      nextActions: ["inspect_generation_run", "inspect_project"],
    });
    expect(markCommitted).toHaveBeenCalled();
  });

  it("fails closed when replacing a Proposed cue is not confirmed by the Human", async () => {
    const initial = selectedCaptionProject("Proposed");
    const fixture = runtimeFor(initial, false);
    const tool = createCaptionSelectionTools(fixture.runtime).find((candidate) => candidate.name === "revise_selected_cue");
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      text: "Replacement caption.",
    }, client());

    expect(result).toMatchObject({ ok: false, code: "CONFIRMATION_DECLINED" });
    expect(fixture.project()).toBe(initial);
    expect(fixture.commands).toEqual([]);
    expect(fixture.confirm).toHaveBeenCalledTimes(1);
  });

  it("does its own integer timing math after an exact selected-item guard", async () => {
    const initial = selectedCaptionProject("Objected");
    const fixture = runtimeFor(initial, true);
    const tool = createCaptionSelectionTools(fixture.runtime).find((candidate) => candidate.name === "adjust_selected_cue_timing");
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      edge: "start",
      deltaMs: 125,
    }, client());

    expect(result).toMatchObject({
      ok: true,
      data: { cue: { startMs: 1_125, endMs: 3_000, itemRevision: 2, state: "Proposed" } },
    });
    expect(fixture.commands).toMatchObject([{
      type: "AdjustCueTiming",
      startDeltaMs: 125,
      endDeltaMs: 0,
      expectedProjectRevision: initial.projectRevision,
      expectedItemRevision: 1,
      expectedSelectionId: "cue-1",
    }]);
  });

  it("rejects a stale selection before it reaches the domain command boundary", async () => {
    const initial = selectedCaptionProject("Objected");
    const fixture = runtimeFor(initial, true);
    const tool = createCaptionSelectionTools(fixture.runtime).find((candidate) => candidate.name === "mark_selected_cue_agent_ready");
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 2,
      expectedItemRevision: 2,
    }, client());

    expect(result).toMatchObject({ ok: false, code: "STALE_SELECTION", retryable: true });
    expect(fixture.commands).toEqual([]);
  });

  it("cancels a pending in-page confirmation when the scoped tool signal aborts", async () => {
    const initial = selectedCaptionProject("Proposed");
    const fixture = runtimeFor(initial, true);
    const abortRuntime: CueBenchWebMcpRuntime = { ...fixture.runtime, requestConfirmation: (_request, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    }) };
    const tool = createCaptionSelectionTools(abortRuntime).find((candidate) => candidate.name === "revise_selected_cue");
    const controller = new AbortController();
    const pending = tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      text: "Replacement caption.",
    }, { signal: controller.signal, markCommitted: vi.fn() });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, code: "CONFIRMATION_DECLINED" });
    expect(fixture.commands).toEqual([]);
  });

  it("does not issue a command when confirmation resolves true but the invocation aborts before the mutation", async () => {
    const initial = selectedCaptionProject("Proposed");
    const fixture = runtimeFor(initial, true);
    const controller = new AbortController();
    const abortRuntime: CueBenchWebMcpRuntime = {
      ...fixture.runtime,
      requestConfirmation: async () => {
        controller.abort();
        return true;
      },
    };
    const tool = createCaptionSelectionTools(abortRuntime).find((candidate) => candidate.name === "revise_selected_cue");

    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      text: "This must not replace the proposal.",
    }, { signal: controller.signal, markCommitted: vi.fn() });

    expect(result).toMatchObject({ ok: false, code: "CONFIRMATION_DECLINED", changed: false });
    expect(fixture.commands).toEqual([]);
    expect(fixture.project()).toBe(initial);
  });

  it("treats a branded in-page confirmation cancellation as a clean decline", async () => {
    const initial = selectedCaptionProject("Proposed");
    const fixture = runtimeFor(initial, true);
    const abortRuntime: CueBenchWebMcpRuntime = {
      ...fixture.runtime,
      requestConfirmation: async () => { throw new ToolExecutionAbortedError(); },
    };
    const tool = createCaptionSelectionTools(abortRuntime).find((candidate) => candidate.name === "revise_selected_cue");

    await expect(tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      text: "This must stay unchanged.",
    }, client())).resolves.toMatchObject({ ok: false, code: "CONFIRMATION_DECLINED", changed: false });
    expect(fixture.commands).toEqual([]);
  });

  it("discloses every sensitive cue and lets a Browser Agent merge a confirmed mixed Proposed and Sustained pair", async () => {
    const project = createProject({
      projectId: "project-mixed-merge-tools",
      title: "Mixed merge fixture",
      media: { sourceId: "source-mixed-merge-tools", sha256: "d".repeat(64), durationMs: 90_000, relinkState: "Linked" },
      captions: [
        {
          kind: "CaptionCue",
          itemId: "cue-proposed",
          state: "Proposed",
          startMs: 1_000,
          endMs: 2_000,
          text: "First cue.",
          speaker: "Teacher",
          actor: browserAgent,
          cause: "fixture",
        },
        {
          kind: "CaptionCue",
          itemId: "cue-sustained",
          state: "Sustained",
          startMs: 2_000,
          endMs: 3_000,
          text: "Second cue.",
          speaker: "Teacher",
          actor: human,
          cause: "fixture",
        },
      ],
    });
    const initial = applyCommand(project, {
      type: "SelectItem",
      actor: browserAgent,
      itemId: "cue-proposed",
      expectedItemRevision: 1,
      expectedProjectRevision: project.projectRevision,
    }).project;
    const fixture = runtimeFor(initial, true);
    const tool = createCaptionSelectionTools(fixture.runtime).find((candidate) => candidate.name === "merge_selected_cue");

    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "cue-proposed",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      withCueId: "cue-sustained",
      expectedWithCueRevision: 1,
    }, client());

    expect(result).toMatchObject({ ok: true, data: { mergedCueId: "cue-sustained" } });
    expect(fixture.confirm).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reopen-sustained",
      itemId: "cue-sustained",
      itemIds: ["cue-sustained", "cue-proposed"],
    }), expect.any(AbortSignal));
    expect(fixture.project().courtRecord.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: browserAgent }),
    ]));
    expect(fixture.commands).toMatchObject([expect.objectContaining({
      type: "MergeCue",
      actor: browserAgent,
      confirmedSustainedReopen: true,
    })]);
  });

  it("applies the same guarded integer-timing path to a selected audio-description beat", async () => {
    const unselected = createProject({
      projectId: "project-ad-tools",
      title: "AD tool fixture",
      media: { sourceId: "source-ad-tools", sha256: "b".repeat(64), durationMs: 90_000, relinkState: "Linked" },
      audioDescriptions: [{
        kind: "AudioDescriptionBeat",
        itemId: "ad-1",
        state: "Objected",
        startMs: 4_000,
        endMs: 6_000,
        description: "A map appears.",
        actor: human,
        cause: "fixture",
      }],
    });
    const initial = applyCommand(unselected, {
      type: "SelectItem",
      actor: browserAgent,
      itemId: "ad-1",
      expectedItemRevision: 1,
      expectedProjectRevision: unselected.projectRevision,
    }).project;
    const fixture = runtimeFor(initial, true);
    const tool = createAudioDescriptionSelectionTools(fixture.runtime).find((candidate) => candidate.name === "adjust_selected_ad_timing");
    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "ad-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
      edge: "end",
      deltaMs: 225,
    }, client());

    expect(result).toMatchObject({ ok: true, data: { beat: { startMs: 4_000, endMs: 6_225, itemRevision: 2, state: "Proposed" } } });
    expect(fixture.commands).toMatchObject([{ type: "AdjustAudioDescriptionTiming", startDeltaMs: 0, endDeltaMs: 225 }]);
  });

  it("reports a committed narration-preview side effect truthfully when later preview work fails", async () => {
    const unselected = createProject({
      projectId: "project-ad-preview-tools",
      title: "AD preview tool fixture",
      media: { sourceId: "source-ad-preview-tools", sha256: "e".repeat(64), durationMs: 90_000, relinkState: "Linked" },
      audioDescriptions: [{
        kind: "AudioDescriptionBeat",
        itemId: "ad-1",
        state: "Objected",
        startMs: 4_000,
        endMs: 6_000,
        description: "A map appears.",
        actor: human,
        cause: "fixture",
      }],
    });
    const initial = applyCommand(unselected, {
      type: "SelectItem",
      actor: browserAgent,
      itemId: "ad-1",
      expectedItemRevision: 1,
      expectedProjectRevision: unselected.projectRevision,
    }).project;
    const markCommitted = vi.fn();
    const previewRuntime: CueBenchWebMcpRuntime = {
      ...runtimeFor(initial, true).runtime,
      previewNarration: async (input) => {
        input.onCommitted?.();
        throw new Error("The quota-consuming synthesis failed after dispatch.");
      },
    };
    const tool = createAudioDescriptionSelectionTools(previewRuntime).find((candidate) => candidate.name === "preview_selected_narration");

    await expect(tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "ad-1",
      expectedSelectionRevision: 1,
      expectedItemRevision: 1,
    }, { signal: new AbortController().signal, markCommitted })).resolves.toMatchObject({
      ok: false,
      code: "GENERATION_STAGE_FAILED",
      changed: true,
      retryable: true,
      nextActions: ["inspect_selected_ad_evidence", "inspect_project"],
    });
    expect(markCommitted).toHaveBeenCalledTimes(1);
  });

  it("turns a selected available gap into one visible Proposed audio-description beat", async () => {
    const unselected = createProject({
      projectId: "project-gap-tools",
      title: "Gap tool fixture",
      media: { sourceId: "source-gap-tools", sha256: "c".repeat(64), durationMs: 90_000, relinkState: "Linked" },
      audioDescriptionGaps: [{ gapId: "gap-1", gapRevision: 1, state: "Available", startMs: 10_000, endMs: 14_000 }],
    });
    const initial = applyCommand(unselected, {
      type: "FocusGap",
      actor: browserAgent,
      gapId: "gap-1",
      expectedGapRevision: 1,
      expectedProjectRevision: unselected.projectRevision,
    }).project;
    const fixture = runtimeFor(initial, true);
    const tool = createGapSelectionTools(fixture.runtime).find((candidate) => candidate.name === "propose_ad_beat_in_gap");
    const result = await tool!.execute({
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
      expectedSelectionId: "gap-1",
      expectedSelectionRevision: 1,
      expectedGapRevision: 1,
      startMs: 10_500,
      endMs: 12_000,
      description: "A watershed map fills the screen.",
    }, client());

    expect(result).toMatchObject({ ok: true, data: { beat: { kind: "AudioDescriptionBeat", state: "Proposed", startMs: 10_500, endMs: 12_000 }, consumedGapId: "gap-1" } });
    expect(fixture.project().selectedItem).toMatchObject({ kind: "AudioDescriptionBeat" });
    expect(fixture.project().audioDescriptionGaps["gap-1"]).toMatchObject({ state: "Consumed", gapRevision: 2 });
  });
});
