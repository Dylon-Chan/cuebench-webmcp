import {
  CONTRACT_VERSION,
  MAX_AD_DESCRIPTION_LENGTH,
  MAX_CAPTION_TEXT_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_SPEAKER_NAME_LENGTH,
  MAX_TRACK_ITEMS_PER_PAGE,
  type Actor,
} from "@cuebench/contracts";
import type {
  CaptionProject,
  CommandResult,
  DomainCommand,
  ProjectTrackExport,
  QualityFinding,
} from "@cuebench/domain";
import { z } from "zod";
import type { JsonSchema, ToolSelectionKind } from "../types";

export const MAX_WEBMCP_PAGE_SIZE = Math.min(MAX_TRACK_ITEMS_PER_PAGE, 32);
export const DEFAULT_WEBMCP_PAGE_SIZE = 16;
export const MAX_WEBMCP_TIMELINE_WINDOW_MS = 120_000;
export const MAX_WEBMCP_EVIDENCE_ITEMS = 32;
export const MAX_WEBMCP_FINDINGS_PER_PAGE = 24;
export const MAX_WEBMCP_TEXT_PREVIEW_LENGTH = 240;

const identifier = z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH);
const mediaTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pageLimit = z.number().int().min(1).max(MAX_WEBMCP_PAGE_SIZE).default(DEFAULT_WEBMCP_PAGE_SIZE);
const cursor = z.string().trim().min(1).max(256).nullable().optional().default(null);

export const ContractInputSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
}).strict();

export const ExpectedProjectRevisionInputSchema = ContractInputSchema.extend({
  expectedProjectRevision: positiveInteger,
}).strict();

export const ExpectedSelectionInputSchema = ExpectedProjectRevisionInputSchema.extend({
  expectedSelectionId: identifier,
  expectedSelectionRevision: positiveInteger,
  expectedItemRevision: positiveInteger,
}).strict();

export const CaptionSelectionInputSchema = ExpectedSelectionInputSchema;
export const AudioDescriptionSelectionInputSchema = ExpectedSelectionInputSchema;
export const GapSelectionInputSchema = ExpectedProjectRevisionInputSchema.extend({
  expectedSelectionId: identifier,
  expectedSelectionRevision: positiveInteger,
  expectedGapRevision: positiveInteger,
}).strict();

const jsonScalar = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const jsonList = z.array(jsonScalar).max(32);
const jsonLeaf = z.union([jsonScalar, jsonList]);
const jsonNestedRecord = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/), jsonLeaf).refine(
  (value) => Object.keys(value).length <= 32,
  "Nested profile patches may contain at most 32 keys.",
);
export const ProfilePatchSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
  z.union([jsonLeaf, jsonNestedRecord]),
).refine(
  (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32,
  "A profile patch must contain between one and 32 safe keys.",
);

/** JSON-schema counterpart to the deliberately bounded one-level patch shape. */
export const ProfilePatchJsonSchema = {
  type: "object",
  maxProperties: 32,
  propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]{0,99}$" },
  additionalProperties: {
    anyOf: [
      {
        anyOf: [
          {
            anyOf: [
              { type: "string", maxLength: 1_000 },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
          {
            type: "array",
            maxItems: 32,
            items: {
              anyOf: [
                { type: "string", maxLength: 1_000 },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
          },
        ],
      },
      {
        type: "object",
        maxProperties: 32,
        propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]{0,99}$" },
        additionalProperties: {
          anyOf: [
            {
              anyOf: [
                { type: "string", maxLength: 1_000 },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
            {
              type: "array",
              maxItems: 32,
              items: {
                anyOf: [
                  { type: "string", maxLength: 1_000 },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "null" },
                ],
              },
            },
          ],
        },
      },
    ],
  },
} as const satisfies JsonSchema;

export const CaptionSnapshotSchema = z.object({
  kind: z.literal("CaptionCue"),
  itemId: identifier,
  itemRevision: positiveInteger,
  state: z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]),
  startMs: mediaTime,
  endMs: mediaTime,
  textPreview: z.string().max(MAX_WEBMCP_TEXT_PREVIEW_LENGTH),
  speaker: z.string().trim().min(1).max(MAX_SPEAKER_NAME_LENGTH).nullable(),
}).strict();

export const AudioDescriptionSnapshotSchema = z.object({
  kind: z.literal("AudioDescriptionBeat"),
  itemId: identifier,
  itemRevision: positiveInteger,
  state: z.enum(["Proposed", "AgentReady", "Objected", "Sustained"]),
  startMs: mediaTime,
  endMs: mediaTime,
  descriptionPreview: z.string().max(MAX_WEBMCP_TEXT_PREVIEW_LENGTH),
}).strict();

export const GapSnapshotSchema = z.object({
  kind: z.literal("AudioDescriptionGap"),
  gapId: identifier,
  gapRevision: positiveInteger,
  state: z.enum(["Available", "Consumed"]),
  startMs: mediaTime,
  endMs: mediaTime,
}).strict();

export const SelectedSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CaptionCue"),
    selectionId: identifier,
    selectionRevision: positiveInteger,
  }).strict(),
  z.object({
    kind: z.literal("AudioDescriptionBeat"),
    selectionId: identifier,
    selectionRevision: positiveInteger,
  }).strict(),
  z.object({
    kind: z.literal("AudioDescriptionGap"),
    selectionId: identifier,
    selectionRevision: positiveInteger,
  }).strict(),
]).nullable();

