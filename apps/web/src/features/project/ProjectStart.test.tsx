import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CueBenchDatabase, loadProject, loadSourceMedia } from "@cuebench/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { LocalMediaError, ObjectUrlLease, ingestLocalMedia } from "./local-media";
import { ProjectStart } from "./ProjectStart";
import { ProjectStore } from "./project-store";

const databaseName = (): string => `cuebench-web-test-${crypto.randomUUID()}`;

const browserStorage = (options: { readonly quota: number; readonly usage: number; readonly persisted: boolean }) => ({
  estimate: vi.fn().mockResolvedValue({ quota: options.quota, usage: options.usage }),
  persist: vi.fn().mockResolvedValue(options.persisted),
});

describe("ProjectStart", () => {
  const databases: CueBenchDatabase[] = [];

  afterEach(async () => {
    cleanup();
    await Promise.all(databases.splice(0).map(async (database) => database.delete()));
  });

  it("opens the bundled sample without an account", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({ database, browserStorage: browserStorage({ quota: 10_000_000, usage: 0, persisted: true }) });
    const user = userEvent.setup();

    render(<ProjectStart store={store} />);
    await user.click(screen.getByRole("button", { name: "Open bundled sample" }));

    await waitFor(() => expect(store.getSnapshot().route).toBe("workbench"));
    expect(store.getSnapshot().project?.title).toBe("Gibbs Free Energy — Lesson 4");
    expect(await loadProject(database, "sample-gibbs-free-energy")).toBeDefined();
  });

  it("restores the last durable project into the workbench route", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const firstStore = new ProjectStore({ database, browserStorage: browserStorage({ quota: 10_000_000, usage: 0, persisted: true }) });
    await firstStore.openSample();
    const resumedStore = new ProjectStore({ database, browserStorage: browserStorage({ quota: 10_000_000, usage: 0, persisted: true }) });

    await resumedStore.restoreLastDurableProject();

    expect(resumedStore.getSnapshot().route).toBe("workbench");
    expect(resumedStore.getSnapshot().project?.projectId).toBe("sample-gibbs-free-energy");
    expect(resumedStore.getSnapshot().mode).toBe("durable");
  });

  it("requires an explicit temporary-session choice when durable browser storage is inadequate", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({
      database,
      browserStorage: browserStorage({ quota: 200, usage: 150, persisted: false }),
      mediaDurationProbe: async () => 90_000,
    });
    const user = userEvent.setup();
    const file = Object.assign(new Blob(["small lesson"], { type: "video/webm" }), { name: "lesson.webm" }) as File;

    await store.chooseFile(file);
    render(<ProjectStart store={store} />);

    expect(await screen.findByRole("dialog", { name: "Temporary session required" })).toBeVisible();
    expect(screen.getByText(/not recoverable after this browser session/i)).toBeVisible();
    expect(store.getSnapshot().project).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue temporarily" }));

    await waitFor(() => expect(store.getSnapshot().route).toBe("workbench"));
    expect(store.getSnapshot().mode).toBe("temporary");
    expect(store.getSnapshot().project?.media.relinkState).toBe("TemporarySession");
  });

  it("keeps Object and Sustain available when WebMCP is unavailable", async () => {
    const database = new CueBenchDatabase(databaseName());
    databases.push(database);
    const store = new ProjectStore({ database, browserStorage: browserStorage({ quota: 10_000_000, usage: 0, persisted: true }) });
    await store.openSample();

    render(<App store={store} webMcpAvailable={false} />);

    expect(screen.getByRole("button", { name: "Object selected revision" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sustain selected revision" })).toBeVisible();
    expect(screen.getByText("Browser Agent unavailable")).toBeVisible();
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
