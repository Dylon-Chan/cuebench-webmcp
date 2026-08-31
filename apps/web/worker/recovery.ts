import type { GenerationRunStatus } from "@cuebench/contracts";

/**
 * Every anonymous processing receipt is deliberately bounded to one day. The
 * server still verifies its signature; this module is the post-verification
 * state model shared by recovery and cleanup surfaces.
 */
export const RECOVERY_LIFECYCLE_BACKSTOP_MS = 24 * 60 * 60 * 1_000;

/**
 * These are lifecycle facts, not a new source of authority. In particular,
 * `adopted` means a Human committed the staged result locally; it does not
 * mean that a request to delete temporary cloud objects succeeded.
 */
export type RecoveryState =
  | "processing"
  | "staged"
  | "adopted"
  | "cancelled"
  | "failed-retryable"
  | "failed-terminal"
  | "deleting"
  | "deleted";

export type RecoveryTransition =
  | "stage"
  | "adopt"
  | "cancel"
  | "fail-retryable"
  | "fail-terminal"
  | "retry"
  | "request-delete"
  | "confirm-delete";

export interface RecoveryRunFacts {
  readonly stage: GenerationRunStatus["stage"];
  readonly retryable?: boolean;
  /** Exact-key tombstone state, after the signed receipt has been verified. */
  readonly cleanup?: "pending" | "completed";
  /** A Human deleted the project while its run or upload was still retained. */
  readonly projectDeletionRequested?: boolean;
}

export interface RecoveryReceiptOwnership {
  /** Salted/verified owner key. Never put the raw browser owner capability here. */
  readonly ownerKey: string;
  readonly expiresAtMs: number;
}

export type RecoveryAccessCode = "RECOVERY_OWNER_MISMATCH" | "RECOVERY_EXPIRED";

export interface RecoveryAccess {
  readonly allowed: boolean;
  readonly code: RecoveryAccessCode | null;
}

const terminalCleanupState = (facts: RecoveryRunFacts): RecoveryState | null => {
  if (facts.cleanup !== "completed") return null;
  // Adoption certifies the browser project. Its temporary provider artifacts
  // may be cleaned, but the user-visible run remains an adopted result.
  if (facts.stage === "Completed") return "adopted";
  return "deleted";
};

/**
 * Projects the existing signed run record + exact-key cleanup tombstone onto
 * the small public recovery vocabulary. It intentionally has no I/O and can
 * therefore not accidentally treat a browser retry as a cleanup command.
 */
export const classifyRecoveryState = (facts: RecoveryRunFacts): RecoveryState => {
  const completedCleanup = terminalCleanupState(facts);
  if (completedCleanup !== null) return completedCleanup;
  if (facts.projectDeletionRequested || facts.cleanup === "pending") return "deleting";
  switch (facts.stage) {
    case "AwaitingAdoption": return "staged";
    case "Completed": return "adopted";
    case "Cancelled": return "cancelled";
    case "Failed": return facts.retryable === true ? "failed-retryable" : "failed-terminal";
    // A live Workflow is not a staged human-reviewable artifact. Detached
    // tabs may reconnect and poll it, but must never be told a proposal is
    // ready before the durable record reaches AwaitingAdoption.
    default: return "processing";
  }
};

const transitions: Readonly<Record<RecoveryState, Readonly<Partial<Record<RecoveryTransition, RecoveryState>>>>> = {
  processing: {
    stage: "staged",
    cancel: "cancelled",
    "fail-retryable": "failed-retryable",
    "fail-terminal": "failed-terminal",
    "request-delete": "deleting",
  },
  staged: {
    stage: "staged",
    adopt: "adopted",
    cancel: "cancelled",
    "fail-retryable": "failed-retryable",
    "fail-terminal": "failed-terminal",
    "request-delete": "deleting",
  },
  adopted: {
    "request-delete": "deleting",
  },
  cancelled: {
    "request-delete": "deleting",
  },
  "failed-retryable": {
    // Retrying starts another durable processing attempt. It cannot be
    // represented as staged until that attempt actually reaches
    // AwaitingAdoption with a reviewable proposal.
    retry: "processing",
    cancel: "cancelled",
    "request-delete": "deleting",
  },
  "failed-terminal": {
    "request-delete": "deleting",
  },
  deleting: {
    "confirm-delete": "deleted",
  },
  deleted: {},
};

/** Rejects impossible UI/server lifecycle moves before they can be persisted. */
export const transitionRecoveryState = (from: RecoveryState, transition: RecoveryTransition): RecoveryState => {
  const next = transitions[from][transition];
  if (next === undefined) {
    throw new Error(`CueBench cannot transition recovery state ${from} with ${transition}.`);
  }
  return next;
};

/**
 * `expectedOwnerKey` must be derived by the route after validating the
 * anonymous session and raw browser-project owner capability. Comparing this
 * opaque salted key prevents a detached tab from adopting or deleting another
 * browser project's media.
 */
export const recoveryAccessFor = (
  receipt: RecoveryReceiptOwnership,
  expectedOwnerKey: string,
  nowMs: number,
): RecoveryAccess => {
  if (receipt.ownerKey !== expectedOwnerKey) return { allowed: false, code: "RECOVERY_OWNER_MISMATCH" };
  if (!Number.isSafeInteger(receipt.expiresAtMs) || receipt.expiresAtMs <= nowMs) {
    return { allowed: false, code: "RECOVERY_EXPIRED" };
  }
  return { allowed: true, code: null };
};

/**
 * Provider and storage errors may contain filenames, signed receipts, or
 * model response fragments. A recovery surface receives only this stable,
 * actionable sentence; structured telemetry continues to record allowlisted
 * codes elsewhere.
 */
export const redactRecoveryError = (error: unknown): string => {
  // Keep the argument so callers can use a uniform catch-boundary helper,
  // while deliberately refusing to inspect or persist any private detail.
  void error;
  return "CueBench could not resume private processing. Reconnect or retry with the current project; private media details were not retained in this notice.";
};

/**
 * Durable Workflow status is a browser-visible recovery boundary. Do not let
 * a provider, file path, signed URL, or raw model response become its status
 * message just because a catch block happens to have access to one.
 */
export const redactWorkflowFailure = (error: unknown): string => {
  // These messages are intentionally selected by category, never relayed
  // from the caught error. They preserve a useful next step without turning
  // an exception string into a private-data transport.
  const source = error instanceof Error ? error.message : "";
  if (/Local Evidence Package|6 MiB canonical/i.test(source)) {
    return "CueBench could not stage a Local Evidence Package within the 6 MiB portable browser budget.";
  }
  if (/cannot safely replay/i.test(source)) {
    return "CueBench cannot safely replay this private processing step because its earlier outcome is unknown.";
  }
  return "CueBench could not complete private processing. Review the current recovery state and retry only when CueBench marks this run retryable.";
};
