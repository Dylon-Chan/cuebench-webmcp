import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { applyCommand, createProject, type CaptionProject, type CommandResult, type DomainCommand } from "@cuebench/domain";
import { CueBenchDatabase } from "@cuebench/storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DEMONSTRATION_REPLAY_RUN_ID,
  DEMONSTRATION_REPLAY_LABEL,
  SAMPLE_MEDIA_DURATION_MS,
  SAMPLE_MEDIA_SHA256,
  createDemonstrationReplay,
  type DemonstrationReplayStore,
} from "../project/replay-generation";
import { ObjectUrlLease } from "../project/local-media";
import { ProjectInstanceFenceError, ProjectStore } from "../project/project-store";
import { CaptionGenerationClient, type GenerationProjectStore } from "./generation-client";
import { GenerationStatus } from "./GenerationStatus";

const sampleProject = (): CaptionProject => createProject({
  projectId: "gibbs-ui-project",
  title: "Gibbs free energy: a 90-second calibration",
  media: {
    sourceId: "gibbs-free-energy-sample-v1",
    sha256: SAMPLE_MEDIA_SHA256,
    durationMs: SAMPLE_MEDIA_DURATION_MS,
    relinkState: "Linked",
  },
});

const bundledSampleFile = (): File => Object.assign(
  new Blob([readFileSync(`${process.cwd()}/public/sample/gibbs-free-energy.mp4`)], { type: "video/mp4" }),
  { name: "gibbs-free-energy.mp4", lastModified: 0 },
) as File;

const durableBrowserStorage = {
  estimate: vi.fn().mockResolvedValue({ quota: 100_000_000, usage: 0 }),
  persist: vi.fn().mockResolvedValue(true),
};

const temporaryBrowserStorage = {
  estimate: vi.fn().mockResolvedValue({ quota: 200, usage: 150 }),
  persist: vi.fn().mockResolvedValue(false),
};

const objectUrlLease = (label: string): ObjectUrlLease => new ObjectUrlLease({
  createObjectURL: vi.fn(() => `blob:cuebench:${label}`),
  revokeObjectURL: vi.fn(),
});

