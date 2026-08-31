import {
  assertToolSchemaJsonSafe,
  executeTool,
  validateToolResult,
  type ToolFaultLogger,
} from "./tool-result";
import { CONTRACT_VERSION } from "@cuebench/contracts";
import {
  isStrictToolDataSchema,
  type CueBenchTool,
  type ModelContextInvocationClient,
  type ModelContextLike,
  type ModelContextTool,
  type SelectionToolFamily,
  type ToolAnnotations,
  type ToolRegistrationGroup,
  type WebMcpDebugArgumentKind,
  type WebMcpDebugArguments,
  type WebMcpDebugEvent,
  type WebMcpDebugObserver,
  type WebMcpDebugRevisions,
  type WebMcpDebugResultCode,
  type WebMcpDebugToolName,
  isWebMcpDebugResultCode,
  isWebMcpDebugToolName,
} from "./types";

export type { ToolRegistrationGroup } from "./types";

export interface CueBenchToolRegistryOptions {
  readonly onUnexpectedError?: ToolFaultLogger;
  /** Provided only by CueBench's `?webmcpDebug=1` in-memory inspector. */
  readonly debugObserver?: WebMcpDebugObserver;
}

/**
 * A page can bind its otherwise-identical tool families to an exact visible
 * project instance. The registry treats these as opaque scope identities; it
 * never exposes them to an agent or changes any tool contract.
 */
export interface RunRegistrationScopes {
  readonly alwaysScopeId?: string;
  readonly runScopeId?: string | null;
  /** Replace captured page runtime closures in the same atomic transition. */
  readonly alwaysTools?: readonly CueBenchTool[];
}

/** An exact page surface replacement, registered as one host transition. */
export interface CueBenchToolSurface {
  readonly alwaysTools: readonly CueBenchTool[];
  readonly alwaysScopeId: string;
  readonly runTools: readonly CueBenchTool[] | null;
  readonly runScopeId: string | null;
  readonly selection: SelectionToolFamily | null;
}

export interface RegistryGroupSnapshot {
  readonly scopeId: string | null;
  readonly toolNames: readonly string[];
  /** True only after this browser accepted the group registration. */
  readonly registered: boolean;
}

export interface CueBenchToolRegistrySnapshot {
  readonly available: boolean;
  readonly always: RegistryGroupSnapshot;
  readonly run: RegistryGroupSnapshot;
  readonly selection: RegistryGroupSnapshot;
}

export class DuplicateToolNameError extends Error {
  public readonly toolName: string;

  public constructor(toolName: string, firstGroup?: ToolRegistrationGroup, secondGroup?: ToolRegistrationGroup) {
    super(firstGroup === undefined || secondGroup === undefined
      ? `CueBench WebMCP tool names must be unique: ${toolName}.`
      : `CueBench WebMCP tool ${toolName} is already active in ${firstGroup} and cannot also register in ${secondGroup}.`);
    this.name = "DuplicateToolNameError";
    this.toolName = toolName;
  }
}

export class InvalidToolDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidToolDefinitionError";
  }
}

/** A disposed bridge has no safe browser-registration surface to revive. */
export class ToolRegistryDisposedError extends Error {
  public constructor() {
    super("CueBench WebMCP registration was disposed before this browser transition settled.");
    this.name = "ToolRegistryDisposedError";
  }
}

interface GroupOwner {
  readonly transitionId: number;
  readonly epoch: number;
}

interface ActiveGroup {
  readonly controller: AbortController;
  readonly scopeId: string | null;
  readonly tools: readonly CueBenchTool[];
  readonly owner: GroupOwner;
  registered: boolean;
}

interface GroupReplacement {
  readonly group: ToolRegistrationGroup;
  readonly scopeId: string | null;
  readonly tools: readonly CueBenchTool[];
}

interface OwnedGroup {
  readonly name: ToolRegistrationGroup;
  readonly group: ActiveGroup;
}

interface PreparedGroup extends OwnedGroup {
  readonly previous: ActiveGroup | null;
}

interface RegistrationAttempt extends OwnedGroup {
  readonly promise: Promise<void>;
}

interface RegistrationStart {
  readonly attempts: readonly RegistrationAttempt[];
  readonly hasSynchronousFailure: boolean;
  readonly synchronousFailure: unknown;
}

interface SurfaceMetadata {
  readonly alwaysTools: readonly CueBenchTool[];
  readonly runTools: readonly CueBenchTool[] | null;
  readonly alwaysScopeId: string;
}

interface PendingMetadataTask {
  readonly start: () => void;
  readonly interrupt: () => void;
}

interface JoinedAbortSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

const groupOrder: readonly ToolRegistrationGroup[] = ["always", "run", "selection"];
const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/;