export const FindingSnapshotSchema = z.object({
  findingId: identifier,
  ruleId: z.string().trim().min(1).max(200),
  severity: z.enum(["blocker", "warning"]),
  messagePreview: z.string().max(MAX_WEBMCP_TEXT_PREVIEW_LENGTH),
  targetKind: z.enum(["project", "item", "pair", "extended-description-requirement"]),
  targetItemIds: z.array(identifier).max(2),
}).strict();

export const PageSchema = z.object({
  limit: z.number().int().positive().max(MAX_WEBMCP_PAGE_SIZE),
  cursor: z.string().trim().min(1).max(256).nullable(),
  nextCursor: z.string().trim().min(1).max(256).nullable(),
  totalCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

export interface WebMcpConfirmationRequest {
  readonly kind: "reopen-sustained" | "replace-proposed";
  readonly title: string;
  readonly detail: string;
  readonly itemId?: string;
  /** Every currently-sensitive item covered by this one visible decision. */
  readonly itemIds?: readonly string[];
}

export interface WebMcpProfileProposal {
  /** The immutable project instance that the diff was calculated against. */
  readonly projectId: string;
  readonly proposalId: string;
  readonly createdBy: string;
  readonly rationale: string;
  readonly profileId: string;
  readonly name: string;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly baseProfileRevision: number;
  /** A backup/import/replacement must not display a proposal from another revision. */
  readonly baseProjectRevision: number;
  readonly changedPaths: readonly string[];
}

export interface WebMcpGenerationStatus {
  readonly runId: string;
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly stage: string;
  readonly progress: number | null;
  readonly warnings: readonly string[];
  readonly retryable: boolean | null;
  readonly code: string | null;
  readonly receiptState: "available" | "missing" | "expired";
}

/**
 * A generation request may have durably acquired a run identity even when the
 * browser cannot yet present a final Worker status. The tool must surface that
 * identity instead of misreporting the operation as an unchanged argument
 * failure.
 */
export interface WebMcpGenerationOperation {
  readonly run: WebMcpGenerationStatus;
  readonly lifecycle: "ready" | "accepted-unknown" | "lifecycle-pending";
}

export interface WebMcpExportPublication {
  readonly prepared: ProjectTrackExport;
  readonly published: boolean;
}

export interface WebMcpNarrationPreview {
  readonly cacheKey: string;
  readonly measuredDurationMs: number;
  readonly source: "cache" | "fresh";
  readonly audioUrl: string | null;
}

/**
 * Pure tool adapters depend only on this narrow page-owned port. The React
 * bridge supplies it from the same ProjectStore and visible focus controls as
 * the human interface; tests can substitute a deterministic in-memory port.
 */
export interface CueBenchWebMcpRuntime {
  readonly browserAgent: Actor;
  readonly getProject: () => CaptionProject | null;
  /**
   * Internal page-owned invocation fence. It is deliberately not a tool input:
   * a dynamically registered family belongs to one exact project instance, not
   * merely to a reusable numeric revision.
   */
  readonly projectInstance?: {
    readonly projectId: string;
    readonly projectRevision: number;
    /** Opaque page-local epoch, never accepted from or returned to an agent. */
    readonly projectInstanceEpoch: number;
    /** One-way durable owner-capability binding, never accepted from or returned to an agent. */
    readonly projectInstanceCapabilityFingerprint?: string | null;
  };
  /** Exact page-owned nonportable-instance check for read and mutation tools. */
  readonly isCurrentProjectInstance?: () => boolean;
  readonly executeCommand: (command: DomainCommand) => Promise<CommandResult>;
  readonly getPlayheadMs: () => number;
  /** Resolves only after React/DOM state and dynamic registration match project state. */
  readonly afterVisibleChange: () => Promise<void>;
  /** Reveals the selection/evidence in the existing visible workbench without a second domain mutation. */
  readonly revealSelection?: (input: {
    readonly kind: ToolSelectionKind;
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    /** Explicit invocation cancellation only after a selection command committed. */
    readonly signal?: AbortSignal;
    /** Page-owned monotonically increasing visual acknowledgement identity. */
    readonly visualEpoch?: number;
  }) => Promise<void> | void;
  /**
   * Runs the existing Human draft save/discard/cancel guard before a Browser
   * Agent persists a new selection. It intentionally performs no domain
   * selection itself, so cancellation leaves the old scoped tool family live.
   */
  readonly prepareSelectionFocus?: (input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean | void> | boolean | void;
  /** Cancellable, in-page Human confirmation; omitted ports fail closed. */
  readonly requestConfirmation?: (request: WebMcpConfirmationRequest, signal: AbortSignal) => Promise<boolean>;
  /** Stores an unapplied Browser Agent proposal for the Human profile-review UI. */
  readonly publishProfileProposal?: (proposal: WebMcpProfileProposal, signal: AbortSignal) => Promise<void> | void;
  /** Serializes, records round-trip evidence, and exposes a real browser download affordance. */
  readonly exportTrack?: (input: {
    readonly project: CaptionProject;
    readonly trackKind: "Captions" | "AudioDescriptions";
    readonly format: "vtt" | "srt" | "ad-txt";
    readonly disposition: "draft" | "certified";
    readonly expectedProjectRevision: number;
    /** Cancels only before a durable export/browser publication boundary. */
    readonly signal: AbortSignal;
    /** Called at the first irreversible browser-visible/domain side effect. */
    readonly onCommitted?: () => void;
  }) => Promise<WebMcpExportPublication>;
  readonly startGeneration?: (input: {
    readonly project: CaptionProject;
    readonly targetTrack: "Captions" | "AudioDescriptions";
    readonly expectedProjectRevision: number;
    /** Cancels only before a durable run lease/receipt boundary. */
    readonly signal: AbortSignal;
    /** Explicit invocation cancellation only after a durable lifecycle edge. */
    readonly postCommitSignal?: AbortSignal;
    /** Called immediately when a lease, remote receipt, or recovery marker is durable. */
    readonly onCommitted?: () => void;
  }) => Promise<WebMcpGenerationOperation>;
  readonly inspectGeneration?: (input: {
    readonly project: CaptionProject;
    readonly signal: AbortSignal;
  }) => Promise<WebMcpGenerationStatus | null>;
  readonly cancelGeneration?: (input: {
    readonly project: CaptionProject;
    readonly expectedProjectRevision: number;
    /** Cancels only before a durable cancellation-intent boundary. */
    readonly signal: AbortSignal;
    /** Explicit invocation cancellation only after durable cancellation intent. */
    readonly postCommitSignal?: AbortSignal;
    /** Called immediately when cancellation intent or another durable lifecycle effect occurs. */
    readonly onCommitted?: () => void;
  }) => Promise<WebMcpGenerationOperation>;
  readonly previewNarration?: (input: {
    readonly project: CaptionProject;
    readonly beatId: string;
    readonly itemRevision: number;
    readonly signal: AbortSignal;
    /** Called before quota/cache side effects that cannot be safely replayed. */
    readonly onCommitted?: () => void;
  }) => Promise<WebMcpNarrationPreview>;
  readonly createOpaqueId?: (prefix: string) => string;
}

export const jsonObjectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: [...required],
});

export const commonJsonProperties = {
  contractVersion: { type: "integer", const: CONTRACT_VERSION },
  expectedProjectRevision: { type: "integer", minimum: 1 },
  expectedSelectionId: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH },
  expectedSelectionRevision: { type: "integer", minimum: 1 },
  expectedItemRevision: { type: "integer", minimum: 1 },
  expectedGapRevision: { type: "integer", minimum: 1 },
} as const satisfies Readonly<Record<string, JsonSchema>>;

