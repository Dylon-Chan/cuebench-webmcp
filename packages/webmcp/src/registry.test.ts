import { describe, expect, it } from "vitest";
import { domainError } from "@cuebench/domain";
import { z } from "zod";
import {
  CueBenchToolRegistry,
  DuplicateToolNameError,
  executeTool,
  featureDetectModelContext,
  MAX_TOOL_RESULT_BYTES,
  strictToolDataSchema,
  ToolExecutionAbortedError,
  toolDomainError,
  toolSuccess,
  type CueBenchTool,
  type ModelContextLike,
  type ModelContextTool,
  type ModelContextInvocationClient,
} from "./index";

class FakeModelContext implements ModelContextLike {
  public readonly events: string[] = [];
  public readonly tools = new Map<string, ModelContextTool>();
  public onToolAborted: ((toolName: string) => void) | undefined;

  public registerTool(tool: ModelContextTool, options?: { readonly signal?: AbortSignal }): void {
    this.events.push(`register:${tool.name}`);
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      this.events.push(`abort:${tool.name}`);
      this.tools.delete(tool.name);
      this.onToolAborted?.(tool.name);
    }, { once: true });
  }
}

class RejectingModelContext extends FakeModelContext {
  public failName: string | null = null;

  public override registerTool(tool: ModelContextTool, options?: { readonly signal?: AbortSignal }): void | Promise<void> {
    if (tool.name === this.failName) {
      this.events.push(`reject:${tool.name}`);
      return Promise.reject(new Error("browser registration rejected"));
    }
    return super.registerTool(tool, options);
  }
}

class DeferredRegistrationModelContext extends FakeModelContext {
  public readonly deferredNames = new Set<string>();
  public readonly rejectedNames = new Set<string>();
  public readonly pending = new Map<string, {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();

  public override registerTool(tool: ModelContextTool, options?: { readonly signal?: AbortSignal }): void | Promise<void> {
    super.registerTool(tool, options);
    if (this.rejectedNames.has(tool.name)) return Promise.reject(new Error(`browser registration rejected: ${tool.name}`));
    if (!this.deferredNames.has(tool.name)) return;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(tool.name, { resolve, reject });
    });
  }
}

const readTool = (name: string): CueBenchTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", additionalProperties: false },
  resultDataSchema: strictToolDataSchema({ name: z.string().trim().min(1).max(128) }),
  annotations: { readOnlyHint: true },
  execute: async () => toolSuccess({
    projectRevision: 1,
    data: { name },
    nextActions: ["inspect_project"],
  }),
});

const selection = (scopeId: string, toolName: string) => ({
  scopeId,
  tools: [readTool(toolName)],
});

const noSignal: ModelContextInvocationClient = {};

