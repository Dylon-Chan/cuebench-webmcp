import * as Dialog from "@radix-ui/react-dialog";
import type {
  CaptionProject,
  CommandResult,
  DomainCommand,
  QualityFinding,
} from "@cuebench/domain";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  resolveValidatedEvidenceWindow,
  type EvidenceContentResolver,
} from "../evidence/EvidenceInspector";
import { QualityFindings } from "../evidence/QualityFindings";
import { AudioDescriptionGapComposer } from "./AudioDescriptionGapComposer";
import { HumanRulingControls } from "./HumanRulingControls";
import { SelectedItemPanel } from "./SelectedItemPanel";
import type { NarrationPreviewGateway } from "./NarrationPreview";
import type { ReviewDraft, ReviewableItem } from "./review-utils";
import {
  evidenceForItem,
  findingsForItem,
  humanReviewActor,
  indexReviewData,
  itemAccessibleLabel,
  itemProse,
  orderedReviewItems,
  primaryFindingItemId,
  reviewDraftForItem,
  reviewDraftHasContentChanges,
  reviewDraftHasStructuralChanges,
  reviewDraftIsCleanForRevision,
  reviewDraftIsDirty,
  reviewItemForId,
  reviewStateLabel,
  semanticRevisionCommand,
  evidenceAnchorId,
  type ReviewCommandExecutor,
} from "./review-utils";

type DocketFilter = "all" | "Proposed" | "AgentReady" | "Objected" | "Sustained";

interface PendingNavigation {
  readonly itemId: string;
  readonly evidenceId?: string;
  readonly label: string;
  /** Undefined seeks the item's start, null leaves the native clock untouched. */
  readonly seekMs?: number | null;
  readonly itemRevision?: number;
  /** A save was accepted; only retry selection, never save again. */
  readonly savedProject?: CaptionProject;
  /** Agent focus follows its already-accepted BrowserAgent selection; never reissues a Human selection command. */
  readonly browserAgentFocus?: BrowserAgentDocketFocus;
  /** Resolves the agent invocation only after the same draft guard accepts navigation. */
  readonly resolveBrowserAgentFocus?: (accepted: boolean) => void;
  /**
   * A preflight intentionally runs before WebMCP persists SelectItem. It uses
   * the identical draft guard but resolves without changing canonical
   * selection, keeping the old scoped family valid while the dialog is open.
   */
  readonly browserAgentSelectionPreflight?: BrowserAgentDocketFocus;
  readonly resolveBrowserAgentSelectionPreflight?: (accepted: boolean) => void;
}

interface PendingSustainedCommand {
  readonly command: DomainCommand;
  readonly acceptedMessage: string;
  readonly afterSuccessNavigation?: PendingNavigation;
}

interface FocusAfterSelection {
  readonly itemId: string;
  readonly evidenceId?: string;
  readonly itemRevision?: number;
  /** Browser Agent focus is acknowledged only from the matching layout effect. */
  readonly browserAgentFocus?: BrowserAgentDocketFocus;
  readonly resolveBrowserAgentFocus?: (accepted: boolean) => void;
}

/**
 * Browser Agent focus follows a successful page-owned selection command. It
 * never reissues that command as a Human action; it moves the already-visible
 * docket/evidence focus after the workbench has sought the native video.
 */
export interface BrowserAgentDocketFocus {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly playheadMs: number;
  readonly evidenceId?: string;
  /** The exact page-owned visual publication this request waits to observe. */
  readonly visualEpoch?: number;
  /** A pending dirty-draft dialog must close if the Browser Agent cancels. */
  readonly signal?: AbortSignal;
}

export interface ReviewDocketProps {
  readonly project: CaptionProject;
  /** The ProjectStore adapter keeps durable and temporary projects on one canonical command boundary. */
  readonly onCommand: ReviewCommandExecutor;
  /** This is the native video seek callback supplied by VideoEvidenceBay. */
  readonly onSeekToMediaTime: (mediaTimeMs: number) => void;
  readonly footer?: ReactNode;
  /** Task 11 may supply retained bounded evidence without changing review state. */
  readonly evidenceContentResolver?: EvidenceContentResolver;
  /** Cross-surface navigation asks the docket before it can replace a draft. */
  readonly onRegisterItemNavigation?: (navigate: (itemId: string, sourceLabel: string) => void) => void;
  /** Court Record links can target an immutable item revision instead of a generic heading. */
  readonly onRegisterItemRevisionFocus?: (focus: (itemId: string, itemRevision: number, sourceLabel: string) => void) => void;
  /** WebMCP uses this after its own successful BrowserAgent selection command. */
  readonly onRegisterBrowserAgentFocus?: (focus: (input: BrowserAgentDocketFocus) => Promise<boolean>) => void;
  /** WebMCP uses this before it persists a BrowserAgent selection command. */
  readonly onRegisterBrowserAgentSelectionPreflight?: (prepare: (input: BrowserAgentDocketFocus) => Promise<boolean>) => void;
  /** The native timeline reports accepted timing revisions through this review boundary. */
  readonly onRegisterCanonicalTimelineEdit?: (rebase: (itemId: string, previousItemRevision: number, project: CaptionProject) => void) => void;
  /** Lets the native timeline disable commands while this docket owns a draft. */
  readonly onDraftStateChange?: (isDirty: boolean) => void;
  /** Provided by VideoEvidenceBay for a legal caption split convenience. */
  readonly onReadNativePlayheadMs?: () => number;
  /** Hosted narration remains optional; all human review works without it. */
  readonly narrationPreviewGateway?: NarrationPreviewGateway;
}

const filterOptions: readonly { readonly value: DocketFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "Proposed", label: "Proposed" },
  { value: "AgentReady", label: "Agent Ready" },
  { value: "Objected", label: "Objected" },
  { value: "Sustained", label: "Sustained" },
];

