import { domainError } from "@cuebench/domain";
import { z } from "zod";
import { ToolExecutionAbortedError, ToolVisibleStateError, toolDomainError, toolSuccess } from "../tool-result";
import { strictToolDataSchema, type CueBenchTool, type ToolExecutionClient } from "../types";
import {
  AudioDescriptionSelectionInputSchema,
  AudioDescriptionSnapshotSchema,
  MAX_WEBMCP_EVIDENCE_ITEMS,
  commonJsonProperties,
  jsonObjectSchema,
  validAudioDescriptionText,
  validIdentifier,
  validMediaTime,
  type CueBenchWebMcpRuntime,
} from "./schemas";
import {
  executeVisibleCommand,
  invalidToolInput,
  isToolError,
  projectUnavailable,
  resultForCommand,
  verificationFor,
} from "./helpers";
import {
  audioDescriptionEvidence,
  audioDescriptionSelectionContext,
  confirmEditableItems,
  invalidTimingChange,
  selectionNextActions,
} from "./selection";

export const AUDIO_DESCRIPTION_SELECTION_TOOL_NAMES = [
  "inspect_selected_ad_evidence",
  "adjust_selected_ad_timing",
  "revise_selected_ad_beat",
  "preview_selected_narration",
  "mark_selected_ad_agent_ready",
] as const;

const evidenceData = strictToolDataSchema({
  beat: AudioDescriptionSnapshotSchema,
  evidence: z.array(z.object({
    evidenceId: validIdentifier,
    atMs: validMediaTime,
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
    mimeType: z.string().trim().min(1).max(200),
  }).strict()).max(MAX_WEBMCP_EVIDENCE_ITEMS),
});
const beatData = strictToolDataSchema({ beat: AudioDescriptionSnapshotSchema });
const previewData = strictToolDataSchema({
  preview: z.object({
    cacheKey: validIdentifier,
    measuredDurationMs: z.number().int().positive(),
    source: z.enum(["cache", "fresh"]),
    previewVisible: z.literal(true),
  }).strict(),
});

const expectedInput = AudioDescriptionSelectionInputSchema;
const timingInput = AudioDescriptionSelectionInputSchema.extend({
  edge: z.enum(["start", "end", "both"]),
  deltaMs: z.number().int().min(-60_000).max(60_000).refine((value) => value !== 0),
}).strict();
const reviseInput = AudioDescriptionSelectionInputSchema.extend({
  description: validAudioDescriptionText,
}).strict();

const selectedJson = {
  expectedProjectRevision: commonJsonProperties.expectedProjectRevision,
  expectedSelectionId: commonJsonProperties.expectedSelectionId,
  expectedSelectionRevision: commonJsonProperties.expectedSelectionRevision,
  expectedItemRevision: commonJsonProperties.expectedItemRevision,
} as const;
const snapshot = (item: { readonly itemId: string; readonly current: { readonly itemRevision: number; readonly state: "Proposed" | "AgentReady" | "Objected" | "Sustained"; readonly startMs: number; readonly endMs: number; readonly description: string } }) => ({
  kind: "AudioDescriptionBeat" as const,
  itemId: item.itemId,
  itemRevision: item.current.itemRevision,
  state: item.current.state,
  startMs: item.current.startMs,
  endMs: item.current.endMs,
  descriptionPreview: item.current.description.length <= 240 ? item.current.description : `${item.current.description.slice(0, 239)}…`,
});
const tool = (input: CueBenchTool): CueBenchTool => input;
const untrustedContent = { untrustedContentHint: true } as const;

