import { useSyncExternalStore } from "react";
import type { WebMcpDebugEvent } from "@cuebench/webmcp";
import type { WebMcpDebugStore } from "./debug-store";

export interface WebMcpDebugDrawerProps {
  readonly store: WebMcpDebugStore;
}

const revisionLabel = (event: Extract<WebMcpDebugEvent, { readonly kind: "call" }>): string => {
  const project = event.revisions.projectRevision === null ? "—" : event.revisions.projectRevision;
  const selection = event.revisions.selectionRevision === null ? "—" : event.revisions.selectionRevision;
  const item = event.revisions.itemRevision === null ? "—" : event.revisions.itemRevision;
  return `p${project} · s${selection} · i${item}`;
};

const argsLabel = (event: Extract<WebMcpDebugEvent, { readonly kind: "call" }>): string => {
  const kinds = event.args.valueKinds.length === 0 ? "no values sampled" : event.args.valueKinds.join(", ");
  return `${event.args.kind} · ${event.args.fieldCount} fields${event.args.truncated ? "+" : ""} · ${kinds}`;
};

const durationLabel = (event: Extract<WebMcpDebugEvent, { readonly kind: "call" }>): string => (
  event.durationCapped ? `≥ ${event.durationMs} ms · capped` : `${event.durationMs} ms`
);

const eventLabel = (event: WebMcpDebugEvent): string => (
  event.kind === "registration"
    ? `${event.group} registration ${event.status}`
    : `${event.group} call`
);

/**
 * A judge-facing, development-only view of the WebMCP integration. It is
 * rendered only by the owning bridge after the `?webmcpDebug=1` opt-in and
 * shows fixed metadata rather than any user or media content.
 */
export function WebMcpDebugDrawer({ store }: WebMcpDebugDrawerProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!snapshot.enabled) return null;

  return (
    <aside className="webmcp-debug-drawer" aria-label="WebMCP inspection drawer">
      <header className="webmcp-debug-drawer__header">
        <div>
          <h2>WebMCP inspection</h2>
          <p>Opt-in, in-memory metadata only. Content values are never recorded.</p>
        </div>
        <button
          className="header-button"
          type="button"
          onClick={store.clear}
          disabled={snapshot.events.length === 0}
          aria-label="Clear inspection record"
        >
          Clear
        </button>
      </header>
      <p className="webmcp-debug-drawer__count" aria-live="polite">
        {snapshot.events.length} recent event{snapshot.events.length === 1 ? "" : "s"}
      </p>
      {snapshot.events.length === 0 ? (
        <p className="webmcp-debug-drawer__empty">No registration or call metadata yet.</p>
      ) : (
        <ol className="webmcp-debug-drawer__events">
          {snapshot.events.map((event, index) => (
            <li key={`${index}:${event.kind}:${event.toolName}:${event.kind === "call" ? event.resultCode : event.status}`}>
              <div className="webmcp-debug-drawer__event-heading">
                <strong>{event.toolName}</strong>
                <span>schema v{event.schemaVersion}</span>
              </div>
              <p>
                {eventLabel(event)}
                {event.kind === "registration" ? null : <strong className="webmcp-debug-drawer__result">{event.resultCode}</strong>}
              </p>
              {event.kind === "registration" ? null : (
                <dl>
                  <div><dt>Arguments</dt><dd>{argsLabel(event)}</dd></div>
                  <div><dt>Duration</dt><dd>{durationLabel(event)}</dd></div>
                  <div><dt>Revisions</dt><dd>{revisionLabel(event)}</dd></div>
                  <div><dt>Cancellation</dt><dd>{event.cancelled ? "cancelled" : "completed"}</dd></div>
                </dl>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
