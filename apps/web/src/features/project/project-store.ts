import {
  applyCommand,
  createProject,
  buildProjectBackupFilename,
  canonicalHash,
  exportProjectBackup as exportProjectBackupManifest,
  prepareTrackExport as prepareDomainTrackExport,
  previewProjectImport,
  type CaptionProject,
  type CommandResult,
  type DomainCommand,
  type ProjectImportDescriptor,
  type ProjectTrackExport,
  type ProjectTrackExportRequest,
} from "@cuebench/domain";
import {
  CueBenchDatabase,
  adoptStagedCaptionGenerationResult as adoptPersistedCaptionGenerationResult,
  describeImportedProject,
  executePersistentCommand,
  initializeProject,
  loadProject,
  loadProjectInTransaction,
  loadRunReceipt,
  listRunReceipts,
  loadSetting,
  loadSourceMedia,
  releaseRunReceiptReservation,
  reserveRunReceiptSlot,
  saveRunReceipt,
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
import { parseBoundedBackupJson } from "./backup-import-safety";
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
  readonly status: "deleted" | "pending" | "failed";
  readonly message: string;
}

export type CloudCleanupHook = (request: CloudCleanupRequest) => Promise<CloudCleanupResult>;

export interface ProjectDeletionResult {
  readonly localDeleted: true;
  readonly cloudCleanup: CloudCleanupResult;
  readonly cleanupNotice: string;
  /** Retained locally so a pending hosted cleanup can be retried truthfully. */
  readonly receiptId: string;
}

export interface ProjectBackupDownload {
  readonly filename: string;
  readonly text: string;
  /** A durable peer updated the project before serialization; this backup uses that canonical version. */
  readonly freshnessNotice?: string;
}

export interface FreshProjectTrackExport {
  readonly project: CaptionProject;
  readonly prepared: ProjectTrackExport;
  readonly freshnessNotice: string | null;
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
  /** Bounds hosted deletion work; local deletion never waits indefinitely on a cloud hook. */
  readonly cloudCleanupTimeoutMs?: number;
  /** Test seam: a synchronous UI-side fault after commit must reconcile forward, never restore a dead preview. */
  readonly afterImportCommitted?: () => void;
  /** Test seam for proving that a stale restore cannot replace a newer operation. */
  readonly beforeRestoreLoad?: () => Promise<void>;
}

export type CaptionGenerationAdoptionCommand = Extract<DomainCommand, {
  readonly type: "AdoptCaptionGenerationResult";
}>;

const metadataReserveBytes = 16 * 1024 * 1024;
const defaultCreateId = (): string => globalThis.crypto.randomUUID();
const projectModeKey = (projectId: string): string => `project-mode:${projectId}`;
const projectOwnerKey = (projectId: string): string => `project-owner:${projectId}`;
/**
 * This is deliberately separate from the short-lived project creation marker
 * above. It is a stable, non-portable browser-project instance capability
 * used to bind optional private cloud operations across anonymous-session
 * renewal. Backups never carry it.
 */
const projectInstanceOwnerCapabilityKey = (projectId: string): string => `project-instance-owner-capability:${projectId}`;
const projectSourceProvenanceKey = (projectId: string): string => `project-source-provenance:${projectId}`;
const lastDurableProjectKey = "last-durable-project";
const importSafetyBackupKey = (projectId: string, backupId: string): string => `import-safety-backup:${projectId}:${backupId}`;
const replacementSafetyBackupKey = (projectId: string, backupId: string): string => `replacement-safety-backup:${projectId}:${backupId}`;
const deletionReceiptKey = (projectId: string, receiptId: string): string => `project-deletion-receipt:${projectId}:${receiptId}`;
const importReplacementHash = (project: CaptionProject): string => canonicalHash("cuebench.web.import-replacement.v1", project);

interface ReplacementImportExpectation {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectHash: string;
  readonly mode: ProjectMode;
}

interface DeletionReceipt {
  readonly receiptId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly activeRunId: string | null;
  readonly createdAtMs: number;
  readonly attempts: number;
  readonly state: "pending" | "deleted" | "failed";
  readonly message: string;
}

interface ProjectInstanceOwnerCapability {
  readonly version: 1;
  readonly projectId: string;
  readonly capability: string;
}

