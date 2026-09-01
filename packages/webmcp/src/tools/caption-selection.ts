import { z } from "zod";
import { strictToolDataSchema, type CueBenchTool, type ToolExecutionClient } from "../types";
import { toolSuccess } from "../tool-result";
import {
  CaptionSelectionInputSchema,
  CaptionSnapshotSchema,
  MAX_WEBMCP_EVIDENCE_ITEMS,
  commonJsonProperties,
  jsonObjectSchema,
  validCaptionText,
  validIdentifier,
  validMediaTime,
  validSpeaker,
  type CueBenchWebMcpRuntime,
} from "./schemas";
import {
  executeVisibleCommand,
  invalidToolInput,
  isToolError,
  resultForCommand,
  verificationFor,
} from "./helpers";
import {
  captionEvidence,
  captionSelectionContext,
  confirmEditableItems,
  invalidTimingChange,
  selectionNextActions,
} from "./selection";

export const CAPTION_SELECTION_TOOL_NAMES = [
  "inspect_selected_cue_evidence",
  "adjust_selected_cue_timing",
  "split_selected_cue",
  "merge_selected_cue",
  "revise_selected_cue",
  "mark_selected_cue_agent_ready",
] as const;

const evidenceData = strictToolDataSchema({
  cue: CaptionSnapshotSchema,
  evidence: z.array(z.object({
    evidenceId: validIdentifier,
    startMs: validMediaTime,
    endMs: validMediaTime,
    textPreview: z.string().max(240),
    speaker: z.string().trim().min(1).max(200).nullable(),
    uncertaintyCount: z.number().int().nonnegative().max(128),
  }).strict()).max(MAX_WEBMCP_EVIDENCE_ITEMS),
});

const cueData = strictToolDataSchema({ cue: CaptionSnapshotSchema });
const splitData = strictToolDataSchema({
  cue: CaptionSnapshotSchema,
  createdCue: CaptionSnapshotSchema,
});
const mergeData = strictToolDataSchema({
  cue: CaptionSnapshotSchema,
  mergedCueId: validIdentifier,
});

const expectedInput = CaptionSelectionInputSchema;
const timingInput = CaptionSelectionInputSchema.extend({
  edge: z.enum(["start", "end", "both"]),
  deltaMs: z.number().int().min(-60_000).max(60_000).refine((value) => value !== 0),
}).strict();
const splitInput = CaptionSelectionInputSchema.extend({
  atMs: validMediaTime,
}).strict();
const mergeInput = CaptionSelectionInputSchema.extend({
  withCueId: validIdentifier,
  expectedWithCueRevision: z.number().int().positive(),
}).strict();
const reviseInput = CaptionSelectionInputSchema.extend({
  text: validCaptionText.optional(),
  speaker: validSpeaker,
}).strict().refine((value) => value.text !== undefined || value.speaker !== undefined, {
  message: "A cue revision must change text or speaker.",
});

const selectedJson = {
  expectedProjectRevision: commonJsonProperties.expectedProjectRevision,
  expectedSelectionId: commonJsonProperties.expectedSelectionId,
  expectedSelectionRevision: commonJsonProperties.expectedSelectionRevision,
  expectedItemRevision: commonJsonProperties.expectedItemRevision,
} as const;
const tool = (input: CueBenchTool): CueBenchTool => input;
const untrustedContent = { untrustedContentHint: true } as const;

