import {
  canonicalTrackFormat,
  domainError,
  prepareCertificationReview,
  type CaptionProject,
  type QualityFinding,
} from "@cuebench/domain";
import { z } from "zod";
import { ToolExecutionAbortedError, ToolVisibleStateError, toolDomainError, toolSuccess } from "../tool-result";
import { strictToolDataSchema, type CueBenchTool } from "../types";
import {
  AudioDescriptionSnapshotSchema,
  CaptionSnapshotSchema,
  DEFAULT_WEBMCP_PAGE_SIZE,
  ExpectedProjectRevisionInputSchema,
  FindingSnapshotSchema,
  GapSnapshotSchema,
  MAX_WEBMCP_FINDINGS_PER_PAGE,
  MAX_WEBMCP_PAGE_SIZE,
  MAX_WEBMCP_TIMELINE_WINDOW_MS,
  PageSchema,
  ProfilePatchSchema,
  ProfilePatchJsonSchema,
  SelectedSnapshotSchema,
  audioDescriptionSnapshot,
  captionSnapshot,
  changedPathsForPatch,
  commonJsonProperties,
  createPage,
  currentSelection,
  findingSnapshot,
  gapSnapshot,
  jsonObjectSchema,
  pageInputSchema,
  parseOffsetCursor,
  resolveProfilePatch,
  safeTextPreview,
  validIdentifier,
  validMediaTime,
  validPositiveInteger,
  type CueBenchWebMcpRuntime,
} from "./schemas";
import {
  executeVisibleCommand,
  invalidToolInput,
  projectAtExpectedRevision,
  projectUnavailable,
  resultForCommand,
  verificationFor,
} from "./helpers";

export const ALWAYS_TOOL_NAMES = [
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
] as const;

const contractJson = commonJsonProperties.contractVersion;
const expectedProjectJson = commonJsonProperties.expectedProjectRevision;

const selectionDataSchema = z.object({
  selection: SelectedSnapshotSchema,
}).strict();

const projectInspectionData = strictToolDataSchema({
  project: z.object({
    projectId: validIdentifier,
    title: z.string().trim().min(1).max(1_000),
    projectRevision: validPositiveInteger,
    media: z.object({
      sourceId: validIdentifier,
      sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
      durationMs: validMediaTime,
      relinkState: z.enum(["Linked", "Missing", "TemporarySession"]),
    }).strict(),
    captions: z.object({
      kind: z.literal("Captions"),
      items: z.array(CaptionSnapshotSchema).max(MAX_WEBMCP_PAGE_SIZE),
      page: PageSchema,
    }).strict(),
    audioDescriptions: z.object({
      kind: z.literal("AudioDescriptions"),
      items: z.array(AudioDescriptionSnapshotSchema).max(MAX_WEBMCP_PAGE_SIZE),
      page: PageSchema,
    }).strict(),
    selectedItem: SelectedSnapshotSchema,
    validation: z.object({
      status: z.enum(["NotRun", "Current", "Stale"]),
      blockerCount: z.number().int().nonnegative(),
      warningCount: z.number().int().nonnegative(),
    }).strict(),
    certification: z.discriminatedUnion("status", [
      z.object({ status: z.literal("NotCertified") }).strict(),
      z.object({ status: z.literal("Current"), certificationId: validIdentifier }).strict(),
      z.object({ status: z.literal("Stale"), certificationId: validIdentifier }).strict(),
    ]),
    activeGenerationRun: z.object({
      runId: validIdentifier,
      targetTrack: z.enum(["Captions", "AudioDescriptions"]),
    }).strict().nullable(),
  }).strict(),
});

const timelineEntrySchema = z.union([
  CaptionSnapshotSchema,
  AudioDescriptionSnapshotSchema,
  GapSnapshotSchema,
  z.object({
    kind: z.literal("Evidence"),
    evidenceId: validIdentifier,
    startMs: validMediaTime,
    endMs: validMediaTime,
    itemId: validIdentifier.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("Finding"),
    findingId: validIdentifier,
    severity: z.enum(["blocker", "warning"]),
    startMs: validMediaTime,
    endMs: validMediaTime,
    messagePreview: z.string().max(240),
  }).strict(),
]);

