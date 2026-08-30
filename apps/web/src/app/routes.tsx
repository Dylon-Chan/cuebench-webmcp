import * as Tabs from "@radix-ui/react-tabs";
import { useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { CaptionProject } from "@cuebench/domain";
import { VideoEvidenceBay } from "../features/evidence/VideoEvidenceBay";
import { ProjectStart } from "../features/project/ProjectStart";
import { StorageDisclosure } from "../features/project/StorageDisclosure";
import type { ProjectMode, ProjectStore } from "../features/project/project-store";

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
  readonly webMcpAvailable: boolean;
  readonly store: ProjectStore;
}

export function WorkbenchShell({ project, mode, sourceObjectUrl, webMcpAvailable, store }: WorkbenchShellProps) {
  const captionCount = project.captions.order.length;
  const descriptionCount = project.audioDescriptions.order.length;
  const validationLabel = project.validation.status === "NotRun"
    ? "Validation not run"
    : `${project.validation.blockerCount} blockers · ${project.validation.warningCount} warnings`;

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
          onCommand={(command) => store.executeCommand(command)}
        />

        <aside className="review-docket" aria-labelledby="review-docket-heading">
          <div className="region-heading">
            <div><h2 id="review-docket-heading">Review Docket</h2><p>{captionCount + descriptionCount} review items</p></div>
            <span className="docket-indicator">Live state</span>
          </div>
          <Tabs.Root defaultValue="all">
            <Tabs.List className="docket-tabs" aria-label="Review item filters">
              <Tabs.Trigger value="all">All</Tabs.Trigger>
              <Tabs.Trigger value="proposed">Proposed</Tabs.Trigger>
              <Tabs.Trigger value="objected">Objected</Tabs.Trigger>
              <Tabs.Trigger value="sustained">Sustained</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content className="docket-content" value="all">
              <p className="empty-docket">{captionCount === 0 ? "Caption generation will place proposed cues here for human review." : "Select an item to inspect its evidence and revision."}</p>
            </Tabs.Content>
            <Tabs.Content className="docket-content" value="proposed"><p className="empty-docket">No Proposed revisions in this shell state.</p></Tabs.Content>
            <Tabs.Content className="docket-content" value="objected"><p className="empty-docket">No Objected revisions in this shell state.</p></Tabs.Content>
            <Tabs.Content className="docket-content" value="sustained"><p className="empty-docket">No Sustained revisions in this shell state.</p></Tabs.Content>
          </Tabs.Root>
          <section className="ruling-panel" aria-labelledby="ruling-heading">
            <div><h3 id="ruling-heading">Human rulings</h3><span>Never delegated to a Browser Agent</span></div>
            <span id="ruling-unavailable" className="visually-hidden">Rulings activate with Task 9's reviewed item workflow.</span>
            <p>Rulings activate with Task 9's reviewed item workflow. Human decisions remain unavailable in this shell.</p>
            <div className="ruling-panel__actions">
              <button className="button button--object" type="button" aria-label="Object selected revision" aria-describedby="ruling-unavailable" title="Rulings activate with Task 9's reviewed item workflow." disabled>Object</button>
              <button className="button button--sustain" type="button" aria-label="Sustain selected revision" aria-describedby="ruling-unavailable" title="Rulings activate with Task 9's reviewed item workflow." disabled>Sustain</button>
            </div>
          </section>
          <StorageDisclosure mode={mode} />
        </aside>
      </div>

      <section className="court-record" aria-labelledby="court-record-heading">
        <div className="region-heading region-heading--compact">
          <div><h2 id="court-record-heading">Court Record</h2><p>Append-only project provenance</p></div>
          <span id="record-unavailable" className="visually-hidden">The full Court Record view is not available in this project shell yet.</span>
          <button className="header-button" type="button" disabled aria-describedby="record-unavailable">Full record (later)</button>
        </div>
        <div className="court-record__empty">
          <span className="record-rule" aria-hidden="true" />
          <p>{project.courtRecord.length === 0 ? "No project events recorded yet." : `${project.courtRecord.length} recorded actions.`}</p>
        </div>
      </section>
    </main>
  );
}

function ProjectRoute({ store, webMcpAvailable }: AppRoutesProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (snapshot.project === null || snapshot.sourceObjectUrl === null) return <ProjectStart store={store} />;
  return <WorkbenchShell
    project={snapshot.project}
    mode={snapshot.mode}
    sourceObjectUrl={snapshot.sourceObjectUrl}
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
