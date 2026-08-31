import {
  CONTRACT_VERSION,
  ToolErrorSchema,
  ToolSuccessSchema,
  type DomainErrorCode,
  type ProjectRevision,
} from "@cuebench/contracts";
import type { DomainError } from "@cuebench/domain";
import { z } from "zod";
import {
  ToolVerificationSchema,
  type ChangedItemSummary,
  type CueBenchToolError,
  type CueBenchToolResult,
  type CueBenchToolSuccess,
  type FindingDelta,
  type StrictToolDataSchema,
  type ToolSelectionSummary,
  type ToolVerification,
} from "./types";

export const MAX_TOOL_RESULT_DEPTH = 12;
export const MAX_TOOL_RESULT_NODES = 1_000;
export const MAX_TOOL_RESULT_BYTES = 32 * 1024;

const MAX_TOOL_SCHEMA_DEPTH = 12;
const MAX_TOOL_SCHEMA_NODES = 1_000;
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;

export interface ToolSuccessInput<TData extends Readonly<Record<string, unknown>>> {
  readonly projectRevision: ProjectRevision;
  readonly data: TData;
  readonly nextActions: readonly string[];
  readonly selection?: ToolSelectionSummary | null;
  readonly changedItem?: ChangedItemSummary | null;
  readonly findingDelta?: FindingDelta | null;
  readonly playheadMs?: number | null;
}

export interface ToolDomainErrorOptions {
  readonly retryable?: boolean;
  readonly changed?: boolean;
  readonly nextActions?: readonly string[];
}

export interface SanitizedToolFault {
  readonly event: "webmcp.unexpected_error";
  readonly toolName: string;
  /** Deliberately excludes an exception message, input, media, and text. */
  readonly errorType: string;
}

export type ToolFaultLogger = (fault: SanitizedToolFault) => void;

export interface ToolAbortOutcome {
  readonly phase: "pre-start" | "after-start";
  readonly committed: boolean;
}

export interface ExecuteToolOptions {
  readonly toolName: string;
  readonly signal?: AbortSignal;
  /** Whether a domain-visible mutation completed before an abort was observed. */
  readonly wasCommitted?: () => boolean;
  readonly onUnexpectedError?: ToolFaultLogger;
  readonly onAborted?: (outcome: ToolAbortOutcome) => CueBenchToolResult;
}

/** A result or JSON schema that cannot safely cross the WebMCP boundary. */
export class ToolResultSafetyError extends Error {
  public constructor() {
    super("CueBench tool output is not safe to return.");
    this.name = "ToolResultSafetyError";
  }
}

/** An input schema that cannot safely be registered with the browser. */
export class ToolSchemaSafetyError extends Error {
  public constructor() {
    super("CueBench tool schema is not safe to register.");
    this.name = "ToolSchemaSafetyError";
  }
}

const toolExecutionAbortBrand = Symbol("CueBenchToolExecutionAborted");

/** Explicit cancellation sentinel for adapters that intentionally stop work. */
export class ToolExecutionAbortedError extends Error {
  public readonly [toolExecutionAbortBrand] = true;

  public constructor() {
    super("CueBench WebMCP tool execution was cancelled.");
    this.name = "ToolExecutionAbortedError";
  }
}

/**
 * Deliberately generic rejection used for unexpected execution failures.
 * It never carries the original exception as a message or a `cause`.
 */
export class CueBenchToolExecutionError extends Error {
  public constructor() {
    super("CueBench could not complete this tool. Inspect the project and retry if appropriate.");
    this.name = "CueBenchToolExecutionError";
  }
}

interface JsonSafetyLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

type SafetyErrorConstructor = new () => Error;

const helperSuccessDataSchema = z.object({
  verification: ToolVerificationSchema,
}).passthrough();

const successSchema = ToolSuccessSchema(helperSuccessDataSchema).strict();

