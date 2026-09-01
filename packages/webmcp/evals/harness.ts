import { CONTRACT_VERSION } from "@cuebench/contracts";
import {
  applyCommand,
  createProject,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import {
  CueBenchToolRegistry,
  createActiveRunTools,
  createAlwaysTools,
  createCaptionSelectionTools,
  type CueBenchTool,
  type CueBenchWebMcpRuntime,
  type ModelContextLike,
  type ModelContextRegistrationOptions,
  type ModelContextTool,
} from "../src/index";
import { CUEBENCH_AGENT_EVAL_CASES, type CueBenchAgentEvalCase } from "./cases";

export interface CueBenchAgentEvalOutcome {
  readonly id: CueBenchAgentEvalCase["id"];
  readonly passed: boolean;
}

export interface CueBenchAgentEvalReport {
  readonly passed: boolean;
  readonly cases: readonly CueBenchAgentEvalOutcome[];
  readonly trace: readonly string[];
  readonly registeredToolNames: readonly string[];
  readonly visibleVerificationCount: number;
  readonly forbiddenStateChanged: boolean;
  readonly staleStateChanged: boolean;
  readonly confirmationDeclinedStateChanged: boolean;
  readonly abortedStateChanged: boolean;
  /** A retained, aborted mutation callback never reached the command boundary. */
  readonly abortedMutationCommandIssued: boolean;
  /** The successful timing mutation's own verification matched a settled UI snapshot. */
  readonly timingMutationVisibilityVerified: boolean;
}

interface VisibleSurfaceAcknowledgement {
  /** Command count is a deterministic ordering fence for the exact mutation. */
  readonly commandCount: number;
  readonly projectRevision: number;
  readonly selectionId: string | null;
  readonly selectionRevision: number | null;
  readonly selectedItemId: string | null;
  readonly selectedItemRevision: number | null;
  readonly selectionRegistered: boolean;
  readonly selectionToolNames: readonly string[];
}

interface TimingMutationVerification {
  readonly projectRevision: number;
  readonly selectionId: string;
  readonly selectionRevision: number;
  readonly changedItemId: string;
  readonly changedItemRevision: number;
}

interface RegisteredTool {
  readonly tool: ModelContextTool;
  readonly signal: AbortSignal | undefined;
}

class DeterministicModelContext implements ModelContextLike {
  public readonly tools = new Map<string, ModelContextTool>();
  public readonly registrations: RegisteredTool[] = [];
  public readonly trace: string[] = [];

  public registerTool(tool: ModelContextTool, options?: ModelContextRegistrationOptions): void {
    this.registrations.push({ tool, signal: options?.signal });
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    }, { once: true });
  }

  public latest(name: string): RegisteredTool {
    const registration = [...this.registrations].reverse().find((candidate) => candidate.tool.name === name);
    if (registration === undefined) throw new Error(`Expected ${name} to have been registered.`);
    return registration;
  }

  public async invoke(name: string, input: unknown, controller = new AbortController()): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`Expected ${name} to be registered.`);
    this.trace.push(name);
    return tool.execute(input, { signal: controller.signal });
  }
}

const browserAgent = { type: "BrowserAgent" as const, id: "browser-agent" };
const cueBenchAi = { type: "CueBenchAI" as const, id: "cuebench-ai" };

