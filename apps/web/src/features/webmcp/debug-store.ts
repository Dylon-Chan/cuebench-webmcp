import {
  isWebMcpDebugResultCode,
  isWebMcpDebugToolName,
} from "@cuebench/webmcp";
import type {
  WebMcpDebugArgumentKind,
  WebMcpDebugEvent,
  WebMcpDebugObserver,
  WebMcpDebugRevisions,
  ToolRegistrationGroup,
} from "@cuebench/webmcp";

/** 200 compact metadata rows are enough for judge inspection and remain bounded. */
export const DEFAULT_WEBMCP_DEBUG_EVENT_LIMIT = 200;

export interface WebMcpDebugSnapshot {
  readonly enabled: boolean;
  readonly events: readonly WebMcpDebugEvent[];
}

export interface WebMcpDebugStore extends WebMcpDebugObserver {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WebMcpDebugSnapshot;
  clear: () => void;
  /** Terminal page-lifetime cleanup; future tool callbacks cannot repopulate it. */
  dispose: () => void;
}

export interface WebMcpDebugStoreOptions {
  readonly maxEvents?: number;
}

const MAX_SAFE_DEBUG_EVENT_LIMIT = 200;
const MAX_DEBUG_ARGUMENT_FIELDS = 16;
const MAX_DEBUG_ARGUMENT_KINDS = 8;
const MAX_DEBUG_DURATION_MS = 10 * 60 * 1_000;
const groups = new Set<ToolRegistrationGroup>(["always", "run", "selection"]);
const argumentKinds = new Set<WebMcpDebugArgumentKind>([
  "null",
  "array",
  "object",
  "string",
  "number",
  "boolean",
  "other",
  "uninspectable",
]);
const registrationStatuses = new Set(["registered", "aborted", "registration-failed"]);

const boundedInteger = (value: unknown, maximum: number): number => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0
);

const safeRevision = (value: unknown): number | null => (
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
);

/**
 * Treat a diagnostics event like untrusted data. In particular, do not run a
 * user-supplied getter while deciding whether its value belongs in the drawer.
 */
const ownDataValue = (candidate: unknown, key: string): unknown => {
  try {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor === undefined || "get" in descriptor || "set" in descriptor
      ? undefined
      : descriptor.value;
  } catch {
    return undefined;
  }
};

const safeGroup = (value: unknown): ToolRegistrationGroup | null => (
  typeof value === "string" && groups.has(value as ToolRegistrationGroup)
    ? value as ToolRegistrationGroup
    : null
);

const safeArgumentKind = (value: unknown): WebMcpDebugArgumentKind => (
  typeof value === "string" && argumentKinds.has(value as WebMcpDebugArgumentKind)
    ? value as WebMcpDebugArgumentKind
    : "uninspectable"
);

const safeArgs = (value: unknown) => {
  const rawKinds = ownDataValue(value, "valueKinds");
  const kinds = Array.isArray(rawKinds)
    ? rawKinds
      .slice(0, MAX_DEBUG_ARGUMENT_KINDS)
      .map(safeArgumentKind)
      .filter((kind, index, all) => all.indexOf(kind) === index)
    : [];
  return {
    kind: safeArgumentKind(ownDataValue(value, "kind")),
    fieldCount: boundedInteger(ownDataValue(value, "fieldCount"), MAX_DEBUG_ARGUMENT_FIELDS),
    valueKinds: kinds,
    truncated: ownDataValue(value, "truncated") === true,
  } as const;
};

const safeRevisions = (value: unknown): WebMcpDebugRevisions => {
  return {
    projectRevision: safeRevision(ownDataValue(value, "projectRevision")),
    selectionRevision: safeRevision(ownDataValue(value, "selectionRevision")),
    itemRevision: safeRevision(ownDataValue(value, "itemRevision")),
  };
};

const safeDuration = (duration: unknown, capped: unknown) => {
  const durationMs = boundedInteger(duration, MAX_DEBUG_DURATION_MS);
  const durationExact = typeof duration === "number"
    && Number.isSafeInteger(duration)
    && duration >= 0
    && duration <= MAX_DEBUG_DURATION_MS;
  const durationCapped = capped === true || !durationExact;
  return { durationMs, durationCapped } as const;
};