const timelineInspectionData = strictToolDataSchema({
  window: z.object({
    startMs: validMediaTime,
    endMs: validMediaTime,
  }).strict(),
  entries: z.array(timelineEntrySchema).max(MAX_WEBMCP_PAGE_SIZE),
  page: PageSchema,
});

const findingListData = strictToolDataSchema({
  findings: z.array(FindingSnapshotSchema).max(MAX_WEBMCP_FINDINGS_PER_PAGE),
  page: PageSchema,
  validationStatus: z.enum(["NotRun", "Current", "Stale"]),
});

const focusFindingData = strictToolDataSchema({
  finding: FindingSnapshotSchema,
  ...selectionDataSchema.shape,
});

const generationStartData = strictToolDataSchema({
  run: z.object({
    runId: validIdentifier,
    targetTrack: z.enum(["Captions", "AudioDescriptions"]),
    stage: z.string().trim().min(1).max(100),
    progress: z.number().min(0).max(1).nullable(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(20),
    retryable: z.boolean().nullable(),
    code: z.string().trim().min(1).max(100).nullable(),
    receiptState: z.enum(["available", "missing", "expired"]),
  }).strict(),
});

const validationData = strictToolDataSchema({
  validation: z.object({
    status: z.enum(["NotRun", "Current", "Stale"]),
    blockerCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }).strict(),
});

const exportData = strictToolDataSchema({
  export: z.object({
    filename: z.string().trim().min(1).max(500),
    trackKind: z.enum(["Captions", "AudioDescriptions"]),
    format: z.enum(["vtt", "srt", "ad-txt"]),
    disposition: z.enum(["draft", "certified"]),
    itemCount: z.number().int().nonnegative(),
    serializedTextHash: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
    published: z.literal(true),
  }).strict(),
});

const profileProposalData = strictToolDataSchema({
  proposal: z.object({
    proposalId: validIdentifier,
    baseProfileRevision: validPositiveInteger,
    changedPaths: z.array(z.string().trim().min(1).max(300)).min(1).max(64),
    reviewRequired: z.literal(true),
  }).strict(),
});

const certificationReadinessData = strictToolDataSchema({
  readiness: z.object({
    readinessHash: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
    canCertify: z.boolean(),
    blockerCount: z.number().int().nonnegative(),
    unwaivedWarningCount: z.number().int().nonnegative(),
    staleValidationCauseCodes: z.array(z.string().trim().min(1).max(100)).max(16),
    itemStateCounts: z.object({
      Proposed: z.number().int().nonnegative(),
      AgentReady: z.number().int().nonnegative(),
      Objected: z.number().int().nonnegative(),
      Sustained: z.number().int().nonnegative(),
    }).strict(),
    blockers: z.array(FindingSnapshotSchema).max(24),
    unwaivedWarnings: z.array(FindingSnapshotSchema).max(24),
  }).strict(),
});

const inspectProjectInput = z.object({
  contractVersion: z.literal(1),
  captionCursor: z.string().trim().min(1).max(256).nullable().optional().default(null),
  audioDescriptionCursor: z.string().trim().min(1).max(256).nullable().optional().default(null),
  limit: z.number().int().min(1).max(MAX_WEBMCP_PAGE_SIZE).optional().default(DEFAULT_WEBMCP_PAGE_SIZE),
}).strict();

const timelineInput = pageInputSchema({
  contractVersion: z.literal(1),
  expectedProjectRevision: validPositiveInteger,
  startMs: validMediaTime,
  endMs: validMediaTime,
}).superRefine((value, context) => {
  if (value.endMs <= value.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "Timeline windows must end after they start." });
  if (value.endMs - value.startMs > MAX_WEBMCP_TIMELINE_WINDOW_MS) {
    context.addIssue({ code: "custom", path: ["endMs"], message: "Timeline windows may cover at most two minutes." });
  }
});

const findingListInput = pageInputSchema({
  contractVersion: z.literal(1),
  expectedProjectRevision: validPositiveInteger,
  severity: z.enum(["blocker", "warning"]).optional(),
}).superRefine((value, context) => {
  if (value.limit > MAX_WEBMCP_FINDINGS_PER_PAGE) {
    context.addIssue({ code: "custom", path: ["limit"], message: "Finding pages may contain at most 24 entries." });
  }
});

