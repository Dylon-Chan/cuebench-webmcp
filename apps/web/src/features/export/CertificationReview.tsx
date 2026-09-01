import * as Dialog from "@radix-ui/react-dialog";
import {
  prepareCertificationReview,
  type CaptionProject,
  type CertificationReadiness,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import { useEffect, useState } from "react";

const humanCertificationActor = { type: "Human" as const, id: "human" };

export interface CertificationReviewProps {
  readonly project: CaptionProject;
  readonly onCommand: (command: DomainCommand) => CommandResult | Promise<CommandResult>;
  readonly prepareReadiness?: (project: CaptionProject) => CertificationReadiness;
  readonly now?: () => number;
  readonly createCertificationId?: () => string;
}

const defaultCertificationId = (): string => `certification-${globalThis.crypto.randomUUID()}`;

/** Certification is a Human-only immutable snapshot, intentionally absent from Browser Agent tool surfaces. */
export function CertificationReview({
  project,
  onCommand,
  prepareReadiness = prepareCertificationReview,
  now = () => Date.now(),
  createCertificationId = defaultCertificationId,
}: CertificationReviewProps) {
  const [open, setOpen] = useState(false);
  const [readiness, setReadiness] = useState<CertificationReadiness | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    const next = prepareReadiness(project);
    setReadiness(next);
    return next;
  };

  useEffect(() => {
    if (open) setReadiness(prepareReadiness(project));
    // The exact current project object, rather than a one-time dialog value,
    // is the displayed readiness input while review remains open.
  }, [open, project, prepareReadiness]);

  const confirm = async () => {
    const displayed = readiness ?? refresh();
    /** Recompute at the confirmation boundary; never reuse a hash read earlier in the dialog. */
    const current = prepareReadiness(project);
    if (current.readinessHash !== displayed.readinessHash) {
      setReadiness(current);
      setError("Certification readiness changed. Review the current blockers, warnings, and snapshot hash before confirming again.");
      return;
    }
    if (!current.canCertify) {
      setReadiness(current);
      setError("Certification is not ready. Resolve blockers, warning waivers, stale validation, and review-state requirements first.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await onCommand({
        type: "CertifyProject",
        actor: humanCertificationActor,
        expectedProjectRevision: project.projectRevision,
        expectedReadinessHash: current.readinessHash,
        certificationId: createCertificationId(),
        certifiedAtMs: now(),
      });
      if (result.error !== undefined) {
        setError(result.error.message);
        return;
      }
      setMessage("Human certification recorded for the exact reviewed snapshot.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not record certification.");
    } finally {
      setPending(false);
    }
  };

  const active = readiness;
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (nextOpen) {
        setError(null);
        setMessage(null);
      } else {
        setReadiness(null);
      }
    }}>
      <Dialog.Trigger asChild>
        <button className="header-button" type="button" aria-label="Review certification">Certify</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="certification-review-description">
          <Dialog.Title>Certification review</Dialog.Title>
          <Dialog.Description id="certification-review-description">
            Certification records a Human decision over one exact snapshot. It is not an automated, legal, or accessibility-conformance certification.
          </Dialog.Description>
          {active === null ? <p className="export-dialog__empty" role="status">Preparing current certification readiness…</p> : (
            <>
              <div className="export-dialog__reading">
                <span><b>Blockers</b>{active.currentBlockers.length}</span>
                <span><b>Unwaived warnings</b>{active.unwaivedWarnings.length}</span>
                <span><b>Sustained</b>{active.itemStateCounts.Sustained}</span>
              </div>
              <p className="certification-review__hash"><b>Current readiness hash</b><code>{active.readinessHash}</code></p>
              <section className="certification-review__section" aria-labelledby="certification-blockers-heading">
                <h3 id="certification-blockers-heading">Blocking validation findings</h3>
                {active.currentBlockers.length === 0 ? <p>None in the available readiness snapshot.</p> : <ul>{active.currentBlockers.map((finding) => <li key={finding.findingId}>{finding.message}</li>)}</ul>}
              </section>
              <section className="certification-review__section" aria-labelledby="certification-warnings-heading">
                <h3 id="certification-warnings-heading">Unwaived quality warnings</h3>
                {active.unwaivedWarnings.length === 0 ? <p>None in the available readiness snapshot.</p> : <ul>{active.unwaivedWarnings.map((finding) => <li key={finding.findingId}>{finding.message}</li>)}</ul>}
              </section>
              <section className="certification-review__section" aria-labelledby="certification-stale-heading">
                <h3 id="certification-stale-heading">Validation freshness</h3>
                {active.staleValidationCauses.length === 0 ? <p>Full validation is current for this snapshot.</p> : <ul>{active.staleValidationCauses.map((cause) => <li key={cause.code}>{cause.message}</li>)}</ul>}
              </section>
              <section className="certification-review__section" aria-labelledby="certification-states-heading">
                <h3 id="certification-states-heading">Review-state counts</h3>
                <p>Proposed review items: {active.itemStateCounts.Proposed} · Agent Ready: {active.itemStateCounts.AgentReady} · Objected: {active.itemStateCounts.Objected} · Sustained: {active.itemStateCounts.Sustained}</p>
              </section>
            </>
          )}
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          {message === null ? null : <p className="export-dialog__status" role="status">{message}</p>}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button" disabled={pending}>Close</Dialog.Close>
            <button className="button button--sustain" type="button" disabled={pending || active === null || !active.canCertify} onClick={() => void confirm()}>
              Confirm certification
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
