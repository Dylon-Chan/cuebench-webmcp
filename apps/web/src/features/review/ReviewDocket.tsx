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
import { EvidenceInspector, type EvidenceContentResolver } from "../evidence/EvidenceInspector";
import { QualityFindings } from "../evidence/QualityFindings";
import { HumanRulingControls } from "./HumanRulingControls";
import { SelectedItemPanel } from "./SelectedItemPanel";
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
}

interface PendingSustainedCommand {
  readonly command: DomainCommand;
  readonly acceptedMessage: string;
  readonly afterSuccessNavigation?: PendingNavigation;
}

interface FocusAfterSelection {
  readonly itemId: string;
  readonly evidenceId?: string;
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
  /** Lets the native timeline disable commands while this docket owns a draft. */
  readonly onDraftStateChange?: (isDirty: boolean) => void;
  /** Provided by VideoEvidenceBay for a legal caption split convenience. */
  readonly onReadNativePlayheadMs?: () => number;
}

const filterOptions: readonly { readonly value: DocketFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "Proposed", label: "Proposed" },
  { value: "AgentReady", label: "Agent Ready" },
  { value: "Objected", label: "Objected" },
  { value: "Sustained", label: "Sustained" },
];

const windowThreshold = 80;
const virtualRowHeight = 184;
const virtualViewportHeight = 552;
const virtualOverscan = 4;

const errorMessage = (error: unknown): string => error instanceof Error && error.message.trim().length > 0
  ? error.message
  : "CueBench could not apply this review command. The canonical project state was retained.";

