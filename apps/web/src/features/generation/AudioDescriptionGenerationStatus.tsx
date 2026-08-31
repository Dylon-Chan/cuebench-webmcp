import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { captionEvidenceProjectionForAudioDescription, type CaptionProject } from "@cuebench/domain";
import type { GenerationRunStatus } from "@cuebench/contracts";
import { loadPersistedCloudUpload, type PersistedCloudUploadRecovery } from "../project/cloud-upload";
import {
  AudioDescriptionGenerationClient,
  type AudioDescriptionGenerationClientPort,
  type AudioDescriptionGenerationProjectStore,
  type AudioDescriptionGenerationReceipt,
} from "./ad-generation-client";

const pollingIntervalMs = 1_500;

const stageLabel = (stage: GenerationRunStatus["stage"] | undefined): string => {
  switch (stage) {
    case "Queued": return "Queued for durable visual review";
    case "PreparingMedia": return "Preparing private visual evidence";
    case "AnalyzingVisuals": return "Reviewing bounded visual evidence against retained captions";
    case "PlacingAudioDescriptions": return "Placing audio-description proposals in compatible gaps";
    case "AwaitingAdoption": return "Staged audio-description proposals await your ruling";
    case "Completed": return "Proposed audio descriptions are now in this browser project";
    case "Cancelled": return "Audio-description review was cancelled; no staged beats were adopted";
    case "Failed": return "Audio-description review stopped before it could stage a complete result";
    default: return "Audio-description visual review has not started";
  }
};

const errorMessage = (error: unknown, fallback: string): string => error instanceof Error && error.message.trim().length > 0
  ? error.message
  : fallback;

const activeRunId = (project: CaptionProject): string | null => (
  project.activeGenerationRun?.targetTrack === "AudioDescriptions" ? project.activeGenerationRun.runId : null
);

const hasReplaceableProposedAudioDescriptions = (project: CaptionProject): boolean => Object.values(project.audioDescriptions.items).some((item) => (
  item.supersededByRunId === null && item.current.state === "Proposed" && item.current.actor.type === "CueBenchAI"
));

const countReplaceableProposedAudioDescriptions = (project: CaptionProject): number => Object.values(project.audioDescriptions.items).filter((item) => (
  item.supersededByRunId === null && item.current.state === "Proposed" && item.current.actor.type === "CueBenchAI"
)).length;

const receiptBelongsToCurrentProjectInstance = (
  receipt: AudioDescriptionGenerationReceipt | null,
  owner: string | null | undefined,
): boolean => receipt !== null && (owner === undefined || (
  owner !== null && receipt.projectOwnerCapability.toLowerCase() === owner.toLowerCase()
));

const hasPendingAdoptionCleanup = (receipt: AudioDescriptionGenerationReceipt | null): receipt is AudioDescriptionGenerationReceipt & {
  readonly adoption: NonNullable<AudioDescriptionGenerationReceipt["adoption"]>;
} => receipt?.adoption?.status === "adopted" && receipt.adoption.cleanupAcknowledgement === "pending";

const hasPendingCancellationCleanup = (receipt: AudioDescriptionGenerationReceipt | null): receipt is AudioDescriptionGenerationReceipt => (
  receipt?.cancellationRequested?.status === "requested"
  || receipt?.terminalCleanup?.cleanupAcknowledgement === "pending"
  || receipt?.terminalCleanup?.localLeaseRelease === "pending"
);

const hasPendingCleanup = (receipt: AudioDescriptionGenerationReceipt | null): boolean => (
  hasPendingAdoptionCleanup(receipt) || hasPendingCancellationCleanup(receipt)
);

const hasUploadAuthorization = (
  recovery: PersistedCloudUploadRecovery | null,
  project: CaptionProject,
  owner: string | null | undefined,
): recovery is PersistedCloudUploadRecovery & { readonly session: string; readonly operationReceipt: string } => (
  recovery !== null
  && typeof recovery.session === "string" && recovery.session.length > 0
  && typeof recovery.operationReceipt === "string" && recovery.operationReceipt.length > 0
  && recovery.sourceSha256.toLowerCase() === project.media.sha256.toLowerCase()
  && recovery.durationMs === project.media.durationMs
  && (owner === undefined || (owner !== null && recovery.projectOwnerCapability.toLowerCase() === owner.toLowerCase()))
);