const focusFindingInput = ExpectedProjectRevisionInputSchema.extend({
  findingId: validIdentifier,
}).strict();

const generationStartInput = ExpectedProjectRevisionInputSchema;
const validateInput = ExpectedProjectRevisionInputSchema;

const exportInput = ExpectedProjectRevisionInputSchema.extend({
  trackKind: z.enum(["Captions", "AudioDescriptions"]),
  format: z.enum(["vtt", "srt", "ad-txt"]),
  disposition: z.enum(["draft", "certified"]),
}).strict();

const profilePatchInput = ExpectedProjectRevisionInputSchema.extend({
  profileId: validIdentifier,
  name: z.string().trim().min(1).max(1_000),
  rationale: z.string().trim().min(1).max(2_000),
  patch: ProfilePatchSchema,
}).strict();

const certificationReadinessInput = ExpectedProjectRevisionInputSchema;

/** These snapshots can include project titles, caption text, and finding prose. */
const readOnly = { readOnlyHint: true, untrustedContentHint: true } as const;
const untrustedContent = { untrustedContentHint: true } as const;

const isFailure = <T,>(value: T | ReturnType<typeof projectUnavailable>): value is ReturnType<typeof projectUnavailable> => (
  typeof value === "object" && value !== null && "ok" in value && value.ok === false
);

const pagedCaptions = (project: CaptionProject, offset: number, limit: number) => {
  const all = project.captions.order
    .map((itemId) => project.captions.items[itemId])
    .filter((item): item is NonNullable<typeof item> => item !== undefined && item.mergedIntoItemId === null)
    .map(captionSnapshot);
  return { items: all.slice(offset, offset + limit), page: createPage(all.length, offset, limit) };
};

const pagedAudioDescriptions = (project: CaptionProject, offset: number, limit: number) => {
  const all = project.audioDescriptions.order
    .map((itemId) => project.audioDescriptions.items[itemId])
    .filter((item): item is NonNullable<typeof item> => item !== undefined && item.supersededByRunId === null)
    .map(audioDescriptionSnapshot);
  return { items: all.slice(offset, offset + limit), page: createPage(all.length, offset, limit) };
};

const evidenceIntervals = (project: CaptionProject): readonly {
  readonly evidenceId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly itemId: string | null;
}[] => {
  const intervals: { evidenceId: string; startMs: number; endMs: number; itemId: string | null }[] = [];
  for (const entry of project.localEvidencePackages) {
    for (const binding of entry.cueBindings) {
      for (const evidenceId of binding.evidenceIds) {
        const word = entry.evidence.words.find((candidate) => candidate.evidenceId === evidenceId);
        if (word !== undefined) intervals.push({ evidenceId, startMs: word.startMs, endMs: word.endMs, itemId: binding.itemId });
      }
    }
  }
  for (const entry of project.localAudioDescriptionEvidencePackages) {
    for (const binding of entry.beatBindings) {
      for (const evidenceId of binding.evidenceIds) {
        const frame = entry.evidence.frames.find((candidate) => candidate.evidenceId === evidenceId);
        if (frame !== undefined) intervals.push({
          evidenceId,
          startMs: Math.max(0, frame.atMs - 1),
          endMs: Math.min(project.media.durationMs, frame.atMs + 1),
          itemId: binding.itemId,
        });
      }
    }
  }
  return intervals;
};

const findingInterval = (project: CaptionProject, finding: QualityFinding): { startMs: number; endMs: number } | null => {
  const ids = finding.target.type === "item"
    ? [finding.target.itemId]
    : finding.target.type === "pair"
      ? [finding.target.first.itemId, finding.target.second.itemId]
      : [];
  const items = ids.flatMap((id) => {
    const item = project.captions.items[id] ?? project.audioDescriptions.items[id];
    return item === undefined ? [] : [item];
  });
  if (items.length === 0) return null;
  return {
    startMs: Math.min(...items.map((item) => item.current.startMs)),
    endMs: Math.max(...items.map((item) => item.current.endMs)),
  };
};

const intersectsWindow = (startMs: number, endMs: number, windowStartMs: number, windowEndMs: number) => (
  startMs < windowEndMs && windowStartMs < endMs
);

