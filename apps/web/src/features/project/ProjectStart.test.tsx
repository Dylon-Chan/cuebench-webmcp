import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CueBenchDatabase, loadProject, loadSourceMedia } from "@cuebench/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { createBundledSampleFile } from "./bundled-sample";
import { LocalMediaError, ObjectUrlLease, ingestLocalMedia } from "./local-media";
import { ProjectStart } from "./ProjectStart";
import { ProjectStore } from "./project-store";

const databaseName = (): string => `cuebench-web-test-${crypto.randomUUID()}`;

const browserStorage = (options: { readonly quota: number; readonly usage: number; readonly persisted: boolean }) => ({
  estimate: vi.fn().mockResolvedValue({ quota: options.quota, usage: options.usage }),
  persist: vi.fn().mockResolvedValue(options.persisted),
});

const videoFile = (contents = "small lesson", name = "lesson.webm"): File => Object.assign(
  new Blob([contents], { type: "video/webm" }),
  { name },
) as File;

const objectUrlLease = (prefix = "preview") => {
  let count = 0;
  const createObjectURL = vi.fn(() => `blob:cuebench:${prefix}-${++count}`);
  const revokeObjectURL = vi.fn();
  return { lease: new ObjectUrlLease({ createObjectURL, revokeObjectURL }), createObjectURL, revokeObjectURL };
};

const sessionStore = () => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (hex: string) => {
    const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    const linear = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
};

