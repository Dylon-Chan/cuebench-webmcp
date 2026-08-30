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
  project: { title: "Future CueBench project" },
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

const verifiedDescriptor = (): ProjectImportDescriptor => ({
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
      blob: new Blob(["narration"], { type: "audio/mpeg" }),
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
