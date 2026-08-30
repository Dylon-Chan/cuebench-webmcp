import {
  applyCommand,
  createProject,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
} from "@cuebench/domain";
import {
  CueBenchDatabase,
  executePersistentCommand,
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
  hashLocalMedia,
  LocalMediaError,
  ObjectUrlLease,
  ingestLocalMedia,
  inspectLocalMedia,
  probeVideoDuration,
  type IngestedLocalMedia,
  type MediaDurationProbe,
} from "./local-media";

export type ProjectMode = "durable" | "temporary";
export type ProjectRoute = "start" | "temporary-choice" | "workbench";
export type ProjectActivity = "hydrating" | "preparing" | "saving" | null;

export interface BrowserStorageManager {
  estimate: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  persist: () => Promise<boolean>;
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
  /** Present only with a live, playable Blob-backed object URL. */
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
  readonly bundledSampleLoader?: () => File | Promise<File>;
  /** Test seam for proving that a stale restore cannot replace a newer operation. */
  readonly beforeRestoreLoad?: () => Promise<void>;
}

const metadataReserveBytes = 16 * 1024 * 1024;
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const projectOwnerKey = (projectId: string): string => `project-owner:${projectId}`;
const lastDurableProjectKey = "last-durable-project";

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

const readMode = (value: unknown): ProjectMode | null => {
  if (typeof value !== "object" || value === null || !("mode" in value)) return null;
  const mode = value.mode;
  return mode === "durable" || mode === "temporary" ? mode : null;
};

const readProjectId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return null;
  return typeof value.projectId === "string" && value.projectId.trim().length > 0 ? value.projectId : null;
};

const readOwnerToken = (value: unknown, projectId: string): string | null => {
  if (typeof value !== "object" || value === null || !("projectId" in value) || !("token" in value)) return null;
  return value.projectId === projectId && typeof value.token === "string" && value.token.length > 0 ? value.token : null;
};

const userFacingError = (error: unknown, fallback: string): string => error instanceof Error && error.message.length > 0
  ? error.message
  : fallback;

const isQuotaExceeded = (error: unknown): boolean => error instanceof Error && error.name === "QuotaExceededError";

const titleForFile = (file: File): string => file.name.trim().length > 0 ? file.name : "Local video";

/** Browser-canonical lifecycle with durable IndexedDB and truthful page-memory fallback. */
export class ProjectStore {
  private readonly database: CueBenchDatabase;
  private readonly storage: BrowserStorageManager | null;
  private readonly mediaDurationProbe: MediaDurationProbe;
  private readonly bundledSampleLoader: () => File | Promise<File>;
  private readonly beforeRestoreLoad: (() => Promise<void>) | undefined;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly ownedProjectTokens = new Map<string, string>();
  private operationEpoch = 0;
  /** Keeps page-originated domain writes ordered just like the durable CAS boundary. */
  private commandQueue: Promise<void> = Promise.resolve();

