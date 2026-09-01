import type {
  AudioDescriptionGap,
  CaptionProject,
  CommandResult,
  DomainCommand,
} from "@cuebench/domain";
import { useMemo, useState } from "react";
import { formatMediaTime } from "../timeline/time-transform";
import { humanReviewActor } from "./review-utils";

export interface AudioDescriptionGapComposerProps {
  readonly project: CaptionProject;
  readonly isCommandPending: boolean;
  readonly hasUnsavedDraft: boolean;
  readonly onExecuteCommand: (
    command: DomainCommand,
    acceptedMessage: string,
  ) => Promise<CommandResult | null>;
  readonly onAcceptedBeat: (result: CommandResult, beatId: string) => void;
}

const orderedAvailableGaps = (project: CaptionProject): readonly AudioDescriptionGap[] => (
  Object.values(project.audioDescriptionGaps)
    .filter((gap) => gap.state === "Available")
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.gapId.localeCompare(right.gapId))
);

const defaultBeatId = (gap: AudioDescriptionGap): string => (
  gap.gapId.endsWith("-gap") ? `${gap.gapId.slice(0, -4)}-ad` : `${gap.gapId}-ad`
);

const integer = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

interface GapDraft {
  readonly beatId: string;
  readonly startMs: string;
  readonly endMs: string;
  readonly description: string;
}

const initialGapDraft = (gap: AudioDescriptionGap): GapDraft => ({
  beatId: defaultBeatId(gap),
  startMs: String(gap.startMs),
  endMs: String(gap.endMs),
  description: "",
});

/**
 * Human counterpart to the selection-scoped WebMCP gap tool. The gap must be
 * visibly selected first, and the exact proposal remains Proposed until the
 * separate Human ruling controls Sustain it.
 */
