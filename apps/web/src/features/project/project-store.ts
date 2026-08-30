import {
  applyCommand,
  createProject,
  buildProjectBackupFilename,
  exportProjectBackup as exportProjectBackupManifest,
  previewProjectImport,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
  type ProjectImportDescriptor,
} from "@cuebench/domain";
import {
  CueBenchDatabase,
  describeImportedProject,
  executePersistentCommand,
  initializeProject,
  loadProject,
  loadSetting,
  loadSourceMedia,
  saveSetting,
  sourceBlobKey,
  type SourceBlobRow,
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
import {
  bundledFixtureSourceProvenance,
  sourceProvenanceFrom,
  uploadedSourceProvenance,
  type SourceProvenance,
} from "./source-provenance";

export type ProjectMode = "durable" | "temporary";
export type ProjectRoute = "start" | "temporary-choice" | "workbench";
export type ProjectActivity = "hydrating" | "preparing" | "saving" | "importing" | "deleting" | null;

export interface CloudCleanupRequest {
  readonly projectId: string;
  readonly sourceId: string;
  readonly activeRunId: string | null;
  /** Task 15 owns the remote cancellation protocol; deletion always requests it first. */
  readonly cancelActiveWork: true;
}

export interface CloudCleanupResult {
  readonly status: "deleted" | "pending";
  readonly message: string;
}

export type CloudCleanupHook = (request: CloudCleanupRequest) => Promise<CloudCleanupResult>;

export interface ProjectDeletionResult {
  readonly localDeleted: true;
  readonly cloudCleanup: CloudCleanupResult;
  readonly cleanupNotice: string;
}

export interface ProjectBackupDownload {
  readonly filename: string;
  readonly text: string;
}

export interface ImportedProjectResult {
  readonly project: CaptionProject;
  readonly cleanupNotice: string;
}

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
  readonly sourceProvenance: SourceProvenance;
}

export interface ProjectStoreSnapshot {
  readonly route: ProjectRoute;
  readonly project: CaptionProject | null;
  readonly mode: ProjectMode | null;
  /** Present only with a live, playable Blob-backed object URL. */
  readonly sourceObjectUrl: string | null;
  /** Trusted local source facts, never inferred from mutable project text. */
  readonly sourceProvenance: SourceProvenance | null;
  readonly pendingUpload: PendingUpload | null;
  readonly activity: ProjectActivity;
  readonly error: string | null;
  /** Retained after a confirmed deletion so we never overstate cloud cleanup. */
  readonly cleanupNotice: string | null;
}

export interface ProjectStoreOptions {
  readonly database?: CueBenchDatabase;
  readonly browserStorage?: BrowserStorageManager | null;
  readonly mediaDurationProbe?: MediaDurationProbe;
  readonly objectUrlLease?: ObjectUrlLease;
  readonly createId?: () => string;
  readonly bundledSampleLoader?: () => File | Promise<File>;
  /** Optional hosted-cleanup seam populated by Task 15. Its absence is reported as lifecycle-pending, never success. */
  readonly cloudCleanup?: CloudCleanupHook;
  /** Test seam for proving that a stale restore cannot replace a newer operation. */
  readonly beforeRestoreLoad?: () => Promise<void>;
}

const metadataReserveBytes = 16 * 1024 * 1024;
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const projectOwnerKey = (projectId: string): string => `project-owner:${projectId}`;
const projectSourceProvenanceKey = (projectId: string): string => `project-source-provenance:${projectId}`;
const lastDurableProjectKey = "last-durable-project";
const importSafetyBackupKey = (projectId: string, backupId: string): string => `import-safety-backup:${projectId}:${backupId}`;
const replacementSafetyBackupKey = (projectId: string, backupId: string): string => `replacement-safety-backup:${projectId}:${backupId}`;

const emptySnapshot = (): ProjectStoreSnapshot => ({
  route: "start",
  project: null,
  mode: null,
  sourceObjectUrl: null,
  sourceProvenance: null,
  pendingUpload: null,
  activity: null,
  error: null,
  cleanupNotice: null,
});

interface PendingBackupImport {
  readonly originalEnvelope: unknown;
  readonly descriptor: ProjectImportDescriptor;
  readonly relinkFile: File | null;
}