export const createCaptionSelectionTools = (runtime: CueBenchWebMcpRuntime): readonly CueBenchTool[] => [
  tool({
    name: "inspect_selected_cue_evidence",
    description: "Inspect bounded retained word evidence for the currently selected caption cue revision.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: evidenceData,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: (input) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Cue evidence inspection requires the current selected cue and all expected revisions.");
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      return toolSuccess({
        projectRevision: context.project.projectRevision,
        data: { cue: { kind: "CaptionCue", itemId: context.item.itemId, itemRevision: context.item.current.itemRevision, state: context.item.current.state, startMs: context.item.current.startMs, endMs: context.item.current.endMs, textPreview: context.item.current.text.length <= 240 ? context.item.current.text : `${context.item.current.text.slice(0, 239)}…`, speaker: context.item.current.speaker }, evidence: captionEvidence(context.project, context.item) },
        nextActions: ["adjust_selected_cue_timing", "revise_selected_cue", "mark_selected_cue_agent_ready"],
        ...verificationFor(runtime, context.project),
      });
    },
  }),
  tool({
    name: "adjust_selected_cue_timing",
    description: "Move the selected cue start, end, or both edges by an integer millisecond delta. CueBench performs the timestamp math.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      edge: { enum: ["start", "end", "both"] },
      deltaMs: { type: "integer", minimum: -60_000, maximum: 60_000, not: { const: 0 } },
    }, ["contractVersion", ...Object.keys(selectedJson), "edge", "deltaMs"]),
    resultDataSchema: cueData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = timingInput.safeParse(input);
      if (!parsed.success) return invalidTimingChange();
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const confirmation = await confirmEditableItems(runtime, [context.item], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const startDeltaMs = parsed.data.edge === "end" ? 0 : parsed.data.deltaMs;
      const endDeltaMs = parsed.data.edge === "start" ? 0 : parsed.data.deltaMs;
      const result = await executeVisibleCommand(runtime, {
        type: "AdjustCueTiming",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        cueId: context.item.itemId,
        startDeltaMs,
        endDeltaMs,
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const cue = result.project.captions.items[context.item.itemId];
      return resultForCommand(runtime, context.project, result, {
        cue: cue === undefined ? { kind: "CaptionCue", itemId: context.item.itemId, itemRevision: context.item.current.itemRevision, state: context.item.current.state, startMs: context.item.current.startMs, endMs: context.item.current.endMs, textPreview: context.item.current.text, speaker: context.item.current.speaker } : {
          kind: "CaptionCue", itemId: cue.itemId, itemRevision: cue.current.itemRevision, state: cue.current.state, startMs: cue.current.startMs, endMs: cue.current.endMs, textPreview: cue.current.text.length <= 240 ? cue.current.text : `${cue.current.text.slice(0, 239)}…`, speaker: cue.current.speaker,
        },
      }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "split_selected_cue",
    description: "Split the selected caption cue at one explicit millisecond boundary and keep both resulting cue revisions visible.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      atMs: { type: "integer", minimum: 0 },
    }, ["contractVersion", ...Object.keys(selectedJson), "atMs"]),
    resultDataSchema: splitData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = splitInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Cue splitting requires one integer point inside the selected current cue.");
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const confirmation = await confirmEditableItems(runtime, [context.item], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const newCueId = runtime.createOpaqueId?.("cue") ?? `${context.item.itemId}-split-${context.item.current.itemRevision + 1}`;
      const result = await executeVisibleCommand(runtime, {
        type: "SplitCue",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        cueId: context.item.itemId,
        splitMs: parsed.data.atMs,
        newCueId,
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const cue = result.project.captions.items[context.item.itemId];
      const createdCue = result.project.captions.items[newCueId];
      const fallback = (item: typeof context.item) => ({ kind: "CaptionCue" as const, itemId: item.itemId, itemRevision: item.current.itemRevision, state: item.current.state, startMs: item.current.startMs, endMs: item.current.endMs, textPreview: item.current.text.length <= 240 ? item.current.text : `${item.current.text.slice(0, 239)}…`, speaker: item.current.speaker });
      return resultForCommand(runtime, context.project, result, {
        cue: cue === undefined ? fallback(context.item) : fallback(cue),
        createdCue: createdCue === undefined ? fallback(context.item) : fallback(createdCue),
      }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "merge_selected_cue",
    description: "Merge the selected caption cue with its current adjacent successor after verifying both exact revisions.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      withCueId: { type: "string", minLength: 1, maxLength: 200 },
      expectedWithCueRevision: { type: "integer", minimum: 1 },
    }, ["contractVersion", ...Object.keys(selectedJson), "withCueId", "expectedWithCueRevision"]),
    resultDataSchema: mergeData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = mergeInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Cue merging requires the adjacent cue id and its current revision.");
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const adjacent = context.project.captions.items[parsed.data.withCueId];
      if (adjacent === undefined || adjacent.mergedIntoItemId !== null || adjacent.current.itemRevision !== parsed.data.expectedWithCueRevision) {
        return invalidToolInput("The merge target must be the current adjacent live cue at the supplied revision.");
      }
      const confirmation = await confirmEditableItems(runtime, [context.item, adjacent], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const result = await executeVisibleCommand(runtime, {
        type: "MergeCue",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        cueId: context.item.itemId,
        adjacentCueId: adjacent.itemId,
        expectedItemRevision: context.item.current.itemRevision,
        expectedAdjacentItemRevision: adjacent.current.itemRevision,
        ...(confirmation.confirmedSustainedReopen ? { confirmedSustainedReopen: true } : {}),
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const cue = result.project.captions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, {
        cue: { kind: "CaptionCue", itemId: cue.itemId, itemRevision: cue.current.itemRevision, state: cue.current.state, startMs: cue.current.startMs, endMs: cue.current.endMs, textPreview: cue.current.text.length <= 240 ? cue.current.text : `${cue.current.text.slice(0, 239)}…`, speaker: cue.current.speaker },
        mergedCueId: adjacent.itemId,
      }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "revise_selected_cue",
    description: "Create a new Proposed revision of the selected caption text or speaker after Human confirmation when replacing a proposal or reopening Sustained work.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      text: { type: "string", minLength: 1, maxLength: 1_000 },
      speaker: { type: ["string", "null"], minLength: 1, maxLength: 200 },
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: cueData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = reviseInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Cue revision requires bounded caption text or a speaker value.");
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const confirmation = await confirmEditableItems(runtime, [context.item], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const result = await executeVisibleCommand(runtime, {
        type: "ReviseCue",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        cueId: context.item.itemId,
        patch: {
          ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
          ...(parsed.data.speaker === undefined ? {} : { speaker: parsed.data.speaker }),
        },
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const cue = result.project.captions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, {
        cue: { kind: "CaptionCue", itemId: cue.itemId, itemRevision: cue.current.itemRevision, state: cue.current.state, startMs: cue.current.startMs, endMs: cue.current.endMs, textPreview: cue.current.text.length <= 240 ? cue.current.text : `${cue.current.text.slice(0, 239)}…`, speaker: cue.current.speaker },
      }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "mark_selected_cue_agent_ready",
    description: "Mark only the Browser Agent's own selected Proposed caption revision Agent Ready for Human review. This is not a ruling or certification.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: cueData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Agent-ready marking requires the current selected cue and all expected revisions.");
      const context = captionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const result = await executeVisibleCommand(runtime, {
        type: "MarkItemAgentReady",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const cue = result.project.captions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, {
        cue: { kind: "CaptionCue", itemId: cue.itemId, itemRevision: cue.current.itemRevision, state: cue.current.state, startMs: cue.current.startMs, endMs: cue.current.endMs, textPreview: cue.current.text.length <= 240 ? cue.current.text : `${cue.current.text.slice(0, 239)}…`, speaker: cue.current.speaker },
      }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
];
