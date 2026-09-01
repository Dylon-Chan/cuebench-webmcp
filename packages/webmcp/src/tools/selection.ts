import type { AudioDescriptionBeat, CaptionCue, CaptionProject } from "@cuebench/domain";
import { domainError } from "@cuebench/domain";
import { ToolExecutionAbortedError, toolDomainError } from "../tool-result";
import type { CueBenchToolError } from "../types";
import {
  MAX_WEBMCP_EVIDENCE_ITEMS,
  currentSelection,
  safeTextPreview,
  type CueBenchWebMcpRuntime,
} from "./schemas";
import {
  invalidToolInput,
  isToolError,
  projectAtExpectedRevision,
  selectionAtExpectedRevision,
  staleSelectionInput,
} from "./helpers";

interface ExpectedItemSelection {
  readonly expectedProjectRevision: number;
  readonly expectedSelectionId: string;
  readonly expectedSelectionRevision: number;
  readonly expectedItemRevision: number;
}

interface ExpectedGapSelection {
  readonly expectedProjectRevision: number;
  readonly expectedSelectionId: string;
  readonly expectedSelectionRevision: number;
  readonly expectedGapRevision: number;
}

export interface CaptionSelectionContext {
  readonly project: CaptionProject;
  readonly item: CaptionCue;
}

export interface AudioDescriptionSelectionContext {
  readonly project: CaptionProject;
  readonly item: AudioDescriptionBeat;
}

export interface GapSelectionContext {
  readonly project: CaptionProject;
  readonly gap: CaptionProject["audioDescriptionGaps"][string];
}

export const captionSelectionContext = (
  runtime: CueBenchWebMcpRuntime,
  input: ExpectedItemSelection,
): CaptionSelectionContext | CueBenchToolError => {
  const project = projectAtExpectedRevision(runtime, input.expectedProjectRevision);
  if (isToolError(project)) return project;
  const selection = selectionAtExpectedRevision(project, input);
  if (selection === null || selection.kind !== "CaptionCue") return staleSelectionInput();
  const item = project.captions.items[input.expectedSelectionId];
  if (item === undefined || item.mergedIntoItemId !== null || item.current.itemRevision !== input.expectedItemRevision) {
    return staleSelectionInput();
  }
  return { project, item };
};

export const audioDescriptionSelectionContext = (
  runtime: CueBenchWebMcpRuntime,
  input: ExpectedItemSelection,
): AudioDescriptionSelectionContext | CueBenchToolError => {
  const project = projectAtExpectedRevision(runtime, input.expectedProjectRevision);
  if (isToolError(project)) return project;
  const selection = selectionAtExpectedRevision(project, input);
  if (selection === null || selection.kind !== "AudioDescriptionBeat") return staleSelectionInput();
  const item = project.audioDescriptions.items[input.expectedSelectionId];
  if (item === undefined || item.supersededByRunId !== null || item.current.itemRevision !== input.expectedItemRevision) {
    return staleSelectionInput();
  }
  return { project, item };
};

export const gapSelectionContext = (
  runtime: CueBenchWebMcpRuntime,
  input: ExpectedGapSelection,
): GapSelectionContext | CueBenchToolError => {
  const project = projectAtExpectedRevision(runtime, input.expectedProjectRevision);
  if (isToolError(project)) return project;
  const selection = selectionAtExpectedRevision(project, input);
  if (selection === null || selection.kind !== "AudioDescriptionGap") return staleSelectionInput();
  const gap = project.audioDescriptionGaps[input.expectedSelectionId];
  if (gap === undefined || gap.state !== "Available" || gap.gapRevision !== input.expectedGapRevision) return staleSelectionInput();
  return { project, gap };
};

/** Revisions to a proposal replace it; revisions to sustained work reopen it. Both need Human confirmation. */
export interface EditableItemsConfirmation {
  /** The in-page Human explicitly approved reopening at least one Sustained item. */
  readonly confirmedSustainedReopen: boolean;
}

