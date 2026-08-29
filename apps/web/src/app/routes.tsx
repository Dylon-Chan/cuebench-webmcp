import * as Tabs from "@radix-ui/react-tabs";
import { useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { CaptionProject } from "@cuebench/domain";
import { ProjectStart } from "../features/project/ProjectStart";
import { StorageDisclosure } from "../features/project/StorageDisclosure";
import type { ProjectMode, ProjectStore } from "../features/project/project-store";

export interface AppRoutesProps {
  readonly store: ProjectStore;
  readonly webMcpAvailable: boolean;
}

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface WorkbenchShellProps {
  readonly project: CaptionProject;
  readonly mode: ProjectMode | null;
  readonly webMcpAvailable: boolean;
}

export function WorkbenchShell({ project, mode, webMcpAvailable }: WorkbenchShellProps) {
  const captionCount = project.captions.order.length;
  const descriptionCount = project.audioDescriptions.order.length;
  const hasSelection = project.selectedItem !== null;
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
          <div><dt>Storage</dt><dd>{mode === "temporary" ? "Temporary session" : "Browser durable"}</dd></div>
          <div><dt>WebMCP</dt><dd className={webMcpAvailable ? "state-ok" : "state-muted"}>{webMcpAvailable ? "Agent connected" : "Browser Agent unavailable"}</dd></div>
        </dl>
        <div className="header-actions">
          <button className="header-button" type="button">Settings</button>
          <button className="header-button" type="button">Export</button>
        </div>
      </header>

      <div className="workbench-grid">
        <section className="evidence-bay" aria-labelledby="evidence-bay-heading">
          <div className="region-heading">
            <div>
              <h1 id="evidence-bay-heading">Evidence bay</h1>
              <p>{project.media.sourceId} · {formatDuration(project.media.durationMs)}</p>
            </div>
            <span className="measurement-label">Native clock</span>
          </div>
          <div className="specimen-view" aria-label="Source media specimen">
            <div className="specimen-view__slide">
              <span className="specimen-view__axis" aria-hidden="true" />
              <span className="specimen-view__curve" aria-hidden="true" />
              <p>Source media ready for review</p>
              <strong>{project.title}</strong>
              <span>Visible evidence stays attached to its media time.</span>
            </div>
            <div className="specimen-view__note">Original video is retained locally; playback attaches here.</div>
          </div>
          <div className="transport-bar" aria-label="Playback transport">
            <button type="button" className="transport-control" aria-label="Play source media">Play</button>
            <output aria-label="Current media time">00:00.000</output>
            <span aria-hidden="true">/</span>
            <output aria-label="Source duration">{formatDuration(project.media.durationMs)}.000</output>
            <span className="transport-bar__spacer" />
            <button type="button" className="transport-control">Captions</button>
          </div>
          <section className="timeline-shell" aria-labelledby="timeline-heading">
            <div className="region-heading region-heading--compact">
              <div><h2 id="timeline-heading">Shared timeline</h2><p>Integer millisecond projection</p></div>
              <span className="measurement-label">00:00 → {formatDuration(project.media.durationMs)}</span>
            </div>
            <div className="waveform-shell" aria-label="Waveform placeholder for the source media">
              <div className="waveform-signal" aria-hidden="true" />
              <span className="playhead" aria-hidden="true" />
            </div>
            <div className="timeline-lanes">
              <div><strong>Captions</strong><span>{captionCount === 0 ? "No caption cues yet" : `${captionCount} caption cues`}</span></div>
              <div><strong>Audio description</strong><span>{descriptionCount === 0 ? "No description beats yet" : `${descriptionCount} description beats`}</span></div>
            </div>
          </section>
        </section>

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
            <p>{hasSelection ? "The active revision is ready for a human decision." : "Choose a cue or description beat before ruling."}</p>
            <div className="ruling-panel__actions">
              <button className="button button--object" type="button" aria-label="Object selected revision" disabled={!hasSelection}>Object</button>
              <button className="button button--sustain" type="button" aria-label="Sustain selected revision" disabled={!hasSelection}>Sustain</button>
            </div>
          </section>
          <StorageDisclosure mode={mode} />
        </aside>
      </div>

      <section className="court-record" aria-labelledby="court-record-heading">
        <div className="region-heading region-heading--compact">
          <div><h2 id="court-record-heading">Court Record</h2><p>Append-only project provenance</p></div>
          <button className="header-button" type="button">View full record</button>
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
  if (snapshot.project === null) return <ProjectStart store={store} />;
  return <WorkbenchShell project={snapshot.project} mode={snapshot.mode} webMcpAvailable={webMcpAvailable} />;
}

export function AppRoutes({ store, webMcpAvailable }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<ProjectRoute store={store} webMcpAvailable={webMcpAvailable} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