describe("ProjectStart", () => {
  const databases: CueBenchDatabase[] = [];

  afterEach(async () => {
    cleanup();
    await Promise.all(databases.splice(0).map(async (database) => database.delete()));
  });

  it("opens the bundled sample without an account", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const urls = objectUrlLease();
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: urls.lease,
    });
    const user = userEvent.setup();

    render(<ProjectStart store={store} />);
    await user.click(screen.getByRole("button", { name: "Open bundled media fixture" }));

    await waitFor(() => expect(store.getSnapshot().route).toBe("workbench"));
    expect(store.getSnapshot().project?.title).toBe("CueBench bundled media fixture");
    expect(store.getSnapshot().sourceObjectUrl).toBe("blob:cuebench:preview-1");
    expect(await loadProject(database, "sample-gibbs-free-energy")).toBeDefined();
    const project = store.getSnapshot().project;
    const saved = project === null ? undefined : await loadSourceMedia(database, project.projectId, project.media.sha256);
    expect(saved?.blob.size).toBe(2_754);
    expect(saved?.contentType).toBe("video/mp4");
    expect(project?.media.sha256).toBe("51beba8fbd43cd905d4952f59f4ef507f471f568cf54f86dd3c88130e2667c45");
  });

  it("restores the last durable project into the workbench route", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const firstStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease("first").lease,
    });
    await firstStore.openSample();
    const resumedStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease("restored").lease,
    });

    await resumedStore.restoreLastDurableProject();

    expect(resumedStore.getSnapshot().route).toBe("workbench");
    expect(resumedStore.getSnapshot().project?.projectId).toBe("sample-gibbs-free-energy");
    expect(resumedStore.getSnapshot().mode).toBe("durable");
    expect(resumedStore.getSnapshot().sourceObjectUrl).toBe("blob:cuebench:restored-1");
  });

  it("requires an explicit temporary-session choice when durable browser storage is inadequate", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 200, usage: 150, persisted: false }),
      mediaDurationProbe: async () => 90_000,
      objectUrlLease: objectUrlLease().lease,
    });
    const user = userEvent.setup();
    const file = videoFile();

    await store.chooseFile(file);
    render(<ProjectStart store={store} />);

    expect(await screen.findByRole("dialog", { name: "Temporary session required" })).toBeVisible();
    expect(screen.getByText(/recovery is not promised after the session ends/i)).toBeVisible();
    expect(store.getSnapshot().project).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue temporarily" }));

    await waitFor(() => expect(store.getSnapshot().route).toBe("workbench"));
    expect(store.getSnapshot().mode).toBe("temporary");
    expect(store.getSnapshot().project?.media.relinkState).toBe("TemporarySession");
  });

  it("keeps a temporary project recoverable only through the same-session pointer", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const session = sessionStore();
    const firstStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 200, usage: 150, persisted: false }),
      mediaDurationProbe: async () => 1_000,
      objectUrlLease: objectUrlLease("temporary-first").lease,
      sessionStorage: session,
    });
    await firstStore.chooseFile(videoFile("temporary", "temporary.webm"));
    await firstStore.continueTemporarily();

    const resumedStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 200, usage: 150, persisted: false }),
      objectUrlLease: objectUrlLease("temporary-restored").lease,
      sessionStorage: session,
    });
    await resumedStore.restoreLastDurableProject();

    expect(resumedStore.getSnapshot()).toMatchObject({
      route: "workbench",
      mode: "temporary",
      sourceObjectUrl: "blob:cuebench:temporary-restored-1",
    });
    expect(session.setItem).toHaveBeenCalled();
  });

  it("does not let a late hydration replace a newer start operation", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const firstStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease("seed").lease,
    });
    await firstStore.openSample();
    const hydrateGate = deferred<void>();
    const resumedStore = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease("newer").lease,
      beforeRestoreLoad: () => hydrateGate.promise,
    });

    const restore = resumedStore.restoreLastDurableProject();
    await waitFor(() => expect(resumedStore.getSnapshot().activity).toBe("hydrating"));
    const newerStart = resumedStore.openSample();
    hydrateGate.resolve();
    await Promise.all([restore, newerStart]);

    expect(resumedStore.getSnapshot()).toMatchObject({
      route: "workbench",
      activity: null,
      sourceObjectUrl: "blob:cuebench:newer-1",
    });
  });

  it("shows a busy, accessible hydration state and rejects double-start clicks", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const sampleGate = deferred<ReturnType<typeof createBundledSampleFile>>();
    const sampleLoader = vi.fn(() => sampleGate.promise);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease("busy").lease,
      bundledSampleLoader: sampleLoader,
    });
    const user = userEvent.setup();
    render(<ProjectStart store={store} />);

    await user.click(screen.getByRole("button", { name: "Open bundled media fixture" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/preparing bundled media/i);
    expect(screen.getByRole("button", { name: "Open bundled media fixture" })).toBeDisabled();
    await waitFor(() => expect(sampleLoader).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Open bundled media fixture" }));
    expect(sampleLoader).toHaveBeenCalledTimes(1);

    sampleGate.resolve(createBundledSampleFile());
    await waitFor(() => expect(store.getSnapshot().route).toBe("workbench"));
  });

  it("keeps Object and Sustain available when WebMCP is unavailable", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: objectUrlLease().lease,
    });
    await store.openSample();

    render(<App store={store} webMcpAvailable={false} />);

    expect(screen.getByRole("button", { name: "Object selected revision" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sustain selected revision" })).toBeVisible();
    expect(screen.getByText("Browser Agent tools unavailable")).toBeVisible();
  });

  it("falls back to the explicit temporary decision after a durable quota error without losing the pending Blob", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const addSource = vi.spyOn(database.sourceBlobs, "add").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    const file = videoFile("quota fallback", "quota.webm");
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      mediaDurationProbe: async () => 1_000,
      objectUrlLease: objectUrlLease("quota").lease,
    });

    await store.chooseFile(file);

    expect(store.getSnapshot()).toMatchObject({ route: "temporary-choice", pendingUpload: { file } });
    expect(store.getSnapshot().error).toMatch(/ran out of durable storage/i);
    addSource.mockRestore();
    await store.continueTemporarily();
    expect(store.getSnapshot().mode).toBe("temporary");
  });

  it("rolls back project and media rows when a lifecycle pointer cannot be saved", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const pointerWrite = vi.spyOn(database.settings, "put").mockRejectedValue(new Error("settings unavailable"));
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      mediaDurationProbe: async () => 1_000,
      objectUrlLease: objectUrlLease("rollback").lease,
    });

    await store.chooseFile(videoFile("rollback", "rollback.webm"));

    expect(store.getSnapshot().error).toMatch(/settings unavailable/i);
    expect(await database.projectHeaders.count()).toBe(0);
    expect(await database.sourceBlobs.count()).toBe(0);
    pointerWrite.mockRestore();
  });

  it("releases the active source URL when the workbench owner is disposed", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const urls = objectUrlLease("dispose");
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 100_000_000, usage: 0, persisted: true }),
      objectUrlLease: urls.lease,
    });
    await store.openSample();

    store.dispose();

    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:cuebench:dispose-1");
  });

  it("keeps the upload control focusable and the visible compact states accessible at narrow widths", () => {
    const stylesheet = readFileSync(`${process.cwd()}/src/styles/index.css`, "utf8");
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({ database, objectUrlLease: objectUrlLease().lease });
    render(<ProjectStart store={store} />);

    expect(screen.getByRole("button", { name: "Upload local video" })).toHaveClass("button--outline");
    expect(stylesheet).toContain(":focus-visible");
    expect(stylesheet).toContain(".header-reading div:nth-child(-n + 2) { display: none; }");
    expect(stylesheet).toContain(".header-compact-status { display: flex;");
  });

  it("uses a contrast-safe Object treatment and 44px narrow-screen action targets", () => {
    const stylesheet = readFileSync(`${process.cwd()}/src/styles/index.css`, "utf8");

    expect(stylesheet).toContain(".button--object { color: #fff9f5; background: #9b3d00;");
    expect(contrastRatio("#fff9f5", "#9b3d00")).toBeGreaterThanOrEqual(4.5);
    expect(stylesheet).toContain(".transport-control { min-height: 44px; }");
  });
});