/** Exact idle starters are absent while an active generation run is surfaced. */
const activeRunStarterNames = new Set([
  "start_caption_generation",
  "start_ad_generation",
]);

const namesOf = (tools: readonly CueBenchTool[]): readonly string[] => tools.map((tool) => tool.name);

const MAX_DEBUG_ARGUMENT_FIELDS = 16;
const MAX_DEBUG_ENUMERATION_ATTEMPTS = 32;
const MAX_DEBUG_DURATION_MS = 10 * 60 * 1_000;

interface DebugCallCapture {
  readonly observer: WebMcpDebugObserver;
  readonly toolName: WebMcpDebugToolName;
  readonly group: ToolRegistrationGroup;
  readonly args: WebMcpDebugArguments;
  readonly startedAt: number;
}

interface DebugDuration {
  readonly durationMs: number;
  readonly durationCapped: boolean;
}

const debugArgumentKind = (value: unknown): WebMcpDebugArgumentKind => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": return "object";
    default: return "other";
  }
};

/**
 * This intentionally never returns an argument value or argument name. It
 * stops after a tiny bounded sample so the debug-only observer cannot become
 * a context, telemetry, or memory side channel.
 */
const debugArguments = (input: unknown): WebMcpDebugArguments => {
  try {
    // Keep *every* reflection operation inside this fail-closed boundary. A
    // revoked Proxy can throw from Array.isArray, iteration, or descriptors;
    // diagnostics must never change the tool's normal outcome.
    const kind = debugArgumentKind(input);
    if (kind !== "object" && kind !== "array") {
      return { kind, fieldCount: 0, valueKinds: [], truncated: false };
    }
    const candidate = input as Record<string, unknown>;
    const valueKinds = new Set<WebMcpDebugArgumentKind>();
    let fieldCount = 0;
    let truncated = false;
    let enumerationAttempts = 0;
    // Do not materialize Object.keys/Reflect.ownKeys: both can allocate an
    // unbounded list. This loop caps *all* enumeration attempts, including
    // inherited properties, while descriptors avoid evaluating getters.
    for (const key in candidate) {
      enumerationAttempts += 1;
      if (enumerationAttempts > MAX_DEBUG_ENUMERATION_ATTEMPTS) {
        truncated = true;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      if (fieldCount >= MAX_DEBUG_ARGUMENT_FIELDS) {
        truncated = true;
        break;
      }
      fieldCount += 1;
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
        valueKinds.add("uninspectable");
      } else {
        valueKinds.add(debugArgumentKind(descriptor.value));
      }
    }
    return {
      kind,
      fieldCount,
      valueKinds: [...valueKinds].sort(),
      truncated,
    };
  } catch {
    return { kind: "uninspectable", fieldCount: 0, valueKinds: [], truncated: false };
  }
};

