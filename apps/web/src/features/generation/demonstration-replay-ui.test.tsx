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
import { ProjectStore } from "../project/project-store";
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

const objectUrlLease = (label: string): ObjectUrlLease => new ObjectUrlLease({
  createObjectURL: vi.fn(() => `blob:cuebench:${label}`),
  revokeObjectURL: vi.fn(),
});

describe("GenerationStatus demonstration fallback", () => {
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