const windowThreshold = 80;
/** First render estimate only; ResizeObserver replaces it per complete row. */
const virtualRowEstimate = 148;
const virtualViewportHeight = 552;
const virtualOverscan = 4;
const virtualRowGap = 8;

interface DocketWindowLayout {
  readonly starts: readonly number[];
  readonly heights: readonly number[];
  readonly totalHeight: number;
}

/** O(n) prefix offsets for variable-height semantic docket rows. */
export const createDocketWindowLayout = (
  items: readonly ReviewableItem[],
  measuredHeights: Readonly<Record<string, number>>,
): DocketWindowLayout => {
  const starts: number[] = [];
  const heights: number[] = [];
  let cursor = 0;
  for (const item of items) {
    starts.push(cursor);
    const measured = measuredHeights[item.itemId];
    const height = measured === undefined || !Number.isFinite(measured)
      ? virtualRowEstimate
      : Math.max(44, Math.ceil(measured));
    heights.push(height);
    cursor += height + virtualRowGap;
  }
  return { starts, heights, totalHeight: Math.max(0, cursor - virtualRowGap) };
};

const firstDocketIndexAfter = (layout: DocketWindowLayout, offset: number): number => {
  let lower = 0;
  let upper = layout.starts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = layout.starts[middle]! + layout.heights[middle]!;
    if (end <= offset) lower = middle + 1;
    else upper = middle;
  }
  return lower;
};

const errorMessage = (error: unknown): string => error instanceof Error && error.message.trim().length > 0
  ? error.message
  : "CueBench could not apply this review command. The canonical project state was retained.";

const currentSelectedItem = (project: CaptionProject): ReviewableItem | null => {
  const selected = project.selectedItem;
  if (selected === null || selected.kind === "AudioDescriptionGap") return null;
  return reviewItemForId(project, selected.itemId);
};

const isNewerCanonicalProject = (candidate: CaptionProject, current: CaptionProject): boolean => (
  candidate.projectId === current.projectId && candidate.projectRevision > current.projectRevision
);

const commandItemIds = (command: DomainCommand): readonly string[] => {
  if (command.type === "MergeCue") return [command.cueId, command.adjacentCueId];
  if (command.type === "SplitCue" || command.type === "ReviseCue" || command.type === "AdjustCueTiming") return [command.cueId ?? command.itemId ?? ""];
  if (command.type === "ReviseAudioDescription" || command.type === "AdjustAudioDescriptionTiming") return [command.beatId ?? command.itemId ?? ""];
  return "itemId" in command && command.itemId !== undefined ? [command.itemId] : [];
};

const commandPrimaryItemId = (command: DomainCommand): string | null => commandItemIds(command).find((itemId) => itemId.length > 0) ?? null;

const commandChangesSustainedWork = (project: CaptionProject, command: DomainCommand): boolean => commandItemIds(command)
  .map((itemId) => reviewItemForId(project, itemId))
  .some((item) => item?.current.state === "Sustained");

/** Mobile-only placement lives between the native video and the timeline. */
export function ReviewSelectionSummary({ project }: { readonly project: CaptionProject }) {
  const item = currentSelectedItem(project);
  const focusEditor = () => document.getElementById("selected-item-heading")?.focus();
  return (
    <section className="review-selection-summary" aria-labelledby="review-selection-summary-heading">
      <div>
        <h2 id="review-selection-summary-heading">Selected review item</h2>
        {item === null ? <p>No item selected. Choose a cue from the docket to review its evidence.</p> : <p>{itemAccessibleLabel(item)} · r{item.current.itemRevision} · {item.current.startMs}–{item.current.endMs} ms</p>}
      </div>
      {item === null ? null : <button className="text-button" type="button" onClick={focusEditor}>Open detailed editor</button>}
    </section>
  );
}

/**
 * The docket owns the draft and all review navigation. A visible dirty draft
 * cannot be silently abandoned by selecting a finding, an item, or evidence.
 */
