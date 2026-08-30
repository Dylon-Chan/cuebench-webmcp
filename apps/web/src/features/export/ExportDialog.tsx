import * as Dialog from "@radix-ui/react-dialog";
import {
  canonicalTrackFormat,
  prepareTrackExport,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
  type ExportDisposition,
  type ExportTrackKind,
  type ProjectTrackExport,
  type ProjectTrackExportRequest,
  type TrackFormat,
} from "@cuebench/domain";
import { useEffect, useRef, useState } from "react";
import { ImpactSummaryPanel } from "./ImpactSummaryPanel";
import type { FreshProjectTrackExport } from "../project/project-store";

const systemExportActor = { type: "System" as const, id: "cuebench-export" };

export interface ExportUrlApi {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const browserUrlApi = (): ExportUrlApi | null => (
  typeof URL.createObjectURL === "function" && typeof URL.revokeObjectURL === "function"
    ? URL
    : null
);

const mimeTypeFor = (format: TrackFormat): string => {
  const canonical = canonicalTrackFormat(format);
  return canonical === "vtt" ? "text/vtt;charset=utf-8"
    : canonical === "srt" ? "application/x-subrip;charset=utf-8"
      : "text/plain;charset=utf-8";
};

const formatsFor = (trackKind: ExportTrackKind): readonly { readonly value: TrackFormat; readonly label: string }[] => trackKind === "Captions"
  ? [{ value: "vtt", label: "WebVTT (.vtt)" }, { value: "srt", label: "SubRip (.srt)" }]
  : [{ value: "vtt", label: "Audio-description WebVTT (.vtt)" }, { value: "ad-txt", label: "Audio-description script (.txt)" }];

export interface ExportDialogProps {
  readonly project: CaptionProject;
  readonly onCommand: (command: DomainCommand) => CommandResult | Promise<CommandResult>;
  readonly urlApi?: ExportUrlApi | null;
  readonly prepareExport?: (request: ProjectTrackExportRequest) => ProjectTrackExport | Promise<ProjectTrackExport>;
  /** Store-owned canonical export boundary used by the workbench; it returns the revision that must receive the round-trip record. */
  readonly prepareFreshExport?: (request: ProjectTrackExportRequest) => Promise<FreshProjectTrackExport>;
  readonly now?: () => number;
  readonly createExportId?: () => string;
}

const defaultExportId = (): string => `export-${globalThis.crypto.randomUUID()}`;

/** Serializes and parse-compares before a Blob/object URL exists; a failed round trip has no download affordance. */
export function ExportDialog({
  project,
  onCommand,
  urlApi = browserUrlApi(),
  prepareExport = prepareTrackExport,
  prepareFreshExport,
  now = () => Date.now(),
  createExportId = defaultExportId,
}: ExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [trackKind, setTrackKind] = useState<ExportTrackKind>("Captions");
  const [format, setFormat] = useState<TrackFormat>("vtt");
  const [disposition, setDisposition] = useState<ExportDisposition>("draft");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [download, setDownload] = useState<{ readonly href: string; readonly filename: string } | null>(null);
  const liveUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const certificationId = project.certification.status === "NotCertified" ? "none" : project.certification.certificationId;
  const projectGenerationKey = `${project.projectId}:${project.projectRevision}:${project.certification.status}:${certificationId}`;

  const revokeDownload = () => {
    if (liveUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(liveUrl.current);
    liveUrl.current = null;
    setDownload(null);
  };

  useEffect(() => () => {
    generation.current += 1;
    if (liveUrl.current !== null && urlApi !== null) urlApi.revokeObjectURL(liveUrl.current);
  }, [urlApi]);

  /** URLs name exact project/certification bytes; changing either invalidates an older object URL. */
  useEffect(() => {
    generation.current += 1;
    revokeDownload();
  }, [projectGenerationKey]);

  const close = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      generation.current += 1;
      revokeDownload();
      setError(null);
      setNotice(null);
    }
  };

  const changeTrack = (nextTrack: ExportTrackKind) => {
    setTrackKind(nextTrack);
    setFormat(formatsFor(nextTrack)[0]!.value);
    generation.current += 1;
    revokeDownload();
  };