const timelineEntries = (project: CaptionProject, startMs: number, endMs: number) => {
  const entries: Array<z.infer<typeof timelineEntrySchema>> = [];
  for (const item of Object.values(project.captions.items)) {
    if (item.mergedIntoItemId === null && intersectsWindow(item.current.startMs, item.current.endMs, startMs, endMs)) entries.push(captionSnapshot(item));
  }
  for (const item of Object.values(project.audioDescriptions.items)) {
    if (item.supersededByRunId === null && intersectsWindow(item.current.startMs, item.current.endMs, startMs, endMs)) entries.push(audioDescriptionSnapshot(item));
  }
  for (const gap of Object.values(project.audioDescriptionGaps)) {
    if (gap.state === "Available" && intersectsWindow(gap.startMs, gap.endMs, startMs, endMs)) entries.push(gapSnapshot(gap));
  }
  for (const evidence of evidenceIntervals(project)) {
    if (evidence.endMs > evidence.startMs && intersectsWindow(evidence.startMs, evidence.endMs, startMs, endMs)) {
      entries.push({ kind: "Evidence", ...evidence });
    }
  }
  for (const finding of project.validationRun?.findings ?? []) {
    const interval = findingInterval(project, finding);
    if (interval !== null && intersectsWindow(interval.startMs, interval.endMs, startMs, endMs)) {
      entries.push({ kind: "Finding", findingId: finding.findingId, severity: finding.severity, ...interval, messagePreview: safeTextPreview(finding.message) });
    }
  }
  const rank: Readonly<Record<z.infer<typeof timelineEntrySchema>["kind"], number>> = {
    CaptionCue: 0,
    AudioDescriptionBeat: 1,
    AudioDescriptionGap: 2,
    Evidence: 3,
    Finding: 4,
  };
  return entries.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || rank[left.kind] - rank[right.kind]);
};

const selectedFindingItem = (project: CaptionProject, finding: QualityFinding) => {
  const targetId = finding.target.type === "item"
    ? finding.target.itemId
    : finding.target.type === "pair"
      ? finding.target.first.itemId
      : null;
  if (targetId === null) return null;
  const item = project.captions.items[targetId] ?? project.audioDescriptions.items[targetId];
  if (item === undefined) return null;
  const expectedRevision = finding.target.type === "item"
    ? finding.target.itemRevision
    : finding.target.type === "pair"
      ? finding.target.first.itemRevision
      : null;
  if (expectedRevision === null) return null;
  return item.current.itemRevision === expectedRevision ? item : null;
};

const tool = (input: CueBenchTool): CueBenchTool => input;

