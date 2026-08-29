import { applyCommand, domainError, type CaptionProject, type CommandResult, type DomainCommand } from "@cuebench/domain";
import {
  appendAcceptedProjectInTransaction,
  CueBenchDatabase,
  loadProjectInTransaction,
  StorageStaleWriteError,
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
