import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject, ProjectImportDescriptor } from "@cuebench/domain";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

export interface BackupDownload {
  readonly filename: string;
  readonly text: string;
}

export interface BackupImportResult {
  readonly project: CaptionProject;
  readonly cleanupNotice: string;
}

/** Narrow Human-UI facade over ProjectStore: no actor is accepted and no agent can invoke import through this component. */
export interface BackupManager {
  readonly exportProjectBackup: () => Promise<BackupDownload>;
  readonly previewBackupText: (text: string) => Promise<ProjectImportDescriptor>;
  readonly relinkImportedMedia: (file: File) => Promise<ProjectImportDescriptor>;
  readonly importPreviewedBackup: () => Promise<BackupImportResult>;
}

interface BackupUrlApi {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const browserUrlApi = (): BackupUrlApi | null => typeof URL.createObjectURL === "function" && typeof URL.revokeObjectURL === "function"
  ? URL
  : null;

const readText = async (file: File): Promise<string> => {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("CueBench could not read this backup."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
};

/** Testing-library can provide a plain array, whereas browser inputs provide FileList. */
const firstSelectedFile = (files: FileList | readonly File[] | null | undefined): File | null => {
  if (files === null || files === undefined) return null;
  if (typeof (files as FileList).item === "function") return (files as FileList).item(0);
  return files[0] ?? null;
};

export interface BackupDialogProps {
  readonly project: CaptionProject;
  readonly manager: BackupManager;
  readonly urlApi?: BackupUrlApi | null;
}

const relinkText = (descriptor: ProjectImportDescriptor): string => {
  if (descriptor.mode === "read-only") return "This backup comes from a newer schema and is available read-only. CueBench will not downgrade or import it.";
  if (descriptor.mediaRelink.status === "required") return `Select the original media with SHA-256 ${descriptor.mediaRelink.expectedSha256} to continue.`;
  if (descriptor.mediaRelink.status === "mismatch") return descriptor.mediaRelink.error.message;
  return "Media Relink verified against the SHA-256 recorded by this backup.";
};

/** A preview-first import flow: backup manifests exclude video, imports require a matching Human Media Relink. */
export function BackupDialog({ project, manager, urlApi = browserUrlApi() }: BackupDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectImportDescriptor | null>(null);
  const [download, setDownload] = useState<{ readonly href: string; readonly filename: string } | null>(null);
  const currentUrl = useRef<string | null>(null);

  const revokeDownload = () => {
    if (currentUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
    setDownload(null);
  };

  useEffect(() => () => {
    if (currentUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(currentUrl.current);
  }, [urlApi]);

  const createBackup = async () => {
    setPending(true);
    setError(null);
    try {
      const backup = await manager.exportProjectBackup();
      if (urlApi === null) {
        setError("This browser cannot create a local backup download URL.");
        return;
      }
      revokeDownload();
      const href = urlApi.createObjectURL(new Blob([backup.text], { type: "application/json;charset=utf-8" }));
      currentUrl.current = href;
      setDownload({ href, filename: backup.filename });
      setMessage("Portable project backup created. It excludes the source video by design.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not create this project backup.");
    } finally {
      setPending(false);
    }
  };

  const previewBackup = async (file: File) => {
    setPending(true);
    setError(null);
    setMessage(null);
    setPreview(null);
    try {
      const descriptor = await manager.previewBackupText(await readText(file));
      setPreview(descriptor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not preview this backup.");
    } finally {
      setPending(false);
    }
  };

  const relink = async (file: File) => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      setPreview(await manager.relinkImportedMedia(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not verify this media relink.");
    } finally {
      setPending(false);
    }
  };

  const importPreview = async () => {
    if (preview === null || preview.mode === "read-only" || !preview.canImport) return;
    setPending(true);
    setError(null);
    try {
      const result = await manager.importPreviewedBackup();
      setMessage(result.cleanupNotice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not import this project backup.");
    } finally {
      setPending(false);
    }
  };

  const onBackupFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = firstSelectedFile(event.currentTarget.files);
    if (file !== null) void previewBackup(file);
    event.currentTarget.value = "";
  };

  const onRelinkFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = firstSelectedFile(event.currentTarget.files);
    if (file !== null) void relink(file);
    event.currentTarget.value = "";
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        revokeDownload();
        setPreview(null);
        setError(null);
        setMessage(null);
      }
    }}>
      <Dialog.Trigger asChild>
        <button className="header-button" type="button" aria-label="Project backup">Backup</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="backup-dialog-description">
          <Dialog.Title>Project backup and import</Dialog.Title>
          <Dialog.Description id="backup-dialog-description">
            A CueBench backup carries project structure, revisions, evidence, findings, profiles, Court Record, certifications, hashes, and export metadata. It never embeds source video.
          </Dialog.Description>
          <p className="export-dialog__note">Project: <b>{project.title}</b></p>
          <div className="export-dialog__actions">
            <button className="button button--signal" type="button" disabled={pending} onClick={() => void createBackup()}>Create project backup</button>
            {download === null ? null : <a className="button button--outline" href={download.href} download={download.filename}>Download backup</a>}
          </div>
          <section className="backup-dialog__section" aria-labelledby="backup-import-heading">
            <h3 id="backup-import-heading">Preview a backup before import</h3>
            <label className="review-field" htmlFor="backup-import-file"><span>Choose CueBench backup</span>
              <input id="backup-import-file" type="file" accept="application/json,.cuebench.json" disabled={pending} onChange={onBackupFile} />
            </label>
            {preview === null ? null : (
              <div className={`backup-dialog__preview backup-dialog__preview--${preview.mode}`}>
                <strong>{preview.mode === "read-only" ? "Newer backup" : "Import preview"}</strong>
                <p>{relinkText(preview)}</p>
                {preview.mode === "read-only" ? null : (
                  <>
                    <p>Import is a Human-only action. CueBench keeps a safety backup before migration or replacement.</p>
                    <label className="review-field" htmlFor="backup-relink-file"><span>Choose original media for Media Relink</span>
                      <input id="backup-relink-file" type="file" accept="video/*" disabled={pending} onChange={onRelinkFile} />
                    </label>
                    <button className="button button--signal" type="button" disabled={pending || !preview.canImport} onClick={() => void importPreview()}>
                      Confirm import after relink
                    </button>
                  </>
                )}
              </div>
            )}
          </section>
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          {message === null ? null : <p className="export-dialog__status" role="status">{message}</p>}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button" disabled={pending}>Close</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
