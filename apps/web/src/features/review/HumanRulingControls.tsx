import * as Dialog from "@radix-ui/react-dialog";
import type { CommandResult, DomainCommand } from "@cuebench/domain";
import { useEffect, useState } from "react";
import type { ReviewableItem } from "./review-utils";
import { humanReviewActor, itemAccessibleLabel } from "./review-utils";

export interface HumanRulingControlsProps {
  readonly item: ReviewableItem | null;
  readonly projectRevision: number;
  readonly isCommandPending: boolean;
  /** The draft lives in ReviewDocket, which is the authority boundary. */
  readonly hasUnsavedDraft: boolean;
  /** Kept inside the modal so a failed command remains perceivable while it stays open. */
  readonly commandError: string | null;
  readonly onExecuteCommand: (command: DomainCommand, acceptedMessage: string) => Promise<CommandResult | null>;
}

/**
 * Human-only control boundary. No actor prop is accepted: a Browser Agent
 * cannot acquire Object or Sustain authority by rendering this component.
 */
export function HumanRulingControls({
  item,
  projectRevision,
  isCommandPending,
  hasUnsavedDraft,
  commandError,
  onExecuteCommand,
}: HumanRulingControlsProps) {
  const [objectOpen, setObjectOpen] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setReason("");
    setObjectOpen(false);
  }, [item?.itemId, item?.current.itemRevision]);

  const label = item === null ? null : itemAccessibleLabel(item);
  const object = async () => {
    if (item === null || !reason.trim()) return;
    const result = await onExecuteCommand({
      type: "ObjectItem",
      actor: humanReviewActor,
      itemId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: projectRevision,
      reason: reason.trim(),
    }, `Objected ${label} as a Human ruling.`);
    if (result !== null && result.error === undefined) setObjectOpen(false);
  };

  const sustain = () => {
    if (item === null) return;
    void onExecuteCommand({
      type: "SustainItem",
      actor: humanReviewActor,
      itemId: item.itemId,
      expectedItemRevision: item.current.itemRevision,
      expectedProjectRevision: projectRevision,
    }, `Sustained ${label} as a Human ruling.`);
  };

  return (
    <section className="ruling-panel" aria-labelledby="ruling-heading">
      <div>
        <h3 id="ruling-heading">Human rulings</h3>
        <span>Human-only</span>
      </div>
      {item === null ? (
        <p>Select an item before issuing a ruling.</p>
      ) : hasUnsavedDraft ? (
        <p id="ruling-draft-guard">Save or discard the draft before a human ruling. Rulings always bind the displayed saved revision.</p>
      ) : (
        <p>Object records a reason. Sustain accepts this exact revision and records Human attribution.</p>
      )}
      <div className="ruling-panel__actions">
        <Dialog.Root open={objectOpen} onOpenChange={setObjectOpen}>
          <Dialog.Trigger asChild>
            <button className="button button--object" type="button" disabled={item === null || isCommandPending || hasUnsavedDraft} aria-label="Object selected revision" aria-describedby={hasUnsavedDraft ? "ruling-draft-guard" : undefined}>Object</button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="storage-dialog review-dialog" aria-describedby="object-reason-description">
              <Dialog.Title>Object {label}</Dialog.Title>
              <Dialog.Description id="object-reason-description">State the evidence-grounded reason for rejecting this exact revision. The reason will be preserved in the Court Record.</Dialog.Description>
              {item === null ? null : (
                <label className="review-field" htmlFor={`object-reason-${item.itemId}`}>
                  <span>Reason for objecting to {label}</span>
                  <textarea
                    id={`object-reason-${item.itemId}`}
                    value={reason}
                    onChange={(event) => setReason(event.currentTarget.value)}
                    rows={4}
                    autoFocus
                  />
                </label>
              )}
              {commandError === null ? null : <p className="review-command-feedback" role="alert">{commandError}</p>}
              <div className="storage-dialog__actions">
                <Dialog.Close className="button button--outline" type="button">Cancel</Dialog.Close>
                <button className="button button--object" type="button" disabled={isCommandPending || !reason.trim()} onClick={() => void object()}>Confirm objection</button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <button
          className="button button--sustain"
          type="button"
          disabled={item === null || isCommandPending || hasUnsavedDraft || item.current.state === "Sustained"}
          aria-label="Sustain selected revision"
          aria-describedby={hasUnsavedDraft ? "ruling-draft-guard" : undefined}
          onClick={sustain}
        >
          {item?.current.state === "Sustained" ? "Sustained" : "Sustain"}
        </button>
      </div>
    </section>
  );
}
