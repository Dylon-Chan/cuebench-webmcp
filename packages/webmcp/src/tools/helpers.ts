import { domainError, type CaptionProject, type CommandResult, type DomainCommand } from "@cuebench/domain";
import { toolDomainError, toolSuccess } from "../tool-result";
import type {
  ChangedItemSummary,
  CueBenchToolError,
  CueBenchToolResult,
  ToolExecutionClient,
  ToolVerification,
} from "../types";
import {
  currentSelection,
  type CueBenchWebMcpRuntime,
} from "./schemas";

export const projectUnavailable = (): CueBenchToolError => toolDomainError(domainError(
  "NOT_FOUND",
  "Open a CueBench project before using Browser Agent tools.",
), { nextActions: ["inspect_project"] });

export const isToolError = (value: unknown): value is CueBenchToolError => (
  value !== null && typeof value === "object" && "ok" in value && (value as { readonly ok?: unknown }).ok === false
);

export const invalidToolInput = (message: string): CueBenchToolError => toolDomainError(domainError(
  "INVALID_ARGUMENT",
  message,
), { nextActions: ["inspect_project"] });

export const staleProjectInput = (): CueBenchToolError => toolDomainError(domainError(
  "STALE_PROJECT",
  "The project revision is no longer current. Inspect the visible project and retry.",
), { retryable: true, nextActions: ["inspect_project"] });

export const staleSelectionInput = (): CueBenchToolError => toolDomainError(domainError(
  "STALE_SELECTION",
  "The visible selection changed. Inspect the current selection and retry.",
), { retryable: true, nextActions: ["inspect_project"] });

export const projectAtExpectedRevision = (
  runtime: CueBenchWebMcpRuntime,
  expectedProjectRevision: number,
): CaptionProject | CueBenchToolError => {
  const project = runtime.getProject();
  if (project === null) return projectUnavailable();
  const owner = runtime.projectInstance;
  return project.projectRevision === expectedProjectRevision
    && (owner === undefined || (
      project.projectId === owner.projectId
      && project.projectRevision === owner.projectRevision
      && runtime.isCurrentProjectInstance?.() !== false
    ))
    ? project
    : staleProjectInput();
};

export const selectionAtExpectedRevision = (
  project: CaptionProject,
  input: {
    readonly expectedSelectionId: string;
    readonly expectedSelectionRevision: number;
    readonly expectedItemRevision?: number;
    readonly expectedGapRevision?: number;
  },
) => {
  const selection = currentSelection(project);
  if (
    selection === null
    || selection.selectionId !== input.expectedSelectionId
    || selection.selectionRevision !== input.expectedSelectionRevision
    || (input.expectedItemRevision !== undefined && input.expectedItemRevision !== input.expectedSelectionRevision)
    || (input.expectedGapRevision !== undefined && input.expectedGapRevision !== input.expectedSelectionRevision)
  ) return null;
  return selection;
};

const findIds = (project: CaptionProject): ReadonlySet<string> => new Set(
  (project.validationRun?.findings ?? []).map((finding) => finding.findingId),
);

export const findingDelta = (before: CaptionProject, after: CaptionProject) => {
  const beforeIds = findIds(before);
  const afterIds = findIds(after);
  const addedFindingIds = [...afterIds].filter((id) => !beforeIds.has(id)).slice(0, 100);
  const resolvedFindingIds = [...beforeIds].filter((id) => !afterIds.has(id)).slice(0, 100);
  return {
    addedFindingIds,
    resolvedFindingIds,
    blockerCount: after.validation.blockerCount,
    warningCount: after.validation.warningCount,
  } as const;
};

export const changedItemFor = (
  project: CaptionProject,
  itemId: string | null,
): ChangedItemSummary | null => {
  if (itemId === null) return null;
  const caption = project.captions.items[itemId];
  if (caption !== undefined && caption.mergedIntoItemId === null) {
    return {
      kind: "CaptionCue",
      itemId: caption.itemId,
      itemRevision: caption.current.itemRevision,
      state: caption.current.state,
    };
  }
  const beat = project.audioDescriptions.items[itemId];
  if (beat !== undefined && beat.supersededByRunId === null) {
    return {
      kind: "AudioDescriptionBeat",
      itemId: beat.itemId,
      itemRevision: beat.current.itemRevision,
      state: beat.current.state,
    };
  }
  return null;
};

export const verificationFor = (
  runtime: CueBenchWebMcpRuntime,
  project: CaptionProject,
  options: {
    readonly changedItemId?: string | null;
    readonly before?: CaptionProject;
  } = {},
): ToolVerification => {
  const selection = currentSelection(project);
  return {
    selection: selection === null ? null : {
      kind: selection.kind,
      selectionId: selection.selectionId,
      selectionRevision: selection.selectionRevision,
    },
    changedItem: changedItemFor(project, options.changedItemId ?? null),
    findingDelta: options.before === undefined ? null : findingDelta(options.before, project),
    playheadMs: Math.max(0, Math.trunc(runtime.getPlayheadMs())),
  };
};

/** Execute one domain command, publish its state to React, then wait until the page settles. */
export const executeVisibleCommand = async (
  runtime: CueBenchWebMcpRuntime,
  command: DomainCommand,
  client: ToolExecutionClient,
  options: { readonly revealSelection?: boolean } = {},
): Promise<CommandResult> => {
  const result = await runtime.executeCommand(command);
  if (result.error === undefined) {
    client.markCommitted();
    await runtime.afterVisibleChange();
    const selection = options.revealSelection === true ? result.project.selectedItem : null;
    if (selection !== null) {
      const playheadMs = selection.kind === "CaptionCue"
        ? result.project.captions.items[selection.itemId]?.current.startMs
        : selection.kind === "AudioDescriptionBeat"
          ? result.project.audioDescriptions.items[selection.itemId]?.current.startMs
          : result.project.audioDescriptionGaps[selection.itemId]?.startMs;
      if (playheadMs !== undefined) {
        await runtime.revealSelection?.({
          kind: selection.kind,
          selectionId: selection.itemId,
          selectionRevision: selection.itemRevision,
          playheadMs,
          ...(client.postCommitSignal === undefined ? {} : { signal: client.postCommitSignal }),
        });
        await runtime.afterVisibleChange();
      }
    }
  }
  return result;
};

export const resultForCommand = <T extends Readonly<Record<string, unknown>>>(
  runtime: CueBenchWebMcpRuntime,
  before: CaptionProject,
  result: CommandResult,
  data: T,
  nextActions: readonly string[],
  changedItemId: string | null,
): CueBenchToolResult<T & { readonly verification: ToolVerification }> => {
  if (result.error !== undefined) return toolDomainError(result.error);
  return toolSuccess({
    projectRevision: result.project.projectRevision,
    data,
    nextActions,
    ...verificationFor(runtime, result.project, { changedItemId, before }),
  });
};

export const revealSelection = async (
  runtime: CueBenchWebMcpRuntime,
  input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat" | "AudioDescriptionGap";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
    readonly visualEpoch?: number;
  },
): Promise<void> => {
  await runtime.revealSelection?.(input);
  await runtime.afterVisibleChange();
};
