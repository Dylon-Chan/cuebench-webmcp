import { createProject, type CaptionProject } from "@cuebench/domain";
import {
  CueBenchDatabase,
  initializeProject,
  loadProject,
  loadSetting,
  loadSourceMedia,
  saveSetting,
} from "@cuebench/storage";
import {
  BUNDLED_SAMPLE_DURATION_MS,
  createBundledSampleFile,
} from "./bundled-sample";
import {
  LocalMediaError,
  ObjectUrlLease,
  ingestLocalMedia,
  inspectLocalMedia,
  probeVideoDuration,
  type MediaDurationProbe,
} from "./local-media";

export type ProjectMode = "durable" | "temporary";
export type ProjectRoute = "start" | "temporary-choice" | "workbench";
export type ProjectActivity = "hydrating" | "preparing" | "saving" | null;

export interface BrowserStorageManager {
  estimate: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  persist: () => Promise<boolean>;
}

export interface SessionStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface PendingUpload {
  readonly file: File;
  readonly durationMs: number;
  readonly projectId: string;
  readonly sourceId: string;
  readonly title: string;
}

export interface ProjectStoreSnapshot {
  readonly route: ProjectRoute;
  readonly project: CaptionProject | null;
  readonly mode: ProjectMode | null;
  /** Present only after IndexedDB byte verification and a live Object URL allocation. */
  readonly sourceObjectUrl: string | null;
  readonly pendingUpload: PendingUpload | null;
  readonly activity: ProjectActivity;
  readonly error: string | null;
}

export interface ProjectStoreOptions {
  readonly database?: CueBenchDatabase;
  readonly browserStorage?: BrowserStorageManager | null;
  readonly mediaDurationProbe?: MediaDurationProbe;
  readonly objectUrlLease?: ObjectUrlLease;
  readonly createId?: () => string;
  readonly sessionStorage?: SessionStorageLike | null;
  readonly bundledSampleLoader?: () => File | Promise<File>;
  /** Test seam for proving that a stale restore cannot replace a newer operation. */
  readonly beforeRestoreLoad?: () => Promise<void>;
}

const metadataReserveBytes = 16 * 1024 * 1024;
const sampleProjectId = "sample-gibbs-free-energy";
const sampleSourceId = "source-bundled-video-fixture";
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const lastDurableProjectKey = "last-durable-project";
const temporaryProjectSessionKey = "cuebench:temporary-project";