describe("ingestLocalMedia", () => {
  const databases: CueBenchDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(async (database) => database.delete()));
  });

  it("rejects oversized or overlong media before persisting it", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const tooLarge = { name: "too-large.webm", size: 500 * 1024 * 1024 + 1, type: "video/webm" } as File;

    await expect(ingestLocalMedia({
      database,
      projectId: "large-project",
      sourceId: "large-media",
      file: tooLarge,
      probeDuration: vi.fn(),
    })).rejects.toMatchObject({ code: "file-too-large" } satisfies Partial<LocalMediaError>);

    const overlong = new File(["lesson"], "overlong.webm", { type: "video/webm" });
    await expect(ingestLocalMedia({
      database,
      projectId: "long-project",
      sourceId: "long-media",
      file: overlong,
      probeDuration: async () => 15 * 60 * 1_000 + 1,
    })).rejects.toMatchObject({ code: "duration-too-long" } satisfies Partial<LocalMediaError>);
  });

  it("hashes and saves accepted media in IndexedDB, then revokes replaced object URLs", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:cuebench:first")
      .mockReturnValueOnce("blob:cuebench:second");
    const revokeObjectURL = vi.fn();
    const urlLease = new ObjectUrlLease({ createObjectURL, revokeObjectURL });
    const first = Object.assign(new Blob([new TextEncoder().encode("abc")], { type: "video/webm" }), {
      name: "lesson.webm",
    }) as File;

    const accepted = await ingestLocalMedia({
      database,
      projectId: "accepted-project",
      sourceId: "accepted-media",
      file: first,
      probeDuration: async () => 90_000,
      urlLease,
    });
    const saved = await loadSourceMedia(database, "accepted-project", accepted.sha256);

    expect(accepted.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(saved?.blob).toBeInstanceOf(Blob);
    expect(saved?.blob.size).toBe(first.size);
    expect(accepted.objectUrl).toBe("blob:cuebench:first");

    await ingestLocalMedia({
      database,
      projectId: "replacement-project",
      sourceId: "replacement-media",
      file: Object.assign(new Blob(["replacement"], { type: "video/webm" }), { name: "replacement.webm" }) as File,
      probeDuration: async () => 90_000,
      urlLease,
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cuebench:first");
  });
});
