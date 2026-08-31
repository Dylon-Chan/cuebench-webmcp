import type { CloudUploadFetch } from "./cloud-upload";

export interface ProjectRunCleanupAuthorization {
  readonly targetTrack: "Captions" | "AudioDescriptions";
  readonly runId: string;
  /** Worker-signed run capability; never returned from a cleanup status. */
  readonly signedRunReceipt: string;
  /** Matching anonymous session required by the Worker route. */
  readonly session: string;
  /**
   * A locally committed terminal ruling must be acknowledged with its exact
   * run route even after the target lease has been released. Undefined keeps
   * the original active-run cancellation behavior.
   */
  readonly terminalAction?:
    | { readonly kind: "acknowledge"; readonly action: "adopted" | "discarded"; readonly adoptedProjectRevision?: number }
    | { readonly kind: "cancel" };
}

export interface ProjectUploadCleanupAuthorization {
  readonly operationId: string;
  readonly operationReceipt: string;
  readonly session: string;
}

/**
 * Private material retained in an IndexedDB deletion receipt after the local
 * project rows have gone. It is intentionally not part of a ProjectStore
 * snapshot, exported backup, WebMCP result, or CloudCleanupStatus entry.
 */
export interface ProjectCloudCleanupAuthorization {
  readonly version: 1;
  readonly ownerCapability: string;
  /** No browser cleanup action may outlive its disclosed one-day ceiling. */
  readonly expiresAtMs: number;
  readonly run?: ProjectRunCleanupAuthorization;
  readonly upload?: ProjectUploadCleanupAuthorization;
}

export interface ProjectCloudCleanupInput {
  readonly projectId: string;
  readonly sourceId: string;
  readonly activeRunId: string | null;
  readonly authorization: ProjectCloudCleanupAuthorization | undefined;
  readonly nowMs?: number;
  readonly fetcher?: CloudUploadFetch;
}

export interface ProjectCloudCleanupResult {
  readonly status: "deleted" | "pending" | "failed";
  readonly message: string;
}

const confirmed = (): ProjectCloudCleanupResult => ({
  status: "deleted",
  message: "CueBench confirmed private cloud cleanup.",
});

const pending = (): ProjectCloudCleanupResult => ({
  status: "pending",
  message: "CueBench is waiting for a private cleanup acknowledgement. The 24-hour lifecycle backstop remains in effect.",
});

const expired = (): ProjectCloudCleanupResult => ({
  status: "pending",
  message: "Private cleanup is lifecycle-pending because this browser recovery capability expired. The 24-hour lifecycle backstop remains in effect.",
});

const fetchFor = (fetcher: CloudUploadFetch | undefined): CloudUploadFetch | null => {
  if (fetcher !== undefined) return fetcher;
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
};

const cleanupState = async (response: Response): Promise<"pending" | "completed"> => {
  try {
    const payload = await response.json() as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "pending";
    const cleanup = (payload as Readonly<Record<string, unknown>>).cleanup;
    return typeof cleanup === "object" && cleanup !== null && !Array.isArray(cleanup)
      && (cleanup as Readonly<Record<string, unknown>>).state === "completed"
      ? "completed"
      : "pending";
  } catch {
    // A successful DELETE without a parseable exact-cleanup acknowledgement
    // is deliberately not promoted to deleted.
    return "pending";
  }
};

const runPathAndReceiptHeader = (run: ProjectRunCleanupAuthorization): {
  readonly path: string;
  readonly receiptHeader: "x-cuebench-generation-receipt" | "x-cuebench-audio-description-receipt";
} => run.targetTrack === "Captions"
  ? { path: `/api/generation-runs/${encodeURIComponent(run.runId)}`, receiptHeader: "x-cuebench-generation-receipt" }
  : { path: `/api/audio-description-runs/${encodeURIComponent(run.runId)}`, receiptHeader: "x-cuebench-audio-description-receipt" };

const terminalAcknowledgementBody = (action: Extract<ProjectRunCleanupAuthorization["terminalAction"], { readonly kind: "acknowledge" }>): string => JSON.stringify({
  action: action.action,
  ...(action.adoptedProjectRevision === undefined ? {} : { adoptedProjectRevision: action.adoptedProjectRevision }),
});

/**
 * Replays only the existing, signed exact-run/delete routes. It never lists
 * or deletes an R2 prefix, and it never claims deletion from a 2xx response
 * unless the route's durable tombstone says `completed`.
 */
export const cleanupProjectCloudArtifacts = async (input: ProjectCloudCleanupInput): Promise<ProjectCloudCleanupResult> => {
  const authorization = input.authorization;
  const nowMs = input.nowMs ?? Date.now();
  if (authorization === undefined) return pending();
  if (!Number.isSafeInteger(authorization.expiresAtMs) || authorization.expiresAtMs <= nowMs) return expired();
  const fetcher = fetchFor(input.fetcher);
  if (fetcher === null) return pending();

  const run = authorization.run;
  if (run !== undefined) {
    if (input.activeRunId !== null && run.runId !== input.activeRunId) return pending();
    const target = runPathAndReceiptHeader(run);
    try {
      const terminalAction = run.terminalAction;
      const response = await fetcher(terminalAction?.kind === "acknowledge" ? `${target.path}/acknowledge` : target.path, {
        method: terminalAction?.kind === "acknowledge" ? "POST" : "DELETE",
        headers: {
          authorization: `Bearer ${run.session}`,
          [target.receiptHeader]: run.signedRunReceipt,
          "x-cuebench-project-owner": authorization.ownerCapability,
          ...(terminalAction?.kind === "acknowledge" ? { "content-type": "application/json" } : {}),
        },
        ...(terminalAction?.kind === "acknowledge" ? { body: terminalAcknowledgementBody(terminalAction) } : {}),
      });
      if (!response.ok) return pending();
      return await cleanupState(response) === "completed" ? confirmed() : pending();
    } catch {
      return pending();
    }
  }

  const upload = authorization.upload;
  if (upload === undefined) return pending();
  try {
    const response = await fetcher(`/api/uploads/${encodeURIComponent(upload.operationId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${upload.session}`,
        "x-cuebench-operation-receipt": upload.operationReceipt,
        "x-cuebench-project-owner": authorization.ownerCapability,
      },
    });
    // The upload route owns only a pre-Workflow private copy. It uses 204 as
    // its exact-delete acknowledgement; a queued/accepted 2xx must remain
    // pending rather than becoming a false browser-side deletion claim.
    return response.status === 204 ? confirmed() : pending();
  } catch {
    return pending();
  }
};
