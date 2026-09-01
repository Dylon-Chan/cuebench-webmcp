import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject, CommandResult, DomainCommand, QualityFinding } from "@cuebench/domain";
import { useState } from "react";

const humanValidationActor = { type: "Human" as const, id: "human" };
const systemValidationActor = { type: "System" as const, id: "cuebench-validation" };

export interface ValidationPanelProps {
  readonly project: CaptionProject;
  /** Uses the same persistent command adapter as the review docket. */
  readonly onCommand: (command: DomainCommand) => CommandResult | Promise<CommandResult>;
  /** Test and incremental-validation seam; full runs remain the certification authority. */
  readonly findings?: readonly QualityFinding[];
}

const findingLabel = (finding: QualityFinding): string => finding.severity === "blocker"
  ? "Blocking validation finding"
  : "Quality warning";

/**
 * Validation describes deterministic project quality facts. It deliberately
 * does not render or alter an item's Proposed/Agent Ready/Objected/Sustained
 * review state, and it makes no legal or accessibility-conformance claim.
 */
export function ValidationPanel({ project, onCommand, findings = project.validationRun?.findings ?? [] }: ValidationPanelProps) {
  const [open, setOpen] = useState(false);
  const [waiverFinding, setWaiverFinding] = useState<QualityFinding | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runValidation = async () => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onCommand({
        type: "ValidateProject",
        actor: systemValidationActor,
        expectedProjectRevision: project.projectRevision,
      });
      if (result.error !== undefined) {
        setError(result.error.message);
        return;
      }
      setMessage("Full deterministic validation was recorded for the current project state.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not run validation.");
    } finally {
      setPending(false);
    }
  };

  const beginWaiver = (finding: QualityFinding) => {
    setWaiverFinding(finding);
    setReason("");
    setError(null);
  };

  const waive = async () => {
    if (waiverFinding === null || !reason.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await onCommand({
        type: "WaiveWarning",
        actor: humanValidationActor,
        expectedProjectRevision: project.projectRevision,
        findingId: waiverFinding.findingId,
        reason: reason.trim(),
      });
      if (result.error !== undefined) {
        setError(result.error.message);
        return;
      }
      setMessage(`Human waiver recorded for ${waiverFinding.findingId}.`);
      setWaiverFinding(null);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not record this warning waiver.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setWaiverFinding(null);
        setReason("");
      }
    }}>
      <Dialog.Trigger asChild>
        <button className="header-button" type="button" aria-label="Open validation">Validate</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="validation-description">
          <Dialog.Title>Validation</Dialog.Title>
          <Dialog.Description id="validation-description">
            Deterministic Quality Profile findings are separate from review states. A passing run supports review; it does not certify legal or WCAG conformance.
          </Dialog.Description>
          <div className="export-dialog__reading" aria-label="Validation state">
            <span><b>Run</b>{project.validation.status}</span>
            <span><b>Blockers</b>{project.validation.blockerCount}</span>
            <span><b>Warnings</b>{project.validation.warningCount}</span>
          </div>
          <div className="export-dialog__actions">
            <button className="button button--signal" type="button" disabled={pending} aria-busy={pending} onClick={() => void runValidation()}>
              Run full validation
            </button>
          </div>
          {message === null ? null : <p className="export-dialog__status" role="status">{message}</p>}
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          <section className="validation-panel__findings" aria-labelledby="validation-findings-heading">
            <h3 id="validation-findings-heading">Current findings</h3>
            {findings.length === 0 ? <p>No findings are attached to the available validation run.</p> : (
              <ul className="validation-panel__list">
                {findings.map((finding) => {
                  const waiver = project.warningWaivers[finding.findingId];
                  return (
                    <li key={finding.findingId} className={`validation-panel__finding validation-panel__finding--${finding.severity}`}>
                      <div>
                        <strong>{findingLabel(finding)}</strong>
                        <p>{finding.message}</p>
                        <span>{finding.ruleId} · {finding.findingId}</span>
                      </div>
                      {finding.severity === "warning" ? waiver === undefined ? (
                        <button className="button button--outline" type="button" disabled={pending} onClick={() => beginWaiver(finding)} aria-label={`Waive warning ${finding.findingId}`}>
                          Waive warning
                        </button>
                      ) : (
                        <div className="validation-panel__waiver">
                          <strong>Waived by Human</strong>
                          <span>{waiver.reason}</span>
                        </div>
                      ) : <span className="validation-panel__cannot-waive">Resolve required</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Dialog.Root open={waiverFinding !== null} onOpenChange={(nextOpen) => {
            if (!nextOpen && !pending) {
              setWaiverFinding(null);
              setReason("");
            }
          }}>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="storage-dialog review-dialog" aria-describedby="warning-waiver-description">
                <Dialog.Title>Waive quality warning</Dialog.Title>
                <Dialog.Description id="warning-waiver-description">
                  A waiver is a Human decision for this exact warning. Record why the current work should proceed without changing the revision.
                </Dialog.Description>
                <label className="review-field" htmlFor="warning-waiver-reason">
                  <span>Reason for waiving this warning</span>
                  <textarea id="warning-waiver-reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} rows={4} autoFocus />
                </label>
                {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
                <div className="storage-dialog__actions">
                  <button className="button button--outline" type="button" disabled={pending} onClick={() => setWaiverFinding(null)}>Cancel</button>
                  <button className="button button--signal" type="button" disabled={pending || !reason.trim()} onClick={() => void waive()}>
                    Record Human waiver
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button">Close validation</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
