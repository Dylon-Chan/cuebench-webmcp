import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applyCommand, createProject, type CaptionProject } from "@cuebench/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CaptionGenerationClient,
  type CaptionGenerationClientPort,
  type GenerationClientReceipt,
  type GenerationProjectStore,
} from "./generation-client";
import { GenerationStatus } from "./GenerationStatus";

const human = { type: "Human" as const, id: "human" };

const projectFixture = (): CaptionProject => createProject({
  projectId: "generation-project",
  title: "Caption generation fixture",
  media: {
    sourceId: "source-generation",
    sha256: "a".repeat(64),
    durationMs: 60_000,
    relinkState: "Linked",
  },
  captions: [
    {
      kind: "CaptionCue",
      itemId: "sustained-caption",
      state: "Sustained",
      startMs: 1_000,
      endMs: 2_000,
      text: "A sustained human caption.",
      speaker: null,
      actor: human,
      cause: "fixture",
    },
    {
      kind: "CaptionCue",
      itemId: "proposed-caption",
      state: "Proposed",
      startMs: 2_000,
      endMs: 3_000,
      text: "An earlier proposed caption.",
      speaker: null,
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      cause: "fixture",
    },
  ],
});

const receipt: GenerationClientReceipt = {
  version: 1,
  runId: "caption-run",
  projectId: "generation-project",
  signedGenerationReceipt: "opaque-generation-receipt",
  expectedProjectRevision: 2,
  expectedQualityProfileRevision: 1,
  mediaSha256: "a".repeat(64),
  savedAtMs: 1_700_000_000_000,
};

afterEach(() => cleanup());

describe("caption generation browser recovery", () => {
  it("persists the signed receipt after lease acquisition and before the first status poll", async () => {
    let project = projectFixture();
    const order: string[] = [];
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project }),
      executeCommand: async (command) => {
        order.push(command.type);
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, saved) => {
        order.push("persist-receipt");
        expect(saved.signedGenerationReceipt).toBe("opaque-generation-receipt");
      },
      loadCaptionGenerationReceipt: async () => null,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      order.push(path.includes("/generation-runs/caption-run") ? "poll" : "start-request");
      if ((init?.method ?? "GET") === "POST") {
        return Response.json({
          generationRunReceipt: receipt.signedGenerationReceipt,
          status: {
            contractVersion: 1,
            runId: receipt.runId,
            projectId: receipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: receipt.expectedProjectRevision,
            stage: "Queued",
          },
        }, { status: 201 });
      }
      return Response.json({
        status: {
          contractVersion: 1,
          runId: receipt.runId,
          projectId: receipt.projectId,
          targetTrack: "Captions",
          expectedProjectRevision: receipt.expectedProjectRevision,
          stage: "PreparingMedia",
          progress: 0,
        },
      });
    });
    const client = new CaptionGenerationClient({ fetcher, createRunId: () => "caption-run", clock: () => receipt.savedAtMs });

    const started = await client.start({
      project,
      store,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt" },
    });
    await client.status(started.receipt);

    expect(order).toEqual(["StartGenerationRun", "start-request", "persist-receipt", "poll"]);
  });

  it("requires visible human confirmation before replacing existing Proposed captions while naming Sustained work as preserved", async () => {
    const project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const adopt = vi.fn(async () => ({ project, events: [] }));
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "AwaitingAdoption" as const,
      })),
      cancel: vi.fn(),
      adopt,
      loadStoredReceipt: vi.fn(async () => receipt),
    };
    const store = { getSnapshot: () => ({ project }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={project} store={store} client={client} uploadRecovery={{ operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt" }} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /replace proposed captions/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /replace proposed captions/i }));
    expect(screen.getByRole("dialog", { name: /replace existing proposed captions/i })).toHaveTextContent(/sustained captions remain untouched/i);
    expect(adopt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm replacement of proposed captions/i }));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      confirmedProposedReplacement: true,
    })));
  });
});
