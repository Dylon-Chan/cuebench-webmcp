import {
  GenerationRunStatusSchema,
  StagedGenerationResultSchema,
  type GenerationRunStatus,
} from "@cuebench/contracts";
import type { CaptionProject, CommandResult, DomainCommand } from "@cuebench/domain";
import type { CloudUploadFetch, PersistedCloudUploadRecovery } from "../project/cloud-upload";
import type { CaptionGenerationAdoptionCommand } from "../project/project-store";

const aiActor = { type: "CueBenchAI" as const, id: "cuebench-ai" };
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const sha256 = /^[0-9a-f]{64}$/i;

export interface GenerationClientReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string;
  /** Opaque Worker-signed bearer, retained in Dexie and never displayed. */
  readonly signedGenerationReceipt: string;
  readonly expectedProjectRevision: number;
  readonly expectedQualityProfileRevision: number;
  readonly mediaSha256: string;
  readonly savedAtMs: number;
}

export interface GenerationProjectStore {
  readonly getSnapshot: () => { readonly project: CaptionProject | null };
  readonly executeCommand: (command: DomainCommand) => Promise<CommandResult>;
  /** This must complete before the browser starts polling an opaque receipt. */
  readonly persistCaptionGenerationReceipt: (runId: string, receipt: GenerationClientReceipt) => Promise<void>;
  readonly loadCaptionGenerationReceipt: (runId: string) => Promise<unknown | null>;
  readonly adoptStagedCaptionGenerationResult: (command: CaptionGenerationAdoptionCommand) => Promise<CommandResult>;
}

export interface GenerationClientErrorDetails {
  readonly code?: string;
  readonly status?: number;
  /** A run could exist server-side, so retain the local target-track lease. */
  readonly dispatchMayBeDurable?: boolean;
}

export class GenerationClientError extends Error {
  public constructor(message: string, public readonly details: GenerationClientErrorDetails = {}) {
    super(message);
    this.name = "GenerationClientError";
  }
}

export interface StartCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly upload: Pick<PersistedCloudUploadRecovery, "operationId" | "session" | "operationReceipt">;
}

export interface StartedCaptionGeneration {
  readonly receipt: GenerationClientReceipt;
  readonly status: GenerationRunStatus;
}

export interface CancelCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly receipt: GenerationClientReceipt;
}

export interface AdoptCaptionGenerationInput {
  readonly project: CaptionProject;
  readonly store: GenerationProjectStore;
  readonly receipt: GenerationClientReceipt;
  readonly confirmedProposedReplacement: boolean;
}

export interface CaptionGenerationClientPort {
  readonly start: (input: StartCaptionGenerationInput) => Promise<StartedCaptionGeneration>;
  readonly status: (receipt: GenerationClientReceipt) => Promise<GenerationRunStatus>;
  readonly cancel: (input: CancelCaptionGenerationInput) => Promise<GenerationRunStatus>;
  readonly adopt: (input: AdoptCaptionGenerationInput) => Promise<CommandResult>;
  readonly loadStoredReceipt: (store: GenerationProjectStore, project: CaptionProject, runId: string) => Promise<GenerationClientReceipt | null>;
}

export interface CaptionGenerationClientOptions {
  readonly fetcher?: CloudUploadFetch;
  readonly createRunId?: () => string;
  readonly clock?: () => number;
}

