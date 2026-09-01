import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject } from "@cuebench/domain";
import { useState } from "react";
import type { ProjectDeletionResult } from "./project-store";

export interface DeleteProjectDialogProps {
  readonly project: CaptionProject;
  /** ProjectStore owns the one-transaction local deletion and optional cloud-cleanup request. */
  readonly onDelete: () => Promise<ProjectDeletionResult>;
}

/** Protected Human deletion boundary. It requires an in-page confirmation and is never a Browser Agent command. */
export function DeleteProjectDialog({ project, onDelete }: DeleteProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProjectDeletionResult | null>(null);
  const confirmed = confirmation === project.title;

  const remove = async () => {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      setResult(await onDelete());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not delete this local project.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setConfirmation("");
        setError(null);
        setResult(null);
      }
    }}>
      <Dialog.Trigger asChild>
        <button className="header-button header-button--delete" type="button" aria-label="Delete project">Delete</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog delete-dialog" aria-describedby="delete-project-description">
          <Dialog.Title>Delete CueBench project</Dialog.Title>
          <Dialog.Description id="delete-project-description">
            This Human-confirmed action removes the local project, source media, cached narration, findings, revisions, Court Record, certifications, and project settings. CueBench retains only a minimal deletion receipt so pending cloud cleanup can be reported or retried truthfully.
          </Dialog.Description>
          <label className="review-field" htmlFor="delete-project-confirmation">
            <span>Type the project title to confirm deletion</span>
            <input id="delete-project-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" />
          </label>
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          {result === null ? null : <p className="export-dialog__status" role="status">{result.cleanupNotice}</p>}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button" disabled={pending}>Cancel</Dialog.Close>
            <button className="button button--object" type="button" disabled={pending || !confirmed} aria-busy={pending} onClick={() => void remove()}>Delete this local project</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
