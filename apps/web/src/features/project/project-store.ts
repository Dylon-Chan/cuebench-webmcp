import { createProject, type CaptionProject } from "@cuebench/domain";
import {
  CueBenchDatabase,
  initializeProject,
  loadProject,
  loadSetting,
  saveSetting,
} from "@cuebench/storage";
import {
  ObjectUrlLease,
  ingestLocalMedia,
  inspectLocalMedia,
  probeVideoDuration,
  type MediaDurationProbe,
} from "./local-media";

export type ProjectMode = "durable" | "temporary";
export type ProjectRoute = "start" | "temporary-choice" | "workbench";

export interface BrowserStorageManager {
  estimate: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  persist: () => Promise<boolean>;
}

export interface PendingUpload {
  readonly file: File;
  readonly durationMs: number;
}

export interface ProjectStoreSnapshot {
  readonly route: ProjectRoute;
  readonly project: CaptionProject | null;
  readonly mode: ProjectMode | null;
  readonly sourceObjectUrl: string | null;
  readonly pendingUpload: PendingUpload | null;
  readonly error: string | null;
}

export interface ProjectStoreOptions {
  readonly database?: CueBenchDatabase;
  readonly browserStorage?: BrowserStorageManager | null;
  readonly mediaDurationProbe?: MediaDurationProbe;
  readonly objectUrlLease?: ObjectUrlLease;
  readonly createId?: () => string;
}

const metadataReserveBytes = 16 * 1024 * 1024;
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const lastDurableProjectKey = "last-durable-project";

const emptySnapshot = (): ProjectStoreSnapshot => ({
  route: "start",
  project: null,
  mode: null,
  sourceObjectUrl: null,
  pendingUpload: null,
  error: null,
});

const browserStorageManager = (): BrowserStorageManager | null => {
  const storage = globalThis.navigator?.storage;
  if (storage?.estimate === undefined || storage.persist === undefined) return null;
  return {
    estimate: () => storage.estimate(),
    persist: () => storage.persist(),
  };
};

const readMode = (value: unknown): ProjectMode | null => {
  if (typeof value !== "object" || value === null || !("mode" in value)) return null;
  const mode = value.mode;
  return mode === "durable" || mode === "temporary" ? mode : null;
};

const readProjectId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return null;
  return typeof value.projectId === "string" && value.projectId.trim().length > 0 ? value.projectId : null;
};

/** Browser-canonical project lifecycle, including truthful temporary-session fallback. */
export class ProjectStore {
  private readonly database: CueBenchDatabase;
  private readonly storage: BrowserStorageManager | null;
  private readonly mediaDurationProbe: MediaDurationProbe;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();

  public constructor(options: ProjectStoreOptions = {}) {
    this.database = options.database ?? new CueBenchDatabase();
    this.storage = options.browserStorage === undefined ? browserStorageManager() : options.browserStorage;
    this.mediaDurationProbe = options.mediaDurationProbe ?? probeVideoDuration;
    this.objectUrlLease = options.objectUrlLease ?? null;
    this.triedObjectUrlLease = options.objectUrlLease !== undefined;
    this.createId = options.createId ?? defaultCreateId;
  }

  public getSnapshot = (): ProjectStoreSnapshot => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public async openSample(): Promise<void> {
    const projectId = "sample-gibbs-free-energy";
    const existing = await loadProject(this.database, projectId);
    const project = existing ?? createProject({
      projectId,
      title: "Gibbs Free Energy — Lesson 4",
      media: {
        sourceId: "sample-gibbs-free-energy-video",
        sha256: "a".repeat(64),
        durationMs: 90_000,
        relinkState: "Linked",
      },
    });
    if (existing === undefined) await initializeProject(this.database, project);
    await this.persistMode(projectId, "durable");
    await this.rememberDurableProject(projectId);
    this.setSnapshot({ route: "workbench", project, mode: "durable", sourceObjectUrl: null, pendingUpload: null, error: null });
  }

