import {
  StagedAudioDescriptionGenerationResultSchema,
  StagedGenerationResultSchema,
} from "@cuebench/contracts";
import { applyCommand, domainError, type CaptionProject, type CommandResult, type DomainCommand } from "@cuebench/domain";
import {
  appendAcceptedProjectInTransaction,
  CueBenchDatabase,
  loadProjectInTransaction,
  runReceiptKey,
  StorageStaleWriteError,
  validateRunReceiptRow,
  type WriteProjectOptions,
} from "./database";

export class PersistentProjectNotFoundError extends Error {
  public constructor(projectId: string) {
    super(`CueBench project ${projectId} does not exist in local storage.`);
    this.name = "PersistentProjectNotFoundError";
  }
}

/**
 * Apply the pure domain reducer against the latest persisted project and, if
 * accepted, append immutable rows and atomically advance current projections
 * in the same IndexedDB transaction. Expected revisions are therefore a real
 * compare-and-swap boundary rather than a UI-only convention.
 */
export const executePersistentCommand = async (
  db: CueBenchDatabase,
  projectId: string,
  command: DomainCommand,
  options: WriteProjectOptions = {},
): Promise<CommandResult> => {
  let projectReadForCas: CaptionProject | undefined;
  try {
    return await db.transaction(
      "rw",
      [
        db.projectHeaders,
        db.items,
        db.revisions,
        db.findings,
        db.evidence,
        db.courtRecord,
        db.certifications,
        db.settings,
      ],
      async () => {
        const project = await loadProjectInTransaction(db, projectId);
        if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
        projectReadForCas = project;
        if (options.authorizeCommand !== undefined && !(await options.authorizeCommand())) {
          return {
            project,
            events: [],
            error: domainError("STALE_PROJECT", "The project instance changed in another browser context."),
          };
        }
        const result = applyCommand(project, command);
        if (result.error !== undefined) return result;
        await appendAcceptedProjectInTransaction(db, project, result.project, options);
        return result;
      },
    );
  } catch (error) {
    /** The rejected transaction has rolled back all append attempts before we expose STALE_PROJECT. */
    if (error instanceof StorageStaleWriteError && projectReadForCas !== undefined) {
      return {
        project: projectReadForCas,
        events: [],
        error: domainError("STALE_PROJECT", "The project changed in another browser context."),
      };
    }
    throw error;
  }
};

/**
 * The final caption adoption is intentionally a separate, explicit helper:
 * it includes the signed recovery receipt in the same IndexedDB transaction
 * as the lease/base-state domain transition. The canonical Local Evidence
 * Package is persisted on the project itself; the receipt retains only
 * recovery/capability metadata after adoption.
 */
export const adoptStagedCaptionGenerationResult = async (
  db: CueBenchDatabase,
  projectId: string,
  command: Extract<DomainCommand, { readonly type: "AdoptCaptionGenerationResult" }>,
  options: WriteProjectOptions = {},
): Promise<CommandResult> => {
  let projectReadForCas: CaptionProject | undefined;
  try {
    return await db.transaction(
      "rw",
      [
        db.projectHeaders,
        db.items,
        db.revisions,
        db.findings,
        db.evidence,
        db.courtRecord,
        db.certifications,
        db.runReceipts,
        db.settings,
      ],
      async () => {
        const project = await loadProjectInTransaction(db, projectId);
        if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
        projectReadForCas = project;
        if (options.authorizeCommand !== undefined && !(await options.authorizeCommand())) {
          return {
            project,
            events: [],
            error: domainError("STALE_PROJECT", "The project instance changed in another browser context."),
          };
        }
        const receipt = await db.runReceipts.get(runReceiptKey(projectId, command.runId));
        if (receipt === undefined) {
          return {
            project,
            events: [],
            error: domainError("RECOVERY_ARTIFACT_EXPIRED", "CueBench cannot adopt a run whose signed recovery receipt was not durably saved."),
          };
        }
        const payload = receipt.receipt.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return {
            project,
            events: [],
            error: domainError("RECOVERY_ARTIFACT_EXPIRED", "CueBench cannot safely attach staged evidence to this recovery receipt."),
          };
        }
        const parsedResult = StagedGenerationResultSchema.safeParse(command.result);
        if (!parsedResult.success) {
          return {
            project,
            events: [],
            error: domainError("INVALID_ARGUMENT", "CueBench cannot adopt an invalid staged caption result."),
          };
        }
        const result = applyCommand(project, { ...command, result: parsedResult.data });
        if (result.error !== undefined) return result;
        await appendAcceptedProjectInTransaction(db, project, result.project, options);
        await db.runReceipts.put(validateRunReceiptRow({
          ...receipt,
          receipt: {
            version: 1,
            payload: {
              ...payload,
              adoption: {
                status: "adopted",
                adoptedProjectRevision: result.project.projectRevision,
                localEvidencePackageId: `generation-${command.runId}`,
                // Acknowledgement occurs only after this transaction. Keep a
                // durable retry marker so an outage cannot abandon immediate
                // cloud cleanup once the target-track lease has cleared.
                cleanupAcknowledgement: "pending",
              },
            },
          },
          savedAtMs: Date.now(),
        }));
        return result;
      },
    );
  } catch (error) {
    if (error instanceof StorageStaleWriteError && projectReadForCas !== undefined) {
      return {
        project: projectReadForCas,
        events: [],
        error: domainError("STALE_PROJECT", "The project changed in another browser context. The staged result remains recoverable."),
      };
    }
    throw error;
  }
};

/**
 * Mirrors caption adoption, but deliberately keeps the AD receipt/result
 * contract separate. The browser cannot split the target-aware expected
 * revision CAS from the durable acknowledgement marker.
 */