export const confirmEditableItems = async (
  runtime: CueBenchWebMcpRuntime,
  items: readonly (CaptionCue | AudioDescriptionBeat)[],
  signal: AbortSignal,
): Promise<CueBenchToolError | EditableItemsConfirmation> => {
  const sensitive = items
    .filter((item) => item.current.state === "Proposed" || item.current.state === "Sustained")
    .sort((left, right) => {
      const leftPriority = left.current.state === "Sustained" ? 0 : 1;
      const rightPriority = right.current.state === "Sustained" ? 0 : 1;
      return leftPriority - rightPriority || left.itemId.localeCompare(right.itemId);
    });
  if (sensitive.length === 0) return { confirmedSustainedReopen: false };
  if (runtime.requestConfirmation === undefined) {
    return toolDomainError(domainError("CONFIRMATION_DECLINED", "A visible Human confirmation is required before replacing a proposal or reopening Sustained work."));
  }
  const primary = sensitive[0]!;
  const hasSustained = sensitive.some((item) => item.current.state === "Sustained");
  let confirmed: boolean;
  try {
    confirmed = await runtime.requestConfirmation({
      kind: hasSustained ? "reopen-sustained" : "replace-proposed",
      title: hasSustained ? "Reopen Sustained work?" : "Replace these proposals?",
      detail: hasSustained
        ? `The Browser Agent wants to create new Proposed revisions from ${sensitive.length} sensitive timeline item${sensitive.length === 1 ? "" : "s"}, including Human-Sustained work. Every existing ruling remains in the Court Record.`
        : `The Browser Agent wants to replace ${sensitive.length} current proposal${sensitive.length === 1 ? "" : "s"}. Review every affected timeline item before CueBench changes the visible timeline.`,
      itemId: primary.itemId,
      itemIds: sensitive.map((item) => item.itemId),
    }, signal);
  } catch (error) {
    if (signal.aborted || error instanceof ToolExecutionAbortedError) {
      return toolDomainError(domainError("CONFIRMATION_DECLINED", "The Human did not confirm this change."));
    }
    throw error;
  }
  // The browser may deliver cancellation between the dialog resolving and the
  // next domain command. Do not let an earlier affirmative answer bypass the
  // live execution scope that made this mutation meaningful.
  if (signal.aborted) {
    return toolDomainError(domainError("CONFIRMATION_DECLINED", "The Human did not confirm this change."));
  }
  return confirmed
    ? { confirmedSustainedReopen: hasSustained }
    : toolDomainError(domainError("CONFIRMATION_DECLINED", "The Human did not confirm this change."));
};

export const captionEvidence = (project: CaptionProject, item: CaptionCue) => {
  const evidence = project.localEvidencePackages.flatMap((entry) => {
    const binding = entry.cueBindings.find((candidate) => (
      candidate.itemId === item.itemId && candidate.itemRevision === item.current.itemRevision
    ));
    if (binding === undefined) return [];
    const ids = new Set(binding.evidenceIds);
    return entry.evidence.words
      .filter((word) => ids.has(word.evidenceId))
      .map((word) => ({
        evidenceId: word.evidenceId,
        startMs: word.startMs,
        endMs: word.endMs,
        textPreview: safeTextPreview(word.text),
        speaker: word.speaker,
        uncertaintyCount: entry.evidence.uncertaintySpans.filter((span) => span.evidenceIds.includes(word.evidenceId)).length,
      }));
  });
  return evidence.slice(0, MAX_WEBMCP_EVIDENCE_ITEMS);
};

export const audioDescriptionEvidence = (project: CaptionProject, item: AudioDescriptionBeat) => {
  const evidence = project.localAudioDescriptionEvidencePackages.flatMap((entry) => {
    const binding = entry.beatBindings.find((candidate) => (
      candidate.itemId === item.itemId && candidate.itemRevision === item.current.itemRevision
    ));
    if (binding === undefined) return [];
    const ids = new Set(binding.evidenceIds);
    return entry.evidence.frames
      .filter((frame) => ids.has(frame.evidenceId))
      .map((frame) => ({
        evidenceId: frame.evidenceId,
        atMs: frame.atMs,
        sha256: `sha256:${frame.sha256}`,
        mimeType: frame.mimeType,
      }));
  });
  return evidence.slice(0, MAX_WEBMCP_EVIDENCE_ITEMS);
};

export const gapEvidence = (project: CaptionProject, gap: CaptionProject["audioDescriptionGaps"][string]) => ({
  startMs: gap.startMs,
  endMs: gap.endMs,
  captionContext: Object.values(project.captions.items)
    .filter((item) => item.mergedIntoItemId === null && item.current.startMs < gap.endMs && gap.startMs < item.current.endMs)
    .sort((left, right) => left.current.startMs - right.current.startMs)
    .slice(0, MAX_WEBMCP_EVIDENCE_ITEMS)
    .map((item) => ({
      itemId: item.itemId,
      itemRevision: item.current.itemRevision,
      startMs: item.current.startMs,
      endMs: item.current.endMs,
      textPreview: safeTextPreview(item.current.text),
    })),
});

export const selectionNextActions = (project: CaptionProject): readonly string[] => {
  const selection = currentSelection(project);
  if (selection?.kind === "CaptionCue") return ["inspect_selected_cue_evidence", "revise_selected_cue"];
  if (selection?.kind === "AudioDescriptionBeat") return ["inspect_selected_ad_evidence", "revise_selected_ad_beat"];
  if (selection?.kind === "AudioDescriptionGap") return ["inspect_selected_gap_evidence", "propose_ad_beat_in_gap"];
  return ["inspect_project"];
};

export const invalidTimingChange = () => invalidToolInput("Timing adjustments require non-zero safe integer millisecond deltas.");