  public constructor(options: ProjectStoreOptions = {}) {
    this.database = options.database ?? new CueBenchDatabase();
    this.storage = options.browserStorage === undefined ? browserStorageManager() : options.browserStorage;
    this.mediaDurationProbe = options.mediaDurationProbe ?? probeVideoDuration;
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

  /** Opens a fresh real bundled Blob through the same storage decision as an upload. */
  public async openSample(): Promise<void> {
    const epoch = this.beginUserOperation("preparing");
    if (epoch === null) return;
    try {
      const file = await this.bundledSampleLoader();
      if (!this.isCurrent(epoch)) return;
      const inspected = await inspectLocalMedia(file, async () => BUNDLED_SAMPLE_DURATION_MS);
      if (!this.isCurrent(epoch)) return;
      await this.chooseStorageMode({
        file,
        durationMs: inspected.durationMs,
        projectId: `sample-${this.createId()}`,
        sourceId: `source-${this.createId()}`,
        title: "CueBench bundled media fixture",
      }, epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not open the bundled media fixture."));
    }
  }

  /** Restores only verified durable projects. Temporary work is current-page memory by design. */
  public async restoreLastDurableProject(): Promise<void> {
    const epoch = this.beginRestore();
    if (epoch === null) return;
    try {
      await this.beforeRestoreLoad?.();
      if (!this.isCurrent(epoch)) return;
      await this.sweepLegacyTemporaryProjects(epoch);
      if (!this.isCurrent(epoch)) return;

      const durableSetting = await loadSetting(this.database, lastDurableProjectKey);
      if (!this.isCurrent(epoch)) return;
      const durableProjectId = durableSetting === undefined ? null : readProjectId(durableSetting.value);
      if (durableProjectId !== null) {
        const result = await this.activateExistingProject(durableProjectId, "durable", epoch);
        if (result || !this.isCurrent(epoch)) return;
        this.failCurrentOperation(epoch, "CueBench could not restore the local media. Choose the video again to start a new project.");
        return;
      }

      this.completeToStart(epoch);
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not restore the local media."));
    }
  }

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

  /** Continues from an explicit choice without writing the Blob to IndexedDB. */
  public async continueTemporarily(): Promise<void> {
    const pendingUpload = this.snapshot.pendingUpload;
    if (pendingUpload === null) return;
    const epoch = this.beginUserOperation("saving");
    if (epoch === null) return;
    await this.persistTemporaryUpload(pendingUpload, epoch);
  }

  public cancelPendingUpload(): void {
    if (this.snapshot.activity !== null) return;
    this.invalidateOperations();
    this.setSnapshot(emptySnapshot());
  }

  /**
   * The UI uses the same version-guarded reducer as WebMCP. Durable projects
   * commit through the IndexedDB CAS transaction; temporary projects retain the
   * exact command semantics in their explicitly in-memory session.
   */
  public executeCommand(command: DomainCommand): Promise<CommandResult> {
    const execute = async (): Promise<CommandResult> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode === null) {
        throw new Error("CueBench cannot edit a project before its media is available.");
      }
      const projectId = snapshot.project.projectId;
      try {
        const result = snapshot.mode === "durable"
          ? await executePersistentCommand(this.database, projectId, command)
          : applyCommand(snapshot.project, command);

        // Rejected durable writes can carry newer canonical state from the
        // transaction. Reconcile it before returning so the next UI command
        // never continues against an abandoned projection.
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({
            ...this.snapshot,
            project: result.project,
            error: result.error?.message ?? null,
          });
        }
        return result;
      } catch (error) {
        if (this.snapshot.project?.projectId === projectId) {
          this.setSnapshot({ ...this.snapshot, error: userFacingError(error, "CueBench could not apply this project command.") });
        }
        throw error;
      }
    };
    const queued = this.commandQueue.then(execute, execute);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
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
      await this.persistDurableUpload(pendingUpload, epoch);
      return;
    }
    this.offerTemporaryChoice(pendingUpload, epoch, null);
  }

  private async persistTemporaryUpload(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) {
      this.failCurrentOperation(epoch, "This browser cannot safely preview local media.");
      return;
    }

    try {
      const sha256 = await hashLocalMedia(pendingUpload.file);
      if (!this.isCurrent(epoch)) return;
      const project = createProject({
        projectId: pendingUpload.projectId,
        title: pendingUpload.title,
        media: {
          sourceId: pendingUpload.sourceId,
          sha256,
          durationMs: pendingUpload.durationMs,
          relinkState: "TemporarySession",
        },
      });
      const sourceObjectUrl = objectUrlLease.replace(pendingUpload.file);
      this.setSnapshot({
        route: "workbench",
        project,
        mode: "temporary",
        sourceObjectUrl,
        pendingUpload: null,
        activity: null,
        error: null,
      });
    } catch (error) {
      this.failCurrentOperation(epoch, userFacingError(error, "CueBench could not prepare this temporary project."));
    }
  }

  private async persistDurableUpload(pendingUpload: PendingUpload, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.setSnapshot({ ...this.snapshot, pendingUpload, activity: "saving", error: null });
    const objectUrlLease = this.activeObjectUrlLease();
    if (objectUrlLease === undefined) {
      this.failCurrentOperation(epoch, "This browser cannot safely preview local media.");
      return;
    }

    let objectUrl: string | null = null;
    let previousDurableProjectId: string | null = null;
    let ownershipClaimed = false;
    try {
      previousDurableProjectId = await this.readLastDurableProjectId();
      if (!this.isCurrent(epoch)) return;
      await this.claimProjectOwnership(pendingUpload.projectId);
      ownershipClaimed = true;
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      const media = await ingestLocalMedia({
        database: this.database,
        projectId: pendingUpload.projectId,
        sourceId: pendingUpload.sourceId,
        file: pendingUpload.file,
        probeDuration: async () => pendingUpload.durationMs,
      });
      this.assertPersistedMedia(pendingUpload, media);
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
          relinkState: "Linked",
        },
      });
      await initializeProject(this.database, project);
      if (!this.isCurrent(epoch)) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        return;
      }
      // The fresh write was schema-validated and already SHA-256 checked by storage.
      objectUrl = objectUrlLease.replace(media.blob);
      await this.persistMode(pendingUpload.projectId, "durable");
      if (!this.isCurrent(epoch)) {
        objectUrlLease.revokeIfCurrent(objectUrl);
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
        return;
      }
      await this.rememberDurableProject(pendingUpload.projectId);
      if (!this.isCurrent(epoch)) {
        objectUrlLease.revokeIfCurrent(objectUrl);
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
        return;
      }
      this.ownedProjectTokens.delete(pendingUpload.projectId);
      this.setSnapshot({
        route: "workbench",
        project,
        mode: "durable",
        sourceObjectUrl: objectUrl,
        pendingUpload: null,
        activity: null,
        error: null,
      });
    } catch (error) {
      if (objectUrl !== null) objectUrlLease.revokeIfCurrent(objectUrl);
      if (ownershipClaimed) {
        await this.rollbackProjectLifecycle(pendingUpload.projectId);
        await this.restoreDurableProjectPointer(previousDurableProjectId, pendingUpload.projectId);
      }
      if (!this.isCurrent(epoch)) return;
      if (isQuotaExceeded(error)) {
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

  private assertPersistedMedia(pendingUpload: PendingUpload, media: IngestedLocalMedia): void {
    if (
      media.projectId !== pendingUpload.projectId
      || media.sourceId !== pendingUpload.sourceId
      || media.byteLength !== pendingUpload.file.size
      || media.blob.size !== pendingUpload.file.size
      || media.contentType !== pendingUpload.file.type
    ) {
      throw new Error("CueBench could not verify the saved local media binding.");
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
    // No await follows this epoch check, so a stale restore cannot replace a newer object URL.
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

  /** Claims a unique persistent owner before writing media, so a losing tab cannot roll back another tab. */
  private async claimProjectOwnership(projectId: string): Promise<void> {
    const token = this.createId();
    try {
      await this.database.transaction("rw", [this.database.projectHeaders, this.database.settings], async () => {
        const [existingProject, existingOwner] = await Promise.all([
          this.database.projectHeaders.get(projectId),
          this.database.settings.get(projectOwnerKey(projectId)),
        ]);
        if (existingProject !== undefined || existingOwner !== undefined) {
          throw new Error("CueBench could not claim a unique local project. Try opening the media again.");
        }
        await this.database.settings.add({
          key: projectOwnerKey(projectId),
          value: { projectId, token },
          updatedAtMs: Date.now(),
        });
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ConstraintError") {
        throw new Error("CueBench could not claim a unique local project. Try opening the media again.", { cause: error });
      }
      throw error;
    }
    this.ownedProjectTokens.set(projectId, token);
  }

  /** Compensates immutable writes only after proving this store owns the lifecycle marker. */
  private async rollbackProjectLifecycle(projectId: string): Promise<void> {
    const token = this.ownedProjectTokens.get(projectId);
    if (token === undefined) return;
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
          const ownership = await this.database.settings.get(projectOwnerKey(projectId));
          if (readOwnerToken(ownership?.value, projectId) !== token) return;
          await this.deleteProjectRows(projectId);
          await Promise.all([
            this.database.settings.delete(projectModeKey(projectId)),
            this.database.settings.delete(projectOwnerKey(projectId)),
          ]);
        },
      );
    } catch {
      // Preserve the primary browser/database failure. The owner marker prevents unrelated deletion on a retry.
    } finally {
      this.ownedProjectTokens.delete(projectId);
    }
  }

  /** Removes only old temporary rows that have neither a durable pointer nor a lifecycle owner. */
  private async sweepLegacyTemporaryProjects(epoch: number): Promise<void> {
    const settings = await this.database.settings.toArray();
    const durableProjectId = readProjectId(settings.find((setting) => setting.key === lastDurableProjectKey)?.value);
    const legacyIds = settings
      .filter((setting) => setting.key.startsWith("project-mode:") && readMode(setting.value) === "temporary")
      .map((setting) => setting.key.slice("project-mode:".length))
      .filter((projectId) => projectId.length > 0 && projectId !== durableProjectId);
    for (const projectId of legacyIds) {
      if (!this.isCurrent(epoch)) return;
      await this.purgeLegacyTemporaryProject(projectId);
    }
  }

  private async purgeLegacyTemporaryProject(projectId: string): Promise<void> {
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
          const [mode, owner, durablePointer] = await Promise.all([
            this.database.settings.get(projectModeKey(projectId)),
            this.database.settings.get(projectOwnerKey(projectId)),
            this.database.settings.get(lastDurableProjectKey),
          ]);
          if (
            readMode(mode?.value) !== "temporary"
            || owner !== undefined
            || readProjectId(durablePointer?.value) === projectId
          ) return;
          await this.deleteProjectRows(projectId);
          await this.database.settings.delete(projectModeKey(projectId));
        },
      );
    } catch {
      // A future app start can retry the migration cleanup; never block durable hydration for an orphan.
    }
  }

  private async deleteProjectRows(projectId: string): Promise<void> {
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
    ]);
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
      // The owner-checked project rollback remains authoritative if pointer recovery is rejected.
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