  const prepareDownload = async () => {
    const requestGeneration = ++generation.current;
    setPending(true);
    setError(null);
    setNotice(null);
    revokeDownload();
    try {
      /** Domain throws if serialization, parsing, normalization, or comparison disagrees. */
      const request = { project, trackKind, format, disposition } satisfies ProjectTrackExportRequest;
      const fresh = prepareFreshExport === undefined ? null : await prepareFreshExport(request);
      if (requestGeneration !== generation.current) return;
      const prepared = fresh === null ? await prepareExport(request) : fresh.prepared;
      if (requestGeneration !== generation.current) return;
      const canonicalProject = fresh?.project ?? project;
      if (fresh?.freshnessNotice !== null && fresh?.freshnessNotice !== undefined) setNotice(fresh.freshnessNotice);
      const result = await onCommand({
        type: "RecordExportRoundTrip",
        actor: systemExportActor,
        expectedProjectRevision: canonicalProject.projectRevision,
        exportId: createExportId(),
        trackKind,
        format: canonicalTrackFormat(format),
        disposition,
        verifiedAtMs: now(),
        text: prepared.text,
      });
      if (requestGeneration !== generation.current) return;
      if (result.error !== undefined) {
        setError(result.error.message);
        return;
      }
      if (urlApi === null) {
        setError("This browser cannot create a verified local download URL.");
        return;
      }
      /** The Blob and object URL are deliberately created after both verification and its durable record. */
      const href = urlApi.createObjectURL(new Blob([prepared.text], { type: mimeTypeFor(format) }));
      if (requestGeneration !== generation.current) {
        urlApi.revokeObjectURL(href);
        return;
      }
      liveUrl.current = href;
      setDownload({ href, filename: prepared.filename });
    } catch (cause) {
      if (requestGeneration === generation.current) setError(cause instanceof Error ? cause.message : "CueBench could not prepare this export.");
    } finally {
      if (requestGeneration === generation.current) setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Trigger asChild>
        <button className="header-button" type="button" aria-label="Export tracks">Export</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="storage-dialog export-dialog" aria-describedby="export-dialog-description">
          <Dialog.Title>Export track</Dialog.Title>
          <Dialog.Description id="export-dialog-description">
            CueBench serializes, parses, and compares the exact requested track before offering a download. Round-trip verification does not itself certify the project.
          </Dialog.Description>
          <div className="export-dialog__fields">
            <label className="review-field" htmlFor="export-track-kind"><span>Track</span>
              <select id="export-track-kind" value={trackKind} disabled={pending} onChange={(event) => changeTrack(event.currentTarget.value as ExportTrackKind)}>
                <option value="Captions">Captions</option>
                <option value="AudioDescriptions">Audio descriptions</option>
              </select>
            </label>
            <label className="review-field" htmlFor="export-format"><span>Format</span>
              <select id="export-format" value={format} disabled={pending} onChange={(event) => { setFormat(event.currentTarget.value as TrackFormat); generation.current += 1; revokeDownload(); }}>
                {formatsFor(trackKind).map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
              </select>
            </label>
            <label className="review-field" htmlFor="export-disposition"><span>Export version</span>
              <select id="export-disposition" value={disposition} disabled={pending} onChange={(event) => { setDisposition(event.currentTarget.value as ExportDisposition); generation.current += 1; revokeDownload(); }}>
                <option value="draft">Current draft</option>
                <option value="certified">Latest current certification</option>
              </select>
            </label>
          </div>
          <p className="export-dialog__note">Filenames state whether the file is a <b>.draft</b> or <b>.certified</b> export.</p>
          {error === null ? null : <p className="review-command-feedback" role="alert">{error}</p>}
          {notice === null ? null : <p className="export-dialog__status" role="status">{notice}</p>}
          {download === null ? null : <p className="export-dialog__status" role="status">Round-trip verified. <a className="button button--signal" href={download.href} download={download.filename}>Download verified export</a></p>}
          <div className="storage-dialog__actions">
            <Dialog.Close className="button button--outline" type="button" disabled={pending}>Close</Dialog.Close>
            <button className="button button--signal" type="button" disabled={pending} aria-busy={pending} onClick={() => void prepareDownload()}>Prepare verified download</button>
          </div>
          <ImpactSummaryPanel project={project} compact />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