const safeDebugRevision = (value: unknown): number | null => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const ownValue = (candidate: unknown, key: string): unknown => {
  try {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor === undefined || "get" in descriptor || "set" in descriptor ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
};

const debugRevisions = (result: unknown): WebMcpDebugRevisions => {
  const projectRevision = safeDebugRevision(ownValue(result, "projectRevision"));
  const data = ownValue(result, "data");
  const verification = ownValue(data, "verification");
  const selection = ownValue(verification, "selection");
  const changedItem = ownValue(verification, "changedItem");
  return {
    projectRevision,
    selectionRevision: safeDebugRevision(ownValue(selection, "selectionRevision")),
    itemRevision: safeDebugRevision(ownValue(changedItem, "itemRevision")),
  };
};

const debugResultCode = (result: unknown): WebMcpDebugResultCode => {
  if (ownValue(result, "ok") === true) return "OK";
  const code = ownValue(result, "code");
  return isWebMcpDebugResultCode(code) ? code : "UNEXPECTED_ERROR";
};

const debugDuration = (startedAt: number): DebugDuration => {
  const elapsed = Date.now() - startedAt;
  const exact = Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= MAX_DEBUG_DURATION_MS;
  if (!exact) {
    return {
      durationMs: typeof elapsed === "number" && Number.isFinite(elapsed)
        ? Math.min(MAX_DEBUG_DURATION_MS, Math.max(0, Math.trunc(elapsed)))
        : 0,
      durationCapped: true,
    };
  }
  return { durationMs: elapsed, durationCapped: false };
};

const debugObserverEnabled = (observer: WebMcpDebugObserver | undefined): boolean => {
  try {
    return observer !== undefined && (observer.isEnabled?.() ?? true);
  } catch {
    return false;
  }
};

const joinedAbortSignal = (signals: readonly (AbortSignal | undefined)[]): JoinedAbortSignal => {
  const uniqueSignals = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (uniqueSignals.length === 0) {
    const controller = new AbortController();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const first = uniqueSignals[0];
  if (uniqueSignals.length === 1 && first !== undefined) return { signal: first, dispose: () => undefined };

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abort = () => controller.abort();
  for (const signal of uniqueSignals) {
    if (signal.aborted) controller.abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      listeners.set(signal, abort);
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.clear();
    },
  };
};

const browserAnnotations = (annotations: ToolAnnotations | undefined): ToolAnnotations | undefined => {
  if (annotations === undefined) return undefined;
  const registered: ToolAnnotations = {
    ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
    ...(typeof annotations.untrustedContentHint === "boolean"
      ? { untrustedContentHint: annotations.untrustedContentHint }
      : {}),
  };
  return Object.keys(registered).length === 0 ? undefined : registered;
};

/**
 * Owns only browser-agent tool registration. It never creates `document.modelContext`,
 * mutates human UI state, or attempts a fallback implementation when WebMCP is absent.
 */
export class CueBenchToolRegistry {
  private readonly groups: Record<ToolRegistrationGroup, ActiveGroup | null> = {
    always: null,
    run: null,
    selection: null,
  };

  /** Each group epoch makes an older asynchronous transition unable to reclaim it. */
  private readonly groupEpochs: Record<ToolRegistrationGroup, number> = {
    always: 0,
    run: 0,
    selection: 0,
  };

  private readonly onUnexpectedError: ToolFaultLogger | undefined;
  private debugObserver: WebMcpDebugObserver | undefined;
  private transitionSequence = 0;
  /** A same textual scope can still belong to a newer async surface transition. */
  private metadataEpoch = 0;
  private alwaysTools: readonly CueBenchTool[] = [];
  private runTools: readonly CueBenchTool[] | null = null;
  private alwaysScopeId = "always";
  /** Disposal is terminal: an unmounted bridge may never revive a late host surface. */
  private disposed = false;
  private lifecycleGeneration = 0;
  private readonly disposalController = new AbortController();
  /**
   * Metadata claims must be serialized with their browser-registration
   * transition. In particular, `select()` cannot observe a stable surface,
   * yield, and then claim a newer epoch while a later always/run transition
   * is still eligible to roll metadata back. The first task starts in the
   * caller's stack so imperative host registrations remain synchronous.
   */
  private metadataTransitionActive = false;
  private activeMetadataTask: PendingMetadataTask | null = null;
  private readonly pendingMetadataTasks: PendingMetadataTask[] = [];

  public constructor(
    private readonly modelContext: ModelContextLike | null | undefined,
    options: CueBenchToolRegistryOptions = {},
  ) {
    this.onUnexpectedError = options.onUnexpectedError;
    this.debugObserver = options.debugObserver;
  }

  public get available(): boolean {
    return !this.disposed && this.modelContext !== null && this.modelContext !== undefined;
  }

  /**
   * The page may turn its development-only inspector on or off without
   * changing any human UI or browser registrations. Existing wrappers read
   * this current observer at invocation time, so disabling is immediate.
   */
  public setDebugObserver(observer: WebMcpDebugObserver | undefined): void {
    this.debugObserver = observer;
  }

  /** Register (or atomically replace) the idle always-available surface. */
  public registerAlways(tools: readonly CueBenchTool[], scopeId = "always"): Promise<void> {
    return this.runMetadataTransition(async () => {
      assertUsableTools(tools);
      if (scopeId.trim().length === 0) {
        throw new InvalidToolDefinitionError("An always-available WebMCP tool family must have a scope id.");
      }
      const nextAlways = [...tools];
      const visibleAlways = this.visibleAlwaysTools(nextAlways, this.runTools);
      this.assertNoLiveNameCollisions({
        always: visibleAlways,
        run: this.runTools ?? [],
        selection: this.groups.selection?.tools ?? [],
      });
      const previous = this.surfaceMetadata();
      const claim = this.setSurfaceMetadata({
        alwaysTools: nextAlways,
        runTools: this.runTools,
        alwaysScopeId: scopeId,
      });
      try {
        await this.replaceGroups([{ group: "always", scopeId, tools: visibleAlways }]);
      } catch (error) {
        this.restoreSurfaceMetadata(claim, previous);
        throw error;
      }
    });
  }

  /**
   * Replaces exact idle generation starters with active-run tools, or restores
   * the complete idle always surface when no run is visible.
   */
  public setRun(tools: readonly CueBenchTool[] | null, scopes: RunRegistrationScopes = {}): Promise<void> {
    return this.runMetadataTransition(async () => {
      if (tools !== null) assertUsableTools(tools);
      if (scopes.alwaysTools !== undefined) assertUsableTools(scopes.alwaysTools);
      const nextAlwaysScopeId = scopes.alwaysScopeId ?? this.alwaysScopeId;
      const nextRunScopeId = tools === null ? null : (scopes.runScopeId ?? "active-run");
      if (nextAlwaysScopeId.trim().length === 0 || (nextRunScopeId !== null && nextRunScopeId.trim().length === 0)) {
        throw new InvalidToolDefinitionError("A WebMCP registration scope id must not be empty.");
      }
      const nextRun = tools === null ? null : [...tools];
      const nextAlways = scopes.alwaysTools === undefined ? this.alwaysTools : [...scopes.alwaysTools];
      const visibleAlways = this.visibleAlwaysTools(nextAlways, nextRun);
      this.assertNoLiveNameCollisions({
        always: visibleAlways,
        run: nextRun ?? [],
        selection: this.groups.selection?.tools ?? [],
      });
      const previous = this.surfaceMetadata();
      const claim = this.setSurfaceMetadata({
        alwaysTools: nextAlways,
        runTools: nextRun,
        alwaysScopeId: nextAlwaysScopeId,
      });
      try {
        await this.replaceGroups([
          { group: "always", scopeId: nextAlwaysScopeId, tools: visibleAlways },
          { group: "run", scopeId: nextRunScopeId, tools: nextRun ?? [] },
        ]);
      } catch (error) {
        this.restoreSurfaceMetadata(claim, previous);
        throw error;
      }
    });
  }

  /**
   * Atomically replace every family for one visible page snapshot. This keeps
   * same-revision project replacements from leaving any stale closure alive,
   * while starting all browser registrations before awaiting any of them.
   */
  public synchronize(surface: CueBenchToolSurface): Promise<void> {
    return this.runMetadataTransition(async () => {
      assertUsableTools(surface.alwaysTools);
      if (surface.runTools !== null) assertUsableTools(surface.runTools);
      if (surface.alwaysScopeId.trim().length === 0 || (surface.runScopeId !== null && surface.runScopeId.trim().length === 0)) {
        throw new InvalidToolDefinitionError("A WebMCP registration scope id must not be empty.");
      }
      if (surface.selection !== null) {
        if (surface.selection.scopeId.trim().length === 0) {
          throw new InvalidToolDefinitionError("A dynamic WebMCP selection must have a scope id.");
        }
        assertUsableTools(surface.selection.tools);
      }
      if ((surface.runTools === null) !== (surface.runScopeId === null)) {
        throw new InvalidToolDefinitionError("An active-run tool family and scope must appear together.");
      }
      const nextAlways = [...surface.alwaysTools];
      const nextRun = surface.runTools === null ? null : [...surface.runTools];
      const nextSelection = surface.selection === null ? [] : [...surface.selection.tools];
      const visibleAlways = this.visibleAlwaysTools(nextAlways, nextRun);
      this.assertNoLiveNameCollisions({
        always: visibleAlways,
        run: nextRun ?? [],
        selection: nextSelection,
      });

      const previous = this.surfaceMetadata();
      const claim = this.setSurfaceMetadata({
        alwaysTools: nextAlways,
        runTools: nextRun,
        alwaysScopeId: surface.alwaysScopeId,
      });
      try {
        await this.replaceGroups([
          { group: "always", scopeId: surface.alwaysScopeId, tools: visibleAlways },
          { group: "run", scopeId: surface.runScopeId, tools: nextRun ?? [] },
          { group: "selection", scopeId: surface.selection?.scopeId ?? null, tools: nextSelection },
        ]);
      } catch (error) {
        this.restoreSurfaceMetadata(claim, previous);
        throw error;
      }
    });
  }

  /** Register exactly one focus-dependent cue, AD beat, or evidence-gap family. */
  public select(family: SelectionToolFamily | null): Promise<void> {
    return this.runMetadataTransition(async () => {
      if (family !== null) {
        if (family.scopeId.trim().length === 0) {
          throw new InvalidToolDefinitionError("A dynamic WebMCP selection must have a scope id.");
        }
        assertUsableTools(family.tools);
      }
      const nextTools = family === null ? [] : [...family.tools];
      this.assertNoLiveNameCollisions({
        always: this.visibleAlwaysTools(this.alwaysTools, this.runTools),
        run: this.runTools ?? [],
        selection: nextTools,
      });
      // Selection owns a metadata transition even though it does not alter
      // the always/run values. This fences an older failed transition from
      // rolling metadata back over an accepted newer selection.
      const previous = this.surfaceMetadata();
      const claim = this.setSurfaceMetadata(previous);
      try {
        await this.replaceGroups([{
          group: "selection",
          scopeId: family?.scopeId ?? null,
          tools: nextTools,
        }]);
      } catch (error) {
        this.restoreSurfaceMetadata(claim, previous);
        throw error;
      }
    });
  }

  /** Remove all dynamically registered tools; it does not alter the human interface. */
  public dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.disposalController.abort();

    // A queued selection/run claim must not start after unmount just because
    // an older host registration eventually settles. Interrupt it before the
    // active task, otherwise the active completion could dequeue it.
    const queued = this.pendingMetadataTasks.splice(0);
    for (const task of queued) task.interrupt();
    const active = this.activeMetadataTask;
    this.activeMetadataTask = null;
    this.metadataTransitionActive = false;
    active?.interrupt();

    // Metadata and owner epochs are independently fenced. A late rollback
    // cannot reclaim either after this terminal generation advance.
    this.metadataEpoch += 1;
    this.alwaysTools = [];
    this.runTools = null;
    const owned = groupOrder.map((name) => ({ name, group: this.groups[name] }));
    for (const { name } of owned) {
      this.groups[name] = null;
      this.groupEpochs[name] += 1;
    }
    for (const { name, group } of owned) {
      if (group !== null) this.abortGroup(name, group);
    }
    return Promise.resolve();
  }

  public snapshot(): CueBenchToolRegistrySnapshot {
    return {
      available: this.available,
      always: this.groupSnapshot("always"),
      run: this.groupSnapshot("run"),
      selection: this.groupSnapshot("selection"),
    };
  }

  /** Debug observation is explicitly best-effort and never changes a tool outcome. */
  private recordDebug(observer: WebMcpDebugObserver, event: WebMcpDebugEvent): void {
    try {
      if (!debugObserverEnabled(observer)) return;
      observer.record(event);
    } catch {
      // The opt-in judge drawer must never become a source of execution faults.
    }
  }

  private recordGroupStatus(
    group: ToolRegistrationGroup,
    tools: readonly CueBenchTool[],
    status: "registered" | "aborted" | "registration-failed",
  ): void {
    const observer = this.debugObserver;
    if (observer === undefined || !debugObserverEnabled(observer)) return;
    for (const tool of tools) {
      const toolName = isWebMcpDebugToolName(tool.name) ? tool.name : null;
      if (toolName === null) continue;
      this.recordDebug(observer, {
        kind: "registration",
        toolName,
        schemaVersion: CONTRACT_VERSION,
        group,
        status,
      });
    }
  }

  /** Begin capture inside one fail-closed boundary before tool execution. */
  private beginDebugCapture(
    toolName: string,
    group: ToolRegistrationGroup,
    input: unknown,
  ): DebugCallCapture | null {
    try {
      const observer = this.debugObserver;
      const approvedToolName = isWebMcpDebugToolName(toolName) ? toolName : null;
      if (approvedToolName === null || !debugObserverEnabled(observer) || observer === undefined) return null;
      return {
        observer,
        toolName: approvedToolName,
        group,
        args: debugArguments(input),
        startedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Finish capture under the same fail-closed boundary, retaining no raw result. */
  private finishDebugCapture(
    capture: DebugCallCapture | null,
    result: unknown,
    cancelled: boolean,
  ): void {
    if (capture === null) return;
    try {
      const duration = debugDuration(capture.startedAt);
      this.recordDebug(capture.observer, {
        kind: "call",
        toolName: capture.toolName,
        schemaVersion: CONTRACT_VERSION,
        group: capture.group,
        args: capture.args,
        ...duration,
        resultCode: debugResultCode(result),
        revisions: debugRevisions(result),
        cancelled,
      });
    } catch {
      // The opt-in judge drawer must never become a source of execution faults.
    }
  }

  private abortGroup(name: ToolRegistrationGroup, group: ActiveGroup): void {
    if (group.controller.signal.aborted) return;
    group.controller.abort();
    this.recordGroupStatus(name, group.tools, "aborted");
  }

  private recordRegistrationFailure(groups: readonly OwnedGroup[]): void {
    for (const owned of groups) this.recordGroupStatus(owned.name, owned.group.tools, "registration-failed");
  }

  private visibleAlwaysTools(
    allAlwaysTools: readonly CueBenchTool[],
    runTools: readonly CueBenchTool[] | null,
  ): readonly CueBenchTool[] {
    if (runTools === null) return allAlwaysTools;
    return allAlwaysTools.filter((tool) => !activeRunStarterNames.has(tool.name));
  }

  private surfaceMetadata(): SurfaceMetadata {
    return {
      alwaysTools: this.alwaysTools,
      runTools: this.runTools,
      alwaysScopeId: this.alwaysScopeId,
    };
  }

  private setSurfaceMetadata(next: SurfaceMetadata): number {
    const claim = this.metadataEpoch + 1;
    this.metadataEpoch = claim;
    this.alwaysTools = next.alwaysTools;
    this.runTools = next.runTools;
    this.alwaysScopeId = next.alwaysScopeId;
    return claim;
  }

  /** Restore only if no later registration operation claimed the metadata. */
  private restoreSurfaceMetadata(claim: number, previous: SurfaceMetadata): void {
    if (this.disposed || this.metadataEpoch !== claim) return;
    // The rollback receives its own claim so another older deferred failure
    // cannot reclaim the same scope after this one completes.
    this.setSurfaceMetadata(previous);
  }

  /**
   * Runs the first metadata transition synchronously and queues later work
   * FIFO. Registration callbacks can therefore re-enter safely without an
   * old failed transition restoring metadata over a newer family claim.
   */
  private runMetadataTransition<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new ToolRegistryDisposedError());
    const generation = this.lifecycleGeneration;
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (): void => {
        if (this.activeMetadataTask !== task) return;
        this.activeMetadataTask = null;
        this.metadataTransitionActive = false;
        const next = this.pendingMetadataTasks.shift();
        next?.start();
      };
      const rejectTask = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (started) finish();
        reject(error);
      };
      const task: PendingMetadataTask = {
        start: () => {
          if (settled) return;
          if (!this.isCurrentLifecycleGeneration(generation)) {
            rejectTask(new ToolRegistryDisposedError());
            return;
          }
          started = true;
          this.activeMetadataTask = task;
          this.metadataTransitionActive = true;
          let pending: Promise<T>;
          try {
            // Do not wrap in an extra Promise.resolve callback: browser hosts
            // expect every member of an initial registration wave synchronously.
            pending = operation();
          } catch (error) {
            pending = Promise.reject(error);
          }
          void pending.then(
            (value) => {
              // Release/start the next claim before resolving the caller's
              // await. Otherwise an immediately-following transition observes
              // a stale busy bit and loses imperative registration synchronicity.
              if (settled) return;
              settled = true;
              finish();
              resolve(value);
            },
            (error) => {
              rejectTask(error);
            },
          );
        },
        interrupt: () => rejectTask(new ToolRegistryDisposedError()),
      };
      if (!this.metadataTransitionActive && this.pendingMetadataTasks.length === 0) task.start();
      else this.pendingMetadataTasks.push(task);
    });
  }

  private isCurrentLifecycleGeneration(generation: number): boolean {
    return !this.disposed && generation === this.lifecycleGeneration;
  }

  private throwIfDisposed(generation: number): void {
    if (!this.isCurrentLifecycleGeneration(generation)) throw new ToolRegistryDisposedError();
  }

  /** Race host registration with terminal disposal without waiting for a host promise to settle. */
  private async awaitCurrentLifecycle<T>(pending: Promise<T>, generation: number): Promise<T> {
    this.throwIfDisposed(generation);
    const cleanup = { removeAbortListener: null as (() => void) | null };
    const disposed = new Promise<never>((_resolve, reject) => {
      const rejectDisposed = () => reject(new ToolRegistryDisposedError());
      this.disposalController.signal.addEventListener("abort", rejectDisposed, { once: true });
      cleanup.removeAbortListener = () => this.disposalController.signal.removeEventListener("abort", rejectDisposed);
    });
    try {
      return await Promise.race([pending, disposed]);
    } finally {
      cleanup.removeAbortListener?.();
    }
  }

  private groupSnapshot(group: ToolRegistrationGroup): RegistryGroupSnapshot {
    const active = this.groups[group];
    return {
      scopeId: active?.scopeId ?? null,
      toolNames: active === null ? [] : namesOf(active.tools),
      registered: active?.registered ?? false,
    };
  }

  /** Preflight all names before any existing group is aborted. */
  private assertNoLiveNameCollisions(groups: Record<ToolRegistrationGroup, readonly CueBenchTool[]>): void {
    const owners = new Map<string, ToolRegistrationGroup>();
    for (const group of groupOrder) {
      for (const tool of groups[group]) {
        const firstGroup = owners.get(tool.name);
        if (firstGroup !== undefined) throw new DuplicateToolNameError(tool.name, firstGroup, group);
        owners.set(tool.name, group);
      }
    }
  }

  /**
   * Claims fresh per-group owners before any outgoing abort fires. AbortSignal
   * listeners are synchronous, so an outgoing slot is cleared by identity and
   * its fresh successor is installed before the listener can re-enter.
   */
  private async replaceGroups(replacements: readonly GroupReplacement[]): Promise<void> {
    const generation = this.lifecycleGeneration;
    this.throwIfDisposed(generation);
    const uniqueGroups = new Set<ToolRegistrationGroup>();
    for (const replacement of replacements) {
      if (uniqueGroups.has(replacement.group)) {
        throw new InvalidToolDefinitionError(`The ${replacement.group} group was replaced more than once.`);
      }
      uniqueGroups.add(replacement.group);
    }

    const transitionId = ++this.transitionSequence;
    const prepared = replacements.map((replacement): PreparedGroup => {
      const previous = this.groups[replacement.group];
      this.clearGroupSlot(replacement.group, previous);
      const group = this.createActiveGroup(replacement, transitionId);
      this.groups[replacement.group] = group;
      return { name: replacement.group, group, previous };
    });

    // Do this only after every new owner is installed. A reentrant callback can
    // then replace a fresh owner, and the stale transition will detect it.
    for (const { name, previous } of prepared) {
      if (previous !== null) this.abortGroup(name, previous);
    }

    this.throwIfDisposed(generation);
    if (!this.available) return;
    const registration = this.startRegistrations(prepared);
    const settledRegistration = Promise.allSettled(registration.attempts.map((attempt) => attempt.promise));
    if (registration.hasSynchronousFailure) {
      this.recordRegistrationFailure(prepared);
      const rollback = this.abortOwnedGroups(prepared);
      await this.awaitCurrentLifecycle(settledRegistration, generation);
      this.throwIfDisposed(generation);
      await this.restorePriorGroups(rollback, generation);
      this.throwIfDisposed(generation);
      throw registration.synchronousFailure;
    }

    try {
      await this.awaitCurrentLifecycle(Promise.all(registration.attempts.map((attempt) => attempt.promise)), generation);
    } catch (error) {
      this.recordRegistrationFailure(prepared);
      const rollback = this.abortOwnedGroups(prepared);
      await this.awaitCurrentLifecycle(settledRegistration, generation);
      this.throwIfDisposed(generation);
      await this.restorePriorGroups(rollback, generation);
      this.throwIfDisposed(generation);
      throw error;
    }
    this.throwIfDisposed(generation);
    this.markRegistered(prepared);
  }

  /**
   * Invoke every browser registration synchronously before awaiting a single
   * promise. This avoids exposing only the first member of a tool family while
   * later registrations are still pending.
   */
  private startRegistrations(groups: readonly OwnedGroup[]): RegistrationStart {
    const modelContext = this.modelContext;
    if (modelContext === null || modelContext === undefined) {
      return { attempts: [], hasSynchronousFailure: false, synchronousFailure: undefined };
    }

    const attempts: RegistrationAttempt[] = [];
    let hasSynchronousFailure = false;
    let synchronousFailure: unknown;
    for (const owned of groups) {
      if (!this.ownsGroup(owned.name, owned.group)) continue;
      for (const tool of owned.group.tools) {
        if (!this.ownsGroup(owned.name, owned.group) || hasSynchronousFailure) break;
        try {
          attempts.push({
            ...owned,
            promise: Promise.resolve(modelContext.registerTool(
              this.wrapTool(tool, owned.group, owned.name),
              { signal: owned.group.controller.signal },
            )),
          });
        } catch (error) {
          hasSynchronousFailure = true;
          synchronousFailure = error;
          break;
        }
      }
      if (hasSynchronousFailure) break;
    }
    return { attempts, hasSynchronousFailure, synchronousFailure };
  }

  /**
   * Clear the matching slot before aborting it. This ordering prevents a
   * synchronous AbortSignal listener from being wiped by an older transition.
   */
  private clearGroupSlot(name: ToolRegistrationGroup, expected: ActiveGroup | null): ActiveGroup | null {
    if (expected === null || this.groups[name] !== expected) return null;
    this.groups[name] = null;
    return expected;
  }

  private createActiveGroup(replacement: GroupReplacement, transitionId: number): ActiveGroup {
    const epoch = this.groupEpochs[replacement.group] + 1;
    this.groupEpochs[replacement.group] = epoch;
    return {
      controller: new AbortController(),
      scopeId: replacement.scopeId,
      tools: replacement.tools,
      owner: { transitionId, epoch },
      registered: false,
    };
  }

  private ownsGroup(name: ToolRegistrationGroup, group: ActiveGroup): boolean {
    return !this.disposed && this.groups[name] === group && this.groupEpochs[name] === group.owner.epoch;
  }

  /** A detached failed group may restore only while no newer epoch owns its slot. */
  private canRestoreGroup(name: ToolRegistrationGroup, group: ActiveGroup): boolean {
    return !this.disposed && this.groups[name] === null && this.groupEpochs[name] === group.owner.epoch;
  }

  /** Clear every still-owned slot before firing any of their abort listeners. */
  private abortOwnedGroups(groups: readonly OwnedGroup[]): readonly PreparedGroup[] {
    const cleared: OwnedGroup[] = [];
    const detached: PreparedGroup[] = [];
    for (const owned of groups) {
      if (!this.ownsGroup(owned.name, owned.group)) continue;
      this.groups[owned.name] = null;
      cleared.push(owned);
      if ("previous" in owned) detached.push(owned as PreparedGroup);
    }
    for (const owned of cleared) this.abortGroup(owned.name, owned.group);
    return detached;
  }

  private markRegistered(groups: readonly OwnedGroup[]): void {
    for (const owned of groups) {
      if (
        this.ownsGroup(owned.name, owned.group)
        && !owned.group.controller.signal.aborted
        && owned.group.tools.length > 0
      ) {
        owned.group.registered = true;
        this.recordGroupStatus(owned.name, owned.group.tools, "registered");
      }
    }
  }

  /**
   * Recreates prior families only while the failed epoch still owns an empty
   * slot. A newer select/setRun/registerAlways always increments the epoch and
   * therefore wins over this late rollback.
   */
  private async restorePriorGroups(rollback: readonly PreparedGroup[], generation: number): Promise<void> {
    this.throwIfDisposed(generation);
    const transitionId = ++this.transitionSequence;
    const restored: OwnedGroup[] = [];
    for (const failed of rollback) {
      if (!this.canRestoreGroup(failed.name, failed.group) || failed.previous === null) continue;
      const group = this.createActiveGroup({
        group: failed.name,
        scopeId: failed.previous.scopeId,
        tools: failed.previous.tools,
      }, transitionId);
      this.groups[failed.name] = group;
      restored.push({ name: failed.name, group });
    }

    if (!this.available || restored.length === 0) {
      this.throwIfDisposed(generation);
      return;
    }
    const registration = this.startRegistrations(restored);
    const settledRegistration = Promise.allSettled(registration.attempts.map((attempt) => attempt.promise));
    if (registration.hasSynchronousFailure) {
      this.recordRegistrationFailure(restored);
      this.abortOwnedGroups(restored);
      await this.awaitCurrentLifecycle(settledRegistration, generation);
      return;
    }
    try {
      await this.awaitCurrentLifecycle(Promise.all(registration.attempts.map((attempt) => attempt.promise)), generation);
    } catch {
      this.recordRegistrationFailure(restored);
      this.abortOwnedGroups(restored);
      await this.awaitCurrentLifecycle(settledRegistration, generation);
      return;
    }
    this.throwIfDisposed(generation);
    this.markRegistered(restored);
  }

  private wrapTool(
    tool: CueBenchTool,
    group: ActiveGroup,
    registrationGroup: ToolRegistrationGroup,
  ): ModelContextTool {
    const annotations = browserAnnotations(tool.annotations);
    return {
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(annotations === undefined ? {} : { annotations }),
      execute: async (input: unknown, client?: ModelContextInvocationClient) => {
        const joined = joinedAbortSignal([group.controller.signal, client?.signal]);
        let committed = false;
        const debugCapture = this.beginDebugCapture(tool.name, registrationGroup, input);
        try {
          const result = await executeTool(
            async () => validateToolResult(
              await tool.execute(input, {
                signal: joined.signal,
                ...(client?.signal === undefined ? {} : { postCommitSignal: client.signal }),
                markCommitted: () => { committed = true; },
              }),
              tool.resultDataSchema,
            ),
            {
              toolName: tool.name,
              signal: joined.signal,
              wasCommitted: () => committed,
              ...(this.onUnexpectedError === undefined ? {} : { onUnexpectedError: this.onUnexpectedError }),
            },
          );
          this.finishDebugCapture(debugCapture, result, joined.signal.aborted);
          return result;
        } catch (error) {
          this.finishDebugCapture(debugCapture, undefined, joined.signal.aborted);
          throw error;
        } finally {
          joined.dispose();
        }
      },
    };
  }
}

const assertUsableTools = (tools: readonly CueBenchTool[]): void => {
  const names = new Set<string>();
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !toolNamePattern.test(tool.name)) {
      throw new InvalidToolDefinitionError("CueBench WebMCP tools need a 1-128 character [A-Za-z0-9_.-] name.");
    }
    if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
      throw new InvalidToolDefinitionError(`CueBench WebMCP tool ${tool.name} needs a description.`);
    }
    if (!isStrictToolDataSchema(tool.resultDataSchema)) {
      throw new InvalidToolDefinitionError(`CueBench WebMCP tool ${tool.name} needs a strict tool-specific result schema.`);
    }
    if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw new InvalidToolDefinitionError(`CueBench WebMCP tool ${tool.name} needs a JSON object input schema.`);
    }
    try {
      assertToolSchemaJsonSafe(tool.inputSchema);
    } catch {
      throw new InvalidToolDefinitionError(`CueBench WebMCP tool ${tool.name} has an invalid JSON input schema.`);
    }
    if (names.has(tool.name)) throw new DuplicateToolNameError(tool.name);
    names.add(tool.name);
  }
};
