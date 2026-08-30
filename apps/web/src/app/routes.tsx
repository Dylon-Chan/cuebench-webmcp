import { useCallback, useState, useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { CaptionProject } from "@cuebench/domain";
import { VideoEvidenceBay } from "../features/evidence/VideoEvidenceBay";
import { projectMediaEvidence } from "../features/evidence/project-media-evidence";
import { ProjectStart } from "../features/project/ProjectStart";
import { StorageDisclosure } from "../features/project/StorageDisclosure";
import type { ProjectMode, ProjectStore } from "../features/project/project-store";
import type { SourceProvenance } from "../features/project/source-provenance";
import { CourtRecord } from "../features/review/CourtRecord";
import { ReviewDocket } from "../features/review/ReviewDocket";

export interface AppRoutesProps {
  readonly store: ProjectStore;
  readonly webMcpAvailable: boolean;
}

export const formatDuration = (durationMs: number): string => {
  const totalMilliseconds = Math.max(0, Math.trunc(durationMs));
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = totalMilliseconds % 1_000;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
};

interface WorkbenchShellProps {
  readonly project: CaptionProject;
  readonly mode: ProjectMode | null;
  readonly sourceObjectUrl: string;
  readonly sourceProvenance: SourceProvenance;
  readonly webMcpAvailable: boolean;
  readonly store: ProjectStore;
}

export function WorkbenchShell({ project, mode, sourceObjectUrl, sourceProvenance, webMcpAvailable, store }: WorkbenchShellProps) {
  const validationLabel = project.validation.status === "NotRun"
    ? "Validation not run"
    : `${project.validation.blockerCount} blockers · ${project.validation.warningCount} warnings`;
  const [reviewSeekToMediaTime, setReviewSeekToMediaTime] = useState<(mediaTimeMs: number) => void>(() => () => undefined);
  const receiveVideoSeek = useCallback((seekToMediaTime: (mediaTimeMs: number) => void) => {
    setReviewSeekToMediaTime(() => seekToMediaTime);
  }, []);

  return (
    <main className="workbench" aria-label="CueBench workbench">
      <header className="instrument-header">
        <div className="brand-lockup" aria-label="CueBench">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>CueBench</strong>
        </div>
        <div className="header-identity">
          <span className="signal-glyph" aria-hidden="true" />
          <span>Calibration Bench</span>
        </div>
        <dl className="header-reading">
          <div><dt>Project</dt><dd>{project.title}</dd></div>
          <div><dt>Validation</dt><dd>{validationLabel}</dd></div>
          <div><dt>Storage</dt><dd>{mode === "temporary" ? "Temporary page" : "Browser durable"}</dd></div>
          <div><dt>WebMCP</dt><dd className={webMcpAvailable ? "state-ok" : "state-muted"}>{webMcpAvailable ? "Page API available" : "Browser Agent tools unavailable"}</dd></div>
        </dl>
        <div className="header-compact-status" aria-label="Storage and Browser Agent status">
          <span><b>Storage</b>{mode === "temporary" ? "Temporary page" : "Browser durable"}</span>
          <span><b>WebMCP</b>{webMcpAvailable ? "Page API available" : "Tools unavailable"}</span>
        </div>
        <div className="header-actions">
          <span id="settings-unavailable" className="visually-hidden">Settings are not available in this project shell yet.</span>
          <span id="export-unavailable" className="visually-hidden">Export is available after the export workflow is added.</span>
          <button className="header-button" type="button" disabled aria-describedby="settings-unavailable">Settings (later)</button>
          <button className="header-button" type="button" disabled aria-describedby="export-unavailable">Export (later)</button>
        </div>
      </header>

      <div className="workbench-grid">
        <VideoEvidenceBay
          project={project}
          sourceObjectUrl={sourceObjectUrl}
          evidence={projectMediaEvidence(sourceProvenance)}
          onCommand={(command) => store.executeCommand(command)}
          onSeekReady={receiveVideoSeek}
        />

        <ReviewDocket
          project={project}
          onCommand={(command) => store.executeCommand(command)}
          onSeekToMediaTime={reviewSeekToMediaTime}
          footer={<StorageDisclosure mode={mode} />}
        />
      </div>

      <CourtRecord project={project} />
    </main>
  );
}

function ProjectRoute({ store, webMcpAvailable }: AppRoutesProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (snapshot.project === null || snapshot.sourceObjectUrl === null || snapshot.sourceProvenance === null) return <ProjectStart store={store} />;
  return <WorkbenchShell
    project={snapshot.project}
    mode={snapshot.mode}
    sourceObjectUrl={snapshot.sourceObjectUrl}
    sourceProvenance={snapshot.sourceProvenance}
    webMcpAvailable={webMcpAvailable}
    store={store}
  />;
}

export function AppRoutes({ store, webMcpAvailable }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<ProjectRoute store={store} webMcpAvailable={webMcpAvailable} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