export interface AudioDescriptionGenerationStatusProps {
  readonly project: CaptionProject;
  readonly store: AudioDescriptionGenerationProjectStore;
  /** Test seam; production reads the opaque cloud operation from durable browser storage. */
  readonly uploadRecovery?: PersistedCloudUploadRecovery | null;
  readonly client?: AudioDescriptionGenerationClientPort;
}
/**
 * The compact visual-review card follows the approved instrumental workbench
 * composition: the evidence timeline remains primary, while this card makes
 * durable AI state, human replacement authority, and recovery visible. There
 * is deliberately no Sustain/Certify action here—those remain human-only
 * Court controls after proposals enter the docket.
 */
export function AudioDescriptionGenerationStatus({ project, store, uploadRecovery, client: suppliedClient }: AudioDescriptionGenerationStatusProps) {
  const ownedClient = useMemo(() => new AudioDescriptionGenerationClient(), []);
  const client = suppliedClient ?? ownedClient;
  const runId = activeRunId(project);
  const captionEvidence = captionEvidenceProjectionForAudioDescription(project);
  const [receipt, setReceipt] = useState<AudioDescriptionGenerationReceipt | null>(null);
  const [stage, setStage] = useState<GenerationRunStatus["stage"] | undefined>(undefined);
  const [owner, setOwner] = useState<string | null | undefined>(() => store.getCloudProjectOwnerCapability === undefined ? undefined : null);
  const [localRecovery, setLocalRecovery] = useState<PersistedCloudUploadRecovery | null>(uploadRecovery ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const recovery = uploadRecovery === undefined ? localRecovery : uploadRecovery;
  const replacementCount = countReplaceableProposedAudioDescriptions(project);
  const hasReplacement = hasReplaceableProposedAudioDescriptions(project);
  const durableStorage = store.getSnapshot().mode === "durable";
  const otherRunActive = project.activeGenerationRun !== null && project.activeGenerationRun.targetTrack !== "AudioDescriptions";
  const missingReceipt = runId !== null && receipt === null;

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const currentOwner = store.getCloudProjectOwnerCapability === undefined
        ? undefined
        : await store.getCloudProjectOwnerCapability(project.projectId);
      if (disposed) return;
      setOwner(currentOwner === null || currentOwner === undefined ? currentOwner : currentOwner.toLowerCase());
      if (uploadRecovery !== undefined) return;
      const restored = currentOwner === undefined
        ? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs })
        : currentOwner === null
          ? null
          : loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }, undefined, currentOwner);
      if (!disposed) setLocalRecovery(restored);
    })().catch(() => {
      if (!disposed) {
        setOwner(null);
        setLocalRecovery(null);
      }
    });
    return () => { disposed = true; };
  }, [project.media.durationMs, project.media.sha256, project.projectId, store, uploadRecovery]);

  useEffect(() => {
    let disposed = false;
    setConfirmReplacement(false);
    void (async () => {
      const candidateIds = runId === null
        ? await store.listAudioDescriptionGenerationReceiptRunIds?.() ?? []
        : [runId];
      const candidates = await Promise.all([...new Set(candidateIds)].map((candidate) => client.loadStoredReceipt(store, project, candidate)));
      if (disposed) return;
      const loaded = runId === null
        ? candidates.find((candidate) => candidate?.adoption?.cleanupAcknowledgement === "pending" || candidate?.terminalCleanup?.cleanupAcknowledgement === "pending") ?? null
        : candidates.find((candidate) => candidate?.runId === runId) ?? null;
      if (!receiptBelongsToCurrentProjectInstance(loaded, owner)) {
        setReceipt(null);
        if (loaded !== null) setError("This audio-description recovery receipt belongs to an older imported browser-project instance and cannot be resumed.");
        return;
      }
      setReceipt(loaded);
      if (loaded?.adoption?.status === "adopted") {
        setStage("Completed");
        setNotice(loaded.adoption.cleanupAcknowledgement === "acknowledged"
          ? "CueBench confirmed private visual-review cleanup after local adoption."
          : "Audio-description proposals were adopted locally; private visual-review cleanup remains recoverable.");
      } else if (loaded?.terminalCleanup?.action === "cancelled") {
        setStage("Cancelled");
        setNotice("Audio-description review was cancelled. Private visual-review cleanup remains visible until CueBench confirms it.");
      } else if (loaded === null && runId !== null) {
        setNotice("This project has an AD lease but no browser recovery receipt yet. Retry the same durable dispatch; CueBench will not create a second run.");
      }
    })().catch(() => { if (!disposed) setError("CueBench could not read the local audio-description recovery receipt."); });
    return () => { disposed = true; };
  }, [client, owner, project, runId, store]);

  useEffect(() => {
    if (receipt === null || stage === "Cancelled" || stage === "Completed" || stage === "Failed") return;
    let disposed = false;
    const poll = async () => {
      try {
        if (!receiptBelongsToCurrentProjectInstance(receipt, owner)) {
          if (!disposed) setError("This audio-description recovery receipt belongs to an older browser-project instance.");
          return;
        }
        const status = await client.status(receipt);
        if (!disposed) {
          setStage(status.stage);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause, "CueBench could not read audio-description generation status."));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), pollingIntervalMs);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, owner, receipt, stage]);

  const currentUploadRecovery = async (): Promise<PersistedCloudUploadRecovery | null> => {
    const currentOwner = store.getCloudProjectOwnerCapability === undefined
      ? undefined
      : await store.getCloudProjectOwnerCapability(project.projectId);
    const normalizedOwner = currentOwner === null || currentOwner === undefined ? currentOwner : currentOwner.toLowerCase();
    setOwner(normalizedOwner);
    const restored = uploadRecovery ?? (
      normalizedOwner === undefined
        ? loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs })
        : normalizedOwner === null
          ? null
          : loadPersistedCloudUpload(project.projectId, { sha256: project.media.sha256, durationMs: project.media.durationMs }, undefined, normalizedOwner)
    );
    if (uploadRecovery === undefined) setLocalRecovery(restored);
    return hasUploadAuthorization(restored, project, normalizedOwner) ? restored : null;
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const freshRecovery = await currentUploadRecovery();
      if (freshRecovery === null) {
        setError("Complete or refresh optional cloud processing for this current browser-project instance before visual review.");
        return;
      }
      const started = await client.start({ project, store, upload: freshRecovery });
      setReceipt(started.receipt);
      setStage(started.status.stage);
      setNotice("CueBench saved the signed AD recovery receipt in this browser before it began polling durable visual review.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not start a recoverable audio-description review."));
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
      setReceipt(await client.loadStoredReceipt(store, project, receipt.runId) ?? receipt);
      setNotice("CueBench confirmed cancellation. No partial AI audio-description proposal can be adopted.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not cancel this audio-description review."));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async () => {
    if (receipt === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.adopt({ project, store, receipt, confirmedProposedReplacement: hasReplacement });
      if (result.error !== undefined) {
        setError(result.error.code === "STALE_PROJECT"
          ? "The retained caption evidence or AD docket changed before adoption. Review the current project and try again."
          : result.error.message);
        return;
      }
      setStage("Completed");
      setNotice("CueBench atomically adopted evidence-bound Proposed audio descriptions. Sustain or amend them in the human Court review flow.");
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not adopt the staged audio-description proposals."));
    } finally {
      setConfirmReplacement(false);
      setBusy(false);
    }
  };

  const retryCleanup = async () => {
    if (receipt === null) return;
    setBusy(true);
    setError(null);
    try {
      if (hasPendingAdoptionCleanup(receipt)) {
        const settled = await client.retryAdoptionCleanup({ store, receipt });
        setReceipt(settled);
        setNotice(settled.adoption?.cleanupAcknowledgement === "acknowledged"
          ? "CueBench confirmed private visual-review cleanup."
          : "The owner capability expired; R2 lifecycle cleanup remains pending and is not an immediate deletion acknowledgement.");
      } else {
        await client.retryCancellationCleanup({ project, store, receipt });
        setReceipt(await client.loadStoredReceipt(store, project, receipt.runId) ?? receipt);
      }
    } catch (cause) {
      setError(errorMessage(cause, "CueBench could not confirm private visual-review cleanup yet. Retry this protected acknowledgement."));
    } finally {
      setBusy(false);
    }
  };

  const canStart = durableStorage && captionEvidence !== null && !busy && !otherRunActive && !hasPendingCleanup(receipt) && (runId === null || missingReceipt) && hasUploadAuthorization(recovery, project, owner);
  const waitingForAdoption = stage === "AwaitingAdoption";

  return (
    <section className="storage-disclosure generation-status ad-generation-status" aria-label="Audio-description generation">
      <div className="ad-generation-status__heading">
        <p className="ad-generation-status__eyebrow">Visual review</p>
        <h2>Audio descriptions</h2>
      </div>
      <p>Use the same hosted evidence bay to propose descriptions in speech-safe gaps. CueBench sends the workflow only the bounded captions and frame evidence it needs; this card never certifies a beat.</p>
      <p role="status" aria-live="polite">{stageLabel(stage)}</p>
      {notice === null ? null : <p role="status">{notice}</p>}
      {receipt === null ? null : <p className="generation-status__receipt">Private AD recovery receipt retained for run {receipt.runId}.</p>}
      {!durableStorage ? <p role="status">Audio-description generation is unavailable in this temporary browser session because CueBench cannot retain a recoverable signed receipt.</p> : null}
      {captionEvidence === null ? <p role="status">First generate and retain evidence-bound captions. AD review is deliberately blocked without a bounded caption-evidence base.</p> : null}
      {otherRunActive ? <p role="status">Another generation target currently holds CueBench’s one-project lease.</p> : null}
      <Dialog.Root open={confirmReplacement} onOpenChange={(open) => { if (!busy) setConfirmReplacement(open); }}>
        <div className="cloud-processing-panel__actions">
          <button type="button" className="button button--outline" disabled={!canStart} onClick={() => void start()}>
            {missingReceipt ? "Recover AD review dispatch" : "Propose audio descriptions"}
          </button>
          {uploadRecovery === undefined ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void currentUploadRecovery()}>Refresh cloud operation</button> : null}
          {receipt !== null && stage !== "Completed" && stage !== "Cancelled" ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void cancel()}>
            {waitingForAdoption ? "Discard staged AD result" : "Cancel AD review"}
          </button> : null}
          {hasPendingCleanup(receipt) ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void retryCleanup()}>Retry private cleanup</button> : null}
          {waitingForAdoption && !hasReplacement ? <button type="button" className="button button--outline" disabled={busy} onClick={() => void adopt()}>Adopt proposed beats</button> : null}
          {waitingForAdoption && hasReplacement ? <Dialog.Trigger asChild><button type="button" className="button button--outline" disabled={busy}>Review replacement</button></Dialog.Trigger> : null}
        </div>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog generation-status__confirmation" aria-describedby="ad-generation-replace-proposed-description">
            <Dialog.Title>Replace {replacementCount} earlier AI proposal{replacementCount === 1 ? "" : "s"}?</Dialog.Title>
            <Dialog.Description id="ad-generation-replace-proposed-description">
              This human ruling replaces only CueBench-AI Proposed audio-description beats. Your manual work and every Sustained beat remain untouched. The new beats remain Proposed and must be reviewed in the Court.
            </Dialog.Description>
            <div className="storage-dialog__actions">
              <Dialog.Close className="button button--outline" type="button" disabled={busy} autoFocus>Keep current beats</Dialog.Close>
              <button type="button" className="button" disabled={busy} onClick={() => void adopt()}>Confirm replacement of AI proposals</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {runId === null && !hasUploadAuthorization(recovery, project, owner) ? <p role="status">First complete optional cloud processing so CueBench can bind visual review to this exact private media source.</p> : null}
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