  public async restoreLastDurableProject(): Promise<void> {
    try {
      const lastProject = await loadSetting(this.database, lastDurableProjectKey);
      const projectId = lastProject === undefined ? null : readProjectId(lastProject.value);
      if (projectId === null) return;
      const [project, mode] = await Promise.all([
        loadProject(this.database, projectId),
        loadProjectMode(this.database, projectId),
      ]);
      if (project === undefined || mode !== "durable") return;
      this.setSnapshot({ route: "workbench", project, mode, sourceObjectUrl: null, pendingUpload: null, error: null });
    } catch {
      // A closed or cleared browser database simply leaves the start route visible.
    }
  }

  public async chooseFile(file: File): Promise<void> {
    try {
      const inspected = await inspectLocalMedia(file, this.mediaDurationProbe);
      if (await this.hasDurableStorage(file.size)) {
        await this.openLocalFile({ file, durationMs: inspected.durationMs }, "durable");
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        route: "temporary-choice",
        pendingUpload: { file, durationMs: inspected.durationMs },
        error: null,
      });
    } catch (error) {
      this.setSnapshot({ ...emptySnapshot(), error: error instanceof Error ? error.message : "CueBench could not open this video." });
    }
  }

  public async continueTemporarily(): Promise<void> {
    const pendingUpload = this.snapshot.pendingUpload;
    if (pendingUpload === null) return;
    await this.openLocalFile(pendingUpload, "temporary");
  }

  public cancelPendingUpload(): void {
    this.setSnapshot({ ...emptySnapshot() });
  }

  public dispose(): void {
    this.objectUrlLease?.revoke();
  }

  private async hasDurableStorage(sourceBytes: number): Promise<boolean> {
    if (this.storage === null) return false;
    try {
      const [estimate, persisted] = await Promise.all([this.storage.estimate(), this.storage.persist()]);
      const quota = estimate.quota;
      const usage = estimate.usage ?? 0;
      return persisted && quota !== undefined && quota - usage >= sourceBytes + metadataReserveBytes;
    } catch {
      return false;
    }
  }

  private async openLocalFile(pendingUpload: PendingUpload, mode: ProjectMode): Promise<void> {
    try {
      const projectId = `local-${this.createId()}`;
      const sourceId = `source-${this.createId()}`;
      const objectUrlLease = this.activeObjectUrlLease();
      const media = await ingestLocalMedia({
        database: this.database,
        projectId,
        sourceId,
        file: pendingUpload.file,
        probeDuration: async () => pendingUpload.durationMs,
        ...(objectUrlLease === undefined ? {} : { urlLease: objectUrlLease }),
      });
      const project = createProject({
        projectId,
        title: pendingUpload.file.name,
        media: {
          sourceId: media.sourceId,
          sha256: media.sha256,
          durationMs: media.durationMs,
          relinkState: mode === "temporary" ? "TemporarySession" : "Linked",
        },
      });
      await initializeProject(this.database, project);
      await this.persistMode(projectId, mode);
      if (mode === "durable") await this.rememberDurableProject(projectId);
      this.setSnapshot({ route: "workbench", project, mode, sourceObjectUrl: media.objectUrl, pendingUpload: null, error: null });
    } catch (error) {
      this.setSnapshot({ ...emptySnapshot(), error: error instanceof Error ? error.message : "CueBench could not save this video." });
    }
  }

  private async persistMode(projectId: string, mode: ProjectMode): Promise<void> {
    await saveSetting(this.database, projectModeKey(projectId), { mode });
  }

  private async rememberDurableProject(projectId: string): Promise<void> {
    await saveSetting(this.database, lastDurableProjectKey, { projectId });
  }

  private activeObjectUrlLease(): ObjectUrlLease | undefined {
    if (this.objectUrlLease !== null) return this.objectUrlLease;
    if (this.triedObjectUrlLease) return undefined;
    this.triedObjectUrlLease = true;
    try {
      this.objectUrlLease = new ObjectUrlLease();
      return this.objectUrlLease;
    } catch {
      return undefined;
    }
  }

  private setSnapshot(nextSnapshot: ProjectStoreSnapshot): void {
    this.snapshot = nextSnapshot;
    for (const listener of this.listeners) listener();
  }
}

export const loadProjectMode = async (database: CueBenchDatabase, projectId: string): Promise<ProjectMode | null> => {
  const setting = await loadSetting(database, projectModeKey(projectId));
  return setting === undefined ? null : readMode(setting.value);
};