export const safeTextPreview = (value: string): string => value.length <= MAX_WEBMCP_TEXT_PREVIEW_LENGTH
  ? value
  : `${value.slice(0, Math.max(0, MAX_WEBMCP_TEXT_PREVIEW_LENGTH - 1))}…`;

export const pageInputSchema = <Shape extends z.ZodRawShape>(shape: Shape) => z.object({
  ...shape,
  limit: pageLimit,
  cursor,
}).strict();

export const parseOffsetCursor = (value: string | null): number | null => {
  if (value === null) return 0;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const createPage = (totalCount: number, offset: number, limit: number) => {
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < totalCount ? String(nextOffset) : null;
  return {
    limit,
    cursor: offset === 0 ? null : String(offset),
    nextCursor,
    totalCount,
    truncated: nextCursor !== null,
  } as const;
};

export const currentSelection = (project: CaptionProject) => {
  const selection = project.selectedItem;
  if (selection === null) return null;
  return {
    kind: selection.kind,
    selectionId: selection.itemId,
    selectionRevision: selection.itemRevision,
  } as const;
};

export const findingSnapshot = (finding: QualityFinding) => ({
  findingId: finding.findingId,
  ruleId: finding.ruleId,
  severity: finding.severity,
  messagePreview: safeTextPreview(finding.message),
  targetKind: finding.target.type,
  targetItemIds: finding.target.type === "item"
    ? [finding.target.itemId]
    : finding.target.type === "pair"
      ? [finding.target.first.itemId, finding.target.second.itemId]
      : [],
});

export const requireBrowserAgent = (actor: Actor): Actor | null => actor.type === "BrowserAgent" ? actor : null;

export const resolveProfilePatch = (
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const merge = (base: Readonly<Record<string, unknown>>, change: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(change)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (value === null) {
        Reflect.deleteProperty(next, key);
        continue;
      }
      if (
        typeof value === "object" && value !== null && !Array.isArray(value)
        && typeof next[key] === "object" && next[key] !== null && !Array.isArray(next[key])
      ) {
        next[key] = merge(next[key] as Readonly<Record<string, unknown>>, value as Readonly<Record<string, unknown>>);
      } else next[key] = structuredClone(value);
    }
    return next;
  };
  return merge(current, patch);
};