const createProjectInstanceOwnerCapability = (): string => {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw new Error("CueBench cannot create a cryptographically random browser-project owner capability.");
  }
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readProjectInstanceOwnerCapability = (value: unknown, projectId: string): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return record.version === 1
    && record.projectId === projectId
    && typeof record.capability === "string"
    && /^[0-9a-f]{64}$/i.test(record.capability)
    ? record.capability.toLowerCase()
    : null;
};

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
  /** Exact canonical target visible to the Human at preview time, or null for a new local project. */
  readonly replacement: ReplacementImportExpectation | null;
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
  private readonly cloudCleanupTimeoutMs: number;
  private readonly afterImportCommitted: (() => void) | undefined;
  private objectUrlLease: ObjectUrlLease | null;
  private triedObjectUrlLease = false;
  private readonly createId: () => string;
  private snapshot: ProjectStoreSnapshot = emptySnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly ownedProjectTokens = new Map<string, string>();
  private pendingBackupImport: PendingBackupImport | null = null;
  private activeCleanupReceiptId: string | null = null;
  /** One browser store never sends overlapping hosted-cleanup requests for the same retained receipt. */
  private readonly cleanupOperations = new Map<string, Promise<CloudCleanupResult>>();
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
    this.cloudCleanupTimeoutMs = Math.max(1, Math.trunc(options.cloudCleanupTimeoutMs ?? 5_000));
    this.afterImportCommitted = options.afterImportCommitted;
  }

  public getSnapshot = (): ProjectStoreSnapshot => this.snapshot;

  /**
   * Resolves the current non-portable project-instance capability directly
   * from IndexedDB before any cloud mutation. This is intentionally a fresh
   * durable read rather than a projectId-keyed localStorage value: a backup
   * import can atomically rotate the capability while an older tab remains
   * open with an obsolete opaque upload receipt.
   */
  public getCloudProjectOwnerCapability = async (projectId: string): Promise<string | null> => {
    return this.database.transaction("rw", [this.database.projectHeaders, this.database.settings], async () => {
      const header = await this.database.projectHeaders.get(projectId);
      if (header === undefined) return null;
      const existing = await this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId));
      const capability = readProjectInstanceOwnerCapability(existing?.value, projectId);
      if (capability !== null) return capability;
      // Compatibility migration for durable projects saved before this
      // capability existed. The record is born transactionally with the
      // project namespace and never reconstructed from localStorage.
      const value: ProjectInstanceOwnerCapability = {
        version: 1,
        projectId,
        capability: createProjectInstanceOwnerCapability(),
      };
      await this.database.settings.put({
        key: projectInstanceOwnerCapabilityKey(projectId),
        value,
        updatedAtMs: Date.now(),
      });
      return value.capability;
    });
  };

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

  /**
   * Caption evidence adoption additionally updates the locally persisted
   * signed run receipt. Keeping that work here prevents a React component
   * from accidentally splitting the expected-revision CAS across writes.
   */
  public adoptStagedCaptionGenerationResult(command: CaptionGenerationAdoptionCommand): Promise<CommandResult> {
    const execute = async (): Promise<CommandResult> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode === null) {
        throw new Error("CueBench cannot adopt caption evidence before its project is available.");
      }
      if (snapshot.activity !== null) {
        throw new Error("CueBench cannot adopt caption evidence while another local operation is in progress.");
      }
      if (snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can retain a recoverable caption-generation receipt.");
      }
      const projectId = snapshot.project.projectId;
      try {
        const result = await adoptPersistedCaptionGenerationResult(this.database, projectId, command);
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
          this.setSnapshot({ ...this.snapshot, error: userFacingError(error, "CueBench could not adopt the staged caption evidence.") });
        }
        throw error;
      }
    };
    const queued = this.commandQueue.then(execute, execute);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Persist the opaque signed recovery receipt before a browser polls it. */
  public persistCaptionGenerationReceipt(runId: string, receipt: unknown): Promise<void> {
    const persist = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can retain a recoverable caption-generation receipt.");
      }
      await saveRunReceipt(this.database, snapshot.project.projectId, runId, { version: 1, payload: receipt });
    };
    const queued = this.commandQueue.then(persist, persist);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Reserve the exact opaque receipt row before a server-side generation start. */
  public reserveCaptionGenerationReceipt(runId: string): Promise<void> {
    const reserve = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") {
        throw new Error("CueBench needs durable browser storage before it can reserve a recoverable caption-generation receipt.");
      }
      await reserveRunReceiptSlot(this.database, snapshot.project.projectId, runId);
    };
    const queued = this.commandQueue.then(reserve, reserve);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Release only an internal unfulfilled write-ahead reservation. */
  public releaseCaptionGenerationReceiptReservation(runId: string): Promise<void> {
    const release = async (): Promise<void> => {
      const snapshot = this.snapshot;
      if (snapshot.project === null || snapshot.mode !== "durable") return;
      await releaseRunReceiptReservation(this.database, snapshot.project.projectId, runId);
    };
    const queued = this.commandQueue.then(release, release);
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Reads only the recovery receipt belonging to the currently visible project. */
  public async loadCaptionGenerationReceipt(runId: string): Promise<unknown | null> {
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode !== "durable") return null;
    const row = await loadRunReceipt(this.database, snapshot.project.projectId, runId);
    return row?.receipt.version === 1 ? row.receipt.payload : null;
  }

  /** Lists opaque receipt ids so detached terminal cleanup can recover on reload. */
  public async listCaptionGenerationReceiptRunIds(): Promise<readonly string[]> {
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode !== "durable") return [];
    return (await listRunReceipts(this.database, snapshot.project.projectId)).map((row) => row.runId);
  }

  /** Produces a portable manifest only; source video remains in browser storage and is never serialized. */
  public async exportProjectBackup(): Promise<ProjectBackupDownload> {
    const { project, freshnessNotice } = await this.freshProjectForSerialization();
    const backup = exportProjectBackupManifest(project, { exportedAtMs: Date.now() });
    return {
      filename: buildProjectBackupFilename(project.title),
      // Domain validates this exact compact representation against the shared
      // 10 MiB import envelope; pretty indentation would otherwise turn a
      // valid aggregate into a download the same browser refuses to import.
      text: JSON.stringify(backup),
      ...(freshnessNotice === null ? {} : { freshnessNotice }),
    };
  }

  /**
   * Export serialization is intentionally owned by the store rather than a
   * possibly stale React projection. A peer-tab edit becomes an explicit UI
   * refresh before round-trip verification can record its bytes.
   */
  public async prepareTrackExport(request: ProjectTrackExportRequest): Promise<ProjectTrackExport> {
    return (await this.prepareFreshTrackExport(request)).prepared;
  }

  public async prepareFreshTrackExport(request: ProjectTrackExportRequest): Promise<FreshProjectTrackExport> {
    const { project, freshnessNotice } = await this.freshProjectForSerialization(request.project.projectId);
    if (project.projectId !== request.project.projectId) {
      throw new Error("CueBench project identity changed before export. Review the current project and try again.");
    }
    return {
      project,
      prepared: prepareDomainTrackExport({ ...request, project }),
      freshnessNotice,
    };
  }

  /** Parses and previews an import without changing local storage. This UI-only boundary always supplies Human provenance. */
  public async previewBackupText(text: string): Promise<ProjectImportDescriptor> {
    const originalEnvelope = parseBoundedBackupJson(text);
    const visibleProject = this.snapshot.project;
    const replacement = visibleProject === null
      ? null
      : await this.freshProjectForSerialization(visibleProject.projectId);
    this.pendingBackupImport = null;
    const descriptor = previewProjectImport(originalEnvelope, {
      actor: humanImportActor,
      ...(replacement === null ? {} : { replaceProject: replacement.project }),
      migration: describeImportedProject,
    });
    this.pendingBackupImport = {
      originalEnvelope: structuredClone(originalEnvelope),
      descriptor,
      relinkFile: null,
      replacement: replacement === null ? null : {
        projectId: replacement.project.projectId,
        projectRevision: replacement.project.projectRevision,
        projectHash: importReplacementHash(replacement.project),
        mode: this.snapshot.mode ?? "durable",
      },
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
      ...(pending.descriptor.replacementSafetyBackup === null
        ? {}
        : { replaceProject: pending.descriptor.replacementSafetyBackup.backup.project }),
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
      || initiallySnapshot.activity !== null
    ) {
      throw new Error("CueBench needs a compatible preview and a SHA-256-verified media relink before import.");
    }

    this.invalidateOperations();
    const importEpoch = this.operationEpoch;
    this.setSnapshot({ ...initiallySnapshot, activity: "importing", error: null, cleanupNotice: null });
    try {
      /** Let any already-started persistent command settle before replacing its project namespace. */
      await this.commandQueue;
      if (!this.isCurrent(importEpoch)) throw new Error("CueBench stopped this import before it could commit.");
      const current = this.snapshot;
      const pending = this.pendingBackupImport;
      if (pending === null || pending.descriptor.mode !== "preview" || pending.relinkFile === null) {
        throw new Error("CueBench's import preview changed before confirmation. Preview the backup again.");
      }
      const replacementProject = await this.canonicalReplacementForImport(pending, current);
      const relinkFile = pending.relinkFile;

      const [inspected, sha256] = await Promise.all([
        inspectLocalMedia(relinkFile, this.mediaDurationProbe),
        hashLocalMedia(relinkFile),
      ]);
      if (!this.isCurrent(importEpoch)) throw new Error("CueBench stopped this import before it could commit.");
      const exactPreview = previewProjectImport(pending.originalEnvelope, {
        actor: humanImportActor,
        ...(replacementProject === null ? {} : { replaceProject: replacementProject }),
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

      const importedProject = exactPreview.project;
      const backupId = this.createId();
      // A portable backup never imports browser authority. Generate the next
      // project-instance capability before entering the Dexie transaction and
      // persist it with the replacement rows, so an old tab's local receipt
      // cannot be accepted after the imported project becomes authoritative.
      const importedProjectOwnerCapability: ProjectInstanceOwnerCapability = {
        version: 1,
        projectId: importedProject.projectId,
        capability: createProjectInstanceOwnerCapability(),
      };
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
      /** Candidate media stays live only after both its second hash and durable transaction succeed. */
      const preparedObjectUrl = objectUrlLease.prepare(relinkFile);
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
            const existingTarget = await this.database.projectHeaders.get(importedProject.projectId);
            let exactReplacement: CaptionProject | null = null;
            if (pending.replacement !== null && pending.replacement.mode === "durable") {
              const expected = pending.replacement;
              const header = await this.database.projectHeaders.get(expected.projectId);
              const canonical = header === undefined ? undefined : await loadProjectInTransaction(this.database, expected.projectId);
              if (
                header === undefined
                || canonical === undefined
                || header.projectRevision !== expected.projectRevision
                || canonical.projectRevision !== expected.projectRevision
                || importReplacementHash(canonical) !== expected.projectHash
              ) {
                throw new Error("CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again before importing.");
              }
              exactReplacement = canonical;
              if (existingTarget !== undefined && importedProject.projectId !== expected.projectId) {
                throw new Error("CueBench cannot overwrite another local project while importing this backup.");
              }
            } else if (pending.replacement !== null) {
              /**
               * A temporary page-memory project normally has no durable
               * namespace. Recheck that exact id inside this transaction:
               * another tab may have imported it while this tab was waiting
               * for a Human relink confirmation.
               */
              const temporaryReplacement = pending.replacement;
              const [durableHeader, durableMode] = await Promise.all([
                this.database.projectHeaders.get(temporaryReplacement.projectId),
                this.database.settings.get(projectModeKey(temporaryReplacement.projectId)),
              ]);
              if (durableHeader !== undefined || readMode(durableMode?.value) === "durable") {
                throw new Error("CueBench's temporary replacement project was saved durably after this preview. Preview the backup again before importing.");
              }
              exactReplacement = replacementProject;
              if (existingTarget !== undefined) {
                throw new Error("CueBench cannot overwrite another local project while importing this backup.");
              }
            } else if (existingTarget !== undefined) {
              throw new Error("CueBench cannot overwrite a project created after this import preview. Preview the backup again.");
            }

            /** Recovery snapshots are built from the exact canonical target observed by the transaction, never a stale React projection. */
            await this.database.settings.put({
              key: importSafetyBackupKey(importedProject.projectId, backupId),
              value: exactPreview.safetyBackup,
              updatedAtMs: Date.now(),
            });
            if (exactReplacement !== null) {
              await this.database.settings.put({
                key: replacementSafetyBackupKey(exactReplacement.projectId, backupId),
                value: {
                  projectId: exactReplacement.projectId,
                  backup: exportProjectBackupManifest(exactReplacement),
                },
                updatedAtMs: Date.now(),
              });
              await this.deleteProjectRows(exactReplacement.projectId);
              /** Keep the just-written recovery copies during an import replacement. */
              await this.deleteProjectSettings(exactReplacement.projectId, false);
            }
            await initializeProject(this.database, importedProject);
            await this.database.sourceBlobs.add(verifiedMediaRow);
            await this.database.settings.put({ key: projectModeKey(importedProject.projectId), value: { mode: "durable" }, updatedAtMs: Date.now() });
            await this.database.settings.put({
              key: projectInstanceOwnerCapabilityKey(importedProject.projectId),
              value: importedProjectOwnerCapability,
              updatedAtMs: Date.now(),
            });
            await this.database.settings.put({ key: projectSourceProvenanceKey(importedProject.projectId), value: uploadedSourceProvenance, updatedAtMs: Date.now() });
            await this.database.settings.put({ key: lastDurableProjectKey, value: { projectId: importedProject.projectId }, updatedAtMs: Date.now() });
          },
        );
      } catch (error) {
        preparedObjectUrl.revoke();
        throw error;
      }

      if (!this.isCurrent(importEpoch)) {
        preparedObjectUrl.revoke();
        throw new Error("CueBench stopped this import after local storage committed. Reopen the project to continue from the durable copy.");
      }

      /** No await is permitted after this point: storage is committed, so the UI always advances to the same verified media URL. */
      let postCommitIssue: string | null = null;
      try {
        this.afterImportCommitted?.();
      } catch (error) {
        postCommitIssue = userFacingError(error, "CueBench recovered the imported project after a UI update fault.");
      }
      const sourceObjectUrl = objectUrlLease.adopt(preparedObjectUrl);
      const cleanupNotice = "Imported project is stored in this browser. The selected local video was verified through Media Relink before replacement.";
      this.pendingBackupImport = null;
      this.setSnapshot({
        route: "workbench",
        project: importedProject,
        mode: "durable",
        sourceObjectUrl,
        sourceProvenance: uploadedSourceProvenance,
        pendingUpload: null,
        activity: null,
        error: postCommitIssue === null ? null : `Imported project recovered locally: ${postCommitIssue}`,
        cleanupNotice,
      });
      return { project: importedProject, cleanupNotice };
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

      let deletionReceipt: DeletionReceipt | null = null;
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
            const canonical = await loadProjectInTransaction(this.database, current.project!.projectId);
            if (canonical === undefined) {
              throw new Error("CueBench's project was already removed by another browser tab.");
            }
            deletionReceipt = this.newDeletionReceipt(canonical);
            await this.deleteProjectRows(canonical.projectId);
            await this.deleteProjectSettings(canonical.projectId, true);
            const durablePointer = await this.database.settings.get(lastDurableProjectKey);
            if (readProjectId(durablePointer?.value) === canonical.projectId) {
              await this.database.settings.delete(lastDurableProjectKey);
            }
            await this.database.settings.put({
              key: deletionReceiptKey(deletionReceipt.projectId, deletionReceipt.receiptId),
              value: deletionReceipt,
              updatedAtMs: Date.now(),
            });
          },
        );
      } else {
        deletionReceipt = this.newDeletionReceipt(current.project);
        await this.database.settings.put({
          key: deletionReceiptKey(deletionReceipt.projectId, deletionReceipt.receiptId),
          value: deletionReceipt,
          updatedAtMs: Date.now(),
        });
      }

      if (deletionReceipt === null) throw new Error("CueBench could not retain the local deletion receipt.");
      this.objectUrlLease?.revoke();
      const cloudCleanup: CloudCleanupResult = {
        status: "pending",
        message: "Cloud cleanup is pending lifecycle enforcement; CueBench will record the hosted result when it is confirmed.",
      };
      const cleanupNotice = `Local project copy deleted. ${cloudCleanup.message}`;
      this.activeCleanupReceiptId = deletionReceipt.receiptId;
      this.setSnapshot({ ...emptySnapshot(), cleanupNotice });
      void this.runCloudCleanupInBackground(deletionReceipt);
      return { localDeleted: true, cloudCleanup, cleanupNotice, receiptId: deletionReceipt.receiptId };
    } catch (error) {
      if (this.snapshot.activity === "deleting") {
        this.setSnapshot({ ...this.snapshot, activity: null, error: userFacingError(error, "CueBench could not delete this local project.") });
      }
      throw error;
    }
  }

  /** Lets a future lifecycle surface retry a retained hosted-cleanup receipt without recreating local project data. */
  public async retryCloudCleanup(receiptId: string): Promise<CloudCleanupResult> {
    const active = this.cleanupOperations.get(receiptId);
    if (active !== undefined) return active;
    const receipt = await this.findDeletionReceipt(receiptId);
    if (receipt === null) throw new Error("CueBench could not find that local deletion receipt.");
    this.activeCleanupReceiptId = receipt.receiptId;
    if (receipt.state === "deleted") return this.cloudCleanupResultFor(receipt);
    return this.completeCloudCleanup(receipt);
  }

  /** Cancels stale async continuations and releases the only live local-media URL. */
  public dispose(): void {
    this.invalidateOperations();
    this.pendingBackupImport = null;
    this.activeCleanupReceiptId = null;
    this.objectUrlLease?.revokePrepared();
    this.objectUrlLease?.revoke();
    if (this.snapshot.route !== "start" || this.snapshot.sourceObjectUrl !== null || this.snapshot.activity !== null) {
      this.setSnapshot(emptySnapshot());
    }
  }

  /** Reads the durable aggregate after page commands settle, never serializing an abandoned peer-tab projection. */
  private async freshProjectForSerialization(expectedProjectId?: string): Promise<{ readonly project: CaptionProject; readonly freshnessNotice: string | null }> {
    await this.commandQueue;
    const snapshot = this.snapshot;
    if (snapshot.project === null || snapshot.mode === null) {
      throw new Error("CueBench cannot serialize a project before its media is available.");
    }
    if (expectedProjectId !== undefined && snapshot.project.projectId !== expectedProjectId) {
      throw new Error("CueBench project identity changed before serialization. Review the current project and try again.");
    }
    if (snapshot.mode !== "durable") return { project: snapshot.project, freshnessNotice: null };

    const canonical = await loadProject(this.database, snapshot.project.projectId);
    if (canonical === undefined) {
      throw new Error("CueBench's durable project was removed before it could be serialized.");
    }
    const stale = canonical.projectRevision !== snapshot.project.projectRevision
      || importReplacementHash(canonical) !== importReplacementHash(snapshot.project);
    if (!stale) return { project: canonical, freshnessNotice: null };

    const freshnessNotice = "This project changed in another browser tab. CueBench refreshed to its durable revision before serialization.";
    if (this.snapshot.project?.projectId === canonical.projectId && this.snapshot.mode === "durable") {
      this.setSnapshot({ ...this.snapshot, project: canonical, error: freshnessNotice });
    }
    return { project: canonical, freshnessNotice };
  }

  /** Rechecks the immutable preview target before hashing/relink work and again inside the write transaction. */
  private async canonicalReplacementForImport(
    pending: PendingBackupImport,
    snapshot: ProjectStoreSnapshot,
  ): Promise<CaptionProject | null> {
    const expected = pending.replacement;
    if (expected === null) return null;
    if (
      snapshot.project === null
      || snapshot.mode !== expected.mode
      || snapshot.project.projectId !== expected.projectId
    ) {
      throw new Error("CueBench's replacement project changed before import. Preview the backup again.");
    }
    if (expected.mode === "temporary") {
      if (
        snapshot.project.projectRevision !== expected.projectRevision
        || importReplacementHash(snapshot.project) !== expected.projectHash
      ) {
        throw new Error("CueBench's replacement project changed before import. Preview the backup again.");
      }
      return snapshot.project;
    }
    const canonical = await loadProject(this.database, expected.projectId);
    if (
      canonical === undefined
      || canonical.projectRevision !== expected.projectRevision
      || importReplacementHash(canonical) !== expected.projectHash
    ) {
      if (this.snapshot.project?.projectId === expected.projectId) {
        this.setSnapshot({
          ...this.snapshot,
          ...(canonical === undefined ? {} : { project: canonical }),
          error: "CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again.",
        });
      }
      throw new Error("CueBench's replacement project changed, was deleted, or was recreated after this preview. Preview the backup again.");
    }
    return canonical;
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
  private async claimProjectOwnership(projectId: string): Promise<string> {
    const token = this.createId();
    const instanceCapability: ProjectInstanceOwnerCapability = {
      version: 1,
      projectId,
      capability: createProjectInstanceOwnerCapability(),
    };
    try {
      await this.database.transaction("rw", [this.database.projectHeaders, this.database.settings], async () => {
        const [existingProject, existingOwner, existingInstanceCapability] = await Promise.all([
          this.database.projectHeaders.get(projectId),
          this.database.settings.get(projectOwnerKey(projectId)),
          this.database.settings.get(projectInstanceOwnerCapabilityKey(projectId)),
        ]);
        if (existingProject !== undefined || existingOwner !== undefined || existingInstanceCapability !== undefined) {
          throw new Error("CueBench could not claim a unique local project. Try opening the media again.");
        }
        await this.database.settings.add({
          key: projectOwnerKey(projectId),
          value: { projectId, token },
          updatedAtMs: Date.now(),
        });
        await this.database.settings.add({
          key: projectInstanceOwnerCapabilityKey(projectId),
          value: instanceCapability,
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
    return instanceCapability.capability;
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
            this.database.settings.delete(projectInstanceOwnerCapabilityKey(projectId)),
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
        || key === projectInstanceOwnerCapabilityKey(projectId)
        || key === projectSourceProvenanceKey(projectId)
        || (includeSafetyBackups && (
          key.startsWith(`import-safety-backup:${projectId}:`)
          || key.startsWith(`replacement-safety-backup:${projectId}:`)
        ))
      ));
    if (keys.length > 0) await this.database.settings.bulkDelete(keys);
  }

  private newDeletionReceipt(project: CaptionProject): DeletionReceipt {
    return {
      receiptId: `delete-${this.createId()}`,
      projectId: project.projectId,
      sourceId: project.media.sourceId,
      activeRunId: project.activeGenerationRun?.runId ?? null,
      createdAtMs: Date.now(),
      attempts: 0,
      state: "pending",
      message: "Cloud cleanup is pending lifecycle enforcement.",
    };
  }

  private deletionReceiptFrom(value: unknown): DeletionReceipt | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (
      typeof record.receiptId !== "string"
      || typeof record.projectId !== "string"
      || typeof record.sourceId !== "string"
      || (record.activeRunId !== null && typeof record.activeRunId !== "string")
      || typeof record.createdAtMs !== "number"
      || typeof record.attempts !== "number"
      || (record.state !== "pending" && record.state !== "deleted" && record.state !== "failed")
      || typeof record.message !== "string"
    ) return null;
    return record as unknown as DeletionReceipt;
  }

  private cloudCleanupResultFor(receipt: DeletionReceipt): CloudCleanupResult {
    return {
      status: receipt.state,
      message: receipt.message,
    };
  }

  private async findDeletionReceipt(receiptId: string): Promise<DeletionReceipt | null> {
    const setting = (await this.database.settings.toArray()).find((candidate) => {
      const value = this.deletionReceiptFrom(candidate.value);
      return value?.receiptId === receiptId;
    });
    return setting === undefined ? null : this.deletionReceiptFrom(setting.value);
  }

  private async currentDeletionReceipt(receipt: DeletionReceipt): Promise<DeletionReceipt | null> {
    const setting = await this.database.settings.get(deletionReceiptKey(receipt.projectId, receipt.receiptId));
    return setting === undefined ? null : this.deletionReceiptFrom(setting.value);
  }

  private async runCloudCleanupInBackground(receipt: DeletionReceipt): Promise<void> {
    try {
      await this.completeCloudCleanup(receipt);
    } catch {
      // Local deletion already completed. Retained receipt metadata makes a later explicit retry possible.
    }
  }

  /** Deduplicates same-store retries before an async database or cloud boundary can interleave. */
  private completeCloudCleanup(receipt: DeletionReceipt): Promise<CloudCleanupResult> {
    const active = this.cleanupOperations.get(receipt.receiptId);
    if (active !== undefined) return active;
    const operation = this.completeCloudCleanupAttempt(receipt).finally(() => {
      if (this.cleanupOperations.get(receipt.receiptId) === operation) {
        this.cleanupOperations.delete(receipt.receiptId);
      }
    });
    this.cleanupOperations.set(receipt.receiptId, operation);
    return operation;
  }

  private async completeCloudCleanupAttempt(receipt: DeletionReceipt): Promise<CloudCleanupResult> {
    const current = await this.currentDeletionReceipt(receipt);
    if (current === null) {
      return {
        status: "pending",
        message: "CueBench could not find the retained deletion receipt. Cloud cleanup remains pending lifecycle enforcement.",
      };
    }
    if (current.state === "deleted") return this.cloudCleanupResultFor(current);
    const result = await this.requestCloudCleanup({
      projectId: current.projectId,
      sourceId: current.sourceId,
      activeRunId: current.activeRunId,
      cancelActiveWork: true,
    });
    let retained: DeletionReceipt | null;
    try {
      retained = await this.persistCloudCleanupResult(current, result);
    } catch {
      // Do not falsely report a successful hosted cleanup as a durable lifecycle receipt update.
      return {
        status: "pending",
        message: "Cloud cleanup returned a result, but CueBench could not retain its deletion receipt. Cleanup remains pending lifecycle enforcement.",
      };
    }
    if (retained === null) {
      return {
        status: "pending",
        message: "CueBench could not retain the current deletion receipt. Cloud cleanup remains pending lifecycle enforcement.",
      };
    }
    const finalResult = this.cloudCleanupResultFor(retained);
    if (
      this.activeCleanupReceiptId === receipt.receiptId
      && this.snapshot.route === "start"
      && this.snapshot.project === null
    ) {
      this.setSnapshot({
        ...this.snapshot,
        cleanupNotice: `Local project copy deleted. ${finalResult.message}`,
      });
    }
    return finalResult;
  }

  /**
   * The receipt is the cross-tab CAS boundary. `deleted` is terminal: a
   * delayed timeout or failure may never downgrade it after another tab has
   * confirmed remote deletion.
   */
  private async persistCloudCleanupResult(
    receipt: DeletionReceipt,
    result: CloudCleanupResult,
  ): Promise<DeletionReceipt | null> {
    let retained: DeletionReceipt | null = null;
    await this.database.transaction("rw", [this.database.settings], async () => {
      const setting = await this.database.settings.get(deletionReceiptKey(receipt.projectId, receipt.receiptId));
      const current = setting === undefined ? null : this.deletionReceiptFrom(setting.value);
      if (current === null) return;
      if (current.state === "deleted") {
        retained = current;
        return;
      }
      const state = result.status === "deleted"
        ? "deleted"
        : current.state === "failed" || result.status === "failed"
          ? "failed"
          : "pending";
      const message = state === "failed" && result.status === "pending"
        ? current.message
        : result.message;
      retained = {
        ...current,
        attempts: current.attempts + 1,
        state,
        message,
      };
      await this.database.settings.put({
        key: deletionReceiptKey(receipt.projectId, receipt.receiptId),
        value: retained,
        updatedAtMs: Date.now(),
      });
    });
    return retained;
  }

  private async requestCloudCleanup(request: CloudCleanupRequest): Promise<CloudCleanupResult> {
    if (this.cloudCleanup === undefined) {
      return {
        status: "pending",
        message: "Cloud cleanup remains pending lifecycle enforcement because no hosted cleanup hook is configured for this browser session.",
      };
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<CloudCleanupResult>((resolve) => {
      timeout = setTimeout(() => resolve({
        status: "pending",
        message: "Cloud cleanup did not confirm before the local lifecycle timeout and remains pending lifecycle enforcement.",
      }), this.cloudCleanupTimeoutMs);
    });
    const requested = Promise.resolve()
      .then(() => this.cloudCleanup!(request))
      .then((result): CloudCleanupResult => {
        if (
          (result.status === "deleted" || result.status === "pending" || result.status === "failed")
          && typeof result.message === "string"
          && result.message.trim().length > 0
        ) return result;
        return {
          status: "pending",
          message: "Cloud cleanup returned an incomplete status and remains pending lifecycle enforcement.",
        };
      })
      .catch((): CloudCleanupResult => ({
        status: "failed",
        message: "Cloud cleanup could not be confirmed and remains pending lifecycle enforcement.",
      }));
    const result = await Promise.race([requested, timedOut]);
    if (timeout !== null) clearTimeout(timeout);
    return result;
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
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /** A view subscriber must not roll a committed local lifecycle transition back to an obsolete object URL. */
      }
    }
  }
}

export const loadProjectMode = async (database: CueBenchDatabase, projectId: string): Promise<ProjectMode | null> => {
  const setting = await loadSetting(database, projectModeKey(projectId));
  return setting === undefined ? null : readMode(setting.value);
};
