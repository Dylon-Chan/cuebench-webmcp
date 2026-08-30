import type {
  CaptionProject,
  CommandResult,
  DomainCommand,
  QualityFinding,
} from "@cuebench/domain";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QualityFindings } from "../evidence/QualityFindings";
import { HumanRulingControls } from "./HumanRulingControls";
import { SelectedItemPanel } from "./SelectedItemPanel";
import type { ReviewableItem } from "./review-utils";
import {
  evidenceAnchorId,
  evidenceForItem,
  findingsForItem,
  humanReviewActor,
  itemAccessibleLabel,
  itemProse,
  orderedReviewItems,
  primaryFindingItemId,
  reviewItemForId,
  reviewStateLabel,
  type ReviewCommandExecutor,
} from "./review-utils";

type DocketFilter = "all" | "Proposed" | "AgentReady" | "Objected" | "Sustained";

export interface ReviewDocketProps {
  readonly project: CaptionProject;
  /** The ProjectStore adapter keeps durable and temporary projects on one canonical command boundary. */
  readonly onCommand: ReviewCommandExecutor;
  /** This is the native video seek callback supplied by VideoEvidenceBay. */
  readonly onSeekToMediaTime: (mediaTimeMs: number) => void;
  readonly footer?: ReactNode;
}

const filterOptions: readonly { readonly value: DocketFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "Proposed", label: "Proposed" },
  { value: "AgentReady", label: "Agent Ready" },
  { value: "Objected", label: "Objected" },
  { value: "Sustained", label: "Sustained" },
];

const errorMessage = (error: unknown): string => error instanceof Error && error.message.trim().length > 0
  ? error.message
  : "CueBench could not apply this review command. The canonical project state was retained.";

const currentSelectedItem = (project: CaptionProject): ReviewableItem | null => {
  const selected = project.selectedItem;
  if (selected === null || selected.kind === "AudioDescriptionGap") return null;
  return reviewItemForId(project, selected.itemId);
};

export function ReviewDocket({ project, onCommand, onSeekToMediaTime, footer }: ReviewDocketProps) {
  const [filter, setFilter] = useState<DocketFilter>("all");
  const [isCommandPending, setIsCommandPending] = useState(false);
  const [acceptedAnnouncement, setAcceptedAnnouncement] = useState<string | null>(null);
  const [errorAnnouncement, setErrorAnnouncement] = useState<string | null>(null);
  const [focusAfterSelection, setFocusAfterSelection] = useState<string | null>(null);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const items = useMemo(() => orderedReviewItems(project), [project]);
  const filteredItems = useMemo(() => filter === "all"
    ? items
    : items.filter((item) => item.current.state === filter), [filter, items]);
  const selectedItem = currentSelectedItem(project);

  useEffect(() => {
    if (focusAfterSelection === null || isCommandPending) return;
    itemButtonRefs.current.get(focusAfterSelection)?.focus();
    setFocusAfterSelection(null);
  }, [focusAfterSelection, isCommandPending, project.projectRevision]);

  const executeCommand = useCallback(async (
    command: DomainCommand,
    acceptedMessage: string,
  ): Promise<CommandResult | null> => {
    if (isCommandPending) return null;
    setIsCommandPending(true);
    setAcceptedAnnouncement(null);
    setErrorAnnouncement(null);
    try {
      const result = await onCommand(command);
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
      setIsCommandPending(false);
    }
  }, [isCommandPending, onCommand]);

  const selectItem = useCallback(async (item: ReviewableItem) => {
    const result = await executeCommand({
      type: "SelectItem",
      actor: humanReviewActor,
      itemId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
    }, `Selected ${itemAccessibleLabel(item)} and sought its start time in the source video.`);
    if (result?.error !== undefined || result === null) return;
    const canonicalItem = reviewItemForId(result.project, item.itemId);
    if (canonicalItem === null) return;
    onSeekToMediaTime(canonicalItem.current.startMs);
    setFocusAfterSelection(canonicalItem.itemId);
  }, [executeCommand, onSeekToMediaTime, project.projectRevision]);

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
    void selectItem(item);
  }, [project, selectItem]);

  const registerItemButton = useCallback((itemId: string, element: HTMLButtonElement | null) => {
    if (element === null) itemButtonRefs.current.delete(itemId);
    else itemButtonRefs.current.set(itemId, element);
  }, []);

  return (
    <section className="review-docket" aria-labelledby="review-docket-heading" aria-busy={isCommandPending || undefined}>
      <div className="region-heading">
        <div><h2 id="review-docket-heading">Review Docket</h2><p>{items.length} review items</p></div>
        <span className="docket-indicator">Live state</span>
      </div>
      <div className="docket-tabs" role="group" aria-label="Review item filters">
        {filterOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <QualityFindings project={project} onFocusFinding={focusFinding} disabled={isCommandPending} />
      <div className="docket-content">
        {filteredItems.length === 0 ? (
          <p className="empty-docket">{items.length === 0 ? "Caption generation will place proposed cues here for human review." : "No items match this review-state filter."}</p>
        ) : (
          <ol className="docket-list" aria-label="Review items">
            {filteredItems.map((item) => {
              const findings = findingsForItem(project, item);
              const evidence = evidenceForItem(project, item);
              const selected = selectedItem?.itemId === item.itemId;
              return (
                <li className="docket-item" key={item.itemId} data-selected={selected || undefined}>
                  <button
                    ref={(element) => registerItemButton(item.itemId, element)}
                    type="button"
                    className="docket-item__select"
                    onClick={() => void selectItem(item)}
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
                    {evidence.length === 0 ? <span>No evidence link</span> : evidence.map((entry) => <a key={entry.evidenceId} href={`#${evidenceAnchorId(entry.evidenceId)}`}>{entry.evidenceId}</a>)}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <SelectedItemPanel
        project={project}
        item={selectedItem}
        isCommandPending={isCommandPending}
        onSeekToMediaTime={onSeekToMediaTime}
        onFocusFinding={focusFinding}
        onExecuteCommand={executeCommand}
      />
      <HumanRulingControls
        item={selectedItem}
        projectRevision={project.projectRevision}
        isCommandPending={isCommandPending}
        onExecuteCommand={executeCommand}
      />
      {footer}
      {acceptedAnnouncement === null ? null : <p className="review-accepted-feedback" role="status" aria-live="polite">{acceptedAnnouncement}</p>}
      {errorAnnouncement === null ? null : <p className="review-command-feedback" role="alert" aria-live="assertive">{errorAnnouncement}</p>}
    </section>
  );
}