export const adoptStagedAudioDescriptionGenerationResult = async (
  db: CueBenchDatabase,
  projectId: string,
  command: Extract<DomainCommand, { readonly type: "AdoptAudioDescriptionGenerationResult" }>,
  options: WriteProjectOptions = {},
): Promise<CommandResult> => {
  let projectReadForCas: CaptionProject | undefined;
  try {
    return await db.transaction(
      "rw",
      [
        db.projectHeaders,
        db.items,
        db.revisions,
        db.findings,
        db.evidence,
        db.courtRecord,
        db.certifications,
        db.runReceipts,
        db.settings,
      ],
      async () => {
        const project = await loadProjectInTransaction(db, projectId);
        if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
        projectReadForCas = project;
        if (options.authorizeCommand !== undefined && !(await options.authorizeCommand())) {
          return {
            project,
            events: [],
            error: domainError("STALE_PROJECT", "The project instance changed in another browser context."),
          };
        }
        const receipt = await db.runReceipts.get(runReceiptKey(projectId, command.runId));
        if (receipt === undefined) {
          return {
            project,
            events: [],
            error: domainError("RECOVERY_ARTIFACT_EXPIRED", "CueBench cannot adopt an audio-description run whose signed recovery receipt was not durably saved."),
          };
        }
        const payload = receipt.receipt.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return {
            project,
            events: [],
            error: domainError("RECOVERY_ARTIFACT_EXPIRED", "CueBench cannot safely attach staged visual evidence to this recovery receipt."),
          };
        }
        const parsedResult = StagedAudioDescriptionGenerationResultSchema.safeParse(command.result);
        if (!parsedResult.success) {
          return {
            project,
            events: [],
            error: domainError("INVALID_ARGUMENT", "CueBench cannot adopt an invalid staged audio-description result."),
          };
        }
        const result = applyCommand(project, { ...command, result: parsedResult.data });
        if (result.error !== undefined) return result;
        await appendAcceptedProjectInTransaction(db, project, result.project, options);
        await db.runReceipts.put(validateRunReceiptRow({
          ...receipt,
          receipt: {
            version: 1,
            payload: {
              ...payload,
              adoption: {
                status: "adopted",
                adoptedProjectRevision: result.project.projectRevision,
                localEvidencePackageId: `audio-description-${command.runId}`,
                cleanupAcknowledgement: "pending",
              },
            },
          },
          savedAtMs: Date.now(),
        }));
        return result;
      },
    );
  } catch (error) {
    if (error instanceof StorageStaleWriteError && projectReadForCas !== undefined) {
      return {
        project: projectReadForCas,
        events: [],
        error: domainError("STALE_PROJECT", "The project changed in another browser context. The staged audio-description result remains recoverable."),
      };
    }
    throw error;
  }
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

/**
 * Atomically releases an elapsed AD target lease and persists a truthful
 * lifecycle-pending receipt tombstone. The Worker capability is expired, so
 * this deliberately never claims remote cleanup completed.
 */
export const settleExpiredAudioDescriptionGenerationReceipt = async (
  db: CueBenchDatabase,
  projectId: string,
  runId: string,
  options: WriteProjectOptions = {},
): Promise<{ readonly project: CaptionProject; readonly receipt: unknown | null }> => {
  return db.transaction(
    "rw",
    [
      db.projectHeaders,
      db.items,
      db.revisions,
      db.findings,
      db.evidence,
      db.courtRecord,
      db.certifications,
      db.runReceipts,
      db.settings,
    ],
    async () => {
      const project = await loadProjectInTransaction(db, projectId);
      if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
      if (options.authorizeCommand !== undefined && !(await options.authorizeCommand())) {
        throw new StorageStaleWriteError(projectId);
      }
      const row = await db.runReceipts.get(runReceiptKey(projectId, runId));
      if (row === undefined) return { project, receipt: null };
      const payload = asRecord(row.receipt.payload);
      if (payload === null) return { project, receipt: null };

      let settledProject = project;
      let localLeaseRelease: "pending" | "released" = project.activeGenerationRun?.runId === runId ? "pending" : "released";
      if (project.activeGenerationRun?.runId === runId && project.activeGenerationRun.targetTrack === "AudioDescriptions") {
        const released = applyCommand(project, {
          type: "ReleaseGenerationRun",
          actor: { type: "System", id: "expiry-settlement" },
          runId,
          expectedProjectRevision: project.projectRevision,
        });
        if (released.error === undefined) {
          await appendAcceptedProjectInTransaction(db, project, released.project, options);
          settledProject = released.project;
          localLeaseRelease = "released";
        }
      }

      const adoption = asRecord(payload.adoption);
      const terminal = asRecord(payload.terminalCleanup);
      const cancellation = asRecord(payload.cancellationRequested);
      const settledPayload: Readonly<Record<string, unknown>> = adoption?.status === "adopted" && adoption.cleanupAcknowledgement === "pending"
        ? { ...payload, adoption: { ...adoption, cleanupAcknowledgement: "lifecycle-pending" } }
        : terminal?.action === "cancelled"
          ? {
            ...payload,
            terminalCleanup: {
              ...terminal,
              cleanupAcknowledgement: "lifecycle-pending",
              localLeaseRelease,
            },
          }
          : {
            ...payload,
            expirySettlement: {
              state: "lifecycle-pending",
              disposition: cancellation?.status === "requested" ? "cancellation-unconfirmed" : "receipt-expired",
              localLeaseRelease,
            },
          };
      await db.runReceipts.put(validateRunReceiptRow({
        ...row,
        receipt: { version: 1, payload: settledPayload },
        savedAtMs: Date.now(),
      }));
      return { project: settledProject, receipt: settledPayload };
    },
  );
};