const fixtureProject = (): CaptionProject => createProject({
  projectId: "webmcp-eval-project",
  title: "WebMCP evaluation fixture",
  media: {
    sourceId: "webmcp-eval-media",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [
    {
      kind: "CaptionCue",
      itemId: "cue-1",
      state: "Proposed",
      startMs: 1_000,
      endMs: 3_000,
      text: "A short caption for calibration.",
      speaker: "Teacher",
      actor: browserAgent,
      cause: "eval fixture",
    },
    {
      kind: "CaptionCue",
      itemId: "cue-2",
      state: "Objected",
      startMs: 5_000,
      endMs: 6_000,
      // Deliberately exceeds the profile's readable rate so a stable,
      // item-bound finding proves `focus_quality_finding` end to end.
      text: "calibration ".repeat(140).trim(),
      speaker: "Teacher",
      actor: { type: "Human", id: "teacher" },
      cause: "eval fixture",
    },
  ],
});

const isToolError = (value: unknown, code?: string): boolean => (
  value !== null
  && typeof value === "object"
  && (value as { readonly ok?: unknown }).ok === false
  && (code === undefined || (value as { readonly code?: unknown }).code === code)
);

const isToolSuccess = (value: unknown): boolean => (
  value !== null && typeof value === "object" && (value as { readonly ok?: unknown }).ok === true
);

const selectedCaptionInput = (project: CaptionProject, overrides: Readonly<Record<string, unknown>> = {}) => {
  const selection = project.selectedItem;
  if (selection?.kind !== "CaptionCue") throw new Error("The evaluation expected a selected caption cue.");
  return {
    contractVersion: CONTRACT_VERSION,
    expectedProjectRevision: project.projectRevision,
    expectedSelectionId: selection.itemId,
    expectedSelectionRevision: selection.itemRevision,
    expectedItemRevision: selection.itemRevision,
    ...overrides,
  };
};

const commandSucceeded = (result: CommandResult): CaptionProject => {
  if (result.error !== undefined) throw new Error(`Evaluation fixture command failed: ${result.error.code}`);
  return result.project;
};

const resultProjectRevision = (project: CaptionProject): number => project.projectRevision;

const valueRecord = (value: unknown): Readonly<Record<string, unknown>> | null => (
  value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : null
);

const safeEvalInteger = (value: unknown): value is number => (
  typeof value === "number" && Number.isSafeInteger(value)
);

/** Extract only the compact verification the real strict tool response promises. */
const timingMutationVerification = (value: unknown): TimingMutationVerification | null => {
  if (!isToolSuccess(value)) return null;
  const result = valueRecord(value);
  const data = valueRecord(result?.data);
  const verification = valueRecord(data?.verification);
  const selection = valueRecord(verification?.selection);
  const changedItem = valueRecord(verification?.changedItem);
  const projectRevision = result?.projectRevision;
  const selectionId = selection?.selectionId;
  const selectionRevision = selection?.selectionRevision;
  const changedItemId = changedItem?.itemId;
  const changedItemRevision = changedItem?.itemRevision;
  if (
    !safeEvalInteger(projectRevision)
    || typeof selectionId !== "string"
    || !safeEvalInteger(selectionRevision)
    || typeof changedItemId !== "string"
    || !safeEvalInteger(changedItemRevision)
  ) return null;
  return {
    projectRevision,
    selectionId,
    selectionRevision,
    changedItemId,
    changedItemRevision,
  };
};

const visibleAcknowledgementFor = (
  project: CaptionProject,
  registry: CueBenchToolRegistry,
  commandCount: number,
): VisibleSurfaceAcknowledgement => {
  const selection = project.selectedItem;
  const selectedItem = selection?.kind === "CaptionCue"
    ? project.captions.items[selection.itemId]
    : selection?.kind === "AudioDescriptionBeat"
      ? project.audioDescriptions.items[selection.itemId]
      : null;
  const registeredSelection = registry.snapshot().selection;
  return {
    commandCount,
    projectRevision: project.projectRevision,
    selectionId: selection?.itemId ?? null,
    selectionRevision: selection?.itemRevision ?? null,
    selectedItemId: selectedItem?.itemId ?? null,
    selectedItemRevision: selectedItem?.current.itemRevision ?? null,
    selectionRegistered: registeredSelection.registered,
    selectionToolNames: [...registeredSelection.toolNames],
  };
};

const isExactTimingMutationAcknowledged = (
  verification: TimingMutationVerification | null,
  acknowledgements: readonly VisibleSurfaceAcknowledgement[],
  commandCount: number,
): boolean => verification !== null && acknowledgements.some((acknowledgement) => (
  acknowledgement.commandCount === commandCount
  && acknowledgement.projectRevision === verification.projectRevision
  && acknowledgement.selectionId === verification.selectionId
  && acknowledgement.selectionRevision === verification.selectionRevision
  && acknowledgement.selectedItemId === verification.changedItemId
  && acknowledgement.selectedItemRevision === verification.changedItemRevision
  && acknowledgement.selectionRegistered
  && acknowledgement.selectionToolNames.includes("adjust_selected_cue_timing")
));

/**
 * Runs the same real adapters used by the browser bridge against a compact
 * in-memory project. It does not fake model reasoning: the plan is a fixed
 * sequence of allowed/forbidden tool decisions so assertions are deterministic.
 */
export const runCueBenchAgentEvaluations = async (): Promise<CueBenchAgentEvalReport> => {
  let current = commandSucceeded(applyCommand(fixtureProject(), {
    type: "SelectItem",
    actor: browserAgent,
    itemId: "cue-1",
    expectedItemRevision: 1,
    expectedProjectRevision: 1,
  }));
  let acceptConfirmation = true;
  let visibleVerificationCount = 0;
  let commandCount = 0;
  let revealedFindingCount = 0;
  const visibleAcknowledgements: VisibleSurfaceAcknowledgement[] = [];
  const modelContext = new DeterministicModelContext();
  const registry = new CueBenchToolRegistry(modelContext);
  let synchronizeSurface: () => Promise<void> = async () => undefined;

  const runtime: CueBenchWebMcpRuntime = {
    browserAgent,
    getProject: () => current,
    executeCommand: async (command: DomainCommand) => {
      commandCount += 1;
      const result = applyCommand(current, command);
      if (result.error === undefined) current = result.project;
      return result;
    },
    getPlayheadMs: () => 1_250,
    afterVisibleChange: async () => {
      visibleVerificationCount += 1;
      await synchronizeSurface();
      // This models the committed workbench + dynamic registration surface,
      // not merely a returned tool shape. Snapshot it before the next tool.
      visibleAcknowledgements.push(visibleAcknowledgementFor(current, registry, commandCount));
    },
    requestConfirmation: async () => acceptConfirmation,
    prepareSelectionFocus: async () => true,
    revealSelection: async () => { revealedFindingCount += 1; },
    cancelGeneration: async ({ project, expectedProjectRevision, onCommitted }) => {
      if (project.projectRevision !== expectedProjectRevision || project.activeGenerationRun === null) {
        throw new Error("The evaluation only cancels the visible run.");
      }
      onCommitted?.();
      const result = applyCommand(current, {
        type: "ReleaseGenerationRun",
        actor: browserAgent,
        runId: project.activeGenerationRun.runId,
        expectedProjectRevision,
      });
      if (result.error !== undefined) throw new Error(`Evaluation cancellation failed: ${result.error.code}`);
      current = result.project;
      return {
        lifecycle: "ready" as const,
        run: {
          runId: project.activeGenerationRun.runId,
          targetTrack: project.activeGenerationRun.targetTrack,
          stage: "Cancelled",
          progress: null,
          warnings: [],
          retryable: false,
          code: "GENERATION_CANCELLED",
          receiptState: "available" as const,
        },
      };
    },
  };

  const captionFamily = (): { readonly scopeId: string; readonly tools: readonly CueBenchTool[] } | null => {
    const selection = current.selectedItem;
    if (selection?.kind !== "CaptionCue") return null;
    return {
      scopeId: `${current.projectId}:caption:${selection.itemId}:r${selection.itemRevision}`,
      tools: createCaptionSelectionTools(runtime),
    };
  };

  synchronizeSurface = async () => {
    const run = current.activeGenerationRun;
    await registry.synchronize({
      alwaysTools: createAlwaysTools(runtime),
      alwaysScopeId: `${current.projectId}:r${current.projectRevision}:always`,
      runTools: run === null ? null : createActiveRunTools(runtime),
      runScopeId: run === null ? null : `${current.projectId}:run:${run.runId}`,
      selection: captionFamily(),
    });
  };

  await synchronizeSurface();
  const initialSelectionNames = registry.snapshot().selection.toolNames;

  // 1–2: the fixed plan discovers the project, then inspects the actual
  // selected cue before mutation. Both are real bounded adapter calls.
  const projectInspection = await modelContext.invoke("inspect_project", {
    contractVersion: CONTRACT_VERSION,
  });
  const inspected = await modelContext.invoke("inspect_selected_cue_evidence", selectedCaptionInput(current));
  const beforeAdjustment = resultProjectRevision(current);
  const oldScopedMutationTool = modelContext.latest("adjust_selected_cue_timing");
  const visibleAcknowledgementCountBeforeAdjustment = visibleAcknowledgements.length;
  const commandCountBeforeAdjustment = commandCount;
  const adjusted = await modelContext.invoke("adjust_selected_cue_timing", selectedCaptionInput(current, {
    edge: "end",
    deltaMs: 120,
  }));
  const afterAdjustment = current;
  const adjustmentCommandCount = commandCount;
  const timingMutationVisibilityVerified = adjustmentCommandCount === commandCountBeforeAdjustment + 1
    && isExactTimingMutationAcknowledged(
      timingMutationVerification(adjusted),
      visibleAcknowledgements.slice(visibleAcknowledgementCountBeforeAdjustment),
      adjustmentCommandCount,
    );

  // 3: stale selection uses the current project revision but an obsolete
  // scoped revision, proving the narrow guard is not merely project-wide.
  const staleBefore = resultProjectRevision(current);
  const stale = await modelContext.invoke("adjust_selected_cue_timing", selectedCaptionInput(current, {
    expectedSelectionRevision: 1,
    expectedItemRevision: 1,
    edge: "end",
    deltaMs: 120,
  }));
  const staleStateChanged = resultProjectRevision(current) !== staleBefore;

  // 4: invalid input is also a structured no-op.
  const invalidBefore = resultProjectRevision(current);
  const invalid = await modelContext.invoke("adjust_selected_cue_timing", selectedCaptionInput(current, {
    edge: "end",
    deltaMs: 0,
  }));
  const invalidStateChanged = resultProjectRevision(current) !== invalidBefore;

  // 5: an old *mutating* browser registration is explicitly aborted when its
  // selection family is removed. Calling the retained host callback cannot
  // reach the command boundary or change the project.
  await registry.select(null);
  const abortedBefore = resultProjectRevision(current);
  const commandCountBeforeAbortedMutation = commandCount;
  const aborted = await oldScopedMutationTool.tool.execute(selectedCaptionInput(afterAdjustment, {
    edge: "end",
    deltaMs: 120,
  }));
  const abortedStateChanged = resultProjectRevision(current) !== abortedBefore;
  const abortedMutationCommandIssued = commandCount !== commandCountBeforeAbortedMutation;
  await synchronizeSurface();

  // 6: a Human decline is observable and never turns an agent edit into a
  // silent replacement of the current Proposed revision.
  acceptConfirmation = false;
  const confirmationBefore = resultProjectRevision(current);
  const confirmationDeclined = await modelContext.invoke("revise_selected_cue", selectedCaptionInput(current, {
    text: "A proposed revision that still needs a Human confirmation.",
  }));
  const confirmationDeclinedStateChanged = resultProjectRevision(current) !== confirmationBefore;
  acceptConfirmation = true;

  // 8 first: deterministic validation creates a finding that actually maps
  // to cue-2, and focus must update the shared selection and visible evidence.
  const validation = await modelContext.invoke("validate_project", {
    contractVersion: CONTRACT_VERSION,
    expectedProjectRevision: current.projectRevision,
  });
  const finding = current.validationRun?.findings.find((candidate) => (
    candidate.target.type === "item" && candidate.target.itemId === "cue-2"
  ));
  const focus = finding === undefined ? null : await modelContext.invoke("focus_quality_finding", {
    contractVersion: CONTRACT_VERSION,
    expectedProjectRevision: current.projectRevision,
    findingId: finding.findingId,
  });
  const focusedCaptionSelection = current.selectedItem?.kind === "CaptionCue"
    && current.selectedItem.itemId === "cue-2"
    && registry.snapshot().selection.toolNames.includes("inspect_selected_cue_evidence");

  // 7: an active run replaces the starters, then cancellation returns the
  // exact page surface to idle state without adopting any proposals.
  current = commandSucceeded(applyCommand(current, {
    type: "StartGenerationRun",
    actor: cueBenchAi,
    runId: "eval-caption-run",
    targetTrack: "Captions",
    expectedProjectRevision: current.projectRevision,
  }));
  await synchronizeSurface();
  const runBeforeCancellation = current.activeGenerationRun;
  const runSurfaceCorrect = runBeforeCancellation !== null
    && !registry.snapshot().always.toolNames.includes("start_caption_generation")
    && registry.snapshot().run.toolNames.includes("cancel_generation_run");
  const cancelledRun = runBeforeCancellation === null ? null : await modelContext.invoke("cancel_generation_run", {
    contractVersion: CONTRACT_VERSION,
    expectedProjectRevision: current.projectRevision,
    expectedRunId: runBeforeCancellation.runId,
  });

  // 9: forbidden names never register; attempted Sustain *and* certification
  // host invocations leave the project unchanged because there is no callable
  // Browser Agent authority tool.
  const forbiddenBefore = resultProjectRevision(current);
  let forbiddenMissing = true;
  for (const forbiddenToolName of ["sustain_selected_cue", "certify_project"] as const) {
    try {
      await modelContext.invoke(forbiddenToolName, {});
      forbiddenMissing = false;
    } catch {
      // A missing host registration is the expected, intentional outcome.
    }
  }
  const forbiddenStateChanged = resultProjectRevision(current) !== forbiddenBefore;

  const cases: readonly CueBenchAgentEvalOutcome[] = [
    {
      id: "correct-selection-tool",
      passed: initialSelectionNames.includes("inspect_selected_cue_evidence")
        && !initialSelectionNames.includes("inspect_selected_ad_evidence")
        && !initialSelectionNames.includes("inspect_selected_gap_evidence"),
    },
    {
      id: "inspect-before-mutate",
      passed: isToolSuccess(projectInspection)
        && isToolSuccess(inspected)
        && isToolSuccess(adjusted)
        && beforeAdjustment < afterAdjustment.projectRevision
        && modelContext.trace.indexOf("inspect_project") < modelContext.trace.indexOf("inspect_selected_cue_evidence")
        && modelContext.trace.indexOf("inspect_selected_cue_evidence") < modelContext.trace.indexOf("adjust_selected_cue_timing"),
    },
    { id: "stale-selection", passed: isToolError(stale, "STALE_SELECTION") && !staleStateChanged },
    { id: "invalid-arguments", passed: isToolError(invalid, "INVALID_ARGUMENT") && !invalidStateChanged },
    {
      id: "aborted-tool",
      passed: isToolError(aborted, "STALE_SELECTION")
        && !abortedStateChanged
        && !abortedMutationCommandIssued,
    },
    {
      id: "confirmation-declined",
      passed: isToolError(confirmationDeclined, "CONFIRMATION_DECLINED") && !confirmationDeclinedStateChanged,
    },
    {
      id: "run-cancel",
      passed: runSurfaceCorrect && isToolSuccess(cancelledRun) && current.activeGenerationRun === null,
    },
    {
      id: "finding-focus",
      passed: isToolSuccess(validation) && isToolSuccess(focus) && focusedCaptionSelection && revealedFindingCount > 0,
    },
    {
      id: "prohibited-human-authority",
      passed: forbiddenMissing
        && !forbiddenStateChanged
        && !modelContext.registrations.some((registration) => [
          "sustain_selected_cue",
          "object_selected_cue",
          "certify_project",
          "apply_profile_patch",
          "waive_quality_finding",
          "edit_caption",
          "bulk_fix_captions",
        ].includes(registration.tool.name)),
    },
    {
      id: "ui-verification-after-success",
      passed: timingMutationVisibilityVerified,
    },
  ];

  const registeredToolNames = [...new Set(modelContext.registrations.map((registration) => registration.tool.name))].sort();
  const catalogMatches = cases.length === CUEBENCH_AGENT_EVAL_CASES.length
    && cases.every((evaluation, index) => evaluation.id === CUEBENCH_AGENT_EVAL_CASES[index]?.id);
  return {
    passed: catalogMatches && cases.every((evaluation) => evaluation.passed),
    cases,
    trace: modelContext.trace,
    registeredToolNames,
    visibleVerificationCount,
    forbiddenStateChanged,
    staleStateChanged,
    confirmationDeclinedStateChanged,
    abortedStateChanged,
    abortedMutationCommandIssued,
    timingMutationVisibilityVerified,
  };
};
