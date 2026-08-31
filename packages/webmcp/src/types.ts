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

/** The one visible WebMCP family that owned a browser registration. */
export type ToolRegistrationGroup = "always" | "run" | "selection";

/**
 * The debug inspector is intentionally constrained to the fixed Core surface.
 * Do not fall back to a permissive identifier check here: a future dynamic
 * name could itself disclose a filename, speaker, or model diagnostic.
 */
export const WEBMCP_DEBUG_TOOL_NAMES = [
  "inspect_project",
  "inspect_timeline_window",
  "list_quality_findings",
  "focus_quality_finding",
  "start_caption_generation",
  "start_ad_generation",
  "validate_project",
  "export_track",
  "propose_profile_patch",
  "prepare_certification_review",
  "inspect_generation_run",
  "cancel_generation_run",
  "inspect_selected_cue_evidence",
  "adjust_selected_cue_timing",
  "split_selected_cue",
  "merge_selected_cue",
  "revise_selected_cue",
  "mark_selected_cue_agent_ready",
  "inspect_selected_ad_evidence",
  "adjust_selected_ad_timing",
  "revise_selected_ad_beat",
  "preview_selected_narration",
  "mark_selected_ad_agent_ready",
  "inspect_selected_gap_evidence",
  "propose_ad_beat_in_gap",
] as const;

export type WebMcpDebugToolName = typeof WEBMCP_DEBUG_TOOL_NAMES[number];

const webMcpDebugToolNameSet = new Set<string>(WEBMCP_DEBUG_TOOL_NAMES);

export const isWebMcpDebugToolName = (value: unknown): value is WebMcpDebugToolName => (
  typeof value === "string" && webMcpDebugToolNameSet.has(value)
);

/**
 * A result code is similarly a closed protocol field, never arbitrary server
 * or model text. `UNEXPECTED_ERROR` is the only fallback sentinel.
 */
export const WEBMCP_DEBUG_RESULT_CODES = [
  "OK",
  "UNEXPECTED_ERROR",
  "UNSUPPORTED_MEDIA",
  "INVALID_MEDIA",
  "FILE_SIZE_LIMIT_EXCEEDED",
  "DURATION_LIMIT_EXCEEDED",
  "STORAGE_INSUFFICIENT",
  "TURNSTILE_SESSION_FAILED",
  "QUOTA_EXCEEDED",
  "SPEND_BREAKER_OPEN",
  "UPLOAD_EXPIRED",
  "UPLOAD_OWNERSHIP_MISMATCH",
  "GENERATION_STAGE_FAILED",
  "GENERATION_CANCELLED",
  "STALE_PROJECT",
  "STALE_ITEM",
  "STALE_SELECTION",
  "STALE_RUN",
  "CONFIRMATION_DECLINED",
  "TARGET_TRACK_LEASE_CONFLICT",
  "VALIDATION_BLOCKER",
  "CERTIFICATION_OUT_OF_DATE",
  "EXPORT_ROUND_TRIP_MISMATCH",
  "BACKUP_SCHEMA_UNSUPPORTED",
  "MEDIA_HASH_MISMATCH",
  "RECOVERY_ARTIFACT_EXPIRED",
  "HUMAN_AUTHORITY_REQUIRED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
] as const satisfies readonly (DomainErrorCode | "OK" | "UNEXPECTED_ERROR")[];

export type WebMcpDebugResultCode = typeof WEBMCP_DEBUG_RESULT_CODES[number];

const webMcpDebugResultCodeSet = new Set<string>(WEBMCP_DEBUG_RESULT_CODES);

export const isWebMcpDebugResultCode = (value: unknown): value is WebMcpDebugResultCode => (
  typeof value === "string" && webMcpDebugResultCodeSet.has(value)
);

/**
 * Debug capture deliberately records shape, never input values or property
 * names. This means caption prose, speaker labels, evidence URLs, filenames,
 * frames, and raw model output cannot enter the judge drawer by design.
 */
export type WebMcpDebugArgumentKind =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "other"
  | "uninspectable";

export interface WebMcpDebugArguments {
  readonly kind: WebMcpDebugArgumentKind;
  /** A bounded count: at most 16 observed fields/items plus truncation. */
  readonly fieldCount: number;
  /** Bounded primitive/container kinds only; no values or property names. */
  readonly valueKinds: readonly WebMcpDebugArgumentKind[];
  readonly truncated: boolean;
}

export interface WebMcpDebugRevisions {
  readonly projectRevision: number | null;
  readonly selectionRevision: number | null;
  readonly itemRevision: number | null;
}

export interface WebMcpDebugRegistrationEvent {
  readonly kind: "registration";
  readonly toolName: WebMcpDebugToolName;
  readonly schemaVersion: ContractVersion;
  readonly group: ToolRegistrationGroup;
  readonly status: "registered" | "aborted" | "registration-failed";
}

export interface WebMcpDebugCallEvent {
  readonly kind: "call";
  readonly toolName: WebMcpDebugToolName;
  readonly schemaVersion: ContractVersion;
  readonly group: ToolRegistrationGroup;
  readonly args: WebMcpDebugArguments;
  readonly durationMs: number;
  /** True when `durationMs` is a conservative capped lower bound, not exact. */
  readonly durationCapped: boolean;
  /** `OK`, a fixed structured domain-error code, or `UNEXPECTED_ERROR` only. */
  readonly resultCode: WebMcpDebugResultCode;
  readonly revisions: WebMcpDebugRevisions;
  readonly cancelled: boolean;
}

export type WebMcpDebugEvent = WebMcpDebugRegistrationEvent | WebMcpDebugCallEvent;

/** Optional opt-in sink; failures from diagnostics must never affect a tool. */
export interface WebMcpDebugObserver {
  /** Optional runtime gate; throwing or false means capture must fail closed. */
  readonly isEnabled?: () => boolean;
  record: (event: WebMcpDebugEvent) => void;
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