describe("CueBenchToolRegistry", () => {
  it("feature-detects WebMCP without mutating an unavailable host", async () => {
    const host: { modelContext?: unknown } = {};
    const registry = new CueBenchToolRegistry(featureDetectModelContext(host));

    await expect(registry.registerAlways([readTool("inspect_project")])).resolves.toBeUndefined();

    expect(host).toEqual({});
    expect(registry.available).toBe(false);
    expect(registry.snapshot().always.toolNames).toEqual(["inspect_project"]);
    expect(registry.snapshot().always.registered).toBe(false);
  });

  it("aborts the old selection family before registering the new one", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);

    await registry.select(selection("caption:c05", "inspect_selected_cue_evidence"));
    await registry.select(selection("ad:ad02", "inspect_selected_ad_evidence"));

    expect(modelContext.events).toEqual([
      "register:inspect_selected_cue_evidence",
      "abort:inspect_selected_cue_evidence",
      "register:inspect_selected_ad_evidence",
    ]);
    expect(registry.snapshot().selection.scopeId).toBe("ad:ad02");
  });

  it("keeps a reentrant newer selection when an outgoing abort listener selects it", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    let reentrantSelection: Promise<void> | undefined;
    await registry.select(selection("caption:c05", "inspect_selected_cue_evidence"));
    modelContext.onToolAborted = (toolName) => {
      if (toolName === "inspect_selected_cue_evidence") {
        reentrantSelection = registry.select(selection("caption:c07", "inspect_selected_c07_evidence"));
      }
    };

    await registry.select(selection("ad:ad02", "inspect_selected_ad_evidence"));
    await reentrantSelection;

    expect([...modelContext.tools.keys()]).toEqual(["inspect_selected_c07_evidence"]);
    expect(registry.snapshot().selection).toMatchObject({
      scopeId: "caption:c07",
      toolNames: ["inspect_selected_c07_evidence"],
      registered: true,
    });

    await registry.select(null);
    expect([...modelContext.tools.keys()]).toEqual([]);
  });

  it("starts every prevalidated family registration before awaiting any browser promise", async () => {
    const modelContext = new DeferredRegistrationModelContext();
    modelContext.deferredNames.add("inspect_timeline_window");
    modelContext.deferredNames.add("inspect_project");
    const registry = new CueBenchToolRegistry(modelContext);

    const transition = registry.registerAlways([
      readTool("inspect_timeline_window"),
      readTool("inspect_project"),
    ]);

    expect(modelContext.events).toEqual([
      "register:inspect_timeline_window",
      "register:inspect_project",
    ]);
    for (const pending of modelContext.pending.values()) pending.resolve();
    await transition;
    expect(registry.snapshot().always.registered).toBe(true);
  });

  it("aborts a partially registered family immediately when a sibling registration rejects", async () => {
    const modelContext = new DeferredRegistrationModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    await registry.registerAlways([readTool("inspect_old")]);
    modelContext.deferredNames.add("inspect_first");
    modelContext.rejectedNames.add("inspect_second");
    let observedAbort: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });
    modelContext.onToolAborted = (toolName) => {
      if (toolName === "inspect_first") observedAbort?.();
    };

    const transition = registry.registerAlways([
      readTool("inspect_first"),
      readTool("inspect_second"),
    ]);
    await abortObserved;
    expect([...modelContext.tools.keys()]).toEqual([]);

    modelContext.pending.get("inspect_first")?.resolve();
    await expect(transition).rejects.toThrow("browser registration rejected: inspect_second");
    expect([...modelContext.tools.keys()]).toEqual(["inspect_old"]);
  });

  it("does not let a deferred failed transition roll back a newer family started by its abort listener", async () => {
    const modelContext = new DeferredRegistrationModelContext();
    modelContext.deferredNames.add("inspect_a");
    const registry = new CueBenchToolRegistry(modelContext);
    let newerTransition: Promise<void> | undefined;
    modelContext.onToolAborted = (toolName) => {
      if (toolName === "inspect_a") {
        newerTransition = registry.registerAlways([readTool("inspect_b")]);
      }
    };

    const failedTransition = registry.registerAlways([readTool("inspect_a")]);
    expect(modelContext.pending.has("inspect_a")).toBe(true);
    modelContext.pending.get("inspect_a")?.reject(new Error("old registration failed"));
    await expect(failedTransition).rejects.toThrow("old registration failed");
    await newerTransition;

    expect([...modelContext.tools.keys()]).toEqual(["inspect_b"]);
    expect(registry.snapshot().always).toMatchObject({
      toolNames: ["inspect_b"],
      registered: true,
    });

    await registry.dispose();
    expect([...modelContext.tools.keys()]).toEqual([]);
  });

  it("aborts and clears a selection family on deselection", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);

    await registry.select(selection("caption:c05", "inspect_selected_cue_evidence"));
    await registry.select(null);

    expect(modelContext.events).toEqual([
      "register:inspect_selected_cue_evidence",
      "abort:inspect_selected_cue_evidence",
    ]);
    expect(registry.snapshot().selection).toEqual({
      scopeId: null,
      toolNames: [],
      registered: false,
    });
  });

  it("replaces generation starters with the active-run family and restores them afterwards", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);

    await registry.registerAlways([
      readTool("inspect_project"),
      readTool("start_caption_generation"),
      readTool("start_ad_generation"),
    ]);
    await registry.setRun([
      readTool("inspect_generation_run"),
      readTool("cancel_generation_run"),
    ]);

    expect([...modelContext.tools.keys()].sort()).toEqual([
      "cancel_generation_run",
      "inspect_generation_run",
      "inspect_project",
    ]);
    expect(modelContext.events.indexOf("abort:start_caption_generation")).toBeLessThan(
      modelContext.events.indexOf("register:inspect_generation_run"),
    );

    await registry.setRun(null);

    expect([...modelContext.tools.keys()].sort()).toEqual([
      "inspect_project",
      "start_ad_generation",
      "start_caption_generation",
    ]);
  });

  it("rejects duplicate live names without tearing down the current family", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    await registry.registerAlways([readTool("inspect_project")]);
    await registry.select(selection("caption:c05", "inspect_selected_cue_evidence"));

    await expect(registry.select(selection("ad:ad02", "inspect_project"))).rejects.toBeInstanceOf(DuplicateToolNameError);

    expect(registry.snapshot().selection.scopeId).toBe("caption:c05");
    expect([...modelContext.tools.keys()].sort()).toEqual([
      "inspect_project",
      "inspect_selected_cue_evidence",
    ]);
  });

  it("returns a structured stale-selection result when a dynamically removed tool finishes", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    let release: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const finished = new Promise<void>((resolve) => { release = resolve; });
    const delayed: CueBenchTool = {
      ...readTool("revise_selected_cue"),
      annotations: { readOnlyHint: false },
      execute: async (_input, client) => {
        observedSignal = client.signal;
        started?.();
        await finished;
        throw new Error("the agent cancelled this in-flight revision");
      },
    };

    await registry.select({ scopeId: "caption:c05", tools: [delayed] });
    const registered = modelContext.tools.get("revise_selected_cue");
    expect(registered).toBeDefined();
    const execution = registered?.execute({}, noSignal);
    await startedPromise;
    await registry.select(null);
    release?.();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      code: "STALE_SELECTION",
      changed: false,
      retryable: true,
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("preserves a successful scoped mutation that replaces its own selection family", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    const selfReplacing: CueBenchTool = {
      ...readTool("revise_selected_cue"),
      annotations: { readOnlyHint: false },
      execute: async (_input, client) => {
        client.markCommitted();
        await registry.select(selection("caption:c06", "inspect_selected_cue_evidence"));
        return toolSuccess({
          projectRevision: 2,
          data: { name: "revised-c05" },
          nextActions: ["inspect_selected_cue_evidence"],
        });
      },
    };

    await registry.select({ scopeId: "caption:c05", tools: [selfReplacing] });
    const registered = modelContext.tools.get("revise_selected_cue");

    await expect(registered?.execute({}, noSignal)).resolves.toMatchObject({
      ok: true,
      projectRevision: 2,
      data: { name: "revised-c05" },
    });
  });

  it("reports conservative changed state when a committed scoped mutation is aborted before it can finalize", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const committedThenCancelled: CueBenchTool = {
      ...readTool("adjust_selected_cue_timing"),
      annotations: { readOnlyHint: false },
      execute: async (_input, client) => {
        client.markCommitted();
        started?.();
        await releasePromise;
        throw new Error("post-commit cancellation");
      },
    };

    await registry.select({ scopeId: "caption:c05", tools: [committedThenCancelled] });
    const registered = modelContext.tools.get("adjust_selected_cue_timing");
    const execution = registered?.execute({}, noSignal);
    await startedPromise;
    await registry.select(null);
    release?.();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      code: "STALE_SELECTION",
      changed: true,
      retryable: true,
      nextActions: ["inspect_project"],
    });
  });

  it("does not invoke a stale handle after its selection family was removed", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    let calls = 0;
    const scoped: CueBenchTool = {
      ...readTool("adjust_selected_cue_timing"),
      annotations: { readOnlyHint: false },
      execute: async () => {
        calls += 1;
        return toolSuccess({ projectRevision: 2, data: {}, nextActions: [] });
      },
    };

    await registry.select({ scopeId: "caption:c05", tools: [scoped] });
    const staleHandle = modelContext.tools.get("adjust_selected_cue_timing");
    await registry.select(null);

    await expect(staleHandle?.execute({}, noSignal)).resolves.toMatchObject({
      ok: false,
      code: "STALE_SELECTION",
      changed: false,
    });
    expect(calls).toBe(0);
  });

  it("rejects malformed names, unbounded schemas, and unbranded result contracts before tearing down the live surface", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    await registry.registerAlways([readTool("inspect_project")]);
    const cyclicSchema: Record<string, unknown> = { type: "object" };
    cyclicSchema.self = cyclicSchema;
    const cyclicTool: CueBenchTool = { ...readTool("inspect_timeline_window"), inputSchema: cyclicSchema };
    const oversizedSchemaTool: CueBenchTool = {
      ...readTool("inspect_timeline_window"),
      inputSchema: { type: "object", description: "x".repeat(40 * 1024) },
    };
    const unbrandedResultSchemaTool: CueBenchTool = {
      ...readTool("inspect_timeline_window"),
      resultDataSchema: { schema: z.object({ name: z.string() }).strict() } as unknown as CueBenchTool["resultDataSchema"],
    };

    await expect(registry.registerAlways([readTool("bad tool name")])).rejects.toMatchObject({
      name: "InvalidToolDefinitionError",
    });
    await expect(registry.registerAlways([cyclicTool])).rejects.toMatchObject({
      name: "InvalidToolDefinitionError",
    });
    await expect(registry.registerAlways([oversizedSchemaTool])).rejects.toMatchObject({
      name: "InvalidToolDefinitionError",
    });
    await expect(registry.registerAlways([unbrandedResultSchemaTool])).rejects.toMatchObject({
      name: "InvalidToolDefinitionError",
    });
    expect([...modelContext.tools.keys()]).toEqual(["inspect_project"]);
  });

  it("rolls back browser registration failures to the prior live family", async () => {
    const modelContext = new RejectingModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    await registry.registerAlways([readTool("inspect_project")]);
    modelContext.failName = "inspect_timeline_window";

    await expect(registry.registerAlways([readTool("inspect_timeline_window")])).rejects.toThrow("browser registration rejected");

    expect([...modelContext.tools.keys()]).toEqual(["inspect_project"]);
    expect(registry.snapshot().always.toolNames).toEqual(["inspect_project"]);
  });

  it("requires a strict tool-specific data schema and rejects unsafe outbound results without exposing secrets", async () => {
    const modelContext = new FakeModelContext();
    const faults: unknown[] = [];
    const registry = new CueBenchToolRegistry(modelContext, { onUnexpectedError: (fault) => faults.push(fault) });
    const secret = "Dr. Nguyen transcript must not escape";
    const unsafeResult: CueBenchTool = {
      ...readTool("inspect_selected_cue_evidence"),
      resultDataSchema: strictToolDataSchema({ payload: z.object({}).strict() }),
      execute: async () => toolSuccess({
        projectRevision: 1,
        data: { payload: { secret, count: BigInt(1) } },
        nextActions: [],
      }),
    };

    await registry.select({ scopeId: "caption:c05", tools: [unsafeResult] });
    const registered = modelContext.tools.get("inspect_selected_cue_evidence");
    const rejection = await Promise.resolve(registered?.execute({}, noSignal)).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ name: "CueBenchToolExecutionError" });
    expect((rejection as Error).message).not.toContain(secret);
    expect(faults).toEqual([{
      event: "webmcp.unexpected_error",
      toolName: "inspect_selected_cue_evidence",
      errorType: "ToolResultSafetyError",
    }]);
  });

  it("rejects cyclic and oversized outbound data through the same sanitized boundary", async () => {
    const modelContext = new FakeModelContext();
    const registry = new CueBenchToolRegistry(modelContext);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicTool: CueBenchTool = {
      ...readTool("inspect_selected_cue_evidence"),
      resultDataSchema: strictToolDataSchema({ payload: z.object({}).strict() }),
      execute: async () => toolSuccess({ projectRevision: 1, data: { payload: cyclic }, nextActions: [] }),
    };

    await registry.select({ scopeId: "caption:c05", tools: [cyclicTool] });
    const cyclicHandle = modelContext.tools.get("inspect_selected_cue_evidence");
    await expect(cyclicHandle?.execute({}, noSignal)).rejects.toMatchObject({
      name: "CueBenchToolExecutionError",
    });

    const oversizedTool: CueBenchTool = {
      ...readTool("inspect_selected_ad_evidence"),
      resultDataSchema: strictToolDataSchema({ payload: z.string() }),
      execute: async () => toolSuccess({
        projectRevision: 1,
        data: { payload: "x".repeat(MAX_TOOL_RESULT_BYTES + 1) },
        nextActions: [],
      }),
    };
    await registry.select({ scopeId: "ad:ad02", tools: [oversizedTool] });
    const oversizedHandle = modelContext.tools.get("inspect_selected_ad_evidence");
    await expect(oversizedHandle?.execute({}, noSignal)).rejects.toMatchObject({
      name: "CueBenchToolExecutionError",
    });
  });
});

