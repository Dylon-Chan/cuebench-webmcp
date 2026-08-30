import { StagedGenerationResultSchema } from "@cuebench/contracts";
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
      ],
      async () => {
        const project = await loadProjectInTransaction(db, projectId);
        if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
        projectReadForCas = project;
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
      ],
      async () => {
        const project = await loadProjectInTransaction(db, projectId);
        if (project === undefined) throw new PersistentProjectNotFoundError(projectId);
        projectReadForCas = project;
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
