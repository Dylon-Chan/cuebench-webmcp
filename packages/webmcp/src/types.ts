import {
  ItemRevisionSchema,
  MediaTimeSchema,
  NonNegativeIntegerSchema,
} from "@cuebench/contracts";
import type {
  ContractVersion,
  DomainErrorCode,
  ProjectRevision,
  ReviewState,
} from "@cuebench/contracts";
import { z } from "zod";

/** A JSON Schema object accepted by the WebMCP imperative API. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The subset of WebMCP annotations CueBench needs to communicate intent. */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
}

/**
 * Chrome supplies an execution signal to imperative WebMCP tools. CueBench
 * forwards it together with the registration-family signal so a tool can stop
 * work when either the agent cancels or the visible scope changes.
 */
export interface ToolExecutionClient {
  readonly signal: AbortSignal;
  /**
   * Browser invocation cancellation without the dynamic registration-family
   * signal. Consequential operations use this only after their first durable
   * edge, so replacing their own family cannot abort an idempotent follow-up.
   */
  readonly postCommitSignal?: AbortSignal;
  /**
   * Call immediately after the domain mutation is durably visible. A later
   * cancellation then reports conservative state instead of claiming nothing
   * changed.
   */
  markCommitted: () => void;
}

/** The browser-owned invocation context, kept structural for feature detection. */
export interface ModelContextInvocationClient {
  readonly signal?: AbortSignal;
}

export interface CueBenchToolSuccess<TData = unknown> {
  readonly ok: true;
  readonly contractVersion: ContractVersion;
  readonly projectRevision: ProjectRevision;
  readonly data: TData;
  readonly nextActions: readonly string[];
}

export type ToolSelectionKind =
  | "CaptionCue"
  | "AudioDescriptionBeat"
  | "AudioDescriptionGap";

/** The visible selection/version that made a scoped tool meaningful. */
export interface ToolSelectionSummary {
  readonly kind: ToolSelectionKind;
  readonly selectionId: string;
  readonly selectionRevision: number;
}

/** Compact confirmation of an immutable item revision created by a mutation. */
export interface ChangedItemSummary {
  readonly kind: "CaptionCue" | "AudioDescriptionBeat";
  readonly itemId: string;
  readonly itemRevision: number;
  readonly state: ReviewState;
}

/** Incremental validation feedback; complete validation remains a separate tool. */
export interface FindingDelta {
  readonly addedFindingIds: readonly string[];
  readonly resolvedFindingIds: readonly string[];
  readonly blockerCount: number;
  readonly warningCount: number;
}

/**
 * Every successful tool response carries the compact pieces an agent needs to
 * verify visible state without receiving a full project or evidence payload.
 */
export interface ToolVerification {
  readonly selection: ToolSelectionSummary | null;
  readonly changedItem: ChangedItemSummary | null;
  readonly findingDelta: FindingDelta | null;
  readonly playheadMs: number | null;
}

const selectionSummarySchema = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat", "AudioDescriptionGap"]),
  selectionId: z.string().trim().min(1).max(200),
  selectionRevision: ItemRevisionSchema,
}).strict();

const changedItemSummarySchema = z.object({
  kind: z.enum(["CaptionCue", "AudioDescriptionBeat"]),
  itemId: z.string().trim().min(1).max(200),
  itemRevision: ItemRevisionSchema,
  state: z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]),
}).strict();

const findingDeltaSchema = z.object({
  addedFindingIds: z.array(z.string().trim().min(1).max(200)).max(100),
  resolvedFindingIds: z.array(z.string().trim().min(1).max(200)).max(100),
  blockerCount: NonNegativeIntegerSchema,
  warningCount: NonNegativeIntegerSchema,
}).strict();

/** Shared verification is required on every successful, tool-specific result. */
export const ToolVerificationSchema = z.object({
  selection: selectionSummarySchema.nullable(),
  changedItem: changedItemSummarySchema.nullable(),
  findingDelta: findingDeltaSchema.nullable(),
  playheadMs: MediaTimeSchema.nullable(),
}).strict();

const strictToolDataSchemaBrand = Symbol("CueBenchStrictToolDataSchema");

/**
 * A registry-only result schema. The factory makes both the tool-specific
 * fields and the object boundary strict; an arbitrary Zod schema cannot be
 * accidentally used as an outbound WebMCP result contract.
 */
export interface StrictToolDataSchema {
  readonly schema: z.ZodType;
  readonly [strictToolDataSchemaBrand]: true;
}

export const strictToolDataSchema = (
  shape: z.ZodRawShape,
): StrictToolDataSchema => Object.freeze({
  schema: z.object({ ...shape, verification: ToolVerificationSchema }).strict(),
  [strictToolDataSchemaBrand]: true as const,
});

export const isStrictToolDataSchema = (value: unknown): value is StrictToolDataSchema => (
  value !== null
  && typeof value === "object"
  && (value as { readonly [strictToolDataSchemaBrand]?: unknown })[strictToolDataSchemaBrand] === true
  && "schema" in value
  && (value as { readonly schema?: unknown }).schema instanceof z.ZodType
);

export interface CueBenchToolError {
  readonly ok: false;
  readonly contractVersion: ContractVersion;
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly changed: boolean;
  readonly nextActions: readonly string[];
}

export type CueBenchToolResult<TData = unknown> =
  | CueBenchToolSuccess<TData>
  | CueBenchToolError;

/**
 * The small tool definition used by CueBench adapters. Tool input remains
 * unknown at this boundary: each adapter validates its own JSON-schema input
 * before issuing a version-guarded domain command.
 */
export interface CueBenchTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Strict, tool-specific schema for every successful outbound `data` value. */
  readonly resultDataSchema: StrictToolDataSchema;
  readonly annotations?: ToolAnnotations;
  readonly execute: (
    input: unknown,
    client: ToolExecutionClient,
  ) => CueBenchToolResult | Promise<CueBenchToolResult>;
}

/** Exact structural subset of Chrome's `document.modelContext` used here. */
export interface ModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
  readonly execute: (
    input: unknown,
    client?: ModelContextInvocationClient,
  ) => unknown | Promise<unknown>;
}

export interface ModelContextRegistrationOptions {
  readonly signal?: AbortSignal;
}

export interface ModelContextLike {
  registerTool: (
    tool: ModelContextTool,
    options?: ModelContextRegistrationOptions,
  ) => void | Promise<void>;
}

export interface SelectionToolFamily {
  /** A visible, human-readable selection identity for debug state and logs. */
  readonly scopeId: string;
  readonly tools: readonly CueBenchTool[];
}

/**
 * Do not add a `modelContext` property to a host. This check deliberately
 * returns null on unsupported browsers so the normal human UI stays complete.
 */
export const featureDetectModelContext = (host: unknown): ModelContextLike | null => {
  if (host === null || typeof host !== "object") return null;
  const candidate = (host as { readonly modelContext?: unknown }).modelContext;
  if (candidate === null || typeof candidate !== "object") return null;
  return typeof (candidate as { readonly registerTool?: unknown }).registerTool === "function"
    ? candidate as ModelContextLike
    : null;
};
