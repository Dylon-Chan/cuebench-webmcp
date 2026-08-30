import { useEffect, useRef, useState } from "react";
import {
  CloudUploadError,
  cancelCloudProcessingCopy,
  createAnonymousCloudSession,
  loadPersistedCloudUpload,
  uploadCloudProcessingCopy,
} from "./cloud-upload";
import { CloudProcessingDisclosure } from "./CloudProcessingDisclosure";

interface TurnstileApi {
  render: (container: HTMLElement, options: {
    readonly sitekey: string;
    readonly action: string;
    readonly callback: (token: string) => void;
    readonly "expired-callback": () => void;
    readonly "error-callback": () => void;
  }) => string;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const configuredSiteKey = (): string => {
  const value = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  return typeof value === "string" ? value.trim() : "";
};

const randomOpaqueId = (): string => {
  if (globalThis.crypto?.randomUUID !== undefined) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now()}${Math.random().toString(36).slice(2)}`.replaceAll(/[^A-Za-z0-9_-]/g, "");
};

interface TurnstileGateProps {
  readonly siteKey: string;
  readonly disabled: boolean;
  readonly onTokenChange: (token: string | null) => void;
}

/** Renders the official challenge only when a configured public site key is present. */
function TurnstileGate({ siteKey, disabled, onTokenChange }: TurnstileGateProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState(siteKey.length === 0 ? "unavailable" : "loading");

  useEffect(() => {
    onTokenChange(null);
    if (siteKey.length === 0) {
      setStatus("unavailable");
      return undefined;
    }
    let active = true;
    let widgetId: string | null = null;
    const render = () => {
      if (!active || host.current === null || window.turnstile === undefined) return;
      widgetId = window.turnstile.render(host.current, {
        sitekey: siteKey,
        action: "cuebench-upload",
        callback: (token) => {
          if (!active) return;
          onTokenChange(token);
          setStatus("ready");
        },
        "expired-callback": () => {
          if (!active) return;
          onTokenChange(null);
          setStatus("expired");
        },
        "error-callback": () => {
          if (!active) return;
          onTokenChange(null);
          setStatus("error");
        },
      });
      setStatus("ready");
    };
    if (window.turnstile !== undefined) {
      render();
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", render, { once: true });
      script.addEventListener("error", () => {
        if (active) setStatus("error");
      }, { once: true });
      document.head.append(script);
    }
    return () => {
      active = false;
      if (widgetId !== null) window.turnstile?.remove?.(widgetId);
    };
  }, [onTokenChange, siteKey]);

  if (siteKey.length === 0) return <p className="cloud-processing-panel__turnstile" role="status">Cloud processing is unavailable: anti-abuse verification is unavailable in this deployment.</p>;
  return (
    <div className="cloud-processing-panel__turnstile" aria-label="Anti-abuse verification" aria-disabled={disabled}>
      <div ref={host} />
      <p role="status">
        {status === "loading" ? "Preparing anti-abuse verification…" : null}
        {status === "ready" ? "Anti-abuse verification is ready." : null}
        {status === "expired" ? "Anti-abuse verification expired. Complete it again before upload." : null}
        {status === "error" ? "Anti-abuse verification could not load. Cloud processing remains unavailable." : null}
      </p>
    </div>
  );
}

export interface HostedProcessingPanelProps {
  readonly projectId: string;
  readonly durationMs: number;
  /** This is the browser-owned local Blob URL from ProjectStore, never a cloud media URL. */
  readonly sourceObjectUrl: string;
  /** Test override only; production reads VITE_TURNSTILE_SITE_KEY. */
  readonly siteKey?: string;
}

/**
 * The hosted route is optional and never becomes a project store: this panel
 * reads the browser-owned Blob only after disclosure and Turnstile acceptance.
 */
export function HostedProcessingPanel({ projectId, durationMs, sourceObjectUrl, siteKey = configuredSiteKey() }: HostedProcessingPanelProps) {
  const [accepted, setAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [operationReceipt, setOperationReceipt] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [status, setStatus] = useState("Cloud processing is optional. Your browser remains the canonical project store.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumable] = useState(() => loadPersistedCloudUpload(projectId));
  const availableSession = session ?? resumable?.session ?? null;
  const canStart = accepted && siteKey.length > 0 && (turnstileToken !== null || availableSession !== null) && !busy;

  const begin = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const anonymous = availableSession === null
        ? await createAnonymousCloudSession({ turnstileToken: turnstileToken!, idempotencyKey: randomOpaqueId() })
        : { session: availableSession, expiresAtMs: 0 };
      if (session === null) setSession(anonymous.session);
      if (!sourceObjectUrl.startsWith("blob:")) throw new CloudUploadError("CueBench can only send a browser-owned local media Blob to optional cloud processing.");
      const sourceResponse = await fetch(sourceObjectUrl);
      if (!sourceResponse.ok) throw new CloudUploadError("CueBench could not read the browser-owned local media Blob for cloud processing.");
      const source = await sourceResponse.blob();
      const nextOperationId = resumable?.operationId ?? randomOpaqueId();
      const result = await uploadCloudProcessingCopy({
        session: anonymous.session,
        projectId,
        operationId: nextOperationId,
        source,
        durationMs,
        disclosureAccepted: true,
      });
      setOperationReceipt(result.operationReceipt);
      setOperationId(nextOperationId);
      setStatus(result.status === "queued"
        ? "Authoritative private-media checks passed and cloud processing is queued. CueBench will request deletion when processing succeeds."
        : `Cloud processing state: ${result.status}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not begin optional cloud processing.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (availableSession === null || operationReceipt === null || operationId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelCloudProcessingCopy({
        session: availableSession,
        projectId,
        operationId,
        receipt: operationReceipt,
      });
      setOperationReceipt(null);
      setOperationId(null);
      setStatus("CueBench confirmed immediate cleanup of the temporary private cloud copy.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CueBench could not confirm private-copy cleanup. It remains subject to the 24-hour deletion ceiling.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="storage-disclosure cloud-processing-panel" aria-label="Optional cloud processing">
      <CloudProcessingDisclosure accepted={accepted} onAcceptedChange={setAccepted} disabled={busy} />
      <TurnstileGate siteKey={siteKey} disabled={busy || !accepted} onTokenChange={setTurnstileToken} />
      <div className="cloud-processing-panel__actions">
        <button className="button button--outline" type="button" disabled={!canStart} aria-busy={busy} onClick={() => void begin()}>Start cloud processing</button>
        {operationReceipt === null ? null : <button className="button button--outline" type="button" disabled={busy || availableSession === null} onClick={() => void cancel()}>Cancel cloud processing and delete copy</button>}
      </div>
      <p role="status">{status}</p>
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
