import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GenerationRunStatus } from "@cuebench/contracts";
import type { CaptionProject, CommandResult } from "@cuebench/domain";
import { loadPersistedCloudUpload, type PersistedCloudUploadRecovery } from "../project/cloud-upload";
import {
  CaptionGenerationClient,
  type CaptionGenerationClientPort,
  type GenerationClientReceipt,
  type GenerationProjectStore,
} from "./generation-client";

const pollingIntervalMs = 1_500;

type CaptionGenerationStage = GenerationRunStatus["stage"] | undefined;

const isTerminal = (stage: CaptionGenerationStage): boolean => (
  stage === "Cancelled" || stage === "Completed" || stage === "Failed"
);

const stageLabel = (stage: CaptionGenerationStage): string => {
  switch (stage) {
    case "Queued": return "Queued for durable caption generation";
    case "PreparingMedia": return "Preparing private media evidence";
    case "Transcribing": return "Creating diarized and word-timestamp transcript evidence";
    case "AligningEvidence": return "Aligning speaker evidence to word timestamps";
    case "ReconcilingTranscript": return "Reconciling bounded transcript uncertainty";
    case "SegmentingCaptions": return "Applying deterministic Education Profile segmentation";
    case "AwaitingAdoption": return "Staged caption evidence is ready for human adoption";
    case "Completed": return "Staged caption evidence was adopted into this browser project";
    case "Cancelled": return "Caption generation was cancelled; no staged captions were adopted";
    case "Failed": return "Caption generation stopped before it could stage a complete result";
    default: return "Caption generation has not started";
  }
};

const errorMessage = (error: unknown, fallback: string): string => error instanceof Error && error.message.trim().length > 0
  ? error.message
  : fallback;

const activeCaptionRunId = (project: CaptionProject): string | null => (
  project.activeGenerationRun?.targetTrack === "Captions" ? project.activeGenerationRun.runId : null
);

const hasProposedCaptions = (project: CaptionProject): boolean => Object.values(project.captions.items)
  .some((item) => item.mergedIntoItemId === null && item.current.state === "Proposed");

const hasUploadAuthorization = (
  recovery: PersistedCloudUploadRecovery | null,
  project: CaptionProject,
): recovery is PersistedCloudUploadRecovery & { readonly session: string; readonly operationReceipt: string } => (
  recovery !== null
  && typeof recovery.session === "string" && recovery.session.length > 0
  && typeof recovery.operationReceipt === "string" && recovery.operationReceipt.length > 0
  && recovery.sourceSha256.toLowerCase() === project.media.sha256.toLowerCase()
  && recovery.durationMs === project.media.durationMs
);

const hasPendingAdoptionCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly adoption: NonNullable<GenerationClientReceipt["adoption"]>;
} => receipt?.adoption?.status === "adopted" && receipt.adoption.cleanupAcknowledgement === "pending";

const hasPendingCancellationCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly terminalCleanup: NonNullable<GenerationClientReceipt["terminalCleanup"]>;
} => receipt?.terminalCleanup?.action === "cancelled" && receipt.terminalCleanup.localLeaseRelease !== "released";

const hasCancellationIntent = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly cancellationRequested: NonNullable<GenerationClientReceipt["cancellationRequested"]>;
} => receipt?.terminalCleanup === undefined && receipt?.cancellationRequested?.status === "requested";

const hasPendingCancellationRecovery = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt => (
  hasCancellationIntent(receipt) || hasPendingCancellationCleanup(receipt)
);

const cancellationRecoveryNotice = (receipt: GenerationClientReceipt): string => (
  hasCancellationIntent(receipt)
    ? "CueBench is recovering a cancellation request. Private cleanup has not been confirmed yet; retry the protected request."
    : receipt.terminalCleanup?.cleanupAcknowledgement === "acknowledged"
    ? "CueBench confirmed private temporary-media cleanup, but this browser still needs to release the local caption lease. Retry recovery."
    : receipt.terminalCleanup?.cleanupAcknowledgement === "lifecycle-pending"
      ? "CueBench's private-retention deadline elapsed. The R2 lifecycle backstop remains responsible for any unsettled artifact; retry to release this browser's caption lease."
      : "CueBench accepted cancellation but still needs to finish private temporary-media cleanup. Keep this browser receipt and retry cleanup."
);

const hasPendingCleanup = (receipt: GenerationClientReceipt | null): boolean => (
  hasPendingAdoptionCleanup(receipt) || hasPendingCancellationRecovery(receipt)
);

const retainedGenerationRunIds = (project: CaptionProject): readonly string[] => (
  [...project.localEvidencePackages]
    .sort((left, right) => right.retainedAtMs - left.retainedAtMs || right.runId.localeCompare(left.runId))
    .map((entry) => entry.runId)
);

