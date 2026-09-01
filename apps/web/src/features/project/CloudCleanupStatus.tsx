import { useState } from "react";

export type CloudCleanupPublicState = "deleting" | "lifecycle-pending" | "deleted";

export interface CloudCleanupStatusEntry {
  readonly receiptId: string;
  readonly state: CloudCleanupPublicState;
  readonly message: string;
  readonly attempts: number;
}

export interface CloudCleanupStatusProps {
  readonly entries: readonly CloudCleanupStatusEntry[];
  /** Receipts are opaque; callers may retry but never inspect a cloud capability. */
  readonly onRetry: (receiptId: string) => Promise<void>;
}

const labelFor = (state: CloudCleanupPublicState): string => {
  switch (state) {
    case "deleted": return "Deleted";
    case "lifecycle-pending": return "Lifecycle pending";
    default: return "Deletion pending";
  }
};

const detailFor = (entry: CloudCleanupStatusEntry): string => {
  if (entry.state === "deleted") return "CueBench received a private cleanup acknowledgement.";
  if (entry.state === "lifecycle-pending") return "CueBench is waiting for a private cleanup acknowledgement. The 24-hour lifecycle backstop remains in effect.";
  return "CueBench requested private cloud cleanup and is waiting for confirmation.";
};

/**
 * Deliberately shown on the start surface after project deletion. It preserves
 * a Human's ability to retry only a still-authorized cleanup without
 * resurrecting the deleted project or revealing private cloud identifiers.
 */
export function CloudCleanupStatus({ entries, onRetry }: CloudCleanupStatusProps) {
  const [retryingReceiptId, setRetryingReceiptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (entries.length === 0) return null;

  const retry = async (receiptId: string) => {
    setRetryingReceiptId(receiptId);
    setError(null);
    try {
      await onRetry(receiptId);
    } catch {
      setError("CueBench could not retry private cleanup yet. The 24-hour lifecycle backstop remains in effect.");
    } finally {
      setRetryingReceiptId(null);
    }
  };

  return (
    <section className="cloud-cleanup-status" aria-label="Private cloud cleanup" aria-live="polite">
      <div className="cloud-cleanup-status__heading">
        <h2>Private cloud cleanup</h2>
        <p>Deletion acknowledgements stay visible after a local project is removed.</p>
      </div>
      <ul className="cloud-cleanup-status__list">
        {entries.map((entry) => {
          const pending = retryingReceiptId === entry.receiptId;
          return (
            <li key={entry.receiptId} className={`cloud-cleanup-status__entry cloud-cleanup-status__entry--${entry.state}`}>
              <div>
                <strong>{labelFor(entry.state)}</strong>
                <p>{detailFor(entry)}</p>
                <p className="cloud-cleanup-status__attempts">{entry.attempts === 1 ? "1 acknowledgement attempt" : `${entry.attempts} acknowledgement attempts`}</p>
              </div>
              {entry.state === "deleting" ? (
                <button
                  type="button"
                  className="button button--outline"
                  disabled={pending}
                  aria-busy={pending}
                  onClick={() => void retry(entry.receiptId)}
                >
                  {pending ? "Retrying private cleanup" : "Retry private cleanup"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error === null ? null : <p className="cloud-cleanup-status__error" role="alert">{error}</p>}
    </section>
  );
}
