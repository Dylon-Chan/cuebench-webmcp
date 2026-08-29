import { applyCommand, type CommandResult, type DomainCommand } from "@cuebench/domain";
import {
  CueBenchDatabase,
  loadProjectInTransaction,
  type WriteProjectOptions,
  writeProjectInTransaction,
} from "./database";

export class PersistentProjectNotFoundError extends Error {
  public constructor(projectId: string) {
    super(`CueBench project ${projectId} does not exist in local storage.`);
    this.name = "PersistentProjectNotFoundError";
  }
}

/**
 * Apply the pure domain reducer against the latest persisted project and, if
 * accepted, replace every normalized projection in the same IndexedDB
 * transaction. Expected revisions are therefore a real compare-and-swap
 * boundary rather than a UI-only convention.
 */
export const executePersistentCommand = async (
  db: CueBenchDatabase,
  projectId: string,
  command: DomainCommand,
  options: WriteProjectOptions = {},
): Promise<CommandResult> => db.transaction(
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
    const result = applyCommand(project, command);
    if (result.error !== undefined) return result;
    await writeProjectInTransaction(db, result.project, options);
    return result;
  },
);