/**
 * This allowlist is deliberately repeated at the app boundary. Even a future
 * registry regression or a test seam that supplies an arbitrary object cannot
 * place raw captions, speaker names, evidence, filenames, URLs, or model
 * output into the React tree.
 */
const sanitizeDebugEvent = (event: unknown): WebMcpDebugEvent | null => {
  if (event === null || typeof event !== "object") return null;
  const rawToolName = ownDataValue(event, "toolName");
  const toolName = isWebMcpDebugToolName(rawToolName) ? rawToolName : null;
  const group = safeGroup(ownDataValue(event, "group"));
  // Contract v1 is the sole Core schema version. Reject rather than preserve
  // unknown values so the inspector cannot silently misrepresent a payload.
  const schemaVersion = ownDataValue(event, "schemaVersion") === 1 ? 1 : null;
  if (toolName === null || group === null || schemaVersion === null) return null;

  if (ownDataValue(event, "kind") === "registration") {
    const rawStatus = ownDataValue(event, "status");
    const status = typeof rawStatus === "string" && registrationStatuses.has(rawStatus)
      ? rawStatus as "registered" | "aborted" | "registration-failed"
      : null;
    return status === null ? null : {
      kind: "registration",
      toolName,
      schemaVersion,
      group,
      status,
    };
  }
  if (ownDataValue(event, "kind") === "call") {
    const rawResultCode = ownDataValue(event, "resultCode");
    const resultCode = isWebMcpDebugResultCode(rawResultCode) ? rawResultCode : "UNEXPECTED_ERROR";
    const duration = safeDuration(
      ownDataValue(event, "durationMs"),
      ownDataValue(event, "durationCapped"),
    );
    return {
      kind: "call",
      toolName,
      schemaVersion,
      group,
      args: safeArgs(ownDataValue(event, "args")),
      ...duration,
      resultCode,
      revisions: safeRevisions(ownDataValue(event, "revisions")),
      cancelled: ownDataValue(event, "cancelled") === true,
    };
  }
  return null;
};

export const isWebMcpDebugEnabled = (search?: string): boolean => {
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
  try {
    return new URLSearchParams(query).get("webmcpDebug") === "1";
  } catch {
    return false;
  }
};

/**
 * Opt-in only, in-memory only. This intentionally never touches localStorage,
 * sessionStorage, IndexedDB, a network API, or a project record.
 */
export const createWebMcpDebugStore = (
  enabled: boolean,
  options: WebMcpDebugStoreOptions = {},
): WebMcpDebugStore => {
  const requestedLimit = options.maxEvents ?? DEFAULT_WEBMCP_DEBUG_EVENT_LIMIT;
  const maxEvents = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_SAFE_DEBUG_EVENT_LIMIT, Math.trunc(requestedLimit)))
    : DEFAULT_WEBMCP_DEBUG_EVENT_LIMIT;
  const listeners = new Set<() => void>();
  let active = enabled;
  let snapshot: WebMcpDebugSnapshot = Object.freeze({ enabled: active, events: Object.freeze([]) });

  const publish = (events: readonly WebMcpDebugEvent[]): void => {
    snapshot = Object.freeze({ enabled: active, events: Object.freeze([...events]) });
    for (const listener of listeners) listener();
  };

  return {
    isEnabled: () => active,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    clear: () => {
      if (!active || snapshot.events.length === 0) return;
      publish([]);
    },
    dispose: () => {
      if (!active && snapshot.events.length === 0) return;
      active = false;
      // This is terminal cleanup during bridge unmount, so no React listener
      // needs a final render. Replace the immutable snapshot synchronously and
      // drop subscribers instead of scheduling a state update while unmounting.
      snapshot = Object.freeze({ enabled: false, events: Object.freeze([]) });
      listeners.clear();
    },
    record: (event) => {
      if (!active) return;
      let sanitized: WebMcpDebugEvent | null;
      try {
        sanitized = sanitizeDebugEvent(event);
      } catch {
        return;
      }
      if (sanitized === null) return;
      publish([...snapshot.events, sanitized].slice(-maxEvents));
    },
  };
};
