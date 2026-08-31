import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createProject,
  exportProjectBackup,
  type CaptionProject,
  type ProjectImportDescriptor,
  type ProjectImportPreview,
} from "@cuebench/domain";
import { CueBenchDatabase, loadProject, saveNarrationBlob } from "@cuebench/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupDialog, type BackupManager } from "./BackupDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { ObjectUrlLease } from "./local-media";
import { ProjectStore } from "./project-store";
import { loadPersistedCloudUpload, type CloudUploadReceiptStore } from "./cloud-upload";

const projectFixture = (): CaptionProject => createProject({
  projectId: "backup-ui",
  title: "Gibbs free energy lesson",
  media: {
    sourceId: "lesson-video",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
});

const newerDescriptor: ProjectImportDescriptor = {
  mode: "read-only",
  readOnly: true,
  requiresHumanConfirmation: true,
  requiresSafetyBackup: false,
  safetyBackup: null,
  replacementSafetyBackup: null,
  schemaVersion: 2,
  reason: "NEWER_SCHEMA",
  project: {
    projectId: "future-project",
    title: "Future CueBench project",
    projectRevision: 12,
    captions: { order: ["future-c01", "future-c02"], items: { "future-c01": {}, "future-c02": {} } },
    audioDescriptions: { order: ["future-ad01"], items: { "future-ad01": {} } },
    qualityProfile: { profileId: "future-profile", name: "Future Profile" },
    certification: { status: "Current" },
    media: { sha256: "f".repeat(64) },
  },
  canImport: false,
};

const mismatchDescriptor = (): ProjectImportPreview => ({
  mode: "preview",
  readOnly: false,
  requiresHumanConfirmation: true,
  requiresSafetyBackup: true,
  safetyBackup: {
    required: true,
    projectId: null,
    originalEnvelope: { schemaVersion: 1 },
    originalEnvelopeHash: `sha256:${"a".repeat(64)}`,
    actor: { type: "Human", id: "human" },
    reason: "IMPORT",
  },
  replacementSafetyBackup: null,
  schemaVersion: 1,
  migratedFrom: null,
  project: projectFixture(),
  mediaRelink: {
    status: "mismatch",
    expectedSha256: "a".repeat(64),
    actualSha256: "b".repeat(64),
    error: { code: "MEDIA_HASH_MISMATCH", message: "The selected media does not match the SHA-256 recorded by this project backup." },
  },
  canImport: false,
});

const verifiedDescriptor = (): ProjectImportPreview => ({
  ...mismatchDescriptor(),
  mediaRelink: {
    status: "verified",
    expectedSha256: "a".repeat(64),
    actualSha256: "a".repeat(64),
  },
  canImport: true,
});

const manager = (descriptor: ProjectImportDescriptor): BackupManager => ({
  exportProjectBackup: vi.fn(async () => ({
    filename: "gibbs-free-energy-lesson.cuebench.json",
    text: JSON.stringify(exportProjectBackup(projectFixture())),
  })),
  previewBackupText: vi.fn(async () => descriptor),
  relinkImportedMedia: vi.fn(async () => descriptor),
  importPreviewedBackup: vi.fn(async () => ({
    project: projectFixture(),
    cleanupNotice: "Imported project is stored in this browser.",
  })),
});

const browserStorage = () => ({
  estimate: async () => ({ quota: 100_000_000, usage: 0 }),
  persist: async () => true,
});

const bundledFile = (): File => Object.assign(new Blob(["fixture-media"], { type: "video/mp4" }), {
  name: "fixture.mp4",
  lastModified: 0,
}) as File;

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const countedProjectFixture = (): CaptionProject => createProject({
  projectId: "incoming-counted-project",
  title: "Incoming counted lesson",
  media: {
    sourceId: "incoming-video",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [
    { kind: "CaptionCue", itemId: "incoming-c01", state: "Proposed", startMs: 1_000, endMs: 2_000, text: "First incoming caption.", speaker: null, actor: { type: "CueBenchAI", id: "cuebench-ai" }, cause: "fixture" },
    { kind: "CaptionCue", itemId: "incoming-c02", state: "Proposed", startMs: 3_000, endMs: 4_000, text: "Second incoming caption.", speaker: null, actor: { type: "CueBenchAI", id: "cuebench-ai" }, cause: "fixture" },
  ],
  audioDescriptions: [
    { kind: "AudioDescriptionBeat", itemId: "incoming-ad01", state: "Proposed", startMs: 5_000, endMs: 6_000, description: "A graph is visible.", actor: { type: "CueBenchAI", id: "cuebench-ai" }, cause: "fixture" },
  ],
});

afterEach(() => cleanup());

describe("Backup, relink, and deletion human workflows", () => {
  it("opens a newer backup read-only and never offers destructive import", async () => {
    const backupManager = manager(newerDescriptor);
    render(<BackupDialog project={projectFixture()} manager={backupManager} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.change(within(dialog).getByLabelText("Choose CueBench backup"), {
      target: { files: [new File(["{}"], "newer.cuebench.json", { type: "application/json" })] },
    });

    expect(await within(dialog).findByText(/read-only/i)).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Read-only portable backup inspector" })).toBeVisible();
    expect(within(dialog).getByText("Incoming title")).toBeVisible();
    expect(within(dialog).getByText("Future CueBench project")).toBeVisible();
    expect(within(dialog).getByText("Caption items").parentElement).toHaveTextContent("2");
    expect(within(dialog).getByText("Audio-description items").parentElement).toHaveTextContent("1");
    expect(within(dialog).queryByLabelText("Choose CueBench backup")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Create project backup" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Confirm import after relink" })).not.toBeInTheDocument();
  });

  it("creates a safety-backed preview but requires matching SHA-256 media before import", async () => {
    const backupManager = manager(mismatchDescriptor());
    render(<BackupDialog project={projectFixture()} manager={backupManager} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.change(within(dialog).getByLabelText("Choose CueBench backup"), {
      target: { files: [new File(["{}"], "backup.cuebench.json", { type: "application/json" })] },
    });

    expect(await within(dialog).findByText(/safety backup/i)).toBeVisible();
    expect(within(dialog).getByText("Incoming identity")).toBeVisible();
    expect(within(dialog).getByText("Schema version")).toBeVisible();
    expect(within(dialog).getByText(/New project/i)).toBeVisible();
    expect(within(dialog).getByText(/does not match the SHA-256/i)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Confirm import after relink" })).toBeDisabled();
  });

  it("reads portable track order and items for incoming facts and replacement diffs", async () => {
    const previous = projectFixture();
    const incoming = countedProjectFixture();
    const descriptor: ProjectImportDescriptor = {
      ...verifiedDescriptor(),
      project: incoming,
      replacementSafetyBackup: { projectId: previous.projectId, backup: exportProjectBackup(previous) },
    };
    const backupManager = manager(descriptor);
    render(<BackupDialog project={previous} manager={backupManager} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.change(within(dialog).getByLabelText("Choose CueBench backup"), {
      target: { files: [new File(["{}"], "counted.cuebench.json", { type: "application/json" })] },
    });

    await within(dialog).findByText("Replacement diff");
    const captions = within(dialog).getAllByText("Caption items");
    const descriptions = within(dialog).getAllByText("Audio-description items");
    expect(captions[0]!.parentElement).toHaveTextContent("2");
    expect(descriptions[0]!.parentElement).toHaveTextContent("1");
    expect(captions[1]!.parentElement).toHaveTextContent("0 → 2");
    expect(descriptions[1]!.parentElement).toHaveTextContent("0 → 1");
  });

  it("allows import only after a verified media relink and explicit human confirmation", async () => {
    const backupManager = manager(verifiedDescriptor());
    render(<BackupDialog project={projectFixture()} manager={backupManager} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.change(within(dialog).getByLabelText("Choose CueBench backup"), {
      target: { files: [new File(["{}"], "backup.cuebench.json", { type: "application/json" })] },
    });
    const confirm = await within(dialog).findByRole("button", { name: "Confirm import after relink" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(backupManager.importPreviewedBackup).toHaveBeenCalledTimes(1));
  });

  it("clears a stale backup request when the project changes, keeps Close available, and never publishes its late URL", async () => {
    const project = projectFixture();
    const backup = deferred<{ readonly filename: string; readonly text: string }>();
    const urlApi = { createObjectURL: vi.fn(() => "blob:cuebench:backup"), revokeObjectURL: vi.fn() };
    const backupManager: BackupManager = {
      ...manager(verifiedDescriptor()),
      exportProjectBackup: vi.fn(() => backup.promise),
    };
    const view = render(<BackupDialog project={project} manager={backupManager} urlApi={urlApi} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project backup" }));
    expect(within(dialog).getByRole("button", { name: "Create project backup" })).toBeDisabled();

    view.rerender(<BackupDialog project={{ ...project, projectRevision: project.projectRevision + 1, title: "Changed backup title" }} manager={backupManager} urlApi={urlApi} />);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create project backup" })).toBeEnabled());
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Project backup and import" })).not.toBeInTheDocument();
    backup.resolve({ filename: "late.cuebench.json", text: "{}" });
    await Promise.resolve();
    expect(urlApi.createObjectURL).not.toHaveBeenCalled();
  });

  it("clears an in-flight import when the imported project projection replaces the old dialog props", async () => {
    const project = projectFixture();
    const imported = { ...countedProjectFixture(), projectRevision: 3 };
    const importGate = deferred<{ readonly project: CaptionProject; readonly cleanupNotice: string }>();
    const backupManager: BackupManager = {
      ...manager(verifiedDescriptor()),
      importPreviewedBackup: vi.fn(() => importGate.promise),
    };
    const view = render(<BackupDialog project={project} manager={backupManager} />);

    fireEvent.click(screen.getByRole("button", { name: "Project backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Project backup and import" });
    fireEvent.change(within(dialog).getByLabelText("Choose CueBench backup"), {
      target: { files: [new File(["{}"], "verified.cuebench.json", { type: "application/json" })] },
    });
    const confirm = await within(dialog).findByRole("button", { name: "Confirm import after relink" });
    fireEvent.click(confirm);
    expect(confirm).toBeDisabled();

    view.rerender(<BackupDialog project={imported} manager={backupManager} />);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled());
    importGate.resolve({ project: imported, cleanupNotice: "Late old import status" });
    await Promise.resolve();
    expect(within(dialog).queryByText("Late old import status")).not.toBeInTheDocument();
  });

  it("persists both safety backups and replaces local rows only after an exact Media Relink", async () => {
    const database = new CueBenchDatabase(`task-10-import-${crypto.randomUUID()}`);
    const urls = new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:import"), revokeObjectURL: vi.fn() });
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: urls,
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await store.openSample();
    const before = store.getSnapshot().project;
    if (before === null) throw new Error("Expected a stored project.");

    const portable = await store.exportProjectBackup();
    const preview = await store.previewBackupText(portable.text);
    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") throw new Error("Expected an import preview.");
    expect(preview.mediaRelink.status).toBe("required");

    const relinked = await store.relinkImportedMedia(bundledFile());
    expect(relinked.mode).toBe("preview");
    if (relinked.mode !== "preview") throw new Error("Expected a relink preview.");
    expect(relinked.mediaRelink.status).toBe("verified");
    const result = await store.importPreviewedBackup();

    expect(result.project.projectId).toBe(before.projectId);
    expect(store.getSnapshot().mode).toBe("durable");
    expect(store.getSnapshot().project?.media.relinkState).toBe("Linked");
    expect(await loadProject(database, before.projectId)).toMatchObject({ projectId: before.projectId });
    expect((await database.settings.toArray()).some((setting) => setting.key.startsWith(`import-safety-backup:${before.projectId}:`))).toBe(true);
    expect((await database.settings.toArray()).some((setting) => setting.key.startsWith(`replacement-safety-backup:${before.projectId}:`))).toBe(true);
    await database.delete();
  });

  it("rotates the durable non-portable project-instance owner on import and rejects old-tab cloud recovery without deleting localStorage", async () => {
    const database = new CueBenchDatabase(`task-13-owner-import-${crypto.randomUUID()}`);
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:owner-first"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await first.openSample();
    const project = first.getSnapshot().project;
    if (project === null) throw new Error("Expected a durable project.");
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:owner-second"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await second.restoreLastDurableProject();

    const oldOwner = await first.getCloudProjectOwnerCapability(project.projectId);
    expect(oldOwner).toMatch(/^[0-9a-f]{64}$/);
    expect(await second.getCloudProjectOwnerCapability(project.projectId)).toBe(oldOwner);
    const portable = await first.exportProjectBackup();
    expect(portable.text).not.toContain(oldOwner!);

    const values = new Map<string, unknown>();
    const receiptStore: CloudUploadReceiptStore = {
      load: (key) => values.get(key) ?? null,
      save: (key, value) => { values.set(key, value); },
      remove: (key) => { values.delete(key); },
    };
    const staleReceiptKey = `cuebench-cloud-upload:${project.projectId}`;
    values.set(staleReceiptKey, {
      version: 1,
      projectId: project.projectId,
      operationId: "old-import-operation",
      sourceByteLength: 13,
      sourceSha256: project.media.sha256,
      sourceContentType: "video/mp4",
      durationMs: project.media.durationMs,
      projectOwnerCapability: oldOwner,
      operationReceipt: "opaque-old-operation",
      uploadCapability: "opaque-old-upload",
      partSize: 13,
      partCount: 1,
      partReceipts: {},
    });

    await first.previewBackupText(portable.text);
    await first.relinkImportedMedia(bundledFile());
    await first.importPreviewedBackup();

    const freshOwner = await first.getCloudProjectOwnerCapability(project.projectId);
    expect(freshOwner).toMatch(/^[0-9a-f]{64}$/);
    expect(freshOwner).not.toBe(oldOwner);
    // The second (older) tab bypasses its stale React projection and reads
    // the fresh capability from IndexedDB before any cloud mutation.
    expect(await second.getCloudProjectOwnerCapability(project.projectId)).toBe(freshOwner);
    expect(loadPersistedCloudUpload(
      project.projectId,
      { sha256: project.media.sha256, durationMs: project.media.durationMs },
      receiptStore,
      freshOwner!,
    )).toBeNull();
    // Correctness comes from the durable owner comparison, not a best-effort
    // localStorage remove that could race another tab's recovery read.
    expect(values.get(staleReceiptKey)).toMatchObject({ projectOwnerCapability: oldOwner });
    await database.delete();
  });

  it("requires a confirmed deletion, clears local tables and narration, and reports cloud cleanup as pending", async () => {
    const database = new CueBenchDatabase(`task-10-delete-${crypto.randomUUID()}`);
    const createObjectURL = vi.fn(() => "blob:cuebench:project");
    const revokeObjectURL = vi.fn();
    const cloudCleanup = vi.fn(async () => ({ status: "pending" as const, message: "Cloud cleanup remains pending lifecycle enforcement." }));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL, revokeObjectURL }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
    });
    await store.openSample();
    const liveProject = store.getSnapshot().project;
    if (liveProject === null) throw new Error("Expected a stored project.");
    await saveNarrationBlob(database, liveProject.projectId, {
      beatId: "ad01",
      itemRevision: 1,
      cacheKey: "a".repeat(64),
      blob: new Blob(["narration"], { type: "audio/mpeg" }),
      measuredDurationMs: 1_000,
    });

    render(<DeleteProjectDialog project={liveProject} onDelete={() => store.deleteCurrentProject()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete CueBench project" });
    const confirm = within(dialog).getByRole("button", { name: "Delete this local project" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Type the project title to confirm deletion"), { target: { value: liveProject.title } });
    fireEvent.click(confirm);

    expect(await within(dialog).findByRole("status")).toHaveTextContent("Cloud cleanup is pending lifecycle enforcement");
    expect(cloudCleanup).toHaveBeenCalledWith(expect.objectContaining({ projectId: liveProject.projectId, cancelActiveWork: true }));
    expect(await loadProject(database, liveProject.projectId)).toBeUndefined();
    await expect(database.narrationBlobs.where("projectId").equals(liveProject.projectId).count()).resolves.toBe(0);
    await expect(database.sourceBlobs.where("projectId").equals(liveProject.projectId).count()).resolves.toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cuebench:project");
    await database.delete();
  });

  it("aborts an import preview after a peer tab edits the replacement project and keeps its old media URL live", async () => {
    const database = new CueBenchDatabase(`task-10-import-cas-edit-${crypto.randomUUID()}`);
    const oldUrl = "blob:cuebench:old";
    const revokeObjectURL = vi.fn();
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => oldUrl), revokeObjectURL }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await first.openSample();
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:peer"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await second.restoreLastDurableProject();
    const before = first.getSnapshot().project!;

    await first.previewBackupText((await first.exportProjectBackup()).text);
    await first.relinkImportedMedia(bundledFile());
    await second.executeCommand({
      type: "AppendCourtRecord",
      actor: { type: "System", id: "cuebench" },
      expectedProjectRevision: second.getSnapshot().project!.projectRevision,
      eventType: "ProjectSerialized",
      deterministic: true,
    });

    await expect(first.importPreviewedBackup()).rejects.toThrow(/replacement project changed/i);
    expect(first.getSnapshot().sourceObjectUrl).toBe(oldUrl);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(oldUrl);
    expect((await loadProject(database, before.projectId))?.projectRevision).toBe(2);
    await database.delete();
  });

  it("aborts an import preview after a peer tab deletes the replacement project", async () => {
    const database = new CueBenchDatabase(`task-10-import-cas-delete-${crypto.randomUUID()}`);
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:old"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await first.openSample();
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:peer"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await second.restoreLastDurableProject();
    const projectId = first.getSnapshot().project!.projectId;

    await first.previewBackupText((await first.exportProjectBackup()).text);
    await first.relinkImportedMedia(bundledFile());
    await second.deleteCurrentProject();

    await expect(first.importPreviewedBackup()).rejects.toThrow(/deleted|replacement project changed/i);
    await expect(loadProject(database, projectId)).resolves.toBeUndefined();
    await database.delete();
  });

  it("aborts a temporary replacement when another store has since imported that exact temporary namespace durably", async () => {
    const database = new CueBenchDatabase(`task-10-import-temporary-cas-${crypto.randomUUID()}`);
    const temporary = new ProjectStore({
      database,
      browserStorage: { estimate: async () => ({ quota: 200, usage: 150 }), persist: async () => false },
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:temporary"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await temporary.chooseFile(bundledFile());
    await temporary.continueTemporarily();
    const temporaryProject = temporary.getSnapshot().project!;
    const temporaryPortable = await temporary.exportProjectBackup();
    const incoming = createProject({
      projectId: "incoming-different-project",
      title: "Different incoming project",
      media: { sourceId: "incoming-source", sha256: temporaryProject.media.sha256, durationMs: 90_000, relinkState: "Linked" },
    });

    await temporary.previewBackupText(JSON.stringify(exportProjectBackup(incoming)));
    await temporary.relinkImportedMedia(bundledFile());

    const peer = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:peer-import"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await peer.previewBackupText(temporaryPortable.text);
    await peer.relinkImportedMedia(bundledFile());
    await peer.importPreviewedBackup();
    const durablePeer = await loadProject(database, temporaryProject.projectId);
    expect(durablePeer).toMatchObject({ projectId: temporaryProject.projectId });

    await expect(temporary.importPreviewedBackup()).rejects.toThrow(/temporary replacement|replacement project changed/i);
    await expect(loadProject(database, temporaryProject.projectId)).resolves.toMatchObject({ projectId: temporaryProject.projectId });
    await expect(loadProject(database, incoming.projectId)).resolves.toBeUndefined();
    await database.delete();
  });

  it("reconciles forward after a post-commit UI fault instead of retaining a dead old media URL", async () => {
    const database = new CueBenchDatabase(`task-10-import-reconcile-${crypto.randomUUID()}`);
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:cuebench:old")
      .mockReturnValueOnce("blob:cuebench:prepared");
    const revokeObjectURL = vi.fn();
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL, revokeObjectURL }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      afterImportCommitted: () => { throw new Error("render callback fault"); },
    });
    await store.openSample();
    const projectId = store.getSnapshot().project!.projectId;
    await store.previewBackupText((await store.exportProjectBackup()).text);
    await store.relinkImportedMedia(bundledFile());

    await store.importPreviewedBackup();

    expect(store.getSnapshot().sourceObjectUrl).toBe("blob:cuebench:prepared");
    expect(store.getSnapshot().error).toMatch(/recovered locally/i);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cuebench:old");
    await expect(loadProject(database, projectId)).resolves.toMatchObject({ projectId });
    await database.delete();
  });

  it("serializes a durable peer-tab revision rather than silently exporting a stale projection", async () => {
    const database = new CueBenchDatabase(`task-10-export-fresh-${crypto.randomUUID()}`);
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:first"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await first.openSample();
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:second"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await second.restoreLastDurableProject();
    const staleProjection = first.getSnapshot().project!;
    await second.executeCommand({
      type: "AppendCourtRecord",
      actor: { type: "System", id: "cuebench" },
      expectedProjectRevision: second.getSnapshot().project!.projectRevision,
      eventType: "ProjectSerialized",
      deterministic: true,
    });

    const backup = await first.exportProjectBackup();
    const freshTrack = await first.prepareFreshTrackExport({
      project: staleProjection,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });
    const parsed = JSON.parse(backup.text) as { readonly project: CaptionProject };
    expect(freshTrack.project.projectRevision).toBe(2);
    expect(freshTrack.prepared.filename).toContain(".draft.vtt");
    expect(parsed.project.projectRevision).toBe(2);
    expect(first.getSnapshot().project?.projectRevision).toBe(2);
    expect(backup.freshnessNotice).toMatch(/another browser tab/i);
    await database.delete();
  });

  it("captures a peer-tab active run in the retained deletion receipt and does not await a never-resolving cloud hook", async () => {
    const database = new CueBenchDatabase(`task-10-delete-background-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn(() => new Promise<never>(() => undefined));
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:first"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
      cloudCleanupTimeoutMs: 1,
    });
    await first.openSample();
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:second"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });
    await second.restoreLastDurableProject();
    const peerMedia = second.getSnapshot().project!.media;
    await second.executeCommand({
      type: "RelinkMedia",
      actor: { type: "Human", id: "teacher" },
      expectedProjectRevision: second.getSnapshot().project!.projectRevision,
      media: {
        sourceId: "concurrent-relinked-source",
        sha256: peerMedia.sha256,
        durationMs: peerMedia.durationMs,
      },
    });
    await second.executeCommand({
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      expectedProjectRevision: second.getSnapshot().project!.projectRevision,
      runId: "run-concurrent-delete",
      targetTrack: "Captions",
    });

    const deletion = await first.deleteCurrentProject();
    expect(first.getSnapshot().route).toBe("start");
    expect(deletion.cloudCleanup.status).toBe("pending");
    await waitFor(() => expect(cloudCleanup).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "concurrent-relinked-source",
      activeRunId: "run-concurrent-delete",
      cancelActiveWork: true,
    })));
    await waitFor(async () => {
      const receipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
      expect(receipt?.value).toMatchObject({ state: "pending", activeRunId: "run-concurrent-delete" });
    });
    await database.delete();
  });

  it("retains a failed cloud cleanup receipt so a later lifecycle retry can report a confirmed result", async () => {
    const database = new CueBenchDatabase(`task-10-delete-retry-${crypto.randomUUID()}`);
    const cloudCleanup = vi.fn()
      .mockRejectedValueOnce(new Error("hosted cleanup unavailable"))
      .mockResolvedValueOnce({ status: "deleted" as const, message: "Hosted source cleanup confirmed." });
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:retry"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
      cloudCleanupTimeoutMs: 5,
    });
    await store.openSample();

    const deletion = await store.deleteCurrentProject();
    await waitFor(async () => {
      const receipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
      expect(receipt?.value).toMatchObject({ state: "failed" });
    });

    await expect(store.retryCloudCleanup(deletion.receiptId)).resolves.toEqual({
      status: "deleted",
      message: "Hosted source cleanup confirmed.",
    });
    const receipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(receipt?.value).toMatchObject({ state: "deleted", attempts: 2 });
    await database.delete();
  });

  it("shares an in-flight cleanup attempt with a retry and never invokes the hook again after deletion is confirmed", async () => {
    const database = new CueBenchDatabase(`task-10-cleanup-idempotent-${crypto.randomUUID()}`);
    const cleanupGate = deferred<{ readonly status: "deleted"; readonly message: string }>();
    const cloudCleanup = vi.fn(() => cleanupGate.promise);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:cleanup"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup,
      cloudCleanupTimeoutMs: 60_000,
    });
    await store.openSample();

    const deletion = await store.deleteCurrentProject();
    await waitFor(() => expect(cloudCleanup).toHaveBeenCalledTimes(1));
    const concurrentRetry = store.retryCloudCleanup(deletion.receiptId);
    expect(cloudCleanup).toHaveBeenCalledTimes(1);

    cleanupGate.resolve({ status: "deleted", message: "Hosted cleanup confirmed." });
    await expect(concurrentRetry).resolves.toEqual({ status: "deleted", message: "Hosted cleanup confirmed." });
    await expect(store.retryCloudCleanup(deletion.receiptId)).resolves.toEqual({ status: "deleted", message: "Hosted cleanup confirmed." });
    expect(cloudCleanup).toHaveBeenCalledTimes(1);
    await database.delete();
  });

  it("does not let a late failed cleanup from another store overwrite a confirmed deletion receipt", async () => {
    const database = new CueBenchDatabase(`task-10-cleanup-monotonic-${crypto.randomUUID()}`);
    const firstGate = deferred<{ readonly status: "failed"; readonly message: string }>();
    const firstCloudCleanup = vi.fn(() => firstGate.promise);
    const first = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:first-cleanup"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
      cloudCleanup: firstCloudCleanup,
      cloudCleanupTimeoutMs: 60_000,
    });
    const secondCloudCleanup = vi.fn(async () => ({ status: "deleted" as const, message: "Hosted cleanup confirmed by retry." }));
    const second = new ProjectStore({
      database,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:second-cleanup"), revokeObjectURL: vi.fn() }),
      cloudCleanup: secondCloudCleanup,
    });
    await first.openSample();

    const deletion = await first.deleteCurrentProject();
    await waitFor(() => expect(firstCloudCleanup).toHaveBeenCalledTimes(1));
    await expect(second.retryCloudCleanup(deletion.receiptId)).resolves.toEqual({ status: "deleted", message: "Hosted cleanup confirmed by retry." });
    firstGate.resolve({ status: "failed", message: "Late hosted cleanup failure." });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const receipt = (await database.settings.toArray()).find((setting) => setting.key.includes(deletion.receiptId));
    expect(receipt?.value).toMatchObject({ state: "deleted", message: "Hosted cleanup confirmed by retry." });
    await expect(second.retryCloudCleanup(deletion.receiptId)).resolves.toEqual({ status: "deleted", message: "Hosted cleanup confirmed by retry." });
    expect(secondCloudCleanup).toHaveBeenCalledTimes(1);
    await database.delete();
  });

  it("imports a verified backup as a new durable project from the start screen state", async () => {
    const producerDatabase = new CueBenchDatabase(`task-10-import-new-source-${crypto.randomUUID()}`);
    const producer = new ProjectStore({
      database: producerDatabase,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:producer"), revokeObjectURL: vi.fn() }),
      bundledSampleLoader: bundledFile,
      mediaDurationProbe: async () => 90_000,
    });
    await producer.openSample();
    const portable = await producer.exportProjectBackup();
    const importDatabase = new CueBenchDatabase(`task-10-import-new-target-${crypto.randomUUID()}`);
    const importer = new ProjectStore({
      database: importDatabase,
      browserStorage: browserStorage(),
      objectUrlLease: new ObjectUrlLease({ createObjectURL: vi.fn(() => "blob:cuebench:importer"), revokeObjectURL: vi.fn() }),
      mediaDurationProbe: async () => 90_000,
    });

    const preview = await importer.previewBackupText(portable.text);
    expect(preview.mode).toBe("preview");
    await importer.relinkImportedMedia(bundledFile());
    const imported = await importer.importPreviewedBackup();

    expect(importer.getSnapshot()).toMatchObject({ route: "workbench", mode: "durable", project: { projectId: imported.project.projectId } });
    await producerDatabase.delete();
    await importDatabase.delete();
  });
});
