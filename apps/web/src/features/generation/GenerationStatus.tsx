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

const isRetryableFailure = (status: GenerationRunStatus): boolean => (
  status.stage === "Failed" && status.retryable
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
  projectOwnerCapability: string | null | undefined = undefined,
): recovery is PersistedCloudUploadRecovery & { readonly session: string; readonly operationReceipt: string } => (
  recovery !== null
  && typeof recovery.session === "string" && recovery.session.length > 0
  && typeof recovery.operationReceipt === "string" && recovery.operationReceipt.length > 0
  && recovery.sourceSha256.toLowerCase() === project.media.sha256.toLowerCase()
  && recovery.durationMs === project.media.durationMs
  && (projectOwnerCapability === undefined || (
    projectOwnerCapability !== null
    && recovery.projectOwnerCapability.toLowerCase() === projectOwnerCapability.toLowerCase()
  ))
);

const receiptBelongsToCurrentProjectInstance = (
  candidate: GenerationClientReceipt | null,
  projectOwnerCapability: string | null | undefined,
): boolean => (
  candidate !== null
  && (projectOwnerCapability === undefined || (
    projectOwnerCapability !== null
    && typeof candidate.projectOwnerCapability === "string"
    && candidate.projectOwnerCapability.toLowerCase() === projectOwnerCapability.toLowerCase()
  ))
);

const hasPendingAdoptionCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly adoption: NonNullable<GenerationClientReceipt["adoption"]>;
} => receipt?.adoption?.status === "adopted" && receipt.adoption.cleanupAcknowledgement === "pending";

const hasLifecyclePendingAdoptionCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly adoption: NonNullable<GenerationClientReceipt["adoption"]>;
} => receipt?.adoption?.status === "adopted" && receipt.adoption.cleanupAcknowledgement === "lifecycle-pending";

const hasLifecyclePendingExpirySettlement = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly expirySettlement: NonNullable<GenerationClientReceipt["expirySettlement"]>;
} => receipt?.expirySettlement?.state === "lifecycle-pending";

const hasPendingCancellationCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly terminalCleanup: NonNullable<GenerationClientReceipt["terminalCleanup"]>;
} => receipt?.terminalCleanup?.action === "cancelled" && (
  receipt.terminalCleanup.cleanupAcknowledgement === "pending"
  || receipt.terminalCleanup.localLeaseRelease !== "released"
);

const hasLifecyclePendingCancellationCleanup = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly terminalCleanup: NonNullable<GenerationClientReceipt["terminalCleanup"]>;
} => receipt?.terminalCleanup?.action === "cancelled" && receipt.terminalCleanup.cleanupAcknowledgement === "lifecycle-pending";

const hasCancellationIntent = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt & {
  readonly cancellationRequested: NonNullable<GenerationClientReceipt["cancellationRequested"]>;
} => receipt?.terminalCleanup === undefined && receipt?.cancellationRequested?.status === "requested";

const hasPendingCancellationRecovery = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt => (
  hasCancellationIntent(receipt) || hasPendingCancellationCleanup(receipt)
);

const hasCancellationCleanupVisibility = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt => (
  hasPendingCancellationRecovery(receipt) || hasLifecyclePendingCancellationCleanup(receipt)
);

const hasCleanupRecoveryVisibility = (receipt: GenerationClientReceipt | null): receipt is GenerationClientReceipt => (
  hasPendingAdoptionCleanup(receipt)
  || hasLifecyclePendingAdoptionCleanup(receipt)
  || hasCancellationCleanupVisibility(receipt)
  || hasLifecyclePendingExpirySettlement(receipt)
);

const cancellationRecoveryNotice = (receipt: GenerationClientReceipt): string => (
  hasCancellationIntent(receipt)
    ? "CueBench is recovering a cancellation request. Private cleanup has not been confirmed yet; retry the protected request."
    : receipt.terminalCleanup?.cleanupAcknowledgement === "pending" && receipt.terminalCleanup.localLeaseRelease === "released"
      ? "Cancellation is confirmed and captions are editable. Private temporary-media cleanup is still pending; keep this receipt and retry cleanup."
    : receipt.terminalCleanup?.cleanupAcknowledgement === "acknowledged"
    ? "CueBench confirmed private temporary-media cleanup, but this browser still needs to release the local caption lease. Retry recovery."
    : receipt.terminalCleanup?.cleanupAcknowledgement === "lifecycle-pending"
      ? "Cancellation is confirmed and captions are editable. The private-retention deadline elapsed; R2 lifecycle deletion remains pending and is not an immediate delete acknowledgement."
      : "CueBench accepted cancellation but still needs to finish private temporary-media cleanup. Keep this browser receipt and retry cleanup."
);

const adoptionLifecycleNotice = "Caption adoption is complete locally. The owner capability expired before CueBench could attest exact private-media deletion; the <=24-hour R2 lifecycle backstop remains pending and is not a delete acknowledgement.";

