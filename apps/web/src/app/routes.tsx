import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { CaptionProject } from "@cuebench/domain";
import { VideoEvidenceBay } from "../features/evidence/VideoEvidenceBay";
import { projectMediaEvidence } from "../features/evidence/project-media-evidence";
import { projectLocalEvidenceContentResolver } from "../features/evidence/project-local-evidence";
import { CertificationReview } from "../features/export/CertificationReview";
import { ExportDialog } from "../features/export/ExportDialog";
import { ImpactSummaryPanel } from "../features/export/ImpactSummaryPanel";
import { ProfileProposalDialog, builtInProfileProposal } from "../features/export/ProfileProposalDialog";
import { ValidationPanel } from "../features/export/ValidationPanel";
import { BackupDialog } from "../features/project/BackupDialog";
import { DeleteProjectDialog } from "../features/project/DeleteProjectDialog";
import { HostedProcessingPanel } from "../features/project/HostedProcessingPanel";
import { ProjectStart } from "../features/project/ProjectStart";
import { StorageDisclosure } from "../features/project/StorageDisclosure";
import type { ProjectMode, ProjectStore } from "../features/project/project-store";
import { GenerationStatus } from "../features/generation/GenerationStatus";
import { AdGenerationStatus } from "../features/generation/AdGenerationStatus";
import type { SourceProvenance } from "../features/project/source-provenance";
import { CourtRecord } from "../features/review/CourtRecord";
import { ReviewDocket, ReviewSelectionSummary } from "../features/review/ReviewDocket";
import { WebMcpBridge, type BoundWebMcpProfileProposal } from "./WebMcpBridge";

export interface AppRoutesProps {
  readonly store: ProjectStore;
  readonly webMcpAvailable: boolean;
  readonly webMcpDebugEnabled?: boolean;
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
  readonly webMcpDebugEnabled: boolean;
  readonly store: ProjectStore;
}

