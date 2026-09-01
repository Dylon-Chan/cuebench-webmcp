import { z } from "zod";
import { toolSuccess } from "../tool-result";
import { strictToolDataSchema, type CueBenchTool, type ToolExecutionClient } from "../types";
import {
  AudioDescriptionSnapshotSchema,
  GapSelectionInputSchema,
  GapSnapshotSchema,
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
  resultForCommand,
  verificationFor,
} from "./helpers";
import {
  gapEvidence,
  gapSelectionContext,
  selectionNextActions,
} from "./selection";

export const GAP_SELECTION_TOOL_NAMES = [
  "inspect_selected_gap_evidence",
  "propose_ad_beat_in_gap",
] as const;

const gapEvidenceData = strictToolDataSchema({
  gap: GapSnapshotSchema,
  evidence: z.object({
    startMs: validMediaTime,
    endMs: validMediaTime,
    captionContext: z.array(z.object({
      itemId: validIdentifier,
      itemRevision: z.number().int().positive(),
      startMs: validMediaTime,
      endMs: validMediaTime,
      textPreview: z.string().max(240),
    }).strict()).max(MAX_WEBMCP_EVIDENCE_ITEMS),
  }).strict(),
});

const proposedBeatData = strictToolDataSchema({
  beat: AudioDescriptionSnapshotSchema,
  consumedGapId: validIdentifier,
});

const expectedInput = GapSelectionInputSchema;
const proposeInput = GapSelectionInputSchema.extend({
  startMs: validMediaTime,
  endMs: validMediaTime,
  description: validAudioDescriptionText,
}).strict().superRefine((value, context) => {
  if (value.endMs <= value.startMs) {
    context.addIssue({ code: "custom", path: ["endMs"], message: "An audio-description beat must end after it starts." });
  }
});

const selectedJson = {
  expectedProjectRevision: commonJsonProperties.expectedProjectRevision,
  expectedSelectionId: commonJsonProperties.expectedSelectionId,
  expectedSelectionRevision: commonJsonProperties.expectedSelectionRevision,
  expectedGapRevision: commonJsonProperties.expectedGapRevision,
} as const;
const gapSnapshot = (gap: { readonly gapId: string; readonly gapRevision: number; readonly state: "Available" | "Consumed"; readonly startMs: number; readonly endMs: number }) => ({
  kind: "AudioDescriptionGap" as const,
  gapId: gap.gapId,
  gapRevision: gap.gapRevision,
  state: gap.state,
  startMs: gap.startMs,
  endMs: gap.endMs,
});
const beatSnapshot = (beat: { readonly itemId: string; readonly current: { readonly itemRevision: number; readonly state: "Proposed" | "AgentReady" | "Objected" | "Sustained"; readonly startMs: number; readonly endMs: number; readonly description: string } }) => ({
  kind: "AudioDescriptionBeat" as const,
  itemId: beat.itemId,
  itemRevision: beat.current.itemRevision,
  state: beat.current.state,
  startMs: beat.current.startMs,
  endMs: beat.current.endMs,
  descriptionPreview: beat.current.description.length <= 240 ? beat.current.description : `${beat.current.description.slice(0, 239)}…`,
});
const tool = (input: CueBenchTool): CueBenchTool => input;
const untrustedContent = { untrustedContentHint: true } as const;

export const createGapSelectionTools = (runtime: CueBenchWebMcpRuntime): readonly CueBenchTool[] => [
  tool({
    name: "inspect_selected_gap_evidence",
    description: "Inspect the selected available audio-description gap and its bounded overlapping caption context before proposing a beat.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
    }, ["contractVersion", ...Object.keys(selectedJson)]),
    resultDataSchema: gapEvidenceData,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: (input) => {
      const parsed = expectedInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Gap evidence inspection requires the current available gap and all expected revisions.");
      const context = gapSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      return toolSuccess({
        projectRevision: context.project.projectRevision,
        data: { gap: gapSnapshot(context.gap), evidence: gapEvidence(context.project, context.gap) },
        nextActions: ["propose_ad_beat_in_gap"],
        ...verificationFor(runtime, context.project),
      });
    },
  }),
  tool({
    name: "propose_ad_beat_in_gap",
    description: "Propose one bounded audio-description beat inside the selected currently available gap. It remains Proposed for Human review.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      ...selectedJson,
      startMs: { type: "integer", minimum: 0 },
      endMs: { type: "integer", minimum: 1 },
      description: { type: "string", minLength: 1, maxLength: 1_000 },
    }, ["contractVersion", ...Object.keys(selectedJson), "startMs", "endMs", "description"]),
    resultDataSchema: proposedBeatData,
    annotations: untrustedContent,
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = proposeInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Audio-description proposals require bounded text and a non-empty interval inside the selected gap.");
      const context = gapSelectionContext(runtime, parsed.data);
      if (isToolError(context)) return context;
      const beatId = runtime.createOpaqueId?.("ad") ?? `${context.gap.gapId}-ad-${context.gap.gapRevision}`;
      const result = await executeVisibleCommand(runtime, {
        type: "ProposeAudioDescriptionInGap",
        actor: runtime.browserAgent,
        gapId: context.gap.gapId,
        expectedSelectionId: context.gap.gapId,
        expectedGapRevision: context.gap.gapRevision,
        beatId,
        startMs: parsed.data.startMs,
        endMs: parsed.data.endMs,
        description: parsed.data.description,
        expectedProjectRevision: context.project.projectRevision,
      }, client, { revealSelection: true });
      const beat = result.project.audioDescriptions.items[beatId];
      const fallback = {
        itemId: beatId,
        current: {
          itemRevision: 1,
          state: "Proposed" as const,
          startMs: parsed.data.startMs,
          endMs: parsed.data.endMs,
          description: parsed.data.description,
        },
      };
      return resultForCommand(runtime, context.project, result, {
        beat: beatSnapshot(beat ?? fallback),
        consumedGapId: context.gap.gapId,
      }, selectionNextActions(result.project), beatId);
    },
  }),
];