const retryableCodes = new Set<DomainErrorCode>([
  "UPLOAD_EXPIRED",
  "GENERATION_STAGE_FAILED",
  "STALE_PROJECT",
  "STALE_ITEM",
  "STALE_SELECTION",
  "STALE_RUN",
  "TARGET_TRACK_LEASE_CONFLICT",
  "RECOVERY_ARTIFACT_EXPIRED",
]);

const defaultFaultLogger: ToolFaultLogger = (fault) => {
  // This intentionally logs only a classified event, never user-generated
  // text, transcript content, media details, input arguments, or URLs.
  console.error("CueBench WebMCP tool failed unexpectedly.", fault);
};

const safeErrorTypes = new Set([
  "AbortError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ZodError",
  "ToolResultSafetyError",
]);

const sanitizedErrorType = (error: unknown): string => {
  if (error instanceof ToolResultSafetyError) return "ToolResultSafetyError";
  if (error instanceof z.ZodError) return "ZodError";
  try {
    if (error !== null && typeof error === "object") {
      const name = (error as { readonly name?: unknown }).name;
      if (typeof name === "string" && safeErrorTypes.has(name)) return name;
    }
  } catch {
    return "UnexpectedError";
  }
  return "UnexpectedError";
};

const isBrandedCancellation = (error: unknown): boolean => {
  try {
    return error !== null
      && typeof error === "object"
      && (error as { readonly [toolExecutionAbortBrand]?: unknown })[toolExecutionAbortBrand] === true;
  } catch {
    return false;
  }
};

const reportUnexpectedFault = (logger: ToolFaultLogger, fault: SanitizedToolFault): void => {
  try {
    logger(fault);
  } catch {
    // Diagnostics must never replace the generic execution boundary.
  }
};

const assertJsonSafe = (
  value: unknown,
  limits: JsonSafetyLimits,
  ErrorType: SafetyErrorConstructor,
): void => {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const fail = (): never => { throw new ErrorType(); };
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) fail();

    if (candidate === null) return;
    switch (typeof candidate) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(candidate)) fail();
        return;
      case "object":
        break;
      default:
        fail();
    }

    const objectCandidate = candidate as object;
    if (seen.has(objectCandidate)) fail();
    seen.add(objectCandidate);

    if (Array.isArray(candidate)) {
      if (candidate.length > limits.maxNodes) fail();
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(candidate, index)) fail();
      }
    } else {
      const prototype = Object.getPrototypeOf(objectCandidate);
      if (prototype !== Object.prototype && prototype !== null) fail();
    }

    for (const key of Object.keys(objectCandidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(objectCandidate, key);
      if (descriptor === undefined || "get" in descriptor || "set" in descriptor) fail();
      visit((descriptor as PropertyDescriptor).value, depth + 1);
    }
  };

  try {
    visit(value, 0);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > limits.maxBytes) {
      fail();
    }
  } catch (error) {
    if (error instanceof ErrorType) throw error;
    throw new ErrorType();
  }
};

/** Validate every outbound result before it crosses from the page to an agent. */
export const assertToolResultJsonSafe = (value: unknown): void => {
  assertJsonSafe(value, {
    maxDepth: MAX_TOOL_RESULT_DEPTH,
    maxNodes: MAX_TOOL_RESULT_NODES,
    maxBytes: MAX_TOOL_RESULT_BYTES,
  }, ToolResultSafetyError);
};

/** Validate a browser-facing JSON input schema before replacing a live surface. */
export const assertToolSchemaJsonSafe = (value: unknown): void => {
  assertJsonSafe(value, {
    maxDepth: MAX_TOOL_SCHEMA_DEPTH,
    maxNodes: MAX_TOOL_SCHEMA_NODES,
    maxBytes: MAX_TOOL_SCHEMA_BYTES,
  }, ToolSchemaSafetyError);
};

/**
 * Parse a result against a particular tool's strict outbound schema. Safety
 * runs both before and after Zod parsing so neither an unsafe raw result nor a
 * transformed value can escape to a browser agent.
 */
