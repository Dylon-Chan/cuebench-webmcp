import * as Dialog from "@radix-ui/react-dialog";
import { useSyncExternalStore, type ChangeEvent } from "react";
import { StorageDisclosure } from "./StorageDisclosure";
import type { ProjectStore } from "./project-store";

export interface ProjectStartProps {
  readonly store: ProjectStore;
}

export function ProjectStart({ store }: ProjectStartProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const temporaryChoiceOpen = snapshot.route === "temporary-choice";

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
          Open the short teaching sample or bring a video you are ready to review. CueBench keeps the human judgment in view from the first cue.
        </p>
        <div className="project-start__actions">
          <button className="button button--signal" type="button" onClick={() => void store.openSample()}>
            Open bundled sample
          </button>
          <label className="button button--outline" htmlFor="source-video">
            Upload local video
          </label>
          <input id="source-video" className="visually-hidden" aria-label="Choose video" type="file" accept="video/*" onChange={onFileChange} />
        </div>
        {snapshot.error === null ? null : <p className="form-error" role="alert">{snapshot.error}</p>}
        <StorageDisclosure mode={null} />
        <p className="project-start__limits">Video limits: 500 MB and 15 minutes. No account is required.</p>
      </section>

      <section className="project-start__measurements" aria-label="CueBench project workflow">
        <div><strong>01</strong><span>Choose source media</span></div>
        <div><strong>02</strong><span>Review visible evidence</span></div>
        <div><strong>03</strong><span>Make the human ruling</span></div>
      </section>

      <Dialog.Root open={temporaryChoiceOpen} onOpenChange={(open) => { if (!open) store.cancelPendingUpload(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog" aria-describedby="temporary-session-description">
            <Dialog.Title>Temporary session required</Dialog.Title>
            <Dialog.Description id="temporary-session-description">
              This browser cannot offer enough durable storage for this video. A temporary session is usable now, but is not recoverable after this browser session ends.
            </Dialog.Description>
            <StorageDisclosure mode="temporary" />
            <div className="storage-dialog__actions">
              <Dialog.Close asChild>
                <button className="button button--outline" type="button">Choose another video</button>
              </Dialog.Close>
              <button className="button button--signal" type="button" onClick={() => void store.continueTemporarily()}>
                Continue temporarily
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