const expirySettlementNotice = (receipt: GenerationClientReceipt): string => (
  receipt.expirySettlement?.disposition === "cancellation-unconfirmed"
    ? "The cancellation owner capability expired before CueBench could confirm a terminal result. Captions are editable locally; private artifact deletion is lifecycle-pending and not an immediate acknowledgement."
    : "The generation owner capability expired before CueBench could confirm a terminal result. Captions are editable locally; private artifact deletion is lifecycle-pending and not an immediate acknowledgement."
);

const hasPendingCleanup = (receipt: GenerationClientReceipt | null): boolean => (
  hasPendingAdoptionCleanup(receipt) || hasPendingCancellationRecovery(receipt)
);

const retainedGenerationRunIds = (project: CaptionProject): readonly string[] => (
  [...project.localEvidencePackages]
    .sort((left, right) => right.retainedAtMs - left.retainedAtMs || right.runId.localeCompare(left.runId))
    .map((entry) => entry.runId)
);

const uniqueRunIds = (values: readonly string[]): readonly string[] => [...new Set(values)];

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
  const [failedRetryable, setFailedRetryable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [projectOwnerCapability, setProjectOwnerCapability] = useState<string | null | undefined>(() => (
    store.getCloudProjectOwnerCapability === undefined ? undefined : null
  ));
  const [localRecovery, setLocalRecovery] = useState<PersistedCloudUploadRecovery | null>(() => uploadRecovery ?? null);
  const recovery = uploadRecovery === undefined ? localRecovery : uploadRecovery;
  const hasProposed = hasProposedCaptions(project);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const owner = store.getCloudProjectOwnerCapability === undefined
        ? undefined
        : await store.getCloudProjectOwnerCapability(project.projectId);
      if (disposed) return;
      setProjectOwnerCapability(owner);
      setLocalRecovery(uploadRecovery ?? (
        owner === undefined
          ? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs })
          : owner === null
            ? null
            : loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }, undefined, owner)
      ));
    })().catch(() => {
      if (!disposed) {
        setProjectOwnerCapability(null);
        setLocalRecovery(null);
      }
    });
    return () => { disposed = true; };
  }, [project.media.durationMs, project.media.sha256, project.projectId, store, uploadRecovery]);

  useEffect(() => {
    let disposed = false;
    setConfirmReplacement(false);
    setFailedRetryable(false);
    void (async () => {
      const receiptRunIds = await store.listCaptionGenerationReceiptRunIds?.() ?? [];
      const candidateRunIds = runId === null
        ? uniqueRunIds([...retainedGenerationRunIds(project), ...receiptRunIds])
        : uniqueRunIds([runId, ...receiptRunIds]);
      if (candidateRunIds.length === 0) {
        if (!disposed) setReceipt(null);
        return;
      }
      const storedReceipts = await Promise.all(candidateRunIds.map((candidate) => client.loadStoredReceipt(store, project, candidate)));
      if (disposed) return;
      const currentInstanceReceipts = storedReceipts.filter((candidate) => (
        receiptBelongsToCurrentProjectInstance(candidate, projectOwnerCapability)
      ));
      const stored = runId === null
        ? currentInstanceReceipts.find((candidate) => hasCleanupRecoveryVisibility(candidate)) ?? null
        : currentInstanceReceipts.find((candidate) => candidate?.runId === runId) ?? null;
      setReceipt(stored);
      if (hasPendingAdoptionCleanup(stored)) {
        setStage("Completed");
        setNotice("Caption adoption is complete locally. CueBench still needs to confirm private temporary-media cleanup.");
      } else if (hasLifecyclePendingAdoptionCleanup(stored)) {
        setStage("Completed");
        setNotice(adoptionLifecycleNotice);
      } else if (hasCancellationCleanupVisibility(stored)) {
        if (hasPendingCancellationCleanup(stored)) setStage("Cancelled");
        if (hasLifecyclePendingCancellationCleanup(stored)) setStage("Cancelled");
        setNotice(cancellationRecoveryNotice(stored));
      } else if (hasLifecyclePendingExpirySettlement(stored)) {
        setStage("Failed");
        setNotice(expirySettlementNotice(stored));
      } else if (stored === null && runId !== null) {
        setNotice("Caption generation has a local target-track lease but no browser recovery receipt yet. Retry durable dispatch with the same private upload operation.");
      }
    })().catch(() => {
      if (!disposed) setError("CueBench could not read the local caption-generation recovery receipt.");
    });
    return () => { disposed = true; };
  }, [client, project, projectOwnerCapability, runId, store]);

  /** Reads current durable owner state before every cloud-authorized action. */
  const resolveCurrentProjectOwnerCapability = async (): Promise<string | null | undefined> => {
    if (store.getCloudProjectOwnerCapability === undefined) return undefined;
    const owner = await store.getCloudProjectOwnerCapability(project.projectId);
    const normalized = owner === null ? null : owner.toLowerCase();
    setProjectOwnerCapability(normalized);
    return normalized;
  };

  const currentUploadRecovery = async (): Promise<PersistedCloudUploadRecovery | null> => {
    const owner = await resolveCurrentProjectOwnerCapability();
    const restored = uploadRecovery ?? (
      owner === undefined
        ? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs })
        : owner === null
          ? null
          : loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }, undefined, owner)
    );
    if (uploadRecovery === undefined) setLocalRecovery(restored);
    return hasUploadAuthorization(restored, project, owner) ? restored : null;
  };

  const receiptStillBelongsToCurrentProjectInstance = async (candidate: GenerationClientReceipt): Promise<boolean> => {
    const owner = await resolveCurrentProjectOwnerCapability();
    return receiptBelongsToCurrentProjectInstance(candidate, owner);
  };

  useEffect(() => {
    if (receipt === null || isTerminal(stage)) return;
    let disposed = false;
    const poll = async () => {
      try {
        if (!await receiptStillBelongsToCurrentProjectInstance(receipt)) {
          if (!disposed) {
            setReceipt(null);
            setError("This caption-generation receipt belongs to an older imported browser-project instance and cannot be resumed.");
          }
          return;
        }
        const status = await client.status(receipt);
        if (!disposed) {
          setStage(status.stage);
          setFailedRetryable(isRetryableFailure(status));
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
    if (uploadRecovery === undefined) void currentUploadRecovery();
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const freshRecovery = await currentUploadRecovery();
      if (freshRecovery === null) {
        setError("Complete or refresh optional cloud processing for this current browser-project instance before starting caption generation.");
        return;
      }
      const started = await client.start({ project, store, upload: freshRecovery });
      setReceipt(started.receipt);
      setStage(started.status.stage);
      setFailedRetryable(isRetryableFailure(started.status));
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
      if (!await receiptStillBelongsToCurrentProjectInstance(receipt)) {
        setReceipt(null);
        setError("This caption-generation receipt belongs to an older imported browser-project instance and cannot be cancelled from this project.");
        return;
      }
      const status = await client.cancel({ project, store, receipt });
      setStage(status.stage);
      setFailedRetryable(false);
      const refreshed = await client.loadStoredReceipt(store, project, receipt.runId);
      setReceipt(refreshed ?? receipt);
      setNotice(hasCancellationCleanupVisibility(refreshed)
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
      if (!await receiptStillBelongsToCurrentProjectInstance(receipt)) {
        setReceipt(null);
        setError("This caption-generation receipt belongs to an older imported browser-project instance and cannot be adopted.");
        return;
      }
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

  const retryFailedGeneration = async () => {
    setBusy(true);
    setError(null);
    try {
      const freshRecovery = await currentUploadRecovery();
      if (freshRecovery === null) {
        setError("Complete or refresh optional cloud processing for this current browser-project instance before retrying caption generation.");
        return;
      }
      // `start` observes the existing Caption lease and posts the immutable
      // same run id/base. It cannot create a second provider-capable run.
      const started = await client.start({ project, store, upload: freshRecovery });
      setReceipt(started.receipt);
      setStage(started.status.stage);
      setFailedRetryable(isRetryableFailure(started.status));
      setNotice("CueBench retried the same durable caption run with its retained recovery receipt.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not retry this recoverable caption-generation failure."));
    } finally {
      setBusy(false);
    }
  };

  const retryCleanup = async () => {
    if (receipt === null || !hasPendingCleanup(receipt)) return;
    setBusy(true);
    setError(null);
    try {
      if (!await receiptStillBelongsToCurrentProjectInstance(receipt)) {
        setReceipt(null);
        setError("This caption-generation cleanup receipt belongs to an older imported browser-project instance and cannot be resumed.");
        return;
      }
      if (hasPendingAdoptionCleanup(receipt)) {
        const settled = await client.retryAdoptionCleanup({ store, receipt });
        setReceipt(settled ?? receipt);
        setNotice(settled?.adoption?.cleanupAcknowledgement === "lifecycle-pending"
          ? adoptionLifecycleNotice
          : "CueBench confirmed private temporary-media cleanup for the adopted caption run.");
      } else if (hasPendingCancellationRecovery(receipt)) {
        await client.retryCancellationCleanup({ project, store, receipt });
        const refreshed = await client.loadStoredReceipt(store, project, receipt.runId);
        setReceipt(refreshed ?? receipt);
        if (refreshed !== null && hasCancellationCleanupVisibility(refreshed)) {
          setNotice(cancellationRecoveryNotice(refreshed));
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
  const canStart = durableStorage && !pendingCleanup && !busy && (runId === null || missingRecovery) && hasUploadAuthorization(recovery, project, projectOwnerCapability);
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
          {receipt !== null && stage === "Failed" && failedRetryable ? <button type="button" className="button button--outline" disabled={busy || otherRunActive} onClick={() => void retryFailedGeneration()}>
            Retry caption generation
          </button> : null}
          {receipt !== null && stage !== "Completed" && stage !== "Cancelled" ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void cancel()}>
            {waitingForAdoption ? "Discard staged caption result" : stage === "Failed" ? failedRetryable ? "Discard retryable caption run" : "Release failed caption lease" : "Cancel caption generation"}
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
      {runId === null && !hasUploadAuthorization(recovery, project, projectOwnerCapability) ? <p role="status">First complete optional cloud processing so CueBench has an authoritative, private media receipt for this exact browser media source.</p> : null}
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