export function ReviewDocket({ project, onCommand, onSeekToMediaTime, footer, evidenceContentResolver, onRegisterItemNavigation, onRegisterItemRevisionFocus, onRegisterBrowserAgentFocus, onRegisterBrowserAgentSelectionPreflight, onRegisterCanonicalTimelineEdit, onDraftStateChange, onReadNativePlayheadMs, narrationPreviewGateway }: ReviewDocketProps) {
  const [filter, setFilter] = useState<DocketFilter>("all");
  const [isCommandPending, setIsCommandPending] = useState(false);
  const commandPendingRef = useRef(false);
  const [acceptedAnnouncement, setAcceptedAnnouncement] = useState<string | null>(null);
  const [errorAnnouncement, setErrorAnnouncement] = useState<string | null>(null);
  const [focusAfterSelection, setFocusAfterSelection] = useState<FocusAfterSelection | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [pendingSustainedCommand, setPendingSustainedCommand] = useState<PendingSustainedCommand | null>(null);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [measuredRowHeights, setMeasuredRowHeights] = useState<Readonly<Record<string, number>>>({});
  const [pinnedDocketItemId, setPinnedDocketItemId] = useState<string | null>(null);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const virtualViewportRef = useRef<HTMLDivElement>(null);
  const docketRowRefs = useRef(new Map<string, HTMLLIElement>());
  const docketRowObserverRef = useRef<ResizeObserver | null>(null);
  const selectedItem = currentSelectedItem(project);
  const initialFocusRequested = useRef(false);
  const [draft, setDraft] = useState<ReviewDraft | null>(() => selectedItem === null ? null : reviewDraftForItem(selectedItem));
  const draftRef = useRef(draft);
  const previousCanonicalProjectRef = useRef(project);
  const pendingTimelineRebaseRef = useRef<{ readonly itemId: string; readonly itemRevision: number; readonly projectRevision: number } | null>(null);
  const browserAgentNavigationSettlersRef = useRef(new Set<(accepted: boolean) => void>());
  draftRef.current = draft;
  const replaceDraft = useCallback((nextDraft: ReviewDraft | null) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);
  const items = useMemo(() => orderedReviewItems(project), [project]);
  const indexes = useMemo(() => indexReviewData(project), [project]);
  const filteredItems = useMemo(() => filter === "all"
    ? items
    : items.filter((item) => item.current.state === filter), [filter, items]);
  const draftItem = draft === null ? null : reviewItemForId(project, draft.itemId);
  const timelineRebasePending = draft !== null
    && selectedItem !== null
    && pendingTimelineRebaseRef.current?.itemId === draft.itemId
    && pendingTimelineRebaseRef.current.itemId === selectedItem.itemId
    && pendingTimelineRebaseRef.current.itemRevision === draft.itemRevision;
  const hasUnsavedDraft = timelineRebasePending ? false : reviewDraftIsDirty(draftItem, draft);
  const draftForSelectedItem = selectedItem !== null && draft !== null && draft.itemId === selectedItem.itemId && draft.itemRevision === selectedItem.current.itemRevision
    ? draft
    : selectedItem !== null && draft !== null && draft.itemId === selectedItem.itemId
      ? draft
    : selectedItem === null ? null : reviewDraftForItem(selectedItem);
  // A BrowserAgent may have selected a new canonical item while the Human is
  // still editing another item. Save/discard must remain bound to the draft's
  // immutable source revision, never silently reinterpret it as the new
  // selection.
  const draftTargetItem = draft === null ? selectedItem : draftItem;
  const draftForTargetItem = draftTargetItem === null
    ? null
    : draft !== null && draft.itemId === draftTargetItem.itemId
      ? draft
      : reviewDraftForItem(draftTargetItem);
  const structuralDraftIsDirty = reviewDraftHasStructuralChanges(draftTargetItem, draftForTargetItem);
  const draftSaveCommand = draftTargetItem === null || draftForTargetItem === null || structuralDraftIsDirty || !reviewDraftHasContentChanges(draftTargetItem, draftForTargetItem)
    ? null
    : draftForTargetItem.itemRevision !== draftTargetItem.current.itemRevision
      ? null
      : semanticRevisionCommand(project, draftTargetItem, draftForTargetItem);
  const windowed = filteredItems.length > windowThreshold;
  const virtualLayout = useMemo(() => createDocketWindowLayout(filteredItems, measuredRowHeights), [filteredItems, measuredRowHeights]);
  const renderedDocketIndexes = useMemo(() => {
    if (!windowed) return filteredItems.map((_, index) => index);
    const first = Math.max(0, firstDocketIndexAfter(virtualLayout, virtualScrollTop) - virtualOverscan);
    const lastVisible = firstDocketIndexAfter(virtualLayout, virtualScrollTop + virtualViewportHeight);
    const last = Math.min(filteredItems.length, lastVisible + virtualOverscan + 1);
    const indexesToRender = new Set<number>();
    for (let index = first; index < last; index += 1) indexesToRender.add(index);
    for (const itemId of [focusAfterSelection?.itemId, pinnedDocketItemId]) {
      if (itemId === undefined || itemId === null) continue;
      const index = filteredItems.findIndex((item) => item.itemId === itemId);
      if (index >= 0) indexesToRender.add(index);
    }
    return [...indexesToRender].sort((left, right) => left - right);
  }, [filteredItems, focusAfterSelection?.itemId, pinnedDocketItemId, virtualLayout, virtualScrollTop, windowed]);

  // Do not let a deferred mount effect overwrite a newer finding/evidence
  // focus request. The first selected item gets focus only if nothing more
  // specific has already claimed it.
  useLayoutEffect(() => {
    if (initialFocusRequested.current) return;
    initialFocusRequested.current = true;
    if (selectedItem !== null) {
      setFocusAfterSelection((current) => current ?? { itemId: selectedItem.itemId });
    }
  }, [selectedItem]);

  useLayoutEffect(() => {
    const previousProject = previousCanonicalProjectRef.current;
    previousCanonicalProjectRef.current = project;
    if (previousProject === project) return;
    const currentDraft = draftRef.current;
    if (currentDraft === null) return;
    const previousItem = reviewItemForId(previousProject, currentDraft.itemId);
    const canonicalItem = reviewItemForId(project, currentDraft.itemId);
    const canonicalSelection = currentSelectedItem(project);
    if (
      previousItem === null
      || canonicalItem === null
      || canonicalSelection?.itemId !== canonicalItem.itemId
      || previousItem.current.itemRevision === canonicalItem.current.itemRevision
    ) return;
    // Commands owned outside the docket (notably WebMCP) publish through the
    // same store, but cannot call the timeline's eager rebase callback. A
    // clean draft may follow its exact immutable successor; a Human-modified
    // draft fails this comparison and remains protected by the normal guard.
    if (!reviewDraftIsCleanForRevision(currentDraft, previousItem, previousItem.current)) return;
    pendingTimelineRebaseRef.current = {
      itemId: canonicalItem.itemId,
      itemRevision: canonicalItem.current.itemRevision,
      projectRevision: project.projectRevision,
    };
    replaceDraft(reviewDraftForItem(canonicalItem));
  }, [project, replaceDraft]);

  useEffect(() => {
    if (timelineRebasePending) return;
    if (selectedItem === null) {
      if (!hasUnsavedDraft) {
        replaceDraft(null);
      }
      return;
    }
    if (draft === null || !hasUnsavedDraft) {
      if (draft?.itemId !== selectedItem.itemId || draft.itemRevision !== selectedItem.current.itemRevision) {
        replaceDraft(reviewDraftForItem(selectedItem));
      }
    }
  }, [draft, hasUnsavedDraft, replaceDraft, selectedItem, timelineRebasePending]);

  useEffect(() => {
    const pending = pendingTimelineRebaseRef.current;
    if (pending !== null && project.projectRevision >= pending.projectRevision) {
      pendingTimelineRebaseRef.current = null;
    }
  }, [project.projectRevision]);

  const executeCommand = useCallback(async (
    command: DomainCommand,
    acceptedMessage: string,
  ): Promise<CommandResult | null> => {
    if (commandPendingRef.current) return null;
    commandPendingRef.current = true;
    setIsCommandPending(true);
    setAcceptedAnnouncement(null);
    setErrorAnnouncement(null);
    try {
      const result = await onCommand(command);
      if (result === null || result === undefined || typeof result !== "object" || !("project" in result) || result.project === null || result.project === undefined || typeof result.project !== "object") {
        setErrorAnnouncement("CueBench did not return an accepted result. The saved project was not changed; retry or discard the draft.");
        return null;
      }
      if (result.error !== undefined) {
        setErrorAnnouncement(result.error.message);
        return result;
      }
      setAcceptedAnnouncement(acceptedMessage);
      return result;
    } catch (error) {
      setErrorAnnouncement(errorMessage(error));
      return null;
    } finally {
      commandPendingRef.current = false;
      setIsCommandPending(false);
    }
  }, [onCommand]);

  const syncDraftToCanonical = useCallback((canonicalProject: CaptionProject, itemId: string | null) => {
    if (itemId === null) return;
    const canonicalItem = reviewItemForId(canonicalProject, itemId);
    const nextDraft = canonicalItem === null ? null : reviewDraftForItem(canonicalItem);
    replaceDraft(nextDraft);
  }, [replaceDraft]);

  const performNavigation = useCallback(async (navigation: PendingNavigation, baseProject: CaptionProject): Promise<boolean> => {
    if (navigation.browserAgentFocus?.signal?.aborted === true || navigation.browserAgentSelectionPreflight?.signal?.aborted === true) {
      navigation.resolveBrowserAgentFocus?.(false);
      navigation.resolveBrowserAgentSelectionPreflight?.(false);
      setPendingNavigation((pending) => pending === navigation ? null : pending);
      return false;
    }
    const target = reviewItemForId(baseProject, navigation.itemId);
    if (target === null) {
      setErrorAnnouncement("The requested review item is not available in the current project state.");
      navigation.resolveBrowserAgentFocus?.(false);
      navigation.resolveBrowserAgentSelectionPreflight?.(false);
      return false;
    }
    if (navigation.browserAgentSelectionPreflight !== undefined) {
      if (target.current.itemRevision !== navigation.browserAgentSelectionPreflight.itemRevision) {
        setErrorAnnouncement("The Browser Agent focus target is no longer the current visible revision.");
        navigation.resolveBrowserAgentSelectionPreflight?.(false);
        setPendingNavigation(null);
        return false;
      }
      // Do not select or seek here. This is solely the page-owned Human draft
      // guard that must settle before the agent can issue its own SelectItem.
      setPendingNavigation(null);
      navigation.resolveBrowserAgentSelectionPreflight?.(true);
      return true;
    }
    if (navigation.browserAgentFocus !== undefined) {
      const selected = baseProject.selectedItem;
      if (
        target.current.itemRevision !== navigation.browserAgentFocus.itemRevision
        || selected?.kind === "AudioDescriptionGap"
        || selected === null
        || selected.itemId !== target.itemId
        || selected.itemRevision !== navigation.browserAgentFocus.itemRevision
      ) {
        setErrorAnnouncement("The Browser Agent focus target is no longer the current visible revision.");
        navigation.resolveBrowserAgentFocus?.(false);
        setPendingNavigation(null);
        return false;
      }
      setFilter("all");
      setFocusAfterSelection({
        itemId: target.itemId,
        ...(navigation.browserAgentFocus.evidenceId === undefined ? {} : { evidenceId: navigation.browserAgentFocus.evidenceId }),
        itemRevision: navigation.browserAgentFocus.itemRevision,
        browserAgentFocus: navigation.browserAgentFocus,
        ...(navigation.resolveBrowserAgentFocus === undefined ? {} : { resolveBrowserAgentFocus: navigation.resolveBrowserAgentFocus }),
      });
      setPendingNavigation(null);
      // The Browser Agent must not return until this exact docket anchor has
      // been mounted, filtered, and focused by the layout effect below.
      return true;
    }
    setFilter("all");
    const result = await executeCommand({
      type: "SelectItem",
      actor: humanReviewActor,
      itemId: target.itemId,
      expectedItemRevision: target.current.itemRevision,
      expectedProjectRevision: baseProject.projectRevision,
    }, `Selected ${itemAccessibleLabel(target)} and sought its start time in the source video.`);
    if (result === null || result.error !== undefined) {
      // Durable command adapters can return the current canonical project with
      // a stale-selection error. Adopt that newer snapshot for the retry so
      // the saved revision is never reissued against abandoned guards.
      if (result !== null && result.error !== undefined && isNewerCanonicalProject(result.project, baseProject)) {
        syncDraftToCanonical(result.project, currentSelectedItem(result.project)?.itemId ?? null);
        setPendingNavigation((pending) => pending === null || pending.savedProject === undefined
          ? pending
          : { ...pending, savedProject: result.project });
      }
      return false;
    }
    const canonicalItem = reviewItemForId(result.project, target.itemId);
    if (canonicalItem === null) {
      setErrorAnnouncement("CueBench accepted the selection but the item is no longer available in its canonical project state.");
      return false;
    }
    syncDraftToCanonical(result.project, canonicalItem.itemId);
    if (navigation.seekMs !== null) onSeekToMediaTime(navigation.seekMs ?? canonicalItem.current.startMs);
    setFocusAfterSelection(navigation.evidenceId === undefined
      ? { itemId: canonicalItem.itemId, ...(navigation.itemRevision === undefined ? {} : { itemRevision: navigation.itemRevision }) }
      : { itemId: canonicalItem.itemId, evidenceId: navigation.evidenceId });
    setPendingNavigation(null);
    return true;
  }, [executeCommand, onSeekToMediaTime, syncDraftToCanonical]);

  const applySemanticCommand = useCallback(async (
    command: DomainCommand,
    acceptedMessage: string,
    afterSuccessNavigation?: PendingNavigation,
  ): Promise<boolean> => {
    const result = await executeCommand(command, acceptedMessage);
    if (result === null || result.error !== undefined) return false;
    const itemId = commandPrimaryItemId(command);
    syncDraftToCanonical(result.project, itemId);
    if (afterSuccessNavigation !== undefined) {
      const retryNavigation = { ...afterSuccessNavigation, savedProject: result.project };
      // Once an edit has been accepted, a later failed selection must never
      // offer a second save against the new immutable revision.
      setPendingNavigation(retryNavigation);
      return performNavigation(retryNavigation, result.project);
    }
    return true;
  }, [executeCommand, performNavigation, syncDraftToCanonical]);

  const requestSemanticCommand = useCallback((command: DomainCommand, acceptedMessage: string, afterSuccessNavigation?: PendingNavigation) => {
    if (structuralDraftIsDirty && command.type !== "SplitCue") {
      setErrorAnnouncement("Apply the split or discard structural changes first. This action cannot include a changed split point or new caption identifier.");
      return;
    }
    if (commandChangesSustainedWork(project, command)) {
      setPendingSustainedCommand(afterSuccessNavigation === undefined
        ? { command, acceptedMessage }
        : { command, acceptedMessage, afterSuccessNavigation });
      return;
    }
    void applySemanticCommand(command, acceptedMessage, afterSuccessNavigation);
  }, [applySemanticCommand, project, structuralDraftIsDirty]);

  const requestNavigation = useCallback((navigation: PendingNavigation) => {
    if (hasUnsavedDraft) {
      setPendingNavigation(navigation);
      return;
    }
    void performNavigation(navigation, project);
  }, [hasUnsavedDraft, performNavigation, project]);

  const requestBrowserAgentFocus = useCallback((input: BrowserAgentDocketFocus): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    let navigation: PendingNavigation | null = null;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      browserAgentNavigationSettlersRef.current.delete(settle);
      resolve(accepted);
    };
    const onAbort = () => {
      setPendingNavigation((pending) => pending === navigation ? null : pending);
      setFocusAfterSelection((focus) => focus?.browserAgentFocus === input ? null : focus);
      settle(false);
    };
    if (input.signal?.aborted === true) {
      settle(false);
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    browserAgentNavigationSettlersRef.current.add(settle);
    const item = reviewItemForId(project, input.itemId);
    const selected = project.selectedItem;
    if (
      item === null
      || item.current.itemRevision !== input.itemRevision
      || selected === null
      || selected.kind === "AudioDescriptionGap"
      || selected.itemId !== input.itemId
      || selected.itemRevision !== input.itemRevision
    ) {
      setErrorAnnouncement("The Browser Agent focus target is no longer the current visible revision.");
      settle(false);
      return;
    }
    navigation = {
      itemId: input.itemId,
      itemRevision: input.itemRevision,
      label: `Browser Agent selection ${itemAccessibleLabel(item)}`,
      browserAgentFocus: input,
      resolveBrowserAgentFocus: settle,
    };
    if (hasUnsavedDraft) {
      setPendingNavigation(navigation);
      return;
    }
    void performNavigation(navigation, project);
  }), [hasUnsavedDraft, performNavigation, project]);

  const requestBrowserAgentSelectionPreflight = useCallback((input: BrowserAgentDocketFocus): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    let navigation: PendingNavigation | null = null;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      browserAgentNavigationSettlersRef.current.delete(settle);
      resolve(accepted);
    };
    const onAbort = () => {
      setPendingNavigation((pending) => pending === navigation ? null : pending);
      settle(false);
    };
    if (input.signal?.aborted === true) {
      settle(false);
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    browserAgentNavigationSettlersRef.current.add(settle);
    const item = reviewItemForId(project, input.itemId);
    if (item === null || item.current.itemRevision !== input.itemRevision) {
      setErrorAnnouncement("The Browser Agent focus target is no longer the current visible revision.");
      settle(false);
      return;
    }
    // Revealing the already-selected editor never discards its own draft.
    const selected = project.selectedItem;
    if (selected !== null && selected.kind !== "AudioDescriptionGap" && selected.itemId === input.itemId && selected.itemRevision === input.itemRevision) {
      settle(true);
      return;
    }
    navigation = {
      itemId: input.itemId,
      itemRevision: input.itemRevision,
      label: `Browser Agent selection ${itemAccessibleLabel(item)}`,
      browserAgentSelectionPreflight: input,
      resolveBrowserAgentSelectionPreflight: settle,
    };
    if (hasUnsavedDraft) {
      setPendingNavigation(navigation);
      return;
    }
    void performNavigation(navigation, project);
  }), [hasUnsavedDraft, performNavigation, project]);

  const cancelPendingNavigation = useCallback(() => {
    setPendingNavigation((pending) => {
      pending?.resolveBrowserAgentFocus?.(false);
      pending?.resolveBrowserAgentSelectionPreflight?.(false);
      return null;
    });
  }, []);

  useEffect(() => () => {
    for (const settle of browserAgentNavigationSettlersRef.current) settle(false);
    browserAgentNavigationSettlersRef.current.clear();
  }, []);

  useEffect(() => {
    onDraftStateChange?.(hasUnsavedDraft);
  }, [hasUnsavedDraft, onDraftStateChange]);

  useEffect(() => {
    onRegisterItemNavigation?.((itemId, sourceLabel) => {
      const item = reviewItemForId(project, itemId);
      if (item === null) {
        setErrorAnnouncement("The requested review item is not available in the current project state.");
        return;
      }
      requestNavigation({ itemId, label: sourceLabel || itemAccessibleLabel(item) });
    });
  }, [onRegisterItemNavigation, project, requestNavigation]);

  useEffect(() => {
    onRegisterItemRevisionFocus?.((itemId, itemRevision, sourceLabel) => {
      const item = reviewItemForId(project, itemId);
      const revisionExists = item?.revisions.some((revision) => revision.itemRevision === itemRevision) ?? false;
      if (item === null || !revisionExists) {
        setErrorAnnouncement("The Court Record target revision is not available in the current project state.");
        return;
      }
      requestNavigation({ itemId, itemRevision, label: sourceLabel || `${itemAccessibleLabel(item)} r${itemRevision}` });
    });
  }, [onRegisterItemRevisionFocus, project, requestNavigation]);

  useLayoutEffect(() => {
    onRegisterBrowserAgentFocus?.(requestBrowserAgentFocus);
  }, [onRegisterBrowserAgentFocus, requestBrowserAgentFocus]);

  useLayoutEffect(() => {
    onRegisterBrowserAgentSelectionPreflight?.(requestBrowserAgentSelectionPreflight);
  }, [onRegisterBrowserAgentSelectionPreflight, requestBrowserAgentSelectionPreflight]);

  useEffect(() => {
    onRegisterCanonicalTimelineEdit?.((itemId, previousItemRevision, canonicalProject) => {
      const canonicalItem = reviewItemForId(canonicalProject, itemId);
      if (canonicalItem === null) return;
      const previousRevision = canonicalItem.revisions.find((revision) => revision.itemRevision === previousItemRevision);
      // A timeline mutation is allowed only while the editor reported a clean
      // draft. Rebase that exact immutable snapshot to its accepted canonical
      // successor before the route re-renders, avoiding a false stale draft.
      if (previousRevision !== undefined && reviewDraftIsCleanForRevision(draftRef.current, canonicalItem, previousRevision)) {
        pendingTimelineRebaseRef.current = {
          itemId: canonicalItem.itemId,
          itemRevision: canonicalItem.current.itemRevision,
          projectRevision: canonicalProject.projectRevision,
        };
        replaceDraft(reviewDraftForItem(canonicalItem));
      }
    });
  }, [onRegisterCanonicalTimelineEdit, replaceDraft]);

  const selectItem = useCallback((item: ReviewableItem) => {
    requestNavigation({ itemId: item.itemId, label: itemAccessibleLabel(item) });
  }, [requestNavigation]);

  const focusFinding = useCallback((finding: QualityFinding) => {
    const itemId = primaryFindingItemId(finding);
    if (itemId === null) {
      setErrorAnnouncement("This project-wide finding does not identify one timeline item to select.");
      return;
    }
    const item = reviewItemForId(project, itemId);
    if (item === null) {
      setErrorAnnouncement("The finding references an item that is not available in the current project state.");
      return;
    }
    requestNavigation({ itemId, label: `finding for ${itemAccessibleLabel(item)}` });
  }, [project, requestNavigation]);

  const focusEvidence = useCallback((item: ReviewableItem, evidenceId: string) => {
    const evidence = evidenceForItem(indexes, item.itemId).find((entry) => entry.evidenceId === evidenceId);
    if (evidence === undefined) {
      setErrorAnnouncement("The requested evidence provenance is not available for this item.");
      return;
    }
    const resolution = resolveValidatedEvidenceWindow(project, evidence, evidenceContentResolver);
    if (resolution.status === "invalid") {
      setErrorAnnouncement(resolution.message);
      return;
    }
    requestNavigation({
      itemId: item.itemId,
      evidenceId,
      label: `evidence ${evidenceId}`,
      // A missing package can still reveal its provenance, but never invents a
      // media seek. A validated window seeks its recorded bounded start.
      seekMs: resolution.status === "available" ? resolution.window.startMs : null,
    });
  }, [evidenceContentResolver, indexes, project, requestNavigation]);

  const registerItemButton = useCallback((itemId: string, element: HTMLButtonElement | null) => {
    if (element === null) itemButtonRefs.current.delete(itemId);
    else itemButtonRefs.current.set(itemId, element);
  }, []);

  const recordDocketRowHeight = useCallback((itemId: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const nextHeight = Math.max(44, Math.ceil(height));
    setMeasuredRowHeights((current) => {
      if (Math.abs((current[itemId] ?? 0) - nextHeight) < 1) return current;
      return { ...current, [itemId]: nextHeight };
    });
  }, []);

  const registerDocketRow = useCallback((itemId: string, element: HTMLLIElement | null) => {
    const previous = docketRowRefs.current.get(itemId);
    if (previous !== undefined && previous !== element) docketRowObserverRef.current?.unobserve(previous);
    if (element === null) {
      docketRowRefs.current.delete(itemId);
      return;
    }
    docketRowRefs.current.set(itemId, element);
    docketRowObserverRef.current?.observe(element);
    recordDocketRowHeight(itemId, element.getBoundingClientRect().height);
  }, [recordDocketRowHeight]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const itemId = (entry.target as HTMLElement).dataset.docketItemId;
        // contentRect excludes the row’s padding and borders; prefix offsets
        // must use its rendered border box so following prose never overlaps.
        if (itemId !== undefined) recordDocketRowHeight(itemId, (entry.target as HTMLElement).getBoundingClientRect().height);
      }
    });
    docketRowObserverRef.current = observer;
    for (const row of docketRowRefs.current.values()) observer.observe(row);
    return () => {
      observer.disconnect();
      if (docketRowObserverRef.current === observer) docketRowObserverRef.current = null;
    };
  }, [recordDocketRowHeight]);

  useLayoutEffect(() => {
    if (focusAfterSelection === null || isCommandPending) return;
    if (focusAfterSelection.browserAgentFocus?.signal?.aborted === true) {
      focusAfterSelection.resolveBrowserAgentFocus?.(false);
      setFocusAfterSelection(null);
      return;
    }
    const index = filteredItems.findIndex((item) => item.itemId === focusAfterSelection.itemId);
    if (index === -1) return;
    if (windowed) {
      const wantedScrollTop = Math.max(0, virtualLayout.starts[index]! - virtualViewportHeight / 3);
      if (Math.abs(virtualScrollTop - wantedScrollTop) > 1) {
        const viewport = virtualViewportRef.current;
        if (viewport !== null) viewport.scrollTop = wantedScrollTop;
        setVirtualScrollTop(wantedScrollTop);
        return;
      }
    }
    const target = focusAfterSelection.evidenceId === undefined
      ? focusAfterSelection.itemRevision === undefined
        ? itemButtonRefs.current.get(focusAfterSelection.itemId)
        : document.getElementById(`revision-${encodeURIComponent(focusAfterSelection.itemId)}-${focusAfterSelection.itemRevision}`)
      : document.getElementById(evidenceAnchorId(focusAfterSelection.evidenceId));
    if (target instanceof HTMLElement) {
      target.focus();
      const browserAgentFocus = focusAfterSelection.browserAgentFocus;
      if (
        browserAgentFocus !== undefined
        && document.activeElement !== target
      ) return;
      // This layout effect is the exact per-focus/evidence acknowledgment:
      // the active filter is All, the requested anchor exists, and focus has
      // moved before the route seeks and verifies the one native video clock.
      if (browserAgentFocus !== undefined) focusAfterSelection.resolveBrowserAgentFocus?.(true);
      setFocusAfterSelection(null);
    }
  }, [filter, filteredItems, focusAfterSelection, isCommandPending, virtualLayout, virtualScrollTop, windowed]);

  const discardDraft = useCallback(() => {
    replaceDraft(selectedItem === null ? null : reviewDraftForItem(selectedItem));
  }, [replaceDraft, selectedItem]);

  const saveDraftAndContinue = () => {
    if (pendingNavigation === null || draftTargetItem === null || structuralDraftIsDirty || draftSaveCommand === null) {
      setErrorAnnouncement("Apply the split or discard structural changes first. A caption revision cannot include a changed split point or new caption identifier.");
      return;
    }
    if (commandChangesSustainedWork(project, draftSaveCommand)) {
      const navigation = pendingNavigation;
      // A confirmation is itself a blocking decision. Close the first modal so
      // assistive technology and focus never face two open dialogs at once.
      setPendingNavigation(null);
      setPendingSustainedCommand({
        command: draftSaveCommand,
        acceptedMessage: `Saved the reviewed revision for ${itemAccessibleLabel(draftTargetItem)}.`,
        afterSuccessNavigation: navigation,
      });
      return;
    }
    requestSemanticCommand(draftSaveCommand, `Saved the reviewed revision for ${itemAccessibleLabel(draftTargetItem)}.`, pendingNavigation);
  };

  const executeRuling = useCallback(async (command: DomainCommand, acceptedMessage: string): Promise<CommandResult | null> => {
    const result = await executeCommand(command, acceptedMessage);
    if (result !== null && result.error === undefined) syncDraftToCanonical(result.project, commandPrimaryItemId(command));
    return result;
  }, [executeCommand, syncDraftToCanonical]);

  const acceptGapBeat = useCallback((result: CommandResult, beatId: string) => {
    syncDraftToCanonical(result.project, beatId);
    setFilter("all");
    setFocusAfterSelection({ itemId: beatId });
  }, [syncDraftToCanonical]);

  const renderDocketItem = (item: ReviewableItem, index: number) => {
    const findings = findingsForItem(indexes, item.itemId);
    const evidence = evidenceForItem(indexes, item.itemId);
    const selected = selectedItem?.itemId === item.itemId;
    const itemStyle = windowed ? {
      position: "absolute" as const,
      insetInline: 0,
      top: `${virtualLayout.starts[index]!}px`,
      minHeight: `${virtualLayout.heights[index]!}px`,
    } : undefined;
    return (
      <li ref={(element) => registerDocketRow(item.itemId, element)} className={`docket-item${windowed ? " docket-item--windowed" : ""}`} key={item.itemId} style={itemStyle} data-docket-item-id={item.itemId} data-selected={selected || undefined} aria-posinset={windowed ? index + 1 : undefined} aria-setsize={windowed ? filteredItems.length : undefined} onFocusCapture={() => setPinnedDocketItemId(item.itemId)}>
        <button
          ref={(element) => registerItemButton(item.itemId, element)}
          type="button"
          className="docket-item__select"
          onClick={() => selectItem(item)}
          disabled={isCommandPending}
          aria-current={selected ? "true" : undefined}
          aria-label={`Select ${itemAccessibleLabel(item)}: ${itemProse(item)}`}
        >
          <span className="docket-item__identity"><strong>{item.itemId.toUpperCase()}</strong><em>{item.kind === "CaptionCue" ? "Caption" : "Audio description"}</em></span>
          <span className="docket-item__prose">{itemProse(item)}</span>
        </button>
        <dl className="docket-item__facts">
          <div><dt>Time</dt><dd>{item.current.startMs}–{item.current.endMs} ms</dd></div>
          {item.kind !== "CaptionCue" ? null : <div><dt>Speaker</dt><dd>{item.current.speaker ?? "Unattributed"}</dd></div>}
          <div><dt>State</dt><dd><span className={`review-state review-state--${item.current.state.toLowerCase()}`}>{reviewStateLabel(item.current.state)}</span></dd></div>
          <div><dt>Revision</dt><dd>r{item.current.itemRevision}{item.current.parentItemRevision === null ? " · root" : ` → r${item.current.parentItemRevision}`}</dd></div>
        </dl>
        <div className="docket-item__links">
          <span>{findings.length} finding{findings.length === 1 ? "" : "s"}</span>
          {evidence.length === 0 ? <span>No evidence link</span> : evidence.map((entry) => <button className="text-button" type="button" key={entry.evidenceId} disabled={isCommandPending} onClick={() => focusEvidence(item, entry.evidenceId)} aria-label={`Open evidence ${entry.evidenceId}`}>{entry.evidenceId}</button>)}
        </div>
      </li>
    );
  };

  return (
    <section className="review-docket" aria-labelledby="review-docket-heading" aria-busy={isCommandPending || undefined}>
      <div className="region-heading">
        <div><h2 id="review-docket-heading">Review Docket</h2><p>{items.length} review items</p></div>
        <span className="docket-indicator">Live state</span>
      </div>
      <div className="docket-tabs" role="group" aria-label="Review item filters">
        {filterOptions.map((option) => (
          <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>
        ))}
      </div>
      <div className={`docket-content${windowed ? " docket-content--windowed" : ""}`}>
        {filteredItems.length === 0 ? (
          <p className="empty-docket">{items.length === 0 ? "Caption generation will place proposed cues here for human review." : "No items match this review-state filter."}</p>
        ) : windowed ? (
          <div className="docket-list-viewport" ref={virtualViewportRef} onScroll={(event) => setVirtualScrollTop(event.currentTarget.scrollTop)}>
            <ol className="docket-list docket-list--windowed" aria-label="Review items" style={{ height: `${virtualLayout.totalHeight}px` }}>
              {renderedDocketIndexes.map((index) => renderDocketItem(filteredItems[index]!, index))}
            </ol>
          </div>
        ) : (
          <ol className="docket-list" aria-label="Review items">{renderedDocketIndexes.map((index) => renderDocketItem(filteredItems[index]!, index))}</ol>
        )}
      </div>
      <SelectedItemPanel
        project={project}
        item={selectedItem}
        draft={draftForSelectedItem}
        indexes={indexes}
        isCommandPending={isCommandPending}
        onDraftChange={replaceDraft}
        onDiscardDraft={discardDraft}
        onSeekItem={(item) => requestNavigation({ itemId: item.itemId, label: `source video for ${itemAccessibleLabel(item)}` })}
        onFocusFinding={focusFinding}
        onFocusEvidence={focusEvidence}
        onRequestSemanticCommand={requestSemanticCommand}
        {...(focusAfterSelection?.itemRevision === undefined ? {} : { focusedRevision: focusAfterSelection.itemRevision })}
        {...(onReadNativePlayheadMs === undefined ? {} : { onReadNativePlayheadMs })}
        {...(evidenceContentResolver === undefined ? {} : { evidenceContentResolver })}
        {...(narrationPreviewGateway === undefined ? {} : { narrationPreviewGateway })}
      />
      <HumanRulingControls item={selectedItem} project={project} isCommandPending={isCommandPending} hasUnsavedDraft={hasUnsavedDraft} commandError={errorAnnouncement} onExecuteCommand={executeRuling} />
      <QualityFindings project={project} indexes={indexes} onFocusFinding={focusFinding} disabled={isCommandPending} />
      <AudioDescriptionGapComposer
        project={project}
        isCommandPending={isCommandPending}
        hasUnsavedDraft={hasUnsavedDraft}
        onExecuteCommand={executeCommand}
        onAcceptedBeat={acceptGapBeat}
      />
      {footer}
      {acceptedAnnouncement === null ? null : <p className="review-accepted-feedback" role="status" aria-live="polite">{acceptedAnnouncement}</p>}
      {errorAnnouncement === null ? null : <p className="review-command-feedback" role="alert" aria-live="assertive">{errorAnnouncement}</p>}
      <Dialog.Root open={pendingNavigation !== null} onOpenChange={(open) => { if (!open) cancelPendingNavigation(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog review-dialog" aria-describedby="unsaved-draft-description">
            <Dialog.Title>{pendingNavigation?.savedProject === undefined ? "Unsaved review draft" : "Navigation still pending"}</Dialog.Title>
            <Dialog.Description id="unsaved-draft-description">{pendingNavigation === null ? "" : pendingNavigation.savedProject === undefined
              ? structuralDraftIsDirty
                ? `Apply the split or discard structural changes before opening ${pendingNavigation.label}. A caption revision cannot include a changed split point or new caption identifier.`
                : `Save, apply, discard, or cancel before opening ${pendingNavigation.label}. The current form displays an unsaved text or timing change.`
              : `Your draft was saved in canonical project revision ${pendingNavigation.savedProject.projectRevision}, but ${pendingNavigation.label} could not be opened. Retry navigation without saving a second revision, or cancel.`}</Dialog.Description>
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button">Cancel navigation</Dialog.Close>
              {pendingNavigation?.savedProject === undefined ? <>
                <button className="button button--outline" type="button" disabled={isCommandPending} onClick={() => { const navigation = pendingNavigation; discardDraft(); if (navigation !== null) void performNavigation(navigation, project); }}>Discard draft and continue</button>
                {structuralDraftIsDirty ? null : <button className="button button--signal" type="button" disabled={isCommandPending || draftSaveCommand === null} onClick={saveDraftAndContinue}>Save changes and continue</button>}
              </> : <button className="button button--signal" type="button" disabled={isCommandPending} onClick={() => void performNavigation(pendingNavigation, pendingNavigation.savedProject!)}>Retry navigation</button>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={pendingSustainedCommand !== null} onOpenChange={(open) => { if (!open) setPendingSustainedCommand(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog review-dialog" aria-describedby="sustained-revision-description">
            <Dialog.Title>Revise Sustained {selectedItem === null ? "item" : itemAccessibleLabel(selectedItem)}</Dialog.Title>
            <Dialog.Description id="sustained-revision-description">This change preserves the accepted immutable revision and creates a new Proposed revision for review.</Dialog.Description>
            {errorAnnouncement === null ? null : <p className="review-command-feedback" role="alert">{errorAnnouncement}</p>}
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button">Cancel</Dialog.Close>
              <button className="button button--signal" type="button" disabled={isCommandPending} onClick={() => { const pending = pendingSustainedCommand; if (pending === null) return; void applySemanticCommand(pending.command, pending.acceptedMessage, pending.afterSuccessNavigation).then((accepted) => { if (accepted) setPendingSustainedCommand(null); }); }}>Create Proposed revision</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
