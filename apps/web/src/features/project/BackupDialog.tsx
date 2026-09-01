import * as Dialog from "@radix-ui/react-dialog";
import type { CaptionProject, ProjectImportDescriptor } from "@cuebench/domain";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { readBoundedBackupFile } from "./backup-import-safety";

export interface BackupDownload {
  readonly filename: string;
  readonly text: string;
  readonly freshnessNotice?: string;
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

/** Testing-library can provide a plain array, whereas browser inputs provide FileList. */
const firstSelectedFile = (files: FileList | readonly File[] | null | undefined): File | null => {
  if (files === null || files === undefined) return null;
  if (typeof (files as FileList).item === "function") return (files as FileList).item(0);
  return files[0] ?? null;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const stringAt = (record: Readonly<Record<string, unknown>> | null, key: string, fallback = "Unavailable"): string =>
  record !== null && typeof record[key] === "string" && record[key].trim().length > 0 ? record[key] : fallback;

const numberAt = (record: Readonly<Record<string, unknown>> | null, key: string): string =>
  record !== null && typeof record[key] === "number" && Number.isFinite(record[key]) ? String(record[key]) : "Unavailable";

/** Portable tracks are `{ order, items }`, not arrays. Prefer visible order and tolerate an older sparse payload by counting its item map. */
const trackCount = (root: Readonly<Record<string, unknown>> | null, key: string): string => {
  const track = root === null ? null : asRecord(root[key]);
  if (track === null) return "Unavailable";
  if (Array.isArray(track.order)) return String(track.order.length);
  const items = asRecord(track.items);
  return items === null ? "Unavailable" : String(Object.keys(items).length);
};

interface PortableProjectFacts {
  readonly identity: string;
  readonly title: string;
  readonly revision: string;
  readonly captions: string;
  readonly audioDescriptions: string;
  readonly profile: string;
  readonly certification: string;
  readonly mediaHash: string;
}

const portableProjectFacts = (project: unknown): PortableProjectFacts => {
  const root = asRecord(project);
  const profile = asRecord(root?.qualityProfile);
  const certification = asRecord(root?.certification);
  const media = asRecord(root?.media);
  return {
    identity: stringAt(root, "projectId"),
    title: stringAt(root, "title"),
    revision: numberAt(root, "projectRevision"),
    captions: trackCount(root, "captions"),
    audioDescriptions: trackCount(root, "audioDescriptions"),
    profile: `${stringAt(profile, "name")} (${stringAt(profile, "profileId")})`,
    certification: stringAt(certification, "status"),
    mediaHash: stringAt(media, "sha256"),
  };
};

const outline = (value: unknown): string => {
  const text = JSON.stringify(value, null, 2);
  return text.length <= 6_000 ? text : `${text.slice(0, 6_000)}\n… preview truncated after 6,000 characters`;
};

const relinkText = (descriptor: ProjectImportDescriptor): string => {
  if (descriptor.mode === "read-only") return "This backup comes from a newer schema and is available read-only. CueBench will not downgrade or import it.";
  if (descriptor.mediaRelink.status === "required") return `Select the original media with SHA-256 ${descriptor.mediaRelink.expectedSha256} to continue.`;
  if (descriptor.mediaRelink.status === "mismatch") return descriptor.mediaRelink.error.message;
  return "Media Relink verified against the SHA-256 recorded by this backup.";
};

const factRows: readonly { readonly key: keyof PortableProjectFacts; readonly label: string }[] = [
  { key: "identity", label: "Incoming identity" },
  { key: "title", label: "Incoming title" },
  { key: "revision", label: "Incoming project revision" },
  { key: "captions", label: "Caption items" },
  { key: "audioDescriptions", label: "Audio-description items" },
  { key: "profile", label: "Quality profile" },
  { key: "certification", label: "Certification state" },
  { key: "mediaHash", label: "Media SHA-256" },
];

function PortableFacts({ project, schemaVersion }: { readonly project: unknown; readonly schemaVersion: number }) {
  const facts = portableProjectFacts(project);
  return (
    <dl className="backup-dialog__facts">
      <div><dt>Schema version</dt><dd>{schemaVersion}</dd></div>
      {factRows.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{facts[row.key]}</dd></div>)}
    </dl>
  );
}

function ReplacementDiff({ descriptor }: { readonly descriptor: ProjectImportDescriptor }) {
  if (descriptor.mode === "read-only") return null;
  const previous = descriptor.replacementSafetyBackup?.backup.project ?? null;
  if (previous === null) return <p className="backup-dialog__diff-note">Target: <b>New project</b>. No current local project will be replaced.</p>;
  const before = portableProjectFacts(previous);
  const after = portableProjectFacts(descriptor.project);
  const changed = factRows.filter(({ key }) => before[key] !== after[key]);
  return (
    <section className="backup-dialog__diff" aria-labelledby="backup-diff-heading">
      <h4 id="backup-diff-heading">Replacement diff</h4>
      <p className="backup-dialog__diff-note">Target: <b>{before.title}</b> ({before.identity}). CueBench will recheck this exact project revision immediately before import.</p>
      {changed.length === 0 ? <p className="backup-dialog__diff-note">No portable project fields differ. Media still requires an exact SHA-256 relink.</p> : (
        <dl>
          {changed.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd><s>{before[key]}</s> → {after[key]}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

function ReadOnlyInspector({ descriptor }: { readonly descriptor: Extract<ProjectImportDescriptor, { readonly mode: "read-only" }> }) {
  return (
    <section className="backup-dialog__read-only" aria-labelledby="backup-read-only-heading">
      <h3 id="backup-read-only-heading">Read-only portable backup inspector</h3>
      <p>Schema v{descriptor.schemaVersion} is newer than this CueBench build. Its portable payload is shown for inspection only; no import, migration, or relink controls are available.</p>
      <PortableFacts project={descriptor.project} schemaVersion={descriptor.schemaVersion} />
      <details>
        <summary>Safe portable payload outline</summary>
        <pre>{outline(descriptor.project)}</pre>
      </details>
    </section>
  );
}

export interface BackupDialogProps {
  /** Omit a project on the start screen to import a verified backup as a new durable project. */
  readonly project?: CaptionProject | null;
  readonly manager: BackupManager;
  readonly urlApi?: BackupUrlApi | null;
  readonly disabled?: boolean;
}

/** A preview-first import flow: backup manifests exclude video, imports require a matching Human Media Relink. */
export function BackupDialog({ project = null, manager, urlApi = browserUrlApi(), disabled = false }: BackupDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectImportDescriptor | null>(null);
  const [download, setDownload] = useState<{ readonly href: string; readonly filename: string } | null>(null);
  const currentUrl = useRef<string | null>(null);
  const asyncGeneration = useRef(0);
  const certificationId = project === null || project.certification.status === "NotCertified"
    ? "none"
    : project.certification.certificationId;
  const projectGenerationKey = `${project?.projectId ?? "start"}:${project?.projectRevision ?? 0}:${project?.certification.status ?? "none"}:${certificationId}`;

  const revokeDownload = () => {
    if (currentUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
    setDownload(null);
  };

  const invalidateAsyncUi = () => {
    asyncGeneration.current += 1;
    revokeDownload();
    setPending(false);
  };

  useEffect(() => () => {
    asyncGeneration.current += 1;
    if (currentUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(currentUrl.current);
  }, [urlApi]);

  /** A revision/certification change invalidates any download generated for the prior aggregate. */
  useEffect(() => {
    invalidateAsyncUi();
  }, [projectGenerationKey]);

  const createBackup = async () => {
    if (project === null) return;
    const generation = ++asyncGeneration.current;
    revokeDownload();
    setPending(true);
    setError(null);
    try {
      const backup = await manager.exportProjectBackup();
      if (generation !== asyncGeneration.current) return;
      if (urlApi === null) {
        setError("This browser cannot create a local backup download URL.");
        return;
      }
      const href = urlApi.createObjectURL(new Blob([backup.text], { type: "application/json;charset=utf-8" }));
      if (generation !== asyncGeneration.current) {
        urlApi.revokeObjectURL(href);
        return;
      }
      currentUrl.current = href;
      setDownload({ href, filename: backup.filename });
      setMessage(backup.freshnessNotice ?? "Portable project backup created. It excludes the source video by design.");
    } catch (cause) {
      if (generation === asyncGeneration.current) setError(cause instanceof Error ? cause.message : "CueBench could not create this project backup.");
    } finally {
      if (generation === asyncGeneration.current) setPending(false);
    }
  };

  const previewBackup = async (file: File) => {
    const generation = ++asyncGeneration.current;
    revokeDownload();
    setPending(true);
    setError(null);
    setMessage(null);
    setPreview(null);
    try {
      const safeEnvelope = await readBoundedBackupFile(file);
      if (generation !== asyncGeneration.current) return;
      const descriptor = await manager.previewBackupText(JSON.stringify(safeEnvelope));
      if (generation !== asyncGeneration.current) return;
      setPreview(descriptor);
    } catch (cause) {
      if (generation === asyncGeneration.current) setError(cause instanceof Error ? cause.message : "CueBench could not preview this backup.");
    } finally {
      if (generation === asyncGeneration.current) setPending(false);
    }
  };

  const relink = async (file: File) => {
    const generation = ++asyncGeneration.current;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const descriptor = await manager.relinkImportedMedia(file);
      if (generation === asyncGeneration.current) setPreview(descriptor);
    } catch (cause) {
      if (generation === asyncGeneration.current) setError(cause instanceof Error ? cause.message : "CueBench could not verify this media relink.");
    } finally {
      if (generation === asyncGeneration.current) setPending(false);
    }
  };

  const importPreview = async () => {
    if (preview === null || preview.mode === "read-only" || !preview.canImport) return;
    const generation = ++asyncGeneration.current;
    setPending(true);
    setError(null);
    revokeDownload();
    try {
      const result = await manager.importPreviewedBackup();
      if (generation === asyncGeneration.current) setMessage(result.cleanupNotice);
    } catch (cause) {
      if (generation === asyncGeneration.current) setError(cause instanceof Error ? cause.message : "CueBench could not import this project backup.");
    } finally {
      if (generation === asyncGeneration.current) setPending(false);
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

  const readOnly = preview?.mode === "read-only";
  const triggerLabel = project === null ? "Restore project backup" : "Project backup";
  const triggerClass = project === null ? "button button--outline" : "header-button";
  const incomingFacts = useMemo(() => preview === null ? null : portableProjectFacts(preview.project), [preview]);

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        invalidateAsyncUi();
        setPreview(null);
        setError(null);
        setMessage(null);
      }
    }}>
      <Dialog.Trigger asChild>
        <button className={triggerClass} type="button" aria-label={triggerLabel} disabled={disabled}>{project === null ? "Restore backup" : "Backup"}</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="backup-dialog-description">
          <Dialog.Title>Project backup and import</Dialog.Title>
          <Dialog.Description id="backup-dialog-description">
            A CueBench backup carries project structure, revisions, evidence, findings, profiles, Court Record, certifications, hashes, and export metadata. It never embeds source video.
          </Dialog.Description>
          {project === null ? <p className="export-dialog__note">No local project is open. A verified backup will be imported as a <b>new durable project</b>.</p> : (
            <>
              <p className="export-dialog__note">Project: <b>{project.title}</b></p>
              {readOnly ? null : <div className="export-dialog__actions">
                <button className="button button--signal" type="button" disabled={pending} onClick={() => void createBackup()}>Create project backup</button>
                {download === null ? null : <a className="button button--outline" href={download.href} download={download.filename}>Download backup</a>}
              </div>}
            </>
          )}
          {readOnly ? <ReadOnlyInspector descriptor={preview} /> : (
            <section className="backup-dialog__section" aria-labelledby="backup-import-heading">
              <h3 id="backup-import-heading">Preview a backup before import</h3>
              <label className="review-field" htmlFor="backup-import-file"><span>Choose CueBench backup</span>
                <input id="backup-import-file" type="file" accept="application/json,.cuebench.json" disabled={pending} onChange={onBackupFile} />
              </label>
              {preview === null ? null : (
                <div className="backup-dialog__preview backup-dialog__preview--preview">
                  <strong>Import preview</strong>
                  <p>{relinkText(preview)}</p>
                  <PortableFacts project={preview.project} schemaVersion={preview.schemaVersion} />
                  <ReplacementDiff descriptor={preview} />
                  {incomingFacts === null ? null : <p className="backup-dialog__preview-note">Incoming title <b>{incomingFacts.title}</b> will be visible only after matching Media Relink and Human confirmation.</p>}
                  <p>Import is a Human-only action. CueBench keeps a safety backup before migration or replacement.</p>
                  <label className="review-field" htmlFor="backup-relink-file"><span>Choose original media for Media Relink</span>
                    <input id="backup-relink-file" type="file" accept="video/*" disabled={pending} onChange={onRelinkFile} />
                  </label>
                  <button className="button button--signal" type="button" disabled={pending || !preview.canImport} onClick={() => void importPreview()}>
                    Confirm import after relink
                  </button>
                </div>
              )}
            </section>
          )}
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          {message === null ? null : <p className="export-dialog__status" role="status">{message}</p>}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button">Close</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