export interface GenerationStatusProps {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  /** Test seam; production refreshes opaque upload recovery from browser storage. */
  readonly uploadRecovery?: PersistedCloudUploadRecovery | null;
  readonly client?: CaptionGenerationClientPort;
}

/**
 * Visible browser surface for a Durable Workflow. It owns no media or model
 * access: its only capability is the opaque receipt persisted in Dexie before
 * it asks the same-origin Worker for stage status.
 */
export function GenerationStatus({ project, store, uploadRecovery, client: suppliedClient }: GenerationStatusProps) {
  const ownedClient = useMemo(() => new CaptionGenerationClient(), []);
  const client = suppliedClient ?? ownedClient;
  const runId = activeCaptionRunId(project);
  const [receipt, setReceipt] = useState<GenerationClientReceipt | null>(null);
  const [stage, setStage] = useState<CaptionGenerationStage>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [localRecovery, setLocalRecovery] = useState<PersistedCloudUploadRecovery | null>(() => uploadRecovery ?? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }));
  const recovery = uploadRecovery === undefined ? localRecovery : uploadRecovery;
  const hasProposed = hasProposedCaptions(project);

  useEffect(() => {
    setLocalRecovery(uploadRecovery ?? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }));
  }, [project.media.durationMs, project.media.sha256, project.projectId, uploadRecovery]);

  useEffect(() => {
    let disposed = false;
    setConfirmReplacement(false);
    const candidateRunIds = runId === null ? retainedGenerationRunIds(project) : [runId];
    if (candidateRunIds.length === 0) {
      setReceipt(null);
      return () => { disposed = true; };
    }
    void Promise.all(candidateRunIds.map((candidate) => client.loadStoredReceipt(store, project, candidate))).then((storedReceipts) => {
      if (disposed) return;
      const stored = runId === null
        ? storedReceipts.find((candidate) => hasPendingCleanup(candidate)) ?? null
        : storedReceipts[0] ?? null;
      setReceipt(stored);
      if (hasPendingAdoptionCleanup(stored)) {
        setStage("Completed");
        setNotice("Caption adoption is complete locally. CueBench still needs to confirm private temporary-media cleanup.");
      } else if (hasPendingCancellationRecovery(stored)) {
        if (hasPendingCancellationCleanup(stored)) setStage("Cancelled");
        setNotice(cancellationRecoveryNotice(stored));
      } else if (stored === null && runId !== null) {
        setNotice("Caption generation has a local target-track lease but no browser recovery receipt yet. Retry durable dispatch with the same private upload operation.");
      }
    }).catch(() => {
      if (!disposed) setError("CueBench could not read the local caption-generation recovery receipt.");
    });
    return () => { disposed = true; };
  }, [client, project, runId, store]);

  useEffect(() => {
    if (receipt === null || isTerminal(stage)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const status = await client.status(receipt);
        if (!disposed) {
          setStage(status.stage);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause, "CueBench could not read caption-generation status."));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), pollingIntervalMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, receipt, stage]);

  const refreshUploadRecovery = () => {
    if (uploadRecovery === undefined) setLocalRecovery(loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }));
  };

  const start = async () => {
    const freshRecovery = uploadRecovery ?? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs });
    if (!hasUploadAuthorization(freshRecovery, project)) {
      setError("Complete or refresh optional cloud processing before starting caption generation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await client.start({ project, store, upload: freshRecovery });
      setReceipt(started.receipt);
      setStage(started.status.stage);
      setNotice("CueBench saved the signed recovery receipt in this browser before it began polling durable workflow status.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not start a recoverable caption-generation run."));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (receipt === null) return;
    setBusy(true);
    setError(null);
    try {
      const status = await client.cancel({ project, store, receipt });
      setStage(status.stage);
      const refreshed = await client.loadStoredReceipt(store, project, receipt.runId);
      setReceipt(refreshed ?? receipt);
      setNotice(hasPendingCancellationRecovery(refreshed)
        ? cancellationRecoveryNotice(refreshed)
        : "CueBench confirmed cancellation. No partial caption result can be staged or adopted.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not cancel this caption-generation run."));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (confirmedProposedReplacement: boolean) => {
    if (receipt === null) return;
    setBusy(true);
    setError(null);
    try {
      const result: CommandResult = await client.adopt({ project, store, receipt, confirmedProposedReplacement });
      if (result.error !== undefined) {
        setError(result.error.code === "STALE_PROJECT"
          ? "The project changed before adoption. The staged caption result remains recoverable; review the current project and try again."
          : result.error.message);
        return;
      }
      setStage("Completed");
      setNotice("CueBench atomically adopted the complete evidence-backed Proposed captions in this browser project.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not adopt the staged caption evidence."));
    } finally {
      setConfirmReplacement(false);
      setBusy(false);
    }
  };

  const retryCleanup = async () => {
    if (receipt === null || !hasPendingCleanup(receipt)) return;
    setBusy(true);
    setError(null);
    try {
      if (hasPendingAdoptionCleanup(receipt)) {
        await client.retryAdoptionCleanup({ store, receipt });
        setReceipt({
          ...receipt,
          adoption: {
            ...receipt.adoption,
            cleanupAcknowledgement: "acknowledged",
          },
        });
        setNotice("CueBench confirmed private temporary-media cleanup for the adopted caption run.");
      } else if (hasPendingCancellationRecovery(receipt)) {
        await client.retryCancellationCleanup({ project, store, receipt });
        const refreshed = await client.loadStoredReceipt(store, project, receipt.runId);
        setReceipt(refreshed ?? receipt);
        if (refreshed !== null && (hasCancellationIntent(refreshed) || hasPendingCancellationCleanup(refreshed))) {
          setNotice(cancellationRecoveryNotice(refreshed));
        } else if (refreshed?.terminalCleanup?.cleanupAcknowledgement === "lifecycle-pending") {
          setNotice("CueBench released this browser's caption lease after the recorded private-retention deadline. R2 lifecycle cleanup remains pending rather than falsely acknowledged.");
        } else {
          setNotice("CueBench confirmed private temporary-media cleanup for the cancelled caption run.");
        }
      }
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not confirm private caption-generation cleanup yet. Retry this acknowledgement before starting another run."));
    } finally {
      setBusy(false);
    }
  };

  const waitingForAdoption = stage === "AwaitingAdoption";
  const pendingCleanup = hasPendingCleanup(receipt);
  const missingRecovery = runId !== null && receipt === null;
  const durableStorage = store.getSnapshot().mode !== "temporary";
  const canStart = durableStorage && !pendingCleanup && !busy && (runId === null || missingRecovery) && hasUploadAuthorization(recovery, project);
  const otherRunActive = project.activeGenerationRun !== null && project.activeGenerationRun.targetTrack !== "Captions";

  return (
    <section className="storage-disclosure generation-status" aria-label="Caption generation">
      <h2>Caption generation</h2>
      <p>Private media preparation and model calls run only inside CueBench’s durable workflow. This browser retains the signed recovery receipt and remains the canonical project store.</p>
      <p role="status" aria-live="polite">{stageLabel(stage)}</p>
      {notice === null ? null : <p role="status">{notice}</p>}
      {receipt === null ? null : <p className="generation-status__receipt">Recovery receipt retained for run {receipt.runId}.</p>}
      {!durableStorage ? <p role="status">Caption generation is unavailable in this temporary browser session because CueBench cannot retain a recoverable signed receipt or safely hold the target-track lease.</p> : null}
      {otherRunActive ? <p role="status">Another generation target currently holds the project lease.</p> : null}
      <Dialog.Root open={confirmReplacement} onOpenChange={(open) => { if (!busy) setConfirmReplacement(open); }}>
        <div className="cloud-processing-panel__actions">
          <button type="button" className="button button--outline" disabled={!canStart || otherRunActive} onClick={() => void start()}>
            {missingRecovery ? "Retry durable caption dispatch" : "Generate proposed captions"}
          </button>
          {uploadRecovery === undefined ? <button type="button" className="button button--outline" disabled={busy} onClick={refreshUploadRecovery}>Refresh cloud operation</button> : null}
          {receipt !== null && stage !== "Completed" && stage !== "Cancelled" ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void cancel()}>
            {waitingForAdoption ? "Discard staged caption result" : stage === "Failed" ? "Release failed caption lease" : "Cancel caption generation"}
          </button> : null}
          {pendingCleanup ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void retryCleanup()}>
            Retry private cleanup
          </button> : null}
          {waitingForAdoption && !hasProposed ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void adopt(false)}>Adopt staged captions</button> : null}
          {waitingForAdoption && hasProposed ? (
            <Dialog.Trigger asChild>
              <button type="button" className="button button--outline" disabled={busy}>Replace proposed captions</button>
            </Dialog.Trigger>
          ) : null}
        </div>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog generation-status__confirmation" aria-describedby="generation-replace-proposed-description">
            <Dialog.Title>Replace existing Proposed captions?</Dialog.Title>
            <Dialog.Description id="generation-replace-proposed-description">
              This will replace only existing Proposed captions with the complete staged result. Sustained captions remain untouched and no partial result can be adopted.
            </Dialog.Description>
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button" disabled={busy} autoFocus>Keep current captions</Dialog.Close>
              <button type="button" className="button" disabled={busy} onClick={() => void adopt(true)}>Confirm replacement of Proposed captions</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {runId === null && !hasUploadAuthorization(recovery, project) ? <p role="status">First complete optional cloud processing so CueBench has an authoritative, private media receipt for this exact browser media source.</p> : null}
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
