import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useSyncExternalStore, type ChangeEvent } from "react";
import { StorageDisclosure } from "./StorageDisclosure";
import type { ProjectStore } from "./project-store";

export interface ProjectStartProps {
  readonly store: ProjectStore;
}

export function ProjectStart({ store }: ProjectStartProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const temporaryChoiceOpen = snapshot.route === "temporary-choice";
  const uploadInput = useRef<HTMLInputElement>(null);
  const busy = snapshot.activity !== null;
  const busyMessage = snapshot.activity === "hydrating"
    ? "Restoring a local project…"
    : snapshot.activity === "saving"
      ? "Saving and verifying local media…"
      : "Preparing bundled media or local video…";

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.item(0);
    if (file !== null && file !== undefined) void store.chooseFile(file);
    event.currentTarget.value = "";
  };

  return (
    <main className="project-start" aria-labelledby="project-start-heading">
      <section className="project-start__instrument" aria-label="Start a CueBench project">
        <div className="instrument-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1 id="project-start-heading">Set the evidence on the bench.</h1>
        <p>
          Open the bundled media fixture or bring a video you are ready to review. CueBench keeps the human judgment in view from the first cue.
        </p>
        <div className="project-start__actions">
          <button className="button button--signal" type="button" disabled={busy} onClick={() => void store.openSample()}>
            Open bundled media fixture
          </button>
          <button className="button button--outline" type="button" disabled={busy} onClick={() => uploadInput.current?.click()}>
            Upload local video
          </button>
          <input
            ref={uploadInput}
            id="source-video"
            className="visually-hidden"
            aria-label="Choose video"
            type="file"
            accept="video/*"
            tabIndex={-1}
            onChange={onFileChange}
          />
        </div>
        {busy ? <p className="form-status" role="status" aria-live="polite">{busyMessage}</p> : null}
        {snapshot.error === null ? null : <p className="form-error" role="alert">{snapshot.error}</p>}
        {snapshot.cleanupNotice === null ? null : <p className="form-status" role="status" aria-live="polite">{snapshot.cleanupNotice}</p>}
        <StorageDisclosure mode={null} />
        <p className="project-start__limits">Video limits: 500 MB and 15 minutes. No account is required.</p>
      </section>

      <section className="project-start__measurements" aria-label="CueBench project workflow">
        <div><strong>Source</strong><span>Choose media stored in this browser</span></div>
        <div><strong>Evidence</strong><span>Review visible evidence against time</span></div>
        <div><strong>Ruling</strong><span>Keep the final human decision explicit</span></div>
      </section>

      <Dialog.Root open={temporaryChoiceOpen} onOpenChange={(open) => { if (!open && !busy) store.cancelPendingUpload(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog" aria-describedby="temporary-session-description">
            <Dialog.Title>Temporary session required</Dialog.Title>
            <Dialog.Description id="temporary-session-description">
              This browser cannot offer enough durable storage for this video. Continue only if keeping it in current-page memory is acceptable: reloading or closing this page loses the project.
            </Dialog.Description>
            <StorageDisclosure mode="temporary" />
            {snapshot.error === null ? null : <p className="form-error" role="alert">{snapshot.error}</p>}
            <div className="storage-dialog__actions">
              <button className="button button--outline" type="button" disabled={busy} onClick={() => store.cancelPendingUpload()}>
                Choose another video
              </button>
              <button className="button button--signal" type="button" disabled={busy} aria-busy={busy} onClick={() => void store.continueTemporarily()}>
                Continue temporarily
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
