import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject, CommandResult, DomainCommand } from "@cuebench/domain";
import { useEffect, useMemo, useState } from "react";
import { EvidenceInspector } from "../evidence/EvidenceInspector";
import { QualityFindings } from "../evidence/QualityFindings";
import { RevisionHistory } from "./RevisionHistory";
import type { ReviewableItem } from "./review-utils";
import {
  humanReviewActor,
  itemAccessibleLabel,
  itemProse,
  itemTypeLabel,
  reviewStateLabel,
} from "./review-utils";

interface ItemDraft {
  readonly prose: string;
  readonly speaker: string;
  readonly startMs: string;
  readonly endMs: string;
}

interface PendingSustainedRevision {
  readonly command: DomainCommand;
  readonly acceptedMessage: string;
}

const draftFor = (item: ReviewableItem | null): ItemDraft => item === null
  ? { prose: "", speaker: "", startMs: "", endMs: "" }
  : {
      prose: itemProse(item),
      speaker: item.kind === "CaptionCue" ? item.current.speaker ?? "" : "",
      startMs: String(item.current.startMs),
      endMs: String(item.current.endMs),
    };

const integerValue = (value: string): number | null => {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export interface SelectedItemPanelProps {
  readonly project: CaptionProject;
  readonly item: ReviewableItem | null;
  readonly isCommandPending: boolean;
  readonly onSeekToMediaTime: (mediaTimeMs: number) => void;
  readonly onFocusFinding: Parameters<typeof QualityFindings>[0]["onFocusFinding"];
  readonly onExecuteCommand: (command: DomainCommand, acceptedMessage: string) => Promise<CommandResult | null>;
}

export function SelectedItemPanel({
  project,
  item,
  isCommandPending,
  onSeekToMediaTime,
  onFocusFinding,
  onExecuteCommand,
}: SelectedItemPanelProps) {
  const [draft, setDraft] = useState<ItemDraft>(() => draftFor(item));
  const [pendingSustainedRevision, setPendingSustainedRevision] = useState<PendingSustainedRevision | null>(null);

  useEffect(() => {
    setDraft(draftFor(item));
    setPendingSustainedRevision(null);
  }, [item?.itemId, item?.current.itemRevision]);

  const label = item === null ? null : itemAccessibleLabel(item);
  const startMs = integerValue(draft.startMs);
  const endMs = integerValue(draft.endMs);
  const timingIsValid = item !== null
    && startMs !== null
    && endMs !== null
    && startMs >= 0
    && startMs < endMs
    && endMs <= project.media.durationMs;
  const proseIsValid = draft.prose.trim().length > 0;
  const timingChanged = item !== null && timingIsValid && (startMs !== item.current.startMs || endMs !== item.current.endMs);
  const revisionChanged = item !== null && timingIsValid && proseIsValid && (
    timingChanged
    || draft.prose.trim() !== itemProse(item)
    || (item.kind === "CaptionCue" && (draft.speaker.trim() || null) !== item.current.speaker)
  );

  const reviseCommand = useMemo<DomainCommand | null>(() => {
    if (item === null || !timingIsValid || !proseIsValid || startMs === null || endMs === null) return null;
    if (item.kind === "CaptionCue") {
      return {
        type: "ReviseCue",
        actor: humanReviewActor,
        itemId: item.itemId,
        cueId: item.itemId,
        expectedItemRevision: item.current.itemRevision,
        expectedProjectRevision: project.projectRevision,
        patch: {
          text: draft.prose.trim(),
          speaker: draft.speaker.trim() || null,
          startMs,
          endMs,
        },
      };
    }
    return {
      type: "ReviseAudioDescription",
      actor: humanReviewActor,
      itemId: item.itemId,
      beatId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
      patch: { description: draft.prose.trim(), startMs, endMs },
    };
  }, [draft.prose, draft.speaker, endMs, item, project.projectRevision, proseIsValid, startMs, timingIsValid]);

  const timingCommand = useMemo<DomainCommand | null>(() => {
    if (item === null || !timingIsValid || startMs === null || endMs === null) return null;
    if (item.kind === "CaptionCue") {
      return {
        type: "AdjustCueTiming",
        actor: humanReviewActor,
        itemId: item.itemId,
        cueId: item.itemId,
        startMs,
        endMs,
        expectedItemRevision: item.current.itemRevision,
        expectedProjectRevision: project.projectRevision,
      };
    }
    return {
      type: "AdjustAudioDescriptionTiming",
      actor: humanReviewActor,
      itemId: item.itemId,
      beatId: item.itemId,
      startMs,
      endMs,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: project.projectRevision,
    };
  }, [endMs, item, project.projectRevision, startMs, timingIsValid]);

  const submitRevision = (command: DomainCommand, acceptedMessage: string) => {
    if (item?.current.state === "Sustained") {
      setPendingSustainedRevision({ command, acceptedMessage });
      return;
    }
    void onExecuteCommand(command, acceptedMessage);
  };

  const confirmSustainedRevision = async () => {
    if (pendingSustainedRevision === null) return;
    const result = await onExecuteCommand(
      pendingSustainedRevision.command,
      pendingSustainedRevision.acceptedMessage,
    );
    if (result?.error === undefined) setPendingSustainedRevision(null);
  };

  if (item === null) {
    return (
      <section className="selected-item-panel" aria-labelledby="selected-item-heading">
        <h3 id="selected-item-heading">Selected item</h3>
        <p>Select a caption cue or audio-description beat to inspect, seek, revise, or rule on it.</p>
      </section>
    );
  }

  const proseLabel = item.kind === "CaptionCue" ? `Caption text for ${item.itemId.toUpperCase()}` : `Audio-description text for ${item.itemId.toUpperCase()}`;
  const saveLabel = item.kind === "CaptionCue" ? "Save caption revision" : "Save audio-description revision";
  const actionDescription = `${itemTypeLabel(item)} ${item.itemId.toUpperCase()}`;

  return (
    <section className="selected-item-panel" aria-labelledby="selected-item-heading">
      <div className="panel-heading">
        <div>
          <h3 id="selected-item-heading">Selected {actionDescription}</h3>
          <p>Current immutable revision r{item.current.itemRevision}</p>
        </div>
        <span className={`review-state review-state--${item.current.state.toLowerCase()}`}>{reviewStateLabel(item.current.state)}</span>
      </div>
      <div className="selected-item-panel__identity">
        <strong>{item.itemId.toUpperCase()}</strong>
        <span>{item.kind === "CaptionCue" && item.current.speaker !== null ? item.current.speaker : item.kind === "CaptionCue" ? "Speaker unavailable" : "Audio description"}</span>
      </div>
      <button className="selected-item-panel__seek" type="button" onClick={() => onSeekToMediaTime(item.current.startMs)}>
        Seek {actionDescription} in source video
      </button>
      <div className="selected-item-panel__editor" aria-label={`Semantic editing controls for ${actionDescription}`}>
        <label className="review-field" htmlFor={`prose-${item.itemId}`}>
          <span>{proseLabel}</span>
          <textarea id={`prose-${item.itemId}`} rows={4} value={draft.prose} onChange={(event) => setDraft((current) => ({ ...current, prose: event.currentTarget.value }))} />
        </label>
        {item.kind !== "CaptionCue" ? null : (
          <label className="review-field" htmlFor={`speaker-${item.itemId}`}>
            <span>Speaker for {item.itemId.toUpperCase()}</span>
            <input id={`speaker-${item.itemId}`} value={draft.speaker} onChange={(event) => setDraft((current) => ({ ...current, speaker: event.currentTarget.value }))} />
          </label>
        )}
        <div className="review-timing-fields">
          <label className="review-field" htmlFor={`start-${item.itemId}`}>
            <span>Start time for {actionDescription}</span>
            <input id={`start-${item.itemId}`} type="number" min={0} max={project.media.durationMs - 1} step={1} value={draft.startMs} onChange={(event) => setDraft((current) => ({ ...current, startMs: event.currentTarget.value }))} />
          </label>
          <label className="review-field" htmlFor={`end-${item.itemId}`}>
            <span>End time for {actionDescription}</span>
            <input id={`end-${item.itemId}`} type="number" min={1} max={project.media.durationMs} step={1} value={draft.endMs} onChange={(event) => setDraft((current) => ({ ...current, endMs: event.currentTarget.value }))} />
          </label>
        </div>
        <p className="selected-item-panel__timing-note">Times are integer milliseconds against the native video clock.</p>
        {item.current.state !== "Sustained" ? null : <p className="selected-item-panel__confirmation-note">Changing Sustained work requires confirmation and creates a new Proposed revision.</p>}
        <div className="selected-item-panel__actions">
          <button
            className="button button--outline"
            type="button"
            disabled={isCommandPending || !timingChanged || timingCommand === null}
            onClick={() => timingCommand === null ? undefined : submitRevision(timingCommand, `Created Proposed timing revision for ${label}.`)}
          >
            Apply timing for {actionDescription}
          </button>
          <button
            className="button button--signal"
            type="button"
            disabled={isCommandPending || !revisionChanged || reviseCommand === null}
            onClick={() => reviseCommand === null ? undefined : submitRevision(reviseCommand, `Created Proposed revision for ${label}.`)}
          >
            {saveLabel}
          </button>
        </div>
      </div>
      <QualityFindings project={project} item={item} onFocusFinding={onFocusFinding} disabled={isCommandPending} />
      <EvidenceInspector project={project} item={item} />
      <RevisionHistory item={item} />
      <Dialog.Root open={pendingSustainedRevision !== null} onOpenChange={(open) => { if (!open) setPendingSustainedRevision(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog review-dialog" aria-describedby="sustained-revision-description">
            <Dialog.Title>Revise Sustained {actionDescription}</Dialog.Title>
            <Dialog.Description id="sustained-revision-description">This change keeps the accepted revision in history and creates a new Proposed revision for review.</Dialog.Description>
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button">Cancel</Dialog.Close>
              <button className="button button--signal" type="button" onClick={() => void confirmSustainedRevision()} disabled={isCommandPending}>Create Proposed revision</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