const currentSelectedItem = (project: CaptionProject): ReviewableItem | null => {
  const selected = project.selectedItem;
  if (selected === null || selected.kind === "AudioDescriptionGap") return null;
  return reviewItemForId(project, selected.itemId);
};

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
export function ReviewDocket({ project, onCommand, onSeekToMediaTime, footer, evidenceContentResolver, onRegisterItemNavigation, onDraftStateChange, onReadNativePlayheadMs }: ReviewDocketProps) {
  const [filter, setFilter] = useState<DocketFilter>("all");
  const [isCommandPending, setIsCommandPending] = useState(false);
  const commandPendingRef = useRef(false);
  const [acceptedAnnouncement, setAcceptedAnnouncement] = useState<string | null>(null);
  const [errorAnnouncement, setErrorAnnouncement] = useState<string | null>(null);
  const [focusAfterSelection, setFocusAfterSelection] = useState<FocusAfterSelection | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [pendingSustainedCommand, setPendingSustainedCommand] = useState<PendingSustainedCommand | null>(null);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const virtualViewportRef = useRef<HTMLDivElement>(null);
  const selectedItem = currentSelectedItem(project);
  const initialSelectedItem = useRef(selectedItem);
  const [draft, setDraft] = useState<ReviewDraft | null>(() => selectedItem === null ? null : reviewDraftForItem(selectedItem));
  const items = useMemo(() => orderedReviewItems(project), [project]);
  const indexes = useMemo(() => indexReviewData(project), [project]);
  const filteredItems = useMemo(() => filter === "all"
    ? items
    : items.filter((item) => item.current.state === filter), [filter, items]);
  const draftItem = draft === null ? null : reviewItemForId(project, draft.itemId);
  const hasUnsavedDraft = reviewDraftIsDirty(draftItem, draft);
  const draftForSelectedItem = selectedItem !== null && draft !== null && draft.itemId === selectedItem.itemId && draft.itemRevision === selectedItem.current.itemRevision
    ? draft
    : selectedItem !== null && draft !== null && draft.itemId === selectedItem.itemId
      ? draft
    : selectedItem === null ? null : reviewDraftForItem(selectedItem);
  const draftSaveCommand = selectedItem === null || draftForSelectedItem === null
    ? null
    : draftForSelectedItem.itemRevision !== selectedItem.current.itemRevision
      ? null
      : semanticRevisionCommand(project, selectedItem, draftForSelectedItem);
  const windowed = filteredItems.length > windowThreshold;
  const rowsPerViewport = Math.ceil(virtualViewportHeight / virtualRowHeight);
  const virtualStart = windowed ? Math.max(0, Math.floor(virtualScrollTop / virtualRowHeight) - virtualOverscan) : 0;
  const virtualEnd = windowed ? Math.min(filteredItems.length, virtualStart + rowsPerViewport + virtualOverscan * 2) : filteredItems.length;
  const visibleItems = filteredItems.slice(virtualStart, virtualEnd);

  useEffect(() => {
    const initiallySelected = initialSelectedItem.current;
    if (initiallySelected !== null) setFocusAfterSelection({ itemId: initiallySelected.itemId });
  }, []);

  useEffect(() => {
    if (selectedItem === null) {
      if (!hasUnsavedDraft) setDraft(null);
      return;
    }
    if (draft === null || !hasUnsavedDraft) {
      if (draft?.itemId !== selectedItem.itemId || draft.itemRevision !== selectedItem.current.itemRevision) {
        setDraft(reviewDraftForItem(selectedItem));
      }
    }
  }, [draft, hasUnsavedDraft, selectedItem]);

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
      if (result === null || result === undefined || typeof result !== "object" || !("project" in result) || result.project === null) {
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
    setDraft(canonicalItem === null ? null : reviewDraftForItem(canonicalItem));
  }, []);

  const performNavigation = useCallback(async (navigation: PendingNavigation, baseProject: CaptionProject): Promise<boolean> => {
    const target = reviewItemForId(baseProject, navigation.itemId);
    if (target === null) {
      setErrorAnnouncement("The requested review item is not available in the current project state.");
      return false;
    }
    setFilter("all");
    const result = await executeCommand({
      type: "SelectItem",
      actor: humanReviewActor,
      itemId: target.itemId,
      expectedItemRevision: target.current.itemRevision,
      expectedProjectRevision: baseProject.projectRevision,
    }, `Selected ${itemAccessibleLabel(target)} and sought its start time in the source video.`);
    if (result === null || result.error !== undefined) return false;
    const canonicalItem = reviewItemForId(result.project, target.itemId);
    if (canonicalItem === null) {
      setErrorAnnouncement("CueBench accepted the selection but the item is no longer available in its canonical project state.");
      return false;
    }
    syncDraftToCanonical(result.project, canonicalItem.itemId);
    onSeekToMediaTime(canonicalItem.current.startMs);
    setFocusAfterSelection(navigation.evidenceId === undefined
      ? { itemId: canonicalItem.itemId }
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
    if (afterSuccessNavigation !== undefined) return performNavigation(afterSuccessNavigation, result.project);
    return true;
  }, [executeCommand, performNavigation, syncDraftToCanonical]);

  const requestSemanticCommand = useCallback((command: DomainCommand, acceptedMessage: string, afterSuccessNavigation?: PendingNavigation) => {
    if (commandChangesSustainedWork(project, command)) {
      setPendingSustainedCommand(afterSuccessNavigation === undefined
        ? { command, acceptedMessage }
        : { command, acceptedMessage, afterSuccessNavigation });
      return;
    }
    void applySemanticCommand(command, acceptedMessage, afterSuccessNavigation);
  }, [applySemanticCommand, project]);

  const requestNavigation = useCallback((navigation: PendingNavigation) => {
    if (hasUnsavedDraft) {
      setPendingNavigation(navigation);
      return;
    }
    void performNavigation(navigation, project);
  }, [hasUnsavedDraft, performNavigation, project]);

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
    requestNavigation({ itemId: item.itemId, evidenceId, label: `evidence ${evidenceId}` });
  }, [requestNavigation]);

  const registerItemButton = useCallback((itemId: string, element: HTMLButtonElement | null) => {
    if (element === null) itemButtonRefs.current.delete(itemId);
    else itemButtonRefs.current.set(itemId, element);
  }, []);

  useLayoutEffect(() => {
    if (focusAfterSelection === null || isCommandPending) return;
    const index = filteredItems.findIndex((item) => item.itemId === focusAfterSelection.itemId);
    if (index === -1) return;
    if (windowed) {
      const wantedScrollTop = Math.max(0, index * virtualRowHeight - virtualRowHeight);
      if (Math.abs(virtualScrollTop - wantedScrollTop) > virtualRowHeight / 2) {
        const viewport = virtualViewportRef.current;
        if (viewport !== null) viewport.scrollTop = wantedScrollTop;
        setVirtualScrollTop(wantedScrollTop);
        return;
      }
    }
    const target = focusAfterSelection.evidenceId === undefined
      ? itemButtonRefs.current.get(focusAfterSelection.itemId)
      : document.getElementById(evidenceAnchorId(focusAfterSelection.evidenceId));
    if (target instanceof HTMLElement) {
      target.focus();
      setFocusAfterSelection(null);
    }
  }, [filter, filteredItems, focusAfterSelection, isCommandPending, virtualScrollTop, windowed]);

  const discardDraft = useCallback(() => {
    setDraft(selectedItem === null ? null : reviewDraftForItem(selectedItem));
  }, [selectedItem]);

  const saveDraftAndContinue = () => {
    if (pendingNavigation === null || selectedItem === null || draftSaveCommand === null) {
      setErrorAnnouncement("This draft cannot be saved yet. Correct the marked field or discard it before navigating.");
      return;
    }
    if (commandChangesSustainedWork(project, draftSaveCommand)) {
      const navigation = pendingNavigation;
      // A confirmation is itself a blocking decision. Close the first modal so
      // assistive technology and focus never face two open dialogs at once.
      setPendingNavigation(null);
      setPendingSustainedCommand({
        command: draftSaveCommand,
        acceptedMessage: `Saved the reviewed revision for ${itemAccessibleLabel(selectedItem)}.`,
        afterSuccessNavigation: navigation,
      });
      return;
    }
    requestSemanticCommand(draftSaveCommand, `Saved the reviewed revision for ${itemAccessibleLabel(selectedItem)}.`, pendingNavigation);
  };

  const executeRuling = useCallback(async (command: DomainCommand, acceptedMessage: string): Promise<CommandResult | null> => {
    const result = await executeCommand(command, acceptedMessage);
    if (result !== null && result.error === undefined) syncDraftToCanonical(result.project, commandPrimaryItemId(command));
    return result;
  }, [executeCommand, syncDraftToCanonical]);

  const renderDocketItem = (item: ReviewableItem, index: number) => {
    const findings = findingsForItem(indexes, item.itemId);
    const evidence = evidenceForItem(indexes, item.itemId);
    const selected = selectedItem?.itemId === item.itemId;
    const itemStyle = windowed ? { position: "absolute" as const, insetInline: 0, top: `${index * virtualRowHeight}px`, minHeight: `${virtualRowHeight}px` } : undefined;
    return (
      <li className={`docket-item${windowed ? " docket-item--windowed" : ""}`} key={item.itemId} style={itemStyle} data-selected={selected || undefined} aria-posinset={windowed ? index + 1 : undefined} aria-setsize={windowed ? filteredItems.length : undefined}>
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
      <QualityFindings project={project} indexes={indexes} onFocusFinding={focusFinding} disabled={isCommandPending} />
      <div className={`docket-content${windowed ? " docket-content--windowed" : ""}`}>
        {filteredItems.length === 0 ? (
          <p className="empty-docket">{items.length === 0 ? "Caption generation will place proposed cues here for human review." : "No items match this review-state filter."}</p>
        ) : windowed ? (
          <div className="docket-list-viewport" ref={virtualViewportRef} onScroll={(event) => setVirtualScrollTop(event.currentTarget.scrollTop)}>
            <ol className="docket-list docket-list--windowed" aria-label="Review items" style={{ height: `${filteredItems.length * virtualRowHeight}px` }}>
              {visibleItems.map((item, offset) => renderDocketItem(item, virtualStart + offset))}
            </ol>
          </div>
        ) : (
          <ol className="docket-list" aria-label="Review items">{visibleItems.map((item, index) => renderDocketItem(item, index))}</ol>
        )}
      </div>
      <SelectedItemPanel
        project={project}
        item={selectedItem}
        draft={draftForSelectedItem}
        indexes={indexes}
        isCommandPending={isCommandPending}
        onDraftChange={setDraft}
        onDiscardDraft={discardDraft}
        onSeekItem={(item) => requestNavigation({ itemId: item.itemId, label: `source video for ${itemAccessibleLabel(item)}` })}
        onFocusFinding={focusFinding}
        onFocusEvidence={focusEvidence}
        onRequestSemanticCommand={requestSemanticCommand}
        {...(onReadNativePlayheadMs === undefined ? {} : { onReadNativePlayheadMs })}
        {...(evidenceContentResolver === undefined ? {} : { evidenceContentResolver })}
      />
      <HumanRulingControls item={selectedItem} projectRevision={project.projectRevision} isCommandPending={isCommandPending} hasUnsavedDraft={hasUnsavedDraft} commandError={errorAnnouncement} onExecuteCommand={executeRuling} />
      {footer}
      {acceptedAnnouncement === null ? null : <p className="review-accepted-feedback" role="status" aria-live="polite">{acceptedAnnouncement}</p>}
      {errorAnnouncement === null ? null : <p className="review-command-feedback" role="alert" aria-live="assertive">{errorAnnouncement}</p>}
      <Dialog.Root open={pendingNavigation !== null} onOpenChange={(open) => { if (!open) setPendingNavigation(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog review-dialog" aria-describedby="unsaved-draft-description">
            <Dialog.Title>Unsaved review draft</Dialog.Title>
            <Dialog.Description id="unsaved-draft-description">{pendingNavigation === null ? "" : `Save, discard, or cancel before opening ${pendingNavigation.label}. The current form displays unsaved text or timing.`}</Dialog.Description>
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button">Cancel navigation</Dialog.Close>
              <button className="button button--outline" type="button" disabled={isCommandPending} onClick={() => { const navigation = pendingNavigation; discardDraft(); if (navigation !== null) void performNavigation(navigation, project); }}>Discard draft and continue</button>
              <button className="button button--signal" type="button" disabled={isCommandPending || draftSaveCommand === null} onClick={saveDraftAndContinue}>Save changes and continue</button>
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
