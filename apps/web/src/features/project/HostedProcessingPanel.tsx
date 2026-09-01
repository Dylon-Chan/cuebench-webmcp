import { useEffect, useRef, useState } from "react";
import {
  CloudUploadError,
  cancelCloudProcessingCopy,
  clearPersistedCloudSession,
  clearPersistedCloudUpload,
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
  const [status, setStatus] = useState<"unavailable" | "loading" | "awaiting" | "verified" | "expired" | "error">(
    siteKey.length === 0 ? "unavailable" : "loading",
  );

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
      setStatus("awaiting");
      widgetId = window.turnstile.render(host.current, {
        sitekey: siteKey,
        action: "cuebench-upload",
        callback: (token) => {
          if (!active) return;
          onTokenChange(token);
          setStatus("verified");
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
    <div
      className="cloud-processing-panel__turnstile"
      aria-label="Anti-abuse verification"
      aria-disabled={disabled}
      data-turnstile-site-key={siteKey}
    >
      <div ref={host} />
      <p role="status">
        {status === "loading" ? "Preparing anti-abuse verification…" : null}
        {status === "awaiting" ? "Anti-abuse check is ready. Complete it to enable cloud processing." : null}
        {status === "verified" ? "Anti-abuse verification is complete." : null}
        {status === "expired" ? "Anti-abuse verification expired. Complete it again before upload." : null}
        {status === "error" ? "Anti-abuse verification could not load. Cloud processing remains unavailable." : null}
      </p>
    </div>
  );
}

export interface HostedProcessingPanelProps {
  readonly projectId: string;
  readonly durationMs: number;
  /** Browser-canonical identity used to reject a stale restored upload receipt. */
  readonly mediaSha256: string;
  /** This is the browser-owned local Blob URL from ProjectStore, never a cloud media URL. */
  readonly sourceObjectUrl: string;
  /**
   * Reads the current non-portable project-instance capability from durable
   * IndexedDB. A replacement import can rotate it while an older tab is open.
   */
  readonly resolveProjectOwnerCapability?: (projectId: string) => Promise<string | null>;
  /** Test override only; production reads VITE_TURNSTILE_SITE_KEY. */
  readonly siteKey?: string;
}

/**
 * The hosted route is optional and never becomes a project store: this panel
 * reads the browser-owned Blob only after disclosure and Turnstile acceptance.
 */
export function HostedProcessingPanel({
  projectId,
  durationMs,
  mediaSha256,
  sourceObjectUrl,
  resolveProjectOwnerCapability,
  siteKey = configuredSiteKey(),
}: HostedProcessingPanelProps) {
  const [accepted, setAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [session, setSession] = useState<{ readonly value: string; readonly expiresAtMs: number } | null>(null);
  const [status, setStatus] = useState("Cloud processing is optional. Your browser remains the canonical project store.");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectOwnerCapability, setProjectOwnerCapability] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<ReturnType<typeof loadPersistedCloudUpload>>(null);
  const [forceNewOperation, setForceNewOperation] = useState(false);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const capability = resolveProjectOwnerCapability === undefined
        ? null
        : await resolveProjectOwnerCapability(projectId);
      if (disposed) return;
      setProjectOwnerCapability(capability);
      setRecovery(capability === null
        ? null
        : loadPersistedCloudUpload(projectId, { sha256: mediaSha256, durationMs }, undefined, capability));
      setForceNewOperation(false);
    })().catch(() => {
      if (!disposed) {
        setProjectOwnerCapability(null);
        setRecovery(null);
      }
    });
    return () => { disposed = true; };
  }, [durationMs, mediaSha256, projectId, resolveProjectOwnerCapability]);
  const currentNow = Date.now();
  const persistedSession = recovery?.session !== undefined && (recovery.sessionExpiresAtMs ?? 0) > currentNow
    ? { value: recovery.session, expiresAtMs: recovery.sessionExpiresAtMs! }
    : null;
  const availableSession = session !== null && session.expiresAtMs > currentNow ? session : persistedSession;
  const operationReceipt = recovery?.operationReceipt ?? null;
  const operationId = recovery?.operationId ?? null;
  const canStart = accepted && siteKey.length > 0 && projectOwnerCapability !== null && (turnstileToken !== null || availableSession !== null) && !busy;
  const canCancel = accepted && siteKey.length > 0 && projectOwnerCapability !== null && operationReceipt !== null && operationId !== null && (availableSession !== null || turnstileToken !== null) && !busy;

  /** Re-read IndexedDB immediately before a cloud request; localStorage is only an opaque receipt cache. */
  const currentOwnerCapability = async (): Promise<string> => {
    const capability = resolveProjectOwnerCapability === undefined
      ? null
      : await resolveProjectOwnerCapability(projectId);
    if (capability === null || !/^[0-9a-f]{64}$/i.test(capability)) {
      throw new CloudUploadError("CueBench needs the durable browser-project owner identity before optional cloud processing.");
    }
    const normalized = capability.toLowerCase();
    setProjectOwnerCapability(normalized);
    return normalized;
  };

  const refreshRecoveryForOwner = (owner: string) => {
    const refreshed = loadPersistedCloudUpload(projectId, { sha256: mediaSha256, durationMs }, undefined, owner);
    setRecovery(refreshed);
    return refreshed;
  };

  const begin = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const anonymous = availableSession === null
        ? await createAnonymousCloudSession({ turnstileToken: turnstileToken!, idempotencyKey: randomOpaqueId() })
        : { session: availableSession.value, expiresAtMs: availableSession.expiresAtMs };
      if (session === null || session.value !== anonymous.session) setSession({ value: anonymous.session, expiresAtMs: anonymous.expiresAtMs });
      if (!sourceObjectUrl.startsWith("blob:")) throw new CloudUploadError("CueBench can only send a browser-owned local media Blob to optional cloud processing.");
      const sourceResponse = await fetch(sourceObjectUrl);
      if (!sourceResponse.ok) throw new CloudUploadError("CueBench could not read the browser-owned local media Blob for cloud processing.");
      const source = await sourceResponse.blob();
      // Resolve only after reading the local Blob. A replacement import can
      // rotate the durable project capability while this older tab is open.
      const owner = await currentOwnerCapability();
      const currentRecovery = refreshRecoveryForOwner(owner);
      const nextOperationId = forceNewOperation ? randomOpaqueId() : currentRecovery?.operationId ?? randomOpaqueId();
      const result = await uploadCloudProcessingCopy({
        session: anonymous.session,
        sessionExpiresAtMs: anonymous.expiresAtMs,
        projectId,
        operationId: nextOperationId,
        source,
        sourceSha256: mediaSha256,
        durationMs,
        projectOwnerCapability: owner,
        disclosureAccepted: true,
      });
      setRecovery(result.operation);
      setForceNewOperation(false);
      setStatus(result.status === "queued"
        ? "Authoritative private-media checks passed and cloud processing is queued. CueBench will request deletion when processing succeeds."
        : `Cloud processing state: ${result.status}.`);
    } catch (cause) {
      if (cause instanceof CloudUploadError && (cause.details.status === 401 || cause.details.status === 403)) {
        clearPersistedCloudSession(projectId);
        setSession(null);
        setTurnstileToken(null);
        if (projectOwnerCapability !== null) refreshRecoveryForOwner(projectOwnerCapability);
        setStatus("CueBench needs a fresh anti-abuse verification before it can resume this private operation. Its opaque recovery receipt was kept.");
      }
      if (cause instanceof CloudUploadError && cause.details.status === 410) {
        clearPersistedCloudUpload(projectId);
        setRecovery(null);
        setForceNewOperation(true);
        setStatus("This temporary private operation reached its recovery expiry and can no longer authorize any action. Start a new operation after completing anti-abuse verification.");
      }
      setError(cause instanceof Error ? cause.message : "CueBench could not begin optional cloud processing.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (operationReceipt === null || operationId === null || busy || (!accepted || siteKey.length === 0) || (availableSession === null && turnstileToken === null)) return;
    setBusy(true);
    setError(null);
    try {
      const owner = await currentOwnerCapability();
      const currentRecovery = refreshRecoveryForOwner(owner);
      if (currentRecovery === null || currentRecovery.operationId !== operationId || currentRecovery.operationReceipt !== operationReceipt) {
        throw new CloudUploadError("This private upload recovery belongs to an older browser-project instance and cannot be resumed after import.");
      }
      const cleanupSession = availableSession === null
        ? await createAnonymousCloudSession({ turnstileToken: turnstileToken!, idempotencyKey: randomOpaqueId(), purpose: "cleanup" })
        : { session: availableSession.value, expiresAtMs: availableSession.expiresAtMs };
      await cancelCloudProcessingCopy({
        session: cleanupSession.session,
        projectId,
        operationId,
        receipt: operationReceipt,
        projectOwnerCapability: owner,
      });
      setRecovery(null);
      setForceNewOperation(false);
      setStatus("CueBench confirmed immediate cleanup of the temporary private cloud copy.");
    } catch (cause) {
      if (cause instanceof CloudUploadError && (cause.details.status === 401 || cause.details.status === 403)) {
        clearPersistedCloudSession(projectId);
        setSession(null);
        setTurnstileToken(null);
        if (projectOwnerCapability !== null) refreshRecoveryForOwner(projectOwnerCapability);
        setStatus("CueBench needs a fresh anti-abuse verification before it can confirm cleanup. The recovery receipt was kept.");
      }
      if (cause instanceof CloudUploadError && cause.details.status === 410) {
        clearPersistedCloudUpload(projectId);
        setRecovery(null);
        setForceNewOperation(true);
        setStatus("This private operation expired before cleanup could be authorized. CueBench's retention reconciler remains responsible for its disclosed deletion ceiling.");
      }
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
        {operationReceipt === null ? null : <button className="button button--outline" type="button" disabled={!canCancel} onClick={() => void cancel()}>Cancel cloud processing and delete copy</button>}
      </div>
      <p role="status">{status}</p>
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
