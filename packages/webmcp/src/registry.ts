import {
  assertToolSchemaJsonSafe,
  executeTool,
  validateToolResult,
  type ToolFaultLogger,
} from "./tool-result";
import {
  isStrictToolDataSchema,
  type CueBenchTool,
  type ModelContextInvocationClient,
  type ModelContextLike,
  type ModelContextTool,
  type SelectionToolFamily,
  type ToolAnnotations,
} from "./types";

export type ToolRegistrationGroup = "always" | "run" | "selection";

export interface CueBenchToolRegistryOptions {
  readonly onUnexpectedError?: ToolFaultLogger;
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
  private transitionSequence = 0;
  private alwaysTools: readonly CueBenchTool[] = [];
  private runTools: readonly CueBenchTool[] | null = null;

  public constructor(
    private readonly modelContext: ModelContextLike | null | undefined,
    options: CueBenchToolRegistryOptions = {},
  ) {
    this.onUnexpectedError = options.onUnexpectedError;
  }

  public get available(): boolean {
    return this.modelContext !== null && this.modelContext !== undefined;
  }

  /** Register (or atomically replace) the idle always-available surface. */
  public async registerAlways(tools: readonly CueBenchTool[]): Promise<void> {
    assertUsableTools(tools);
    const nextAlways = [...tools];
    const visibleAlways = this.visibleAlwaysTools(nextAlways, this.runTools);
    this.assertNoLiveNameCollisions({
      always: visibleAlways,
      run: this.runTools ?? [],
      selection: this.groups.selection?.tools ?? [],
    });
    const previousAlways = this.alwaysTools;
    this.alwaysTools = nextAlways;
    try {
      await this.replaceGroups([{ group: "always", scopeId: "always", tools: visibleAlways }]);
    } catch (error) {
      if (this.alwaysTools === nextAlways) this.alwaysTools = previousAlways;
      throw error;
    }
  }

  /**
   * Replaces exact idle generation starters with active-run tools, or restores
   * the complete idle always surface when no run is visible.
   */
  public async setRun(tools: readonly CueBenchTool[] | null): Promise<void> {
    if (tools !== null) assertUsableTools(tools);
    const nextRun = tools === null ? null : [...tools];
    const visibleAlways = this.visibleAlwaysTools(this.alwaysTools, nextRun);
    this.assertNoLiveNameCollisions({
      always: visibleAlways,
      run: nextRun ?? [],
      selection: this.groups.selection?.tools ?? [],
    });
    const previousRun = this.runTools;
    this.runTools = nextRun;
    try {
      await this.replaceGroups([
        { group: "always", scopeId: "always", tools: visibleAlways },
        { group: "run", scopeId: nextRun === null ? null : "active-run", tools: nextRun ?? [] },
      ]);
    } catch (error) {
      if (this.runTools === nextRun) this.runTools = previousRun;
      throw error;
    }
  }

  /** Register exactly one focus-dependent cue, AD beat, or evidence-gap family. */
  public async select(family: SelectionToolFamily | null): Promise<void> {
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
    await this.replaceGroups([{
      group: "selection",
      scopeId: family?.scopeId ?? null,
      tools: nextTools,
    }]);
  }

  /** Remove all dynamically registered tools; it does not alter the human interface. */
  public async dispose(): Promise<void> {
    const previousAlways = this.alwaysTools;
    const previousRun = this.runTools;
    this.alwaysTools = [];
    this.runTools = null;
    try {
      await this.replaceGroups(groupOrder.map((group) => ({ group, scopeId: null, tools: [] })));
    } catch (error) {
      this.alwaysTools = previousAlways;
      this.runTools = previousRun;
      throw error;
    }
  }

  public snapshot(): CueBenchToolRegistrySnapshot {
    return {
      available: this.available,
      always: this.groupSnapshot("always"),
      run: this.groupSnapshot("run"),
      selection: this.groupSnapshot("selection"),
    };
  }

  private visibleAlwaysTools(
    allAlwaysTools: readonly CueBenchTool[],
    runTools: readonly CueBenchTool[] | null,
  ): readonly CueBenchTool[] {
    if (runTools === null) return allAlwaysTools;
    return allAlwaysTools.filter((tool) => !activeRunStarterNames.has(tool.name));
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
    for (const { previous } of prepared) previous?.controller.abort();

    if (!this.available) return;
    const registration = this.startRegistrations(prepared);
    const settledRegistration = Promise.allSettled(registration.attempts.map((attempt) => attempt.promise));
    if (registration.hasSynchronousFailure) {
      const rollback = this.abortOwnedGroups(prepared);
      await settledRegistration;
      await this.restorePriorGroups(rollback);
      throw registration.synchronousFailure;
    }

    try {
      await Promise.all(registration.attempts.map((attempt) => attempt.promise));
    } catch (error) {
      const rollback = this.abortOwnedGroups(prepared);
      await settledRegistration;
      await this.restorePriorGroups(rollback);
      throw error;
    }
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
              this.wrapTool(tool, owned.group),
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
    return this.groups[name] === group && this.groupEpochs[name] === group.owner.epoch;
  }

  /** A detached failed group may restore only while no newer epoch owns its slot. */
  private canRestoreGroup(name: ToolRegistrationGroup, group: ActiveGroup): boolean {
    return this.groups[name] === null && this.groupEpochs[name] === group.owner.epoch;
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
    for (const owned of cleared) owned.group.controller.abort();
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
      }
    }
  }

  /**
   * Recreates prior families only while the failed epoch still owns an empty
   * slot. A newer select/setRun/registerAlways always increments the epoch and
   * therefore wins over this late rollback.
   */
  private async restorePriorGroups(rollback: readonly PreparedGroup[]): Promise<void> {
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

    if (!this.available || restored.length === 0) return;
    const registration = this.startRegistrations(restored);
    const settledRegistration = Promise.allSettled(registration.attempts.map((attempt) => attempt.promise));
    if (registration.hasSynchronousFailure) {
      this.abortOwnedGroups(restored);
      await settledRegistration;
      return;
    }
    try {
      await Promise.all(registration.attempts.map((attempt) => attempt.promise));
    } catch {
      this.abortOwnedGroups(restored);
      await settledRegistration;
      return;
    }
    this.markRegistered(restored);
  }

  private wrapTool(tool: CueBenchTool, group: ActiveGroup): ModelContextTool {
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
        try {
          return await executeTool(
            async () => validateToolResult(
              await tool.execute(input, {
                signal: joined.signal,
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
