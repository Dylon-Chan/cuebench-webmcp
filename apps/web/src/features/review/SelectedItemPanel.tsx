import type { CaptionProject, DomainCommand, QualityFinding } from "@cuebench/domain";
import { EvidenceInspector, type EvidenceContentResolver } from "../evidence/EvidenceInspector";
import { QualityFindings } from "../evidence/QualityFindings";
import { RevisionHistory } from "./RevisionHistory";
import type { ReviewDraft, ReviewIndexes, ReviewableItem } from "./review-utils";
import {
  evidenceForItem,
  humanReviewActor,
  integerValue,
  itemAccessibleLabel,
  itemProse,
  itemTypeLabel,
  reviewDraftForItem,
  reviewDraftIsDirty,
  reviewDraftValidity,
  reviewStateLabel,
  semanticRevisionCommand,
} from "./review-utils";

export interface SelectedItemPanelProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
  readonly draft: ReviewDraft | null;
  readonly indexes: ReviewIndexes;
  readonly isCommandPending: boolean;
  readonly onDraftChange: (draft: ReviewDraft) => void;
  readonly onDiscardDraft: () => void;
  readonly onSeekItem: (item: ReviewableItem) => void;
  readonly onFocusFinding: (finding: QualityFinding) => void;
  readonly onFocusEvidence: (item: ReviewableItem, evidenceId: string) => void;
  readonly onRequestSemanticCommand: (command: DomainCommand, acceptedMessage: string) => void;
  /** Reads the single native video clock; no parallel review clock exists. */
  readonly onReadNativePlayheadMs?: () => number;
  readonly evidenceContentResolver?: EvidenceContentResolver;
}

const updateDraft = <Key extends keyof ReviewDraft>(
  draft: ReviewDraft,
  key: Key,
  value: ReviewDraft[Key],
): ReviewDraft => ({ ...draft, [key]: value });

const rightAdjacentCaption = (project: CaptionProject, item: ReviewableItem): ReviewableItem | null => {
  if (item.kind !== "CaptionCue") return null;
  const index = project.captions.order.indexOf(item.itemId);
  const adjacentId = project.captions.order[index + 1];
  if (adjacentId === undefined) return null;
  const adjacent = project.captions.items[adjacentId];
  return adjacent === undefined || adjacent.mergedIntoItemId !== null ? null : adjacent;
};

/**
 * A controlled semantic editor. The parent owns the draft so review-state
 * commands can never silently rule on canonical content while an edited value
 * remains visible in the form.
 */