describe("GenerationStatus demonstration fallback", () => {
  it("keeps real cloud generation unavailable but runs the local replay in a temporary current-page project", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary"),
        bundledSampleLoader: bundledSampleFile,
      });
      const providerRequest = vi.fn(async () => { throw new Error("the local replay must not call a provider"); });
      const client = new CaptionGenerationClient({ fetcher: providerRequest });
      const user = userEvent.setup();

      await store.openSample();
      expect(store.getSnapshot().route).toBe("temporary-choice");
      await store.continueTemporarily();
      const project = store.getSnapshot().project;
      expect(store.getSnapshot().mode).toBe("temporary");
      expect(project).not.toBeNull();
      const generationStore = store.bindGenerationStore(store.getProjectInstanceFence()!);

      render(<GenerationStatus project={project!} store={generationStore} client={client} demonstrationReplayStageDelayMs={0} />);

      expect(screen.getByRole("button", { name: "Generate proposed captions" })).toBeDisabled();
      const replay = screen.getByRole("button", { name: "Run demonstration replay" });
      expect(replay).toBeEnabled();
      expect(screen.getByText(/does not create a cloud recovery receipt/i)).toBeVisible();

      await user.click(replay);

      await waitFor(() => expect(store.getSnapshot().project?.validationRun).not.toBeNull());
      expect(screen.getByRole("status", { name: /demonstration replay complete/i })).toBeVisible();
      expect(await database.runReceipts.count()).toBe(0);
      expect(providerRequest).not.toHaveBeenCalled();
    } finally {
      await database.delete();
    }
  });

  it("rejects forged checkpoint and staged-result writes at the temporary ProjectStore boundary", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-proof-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary-proof"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      await store.continueTemporarily();
      const initial = store.getSnapshot().project;
      expect(initial).not.toBeNull();
      const replayStore = store.bindGenerationStore(store.getProjectInstanceFence()!);

      let captured: Extract<DomainCommand, { readonly type: "AdoptCaptionGenerationResult" }> | null = null;
      const intercept = vi.spyOn(store, "adoptStagedCaptionGenerationResult").mockImplementation(async (command) => {
        captured = structuredClone(command);
        throw new Error("hold temporary replay checkpoint");
      });
      await expect(createDemonstrationReplay({ project: initial!, store: replayStore })).rejects.toThrow(/hold temporary replay checkpoint/i);
      intercept.mockRestore();

      const leasedProject = store.getSnapshot().project;
      const receipt = await replayStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID);
      expect(leasedProject).not.toBeNull();
      expect(receipt).not.toBeNull();
      expect(captured).not.toBeNull();

      await expect(store.executeCommand(captured!)).rejects.toThrow(/target-specific receipt-verified method/i);
      await expect(store.executeCommand({
        type: "AdoptAudioDescriptionGenerationResult",
      } as unknown as DomainCommand)).rejects.toThrow(/target-specific receipt-verified method/i);
      await expect(store.adoptStagedCaptionGenerationResult(captured!)).rejects.toThrow(/durable browser storage/i);
      await expect(store.deleteCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).rejects.toThrow(/durable browser storage/i);
      await expect(replayStore.persistCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID, {
        ...(receipt as Record<string, unknown>),
        demonstrationReplay: {
          ...((receipt as { readonly demonstrationReplay: Record<string, unknown> }).demonstrationReplay),
          stagedResultSha256: "0".repeat(64),
        },
      })).rejects.toThrow(/durable browser storage/i);
      await expect(replayStore.adoptStagedCaptionGenerationResult({
        ...captured!,
        result: { ...captured!.result, outputSha256: "0".repeat(64) },
      })).rejects.toThrow(/durable browser storage/i);
      expect(store.getSnapshot().project?.captions.order).toHaveLength(0);
      expect(await database.runReceipts.count()).toBe(0);
    } finally {
      await database.delete();
    }
  });

  it("rejects generic caption and AD adoption before a durable project reducer can mutate state", async () => {
    const database = new CueBenchDatabase(`cuebench-durable-generic-adoption-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: durableBrowserStorage,
        objectUrlLease: objectUrlLease("durable-generic-adoption"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      const before = store.getSnapshot().project;
      expect(before).not.toBeNull();

      for (const command of [
        { type: "AdoptCaptionGenerationResult" },
        { type: "AdoptAudioDescriptionGenerationResult" },
      ] as const) {
        await expect(store.executeCommand(command as unknown as DomainCommand)).rejects.toThrow(/target-specific receipt-verified method/i);
      }

      const after = store.getSnapshot().project;
      expect(after?.projectRevision).toBe(before!.projectRevision);
      expect(after?.courtRecord).toEqual(before!.courtRecord);
      expect(await database.runReceipts.count()).toBe(0);
    } finally {
      await database.delete();
    }
  });

  it("keeps temporary replay checkpoints scoped to the one fixed caption run ID", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-run-id-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary-run-id"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      await store.continueTemporarily();
      const initial = store.getSnapshot().project;
      expect(initial).not.toBeNull();
      const replayStore = store.bindGenerationStore(store.getProjectInstanceFence()!);

      const intercept = vi.spyOn(store, "adoptStagedCaptionGenerationResult").mockRejectedValueOnce(
        new Error("hold the temporary replay checkpoint"),
      );
      await expect(createDemonstrationReplay({ project: initial!, store: replayStore })).rejects.toThrow(/hold the temporary replay checkpoint/i);
      intercept.mockRestore();

      const project = store.getSnapshot().project;
      const receipt = await replayStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID);
      expect(project).not.toBeNull();
      expect(receipt).not.toBeNull();

      const aliasRunId = "temporary-ad-alias";
      await expect(replayStore.persistCaptionGenerationReceipt(aliasRunId, receipt)).rejects.toThrow(/fixed run ID/i);
      await expect(replayStore.persistAudioDescriptionGenerationReceipt(aliasRunId, receipt)).rejects.toThrow(/durable browser storage/i);
      await expect(replayStore.persistAudioDescriptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID, receipt)).rejects.toThrow(/durable browser storage/i);
      expect(await replayStore.loadCaptionGenerationReceipt(aliasRunId)).toBeNull();
      expect(await replayStore.loadAudioDescriptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
      await expect(replayStore.deleteCaptionGenerationReceipt(aliasRunId)).rejects.toThrow(/fixed run ID/i);
      expect(await replayStore.listCaptionGenerationReceiptRunIds()).toEqual([DEMONSTRATION_REPLAY_RUN_ID]);
      expect(await replayStore.listAudioDescriptionGenerationReceiptRunIds()).toEqual([]);
      await expect(store.persistCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID, receipt)).rejects.toThrow(/durable browser storage/i);
      expect(await store.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
      expect(await store.listCaptionGenerationReceiptRunIds()).toEqual([]);
    } finally {
      await database.delete();
    }
  });

  it("clears temporary replay evidence and fences stale work when the same project instance rotates", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-rotation-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary-rotation"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      await store.continueTemporarily();
      const initial = store.getSnapshot().project;
      expect(initial).not.toBeNull();
      const replayStore = store.bindGenerationStore(store.getProjectInstanceFence()!);

      const intercept = vi.spyOn(store, "adoptStagedCaptionGenerationResult").mockRejectedValueOnce(
        new Error("hold the temporary replay checkpoint"),
      );
      await expect(createDemonstrationReplay({ project: initial!, store: replayStore })).rejects.toThrow(/hold the temporary replay checkpoint/i);
      intercept.mockRestore();

      const beforeRotation = store.getSnapshot();
      const staleFence = store.getProjectInstanceFence();
      expect(beforeRotation.mode).toBe("temporary");
      expect(staleFence).not.toBeNull();
      expect(await replayStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).not.toBeNull();

      const internalStore = store as unknown as {
        readonly setSnapshot: (snapshot: ReturnType<ProjectStore["getSnapshot"]>, options: { readonly rotateProjectInstance: true }) => void;
      };
      internalStore.setSnapshot(beforeRotation, { rotateProjectInstance: true });

      const current = store.getSnapshot();
      const currentFence = store.getProjectInstanceFence();
      expect(current.mode).toBe("temporary");
      expect(current.project?.projectId).toBe(beforeRotation.project?.projectId);
      expect(currentFence?.projectInstanceEpoch).toBeGreaterThan(staleFence!.projectInstanceEpoch);
      await expect(replayStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).rejects.toBeInstanceOf(ProjectInstanceFenceError);
      const currentStore = store.bindGenerationStore(currentFence!);
      expect(await currentStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
      expect(await currentStore.listCaptionGenerationReceiptRunIds()).toEqual([]);
    } finally {
      await database.delete();
    }
  });

  it("rejects in-flight replay work that crosses a same-ID temporary instance rotation after its lease", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-in-flight-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary-in-flight"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      await store.continueTemporarily();
      const project = store.getSnapshot().project;
      const fence = store.getProjectInstanceFence();
      expect(project).not.toBeNull();
      expect(fence).not.toBeNull();

      const boundStore = store.bindGenerationStore(fence!);
      const internalStore = store as unknown as {
        readonly setSnapshot: (snapshot: ReturnType<ProjectStore["getSnapshot"]>, options: { readonly rotateProjectInstance: true }) => void;
      };
      let rotated = false;
      const replayStore: DemonstrationReplayStore = {
        ...boundStore,
        executeCommand: async (command) => {
          const result = await boundStore.executeCommand(command);
          if (command.type === "StartGenerationRun") {
            rotated = true;
            internalStore.setSnapshot(store.getSnapshot(), { rotateProjectInstance: true });
          }
          return result;
        },
      };

      await expect(createDemonstrationReplay({ project: project!, store: replayStore })).rejects.toThrow(/browser project instance changed/i);
      expect(rotated).toBe(true);
      expect(store.getSnapshot().project?.captions.order).toHaveLength(0);
      expect(store.getSnapshot().project?.courtRecord.some((event) => event.type === "AdoptCaptionGenerationResult")).toBe(false);

      const currentFence = store.getProjectInstanceFence();
      expect(currentFence?.projectId).toBe(project!.projectId);
      expect(currentFence?.projectInstanceEpoch).toBeGreaterThan(fence!.projectInstanceEpoch);
      const currentStore = store.bindGenerationStore(currentFence!);
      expect(await currentStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
      expect(await currentStore.listCaptionGenerationReceiptRunIds()).toEqual([]);
    } finally {
      await database.delete();
    }
  });

  it("fails closed before adoption when an unbound temporary replay crosses the same-ID rotation", async () => {
    const database = new CueBenchDatabase(`cuebench-temporary-replay-raw-in-flight-${crypto.randomUUID()}`);
    try {
      const store = new ProjectStore({
        database,
        browserStorage: temporaryBrowserStorage,
        objectUrlLease: objectUrlLease("temporary-raw-in-flight"),
        bundledSampleLoader: bundledSampleFile,
      });
      await store.openSample();
      await store.continueTemporarily();
      const project = store.getSnapshot().project;
      expect(project).not.toBeNull();

      const internalStore = store as unknown as {
        readonly setSnapshot: (snapshot: ReturnType<ProjectStore["getSnapshot"]>, options: { readonly rotateProjectInstance: true }) => void;
      };
      const rawReplayStore: DemonstrationReplayStore = {
        getSnapshot: store.getSnapshot,
        executeCommand: async (command, expectedProjectId) => {
          const result = await store.executeCommand(command, expectedProjectId);
          if (command.type === "StartGenerationRun") {
            internalStore.setSnapshot(store.getSnapshot(), { rotateProjectInstance: true });
          }
          return result;
        },
        persistCaptionGenerationReceipt: store.persistCaptionGenerationReceipt.bind(store),
        deleteCaptionGenerationReceipt: store.deleteCaptionGenerationReceipt.bind(store),
        loadCaptionGenerationReceipt: store.loadCaptionGenerationReceipt.bind(store),
        adoptStagedCaptionGenerationResult: store.adoptStagedCaptionGenerationResult.bind(store),
        getCloudProjectOwnerCapability: store.getCloudProjectOwnerCapability,
      };

      await expect(createDemonstrationReplay({ project: project!, store: rawReplayStore })).rejects.toThrow(/durable browser storage/i);
      expect(store.getSnapshot().project?.captions.order).toHaveLength(0);
      expect(store.getSnapshot().project?.courtRecord.some((event) => event.type === "AdoptCaptionGenerationResult")).toBe(false);

      const currentFence = store.getProjectInstanceFence();
      const currentStore = store.bindGenerationStore(currentFence!);
      expect(await currentStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
    } finally {
      await database.delete();
    }
  });

  it("visibly labels recorded fixture output and drives the real adoption and validation path without a provider client", async () => {
    let project = sampleProject();
    const receipts = new Map<string, unknown>();
    const executeCommand = vi.fn(async (command: DomainCommand): Promise<CommandResult> => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const replayStore: DemonstrationReplayStore = {
      getSnapshot: () => ({ project, mode: "durable" }),
      executeCommand,
      persistCaptionGenerationReceipt: async (runId, receipt) => { receipts.set(runId, receipt); },
      deleteCaptionGenerationReceipt: async (runId) => { receipts.delete(runId); },
      loadCaptionGenerationReceipt: async (runId) => receipts.get(runId) ?? null,
      adoptStagedCaptionGenerationResult: async (command) => {
        if (!receipts.has(command.runId)) throw new Error("missing receipt");
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      getCloudProjectOwnerCapability: async () => "1".repeat(64),
    };
    const generationStore: GenerationProjectStore = {
      ...replayStore,
      loadCaptionGenerationReceipt: async (runId) => receipts.get(runId) ?? null,
    };
    const user = userEvent.setup();

    render(<GenerationStatus project={project} store={generationStore} demonstrationReplayStageDelayMs={0} />);

    expect(screen.getByRole("heading", { name: DEMONSTRATION_REPLAY_LABEL })).toBeVisible();
    expect(screen.getByText(/recorded, deterministic fixture/i)).toBeVisible();
    expect(screen.getByText(/not live provider output/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Run demonstration replay" }));

    await waitFor(() => expect(project.validationRun).not.toBeNull());
    expect(screen.getByRole("status", { name: /demonstration replay complete/i })).toBeVisible();
    expect(Object.values(project.captions.items).every((item) => item.current.state === "Proposed")).toBe(true);
    expect(project.courtRecord.some((event) => event.type === "SustainItem" || event.type === "CertifyProject")).toBe(false);
  });

  it("shows paced intermediate progress visually while announcing only replay start and completion", async () => {
    vi.useFakeTimers();
    try {
      let project = sampleProject();
      const receipts = new Map<string, unknown>();
      const executeCommand = vi.fn(async (command: DomainCommand): Promise<CommandResult> => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      });
      const store: GenerationProjectStore = {
        getSnapshot: () => ({ project, mode: "durable" }),
        executeCommand,
        persistCaptionGenerationReceipt: async (runId, receipt) => { receipts.set(runId, receipt); },
        deleteCaptionGenerationReceipt: async (runId) => { receipts.delete(runId); },
        loadCaptionGenerationReceipt: async (runId) => receipts.get(runId) ?? null,
        adoptStagedCaptionGenerationResult: async (command) => {
          const result = applyCommand(project, command);
          project = result.project;
          return result;
        },
        getCloudProjectOwnerCapability: async () => "1".repeat(64),
      };
      render(<GenerationStatus project={project} store={store} demonstrationReplayStageDelayMs={500} />);

      fireEvent.click(screen.getByRole("button", { name: "Run demonstration replay" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const replayPanel = screen.getByRole("region", { name: DEMONSTRATION_REPLAY_LABEL });
      const stage = screen.getByTestId("caption-generation-stage");
      expect(replayPanel).toHaveAttribute("aria-busy", "true");
      expect(stage).toHaveTextContent("Queued for durable caption generation");
      expect(stage).not.toHaveAttribute("role");
      expect(stage).not.toHaveAttribute("aria-live");
      expect(screen.getByRole("status", { name: /demonstration replay started/i })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(stage).toHaveTextContent("Preparing private media evidence");
      expect(stage).not.toHaveAttribute("role");

      await act(async () => { await vi.runAllTimersAsync(); });
      expect(replayPanel).toHaveAttribute("aria-busy", "false");
      expect(screen.getByRole("status", { name: /demonstration replay complete/i })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Resume with existing captions only for its exact incomplete durable checkpoint", async () => {
    let project = sampleProject();
    const receipts = new Map<string, unknown>();
    let interruptValidation = true;
    const executeCommand = vi.fn(async (command: DomainCommand): Promise<CommandResult> => {
      if (command.type === "ValidateProject" && interruptValidation) {
        interruptValidation = false;
        throw new Error("simulated reload after acknowledgement");
      }
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" }),
      executeCommand,
      persistCaptionGenerationReceipt: async (runId, receipt) => { receipts.set(runId, structuredClone(receipt)); },
      deleteCaptionGenerationReceipt: async (runId) => { receipts.delete(runId); },
      loadCaptionGenerationReceipt: async (runId) => structuredClone(receipts.get(runId) ?? null),
      adoptStagedCaptionGenerationResult: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        const prior = receipts.get(command.runId);
        if (typeof prior === "object" && prior !== null && !Array.isArray(prior)) {
          receipts.set(command.runId, {
            ...prior,
            adoption: {
              status: "adopted",
              adoptedProjectRevision: project.projectRevision,
              localEvidencePackageId: `generation-${command.runId}`,
              cleanupAcknowledgement: "pending",
            },
          });
        }
        return result;
      },
      getCloudProjectOwnerCapability: async () => "1".repeat(64),
    };
    await expect(createDemonstrationReplay({ project, store })).rejects.toThrow(/simulated reload/i);
    const adoptedOrder = [...project.captions.order];

    render(<GenerationStatus project={project} store={store} demonstrationReplayStageDelayMs={0} />);
    const resume = screen.getByRole("button", { name: "Resume demonstration replay" });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);

    await waitFor(() => expect(project.validationRun).not.toBeNull());
    expect(project.captions.order).toEqual(adoptedOrder);
    expect(project.courtRecord.filter((event) => event.type === "AdoptCaptionGenerationResult")).toHaveLength(1);
    expect(project.courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(1);
    expect(resume).toBeDisabled();
  });

  it("reloads a completed replay immediately and after retention expiry from project evidence without cloud cleanup", async () => {
    const completedAtMs = 1_900_000_000_000;
    const database = new CueBenchDatabase(`cuebench-replay-reload-${crypto.randomUUID()}`);
    try {
      const initialStore = new ProjectStore({
        database,
        browserStorage: durableBrowserStorage,
        objectUrlLease: objectUrlLease("initial"),
        bundledSampleLoader: bundledSampleFile,
      });
      await initialStore.openSample();
      const initialProject = initialStore.getSnapshot().project;
      expect(initialProject).not.toBeNull();
      await createDemonstrationReplay({
        project: initialProject!,
        store: initialStore,
        clock: () => completedAtMs,
      });
      expect(await initialStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();

      const assertCompletedReload = async (label: string, clock: () => number) => {
        const reloadedStore = new ProjectStore({
          database,
          browserStorage: durableBrowserStorage,
          objectUrlLease: objectUrlLease(label),
        });
        await reloadedStore.restoreLastDurableProject();
        const project = reloadedStore.getSnapshot().project;
        expect(project).not.toBeNull();
        const providerRequest = vi.fn(async () => { throw new Error("completed replay must not request a provider"); });
        const client = new CaptionGenerationClient({ fetcher: providerRequest, clock });
        const loadStoredReceipt = vi.spyOn(client, "loadStoredReceipt");
        const view = render(<GenerationStatus project={project!} store={reloadedStore} client={client} uploadRecovery={null} />);

        await waitFor(() => expect(loadStoredReceipt).toHaveBeenCalledWith(
          reloadedStore,
          project,
          DEMONSTRATION_REPLAY_RUN_ID,
        ));
        expect(screen.getByTestId("caption-generation-stage")).toHaveTextContent(/adopted into this browser project/i);
        expect(screen.getByRole("button", { name: "Demonstration replay complete" })).toBeDisabled();
        expect(project?.courtRecord.filter((event) => event.type === "AdoptCaptionGenerationResult")).toHaveLength(1);
        expect(project?.courtRecord.filter((event) => event.type === "ValidateProject")).toHaveLength(1);
        expect(await reloadedStore.loadCaptionGenerationReceipt(DEMONSTRATION_REPLAY_RUN_ID)).toBeNull();
        expect(await reloadedStore.listCaptionGenerationReceiptRunIds()).not.toContain(DEMONSTRATION_REPLAY_RUN_ID);
        expect(screen.queryByRole("button", { name: /retry private cleanup/i })).toBeNull();
        expect(screen.queryByText(/owner capability expired|private temporary-media cleanup|lifecycle backstop/i)).toBeNull();
        expect(providerRequest).not.toHaveBeenCalled();
        view.unmount();
      };

      await assertCompletedReload("immediate", () => completedAtMs);
      await assertCompletedReload("after-expiry", () => completedAtMs + 24 * 60 * 60 * 1_000 + 1);
    } finally {
      await database.delete();
    }
  });
});