export const validateToolResult = (
  result: unknown,
  resultDataSchema: StrictToolDataSchema,
): CueBenchToolResult => {
  assertToolResultJsonSafe(result);
  const parsed = z.union([
    ToolSuccessSchema(resultDataSchema.schema).strict(),
    ToolErrorSchema.strict(),
  ]).parse(result);
  assertToolResultJsonSafe(parsed);
  return parsed as CueBenchToolResult;
};

/** Build a compact, versioned result after the DOM-visible mutation has finished. */
export const toolSuccess = <TData extends Readonly<Record<string, unknown>>>(
  input: ToolSuccessInput<TData>,
): CueBenchToolSuccess<TData & { readonly verification: ToolVerification }> => (
  successSchema.parse({
    ok: true,
    contractVersion: CONTRACT_VERSION,
    projectRevision: input.projectRevision,
    data: {
      ...input.data,
      verification: ToolVerificationSchema.parse({
        selection: input.selection ?? null,
        changedItem: input.changedItem ?? null,
        findingDelta: input.findingDelta ?? null,
        playheadMs: input.playheadMs ?? null,
      }),
    },
    nextActions: [...input.nextActions],
  }) as CueBenchToolSuccess<TData & { readonly verification: ToolVerification }>
);

/** Convert a known domain rejection into the structured, non-throwing contract. */
export const toolDomainError = (
  error: DomainError,
  options: ToolDomainErrorOptions = {},
): CueBenchToolError => ToolErrorSchema.parse({
  ok: false,
  contractVersion: CONTRACT_VERSION,
  code: error.code,
  message: error.message,
  retryable: options.retryable ?? retryableCodes.has(error.code),
  changed: options.changed ?? false,
  nextActions: [...(options.nextActions ?? ["inspect_project"])],
});

/** A stale dynamically-scoped tool returns a conservative, inspect-first outcome. */
export const abortedToolResult = (options: { readonly changed?: boolean } = {}): CueBenchToolError => ToolErrorSchema.parse({
  ok: false,
  contractVersion: CONTRACT_VERSION,
  code: "STALE_SELECTION",
  message: "The visible selection changed before this tool could finish.",
  retryable: true,
  changed: options.changed ?? false,
  nextActions: ["inspect_project"],
});

/**
 * Resolve expected cancellation as a structured result. A completed success
 * remains truthful even if it itself replaces the group that owns the tool;
 * only cancellation before a result is produced is converted to stale state.
 */
export const executeTool = async <TData>(
  operation: () => CueBenchToolResult<TData> | Promise<CueBenchToolResult<TData>>,
  options: ExecuteToolOptions,
): Promise<CueBenchToolResult<TData>> => {
  const committed = (): boolean => {
    try {
      return options.wasCommitted?.() === true;
    } catch {
      // A broken observer must not cause us to under-report a possible mutation.
      return true;
    }
  };
  const aborted = (phase: ToolAbortOutcome["phase"]): CueBenchToolResult<TData> => {
    const outcome = { phase, committed: phase === "after-start" && committed() } as const;
    return (options.onAborted?.(outcome) ?? abortedToolResult({ changed: outcome.committed })) as CueBenchToolResult<TData>;
  };

  if (options.signal?.aborted) return aborted("pre-start");

  try {
    // Do not inspect the signal after this resolves: a successful tool may
    // legitimately replace its own dynamic registration group before return.
    return await operation();
  } catch (error) {
    if (options.signal?.aborted === true || isBrandedCancellation(error)) {
      return aborted("after-start");
    }
    reportUnexpectedFault(options.onUnexpectedError ?? defaultFaultLogger, {
      event: "webmcp.unexpected_error",
      toolName: options.toolName,
      errorType: sanitizedErrorType(error),
    });
    throw new CueBenchToolExecutionError();
  }
};