export function AudioDescriptionGapComposer({
  project,
  isCommandPending,
  hasUnsavedDraft,
  onExecuteCommand,
  onAcceptedBeat,
}: AudioDescriptionGapComposerProps) {
  const gaps = useMemo(() => orderedAvailableGaps(project), [project]);
  const selected = project.selectedItem?.kind === "AudioDescriptionGap"
    ? project.audioDescriptionGaps[project.selectedItem.itemId] ?? null
    : null;
  const selectedGap = selected?.state === "Available" ? selected : null;
  const [draftsByGapId, setDraftsByGapId] = useState<Readonly<Record<string, GapDraft>>>({});
  const draft = selectedGap === null
    ? null
    : draftsByGapId[selectedGap.gapId] ?? initialGapDraft(selectedGap);

  const updateDraft = (patch: Partial<GapDraft>) => {
    if (selectedGap === null) return;
    setDraftsByGapId((current) => ({
      ...current,
      [selectedGap.gapId]: {
        ...(current[selectedGap.gapId] ?? initialGapDraft(selectedGap)),
        ...patch,
      },
    }));
  };

  if (gaps.length === 0 && selectedGap === null) return null;

  const beatId = draft?.beatId ?? "";
  const startMs = draft?.startMs ?? "";
  const endMs = draft?.endMs ?? "";
  const description = draft?.description ?? "";
  const parsedStartMs = integer(startMs);
  const parsedEndMs = integer(endMs);
  const timingValid = selectedGap !== null
    && parsedStartMs !== null
    && parsedEndMs !== null
    && parsedStartMs >= selectedGap.startMs
    && parsedStartMs < parsedEndMs
    && parsedEndMs <= selectedGap.endMs;
  const idAvailable = beatId.trim().length > 0
    && project.captions.items[beatId.trim()] === undefined
    && project.audioDescriptions.items[beatId.trim()] === undefined
    && project.audioDescriptionGaps[beatId.trim()] === undefined;
  const descriptionValid = description.trim().length > 0;
  const canSubmit = selectedGap !== null
    && !isCommandPending
    && !hasUnsavedDraft
    && timingValid
    && idAvailable
    && descriptionValid;

  const focusGap = async (gap: AudioDescriptionGap) => {
    await onExecuteCommand({
      type: "FocusGap",
      actor: humanReviewActor,
      gapId: gap.gapId,
      expectedGapRevision: gap.gapRevision,
      expectedProjectRevision: project.projectRevision,
    }, `Selected audio-description gap ${gap.gapId.toUpperCase()} for a Human proposal.`);
  };

  const propose = async () => {
    if (selectedGap === null || parsedStartMs === null || parsedEndMs === null || !canSubmit) return;
    const canonicalBeatId = beatId.trim();
    const result = await onExecuteCommand({
      type: "ProposeAudioDescriptionInGap",
      actor: humanReviewActor,
      gapId: selectedGap.gapId,
      expectedSelectionId: selectedGap.gapId,
      expectedGapRevision: selectedGap.gapRevision,
      beatId: canonicalBeatId,
      startMs: parsedStartMs,
      endMs: parsedEndMs,
      description: description.trim(),
      expectedProjectRevision: project.projectRevision,
    }, `Added audio-description proposal ${canonicalBeatId.toUpperCase()} as Human-authored work.`);
    if (result !== null && result.error === undefined) {
      setDraftsByGapId((current) => {
        const next = { ...current };
        delete next[selectedGap.gapId];
        return next;
      });
      onAcceptedBeat(result, canonicalBeatId);
    }
  };

  return (
    <section className="ad-gap-composer" aria-labelledby="ad-gap-composer-heading">
      <div className="panel-heading">
        <div>
          <h3 id="ad-gap-composer-heading">Audio-description gaps</h3>
          <p>Choose a retained silent interval, then draft a Human-authored description inside it.</p>
        </div>
        <span>{gaps.length} available</span>
      </div>
      {hasUnsavedDraft ? <p className="ad-gap-composer__guard" role="status">Save or discard the selected review draft before changing the active gap.</p> : null}
      <ul className="ad-gap-composer__gaps" aria-label="Available audio-description gaps">
        {gaps.map((gap) => {
          const active = selectedGap?.gapId === gap.gapId;
          return (
            <li key={gap.gapId}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                aria-label={`Select audio-description gap ${gap.gapId.toUpperCase()}`}
                disabled={isCommandPending || hasUnsavedDraft}
                onClick={() => void focusGap(gap)}
              >
                <strong>{gap.gapId.toUpperCase()}</strong>
                <span>{formatMediaTime(gap.startMs)} → {formatMediaTime(gap.endMs)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {selectedGap === null ? <p className="ad-gap-composer__empty">Select a gap to author a bounded description beat.</p> : (
        <div className="ad-gap-composer__form" aria-label={`Audio-description proposal for ${selectedGap.gapId.toUpperCase()}`}>
          <label className="review-field" htmlFor={`ad-gap-description-${selectedGap.gapId}`}>
            <span>Audio description for {selectedGap.gapId.toUpperCase()}</span>
            <textarea
              id={`ad-gap-description-${selectedGap.gapId}`}
              rows={3}
              value={description}
              autoFocus
              aria-invalid={!descriptionValid || undefined}
              aria-describedby={!descriptionValid ? `ad-gap-description-error-${selectedGap.gapId}` : undefined}
              onChange={(event) => updateDraft({ description: event.currentTarget.value })}
            />
          </label>
          {!descriptionValid ? <p id={`ad-gap-description-error-${selectedGap.gapId}`} className="review-field-error" role="alert">A description is required before adding this proposal.</p> : null}
          <div className="review-timing-fields">
            <label className="review-field" htmlFor={`ad-gap-start-${selectedGap.gapId}`}>
              <span>Start time in milliseconds</span>
              <input id={`ad-gap-start-${selectedGap.gapId}`} type="number" min={selectedGap.startMs} max={selectedGap.endMs - 1} step={1} value={startMs} aria-invalid={!timingValid || undefined} aria-describedby={!timingValid ? `ad-gap-timing-error-${selectedGap.gapId}` : undefined} onChange={(event) => updateDraft({ startMs: event.currentTarget.value })} />
            </label>
            <label className="review-field" htmlFor={`ad-gap-end-${selectedGap.gapId}`}>
              <span>End time in milliseconds</span>
              <input id={`ad-gap-end-${selectedGap.gapId}`} type="number" min={selectedGap.startMs + 1} max={selectedGap.endMs} step={1} value={endMs} aria-invalid={!timingValid || undefined} aria-describedby={!timingValid ? `ad-gap-timing-error-${selectedGap.gapId}` : undefined} onChange={(event) => updateDraft({ endMs: event.currentTarget.value })} />
            </label>
          </div>
          {!timingValid ? <p id={`ad-gap-timing-error-${selectedGap.gapId}`} className="review-field-error" role="alert">The description must use integer milliseconds entirely inside the selected gap.</p> : null}
          <label className="review-field" htmlFor={`ad-gap-id-${selectedGap.gapId}`}>
            <span>Audio-description identifier</span>
            <input id={`ad-gap-id-${selectedGap.gapId}`} value={beatId} aria-invalid={!idAvailable || undefined} aria-describedby={!idAvailable ? `ad-gap-id-error-${selectedGap.gapId}` : undefined} onChange={(event) => updateDraft({ beatId: event.currentTarget.value })} />
          </label>
          {!idAvailable ? <p id={`ad-gap-id-error-${selectedGap.gapId}`} className="review-field-error" role="alert">Choose a non-empty identifier that is not already used by a cue, beat, or gap.</p> : null}
          <button className="button button--signal" type="button" disabled={!canSubmit} onClick={() => void propose()}>
            Add Human audio-description proposal
          </button>
        </div>
      )}
    </section>
  );
}
