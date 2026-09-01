import { domainError } from "@cuebench/domain";
import { z } from "zod";
import { ToolExecutionAbortedError, ToolGenerationInspectionError, ToolStaleRunError, ToolVisibleStateError, toolDomainError, toolSuccess } from "../tool-result";
import { strictToolDataSchema, type CueBenchTool, type ToolExecutionClient } from "../types";
import {
  ExpectedProjectRevisionInputSchema,
  commonJsonProperties,
  jsonObjectSchema,
  validIdentifier,
  type CueBenchWebMcpRuntime,
} from "./schemas";
import {
  invalidToolInput,
  isToolError,
  projectAtExpectedRevision,
  projectUnavailable,
  verificationFor,
} from "./helpers";

export const ACTIVE_RUN_TOOL_NAMES = [
  "inspect_generation_run",
  "cancel_generation_run",
] as const;

const inspectInput = ExpectedProjectRevisionInputSchema;
const cancelInput = ExpectedProjectRevisionInputSchema.extend({
  expectedRunId: validIdentifier,
}).strict();

const generationData = strictToolDataSchema({
  run: z.object({
    runId: validIdentifier,
    targetTrack: z.enum(["Captions", "AudioDescriptions"]),
    stage: z.string().trim().min(1).max(100),
    progress: z.number().min(0).max(1).nullable(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(20),
    retryable: z.boolean().nullable(),
    code: z.string().trim().min(1).max(100).nullable(),
    receiptState: z.enum(["available", "missing", "expired"]),
  }).strict().nullable(),
});

const tool = (input: CueBenchTool): CueBenchTool => input;

/** Active-run tools are replaced atomically by the registry whenever the run changes. */
export const createActiveRunTools = (runtime: CueBenchWebMcpRuntime): readonly CueBenchTool[] => [
  tool({
    name: "inspect_generation_run",
    description: "Inspect the one visible active generation run and its recoverable stage without adopting, ruling on, or replacing work.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      expectedProjectRevision: commonJsonProperties.expectedProjectRevision,
    }, ["contractVersion", "expectedProjectRevision"]),
    resultDataSchema: generationData,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input, client) => {
      const parsed = inspectInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Generation inspection requires the current project revision.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isToolError(project)) return project;
      if (runtime.inspectGeneration === undefined) {
        return toolDomainError(domainError("INVALID_ARGUMENT", "Generation inspection is not available in this page session."));
      }
      let run;
      try {
        run = await runtime.inspectGeneration({ project, signal: client.signal });
      } catch (error) {
        if (error instanceof ToolGenerationInspectionError) {
          return toolDomainError(domainError("GENERATION_STAGE_FAILED", "CueBench could not inspect the visible generation run. Retry inspection."), {
            retryable: true,
            nextActions: ["inspect_generation_run", "inspect_project"],
          });
        }
        if (error instanceof ToolStaleRunError) {
          return toolDomainError(domainError("STALE_RUN", "The visible generation run changed while its status was loading."), {
            retryable: true,
            nextActions: ["inspect_generation_run", "inspect_project"],
          });
        }
        throw error;
      }
      if (client.signal.aborted) return toolDomainError(domainError("STALE_RUN", "The generation inspection was cancelled before the visible run could be verified."), { retryable: true, nextActions: ["inspect_generation_run"] });
      const current = runtime.getProject();
      if (
        current === null
        || current.projectId !== project.projectId
        || current.projectRevision !== project.projectRevision
        || current.activeGenerationRun?.runId !== project.activeGenerationRun?.runId
        || current.activeGenerationRun?.targetTrack !== project.activeGenerationRun?.targetTrack
      ) return toolDomainError(domainError("STALE_RUN", "The visible generation run changed while its status was loading."), { retryable: true, nextActions: ["inspect_generation_run", "inspect_project"] });
      return toolSuccess({
        projectRevision: project.projectRevision,
        data: { run },
        nextActions: run === null ? ["inspect_project"] : ["cancel_generation_run", "inspect_project"],
        ...verificationFor(runtime, project),
      });
    },
  }),
  tool({
    name: "cancel_generation_run",
    description: "Cancel the currently visible generation run. Cancellation preserves visible recoverable state and never adopts or deletes proposals.",
    inputSchema: jsonObjectSchema({
      contractVersion: commonJsonProperties.contractVersion,
      expectedProjectRevision: commonJsonProperties.expectedProjectRevision,
      expectedRunId: { type: "string", minLength: 1, maxLength: 200 },
    }, ["contractVersion", "expectedProjectRevision", "expectedRunId"]),
    resultDataSchema: generationData,
    annotations: { untrustedContentHint: true },
    execute: async (input, client: ToolExecutionClient) => {
      const parsed = cancelInput.safeParse(input);
      if (!parsed.success) return invalidToolInput("Generation cancellation requires the current project revision and active run id.");
      const project = projectAtExpectedRevision(runtime, parsed.data.expectedProjectRevision);
      if (isToolError(project)) return project;
      if (project.activeGenerationRun === null || project.activeGenerationRun.runId !== parsed.data.expectedRunId) {
        return toolDomainError(domainError("STALE_RUN", "The requested generation run is no longer active."), { retryable: true, nextActions: ["inspect_generation_run"] });
      }
      if (runtime.cancelGeneration === undefined) {
        return toolDomainError(domainError("INVALID_ARGUMENT", "Generation cancellation is not available in this page session."));
      }
      let operation;
      let committed = false;
      try {
        operation = await runtime.cancelGeneration({
          project,
          expectedProjectRevision: project.projectRevision,
          signal: client.signal,
          ...(client.postCommitSignal === undefined ? {} : { postCommitSignal: client.postCommitSignal }),
          onCommitted: () => { committed = true; client.markCommitted(); },
        });
      } catch (error) {
        if (error instanceof ToolExecutionAbortedError || error instanceof ToolVisibleStateError) throw error;
        return toolDomainError(domainError(
          "INVALID_ARGUMENT",
          "CueBench cannot cancel this run without its visible browser recovery receipt.",
        ), { changed: committed, nextActions: committed ? ["inspect_generation_run", "inspect_project"] : ["inspect_project"] });
      }
      if (operation.lifecycle !== "ready") client.markCommitted();
      await runtime.afterVisibleChange();
      const current = runtime.getProject();
      if (current === null) return projectUnavailable();
      return toolSuccess({
        projectRevision: current.projectRevision,
        data: { run: operation.run },
        nextActions: operation.lifecycle === "ready" ? ["inspect_project"] : ["inspect_generation_run", "inspect_project"],
        ...verificationFor(runtime, current, { before: project }),
      });
    },
  }),
];