const emptySnapshot = (): ProjectStoreSnapshot => ({
  route: "start",
  project: null,
  mode: null,
  sourceObjectUrl: null,
  pendingUpload: null,
  activity: null,
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

const browserSessionStorage = (): SessionStorageLike | null => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
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

const userFacingError = (error: unknown, fallback: string): string => error instanceof Error && error.message.length > 0
  ? error.message
  : fallback;

const isQuotaExceeded = (error: unknown): boolean => error instanceof Error && error.name === "QuotaExceededError";

const titleForFile = (file: File): string => file.name.trim().length > 0 ? file.name : "Local video";

/** Browser-canonical project lifecycle, including truthful temporary-session fallback. */
export class ProjectStore {
  private readonly database: CueBenchDatabase;
  private readonly storage: BrowserStorageManager | null;
  private readonly mediaDurationProbe: MediaDurationProbe;
  private readonly sessionStorage: SessionStorageLike | null;
  private readonly bundledSampleLoader: () => File | Promise<File>;
  private readonly beforeRestoreLoad: (() => Promise<void>) | undefined;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();
  private operationEpoch = 0;

  public constructor(options: ProjectStoreOptions = {}) {
    this.database = options.database ?? new CueBenchDatabase();
    this.storage = options.browserStorage === undefined ? browserStorageManager() : options.browserStorage;
    this.mediaDurationProbe = options.mediaDurationProbe ?? probeVideoDuration;
    this.sessionStorage = options.sessionStorage === undefined ? browserSessionStorage() : options.sessionStorage;
    this.objectUrlLease = options.objectUrlLease ?? null;
    this.triedObjectUrlLease = options.objectUrlLease !== undefined;
    this.createId = options.createId ?? defaultCreateId;
    this.bundledSampleLoader = options.bundledSampleLoader ?? createBundledSampleFile;
    this.beforeRestoreLoad = options.beforeRestoreLoad;
  }

  public getSnapshot = (): ProjectStoreSnapshot => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens the real bundled Blob through the same inspected persistence path as an upload. */
  public async openSample(): Promise<void> {
    const epoch = this.beginUserOperation("preparing");
    if (epoch === null) return;
    try {
      const durableExisting = await this.activateExistingProject(sampleProjectId, "durable", epoch);
      if (durableExisting || !this.isCurrent(epoch)) return;
      const temporaryExisting = await this.activateExistingProject(sampleProjectId, "temporary", epoch);
      if (temporaryExisting || !this.isCurrent(epoch)) return;
      const file = await this.bundledSampleLoader();
      if (!this.isCurrent(epoch)) return;
      const inspected = await inspectLocalMedia(file, async () => BUNDLED_SAMPLE_DURATION_MS);
      if (!this.isCurrent(epoch)) return;
      await this.chooseStorageMode({
        file,
        durationMs: inspected.durationMs,
        projectId: sampleProjectId,
        sourceId: sampleSourceId,
        title: "CueBench bundled media fixture",
      }, epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not open the bundled media fixture."));
    }
  }

  public async restoreLastDurableProject(): Promise<void> {
    const epoch = this.beginRestore();
    if (epoch === null) return;
    try {
      await this.beforeRestoreLoad?.();
      if (!this.isCurrent(epoch)) return;

      let mediaWasUnavailable = false;
      const temporaryProjectId = this.readTemporaryProjectId();
      if (temporaryProjectId !== null) {
        const result = await this.activateExistingProject(temporaryProjectId, "temporary", epoch);
        if (result) return;
        if (!this.isCurrent(epoch)) return;
        this.clearTemporaryProject();
        mediaWasUnavailable = true;
      }

      const durableSetting = await loadSetting(this.database, lastDurableProjectKey);
      if (!this.isCurrent(epoch)) return;
      const durableProjectId = durableSetting === undefined ? null : readProjectId(durableSetting.value);
      if (durableProjectId !== null) {
        const result = await this.activateExistingProject(durableProjectId, "durable", epoch);
        if (result) return;
        if (!this.isCurrent(epoch)) return;
        mediaWasUnavailable = true;
      }

      if (mediaWasUnavailable) {
        this.failCurrentOperation(epoch, "CueBench could not restore the local media. Choose the video again to start a new project.");
      } else {
        this.completeToStart(epoch);
      }
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not restore the local media."));
    }
  }

  /** `restoreLastDurableProject` retains this historic name while also recovering a same-session temporary pointer. */
  public restoreLastProject(): Promise<void> {
    return this.restoreLastDurableProject();
  }

  public async chooseFile(file: File): Promise<void> {
    const epoch = this.beginUserOperation("preparing");
    if (epoch === null) return;
    try {
      const inspected = await inspectLocalMedia(file, this.mediaDurationProbe);
      if (!this.isCurrent(epoch)) return;
      await this.chooseStorageMode({
        file,
        durationMs: inspected.durationMs,
        projectId: `local-${this.createId()}`,
        sourceId: `source-${this.createId()}`,
        title: titleForFile(file),
      }, epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not open this video."));
    }
  }

  public async continueTemporarily(): Promise<void> {
    const pendingUpload = this.snapshot.pendingUpload;
    if (pendingUpload === null) return;
    const epoch = this.beginUserOperation("saving");
    if (epoch === null) return;
    await this.persistPendingUpload(pendingUpload, "temporary", epoch);
  }

  public cancelPendingUpload(): void {
    if (this.snapshot.activity !== null) return;
    this.invalidateOperations();
    this.setSnapshot(emptySnapshot());
  }

  /** Cancels stale async continuations and releases the only live local-media URL. */
  public dispose(): void {
    this.invalidateOperations();
    this.objectUrlLease?.revoke();
    if (this.snapshot.route !== "start" || this.snapshot.sourceObjectUrl !== null || this.snapshot.activity !== null) {
      this.setSnapshot(emptySnapshot());
    }
  }

  private async chooseStorageMode(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    const durable = await this.hasDurableStorage(pendingUpload.file.size);
    if (!this.isCurrent(epoch)) return;
    if (durable) {
      this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
      await this.persistPendingUpload(pendingUpload, "durable", epoch);
      return;
    }
    this.offerTemporaryChoice(pendingUpload, epoch, null);
  }

  private async persistPendingUpload(pendingUpload: PendingUpload, mode: ProjectMode, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) {
      this.failCurrentOperation(epoch, "This browser cannot safely preview local media.");
      return;
    }

    let objectUrl: string | null = null;
    try {
      const previousDurableProjectId = mode === "durable" ? await this.readLastDurableProjectId() : null;
      if (!this.isCurrent(epoch)) return;
      const media = await ingestLocalMedia({
        database: this.database,
        projectId: pendingUpload.projectId,
        sourceId: pendingUpload.sourceId,
        file: pendingUpload.file,
        probeDuration: async () => pendingUpload.durationMs,
      });
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      const project = createProject({
        projectId: pendingUpload.projectId,
        title: pendingUpload.title,
        media: {
          sourceId: media.sourceId,
          sha256: media.sha256,
          durationMs: media.durationMs,
          relinkState: mode === "temporary" ? "TemporarySession" : "Linked",
        },
      });
      await initializeProject(this.database, project);
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      // `loadSourceMedia` re-hashes the Blob and prevents a ready-looking route without playable local bytes.
      const verifiedSource = await loadSourceMedia(this.database, pendingUpload.projectId, media.sha256);
      if (verifiedSource === undefined) throw new Error("CueBench could not verify the saved local media.");
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      objectUrl = objectUrlLease.replace(verifiedSource.blob);
      await this.persistMode(pendingUpload.projectId, mode);
      if (!this.isCurrent(epoch)) {
        objectUrlLease.revoke();
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      if (mode === "durable") {
        await this.rememberDurableProject(pendingUpload.projectId);
        if (!this.isCurrent(epoch)) {
          objectUrlLease.revoke();
          await this.rollbackProjectLifecycle(pendingUpload.projectId);
          await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
          return;
        }
        this.clearTemporaryProject();
      } else {
        this.rememberTemporaryProject(pendingUpload.projectId);
      }
      this.setSnapshot({
        route: "workbench",
        project,
        mode,
        sourceObjectUrl: objectUrl,
        pendingUpload: null,
        activity: null,
        error: null,
      });
    } catch (error) {
      if (objectUrl !== null) objectUrlLease.revoke();
      await this.rollbackProjectLifecycle(pendingUpload.projectId);
      if (!this.isCurrent(epoch)) return;
      if (mode === "durable" && isQuotaExceeded(error)) {
        this.offerTemporaryChoice(
          pendingUpload,
          epoch,
          "The browser ran out of durable storage. Continue temporarily or choose another video.",
        );
        return;
      }
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not save this video."));
    }
  }

  private async activateExistingProject(projectId: string, expectedMode: ProjectMode, epoch: number): Promise<boolean> {
    const [project, mode] = await Promise.all([
      loadProject(this.database, projectId),
      loadProjectMode(this.database, projectId),
    ]);
    if (!this.isCurrent(epoch) || project === undefined || mode !== expectedMode) return false;
    let media: Awaited<ReturnType<typeof loadSourceMedia>>;
    try {
      media = await loadSourceMedia(this.database, projectId, project.media.sha256);
    } catch {
      return false;
    }
    if (!this.isCurrent(epoch) || media === undefined) return false;
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) throw new LocalMediaError("object-url-unavailable", "This browser cannot safely preview local media.");
    // There is no await after this current-epoch check, so a stale restore cannot revoke a newer URL.
    const sourceObjectUrl = objectUrlLease.replace(media.blob);
    this.setSnapshot({
      route: "workbench",
      project,
      mode,
      sourceObjectUrl,
      pendingUpload: null,
      activity: null,
      error: null,
    });
    return true;
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

  /** Guaranteed cleanup compensates for the package-level immutable writes that span separate Dexie transactions. */
  private async rollbackProjectLifecycle(projectId: string): Promise<void> {
    try {
      await this.database.transaction(
        "rw",
        [
          this.database.projectHeaders,
          this.database.items,
          this.database.revisions,
          this.database.findings,
          this.database.evidence,
          this.database.courtRecord,
          this.database.certifications,
          this.database.sourceBlobs,
          this.database.narrationBlobs,
          this.database.runReceipts,
          this.database.settings,
        ],
        async () => {
          await Promise.all([
            this.database.projectHeaders.delete(projectId),
            this.database.items.where("projectId").equals(projectId).delete(),
            this.database.revisions.where("projectId").equals(projectId).delete(),
            this.database.findings.where("projectId").equals(projectId).delete(),
            this.database.evidence.where("projectId").equals(projectId).delete(),
            this.database.courtRecord.where("projectId").equals(projectId).delete(),
            this.database.certifications.where("projectId").equals(projectId).delete(),
            this.database.sourceBlobs.where("projectId").equals(projectId).delete(),
            this.database.narrationBlobs.where("projectId").equals(projectId).delete(),
            this.database.runReceipts.where("projectId").equals(projectId).delete(),
            this.database.settings.delete(projectModeKey(projectId)),
          ]);
        },
      );
    } catch {
      // Preserve the original user-facing failure; a later inspection can identify a browser-level database outage.
    }
  }

  private async persistMode(projectId: string, mode: ProjectMode): Promise<void> {
    await saveSetting(this.database, projectModeKey(projectId), { mode });
  }

  private async rememberDurableProject(projectId: string): Promise<void> {
    await saveSetting(this.database, lastDurableProjectKey, { projectId });
  }

  private async readLastDurableProjectId(): Promise<string | null> {
    const setting = await loadSetting(this.database, lastDurableProjectKey);
    return setting === undefined ? null : readProjectId(setting.value);
  }

  private async restoreDurableProjectPointer(previousProjectId: string | null, failedProjectId: string): Promise<void> {
    try {
      const current = await loadSetting(this.database, lastDurableProjectKey);
      if (current === undefined || readProjectId(current.value) !== failedProjectId) return;
      if (previousProjectId === null) {
        await this.database.settings.delete(lastDurableProjectKey);
      } else {
        await this.rememberDurableProject(previousProjectId);
      }
    } catch {
      // The project rollback remains authoritative even if the browser rejects a compensating pointer write.
    }
  }

  private readTemporaryProjectId(): string | null {
    try {
      const encoded = this.sessionStorage?.getItem(temporaryProjectSessionKey);
      if (encoded === null || encoded === undefined) return null;
      return readProjectId(JSON.parse(encoded));
    } catch {
      return null;
    }
  }

  private rememberTemporaryProject(projectId: string): void {
    try {
      this.sessionStorage?.setItem(temporaryProjectSessionKey, JSON.stringify({ projectId }));
    } catch {
      // The current tab stays usable even in restrictive privacy modes; the disclosure does not promise recovery.
    }
  }

  private clearTemporaryProject(): void {
    try {
      this.sessionStorage?.removeItem(temporaryProjectSessionKey);
    } catch {
      // Best-effort cleanup only; browser session storage can be disabled independently of IndexedDB.
    }
  }

  private offerTemporaryChoice(pendingUpload: PendingUpload, epoch: number, error: string | null): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({
      route: "temporary-choice",
      project: null,
      mode: null,
      sourceObjectUrl: null,
      pendingUpload,
      activity: null,
      error,
    });
  }

  private beginRestore(): number | null {
    if (this.snapshot.activity !== null || this.snapshot.project !== null) return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity: "hydrating", error: null });
    return epoch;
  }

  private beginUserOperation(activity: Exclude<ProjectActivity, "hydrating" | null>): number | null {
    if (this.snapshot.project !== null) return null;
    if (this.snapshot.activity !== null && this.snapshot.activity !== "hydrating") return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity, error: null });
    return epoch;
  }

  private completeToStart(epoch: number): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot(emptySnapshot());
  }

  private failCurrentOperation(epoch: number, error: string): void {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...emptySnapshot(), error });
  }

  private invalidateOperations(): void {
    this.operationEpoch += 1;
  }

  private isCurrent(epoch: number): boolean {
    return epoch === this.operationEpoch;
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