export const changedPathsForPatch = (patch: Readonly<Record<string, unknown>>, prefix = "rules"): readonly string[] => Object.entries(patch)
  .flatMap(([key, value]) => (
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? changedPathsForPatch(value as Readonly<Record<string, unknown>>, `${prefix}.${key}`)
      : [`${prefix}.${key}`]
  ))
  .slice(0, 64);

export const captionSnapshot = (item: CaptionProject["captions"]["items"][string]) => ({
  kind: "CaptionCue" as const,
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  state: item.current.state,
  startMs: item.current.startMs,
  endMs: item.current.endMs,
  textPreview: safeTextPreview(item.current.text),
  speaker: item.current.speaker,
});

export const audioDescriptionSnapshot = (item: CaptionProject["audioDescriptions"]["items"][string]) => ({
  kind: "AudioDescriptionBeat" as const,
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  state: item.current.state,
  startMs: item.current.startMs,
  endMs: item.current.endMs,
  descriptionPreview: safeTextPreview(item.current.description),
});

export const gapSnapshot = (gap: CaptionProject["audioDescriptionGaps"][string]) => ({
  kind: "AudioDescriptionGap" as const,
  gapId: gap.gapId,
  gapRevision: gap.gapRevision,
  state: gap.state,
  startMs: gap.startMs,
  endMs: gap.endMs,
});

export const validCaptionText = z.string().trim().min(1).max(MAX_CAPTION_TEXT_LENGTH);
export const validAudioDescriptionText = z.string().trim().min(1).max(MAX_AD_DESCRIPTION_LENGTH);
export const validSpeaker = z.string().trim().min(1).max(MAX_SPEAKER_NAME_LENGTH).nullable().optional();
export const validIdentifier = identifier;
export const validMediaTime = mediaTime;
export const validPositiveInteger = positiveInteger;
