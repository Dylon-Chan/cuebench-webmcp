import type { RecoveryState } from "../../../worker/recovery";

export type RecoveryTrack = "captions" | "audio descriptions";

export interface RecoveryNoticeProps {
  readonly state: RecoveryState;
  readonly track: RecoveryTrack;
}

interface NoticeCopy {
  readonly title: string;
  readonly detail: (track: RecoveryTrack) => string;
}

const copyFor: Readonly<Record<RecoveryState, NoticeCopy>> = {
  processing: {
    title: "Private processing in progress",
    detail: (track) => `CueBench is still preparing the ${track} run. Reconnect to this project to follow its durable progress; no proposal is ready for human review yet.`,
  },
  staged: {
    title: "Staged for human review",
    detail: (track) => `CueBench retained the complete ${track} proposal. Reconnect to this project to review, adopt, object to, or discard the same staged result.`,
  },
  adopted: {
    title: "Human adoption recorded",
    detail: (track) => `The ${track} proposal is now in this browser project. Any temporary cloud cleanup is tracked separately until CueBench confirms it.`,
  },
  cancelled: {
    title: "Cancellation recorded",
    detail: (track) => `CueBench stopped the ${track} run. Reconnect to confirm private cleanup if this notice remains visible.`,
  },
  "failed-retryable": {
    title: "Retryable recovery",
    detail: (track) => `The ${track} run stopped before staging a complete result. Reconnect and retry the same durable run; CueBench will not begin a second hosted run.`,
  },
  "failed-terminal": {
    title: "Terminal recovery",
    detail: (track) => `The ${track} run cannot continue. CueBench retains its cleanup record until private temporary media is confirmed deleted or reaches the lifecycle backstop.`,
  },
  deleting: {
    title: "Private cleanup pending",
    detail: () => "CueBench requested exact private-media cleanup. It will never describe this as deleted until the hosted acknowledgement is recorded.",
  },
  deleted: {
    title: "Private cleanup confirmed",
    detail: () => "CueBench confirmed the private cleanup acknowledgement for this retained lifecycle record.",
  },
};

/**
 * A compact, receipt-safe recovery projection for the two generation cards.
 * It deliberately contains neither a run id nor a raw provider error: those
 * values are capabilities/private evidence, not recovery instructions.
 */
export function RecoveryNotice({ state, track }: RecoveryNoticeProps) {
  const copy = copyFor[state];
  return (
    <aside className={`recovery-notice recovery-notice--${state}`} role="status" aria-live="polite">
      <span className="recovery-notice__state" aria-hidden="true" />
      <div className="recovery-notice__body">
        <strong>{copy.title}</strong>
        <p>{copy.detail(track)}</p>
      </div>
    </aside>
  );
}