const humanImportActor = { type: "Human" as const, id: "human" };

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
  private readonly cloudCleanup: CloudCleanupHook | undefined;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly ownedProjectTokens = new Map<string, string>();
  private pendingBackupImport: PendingBackupImport | null = null;
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
    this.cloudCleanup = options.cloudCleanup;
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
        sourceProvenance: bundledFixtureSourceProvenance,
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
        sourceProvenance: uploadedSourceProvenance,
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
      if (snapshot.activity !== null) {
        throw new Error("CueBench cannot edit a project while another local operation is in progress.");
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

  /** Produces a portable manifest only; source video remains in browser storage and is never serialized. */
  public async exportProjectBackup(): Promise<ProjectBackupDownload> {
    const project = this.snapshot.project;
    if (project === null) throw new Error("CueBench cannot back up a project before its media is available.");
    const backup = exportProjectBackupManifest(project, { exportedAtMs: Date.now() });
    return {
      filename: buildProjectBackupFilename(project.title),
      text: JSON.stringify(backup, null, 2),
    };
  }

  /** Parses and previews an import without changing local storage. This UI-only boundary always supplies Human provenance. */
  public async previewBackupText(text: string): Promise<ProjectImportDescriptor> {
    const project = this.snapshot.project;
    if (project === null) throw new Error("Open a project before previewing a backup replacement.");
    this.pendingBackupImport = null;
    let originalEnvelope: unknown;
    try {
      originalEnvelope = JSON.parse(text) as unknown;
    } catch {
      throw new Error("CueBench could not parse this backup JSON.");
    }
    const descriptor = previewProjectImport(originalEnvelope, {
      actor: humanImportActor,
      replaceProject: project,
      migration: describeImportedProject,
    });
    this.pendingBackupImport = {
      originalEnvelope: structuredClone(originalEnvelope),
      descriptor,
      relinkFile: null,
    };
    return descriptor;
  }

  /** Recomputes the pure preview after hashing the selected local video; a mismatch can never enable import. */
  public async relinkImportedMedia(file: File): Promise<ProjectImportDescriptor> {
    const pending = this.pendingBackupImport;
    if (pending === null || pending.descriptor.mode !== "preview") {
      throw new Error("Preview a compatible project backup before selecting media to relink.");
    }
    const [inspected, sha256] = await Promise.all([
      inspectLocalMedia(file, this.mediaDurationProbe),
      hashLocalMedia(file),
    ]);
    const descriptor = previewProjectImport(pending.originalEnvelope, {
      actor: humanImportActor,
      ...(this.snapshot.project === null ? {} : { replaceProject: this.snapshot.project }),
      migration: describeImportedProject,
      relinkedMedia: {
        sourceId: `import-source-${this.createId()}`,
        sha256,
        durationMs: inspected.durationMs,
      },
    });
    this.pendingBackupImport = { ...pending, descriptor, relinkFile: file };
    return descriptor;
  }

  /**
   * Commits a previewed import only after a second hash check, all required
   * safety backups, and the Human dialog confirmation. Browser Agent tools
   * do not receive this method or a configurable actor parameter.
   */
  public async importPreviewedBackup(): Promise<ImportedProjectResult> {
    const initiallyPending = this.pendingBackupImport;
    const initiallySnapshot = this.snapshot;
    if (
      initiallyPending === null
      || initiallyPending.descriptor.mode !== "preview"
      || initiallyPending.relinkFile === null
      || !initiallyPending.descriptor.canImport
      || initiallySnapshot.project === null
      || initiallySnapshot.activity !== null
    ) {
      throw new Error("CueBench needs a compatible preview and a SHA-256-verified media relink before import.");
    }

    this.invalidateOperations();
    this.setSnapshot({ ...initiallySnapshot, activity: "importing", error: null, cleanupNotice: null });
    try {
      /** Let any already-started persistent command settle before replacing its project namespace. */
      await this.commandQueue;
      const current = this.snapshot;
      const pending = this.pendingBackupImport;
      if (current.project === null || pending === null || pending.descriptor.mode !== "preview" || pending.relinkFile === null) {
        throw new Error("CueBench's import preview changed before confirmation. Preview the backup again.");
      }
      const relinkFile = pending.relinkFile;

      const [inspected, sha256] = await Promise.all([
        inspectLocalMedia(relinkFile, this.mediaDurationProbe),
        hashLocalMedia(relinkFile),
      ]);
      const exactPreview = previewProjectImport(pending.originalEnvelope, {
        actor: humanImportActor,
        replaceProject: current.project,
        migration: describeImportedProject,
        relinkedMedia: {
          sourceId: pending.descriptor.project.media.sourceId,
          sha256,
          durationMs: inspected.durationMs,
        },
      });
      if (exactPreview.mode !== "preview" || !exactPreview.canImport || exactPreview.mediaRelink.status !== "verified") {
        throw new Error("The selected media no longer matches the SHA-256 recorded by this backup. Choose the original source video again.");
      }
      const objectUrlLease = this.activeObjectUrlLease();
      if (objectUrlLease === undefined) {
        throw new LocalMediaError("object-url-unavailable", "This browser cannot safely preview the relinked local media.");
      }

      const replacementProject = current.project;
      const importedProject = exactPreview.project;
      const backupId = this.createId();
      /** The SHA-256 was recomputed immediately above; write its immutable binding within the same local transaction. */
      const verifiedMediaRow: SourceBlobRow = {
        key: sourceBlobKey(importedProject.projectId, importedProject.media.sha256),
        projectId: importedProject.projectId,
        sourceId: importedProject.media.sourceId,
        sha256: importedProject.media.sha256,
        blob: relinkFile,
        byteLength: relinkFile.size,
        contentType: relinkFile.type,
        fileName: relinkFile.name,
        savedAtMs: Date.now(),
      };
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
          const existingTarget = await this.database.projectHeaders.get(importedProject.projectId);
          if (existingTarget !== undefined && importedProject.projectId !== replacementProject.projectId) {
            throw new Error("CueBench cannot overwrite another local project while importing this backup.");
          }

          /** Persist recovery material before replacing any local row. */
          await this.database.settings.put({
            key: importSafetyBackupKey(importedProject.projectId, backupId),
            value: exactPreview.safetyBackup,
            updatedAtMs: Date.now(),
          });
          if (exactPreview.replacementSafetyBackup !== null) {
            await this.database.settings.put({
              key: replacementSafetyBackupKey(replacementProject.projectId, backupId),
              value: exactPreview.replacementSafetyBackup,
              updatedAtMs: Date.now(),
            });
          }

          await this.deleteProjectRows(replacementProject.projectId);
          /** Keep the just-written recovery copies during an import replacement. */
          await this.deleteProjectSettings(replacementProject.projectId, false);
          await initializeProject(this.database, importedProject);
          await this.database.sourceBlobs.add(verifiedMediaRow);
          await this.database.settings.put({ key: projectModeKey(importedProject.projectId), value: { mode: "durable" }, updatedAtMs: Date.now() });
          await this.database.settings.put({ key: projectSourceProvenanceKey(importedProject.projectId), value: uploadedSourceProvenance, updatedAtMs: Date.now() });
          await this.database.settings.put({ key: lastDurableProjectKey, value: { projectId: importedProject.projectId }, updatedAtMs: Date.now() });
        },
      );

      const persistedProject = await loadProject(this.database, importedProject.projectId);
      if (persistedProject === undefined) throw new Error("CueBench could not verify the imported project after writing local storage.");
      const persistedMedia = await loadSourceMedia(this.database, importedProject.projectId, importedProject.media.sha256);
      if (
        persistedMedia === undefined
        || persistedMedia.sourceId !== importedProject.media.sourceId
        || persistedMedia.sha256 !== importedProject.media.sha256
        || persistedMedia.byteLength !== relinkFile.size
      ) {
        throw new Error("CueBench could not verify the saved Media Relink binding.");
      }
      const sourceObjectUrl = objectUrlLease.replace(relinkFile);
      const cleanupNotice = "Imported project is stored in this browser. The selected local video was verified through Media Relink before replacement.";
      this.pendingBackupImport = null;
      this.setSnapshot({
        route: "workbench",
        project: persistedProject,
        mode: "durable",
        sourceObjectUrl,
        sourceProvenance: uploadedSourceProvenance,
        pendingUpload: null,
        activity: null,
        error: null,
        cleanupNotice,
      });
      return { project: persistedProject, cleanupNotice };
    } catch (error) {
      if (this.snapshot.activity === "importing") {
        this.setSnapshot({ ...this.snapshot, activity: null, error: userFacingError(error, "CueBench could not import this backup.") });
      }
      throw error;
    }
  }

  /** Deletes browser records atomically, then reports hosted cleanup honestly instead of treating a request as success. */
  public async deleteCurrentProject(): Promise<ProjectDeletionResult> {
    const initial = this.snapshot;
    if (initial.project === null || initial.mode === null || initial.activity !== null) {
      throw new Error("CueBench cannot delete a project while it is unavailable or another local operation is in progress.");
    }
    this.invalidateOperations();
    this.pendingBackupImport = null;
    this.setSnapshot({ ...initial, activity: "deleting", error: null, cleanupNotice: null });
    try {
      /** No new commands may begin after the deleting state is published. */
      await this.commandQueue;
      const current = this.snapshot;
      if (current.project === null || current.mode === null) throw new Error("CueBench project state changed before deletion could begin.");

      if (current.mode === "durable") {
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
            await this.deleteProjectRows(current.project!.projectId);
            await this.deleteProjectSettings(current.project!.projectId, true);
            const durablePointer = await this.database.settings.get(lastDurableProjectKey);
            if (readProjectId(durablePointer?.value) === current.project!.projectId) {
              await this.database.settings.delete(lastDurableProjectKey);
            }
          },
        );
      }

      this.objectUrlLease?.revoke();
      const cloudCleanup = await this.requestCloudCleanup(current.project);
      const cleanupNotice = `Local project copy deleted. ${cloudCleanup.message}`;
      this.setSnapshot({ ...emptySnapshot(), cleanupNotice });
      return { localDeleted: true, cloudCleanup, cleanupNotice };
    } catch (error) {
      if (this.snapshot.activity === "deleting") {
        this.setSnapshot({ ...this.snapshot, activity: null, error: userFacingError(error, "CueBench could not delete this local project.") });
      }
      throw error;
    }
  }

  /** Cancels stale async continuations and releases the only live local-media URL. */
  public dispose(): void {
    this.invalidateOperations();
    this.pendingBackupImport = null;
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
        sourceProvenance: pendingUpload.sourceProvenance,
        pendingUpload: null,
        activity: null,
        error: null,
        cleanupNotice: null,
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
      await this.persistSourceProvenance(pendingUpload.projectId, pendingUpload.sourceProvenance);
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
        sourceProvenance: pendingUpload.sourceProvenance,
        pendingUpload: null,
        activity: null,
        error: null,
        cleanupNotice: null,
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
    const [project, mode, sourceProvenanceSetting] = await Promise.all([
      loadProject(this.database, projectId),
      loadProjectMode(this.database, projectId),
      loadSetting(this.database, projectSourceProvenanceKey(projectId)),
    ]);
    if (!this.isCurrent(epoch) || project === undefined || mode !== expectedMode) return false;
    const sourceProvenance = sourceProvenanceSetting === undefined
      ? uploadedSourceProvenance
      : sourceProvenanceFrom(sourceProvenanceSetting.value) ?? uploadedSourceProvenance;
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
      sourceProvenance,
      pendingUpload: null,
      activity: null,
      error: null,
      cleanupNotice: null,
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
            this.database.settings.delete(projectSourceProvenanceKey(projectId)),
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
          await Promise.all([
            this.database.settings.delete(projectModeKey(projectId)),
            this.database.settings.delete(projectSourceProvenanceKey(projectId)),
          ]);
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

  /** Removes local lifecycle metadata and, for a confirmed deletion, retained recovery copies containing project data. */
  private async deleteProjectSettings(projectId: string, includeSafetyBackups: boolean): Promise<void> {
    const keys = (await this.database.settings.toArray())
      .map((setting) => setting.key)
      .filter((key) => (
        key === projectModeKey(projectId)
        || key === projectOwnerKey(projectId)
        || key === projectSourceProvenanceKey(projectId)
        || (includeSafetyBackups && (
          key.startsWith(`import-safety-backup:${projectId}:`)
          || key.startsWith(`replacement-safety-backup:${projectId}:`)
        ))
      ));
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  private async requestCloudCleanup(project: CaptionProject): Promise<CloudCleanupResult> {
    if (this.cloudCleanup === undefined) {
      return {
        status: "pending",
        message: "Cloud cleanup remains pending lifecycle enforcement because no hosted cleanup hook is configured for this browser session.",
      };
    }
    try {
      const result = await this.cloudCleanup({
        projectId: project.projectId,
        sourceId: project.media.sourceId,
        activeRunId: project.activeGenerationRun?.runId ?? null,
        cancelActiveWork: true,
      });
      if ((result.status === "deleted" || result.status === "pending") && typeof result.message === "string" && result.message.trim().length > 0) {
        return result;
      }
      return {
        status: "pending",
        message: "Cloud cleanup returned an incomplete status and remains pending lifecycle enforcement.",
      };
    } catch {
      return {
        status: "pending",
        message: "Cloud cleanup could not be confirmed and remains pending lifecycle enforcement.",
      };
    }
  }

  private async persistMode(projectId: string, mode: ProjectMode): Promise<void> {
    await saveSetting(this.database, projectModeKey(projectId), { mode });
  }

  private async persistSourceProvenance(projectId: string, sourceProvenance: SourceProvenance): Promise<void> {
    await saveSetting(this.database, projectSourceProvenanceKey(projectId), sourceProvenance);
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
      // The temporary-decision screen still describes this concrete local
      // source. Keeping the fact here prevents title-based fallbacks when the
      // upload is continued in the current page.
      sourceProvenance: pendingUpload.sourceProvenance,
      pendingUpload,
      activity: null,
      error,
      cleanupNotice: null,
    });
  }

  private beginRestore(): number | null {
    if (this.snapshot.activity !== null || this.snapshot.project !== null) return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity: "hydrating", error: null, cleanupNotice: null });
    return epoch;
  }

  private beginUserOperation(activity: Exclude<ProjectActivity, "hydrating" | null>): number | null {
    if (this.snapshot.project !== null) return null;
    if (this.snapshot.activity !== null && this.snapshot.activity !== "hydrating") return null;
    const epoch = ++this.operationEpoch;
    this.setSnapshot({ ...this.snapshot, activity, error: null, cleanupNotice: null });
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