export const createAlwaysTools = (runtime: CueBenchWebMcpRuntime): readonly CueBenchTool[] => [
  tool({
    name: "inspect_project",
    description: "Inspect the bounded visible CueBench project, tracks, selection, validation, certification, and run state.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      captionCursor: { type: ["string", "null"], maxLength: 256 },
      audioDescriptionCursor: { type: ["string", "null"], maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: MAX_WEBMCP_PAGE_SIZE },
    }, ["contractVersion"]),
    resultDataSchema: projectInspectionData,
    annotations: readOnly,
    execute: (input) => {
      const parsed = inspectProjectInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Inspect project requires a bounded cursor and page limit.");
      const project = runtime.getProject();
      if (project === null) return projectUnavailable();
      const captionOffset = parseOffsetCursor(parsed.data.captionCursor);
      const adOffset = parseOffsetCursor(parsed.data.audioDescriptionCursor);
      if (captionOffset === null || adOffset === null) return invalidToolInput("Project cursors must be non-negative decimal offsets.");
      const captions = pagedCaptions(project, captionOffset, parsed.data.limit);
      const audioDescriptions = pagedAudioDescriptions(project, adOffset, parsed.data.limit);
      if (captionOffset > captions.page.totalCount || adOffset > audioDescriptions.page.totalCount) {
        return invalidToolInput("The requested project cursor is outside the current bounded track.");
      }
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: {
          project: {
            projectId: project.projectId,
            title: project.title,
            projectRevision: project.projectRevision,
            media: project.media,
            captions: { kind: "Captions" as const, ...captions },
            audioDescriptions: { kind: "AudioDescriptions" as const, ...audioDescriptions },
            selectedItem: currentSelection(project),
            validation: project.validation,
            certification: project.certification,
            activeGenerationRun: project.activeGenerationRun === null ? null : {
              runId: project.activeGenerationRun.runId,
              targetTrack: project.activeGenerationRun.targetTrack,
            },
          },
        },
        nextActions: ["inspect_timeline_window", "list_quality_findings"],
        ...verificationFor(runtime, project),
      });
    },
  }),
  tool({
    name: "inspect_timeline_window",
    description: "Inspect one bounded, paginated time window of the currently visible caption, AD, gap, evidence, and finding timeline.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
      startMs: { type: "integer", minimum: 0 },
      endMs: { type: "integer", minimum: 1 },
      cursor: { type: ["string", "null"], maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: MAX_WEBMCP_PAGE_SIZE },
    }, ["contractVersion", "expectedProjectRevision", "startMs", "endMs"]),
    resultDataSchema: timelineInspectionData,
    annotations: readOnly,
    execute: (input) => {
      const parsed = timelineInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Timeline inspection needs a non-empty window of at most two minutes and a bounded page.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      if (parsed.data.endMs > project.media.durationMs) return invalidToolInput("The requested timeline window exceeds this source media.");
      const offset = parseOffsetCursor(parsed.data.cursor);
      if (offset === null) return invalidToolInput("Timeline cursors must be non-negative decimal offsets.");
      const entries = timelineEntries(project, parsed.data.startMs, parsed.data.endMs);
      if (offset > entries.length) return invalidToolInput("The requested timeline cursor is outside this window.");
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: {
          window: { startMs: parsed.data.startMs, endMs: parsed.data.endMs },
          entries: entries.slice(offset, offset + parsed.data.limit),
          page: createPage(entries.length, offset, parsed.data.limit),
        },
        nextActions: ["focus_quality_finding", "inspect_project"],
        ...verificationFor(runtime, project),
      });
    },
  }),
  tool({
    name: "list_quality_findings",
    description: "List a bounded page of current deterministic blockers or warnings without making a human ruling.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
      severity: { enum: ["blocker", "warning"] },
      cursor: { type: ["string", "null"], maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: MAX_WEBMCP_FINDINGS_PER_PAGE },
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: findingListData,
    annotations: readOnly,
    execute: (input) => {
      const parsed = findingListInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Finding inspection needs a bounded page and optional blocker or warning filter.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      const offset = parseOffsetCursor(parsed.data.cursor);
      if (offset === null) return invalidToolInput("Finding cursors must be non-negative decimal offsets.");
      const all = (project.validationRun?.findings ?? [])
        .filter((finding) => parsed.data.severity === undefined || finding.severity === parsed.data.severity)
        .map(findingSnapshot);
      if (offset > all.length) return invalidToolInput("The requested finding cursor is outside the current result.");
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: {
          findings: all.slice(offset, offset + parsed.data.limit),
          page: createPage(all.length, offset, parsed.data.limit),
          validationStatus: project.validation.status,
        },
        nextActions: all.length === 0 ? ["validate_project", "inspect_project"] : ["focus_quality_finding", "inspect_project"],
        ...verificationFor(runtime, project),
      });
    },
  }),
  tool({
    name: "focus_quality_finding",
    description: "Focus one item-bound quality finding on the visible timeline, seek the native video clock, reveal its evidence, and activate the applicable scoped tools.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
      findingId: { type: "string", minLength: 1, maxLength: 200 },
    }, ["contractVersion", "expectedProjectRevision", "findingId"]),
    resultDataSchema: focusFindingData,
    annotations: untrustedContent,
    execute: async (input, client) => {
      const parsed = focusFindingInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Finding focus requires the current project revision and a finding id.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      const finding = (project.validationRun?.findings ?? []).find((candidate) => candidate.findingId === parsed.data.findingId);
      if (finding === undefined) return toolDomainError(domainError("NOT_FOUND", "The requested finding is not part of the current validation run."));
      const item = selectedFindingItem(project, finding);
      if (item === null) return toolDomainError(domainError("INVALID_ARGUMENT", "This finding does not identify one current timeline item to focus."));
      // A Browser Agent must pass through the same visible save/discard/cancel
      // guard as a Human before it can replace the current persisted selection.
      // The guard deliberately leaves the old selected family registered while
      // its dialog is pending.
      if (runtime.prepareSelectionFocus !== undefined) {
        const allowed = await runtime.prepareSelectionFocus({
          kind: item.kind,
          selectionId: item.itemId,
          selectionRevision: item.current.itemRevision,
          playheadMs: item.current.startMs,
          signal: client.signal,
        });
        if (client.signal.aborted) return toolDomainError(domainError("STALE_SELECTION", "The Browser Agent focus request was cancelled before the visible selection changed."), { retryable: true });
        if (allowed === false) return toolDomainError(domainError("STALE_SELECTION", "The Human kept the current review draft; the visible selection did not change."), { retryable: true });
      }
      const selected = await executeVisibleCommand(runtime, {
        type: "SelectItem",
        actor: runtime.browserAgent,
        itemId: item.itemId,
        expectedItemRevision: item.current.itemRevision,
        expectedProjectRevision: project.projectRevision,
      }, client, { revealSelection: true });
      if (selected.error !== undefined) return toolDomainError(selected.error);
      const focusedItem = selected.project.captions.items[item.itemId] ?? selected.project.audioDescriptions.items[item.itemId];
      if (focusedItem === undefined) return toolDomainError(domainError("STALE_SELECTION", "The finding item is no longer available after selection."), { retryable: true });
      return toolSuccess({
        projectRevision: selected.project.projectRevision,
        data: { finding: findingSnapshot(finding), selection: currentSelection(selected.project) },
        nextActions: focusedItem.kind === "CaptionCue"
          ? ["inspect_selected_cue_evidence", "revise_selected_cue"]
          : ["inspect_selected_ad_evidence", "revise_selected_ad_beat"],
        ...verificationFor(runtime, selected.project, { changedItemId: null, before: project }),
      });
    },
  }),
  tool({
    name: "start_caption_generation",
    description: "Start one visible, recoverable CueBench AI caption generation run. It creates proposals only and never silently replaces Sustained work.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: generationStartData,
    annotations: untrustedContent,
    execute: async (input, client) => {
      const parsed = generationStartInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Caption generation requires the current project revision.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      if (runtime.startGeneration === undefined) return toolDomainError(domainError("INVALID_ARGUMENT", "Caption generation is not available in this page session."));
      let operation;
      let committed = false;
      try {
        operation = await runtime.startGeneration({
          project,
          targetTrack: "Captions",
          expectedProjectRevision: project.projectRevision,
          signal: client.signal,
          ...(client.postCommitSignal === undefined ? {} : { postCommitSignal: client.postCommitSignal }),
          onCommitted: () => { committed = true; client.markCommitted(); },
        });
      } catch (error) {
        if (error instanceof ToolExecutionAbortedError) throw error;
        if (error instanceof ToolVisibleStateError) {
          return toolDomainError(domainError(
            "STALE_PROJECT",
            "CueBench could not verify the visible Browser Agent tool state. Inspect the project and retry.",
          ), { changed: committed });
        }
        return toolDomainError(domainError(
          "INVALID_ARGUMENT",
          "Caption generation is not ready in this page. Complete the visible hosted-processing requirements and retry.",
        ), { changed: committed, nextActions: committed ? ["inspect_generation_run", "inspect_project"] : ["inspect_project"] });
      }
      if (operation.lifecycle !== "ready") client.markCommitted();
      await runtime.afterVisibleChange();
      const current = runtime.getProject();
      if (current === null) return projectUnavailable();
      return toolSuccess({
        projectRevision: current.projectRevision,
        data: { run: operation.run },
        nextActions: operation.lifecycle === "ready"
          ? ["inspect_generation_run", "cancel_generation_run"]
          : ["inspect_generation_run", "inspect_project"],
        ...verificationFor(runtime, current, { before: project }),
      });
    },
  }),
  tool({
    name: "start_ad_generation",
    description: "Start one visible, recoverable CueBench AI audio-description generation run after retained caption evidence exists.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: generationStartData,
    annotations: untrustedContent,
    execute: async (input, client) => {
      const parsed = generationStartInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Audio-description generation requires the current project revision.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      if (runtime.startGeneration === undefined) return toolDomainError(domainError("INVALID_ARGUMENT", "Audio-description generation is not available in this page session."));
      let operation;
      let committed = false;
      try {
        operation = await runtime.startGeneration({
          project,
          targetTrack: "AudioDescriptions",
          expectedProjectRevision: project.projectRevision,
          signal: client.signal,
          ...(client.postCommitSignal === undefined ? {} : { postCommitSignal: client.postCommitSignal }),
          onCommitted: () => { committed = true; client.markCommitted(); },
        });
      } catch (error) {
        if (error instanceof ToolExecutionAbortedError) throw error;
        if (error instanceof ToolVisibleStateError) {
          return toolDomainError(domainError(
            "STALE_PROJECT",
            "CueBench could not verify the visible Browser Agent tool state. Inspect the project and retry.",
          ), { changed: committed });
        }
        return toolDomainError(domainError(
          "INVALID_ARGUMENT",
          "Audio-description generation is not ready in this page. Complete the visible hosted-processing requirements and retry.",
        ), { changed: committed, nextActions: committed ? ["inspect_generation_run", "inspect_project"] : ["inspect_project"] });
      }
      if (operation.lifecycle !== "ready") client.markCommitted();
      await runtime.afterVisibleChange();
      const current = runtime.getProject();
      if (current === null) return projectUnavailable();
      return toolSuccess({
        projectRevision: current.projectRevision,
        data: { run: operation.run },
        nextActions: operation.lifecycle === "ready"
          ? ["inspect_generation_run", "cancel_generation_run"]
          : ["inspect_generation_run", "inspect_project"],
        ...verificationFor(runtime, current, { before: project }),
      });
    },
  }),
  tool({
    name: "validate_project",
    description: "Run complete deterministic project validation. This reports technical findings and does not rule, waive, or certify.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: validationData,
    execute: async (input, client) => {
      const parsed = validateInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Validation requires the current project revision.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      const result = await executeVisibleCommand(runtime, {
        type: "ValidateProject",
        actor: { type: "System", id: "cuebench-validation" },
        expectedProjectRevision: project.projectRevision,
      }, client);
      return resultForCommand(runtime, project, result, { validation: result.project.validation }, ["list_quality_findings", "prepare_certification_review"], null);
    },
  }),
  tool({
    name: "export_track",
    description: "Prepare a round-trip-verified draft or latest-current-certified track export and expose the browser download affordance.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
      trackKind: { enum: ["Captions", "AudioDescriptions"] },
      format: { enum: ["vtt", "srt", "ad-txt"] },
      disposition: { enum: ["draft", "certified"] },
    }, ["contractVersion", "expectedProjectRevision", "trackKind", "format", "disposition"]),
    resultDataSchema: exportData,
    annotations: untrustedContent,
    execute: async (input, client) => {
      const parsed = exportInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Export requires a current project revision, one track, a compatible format, and draft or certified disposition.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      const format = canonicalTrackFormat(parsed.data.format);
      if (
        (parsed.data.trackKind === "Captions" && format === "ad-txt")
        || (parsed.data.trackKind === "AudioDescriptions" && format === "srt")
      ) return invalidToolInput("Caption tracks export as VTT or SRT; audio-description tracks export as VTT or AD text.");
      if (runtime.exportTrack === undefined) return toolDomainError(domainError("INVALID_ARGUMENT", "This page cannot offer a verified export download."));
      let published;
      let committed = false;
      try {
        published = await runtime.exportTrack({
          project,
          trackKind: parsed.data.trackKind,
          format,
          disposition: parsed.data.disposition,
          expectedProjectRevision: project.projectRevision,
          signal: client.signal,
          onCommitted: () => { committed = true; client.markCommitted(); },
        });
      } catch (error) {
        if (error instanceof ToolExecutionAbortedError || error instanceof ToolVisibleStateError) throw error;
        return toolDomainError(domainError("EXPORT_ROUND_TRIP_MISMATCH", "CueBench could not prepare a verified export from the current project."), {
          changed: committed,
          nextActions: ["inspect_project"],
        });
      }
      if (!published.published) return toolDomainError(domainError("INVALID_ARGUMENT", "CueBench could not expose the verified export download in this browser."));
      client.markCommitted();
      await runtime.afterVisibleChange();
      const current = runtime.getProject();
      if (current === null) return projectUnavailable();
      return toolSuccess({
        projectRevision: current.projectRevision,
        data: {
          export: {
            filename: published.prepared.filename,
            trackKind: parsed.data.trackKind,
            format,
            disposition: parsed.data.disposition,
            itemCount: published.prepared.source.items.length,
            serializedTextHash: published.prepared.serializedTextHash,
            published: true,
          },
        },
        nextActions: ["inspect_project"],
        ...verificationFor(runtime, current, { before: project }),
      });
    },
  }),
  tool({
    name: "propose_profile_patch",
    description: "Create an unapplied Browser Agent Quality Profile patch for a Human to inspect and optionally apply in the normal UI.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
      profileId: { type: "string", minLength: 1, maxLength: 200 },
      name: { type: "string", minLength: 1, maxLength: 1000 },
      rationale: { type: "string", minLength: 1, maxLength: 2000 },
      patch: ProfilePatchJsonSchema,
    }, ["contractVersion", "expectedProjectRevision", "profileId", "name", "rationale", "patch"]),
    resultDataSchema: profileProposalData,
    execute: async (input, client) => {
      const parsed = profilePatchInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("A profile proposal needs a bounded, safe patch plus a rationale for Human review.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      if (runtime.publishProfileProposal === undefined) return toolDomainError(domainError("INVALID_ARGUMENT", "This page cannot present a profile proposal for Human review."));
      const changedPaths = changedPathsForPatch(parsed.data.patch);
      if (changedPaths.length === 0) return invalidToolInput("A profile proposal must change at least one safe rule path.");
      const proposalId = runtime.createOpaqueId?.("profile-proposal") ?? `profile-proposal-${project.projectRevision}`;
      const proposal = {
        projectId: project.projectId,
        proposalId,
        createdBy: `Browser Agent · ${runtime.browserAgent.id}`,
        rationale: parsed.data.rationale,
        profileId: parsed.data.profileId,
        name: parsed.data.name,
        rules: resolveProfilePatch(project.qualityProfile.rules, parsed.data.patch),
        baseProfileRevision: project.qualityProfile.revision,
        baseProjectRevision: project.projectRevision,
        changedPaths,
      };
      if (client.signal.aborted) throw new ToolExecutionAbortedError();
      await runtime.publishProfileProposal(proposal, client.signal);
      if (client.signal.aborted) throw new ToolExecutionAbortedError();
      await runtime.afterVisibleChange();
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: {
          proposal: {
            proposalId,
            baseProfileRevision: project.qualityProfile.revision,
            changedPaths,
            reviewRequired: true,
          },
        },
        nextActions: ["inspect_project"],
        ...verificationFor(runtime, project),
      });
    },
  }),
  tool({
    name: "prepare_certification_review",
    description: "Prepare current certification readiness for Human review without certifying, waiving, or applying a profile.",
    inputSchema: jsonObjectSchema({
      contractVersion: contractJson,
      expectedProjectRevision: expectedProjectJson,
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: certificationReadinessData,
    annotations: readOnly,
    execute: (input) => {
      const parsed = certificationReadinessInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Certification preparation requires the current project revision.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isFailure(project)) return project;
      const readiness = prepareCertificationReview(project);
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: {
          readiness: {
            readinessHash: readiness.readinessHash,
            canCertify: readiness.canCertify,
            blockerCount: readiness.currentBlockers.length,
            unwaivedWarningCount: readiness.unwaivedWarnings.length,
            staleValidationCauseCodes: readiness.staleValidationCauses.map((cause) => cause.code),
            itemStateCounts: readiness.itemStateCounts,
            blockers: readiness.currentBlockers.slice(0, 24).map(findingSnapshot),
            unwaivedWarnings: readiness.unwaivedWarnings.slice(0, 24).map(findingSnapshot),
          },
        },
        nextActions: readiness.canCertify ? ["inspect_project"] : ["list_quality_findings", "inspect_project"],
        ...verificationFor(runtime, project),
      });
    },
  }),
];
