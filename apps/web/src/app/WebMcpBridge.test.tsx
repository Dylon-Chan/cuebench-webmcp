import {
  applyCommand,
  createProject,
  prepareTrackExport,
  type CaptionProject,
  type DomainCommand,
  type ProjectTrackExportRequest,
} from "@cuebench/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelContextLike,
  ModelContextRegistrationOptions,
  ModelContextTool,
} from "@cuebench/webmcp";
import type { BoundGenerationProjectStore, ProjectStore } from "../features/project/project-store";
import type { NarrationPreviewGateway, NarrationPreviewSynthesis } from "../features/review/NarrationPreview";
import { WebMcpBridge, type WebMcpBridgeProps } from "./WebMcpBridge";

const browserAgent = { type: "BrowserAgent" as const, id: "browser-agent" };
const cueBenchAi = { type: "CueBenchAI" as const, id: "cuebench-ai" };

interface RegisteredTool {
  readonly tool: ModelContextTool;
  readonly signal: AbortSignal | undefined;
}

class FakeModelContext implements ModelContextLike {
  public readonly tools = new Map<string, ModelContextTool>();
  public readonly registrations: RegisteredTool[] = [];

  public registerTool(tool: ModelContextTool, options?: ModelContextRegistrationOptions): void {
    const record = { tool, signal: options?.signal };
    this.registrations.push(record);
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    }, { once: true });
  }

  public async invoke(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`Tool ${name} is not currently registered.`);
    return tool.execute(input, signal === undefined ? undefined : { signal });
  }
}

interface PendingRegistration {
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

class ControllableModelContext extends FakeModelContext {
  public holdRegistrations = false;
  public readonly pendingRegistrations: PendingRegistration[] = [];

  public override registerTool(tool: ModelContextTool, options?: ModelContextRegistrationOptions): void | Promise<void> {
    super.registerTool(tool, options);
    if (!this.holdRegistrations) return;
    return new Promise<void>((resolve, reject) => {
      this.pendingRegistrations.push({ resolve, reject });
    });
  }

  public resolvePendingRegistrations(): void {
    const pending = this.pendingRegistrations.splice(0);
    for (const registration of pending) registration.resolve();
  }