export const createAudioDescriptionSelectionTools = (runtime: CueBenchWebMcpRuntime): readonly CueBenchTool[] => [
  tool({
    name: "inspect_selected_ad_evidence",
    description: "Inspect bounded retained visual frame evidence for the currently selected audio-description beat revision.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: evidenceData,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: (input) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Audio-description evidence inspection requires the current selected beat and all expected revisions.");
      const context = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      return toolSuccess({
        projectRevision: context.project.projectRevision,
        data: { beat: snapshot(context.item), evidence: audioDescriptionEvidence(context.project, context.item) },
        nextActions: ["adjust_selected_ad_timing", "revise_selected_ad_beat", "preview_selected_narration", "mark_selected_ad_agent_ready"],
        ...verificationFor(runtime, context.project),
      });
    },
  }),
  tool({
    name: "adjust_selected_ad_timing",
    description: "Move the selected audio-description start, end, or both edges by an integer millisecond delta. CueBench performs the timestamp math.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      edge: { enum: ["start", "end", "both"] },
      deltaMs: { type: "integer", minimum: -60_000, maximum: 60_000, not: { const: 0 } },
    }, ["contractVersion", ...Object.keys(selectedJson), "edge", "deltaMs"]),
    resultDataSchema: beatData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = timingInput.safeParse(input);
      if (!parsed.success) return invalidTimingChange();
      const context = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const confirmation = await confirmEditableItems(runtime, [context.item], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const result = await executeVisibleCommand(runtime, {
        type: "AdjustAudioDescriptionTiming",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        beatId: context.item.itemId,
        startDeltaMs: parsed.data.edge === "end" ? 0 : parsed.data.deltaMs,
        endDeltaMs: parsed.data.edge === "start" ? 0 : parsed.data.deltaMs,
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const beat = result.project.audioDescriptions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, { beat: snapshot(beat) }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "revise_selected_ad_beat",
    description: "Create a new Proposed revision of the selected audio-description beat after Human confirmation when replacing a proposal or reopening Sustained work.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      description: { type: "string", minLength: 1, maxLength: 1_000 },
    }, ["contractVersion", ...Object.keys(selectedJson), "description"]),
    resultDataSchema: beatData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = reviseInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Audio-description revision requires bounded description text and the current selection revisions.");
      const context = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const confirmation = await confirmEditableItems(runtime, [context.item], client.signal);
      if (isToolError(confirmation)) return confirmation;
      const result = await executeVisibleCommand(runtime, {
        type: "ReviseAudioDescription",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        beatId: context.item.itemId,
        patch: { description: parsed.data.description },
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const beat = result.project.audioDescriptions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, { beat: snapshot(beat) }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
  tool({
    name: "preview_selected_narration",
    description: "Prepare and visibly preview narration for the selected audio-description beat without changing its text, timing, state, or certification.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: previewData,
    // It does not alter caption evidence, but a hosted TTS request can spend
    // quota and a fresh result is cached in browser storage. Do not label it
    // read-only to the Browser Agent.
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Narration preview requires the current selected beat and all expected revisions.");
      const context = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      if (runtime.previewNarration === undefined) return invalidToolInput("Narration preview is not available in this page session.");
      let preview;
      let committed = false;
      try {
        preview = await runtime.previewNarration({
          project: context.project,
          beatId: context.item.itemId,
          itemRevision: context.item.current.itemRevision,
          signal: client.signal,
          onCommitted: () => {
            committed = true;
            client.markCommitted();
          },
        });
      } catch (error) {
        if (client.signal.aborted || error instanceof ToolExecutionAbortedError) throw new ToolExecutionAbortedError();
        if (error instanceof ToolVisibleStateError) {
          return toolDomainError(domainError(
            "STALE_PROJECT",
            "CueBench could not verify the visible project instance before narration preview could continue. Inspect the project and retry.",
          ), {
            changed: committed,
            retryable: true,
            nextActions: ["inspect_project", "inspect_selected_ad_evidence"],
          });
        }
        if (committed) {
          return toolDomainError(domainError(
            "GENERATION_STAGE_FAILED",
            "CueBench started a narration-preview side effect but could not complete visible playback. Inspect this selected beat before retrying.",
          ), {
            changed: true,
            retryable: true,
            nextActions: ["inspect_selected_ad_evidence", "inspect_project"],
          });
        }
        return invalidToolInput("CueBench could not prepare a visible narration preview for this selected beat.");
      }
      if (client.signal.aborted) throw new ToolExecutionAbortedError();
      // Re-evaluate the exact selected beat after asynchronous cache/network
      // work. A preview must never be published for a superseded selection.
      const currentContext = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(currentContext)) return currentContext;
      await runtime.afterVisibleChange();
      const current = runtime.getProject();
      if (current === null) return projectUnavailable();
      return toolSuccess({
        projectRevision: current.projectRevision,
        data: {
          preview: {
            cacheKey: preview.cacheKey,
            measuredDurationMs: preview.measuredDurationMs,
            source: preview.source,
            previewVisible: true,
          },
        },
        nextActions: ["inspect_selected_ad_evidence", "revise_selected_ad_beat"],
        ...verificationFor(runtime, current),
      });
    },
  }),
  tool({
    name: "mark_selected_ad_agent_ready",
    description: "Mark only the Browser Agent's own selected Proposed audio-description revision Agent Ready for Human review. This is not a ruling or certification.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: beatData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Agent-ready marking requires the current selected audio-description beat and all expected revisions.");
      const context = audioDescriptionSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const result = await executeVisibleCommand(runtime, {
        type: "MarkItemAgentReady",
        actor: runtime.browserAgent,
        itemId: context.item.itemId,
        expectedItemRevision: context.item.current.itemRevision,
        expectedSelectionId: context.item.itemId,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const beat = result.project.audioDescriptions.items[context.item.itemId] ?? context.item;
      return resultForCommand(runtime, context.project, result, { beat: snapshot(beat) }, selectionNextActions(result.project), context.item.itemId);
    },
  }),
];
