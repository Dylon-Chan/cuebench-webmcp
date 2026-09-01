import { RECOVERY_LIFECYCLE_BACKSTOP_MS } from "./recovery";

/**
 * A small durable projection of a cleanup acknowledgement. The opaque owner
 * key is retained only at the private browser/route boundary; this shape is
 * intentionally suitable for tests and UI status without making it public.
 */
export interface CleanupReceipt {
  readonly version: 1;
  readonly ownerKey: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly attempts: number;
  readonly state: "deleting" | "lifecycle-pending" | "deleted";
}

export type CleanupSettlement =
  | { readonly kind: "confirmed-deleted"; readonly nowMs: number }
  | { readonly kind: "unconfirmed"; readonly nowMs: number };

export interface CleanupReceiptInput {
  readonly ownerKey: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs?: number;
}

/**
 * Produces a bounded receipt before a delete request is issued. A caller must
 * persist it write-ahead so a crash or detached tab still has an idempotent
 * cleanup target to reconnect with.
 */
export const createCleanupReceipt = (input: CleanupReceiptInput): CleanupReceipt => {
  const expiresAtMs = input.expiresAtMs ?? input.requestedAtMs + RECOVERY_LIFECYCLE_BACKSTOP_MS;
  if (!Number.isSafeInteger(input.requestedAtMs) || input.requestedAtMs < 0 || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= input.requestedAtMs) {
    throw new Error("CueBench cleanup receipt requires a bounded lifecycle expiry.");
  }
  if (input.ownerKey.trim().length === 0) throw new Error("CueBench cleanup receipt requires a verified owner.");
  return {
    version: 1,
    ownerKey: input.ownerKey,
    requestedAtMs: input.requestedAtMs,
    expiresAtMs,
    attempts: 0,
    state: "deleting",
  };
};

/**
 * Applies a server acknowledgement monotonically. `deleted` is terminal and
 * `unconfirmed` can never manufacture a deletion result. Once the 24-hour
 * cap is reached, the wording changes to lifecycle-pending rather than
 * promising an instantaneous delete the browser has not observed.
 */
export const settleCleanupReceipt = (receipt: CleanupReceipt, settlement: CleanupSettlement): CleanupReceipt => {
  if (receipt.state === "deleted") return receipt;
  const attempts = receipt.attempts + 1;
  if (settlement.kind === "confirmed-deleted") return { ...receipt, attempts, state: "deleted" };
  return {
    ...receipt,
    attempts,
    state: settlement.nowMs >= receipt.expiresAtMs ? "lifecycle-pending" : "deleting",
  };
};

/** A user-facing status must not contain route, provider, or object-key text. */
export const cleanupMessageFor = (state: CleanupReceipt["state"]): string => {
  switch (state) {
    case "deleted": return "CueBench confirmed private cloud cleanup.";
    case "lifecycle-pending": return "CueBench is waiting for a private cleanup acknowledgement. The 24-hour lifecycle backstop remains in effect.";
    default: return "CueBench requested private cloud cleanup and is waiting for confirmation.";
  }
};
