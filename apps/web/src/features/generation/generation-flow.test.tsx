import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StagedGenerationResultSchema } from "@cuebench/contracts";
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
const projectOwnerCapability = "1".repeat(64);

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
  session: "anonymous-session",
  expectedProjectRevision: 2,
  expectedQualityProfileRevision: 1,
  mediaSha256: "a".repeat(64),
  sourceByteLength: 5,
  sourceDurationMs: 60_000,
  projectOwnerCapability,
  savedAtMs: 1_700_000_000_000,
  retentionExpiresAtMs: 1_700_086_400_000,
};

afterEach(() => cleanup());

describe("caption generation browser recovery", () => {
  it("does not acquire a lease or dispatch durable generation from temporary browser storage", async () => {
    const project = projectFixture();
    const executeCommand = vi.fn();
    const fetcher = vi.fn();
    const store = {
      getSnapshot: () => ({ project, mode: "temporary" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    } as unknown as GenerationProjectStore;
    const client = new CaptionGenerationClient({ fetcher, createRunId: () => "temporary-run" });

    await expect(client.start({
      project,
      store,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
    })).rejects.toMatchObject({ details: { code: "DURABLE_STORAGE_REQUIRED" } });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors an agent abort after an awaited reservation and before acquiring a caption lease", async () => {
    let project = projectFixture();
    let releaseReservation: () => void = () => { throw new Error("Reservation was not reached."); };
    const controller = new AbortController();
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn();
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: vi.fn(),
      reserveCaptionGenerationReceipt: async () => new Promise<void>((resolve) => { releaseReservation = resolve; }),
      releaseCaptionGenerationReceiptReservation: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher, createRunId: () => "aborted-caption-run" });
    const pending = client.start({
      project,
      store,
      signal: controller.signal,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
    });
    await Promise.resolve();
    controller.abort();
    releaseReservation();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(project.activeGenerationRun).toBeNull();
  });

  it("does not let the lease-driven WebMCP family replacement abort its own caption POST", async () => {
    let project = projectFixture();
    const groupController = new AbortController();
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // This mirrors a browser fetch implementation: a replacement-family
      // abort must not leak into the durable POST after the lease committed.
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      const base = project.activeGenerationRun?.base;
      if (base?.targetTrack !== "Captions") throw new Error("expected caption lease");
      return Response.json({
        generationRunReceipt: "opaque-generation-receipt",
        retentionExpiresAtMs: receipt.retentionExpiresAtMs,
        status: {
          contractVersion: 1,
          runId: "self-swap-caption-run",
          projectId: project.projectId,
          targetTrack: "Captions",
          expectedProjectRevision: base.expectedProjectRevision,
          stage: "Queued",
        },
      }, { status: 201 });
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher, createRunId: () => "self-swap-caption-run", clock: () => receipt.savedAtMs });

    await expect(client.start({
      project,
      store,
      signal: groupController.signal,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
      onLifecycleEvent: (event) => { if (event.phase === "lease-acquired") groupController.abort(); },
    })).resolves.toMatchObject({ status: { runId: "self-swap-caption-run", stage: "Queued" } });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("stops caption cancellation before its durable intent when the invocation is already aborted", async () => {
    const project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    const controller = new AbortController();
    controller.abort();
    const persistCaptionGenerationReceipt = vi.fn();
    const fetcher = vi.fn();
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt,
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher });

    await expect(client.cancel({ project, store, receipt: runReceipt, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(persistCaptionGenerationReceipt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let the cancellation-intent family replacement abort its own caption DELETE", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    const groupController = new AbortController();
    const persistCaptionGenerationReceipt = vi.fn(async () => { groupController.abort(); });
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return Response.json({
        status: {
          contractVersion: 1,
          runId: runReceipt.runId,
          projectId: runReceipt.projectId,
          targetTrack: "Captions",
          expectedProjectRevision: runReceipt.expectedProjectRevision,
          stage: "Cancelled",
        },
        cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: receipt.savedAtMs, completedAtMs: receipt.savedAtMs + 1 },
      });
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt,
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher });

    await expect(client.cancel({ project, store, receipt: runReceipt, signal: groupController.signal })).resolves.toMatchObject({ stage: "Cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("retains and reports the exact caption run identity when dispatch is ambiguous after lease acquisition", async () => {
    let project = projectFixture();
    const events: string[] = [];
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({
      createRunId: () => "ambiguous-caption-run",
      fetcher: async () => { throw new Error("transport interrupted after dispatch"); },
      clock: () => receipt.savedAtMs,
    });

    await expect(client.start({
      project,
      store,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
      onLifecycleEvent: (event) => events.push(event.phase),
    })).rejects.toMatchObject({
      details: { lifecycleOutcome: { runId: "ambiguous-caption-run", targetTrack: "Captions", disposition: "accepted-unknown" } },
    });
    expect(project.activeGenerationRun).toMatchObject({ runId: "ambiguous-caption-run", targetTrack: "Captions" });
    expect(events).toEqual(["lease-acquired", "dispatch-uncertain"]);
  });

  it("persists the signed receipt after lease acquisition and before the first status poll", async () => {
    let project = projectFixture();
    const order: string[] = [];
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
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
          retentionExpiresAtMs: receipt.retentionExpiresAtMs,
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
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
    });
    await client.status(started.receipt);

    expect(order).toEqual(["StartGenerationRun", "start-request", "persist-receipt", "poll"]);
  });

  it("retries an ambiguous start with the immutable caption-lease base after permitted unrelated edits", async () => {
    const original = projectFixture();
    const leased = applyCommand(original, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: "caption-run",
      targetTrack: "Captions",
      expectedProjectRevision: original.projectRevision,
    }).project;
    // Model a permitted unrelated Audio Description edit. The target caption
    // base remains the newly leased revision even though the project counter
    // has advanced before the browser retries its ambiguous POST.
    const advanced = { ...leased, projectRevision: leased.projectRevision + 1 };
    let sent: Record<string, unknown> | null = null;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project: advanced, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({
      createRunId: () => "different-run-must-not-be-used",
      clock: () => receipt.savedAtMs,
      fetcher: async (_input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          generationRunReceipt: receipt.signedGenerationReceipt,
          retentionExpiresAtMs: receipt.retentionExpiresAtMs,
          status: {
            contractVersion: 1,
            runId: "caption-run",
            projectId: advanced.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: leased.activeGenerationRun!.base!.expectedProjectRevision,
            stage: "Queued",
          },
        });
      },
    });

    await client.start({
      project: advanced,
      store,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
    });

    expect(sent).toMatchObject({
      runId: "caption-run",
      expectedProjectRevision: leased.activeGenerationRun!.base!.expectedProjectRevision,
      expectedQualityProfileRevision: leased.activeGenerationRun!.base!.qualityProfileRevision,
      mediaSha256: leased.activeGenerationRun!.base!.mediaSha256,
    });
  });

  it.each(["GENERATION_RECORD_UNCERTAIN", "GENERATION_LEASE_UNCERTAIN"])("retains the same local caption lease when %s leaves durable dispatch ambiguous", async (code) => {
    let project = projectFixture();
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({
      createRunId: () => "durable-ambiguity-run",
      fetcher: async () => Response.json({ error: { code, message: "durable outcome unknown" } }, { status: 503 }),
    });

    await expect(client.start({
      project,
      store,
      upload: { operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability },
    })).rejects.toMatchObject({ details: { code, dispatchMayBeDurable: true } });

    expect(project.activeGenerationRun?.runId).toBe("durable-ambiguity-run");
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "StartGenerationRun", runId: "durable-ambiguity-run" }), project.projectId);
  });

  it("upgrades an earlier durable receipt with the documented bounded retention deadline", async () => {
    const project = projectFixture();
    const legacy = { ...receipt } as Record<string, unknown>;
    delete legacy.retentionExpiresAtMs;
    const store = {
      loadCaptionGenerationReceipt: async () => legacy,
    } as unknown as GenerationProjectStore;
    const client = new CaptionGenerationClient({ fetcher: vi.fn(), clock: () => receipt.savedAtMs });

    await expect(client.loadStoredReceipt(store, project, receipt.runId)).resolves.toMatchObject({
      retentionExpiresAtMs: receipt.savedAtMs + 24 * 60 * 60 * 1_000,
    });
  });

  it("acknowledges server cleanup only after the local expected-revision adoption commits", async () => {
    const original = projectFixture();
    const leased = applyCommand(original, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: original.projectRevision,
    }).project;
    const adoptedProject = { ...leased, activeGenerationRun: null, projectRevision: leased.projectRevision + 1 };
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
    };
    const staged = StagedGenerationResultSchema.parse({
      contractVersion: 1,
      runId: runReceipt.runId,
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      evidence: {
        contractVersion: 1,
        runId: runReceipt.runId,
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/fixture/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/fixture/audio.wav", sha256: "c".repeat(64), byteLength: 1, durationMs: leased.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: "word-fixture-1", startMs: 0, endMs: 1_000, text: "Fixture", speaker: "A", speakerSegmentIds: ["speaker-fixture-1"], sourceWordIndex: 0 }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null },
        ],
      },
      captions: [{ cueId: "generated-caption", startMs: 0, endMs: 1_000, text: "Fixture", speaker: "A", evidenceIds: ["word-fixture-1"] }],
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const order: string[] = [];
    const adoptStagedCaptionGenerationResult = vi.fn(async () => {
      order.push("local-adoption");
      return { project: adoptedProject, events: [] };
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project: leased, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: vi.fn(),
      adoptStagedCaptionGenerationResult,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.endsWith("/staged-result")) {
        order.push("staged-result");
        return Response.json({ result: staged });
      }
      order.push("acknowledge");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "adopted", adoptedProjectRevision: adoptedProject.projectRevision });
      return Response.json({
        status: {
          contractVersion: 1,
          runId: runReceipt.runId,
          projectId: runReceipt.projectId,
          targetTrack: "Captions",
          expectedProjectRevision: runReceipt.expectedProjectRevision,
          stage: "Completed",
          adoptedProjectRevision: adoptedProject.projectRevision,
        },
        cleanup: { version: 1, state: "completed", action: "adopted", artifactKeys: [], requestedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_000_000 },
      });
    });
    const client = new CaptionGenerationClient({ fetcher, clock: () => receipt.savedAtMs });

    await expect(client.adopt({
      project: leased,
      store,
      receipt: runReceipt,
      confirmedProposedReplacement: true,
    })).resolves.toMatchObject({ project: { projectRevision: adoptedProject.projectRevision } });
    expect(order).toEqual(["staged-result", "local-adoption", "acknowledge"]);
  });

  it("keeps a durable pending cleanup acknowledgement visible while the server drains a late preparation write", async () => {
    const original = projectFixture();
    const leased = applyCommand(original, {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: original.projectRevision,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
    };
    const staged = StagedGenerationResultSchema.parse({
      contractVersion: 1,
      runId: runReceipt.runId,
      projectId: leased.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: leased.projectRevision,
      expectedQualityProfileRevision: leased.qualityProfile.revision,
      evidence: {
        contractVersion: 1,
        runId: runReceipt.runId,
        projectId: leased.projectId,
        mediaSha256: leased.media.sha256,
        preparedManifest: { key: "prepared/fixture/manifest.json", sha256: "b".repeat(64) },
        normalizedAudio: { key: "prepared/fixture/audio.wav", sha256: "c".repeat(64), byteLength: 1, durationMs: leased.media.durationMs, contentType: "audio/wav" },
        words: [{ evidenceId: "word-fixture-1", startMs: 0, endMs: 1_000, text: "Fixture", speaker: "A", speakerSegmentIds: ["speaker-fixture-1"], sourceWordIndex: 0 }],
        uncertaintySpans: [],
        provenance: [
          { role: "diarization", model: "fixture", requestHash: "d".repeat(64), responseHash: "e".repeat(64), store: null },
          { role: "word-timestamps", model: "fixture", requestHash: "f".repeat(64), responseHash: "0".repeat(64), store: null },
        ],
      },
      captions: [{ cueId: "generated-caption", startMs: 0, endMs: 1_000, text: "Fixture", speaker: "A", evidenceIds: ["word-fixture-1"] }],
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const adoptedProject = { ...leased, activeGenerationRun: null, projectRevision: leased.projectRevision + 1 };
    let storedReceipt: GenerationClientReceipt = runReceipt;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project: leased, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: async (_runId, value) => { storedReceipt = value; },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: async () => ({ project: adoptedProject, events: [] }),
    };
    let acknowledgeAttempts = 0;
    const client = new CaptionGenerationClient({
      fetcher: async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/staged-result")) return Response.json({ result: staged });
        acknowledgeAttempts += 1;
        if (acknowledgeAttempts === 1) return Response.json({
          status: {
            contractVersion: 1,
            runId: runReceipt.runId,
            projectId: runReceipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: runReceipt.expectedProjectRevision,
            stage: "Completed",
            adoptedProjectRevision: adoptedProject.projectRevision,
          },
          cleanup: { version: 1, state: "pending", action: "adopted", artifactKeys: [], requestedAtMs: 1_700_000_000_000 },
        });
        return Response.json({
          status: {
            contractVersion: 1,
            runId: runReceipt.runId,
            projectId: runReceipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: runReceipt.expectedProjectRevision,
            stage: "Completed",
            adoptedProjectRevision: adoptedProject.projectRevision,
          },
          cleanup: { version: 1, state: "completed", action: "adopted", artifactKeys: [], requestedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_000_001 },
        });
      },
      clock: () => receipt.savedAtMs,
    });

    await expect(client.adopt({
      project: leased,
      store,
      receipt: runReceipt,
      confirmedProposedReplacement: true,
    })).resolves.toMatchObject({ project: { projectRevision: adoptedProject.projectRevision } });
    expect(storedReceipt.adoption?.cleanupAcknowledgement).toBe("pending");

    await client.retryAdoptionCleanup({ store, receipt: storedReceipt });
    expect(acknowledgeAttempts).toBe(2);
    expect(storedReceipt.adoption?.cleanupAcknowledgement).toBe("acknowledged");
  });

  it("releases a confirmed Cancelled caption lease while private cleanup remains independently retryable", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    let storedReceipt = runReceipt;
    const executeCommand = vi.fn(async (command) => {
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: async (_runId, saved) => { storedReceipt = saved; },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    let attempts = 0;
    const client = new CaptionGenerationClient({
      fetcher: async () => {
        attempts += 1;
        return Response.json({
          status: {
            contractVersion: 1,
            runId: runReceipt.runId,
            projectId: runReceipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: runReceipt.expectedProjectRevision,
            stage: "Cancelled",
          },
          cleanup: attempts === 1
            ? { version: 1, state: "pending", action: "cancelled", artifactKeys: [], requestedAtMs: 1_700_000_000_000 }
            : { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_000_001 },
        });
      },
      clock: () => runReceipt.savedAtMs,
    });

    await expect(client.cancel({ project, store, receipt: runReceipt })).resolves.toMatchObject({ stage: "Cancelled" });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "ReleaseGenerationRun", runId: runReceipt.runId }), project.projectId);
    expect(project.activeGenerationRun).toBeNull();
    expect(storedReceipt.terminalCleanup?.cleanupAcknowledgement).toBe("pending");
    expect(storedReceipt.terminalCleanup?.localLeaseRelease).toBe("released");

    await client.retryCancellationCleanup({ project, store, receipt: storedReceipt });
    expect(attempts).toBe(2);
    expect(storedReceipt.terminalCleanup?.cleanupAcknowledgement).toBe("acknowledged");
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "ReleaseGenerationRun", runId: runReceipt.runId }), project.projectId);
    expect(project.activeGenerationRun).toBeNull();
  });

  it("keeps a BrowserAgent-attributed caption cancellation recoverable when local lease release fails", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    let stored = runReceipt;
    const executeCommand = vi.fn(async (command) => {
      if (command.type === "ReleaseGenerationRun") throw new Error("local release unavailable");
      const result = applyCommand(project, command);
      project = result.project;
      return result;
    });
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt: async (_runId, value) => { stored = value; },
      loadCaptionGenerationReceipt: async () => stored,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const events: string[] = [];
    const client = new CaptionGenerationClient({
      fetcher: async () => Response.json({
        status: { contractVersion: 1, runId: runReceipt.runId, projectId: runReceipt.projectId, targetTrack: "Captions", expectedProjectRevision: runReceipt.expectedProjectRevision, stage: "Cancelled" },
        cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: receipt.savedAtMs, completedAtMs: receipt.savedAtMs + 1 },
      }),
      clock: () => receipt.savedAtMs,
    });

    await expect(client.cancel({
      project,
      store,
      receipt: runReceipt,
      actor: { type: "BrowserAgent", id: "browser-agent" },
      onLifecycleEvent: (event) => events.push(event.phase),
    })).rejects.toMatchObject({
      details: { lifecycleOutcome: { runId: runReceipt.runId, targetTrack: "Captions", disposition: "lifecycle-pending" } },
    });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "ReleaseGenerationRun",
      actor: { type: "BrowserAgent", id: "browser-agent" },
    }), project.projectId);
    expect(project.activeGenerationRun?.runId).toBe(runReceipt.runId);
    expect(stored.terminalCleanup).toMatchObject({ action: "cancelled", localLeaseRelease: "pending" });
    expect(events).toEqual(["cancellation-intent-persisted", "remote-cancelled"]);
  });

  it("recovers a local caption-lease release after cleanup was acknowledged but the browser crashed before release", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    let storedReceipt = runReceipt;
    let releaseAttempts = 0;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        if (command.type === "ReleaseGenerationRun" && releaseAttempts++ === 0) throw new Error("simulated tab crash after receipt persistence");
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, saved) => { storedReceipt = saved; },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    let remoteCalls = 0;
    const client = new CaptionGenerationClient({
      fetcher: async () => {
        remoteCalls += 1;
        return Response.json({
          status: {
            contractVersion: 1,
            runId: runReceipt.runId,
            projectId: runReceipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: runReceipt.expectedProjectRevision,
            stage: "Cancelled",
          },
          cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_000_001 },
        });
      },
    });

    await expect(client.cancel({ project, store, receipt: runReceipt })).rejects.toThrow(/simulated tab crash/i);
    expect(storedReceipt.terminalCleanup).toMatchObject({
      cleanupAcknowledgement: "acknowledged",
      localLeaseRelease: "pending",
    });
    expect(project.activeGenerationRun?.runId).toBe(runReceipt.runId);

    await client.retryCancellationCleanup({ project, store, receipt: storedReceipt });
    expect(remoteCalls).toBe(1);
    expect(storedReceipt.terminalCleanup).toMatchObject({
      cleanupAcknowledgement: "acknowledged",
      localLeaseRelease: "released",
    });
    expect(project.activeGenerationRun).toBeNull();
  });

  it("releases a cancelled lease after its recorded retention deadline without falsely acknowledging lifecycle cleanup", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const expiringReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      retentionExpiresAtMs: receipt.savedAtMs + 1,
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: "pending",
        localLeaseRelease: "pending",
      },
    };
    let storedReceipt = expiringReceipt;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, saved) => { storedReceipt = saved; },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const fetcher = vi.fn(async () => { throw new Error("expired terminal recovery must not call an unusable cloud receipt"); });
    const client = new CaptionGenerationClient({ fetcher, clock: () => expiringReceipt.retentionExpiresAtMs });

    await client.retryCancellationCleanup({ project, store, receipt: expiringReceipt });

    expect(fetcher).not.toHaveBeenCalled();
    expect(storedReceipt.terminalCleanup).toEqual({
      action: "cancelled",
      cleanupAcknowledgement: "lifecycle-pending",
      localLeaseRelease: "released",
    });
    expect(project.activeGenerationRun).toBeNull();
  });

  it.each(["active", "failed", "awaiting adoption"])("settles an expired %s run without retaining a permanent caption lease", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const expiredReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      retentionExpiresAtMs: receipt.savedAtMs + 1,
    };
    let storedReceipt: GenerationClientReceipt = expiredReceipt;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, value) => { storedReceipt = value; },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher: vi.fn(), clock: () => expiredReceipt.retentionExpiresAtMs });

    await expect(client.loadStoredReceipt(store, project, expiredReceipt.runId)).resolves.toMatchObject({
      expirySettlement: { state: "lifecycle-pending", disposition: "receipt-expired", localLeaseRelease: "released" },
    });
    expect(project.activeGenerationRun).toBeNull();
    expect(storedReceipt.expirySettlement).toMatchObject({ localLeaseRelease: "released" });
  });

  it("peeks an expired caption receipt without settling, releasing, or writing recovery state", async () => {
    const project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const expired: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      retentionExpiresAtMs: receipt.savedAtMs + 1,
    };
    const persist = vi.fn();
    const execute = vi.fn();
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: execute,
      persistCaptionGenerationReceipt: persist,
      loadCaptionGenerationReceipt: async () => expired,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const before = project;
    const client = new CaptionGenerationClient({ clock: () => expired.retentionExpiresAtMs });

    await expect(client.peekStoredReceipt(store, project, expired.runId)).resolves.toMatchObject({ runId: expired.runId });
    expect(project).toBe(before);
    expect(execute).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("settles pending adoption cleanup and an unconfirmed cancellation intent truthfully at owner-capability expiry", async () => {
    const expiredAtMs = receipt.savedAtMs + 1;
    const adoptedProject = { ...projectFixture(), activeGenerationRun: null };
    let adoptedReceipt: GenerationClientReceipt = {
      ...receipt,
      retentionExpiresAtMs: expiredAtMs,
      adoption: {
        status: "adopted",
        adoptedProjectRevision: adoptedProject.projectRevision,
        localEvidencePackageId: "generation-caption-run",
        cleanupAcknowledgement: "pending",
      },
    };
    const adoptionStore: GenerationProjectStore = {
      getSnapshot: () => ({ project: adoptedProject, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: async (_runId, value) => { adoptedReceipt = value; },
      loadCaptionGenerationReceipt: async () => adoptedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    const client = new CaptionGenerationClient({ fetcher: vi.fn(), clock: () => expiredAtMs });
    await expect(client.loadStoredReceipt(adoptionStore, adoptedProject, adoptedReceipt.runId)).resolves.toMatchObject({
      adoption: { cleanupAcknowledgement: "lifecycle-pending" },
    });

    let cancellingProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    let cancellingReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: cancellingProject.projectRevision,
      expectedQualityProfileRevision: cancellingProject.qualityProfile.revision,
      retentionExpiresAtMs: expiredAtMs,
      cancellationRequested: { status: "requested" },
    };
    const cancellationStore: GenerationProjectStore = {
      getSnapshot: () => ({ project: cancellingProject, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(cancellingProject, command);
        cancellingProject = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, value) => { cancellingReceipt = value; },
      loadCaptionGenerationReceipt: async () => cancellingReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    await expect(client.loadStoredReceipt(cancellationStore, cancellingProject, cancellingReceipt.runId)).resolves.toMatchObject({
      expirySettlement: { state: "lifecycle-pending", disposition: "cancellation-unconfirmed", localLeaseRelease: "released" },
    });
    expect(cancellingProject.activeGenerationRun).toBeNull();
  });

  it("persists cancellation intent before DELETE so a post-response crash remains recoverable", async () => {
    let project = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const runReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: project.projectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
    };
    let storedReceipt = runReceipt;
    let persistAttempts = 0;
    const store: GenerationProjectStore = {
      getSnapshot: () => ({ project, mode: "durable" as const }),
      executeCommand: async (command) => {
        const result = applyCommand(project, command);
        project = result.project;
        return result;
      },
      persistCaptionGenerationReceipt: async (_runId, saved) => {
        persistAttempts += 1;
        if (persistAttempts === 2) throw new Error("simulated tab crash after authenticated DELETE");
        storedReceipt = saved;
      },
      loadCaptionGenerationReceipt: async () => storedReceipt,
      adoptStagedCaptionGenerationResult: vi.fn(),
    };
    let remoteCalls = 0;
    const client = new CaptionGenerationClient({
      fetcher: async () => {
        remoteCalls += 1;
        return Response.json({
          status: {
            contractVersion: 1,
            runId: runReceipt.runId,
            projectId: runReceipt.projectId,
            targetTrack: "Captions",
            expectedProjectRevision: runReceipt.expectedProjectRevision,
            stage: "Cancelled",
          },
          cleanup: { version: 1, state: "completed", action: "cancelled", artifactKeys: [], requestedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_000_001 },
        });
      },
      clock: () => runReceipt.savedAtMs,
    });

    await expect(client.cancel({ project, store, receipt: runReceipt })).rejects.toThrow(/simulated tab crash after authenticated DELETE/i);
    expect(storedReceipt.cancellationRequested).toEqual({ status: "requested" });
    expect(project.activeGenerationRun?.runId).toBe(runReceipt.runId);

    const reloadedReceipt = await client.loadStoredReceipt(store, project, runReceipt.runId);
    expect(reloadedReceipt?.cancellationRequested).toEqual({ status: "requested" });
    if (reloadedReceipt === null) throw new Error("expected write-ahead cancellation intent to survive receipt parsing");
    await client.retryCancellationCleanup({ project, store, receipt: reloadedReceipt });
    expect(remoteCalls).toBe(2);
    expect(storedReceipt.terminalCleanup).toMatchObject({ cleanupAcknowledgement: "acknowledged", localLeaseRelease: "released" });
    expect(project.activeGenerationRun).toBeNull();
  });

  it("recovers a pending cleanup acknowledgement after reload without an active caption lease", async () => {
    const adoptedProject: CaptionProject = {
      ...projectFixture(),
      activeGenerationRun: null,
      localEvidencePackages: [{
        runId: receipt.runId,
        retainedAtMs: receipt.savedAtMs,
      }] as unknown as CaptionProject["localEvidencePackages"],
    };
    const retryAdoptionCleanup = vi.fn(async (input: { readonly receipt: GenerationClientReceipt }) => input.receipt);
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup,
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => ({
        ...receipt,
        adoption: {
          status: "adopted" as const,
          adoptedProjectRevision: adoptedProject.projectRevision,
          localEvidencePackageId: `generation-${receipt.runId}`,
          cleanupAcknowledgement: "pending" as const,
        },
      })),
    };
    const store = { getSnapshot: () => ({ project: adoptedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={adoptedProject} store={store} client={client} uploadRecovery={null} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /retry private cleanup/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /retry private cleanup/i }));
    await waitFor(() => expect(retryAdoptionCleanup).toHaveBeenCalledWith(expect.objectContaining({ receipt: expect.objectContaining({ runId: receipt.runId }) })));
  });

  it("keeps a detached confirmed-cancellation cleanup receipt visible and retryable after reload", async () => {
    const editableProject = { ...projectFixture(), activeGenerationRun: null };
    const terminalReceipt: GenerationClientReceipt = {
      ...receipt,
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: "pending",
        localLeaseRelease: "released",
      },
    };
    const retryCancellationCleanup = vi.fn(async () => undefined);
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup,
      loadStoredReceipt: vi.fn(async () => terminalReceipt),
    };
    const store = {
      getSnapshot: () => ({ project: editableProject, mode: "durable" as const }),
      listCaptionGenerationReceiptRunIds: vi.fn(async () => [terminalReceipt.runId]),
    } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={editableProject} store={store} client={client} uploadRecovery={null} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /retry private cleanup/i })).toBeEnabled());
    expect(screen.getByText(/cancellation is confirmed and captions are editable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry private cleanup/i }));
    await waitFor(() => expect(retryCancellationCleanup).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ terminalCleanup: expect.objectContaining({ localLeaseRelease: "released" }) }),
    })));
  });

  it("keeps lifecycle-pending adoption and expired-capability recovery truthful after reload", async () => {
    const editableProject = { ...projectFixture(), activeGenerationRun: null };
    const lifecycleAdoption: GenerationClientReceipt = {
      ...receipt,
      adoption: {
        status: "adopted",
        adoptedProjectRevision: editableProject.projectRevision,
        localEvidencePackageId: `generation-${receipt.runId}`,
        cleanupAcknowledgement: "lifecycle-pending",
      },
    };
    const expiredActive: GenerationClientReceipt = {
      ...receipt,
      runId: "expired-active-run",
      expirySettlement: {
        state: "lifecycle-pending",
        disposition: "receipt-expired",
        localLeaseRelease: "released",
      },
    };
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(async (input) => input.receipt),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async (_store, _project, runId) => runId === lifecycleAdoption.runId ? lifecycleAdoption : expiredActive),
    };
    const store = {
      getSnapshot: () => ({ project: editableProject, mode: "durable" as const }),
      listCaptionGenerationReceiptRunIds: vi.fn(async () => [lifecycleAdoption.runId, expiredActive.runId]),
    } as unknown as GenerationProjectStore;

    const first = render(<GenerationStatus project={editableProject} store={store} client={client} uploadRecovery={null} />);
    await waitFor(() => expect(screen.getByText(/owner capability expired before CueBench could attest exact private-media deletion/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry private cleanup/i })).toBeNull();
    first.unmount();

    const expiredOnlyClient: CaptionGenerationClientPort = {
      ...client,
      loadStoredReceipt: vi.fn(async () => expiredActive),
    };
    render(<GenerationStatus project={editableProject} store={store} client={expiredOnlyClient} uploadRecovery={null} />);
    await waitFor(() => expect(screen.getByText(/generation owner capability expired before CueBench could confirm a terminal result/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry private cleanup/i })).toBeNull();
  });

  it("keeps cancellation cleanup visible and retryable after the server accepts cancellation but is still draining", async () => {
    const leasedProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    let recoveredReceipt: GenerationClientReceipt = receipt;
    const retryCancellationCleanup = vi.fn(async () => {
      recoveredReceipt = {
        ...recoveredReceipt,
        terminalCleanup: { action: "cancelled", cleanupAcknowledgement: "acknowledged", localLeaseRelease: "released" },
      };
    });
    const cancel = vi.fn(async () => {
      recoveredReceipt = {
        ...receipt,
        terminalCleanup: { action: "cancelled", cleanupAcknowledgement: "pending", localLeaseRelease: "pending" },
      };
      return {
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Cancelled" as const,
      };
    });
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
      cancel,
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup,
      loadStoredReceipt: vi.fn(async () => recoveredReceipt),
    };
    const store = { getSnapshot: () => ({ project: leasedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={leasedProject} store={store} client={client} uploadRecovery={{ operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability }} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /discard staged caption result/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /discard staged caption result/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /retry private cleanup/i })).toBeEnabled());
    expect(screen.getByText(/accepted cancellation.*still needs to finish/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry private cleanup/i }));
    await waitFor(() => expect(retryCancellationCleanup).toHaveBeenCalledWith(expect.objectContaining({ receipt: expect.objectContaining({ terminalCleanup: expect.objectContaining({ cleanupAcknowledgement: "pending" }) }) })));
  });

  it("keeps a write-ahead cancellation intent retryable after reload when polling reaches Cancelled", async () => {
    const leasedProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const requestedReceipt: GenerationClientReceipt = {
      ...receipt,
      expectedProjectRevision: leasedProject.projectRevision,
      expectedQualityProfileRevision: leasedProject.qualityProfile.revision,
      cancellationRequested: { status: "requested" },
    };
    const retryCancellationCleanup = vi.fn(async () => undefined);
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: requestedReceipt.runId,
        projectId: requestedReceipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: requestedReceipt.expectedProjectRevision,
        stage: "Cancelled" as const,
      })),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup,
      loadStoredReceipt: vi.fn(async () => requestedReceipt),
    };
    const store = { getSnapshot: () => ({ project: leasedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={leasedProject} store={store} client={client} uploadRecovery={null} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /retry private cleanup/i })).toBeEnabled());
    expect(screen.getByText(/recovering a cancellation request/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry private cleanup/i }));
    await waitFor(() => expect(retryCancellationCleanup).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ cancellationRequested: { status: "requested" } }),
    })));
  });

  it("recovers a reload between acknowledged cancellation cleanup and local lease release", async () => {
    const leasedProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const pendingReleaseReceipt: GenerationClientReceipt = {
      ...receipt,
      terminalCleanup: {
        action: "cancelled",
        cleanupAcknowledgement: "acknowledged",
        localLeaseRelease: "pending",
      },
    };
    const retryCancellationCleanup = vi.fn(async () => undefined);
    const client: CaptionGenerationClientPort = {
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup,
      loadStoredReceipt: vi.fn(async () => pendingReleaseReceipt),
    };
    const store = { getSnapshot: () => ({ project: leasedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={leasedProject} store={store} client={client} uploadRecovery={null} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /retry private cleanup/i })).toBeEnabled());
    expect(screen.getByText(/confirmed private temporary-media cleanup.*release the local caption lease/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry private cleanup/i }));
    await waitFor(() => expect(retryCancellationCleanup).toHaveBeenCalledWith(expect.objectContaining({ receipt: pendingReleaseReceipt })));
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
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => receipt),
    };
    const store = { getSnapshot: () => ({ project, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={project} store={store} client={client} uploadRecovery={{ operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability }} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /replace proposed captions/i })).toBeEnabled());
    const replace = screen.getByRole("button", { name: /replace proposed captions/i });
    replace.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: /replace existing proposed captions/i })).toHaveTextContent(/sustained captions remain untouched/i);
    expect(adopt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: /keep current captions/i })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /replace existing proposed captions/i })).toBeNull());
    expect(replace).toHaveFocus();

    await user.click(replace);
    await user.click(screen.getByRole("button", { name: /confirm replacement of proposed captions/i }));
    await waitFor(() => expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      confirmedProposedReplacement: true,
    })));
  });

  it("offers authenticated terminal discard/release controls for staged and failed runs", async () => {
    const leasedProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const renderTerminal = async (stage: "AwaitingAdoption" | "Failed", label: RegExp) => {
      const cancel = vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Cancelled" as const,
      }));
      const client: CaptionGenerationClientPort = {
        start: vi.fn(),
        status: vi.fn(async () => stage === "Failed"
          ? {
            contractVersion: 1 as const,
            runId: receipt.runId,
            projectId: receipt.projectId,
            targetTrack: "Captions" as const,
            expectedProjectRevision: receipt.expectedProjectRevision,
            stage: "Failed" as const,
            code: "GENERATION_STAGE_FAILED" as const,
            message: "Fixture failure",
            retryable: false,
          }
          : {
            contractVersion: 1 as const,
            runId: receipt.runId,
            projectId: receipt.projectId,
            targetTrack: "Captions" as const,
            expectedProjectRevision: receipt.expectedProjectRevision,
            stage: "AwaitingAdoption" as const,
          }),
        cancel,
        adopt: vi.fn(),
        retryAdoptionCleanup: vi.fn(),
        retryCancellationCleanup: vi.fn(),
        loadStoredReceipt: vi.fn(async () => receipt),
      };
      const store = { getSnapshot: () => ({ project: leasedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
      render(<GenerationStatus project={leasedProject} store={store} client={client} uploadRecovery={{ operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability }} />);
      await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeEnabled());
      await userEvent.setup().click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ receipt })));
      cleanup();
    };

    await renderTerminal("AwaitingAdoption", /discard staged caption result/i);
    await renderTerminal("Failed", /release failed caption lease/i);
  });

  it("retries a visible retryable failure with the retained same-run receipt instead of releasing its lease", async () => {
    const leasedProject = applyCommand(projectFixture(), {
      type: "StartGenerationRun",
      actor: { type: "CueBenchAI", id: "cuebench-ai" },
      runId: receipt.runId,
      targetTrack: "Captions",
      expectedProjectRevision: 1,
    }).project;
    const started = vi.fn(async () => ({
      receipt,
      status: {
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Queued" as const,
      },
    }));
    const client: CaptionGenerationClientPort = {
      start: started,
      status: vi.fn(async () => ({
        contractVersion: 1 as const,
        runId: receipt.runId,
        projectId: receipt.projectId,
        targetTrack: "Captions" as const,
        expectedProjectRevision: receipt.expectedProjectRevision,
        stage: "Failed" as const,
        code: "GENERATION_STAGE_FAILED" as const,
        message: "Temporary durable binding failure",
        retryable: true,
      })),
      cancel: vi.fn(),
      adopt: vi.fn(),
      retryAdoptionCleanup: vi.fn(),
      retryCancellationCleanup: vi.fn(),
      loadStoredReceipt: vi.fn(async () => receipt),
    };
    const store = { getSnapshot: () => ({ project: leasedProject, mode: "durable" as const }) } as unknown as GenerationProjectStore;
    const user = userEvent.setup();

    render(<GenerationStatus project={leasedProject} store={store} client={client} uploadRecovery={{ operationId: "upload-run", session: "anonymous-session", operationReceipt: "opaque-upload-receipt", sourceByteLength: 5, sourceSha256: "a".repeat(64), durationMs: 60_000, projectOwnerCapability }} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /retry caption generation/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /retry caption generation/i }));
    await waitFor(() => expect(started).toHaveBeenCalledWith(expect.objectContaining({
      project: leasedProject,
      upload: expect.objectContaining({ operationId: "upload-run" }),
    })));
  });
});