const defaultFetcher = (): CloudUploadFetch => {
  if (typeof globalThis.fetch !== "function") throw new GenerationClientError("Caption generation is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const responseError = async (response: Response, fallback: string): Promise<GenerationClientError> => {
  try {
    const body = await response.json() as { readonly error?: Readonly<Record<string, unknown>> };
    const error = body.error;
    if (typeof error?.message === "string" && error.message.trim().length > 0) {
      const code = typeof error.code === "string" ? error.code : undefined;
      return new GenerationClientError(error.message, {
        status: response.status,
        ...(code === undefined ? {} : { code }),
        ...(code === "GENERATION_DISPATCH_PENDING" ? { dispatchMayBeDurable: true } : {}),
      });
    }
  } catch {
    // Do not surface an untrusted gateway body: it may include private context.
  }
  return new GenerationClientError(fallback, { status: response.status });
};

const responseRecord = (value: unknown, fallback: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GenerationClientError(fallback);
  return value as Readonly<Record<string, unknown>>;
};

const parseStatus = (value: unknown): GenerationRunStatus => {
  const parsed = GenerationRunStatusSchema.safeParse(value);
  if (!parsed.success) throw new GenerationClientError("CueBench received an invalid caption-generation status.");
  return parsed.data;
};

const requireUploadAuthorization = (upload: StartCaptionGenerationInput["upload"]): { readonly session: string; readonly operationReceipt: string } => {
  if (typeof upload.session !== "string" || upload.session.trim().length === 0 || typeof upload.operationReceipt !== "string" || upload.operationReceipt.trim().length === 0) {
    throw new GenerationClientError("Complete or refresh optional cloud processing before starting caption generation.");
  }
  return { session: upload.session, operationReceipt: upload.operationReceipt };
};

const parseStart = (value: unknown, project: CaptionProject, expectedProjectRevision: number, runId: string, savedAtMs: number): StartedCaptionGeneration => {
  const record = responseRecord(value, "CueBench did not return a signed caption-generation receipt.");
  if (typeof record.generationRunReceipt !== "string" || record.generationRunReceipt.trim().length === 0) {
    throw new GenerationClientError("CueBench did not return a signed caption-generation receipt.");
  }
  const status = parseStatus(record.status);
  if (
    status.runId !== runId
    || status.projectId !== project.projectId
    || status.targetTrack !== "Captions"
    || status.expectedProjectRevision !== expectedProjectRevision
  ) throw new GenerationClientError("CueBench returned a caption-generation receipt for different project evidence.");
  return {
    receipt: {
      version: 1,
      runId,
      projectId: project.projectId,
      signedGenerationReceipt: record.generationRunReceipt,
      expectedProjectRevision,
      expectedQualityProfileRevision: project.qualityProfile.revision,
      mediaSha256: project.media.sha256.toLowerCase(),
      savedAtMs,
    },
    status,
  };
};

const isMatchingCaptionLease = (project: CaptionProject, runId: string): boolean => (
  project.activeGenerationRun?.runId === runId && project.activeGenerationRun.targetTrack === "Captions"
);

/**
 * Browser-side boundary for the opaque same-origin API. It deliberately does
 * not call a provider or hold a media Blob: all provider work remains inside
 * the durable Cloudflare Workflow.
 */
export class CaptionGenerationClient implements CaptionGenerationClientPort {
  private readonly fetcher: CloudUploadFetch;
  private readonly createRunId: () => string;
  private readonly clock: () => number;

  public constructor(options: CaptionGenerationClientOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher();
    this.createRunId = options.createRunId ?? (() => globalThis.crypto.randomUUID());
    this.clock = options.clock ?? Date.now;
  }

  public async start(input: StartCaptionGenerationInput): Promise<StartedCaptionGeneration> {
    const authorization = requireUploadAuthorization(input.upload);
    const visibleProject = input.store.getSnapshot().project;
    if (visibleProject === null || visibleProject.projectId !== input.project.projectId) {
      throw new GenerationClientError("CueBench project identity changed before caption generation could start.");
    }
    let leasedProject = visibleProject;
    let runId: string;
    if (leasedProject.activeGenerationRun === null) {
      runId = this.createRunId();
      if (!opaqueId.test(runId)) throw new GenerationClientError("CueBench generated an invalid caption-generation run identifier.");
      const lease = await input.store.executeCommand({
        type: "StartGenerationRun",
        actor: aiActor,
        runId,
        targetTrack: "Captions",
        expectedProjectRevision: leasedProject.projectRevision,
      });
      if (lease.error !== undefined) throw new GenerationClientError(lease.error.message, { code: lease.error.code });
      leasedProject = lease.project;
    } else if (isMatchingCaptionLease(leasedProject, leasedProject.activeGenerationRun.runId)) {
      runId = leasedProject.activeGenerationRun.runId;
    } else {
      throw new GenerationClientError("A different generation run currently holds CueBench's target-track lease.", { code: "TARGET_TRACK_LEASE_CONFLICT" });
    }

    let durableStartMayExist = false;
    try {
      const response = await this.fetcher("/api/generation-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization.session}`,
          "content-type": "application/json",
          "x-cuebench-operation-receipt": authorization.operationReceipt,
        },
        body: JSON.stringify({
          projectId: leasedProject.projectId,
          runId,
          expectedProjectRevision: leasedProject.projectRevision,
          expectedQualityProfileRevision: leasedProject.qualityProfile.revision,
          mediaSha256: leasedProject.media.sha256.toLowerCase(),
          qualityProfileRules: leasedProject.qualityProfile.rules,
        }),
      });
      if (!response.ok) throw await responseError(response, "CueBench could not start a recoverable caption-generation run.");
      // A successful HTTP response means the Worker has already persisted its
      // private record. Retain the local lease even if a hostile/corrupt body
      // cannot be parsed or IndexedDB fails before saving the browser receipt.
      durableStartMayExist = true;
      const started = parseStart(await response.json(), leasedProject, leasedProject.projectRevision, runId, this.clock());
      // This await is intentionally before returning to UI polling. If a tab
      // closes immediately after start, the signed capability still recovers.
      await input.store.persistCaptionGenerationReceipt(runId, started.receipt);
      return started;
    } catch (error) {
      const current = input.store.getSnapshot().project;
      const clientError = error instanceof GenerationClientError ? error : null;
      // A transport failure or explicit dispatch-pending response is ambiguous:
      // retain the lease so the same run id can be retried instead of racing a
      // server-side Workflow that already holds its signed receipt.
      if (!durableStartMayExist && clientError !== null && clientError.details.dispatchMayBeDurable !== true && current !== null && isMatchingCaptionLease(current, runId)) {
        await input.store.executeCommand({
          type: "ReleaseGenerationRun",
          actor: aiActor,
          runId,
          expectedProjectRevision: current.projectRevision,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  public async status(receipt: GenerationClientReceipt): Promise<GenerationRunStatus> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(receipt.runId)}`, {
      headers: { "x-cuebench-generation-receipt": receipt.signedGenerationReceipt },
    });
    if (!response.ok) throw await responseError(response, "CueBench could not read caption-generation status.");
    const record = responseRecord(await response.json(), "CueBench did not return caption-generation status.");
    const status = parseStatus(record.status);
    if (status.runId !== receipt.runId || status.projectId !== receipt.projectId || status.expectedProjectRevision !== receipt.expectedProjectRevision) {
      throw new GenerationClientError("CueBench returned status for different caption-generation evidence.");
    }
    return status;
  }

  public async cancel(input: CancelCaptionGenerationInput): Promise<GenerationRunStatus> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(input.receipt.runId)}`, {
      method: "DELETE",
      headers: { "x-cuebench-generation-receipt": input.receipt.signedGenerationReceipt },
    });
    if (!response.ok) throw await responseError(response, "CueBench could not cancel this caption-generation run.");
    const record = responseRecord(await response.json(), "CueBench did not confirm caption-generation cancellation.");
    const status = parseStatus(record.status);
    if (status.stage !== "Cancelled" || status.runId !== input.receipt.runId) {
      throw new GenerationClientError("CueBench did not confirm cancellation of this caption-generation run.");
    }
    const current = input.store.getSnapshot().project;
    if (current !== null && isMatchingCaptionLease(current, input.receipt.runId)) {
      const released = await input.store.executeCommand({
        type: "ReleaseGenerationRun",
        actor: aiActor,
        runId: input.receipt.runId,
        expectedProjectRevision: current.projectRevision,
      });
      if (released.error !== undefined && released.error.code !== "STALE_RUN") {
        throw new GenerationClientError("CueBench confirmed cloud cancellation, but the local target-track lease needs recovery before it can be released.", { code: released.error.code });
      }
    }
    return status;
  }

  public async adopt(input: AdoptCaptionGenerationInput): Promise<CommandResult> {
    const response = await this.fetcher(`/api/generation-runs/${encodeURIComponent(input.receipt.runId)}/staged-result`, {
      headers: { "x-cuebench-generation-receipt": input.receipt.signedGenerationReceipt },
    });
    if (!response.ok) throw await responseError(response, "CueBench could not retrieve a complete staged caption result.");
    const record = responseRecord(await response.json(), "CueBench did not return a complete staged caption result.");
    const parsed = StagedGenerationResultSchema.safeParse(record.result);
    if (!parsed.success) throw new GenerationClientError("CueBench returned an invalid staged caption result.");
    const result = parsed.data;
    if (
      result.runId !== input.receipt.runId
      || result.projectId !== input.project.projectId
      || result.expectedProjectRevision !== input.project.projectRevision
      || result.expectedQualityProfileRevision !== input.project.qualityProfile.revision
      || result.evidence.mediaSha256.toLowerCase() !== input.project.media.sha256.toLowerCase()
    ) throw new GenerationClientError("The staged caption result is stale for CueBench's current project evidence.", { code: "STALE_PROJECT" });
    return input.store.adoptStagedCaptionGenerationResult({
      type: "AdoptCaptionGenerationResult",
      actor: aiActor,
      runId: input.receipt.runId,
      expectedProjectRevision: input.project.projectRevision,
      expectedQualityProfileRevision: input.project.qualityProfile.revision,
      confirmedProposedReplacement: input.confirmedProposedReplacement,
      result,
    });
  }

  public async loadStoredReceipt(store: GenerationProjectStore, project: CaptionProject, runId: string): Promise<GenerationClientReceipt | null> {
    const value = await store.loadCaptionGenerationReceipt(runId);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const receipt = value as Partial<GenerationClientReceipt>;
    const expectedProjectRevision = receipt.expectedProjectRevision;
    const expectedQualityProfileRevision = receipt.expectedQualityProfileRevision;
    const savedAtMs = receipt.savedAtMs;
    if (
      receipt.version !== 1
      || receipt.runId !== runId
      || receipt.projectId !== project.projectId
      || typeof expectedProjectRevision !== "number" || !Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1
      || typeof expectedQualityProfileRevision !== "number" || !Number.isSafeInteger(expectedQualityProfileRevision) || expectedQualityProfileRevision < 1
      || typeof receipt.signedGenerationReceipt !== "string" || receipt.signedGenerationReceipt.length === 0
      || typeof receipt.mediaSha256 !== "string" || !sha256.test(receipt.mediaSha256)
      || typeof savedAtMs !== "number" || !Number.isSafeInteger(savedAtMs) || savedAtMs < 0
    ) return null;
    return receipt as GenerationClientReceipt;
  }
}