  public rejectPendingRegistrations(reason = new Error("registration rejected")): void {
    const pending = this.pendingRegistrations.splice(0);
    for (const registration of pending) registration.reject(reason);
  }
}

interface MutableBridgeStore {
  readonly asProjectStore: ProjectStore;
  readonly current: () => CaptionProject;
  readonly projectInstanceEpoch: () => number;
  readonly replaceProject: (project: CaptionProject) => void;
  /** Simulates an imported durable replacement before React receives its next snapshot. */
  readonly replaceProjectSilently: (project: CaptionProject) => void;
}

interface MutableBridgeStoreOptions {
  readonly mode?: "durable" | "temporary";
  readonly captionReceipt?: unknown | null;
  readonly audioDescriptionReceipt?: unknown | null;
  readonly projectOwnerCapability?: string | null;
}

/**
 * Browser-bridge tests that use an in-memory store still need to exercise
 * the production requirement that generation clients receive a bound facade,
 * never the raw ProjectStore. The real ProjectStore supplies a durable
 * capability fence; this fixture has no second durable context to fence, so
 * its facade deliberately delegates to its same in-memory backing object.
 */
const withGenerationFacade = <T extends object>(store: T): T & Pick<ProjectStore, "bindGenerationStore" | "bindNarrationPreviewGateway"> => {
  Object.assign(store, {
    bindGenerationStore: () => store as unknown as BoundGenerationProjectStore,
    bindNarrationPreviewGateway: () => (
      store as unknown as { readonly getNarrationPreviewGateway: () => NarrationPreviewGateway }
    ).getNarrationPreviewGateway(),
  });
  return store as T & Pick<ProjectStore, "bindGenerationStore" | "bindNarrationPreviewGateway">;
};

const createMutableStore = (
  initial: CaptionProject,
  publish: (project: CaptionProject) => void,
  narrationPreviewGateway?: NarrationPreviewGateway,
  options: MutableBridgeStoreOptions = {},
): MutableBridgeStore => {
  let current = initial;
  let projectInstanceEpoch = 1;
  const update = (project: CaptionProject, rotateProjectInstance = false, publishSnapshot = true) => {
    if (rotateProjectInstance) projectInstanceEpoch += 1;
    current = project;
    if (publishSnapshot) publish(project);
  };
  const store = withGenerationFacade({
    getSnapshot: () => ({ project: current, mode: options.mode ?? "temporary" }),
    getProjectInstanceEpoch: () => projectInstanceEpoch,
    executeCommand: async (command: DomainCommand) => {
      const result = applyCommand(current, command);
      if (result.error === undefined) update(result.project);
      return result;
    },
    prepareFreshTrackExport: async (request: ProjectTrackExportRequest) => ({
      project: current,
      prepared: prepareTrackExport({ ...request, project: current }),
      freshnessNotice: null,
    }),
    getCloudProjectOwnerCapability: async () => options.projectOwnerCapability ?? null,
    loadCaptionGenerationReceipt: async () => options.captionReceipt ?? null,
    loadAudioDescriptionGenerationReceipt: async () => options.audioDescriptionReceipt ?? null,
    getNarrationPreviewGateway: () => {
      if (narrationPreviewGateway === undefined) throw new Error("Narration preview is not configured for this fixture.");
      return narrationPreviewGateway;
    },
  });
  return {
    asProjectStore: store as unknown as ProjectStore,
    current: () => current,
    projectInstanceEpoch: () => projectInstanceEpoch,
    replaceProject: (project) => update(project, true),
    replaceProjectSilently: (project) => update(project, true, false),
  };
};

interface BridgeHarnessProps extends Omit<WebMcpBridgeProps, "project" | "store"> {
  readonly initial: CaptionProject;
  readonly onStore: (store: MutableBridgeStore) => void;
  readonly narrationPreviewGateway?: NarrationPreviewGateway;
  readonly storeOptions?: MutableBridgeStoreOptions;
}

function BridgeHarness({ initial, onStore, narrationPreviewGateway, storeOptions, ...props }: BridgeHarnessProps) {
  const [project, setProject] = useState(initial);
  const storeRef = useRef<MutableBridgeStore | null>(null);
  if (storeRef.current === null) storeRef.current = createMutableStore(initial, setProject, narrationPreviewGateway, storeOptions);
  useEffect(() => { onStore(storeRef.current!); }, [onStore]);
  return <WebMcpBridge project={project} store={storeRef.current.asProjectStore} {...props} />;
}

const baseProject = (input: {
  readonly cueState?: "Proposed" | "Objected" | "Sustained";
  readonly withAd?: boolean;
  readonly withGap?: boolean;
  readonly withSecondCue?: boolean;
} = {}): CaptionProject => createProject({
  projectId: "project-webmcp",
  title: "WebMCP fixture",
  media: {
    sourceId: "source-webmcp",
    sha256: "a".repeat(64),
    durationMs: 90_000,
    relinkState: "Linked",
  },
  captions: [{
    kind: "CaptionCue",
    itemId: "cue-1",
    state: input.cueState ?? "Proposed",
    startMs: 1_000,
    endMs: 3_000,
    text: "A reviewable caption.",
    speaker: "Teacher",
    actor: input.cueState === undefined || input.cueState === "Proposed"
      ? browserAgent
      : { type: "Human" as const, id: "teacher" },
    cause: "fixture",
  }, ...(input.withSecondCue ? [{
    kind: "CaptionCue" as const,
    itemId: "cue-2",
    state: "Objected" as const,
    startMs: 5_000,
    endMs: 6_000,
    // Deliberately exceeds the default reading-speed limit so validation
    // produces a current, item-bound target distinct from selected cue-1.
    text: "A deliberately very long caption sentence used only to create a deterministic reading-speed finding for Browser Agent focus testing.",
    speaker: "Teacher",
    actor: { type: "Human" as const, id: "teacher" },
    cause: "fixture",
  }] : [])],
  ...(input.withAd ? { audioDescriptions: [{
    kind: "AudioDescriptionBeat" as const,
    itemId: "ad-1",
    state: "Objected" as const,
    startMs: 4_000,
    endMs: 6_000,
    description: "A map fills the frame.",
    actor: { type: "Human" as const, id: "teacher" },
    cause: "fixture",
  }] } : {}),
  ...(input.withGap ? { audioDescriptionGaps: [{
    gapId: "gap-1",
    gapRevision: 1,
    state: "Available" as const,
    startMs: 10_000,
    endMs: 14_000,
  }] } : {}),
});

const selectItem = (project: CaptionProject, itemId: string): CaptionProject => {
  const item = project.captions.items[itemId] ?? project.audioDescriptions.items[itemId];
  if (item === undefined) throw new Error(`Fixture item ${itemId} is missing.`);
  const result = applyCommand(project, {
    type: "SelectItem",
    actor: browserAgent,
    itemId,
    expectedItemRevision: item.current.itemRevision,
    expectedProjectRevision: project.projectRevision,
  });
  if (result.error !== undefined) throw new Error(result.error.message);
  return result.project;
};

const focusGap = (project: CaptionProject): CaptionProject => {
  const result = applyCommand(project, {
    type: "FocusGap",
    actor: browserAgent,
    gapId: "gap-1",
    expectedGapRevision: 1,
    expectedProjectRevision: project.projectRevision,
  });
  if (result.error !== undefined) throw new Error(result.error.message);
  return result.project;
};

const startCaptionRun = (project: CaptionProject): CaptionProject => {
  const result = applyCommand(project, {
    type: "StartGenerationRun",
    actor: cueBenchAi,
    runId: "run-caption-1",
    targetTrack: "Captions",
    expectedProjectRevision: project.projectRevision,
  });
  if (result.error !== undefined) throw new Error(result.error.message);
  return result.project;
};

const captionReceiptFor = (project: CaptionProject, runId = "run-caption-1") => ({
  version: 1 as const,
  runId,
  projectId: project.projectId,
  signedGenerationReceipt: "opaque-generation-receipt",
  session: "anonymous-session",
  expectedProjectRevision: project.projectRevision,
  expectedQualityProfileRevision: project.qualityProfile.revision,
  mediaSha256: project.media.sha256,
  sourceByteLength: 5,
  sourceDurationMs: project.media.durationMs,
  projectOwnerCapability: "1".repeat(64),
  savedAtMs: Date.now(),
  retentionExpiresAtMs: Date.now() + 60_000,
});

const releaseRun = (project: CaptionProject): CaptionProject => {
  const result = applyCommand(project, {
    type: "ReleaseGenerationRun",
    actor: cueBenchAi,
    runId: "run-caption-1",
    expectedProjectRevision: project.projectRevision,
  });
  if (result.error !== undefined) throw new Error(result.error.message);
  return result.project;
};

const selectedInput = (project: CaptionProject) => {
  const selected = project.selectedItem;
  if (selected === null) throw new Error("Fixture needs a selected item.");
  return {
    contractVersion: 1,
    expectedProjectRevision: project.projectRevision,
    expectedSelectionId: selected.itemId,
    expectedSelectionRevision: selected.itemRevision,
    ...(selected.kind === "AudioDescriptionGap"
      ? { expectedGapRevision: selected.itemRevision }
      : { expectedItemRevision: selected.itemRevision }),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebMcpBridge", () => {
  it("waits for the exact replacement selection family to register before reporting a visible mutation", async () => {
    const modelContext = new ControllableModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true));
    const before = store!.current();
    modelContext.holdRegistrations = true;
    let settled = false;
    const pending = modelContext.invoke("adjust_selected_cue_timing", {
      ...selectedInput(before),
      edge: "end",
      deltaMs: 100,
    }).then((result) => {
      settled = true;
      return result;
    });

    await waitFor(() => expect(modelContext.pendingRegistrations.length).toBeGreaterThan(0));
    expect(settled).toBe(false);
    modelContext.resolvePendingRegistrations();

    await expect(pending).resolves.toMatchObject({ ok: true, data: { cue: { itemRevision: 2 } } });
    expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true);
  });

  it("returns a structured changed result if the required dynamic registration rejects", async () => {
    const modelContext = new ControllableModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true));
    const before = store!.current();
    modelContext.holdRegistrations = true;
    const pending = modelContext.invoke("adjust_selected_cue_timing", {
      ...selectedInput(before),
      edge: "end",
      deltaMs: 100,
    });
    await waitFor(() => expect(modelContext.pendingRegistrations.length).toBeGreaterThan(0));
    modelContext.rejectPendingRegistrations();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "STALE_PROJECT",
      changed: true,
      retryable: true,
      nextActions: ["inspect_project"],
    });
    expect(store!.current().captions.items["cue-1"]?.current.itemRevision).toBe(2);
  });

  it("fails closed with a structured result when exact registration settlement times out", async () => {
    const modelContext = new ControllableModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      registrationTimeoutMs={20}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true));
    const before = store!.current();
    modelContext.holdRegistrations = true;
    const result = await modelContext.invoke("adjust_selected_cue_timing", {
      ...selectedInput(before),
      edge: "end",
      deltaMs: 100,
    });

    expect(result).toMatchObject({ ok: false, code: "STALE_PROJECT", changed: true, retryable: true });
    expect(modelContext.pendingRegistrations.length).toBeGreaterThan(0);
  });

  it("registers the selected caption family and atomically replaces idle starters for an active run", async () => {
    const modelContext = new FakeModelContext();
    const selected = selectItem(baseProject({ cueState: "Objected" }), "cue-1");
    let store: MutableBridgeStore | null = null;
    const view = render(<BridgeHarness initial={selected} modelContext={modelContext} onStore={(next) => { store = next; }} />);

    await waitFor(() => expect(modelContext.tools.has("inspect_project")).toBe(true));
    expect(modelContext.tools.has("start_caption_generation")).toBe(true);
    expect(modelContext.tools.has("start_ad_generation")).toBe(true);
    expect(modelContext.tools.has("inspect_selected_cue_evidence")).toBe(true);
    expect(modelContext.tools.has("sustain_selected_cue")).toBe(false);

    await waitFor(() => expect(store).not.toBeNull());
    const active = startCaptionRun(store!.current());
    act(() => store!.replaceProject(active));
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));
    expect(modelContext.tools.has("cancel_generation_run")).toBe(true);
    expect(modelContext.tools.has("start_caption_generation")).toBe(false);
    expect(modelContext.tools.has("start_ad_generation")).toBe(false);

    act(() => store!.replaceProject(releaseRun(store!.current())));
    await waitFor(() => expect(modelContext.tools.has("start_caption_generation")).toBe(true));
    expect(modelContext.tools.has("start_ad_generation")).toBe(true);
    expect(modelContext.tools.has("inspect_generation_run")).toBe(false);
    expect(modelContext.tools.has("cancel_generation_run")).toBe(false);
    const restored = store!.current();
    await expect(modelContext.invoke("start_caption_generation", {
      contractVersion: 1,
      expectedProjectRevision: restored.projectRevision,
    })).resolves.toMatchObject({ ok: false, code: "INVALID_ARGUMENT", changed: false });
    expect(store!.current()).toBe(restored);
    view.unmount();
  });

  it("waits for the compensated idle registry restoration before reporting a known caption-start failure", async () => {
    const modelContext = new ControllableModelContext();
    const initial = baseProject();
    const owner = "1".repeat(64);
    localStorage.setItem(`cuebench-cloud-upload:${initial.projectId}`, JSON.stringify({
      version: 1,
      operationId: "upload-operation",
      sourceByteLength: 5,
      sourceSha256: initial.media.sha256,
      durationMs: initial.media.durationMs,
      projectOwnerCapability: owner,
      session: "anonymous-session",
      operationReceipt: "opaque-upload-receipt",
    }));
    let resolveStart: ((response: Response) => void) | null = null;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>((resolve) => { resolveStart = resolve; }));
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={initial}
      modelContext={modelContext}
      storeOptions={{ mode: "durable", projectOwnerCapability: owner }}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("start_caption_generation")).toBe(true));
    modelContext.holdRegistrations = true;
    let settled = false;
    const pending = modelContext.invoke("start_caption_generation", {
      contractVersion: 1,
      expectedProjectRevision: initial.projectRevision,
    }).then((result) => {
      settled = true;
      return result;
    });
    await waitFor(() => expect(store!.current().activeGenerationRun).not.toBeNull());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(modelContext.pendingRegistrations.length).toBeGreaterThan(0));
    // First settle the active-run family so release must perform a distinct
    // restoration rather than being batched away as an invisible no-op.
    modelContext.holdRegistrations = false;
    modelContext.resolvePendingRegistrations();
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));

    modelContext.holdRegistrations = true;
    act(() => resolveStart?.(Response.json({
      error: { code: "BAD_GENERATION_REQUEST", message: "Known start precondition failure." },
    }, { status: 400 })));
    await waitFor(() => expect(modelContext.pendingRegistrations.length).toBeGreaterThan(0));
    expect(settled).toBe(false);
    modelContext.holdRegistrations = false;
    modelContext.resolvePendingRegistrations();

    await expect(pending).resolves.toMatchObject({ ok: false, code: "INVALID_ARGUMENT", changed: true });
    expect(store!.current().activeGenerationRun).toBeNull();
    await waitFor(() => expect(modelContext.tools.has("start_caption_generation")).toBe(true));
    expect(modelContext.tools.has("inspect_generation_run")).toBe(false);
    localStorage.removeItem(`cuebench-cloud-upload:${initial.projectId}`);
  });

  it("inspects a visible active run without adopting it and rejects unavailable start or cancel prerequisites structurally", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={startCaptionRun(baseProject())}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));
    const active = store!.current();
    await expect(modelContext.invoke("inspect_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
    })).resolves.toMatchObject({
      ok: true,
      data: { run: { runId: "run-caption-1", targetTrack: "Captions", receiptState: "missing" } },
    });
    await expect(modelContext.invoke("cancel_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
      expectedRunId: "run-caption-1",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_ARGUMENT", changed: false });
    expect(store!.current()).toBe(active);
  });

  it("inspects an expired generation receipt without settling, releasing, polling, or changing the registered run family", async () => {
    const modelContext = new FakeModelContext();
    const active = startCaptionRun(baseProject());
    const current = active;
    const executeCommand = vi.fn(async (command: DomainCommand) => applyCommand(current, command));
    const persistCaptionGenerationReceipt = vi.fn();
    const store = withGenerationFacade({
      getSnapshot: () => ({ project: current, mode: "durable" as const }),
      executeCommand,
      persistCaptionGenerationReceipt,
      loadCaptionGenerationReceipt: async () => ({
        version: 1,
        runId: "run-caption-1",
        projectId: current.projectId,
        signedGenerationReceipt: "opaque-generation-receipt",
        session: "anonymous-session",
        expectedProjectRevision: current.projectRevision,
        expectedQualityProfileRevision: current.qualityProfile.revision,
        mediaSha256: current.media.sha256,
        sourceByteLength: 5,
        sourceDurationMs: current.media.durationMs,
        projectOwnerCapability: "1".repeat(64),
        savedAtMs: 0,
        retentionExpiresAtMs: 1,
      }),
      loadAudioDescriptionGenerationReceipt: async () => null,
      getCloudProjectOwnerCapability: async () => null,
      prepareFreshTrackExport: vi.fn(),
    }) as unknown as ProjectStore;
    render(<WebMcpBridge project={active} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));
    const namesBefore = [...modelContext.tools.keys()].sort();

    await expect(modelContext.invoke("inspect_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
    })).resolves.toMatchObject({
      ok: true,
      data: { run: { runId: "run-caption-1", receiptState: "expired", stage: "LifecyclePending" } },
    });
    expect(current).toBe(active);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(persistCaptionGenerationReceipt).not.toHaveBeenCalled();
    expect([...modelContext.tools.keys()].sort()).toEqual(namesBefore);
  });

  it("returns bounded, sanitized nonempty generation warnings from a current hosted status", async () => {
    const modelContext = new FakeModelContext();
    const active = startCaptionRun(baseProject());
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: {
        contractVersion: 1,
        runId: "run-caption-1",
        projectId: active.projectId,
        targetTrack: "Captions",
        expectedProjectRevision: active.projectRevision,
        stage: "Queued",
        warnings: ["  Retained receipt is ready.\u0000  ", "Retained receipt is ready."],
      },
    }));
    const store = withGenerationFacade({
      getSnapshot: () => ({ project: active, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: async () => ({
        version: 1,
        runId: "run-caption-1",
        projectId: active.projectId,
        signedGenerationReceipt: "opaque-generation-receipt",
        session: "anonymous-session",
        expectedProjectRevision: active.projectRevision,
        expectedQualityProfileRevision: active.qualityProfile.revision,
        mediaSha256: active.media.sha256,
        sourceByteLength: 5,
        sourceDurationMs: active.media.durationMs,
        projectOwnerCapability: "1".repeat(64),
        savedAtMs: Date.now(),
        retentionExpiresAtMs: Date.now() + 60_000,
      }),
      loadAudioDescriptionGenerationReceipt: async () => null,
      getCloudProjectOwnerCapability: async () => null,
      prepareFreshTrackExport: vi.fn(),
    }) as unknown as ProjectStore;
    render(<WebMcpBridge project={active} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));

    await expect(modelContext.invoke("inspect_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
    })).resolves.toMatchObject({
      ok: true,
      data: { run: { receiptState: "available", warnings: ["Retained receipt is ready."] } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a sanitized retryable inspection result for a known hosted status failure", async () => {
    const modelContext = new FakeModelContext();
    const active = startCaptionRun(baseProject());
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: "GENERATION_STAGE_FAILED", message: "private provider detail must not cross this tool boundary" },
    }, { status: 503 }));
    const store = withGenerationFacade({
      getSnapshot: () => ({ project: active, mode: "durable" as const }),
      executeCommand: vi.fn(),
      persistCaptionGenerationReceipt: vi.fn(),
      loadCaptionGenerationReceipt: async () => ({
        version: 1,
        runId: "run-caption-1",
        projectId: active.projectId,
        signedGenerationReceipt: "opaque-generation-receipt",
        session: "anonymous-session",
        expectedProjectRevision: active.projectRevision,
        expectedQualityProfileRevision: active.qualityProfile.revision,
        mediaSha256: active.media.sha256,
        sourceByteLength: 5,
        sourceDurationMs: active.media.durationMs,
        projectOwnerCapability: "1".repeat(64),
        savedAtMs: Date.now(),
        retentionExpiresAtMs: Date.now() + 60_000,
      }),
      loadAudioDescriptionGenerationReceipt: async () => null,
      getCloudProjectOwnerCapability: async () => null,
      prepareFreshTrackExport: vi.fn(),
    }) as unknown as ProjectStore;
    render(<WebMcpBridge project={active} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));

    await expect(modelContext.invoke("inspect_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
    })).resolves.toMatchObject({
      ok: false,
      code: "GENERATION_STAGE_FAILED",
      retryable: true,
      changed: false,
      nextActions: ["inspect_generation_run", "inspect_project"],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns STALE_RUN rather than publishing a status after the visible project/run changes mid-request", async () => {
    const modelContext = new FakeModelContext();
    const active = startCaptionRun(baseProject());
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={active}
      modelContext={modelContext}
      storeOptions={{ mode: "durable", captionReceipt: captionReceiptFor(active) }}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("inspect_generation_run")).toBe(true));
    const pending = modelContext.invoke("inspect_generation_run", {
      contractVersion: 1,
      expectedProjectRevision: active.projectRevision,
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => store!.replaceProject({ ...store!.current(), projectId: "replacement-project" }));
    act(() => resolveFetch?.(Response.json({ status: {
      contractVersion: 1,
      runId: "run-caption-1",
      projectId: active.projectId,
      targetTrack: "Captions",
      expectedProjectRevision: active.projectRevision,
      stage: "Queued",
    } })));

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "STALE_RUN",
      retryable: true,
      changed: false,
      nextActions: ["inspect_generation_run", "inspect_project"],
    });
  });

  it("runs always and caption tools through the persisted command boundary and reveals the resulting cue", async () => {
    const modelContext = new FakeModelContext();
    const reveal = vi.fn();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      onRevealSelection={reveal}
      onReadNativePlayheadMs={() => 1_111}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("inspect_selected_cue_evidence")).toBe(true));
    const before = store!.current();

    await expect(modelContext.invoke("inspect_project", { contractVersion: 1 })).resolves.toMatchObject({
      ok: true,
      projectRevision: before.projectRevision,
    });
    await expect(modelContext.invoke("inspect_timeline_window", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
      startMs: 0,
      endMs: 10_000,
      limit: 8,
    })).resolves.toMatchObject({ ok: true, data: { window: { startMs: 0, endMs: 10_000 } } });
    await expect(modelContext.invoke("inspect_selected_cue_evidence", selectedInput(before))).resolves.toMatchObject({ ok: true, data: { cue: { itemId: "cue-1" } } });

    const adjusted = await modelContext.invoke("adjust_selected_cue_timing", {
      ...selectedInput(before),
      edge: "start",
      deltaMs: 120,
    });
    expect(adjusted).toMatchObject({ ok: true, data: { cue: { startMs: 1_120, itemRevision: 2 } } });
    await waitFor(() => expect(store!.current().captions.items["cue-1"]?.current.startMs).toBe(1_120));
    expect(store!.current().captions.items["cue-1"]?.current.state).toBe("Proposed");
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({
      kind: "CaptionCue",
      selectionId: "cue-1",
      selectionRevision: 2,
      playheadMs: 1_120,
    }));
  });

  it("focuses a current finding, seeks through the UI port, and settles the caption evidence family before returning", async () => {
    const modelContext = new FakeModelContext();
    const reveal = vi.fn();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={baseProject({ cueState: "Objected" })}
      modelContext={modelContext}
      onRevealSelection={reveal}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    expect(modelContext.tools.has("inspect_selected_cue_evidence")).toBe(false);
    const beforeValidation = store!.current();
    await expect(modelContext.invoke("validate_project", {
      contractVersion: 1,
      expectedProjectRevision: beforeValidation.projectRevision,
    })).resolves.toMatchObject({ ok: true });
    await waitFor(() => expect(store!.current().validation.status).toBe("Current"));
    const validated = store!.current();
    const findings = await modelContext.invoke("list_quality_findings", {
      contractVersion: 1,
      expectedProjectRevision: validated.projectRevision,
      limit: 24,
    }) as { readonly ok: boolean; readonly data: { readonly findings: readonly { readonly findingId: string; readonly targetItemIds: readonly string[] }[] } };
    expect(findings.ok).toBe(true);
    const finding = findings.data.findings.find((candidate) => candidate.targetItemIds.includes("cue-1"));
    expect(finding).toBeDefined();

    const focused = await modelContext.invoke("focus_quality_finding", {
      contractVersion: 1,
      expectedProjectRevision: validated.projectRevision,
      findingId: finding!.findingId,
    });
    expect(focused).toMatchObject({ ok: true, data: { selection: { kind: "CaptionCue", selectionId: "cue-1" } } });
    expect(modelContext.tools.has("inspect_selected_cue_evidence")).toBe(true);
    const selected = store!.current();
    expect(selected.selectedItem).toMatchObject({ kind: "CaptionCue", itemId: "cue-1" });
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ selectionId: "cue-1", playheadMs: 1_000 }));
    await expect(modelContext.invoke("inspect_selected_cue_evidence", selectedInput(selected))).resolves.toMatchObject({ ok: true });
  });

  it("validates without navigating or opening the dirty-review draft guard", async () => {
    const modelContext = new FakeModelContext();
    const reveal = vi.fn();
    const prepare = vi.fn(async () => false);
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      onPrepareSelectionFocus={prepare}
      onRevealSelection={reveal}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("validate_project")).toBe(true));
    const before = store!.current();

    await expect(modelContext.invoke("validate_project", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
    })).resolves.toMatchObject({ ok: true });

    expect(prepare).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(store!.current().validation.status).toBe("Current");
  });

  it("keeps the old selection and scoped family while the page-owned Browser Agent draft guard is pending", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    let allowFocus: ((accepted: boolean) => void) | null = null;
    const gate = new Promise<boolean>((resolve) => { allowFocus = resolve; });
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected", withSecondCue: true }), "cue-1")}
      modelContext={modelContext}
      onPrepareSelectionFocus={() => gate}
      onRevealSelection={() => true}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true));
    const beforeValidation = store!.current();
    await expect(modelContext.invoke("validate_project", {
      contractVersion: 1,
      expectedProjectRevision: beforeValidation.projectRevision,
    })).resolves.toMatchObject({ ok: true });
    const validated = store!.current();
    const listed = await modelContext.invoke("list_quality_findings", {
      contractVersion: 1,
      expectedProjectRevision: validated.projectRevision,
      limit: 24,
    }) as { readonly ok: boolean; readonly data: { readonly findings: readonly { readonly findingId: string; readonly targetItemIds: readonly string[] }[] } };
    const cueTwoFinding = listed.data.findings.find((finding) => finding.targetItemIds.includes("cue-2"));
    expect(cueTwoFinding).toBeDefined();

    const pending = modelContext.invoke("focus_quality_finding", {
      contractVersion: 1,
      expectedProjectRevision: validated.projectRevision,
      findingId: cueTwoFinding!.findingId,
    });
    await Promise.resolve();
    expect(store!.current().selectedItem).toMatchObject({ itemId: "cue-1" });
    expect(modelContext.tools.has("adjust_selected_cue_timing")).toBe(true);
    expect(modelContext.tools.has("inspect_selected_cue_evidence")).toBe(true);

    act(() => allowFocus?.(true));
    await expect(pending).resolves.toMatchObject({ ok: true, data: { selection: { selectionId: "cue-2" } } });
    expect(store!.current().selectedItem).toMatchObject({ itemId: "cue-2" });
  });

  it("runs selected audio-description evidence and timing through the same persisted bridge boundary", async () => {
    const modelContext = new FakeModelContext();
    const reveal = vi.fn();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ withAd: true }), "ad-1")}
      modelContext={modelContext}
      onRevealSelection={reveal}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("inspect_selected_ad_evidence")).toBe(true));
    const before = store!.current();
    await expect(modelContext.invoke("inspect_selected_ad_evidence", selectedInput(before))).resolves.toMatchObject({
      ok: true,
      data: { beat: { itemId: "ad-1" } },
    });

    const adjusted = await modelContext.invoke("adjust_selected_ad_timing", {
      ...selectedInput(before),
      edge: "end",
      deltaMs: 200,
    });
    expect(adjusted).toMatchObject({ ok: true, data: { beat: { endMs: 6_200, itemRevision: 2 } } });
    await waitFor(() => expect(store!.current().audioDescriptions.items["ad-1"]?.current.endMs).toBe(6_200));
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({
      kind: "AudioDescriptionBeat",
      selectionId: "ad-1",
      playheadMs: 4_000,
    }));
  });

  it("does not publish or cache stale narration after its selected beat is replaced mid-synthesis", async () => {
    const modelContext = new FakeModelContext();
    let resolveSynthesis: ((value: NarrationPreviewSynthesis) => void) | null = null;
    const gateway: NarrationPreviewGateway = {
      loadCached: vi.fn(async () => undefined),
      saveCached: vi.fn(async () => undefined),
      synthesize: vi.fn(async (): Promise<NarrationPreviewSynthesis> => new Promise<NarrationPreviewSynthesis>((resolve) => { resolveSynthesis = resolve; })),
      measureDurationMs: vi.fn(async () => 900),
      createObjectUrl: vi.fn(() => "blob:narration"),
      revokeObjectUrl: vi.fn(),
    };
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ withAd: true }), "ad-1")}
      modelContext={modelContext}
      narrationPreviewGateway={gateway}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("preview_selected_narration")).toBe(true));
    const before = store!.current();
    const pending = modelContext.invoke("preview_selected_narration", selectedInput(before));
    await waitFor(() => expect(gateway.synthesize).toHaveBeenCalledTimes(1));
    act(() => store!.replaceProject(selectItem(store!.current(), "cue-1")));
    act(() => resolveSynthesis?.({
      blob: new Blob(["narration"], { type: "audio/wav" }),
      contentType: "audio/wav",
      model: "fixture",
      voice: "fixture",
      responseFormat: "wav",
      store: null,
      warnings: [],
    }));

    await expect(pending).resolves.toMatchObject({ ok: false, code: "STALE_SELECTION", changed: true });
    expect(gateway.saveCached).not.toHaveBeenCalled();
    expect(gateway.createObjectUrl).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Browser Agent narration preview/i)).not.toBeInTheDocument();
  });

  it("does not resolve a same-revision narration preview until its native audio element is visible", async () => {
    const modelContext = new FakeModelContext();
    const gateway: NarrationPreviewGateway = {
      loadCached: vi.fn(async () => ({ blob: new Blob(["cached narration"], { type: "audio/wav" }), contentType: "audio/wav", measuredDurationMs: 875 })),
      saveCached: vi.fn(),
      synthesize: vi.fn(),
      measureDurationMs: vi.fn(),
      createObjectUrl: vi.fn(() => "blob:cached-narration"),
      revokeObjectUrl: vi.fn(),
    };
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ withAd: true }), "ad-1")}
      modelContext={modelContext}
      narrationPreviewGateway={gateway}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("preview_selected_narration")).toBe(true));
    const result = await modelContext.invoke("preview_selected_narration", selectedInput(store!.current()));
    expect(result).toMatchObject({ ok: true, data: { preview: { source: "cache", measuredDurationMs: 875 } } });
    expect(screen.getByLabelText("Narration preview for ad-1")).toBeInTheDocument();
  });

  it("turns a selected gap into a persisted Proposed AD beat and swaps the scoped family", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={focusGap(baseProject({ withGap: true }))}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("inspect_selected_gap_evidence")).toBe(true));
    const before = store!.current();
    await expect(modelContext.invoke("inspect_selected_gap_evidence", selectedInput(before))).resolves.toMatchObject({
      ok: true,
      data: { gap: { gapId: "gap-1", state: "Available" } },
    });
    const proposed = await modelContext.invoke("propose_ad_beat_in_gap", {
      ...selectedInput(before),
      startMs: 10_500,
      endMs: 12_000,
      description: "A watershed map fills the screen.",
    });
    expect(proposed).toMatchObject({
      ok: true,
      data: { beat: { kind: "AudioDescriptionBeat", state: "Proposed", startMs: 10_500, endMs: 12_000 }, consumedGapId: "gap-1" },
    });
    await waitFor(() => expect(store!.current().audioDescriptionGaps["gap-1"]?.state).toBe("Consumed"));
    expect(store!.current().selectedItem).toMatchObject({ kind: "AudioDescriptionBeat" });
    expect(modelContext.tools.has("inspect_selected_ad_evidence")).toBe(true);
    expect(modelContext.tools.has("inspect_selected_gap_evidence")).toBe(false);
  });

  it("requires and records an in-page Human confirmation before replacing a Proposed cue", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Proposed" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("revise_selected_cue")).toBe(true));
    const before = store!.current();
    const pending = modelContext.invoke("revise_selected_cue", {
      ...selectedInput(before),
      text: "Dr. Nguyen explains Gibbs free energy.",
    });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Browser Agent change" }));
    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { cue: { itemId: "cue-1", itemRevision: 2, state: "Proposed" } },
    });
    await waitFor(() => expect(store!.current().captions.items["cue-1"]?.current.text).toBe("Dr. Nguyen explains Gibbs free energy."));
    expect(store!.current().courtRecord.at(-1)).toMatchObject({ actor: browserAgent });
  });

  it("settles an aborted in-page confirmation as an unchanged, inspectable rejection", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Proposed" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    const before = store!.current();
    const controller = new AbortController();
    const pending = modelContext.invoke("revise_selected_cue", {
      ...selectedInput(before),
      text: "This must not replace the proposal.",
    }, controller.signal);
    await screen.findByRole("dialog");
    act(() => controller.abort());
    await expect(pending).resolves.toMatchObject({ ok: false, code: "CONFIRMATION_DECLINED", changed: false });
    expect(store!.current()).toBe(before);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("aborts an old selection owner before a same-revision replacement can apply its confirmed command", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Proposed" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(modelContext.tools.has("revise_selected_cue")).toBe(true));
    const before = store!.current();
    const oldSelectionRegistration = [...modelContext.registrations].reverse().find((registration) => registration.tool.name === "revise_selected_cue");
    expect(oldSelectionRegistration).toBeDefined();

    const pending = modelContext.invoke("revise_selected_cue", {
      ...selectedInput(before),
      text: "This revision belongs only to project A.",
    });
    await screen.findByRole("dialog");
    // Accepting queues the continuation in a microtask. Replace the visible
    // project before that continuation may issue its BrowserAgent command.
    fireEvent.click(screen.getByRole("button", { name: "Confirm Browser Agent change" }));
    act(() => store!.replaceProject({ ...before, projectId: "replacement-project" }));

    await expect(pending).resolves.toMatchObject({ ok: false, changed: false, retryable: true });
    expect(oldSelectionRegistration?.signal?.aborted).toBe(true);
    expect(store!.current()).toMatchObject({
      projectId: "replacement-project",
      projectRevision: before.projectRevision,
      selectedItem: before.selectedItem,
    });
    expect(store!.current().captions.items["cue-1"]?.current).toMatchObject({
      itemRevision: before.captions.items["cue-1"]?.current.itemRevision,
      text: before.captions.items["cue-1"]?.current.text,
    });
  });

  it("never lets a pending tool command cross an imported same-id same-revision project-instance boundary", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Proposed" }), "cue-1")}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(modelContext.tools.has("revise_selected_cue")).toBe(true));
    const before = store!.current();
    const beforeEpoch = store!.projectInstanceEpoch();
    const pending = modelContext.invoke("revise_selected_cue", {
      ...selectedInput(before),
      text: "This must never be written into imported project B.",
    });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Browser Agent change" }));
    // A portable import can intentionally retain the project id, revision,
    // selected cue id, and item revision while rotating the nonportable
    // project-instance capability. Hold React's next render so this probes
    // the store/closure fence itself, not merely DOM deregistration timing.
    act(() => store!.replaceProjectSilently({ ...before }));
    expect(store!.projectInstanceEpoch()).toBeGreaterThan(beforeEpoch);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "STALE_PROJECT", changed: false, retryable: true });
    expect(store!.current().captions.items["cue-1"]?.current.text).toBe(before.captions.items["cue-1"]?.current.text);
  });

  it("keeps profile and certification preparation unapplied, then records and exposes a verified draft export", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    let proposal: Parameters<NonNullable<WebMcpBridgeProps["onProfileProposal"]>>[0] | null = null;
    render(<BridgeHarness
      initial={selectItem(baseProject({ cueState: "Objected" }), "cue-1")}
      modelContext={modelContext}
      onProfileProposal={(next) => { proposal = next; }}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    const before = store!.current();
    const profile = await modelContext.invoke("propose_profile_patch", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
      profileId: before.qualityProfile.profileId,
      name: "A proposed tighter caption profile",
      rationale: "Keep line count appropriate for a short technical lecture.",
      patch: { caption: { maxLines: 1 } },
    });
    expect(profile).toMatchObject({ ok: true, data: { proposal: { reviewRequired: true } } });
    expect(proposal).toMatchObject({ baseProfileRevision: before.qualityProfile.revision, changedPaths: ["rules.caption.maxLines"] });
    expect(store!.current()).toBe(before);

    await expect(modelContext.invoke("prepare_certification_review", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
    })).resolves.toMatchObject({ ok: true, projectRevision: before.projectRevision, data: { readiness: expect.any(Object) } });
    expect(store!.current()).toBe(before);

    const exported = await modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });
    expect(exported).toMatchObject({ ok: true, data: { export: { published: true, trackKind: "Captions", format: "vtt", disposition: "draft" } } });
    await waitFor(() => expect(store!.current().exportHistory).toHaveLength(1));
    expect(store!.current().courtRecord.at(-1)).toMatchObject({ actor: { type: "System", id: "cuebench-export" } });
    // The tool resolves only after the exact export anchor is committed, not
    // merely after its RecordExportRoundTrip project revision settles.
    const download = screen.getByRole("link", { name: /Download .*\.vtt/i });
    expect(download).toHaveAttribute("download", expect.stringMatching(/\.draft\.vtt$/u));
  });

  it("keeps a fresh bridge publication owner alive through StrictMode rehearsal, then cleans it up on the real unmount", async () => {
    const modelContext = new FakeModelContext();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:strict-export");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let store: MutableBridgeStore | null = null;
    const view = render(<StrictMode><BridgeHarness
      initial={baseProject()}
      modelContext={modelContext}
      onStore={(next) => { store = next; }}
    /></StrictMode>);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));

    await expect(modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: store!.current().projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    })).resolves.toMatchObject({ ok: true, data: { export: { published: true } } });
    expect(screen.getByRole("link", { name: /Download .*\.vtt/i })).toHaveAttribute("href", "blob:strict-export");

    view.unmount();
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith("blob:strict-export"));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight profile proposal publication without leaving a Browser Agent invocation hanging", async () => {
    const modelContext = new FakeModelContext();
    let store: MutableBridgeStore | null = null;
    const publicationStarted = vi.fn();
    render(<BridgeHarness
      initial={baseProject()}
      modelContext={modelContext}
      onProfileProposal={(_proposal, signal) => new Promise<void>((_resolve, reject) => {
        publicationStarted();
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })}
      onStore={(next) => { store = next; }}
    />);
    await waitFor(() => expect(store).not.toBeNull());
    const controller = new AbortController();
    const pending = modelContext.invoke("propose_profile_patch", {
      contractVersion: 1,
      expectedProjectRevision: store!.current().projectRevision,
      profileId: store!.current().qualityProfile.profileId,
      name: "Cancelled proposal",
      rationale: "This publication should never reach a Human dialog.",
      patch: { caption: { maxLines: 1 } },
    }, controller.signal);
    await waitFor(() => expect(publicationStarted).toHaveBeenCalledTimes(1));

    act(() => controller.abort());
    await expect(pending).resolves.toMatchObject({ ok: false, code: "STALE_SELECTION", changed: false });
    expect(store!.current().projectRevision).toBe(1);
    expect(screen.queryByRole("dialog", { name: "Quality profile proposal" })).not.toBeInTheDocument();
  });

  it("does not write export history when the browser cannot create a download Blob URL", async () => {
    const modelContext = new FakeModelContext();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => { throw new Error("Blob URL unavailable"); });
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness initial={baseProject()} modelContext={modelContext} onStore={(next) => { store = next; }} />);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));
    const before = store!.current();

    await expect(modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: before.projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    })).resolves.toMatchObject({ ok: false, code: "EXPORT_ROUND_TRIP_MISMATCH", changed: false });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(store!.current().exportHistory).toHaveLength(0);
  });

  it("clears and revokes a Browser Agent download when the visible project is edited or replaced", async () => {
    const modelContext = new FakeModelContext();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:export-a")
      .mockReturnValueOnce("blob:export-b");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let store: MutableBridgeStore | null = null;
    render(<BridgeHarness initial={baseProject()} modelContext={modelContext} onStore={(next) => { store = next; }} />);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));
    const exportCurrent = async () => modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: store!.current().projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });

    await expect(exportCurrent()).resolves.toMatchObject({ ok: true });
    expect(await screen.findByRole("link", { name: /Download .*\.vtt/i })).toHaveAttribute("href", "blob:export-a");
    act(() => store!.replaceProject({ ...store!.current(), projectRevision: store!.current().projectRevision + 1 }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Download .*\.vtt/i })).not.toBeInTheDocument());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:export-a");

    await expect(exportCurrent()).resolves.toMatchObject({ ok: true });
    expect(await screen.findByRole("link", { name: /Download .*\.vtt/i })).toHaveAttribute("href", "blob:export-b");
    act(() => store!.replaceProject({ ...store!.current(), projectId: "replacement-project" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Download .*\.vtt/i })).not.toBeInTheDocument());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:export-b");
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("revokes a prepared Blob URL when recording the export fails", async () => {
    const modelContext = new FakeModelContext();
    const project = baseProject();
    const href = "blob:export-failed";
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(href);
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const executeCommand = vi.fn(async () => { throw new Error("recording failed"); });
    const store = {
      getSnapshot: () => ({ project, mode: "temporary" as const }),
      executeCommand,
      prepareFreshTrackExport: async (request: ProjectTrackExportRequest) => ({
        project,
        prepared: prepareTrackExport({ ...request, project }),
        freshnessNotice: null,
      }),
      getCloudProjectOwnerCapability: async () => null,
      loadCaptionGenerationReceipt: async () => null,
      loadAudioDescriptionGenerationReceipt: async () => null,
    } as unknown as ProjectStore;
    render(<WebMcpBridge project={project} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));

    await expect(modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: project.projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    })).resolves.toMatchObject({ ok: false, code: "EXPORT_ROUND_TRIP_MISMATCH", changed: false });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith(href);
  });

  it("settles and revokes an export when the bridge unmounts while its durable record is pending", async () => {
    const modelContext = new FakeModelContext();
    const project = baseProject();
    const href = "blob:export-after-unmount";
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(href);
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let resolveRecord: ((result: ReturnType<typeof applyCommand>) => void) | null = null;
    let recordedCommand: DomainCommand | null = null;
    const executeCommand = vi.fn((command: DomainCommand) => new Promise<ReturnType<typeof applyCommand>>((resolve) => {
      recordedCommand = command;
      resolveRecord = (result) => resolve(result);
    }));
    const store = {
      getSnapshot: () => ({ project, mode: "temporary" as const }),
      executeCommand,
      prepareFreshTrackExport: async (request: ProjectTrackExportRequest) => ({
        project,
        prepared: prepareTrackExport({ ...request, project }),
        freshnessNotice: null,
      }),
      getCloudProjectOwnerCapability: async () => null,
      loadCaptionGenerationReceipt: async () => null,
      loadAudioDescriptionGenerationReceipt: async () => null,
    } as unknown as ProjectStore;
    const { container, unmount } = render(<WebMcpBridge project={project} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));
    const pending = modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: project.projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    });
    await waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1));

    unmount();
    act(() => resolveRecord?.(applyCommand(project, recordedCommand!)));

    await expect(pending).resolves.toMatchObject({ ok: false, code: "STALE_PROJECT", changed: true, retryable: true });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith(href);
    expect(container).toBeEmptyDOMElement();
  });

  it("honors an execution abort after export preflight and before Blob/history publication", async () => {
    const modelContext = new FakeModelContext();
    const project = baseProject();
    let releaseFresh: () => void = () => { throw new Error("Export preflight was not reached."); };
    const executeCommand = vi.fn();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:should-not-exist");
    const store = {
      getSnapshot: () => ({ project, mode: "temporary" as const }),
      executeCommand,
      prepareFreshTrackExport: async (request: ProjectTrackExportRequest) => new Promise<{
        readonly project: CaptionProject;
        readonly prepared: ReturnType<typeof prepareTrackExport>;
        readonly freshnessNotice: null;
      }>((resolve) => {
        releaseFresh = () => resolve({ project, prepared: prepareTrackExport({ ...request, project }), freshnessNotice: null });
      }),
      getCloudProjectOwnerCapability: async () => null,
      loadCaptionGenerationReceipt: async () => null,
      loadAudioDescriptionGenerationReceipt: async () => null,
    } as unknown as ProjectStore;
    render(<WebMcpBridge project={project} store={store} modelContext={modelContext} />);
    await waitFor(() => expect(modelContext.tools.has("export_track")).toBe(true));
    const controller = new AbortController();
    const pending = modelContext.invoke("export_track", {
      contractVersion: 1,
      expectedProjectRevision: project.projectRevision,
      trackKind: "Captions",
      format: "vtt",
      disposition: "draft",
    }, controller.signal);
    await Promise.resolve();
    controller.abort();
    releaseFresh();

    await expect(pending).resolves.toMatchObject({ ok: false, changed: false, retryable: true });
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("does not need a browser API to render its Human-confirmation boundary safely", () => {
    const project = baseProject();
    const store = createMutableStore(project, () => undefined);
    const { container } = render(<WebMcpBridge project={project} store={store.asProjectStore} modelContext={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