describe("WebMCP tool result helpers", () => {
  it("creates compact versioned success and domain-error envelopes", () => {
    const success = toolSuccess({
      projectRevision: 4,
      data: { changedItem: { itemId: "c05", itemRevision: 2 } },
      nextActions: ["inspect_project"],
      selection: { kind: "CaptionCue", selectionId: "c05", selectionRevision: 2 },
      changedItem: { kind: "CaptionCue", itemId: "c05", itemRevision: 2, state: "Proposed" },
      findingDelta: {
        addedFindingIds: ["finding-2"],
        resolvedFindingIds: ["finding-1"],
        blockerCount: 1,
        warningCount: 2,
      },
      playheadMs: 12_400,
    });

    expect(success).toMatchObject({ ok: true, contractVersion: 1, projectRevision: 4 });
    expect(success.data.verification).toEqual({
      selection: { kind: "CaptionCue", selectionId: "c05", selectionRevision: 2 },
      changedItem: { kind: "CaptionCue", itemId: "c05", itemRevision: 2, state: "Proposed" },
      findingDelta: {
        addedFindingIds: ["finding-2"],
        resolvedFindingIds: ["finding-1"],
        blockerCount: 1,
        warningCount: 2,
      },
      playheadMs: 12_400,
    });
    expect(toolDomainError(domainError("STALE_SELECTION", "The selection changed."))).toMatchObject({
      ok: false,
      contractVersion: 1,
      code: "STALE_SELECTION",
      changed: false,
      retryable: true,
    });
  });

  it("rejects unexpected failures only after logging a sanitized fault", async () => {
    const faults: unknown[] = [];
    const secret = new Error("Dr. Nguyen transcript must not be logged");

    const rejection = await executeTool(
      async () => { throw secret; },
      { toolName: "inspect_project", onUnexpectedError: (fault) => faults.push(fault) },
    ).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ name: "CueBenchToolExecutionError" });
    expect((rejection as Error).message).not.toContain(secret.message);
    expect(faults).toEqual([{
      event: "webmcp.unexpected_error",
      toolName: "inspect_project",
      errorType: "Error",
    }]);
  });

  it("does not mistake an unconnected AbortError for agent cancellation", async () => {
    const faults: unknown[] = [];
    const rejection = await executeTool(
      async () => { throw new DOMException("unconnected abort", "AbortError"); },
      { toolName: "inspect_project", onUnexpectedError: (fault) => faults.push(fault) },
    ).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ name: "CueBenchToolExecutionError" });
    expect(faults).toEqual([{
      event: "webmcp.unexpected_error",
      toolName: "inspect_project",
      errorType: "AbortError",
    }]);
  });

  it("accepts CueBench's explicit cancellation sentinel", async () => {
    await expect(executeTool(
      async () => { throw new ToolExecutionAbortedError(); },
      { toolName: "inspect_project" },
    )).resolves.toMatchObject({
      ok: false,
      code: "STALE_SELECTION",
      changed: false,
    });
  });
});