export function WorkbenchShell({ project, mode, sourceObjectUrl, sourceProvenance, webMcpAvailable, webMcpDebugEnabled, store }: WorkbenchShellProps) {
  const validationLabel = project.validation.status === "NotRun"
    ? "Validation not run"
    : `${project.validation.blockerCount} blockers · ${project.validation.warningCount} warnings`;
  const [reviewSeekToMediaTime, setReviewSeekToMediaTime] = useState<(mediaTimeMs: number) => void>(() => () => undefined);
  const [browserAgentFocusSeek, setBrowserAgentFocusSeek] = useState<((input: { readonly playheadMs: number; readonly visualEpoch: number }) => Promise<boolean>) | null>(null);
  const [readNativePlayheadMs, setReadNativePlayheadMs] = useState<(() => number) | null>(null);
  const [reviewDraftActive, setReviewDraftActive] = useState(false);
  const [agentProfileProposal, setAgentProfileProposal] = useState<BoundWebMcpProfileProposal | null>(null);
  const [agentProfileProposalOpen, setAgentProfileProposalOpen] = useState(false);
  const pendingProfilePublicationRef = useRef<{
    readonly proposalId: string;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
    readonly removeAbortListener: () => void;
  } | null>(null);
  const narrationPreviewGateway = useMemo(() => {
    if (mode !== "durable") return undefined;
    try {
      return store.getNarrationPreviewGateway();
    } catch {
      // Browsers without safe Blob URL support retain the complete human
      // review workflow; the endpoint is deliberately not approximated.
      return undefined;
    }
  }, [mode, store]);
  const reviewItemNavigationRef = useRef<(itemId: string, sourceLabel: string) => void>(() => undefined);
  const reviewItemRevisionFocusRef = useRef<(itemId: string, itemRevision: number, sourceLabel: string) => void>(() => undefined);
  const reviewTimelineRebaseRef = useRef<(itemId: string, previousItemRevision: number, project: CaptionProject) => void>(() => undefined);
  const browserAgentFocusRef = useRef<(input: {
    readonly itemId: string;
    readonly itemRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
    readonly visualEpoch?: number;
  }) => Promise<boolean>>(async () => false);
  const browserAgentSelectionPreflightRef = useRef<(input: {
    readonly itemId: string;
    readonly itemRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<boolean>>(async () => false);
  const projectInstanceCapabilityFingerprint = store.getProjectInstanceFence()?.projectInstanceCapabilityFingerprint ?? null;
  const profileProposalMatchesProject = agentProfileProposal !== null
    && agentProfileProposal.projectId === project.projectId
    && agentProfileProposal.baseProjectRevision === project.projectRevision
    && agentProfileProposal.baseProfileRevision === project.qualityProfile.revision
    && agentProfileProposal.projectInstanceEpoch === store.getProjectInstanceEpoch()
    && agentProfileProposal.projectInstanceCapabilityFingerprint === projectInstanceCapabilityFingerprint;
  const publishAgentProfileProposal = useCallback((proposal: BoundWebMcpProfileProposal, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Browser Agent profile publication was cancelled.", "AbortError"));
      return;
    }
    const previous = pendingProfilePublicationRef.current;
    if (previous !== null) {
      previous.removeAbortListener();
      previous.reject(new Error("A newer Browser Agent profile proposal replaced the previous pending proposal."));
    }
    let settled = false;
    const settle = (accepted: boolean, reason?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (pendingProfilePublicationRef.current?.proposalId === proposal.proposalId) pendingProfilePublicationRef.current = null;
      if (!accepted) {
        setAgentProfileProposal(null);
        setAgentProfileProposalOpen(false);
        reject(reason ?? new DOMException("Browser Agent profile publication was cancelled.", "AbortError"));
        return;
      }
      resolve();
    };
    const onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    pendingProfilePublicationRef.current = {
      proposalId: proposal.proposalId,
      resolve: () => settle(true),
      reject: (reason) => settle(false, reason),
      removeAbortListener: () => signal.removeEventListener("abort", onAbort),
    };
    setAgentProfileProposal(proposal);
    setAgentProfileProposalOpen(true);
  }), []);
  const acknowledgeProfileProposalVisible = useCallback((proposalId: string) => {
    const pending = pendingProfilePublicationRef.current;
    if (pending?.proposalId !== proposalId) return;
    pendingProfilePublicationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, []);

  useLayoutEffect(() => {
    if (agentProfileProposal === null || profileProposalMatchesProject) return;
    const pending = pendingProfilePublicationRef.current;
    pendingProfilePublicationRef.current = null;
    pending?.removeAbortListener();
    pending?.reject(new Error("The Browser Agent profile proposal no longer matches the visible project revision."));
    setAgentProfileProposal(null);
    setAgentProfileProposalOpen(false);
  }, [agentProfileProposal, profileProposalMatchesProject]);
  useLayoutEffect(() => () => {
    const pending = pendingProfilePublicationRef.current;
    pendingProfilePublicationRef.current = null;
    pending?.removeAbortListener();
    pending?.reject(new Error("CueBench closed before the Browser Agent profile proposal was visible."));
  }, []);
  const receiveVideoSeek = useCallback((seekToMediaTime: (mediaTimeMs: number) => void) => {
    setReviewSeekToMediaTime(() => seekToMediaTime);
  }, []);
  const receiveNativePlayhead = useCallback((readMediaTimeMs: () => number) => {
    setReadNativePlayheadMs(() => readMediaTimeMs);
  }, []);
  const receiveBrowserAgentFocusSeek = useCallback((seek: (input: { readonly playheadMs: number; readonly visualEpoch: number }) => Promise<boolean>) => {
    setBrowserAgentFocusSeek(() => seek);
  }, []);
  const receiveReviewItemNavigation = useCallback((navigate: (itemId: string, sourceLabel: string) => void) => {
    reviewItemNavigationRef.current = navigate;
  }, []);
  const requestReviewItemNavigation = useCallback((itemId: string, sourceLabel: string) => {
    reviewItemNavigationRef.current(itemId, sourceLabel);
  }, []);
  const receiveReviewItemRevisionFocus = useCallback((focus: (itemId: string, itemRevision: number, sourceLabel: string) => void) => {
    reviewItemRevisionFocusRef.current = focus;
  }, []);
  const requestReviewItemRevisionFocus = useCallback((itemId: string, itemRevision: number) => {
    reviewItemRevisionFocusRef.current(itemId, itemRevision, `Court Record ${itemId.toUpperCase()} r${itemRevision}`);
  }, []);
  const receiveReviewTimelineRebase = useCallback((rebase: (itemId: string, previousItemRevision: number, project: CaptionProject) => void) => {
    reviewTimelineRebaseRef.current = rebase;
  }, []);
  const reportTimelineCanonicalRevision = useCallback((itemId: string, previousItemRevision: number, canonicalProject: CaptionProject) => {
    reviewTimelineRebaseRef.current(itemId, previousItemRevision, canonicalProject);
  }, []);
  const receiveBrowserAgentFocus = useCallback((focus: (input: {
    readonly itemId: string;
    readonly itemRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
    readonly visualEpoch?: number;
  }) => Promise<boolean>) => {
    browserAgentFocusRef.current = focus;
  }, []);
  const receiveBrowserAgentSelectionPreflight = useCallback((prepare: (input: {
    readonly itemId: string;
    readonly itemRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<boolean>) => {
    browserAgentSelectionPreflightRef.current = prepare;
  }, []);
  const prepareBrowserAgentSelection = useCallback(async (input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal: AbortSignal;
  }): Promise<boolean> => browserAgentSelectionPreflightRef.current({
    itemId: input.selectionId,
    itemRevision: input.selectionRevision,
    playheadMs: input.playheadMs,
    ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
    signal: input.signal,
  }), []);
  const revealBrowserAgentSelection = useCallback(async (input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat" | "AudioDescriptionGap";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
    readonly visualEpoch: number;
  }): Promise<boolean> => {
    const wasAborted = () => input.signal?.aborted === true;
    if (wasAborted()) return false;
    if (input.kind === "AudioDescriptionGap") {
      if (browserAgentFocusSeek === null) return false;
      return browserAgentFocusSeek({ playheadMs: input.playheadMs, visualEpoch: input.visualEpoch });
    }
    const focused = await browserAgentFocusRef.current({
      itemId: input.selectionId,
      itemRevision: input.selectionRevision,
      playheadMs: input.playheadMs,
      ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      visualEpoch: input.visualEpoch,
    });
    // A dirty-review cancellation must not even seek a different clip span;
    // the old editor remains the page's visible, protected context.
    if (!focused) return false;
    if (wasAborted()) return false;
    if (browserAgentFocusSeek === null) return false;
    const visible = await browserAgentFocusSeek({ playheadMs: input.playheadMs, visualEpoch: input.visualEpoch });
    if (wasAborted()) return false;
    return visible;
  }, [browserAgentFocusSeek]);

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
          <ValidationPanel project={project} onCommand={(command) => store.executeCommand(command)} />
          <ProfileProposalDialog
            project={project}
            projectInstanceEpoch={store.getProjectInstanceEpoch()}
            projectInstanceCapabilityFingerprint={projectInstanceCapabilityFingerprint}
            proposal={profileProposalMatchesProject ? agentProfileProposal : builtInProfileProposal(project)}
            onCommand={(command) => store.executeCommand(command)}
            {...(profileProposalMatchesProject ? {
              open: agentProfileProposalOpen,
              onOpenChange: setAgentProfileProposalOpen,
              onProposalVisible: acknowledgeProfileProposalVisible,
            } : {})}
          />
          <CertificationReview project={project} onCommand={(command) => store.executeCommand(command)} />
          <ExportDialog
            project={project}
            onCommand={(command) => store.executeCommand(command)}
            prepareFreshExport={(request) => store.prepareFreshTrackExport(request)}
          />
          <BackupDialog project={project} manager={store} />
          <DeleteProjectDialog project={project} onDelete={() => store.deleteCurrentProject()} />
        </div>
      </header>

      <div className="workbench-grid">
        <VideoEvidenceBay
          project={project}
          sourceObjectUrl={sourceObjectUrl}
          evidence={projectMediaEvidence(sourceProvenance)}
          onCommand={(command) => store.executeCommand(command)}
          onSeekReady={receiveVideoSeek}
          onPlayheadReady={receiveNativePlayhead}
          onBrowserAgentFocusSeekReady={receiveBrowserAgentFocusSeek}
          onRequestItemNavigation={requestReviewItemNavigation}
          reviewDraftActive={reviewDraftActive}
          onCanonicalItemRevision={reportTimelineCanonicalRevision}
          reviewSummary={<ReviewSelectionSummary project={project} />}
        />

        <ReviewDocket
          project={project}
          onCommand={(command) => store.executeCommand(command)}
          onSeekToMediaTime={reviewSeekToMediaTime}
          footer={<>
            <ImpactSummaryPanel project={project} compact />
            <StorageDisclosure mode={mode} />
          </>}
          onRegisterItemNavigation={receiveReviewItemNavigation}
          onRegisterItemRevisionFocus={receiveReviewItemRevisionFocus}
          onRegisterBrowserAgentFocus={receiveBrowserAgentFocus}
          onRegisterBrowserAgentSelectionPreflight={receiveBrowserAgentSelectionPreflight}
          onRegisterCanonicalTimelineEdit={receiveReviewTimelineRebase}
          onDraftStateChange={setReviewDraftActive}
          evidenceContentResolver={projectLocalEvidenceContentResolver(project)}
          {...(readNativePlayheadMs === null ? {} : { onReadNativePlayheadMs: readNativePlayheadMs })}
          {...(narrationPreviewGateway === undefined ? {} : { narrationPreviewGateway })}
        />
        <CourtRecord project={project} onSelectItem={(itemId) => requestReviewItemNavigation(itemId, `Court Record item ${itemId.toUpperCase()}`)} onFocusItemRevision={requestReviewItemRevisionFocus} />
        <HostedProcessingPanel
          projectId={project.projectId}
          durationMs={project.media.durationMs}
          mediaSha256={project.media.sha256}
          sourceObjectUrl={sourceObjectUrl}
          resolveProjectOwnerCapability={store.getCloudProjectOwnerCapability}
        />
        <GenerationStatus project={project} store={store} />
        <AdGenerationStatus project={project} store={store} />
        {webMcpAvailable || webMcpDebugEnabled ? <WebMcpBridge
          project={project}
          store={store}
          debugEnabled={webMcpDebugEnabled}
          onProfileProposal={publishAgentProfileProposal}
          onRevealSelection={revealBrowserAgentSelection}
          onPrepareSelectionFocus={prepareBrowserAgentSelection}
          {...(readNativePlayheadMs === null ? {} : { onReadNativePlayheadMs: readNativePlayheadMs })}
        /> : null}
      </div>
    </main>
  );
}

function ProjectRoute({ store, webMcpAvailable, webMcpDebugEnabled = false }: AppRoutesProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (snapshot.project === null || snapshot.sourceObjectUrl === null || snapshot.sourceProvenance === null) return <ProjectStart store={store} />;
  return <WorkbenchShell
    project={snapshot.project}
    mode={snapshot.mode}
    sourceObjectUrl={snapshot.sourceObjectUrl}
    sourceProvenance={snapshot.sourceProvenance}
    webMcpAvailable={webMcpAvailable}
    webMcpDebugEnabled={webMcpDebugEnabled}
    store={store}
  />;
}

export function AppRoutes({ store, webMcpAvailable, webMcpDebugEnabled = false }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<ProjectRoute store={store} webMcpAvailable={webMcpAvailable} webMcpDebugEnabled={webMcpDebugEnabled} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