export function SelectedItemPanel({
  project,
  item,
  draft,
  indexes,
  isCommandPending,
  onDraftChange,
  onDiscardDraft,
  onSeekItem,
  onFocusFinding,
  onFocusEvidence,
  onRequestSemanticCommand,
  onReadNativePlayheadMs,
  evidenceContentResolver,
}: SelectedItemPanelProps) {
  if (item === null) {
    return (
      <section className="selected-item-panel" aria-labelledby="selected-item-heading">
        <h3 id="selected-item-heading">Selected item</h3>
        <p>Select a caption cue or audio-description beat to inspect, seek, revise, or rule on it.</p>
      </section>
    );
  }

  const activeDraft = draft?.itemId === item.itemId && draft.itemRevision === item.current.itemRevision
    ? draft
    : draft?.itemId === item.itemId
      ? draft
    : reviewDraftForItem(item);
  const validity = reviewDraftValidity(project, item, activeDraft);
  const draftIsDirty = reviewDraftIsDirty(item, activeDraft);
  const staleDraft = activeDraft.itemRevision !== item.current.itemRevision;
  const startMs = integerValue(activeDraft.startMs);
  const endMs = integerValue(activeDraft.endMs);
  const timingChanged = startMs !== null && endMs !== null
    && (startMs !== item.current.startMs || endMs !== item.current.endMs);
  const proseChanged = activeDraft.prose !== itemProse(item)
    || (item.kind === "CaptionCue" && activeDraft.speaker !== (item.current.speaker ?? ""));
  const semanticCommand = staleDraft ? null : semanticRevisionCommand(project, item, activeDraft);
  const adjacent = rightAdjacentCaption(project, item);
  const splitMs = integerValue(activeDraft.splitMs);
  const splitCommand: DomainCommand | null = item.kind !== "CaptionCue" || splitMs === null || validity.splitError !== null
    ? null
    : {
        type: "SplitCue",
        actor: humanReviewActor,
        itemId: item.itemId,
        cueId: item.itemId,
        splitMs,
        newCueId: activeDraft.newCueId.trim(),
        expectedItemRevision: item.current.itemRevision,
        expectedProjectRevision: project.projectRevision,
      };
  const mergeCommand: DomainCommand | null = item.kind !== "CaptionCue" || adjacent === null
    ? null
    : {
        type: "MergeCue",
        actor: humanReviewActor,
        itemId: item.itemId,
        cueId: item.itemId,
        adjacentCueId: adjacent.itemId,
        expectedItemRevision: item.current.itemRevision,
        expectedAdjacentItemRevision: adjacent.current.itemRevision,
        expectedProjectRevision: project.projectRevision,
      };
  const timingCommand: DomainCommand | null = validity.timingError !== null || startMs === null || endMs === null
    ? null
    : item.kind === "CaptionCue"
      ? {
          type: "AdjustCueTiming",
          actor: humanReviewActor,
          itemId: item.itemId,
          cueId: item.itemId,
          startMs,
          endMs,
          expectedItemRevision: item.current.itemRevision,
          expectedProjectRevision: project.projectRevision,
        }
      : {
          type: "AdjustAudioDescriptionTiming",
          actor: humanReviewActor,
          itemId: item.itemId,
          beatId: item.itemId,
          startMs,
          endMs,
          expectedItemRevision: item.current.itemRevision,
          expectedProjectRevision: project.projectRevision,
        };
  const proseLabel = item.kind === "CaptionCue" ? `Caption text for ${item.itemId.toUpperCase()}` : `Audio-description text for ${item.itemId.toUpperCase()}`;
  const saveLabel = item.kind === "CaptionCue" ? "Save caption revision" : "Save audio-description revision";
  const actionDescription = `${itemTypeLabel(item)} ${item.itemId.toUpperCase()}`;
  const timingErrorId = `timing-error-${item.itemId}`;
  const proseErrorId = `prose-error-${item.itemId}`;
  const splitErrorId = `split-error-${item.itemId}`;
  const evidence = evidenceForItem(indexes, item.itemId);

  return (
    <section className="selected-item-panel" aria-labelledby="selected-item-heading">
      <div className="panel-heading">
        <div>
          <h3 id="selected-item-heading" tabIndex={-1}>Selected {actionDescription}</h3>
          <p>Current immutable revision r{item.current.itemRevision}</p>
        </div>
        <span className={`review-state review-state--${item.current.state.toLowerCase()}`}>{reviewStateLabel(item.current.state)}</span>
      </div>
      <div className="selected-item-panel__identity">
        <strong>{item.itemId.toUpperCase()}</strong>
        <span>{item.kind === "CaptionCue" && item.current.speaker !== null ? item.current.speaker : item.kind === "CaptionCue" ? "Speaker unavailable" : "Audio description"}</span>
      </div>
      <button className="selected-item-panel__seek" type="button" onClick={() => onSeekItem(item)} disabled={isCommandPending}>
        Seek {actionDescription} in source video
      </button>
      <div className="selected-item-panel__editor" aria-label={`Semantic editing controls for ${actionDescription}`}>
        {staleDraft ? <p className="review-field-error" role="alert">This draft began on r{activeDraft.itemRevision}, but the canonical item is now r{item.current.itemRevision}. Discard the draft before continuing so the saved revision stays exact.</p> : null}
        <label className="review-field" htmlFor={`prose-${item.itemId}`}>
          <span>{proseLabel}</span>
          <textarea
            id={`prose-${item.itemId}`}
            rows={4}
            value={activeDraft.prose}
            aria-invalid={validity.proseError !== null || undefined}
            aria-describedby={validity.proseError === null ? undefined : proseErrorId}
            onChange={(event) => onDraftChange(updateDraft(activeDraft, "prose", event.currentTarget.value))}
          />
        </label>
        {validity.proseError === null ? null : <p className="review-field-error" id={proseErrorId} role="alert">{validity.proseError}</p>}
        {item.kind !== "CaptionCue" ? null : (
          <label className="review-field" htmlFor={`speaker-${item.itemId}`}>
            <span>Speaker for {item.itemId.toUpperCase()}</span>
            <input id={`speaker-${item.itemId}`} value={activeDraft.speaker} onChange={(event) => onDraftChange(updateDraft(activeDraft, "speaker", event.currentTarget.value))} />
          </label>
        )}
        <div className="review-timing-fields">
          <label className="review-field" htmlFor={`start-${item.itemId}`}>
            <span>Start time for {actionDescription}</span>
            <input
              id={`start-${item.itemId}`}
              type="number"
              min={0}
              max={project.media.durationMs - 1}
              step={1}
              value={activeDraft.startMs}
              aria-invalid={validity.timingError !== null || undefined}
              aria-describedby={validity.timingError === null ? undefined : timingErrorId}
              onChange={(event) => onDraftChange(updateDraft(activeDraft, "startMs", event.currentTarget.value))}
            />
          </label>
          <label className="review-field" htmlFor={`end-${item.itemId}`}>
            <span>End time for {actionDescription}</span>
            <input
              id={`end-${item.itemId}`}
              type="number"
              min={1}
              max={project.media.durationMs}
              step={1}
              value={activeDraft.endMs}
              aria-invalid={validity.timingError !== null || undefined}
              aria-describedby={validity.timingError === null ? undefined : timingErrorId}
              onChange={(event) => onDraftChange(updateDraft(activeDraft, "endMs", event.currentTarget.value))}
            />
          </label>
        </div>
        {validity.timingError === null ? null : <p className="review-field-error" id={timingErrorId} role="alert">{validity.timingError}</p>}
        <p className="selected-item-panel__timing-note">Times are integer milliseconds against the native video clock.</p>
        {draftIsDirty ? <p className="selected-item-panel__draft-note">Unsaved text or timing is visible. Save or discard it before navigating or ruling.</p> : null}
        {item.current.state !== "Sustained" ? null : <p className="selected-item-panel__confirmation-note">Changing Sustained work requires confirmation and creates a new Proposed revision.</p>}
        <div className="selected-item-panel__actions">
          <button
            className="button button--outline"
            type="button"
            disabled={isCommandPending || proseChanged || !timingChanged || timingCommand === null}
            onClick={() => timingCommand === null ? undefined : onRequestSemanticCommand(timingCommand, `Created Proposed timing revision for ${itemAccessibleLabel(item)}.`)}
          >
            Apply timing for {actionDescription}
          </button>
          <button
            className="button button--signal"
            type="button"
            disabled={isCommandPending || !draftIsDirty || semanticCommand === null}
            onClick={() => semanticCommand === null ? undefined : onRequestSemanticCommand(semanticCommand, `Created Proposed revision for ${itemAccessibleLabel(item)}.`)}
          >
            {saveLabel}
          </button>
          <button className="button button--outline" type="button" disabled={isCommandPending || !draftIsDirty} onClick={onDiscardDraft}>Discard draft</button>
        </div>
        {item.kind !== "CaptionCue" ? null : (
          <fieldset className="caption-structure-tools">
            <legend>Caption structure</legend>
            <label className="review-field" htmlFor={`split-${item.itemId}`}>
              <span>Split point for Caption {item.itemId.toUpperCase()}</span>
              <input
                id={`split-${item.itemId}`}
                type="number"
                min={item.current.startMs + 1}
                max={item.current.endMs - 1}
                step={1}
                value={activeDraft.splitMs}
                aria-invalid={validity.splitError !== null || undefined}
                aria-describedby={validity.splitError === null ? undefined : splitErrorId}
                onChange={(event) => onDraftChange(updateDraft(activeDraft, "splitMs", event.currentTarget.value))}
              />
            </label>
            {onReadNativePlayheadMs === undefined ? null : <button className="text-button caption-structure-tools__playhead" type="button" disabled={isCommandPending || staleDraft} onClick={() => onDraftChange(updateDraft(activeDraft, "splitMs", String(onReadNativePlayheadMs())))}>Use native playhead for split</button>}
            <label className="review-field" htmlFor={`split-id-${item.itemId}`}>
              <span>New caption identifier for {item.itemId.toUpperCase()}</span>
              <input id={`split-id-${item.itemId}`} value={activeDraft.newCueId} aria-invalid={validity.splitError !== null || undefined} aria-describedby={validity.splitError === null ? undefined : splitErrorId} onChange={(event) => onDraftChange(updateDraft(activeDraft, "newCueId", event.currentTarget.value))} />
            </label>
            {validity.splitError === null ? null : <p className="review-field-error" id={splitErrorId} role="alert">{validity.splitError}</p>}
            <div className="selected-item-panel__actions">
              <button className="button button--outline" type="button" disabled={isCommandPending || draftIsDirty || staleDraft || splitCommand === null} onClick={() => splitCommand === null ? undefined : onRequestSemanticCommand(splitCommand, `Split ${itemAccessibleLabel(item)} at ${splitMs} ms.`)}>Split Caption {item.itemId.toUpperCase()}</button>
              {adjacent === null ? <p className="caption-structure-tools__empty">No adjacent successor is available to merge.</p> : <button className="button button--outline" type="button" disabled={isCommandPending || draftIsDirty || staleDraft || mergeCommand === null} onClick={() => mergeCommand === null ? undefined : onRequestSemanticCommand(mergeCommand, `Merged ${itemAccessibleLabel(item)} with ${itemAccessibleLabel(adjacent)}.`)}>Merge Caption {item.itemId.toUpperCase()} with {adjacent.itemId.toUpperCase()}</button>}
            </div>
          </fieldset>
        )}
      </div>
      <QualityFindings project={project} item={item} indexes={indexes} onFocusFinding={onFocusFinding} disabled={isCommandPending} />
      <EvidenceInspector
        project={project}
        item={item}
        indexes={indexes}
        {...(evidenceContentResolver === undefined ? {} : { contentResolver: evidenceContentResolver })}
        onFocusEvidence={(evidenceId) => onFocusEvidence(item, evidenceId)}
      />
      <RevisionHistory project={project} item={item} evidence={evidence} onFocusEvidence={(evidenceId) => onFocusEvidence(item, evidenceId)} />
    </section>
  );
}
