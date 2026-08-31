import * as Dialog from "@radix-ui/react-dialog";
import {
  canonicalTrackFormat,
  type CaptionProject,
  type ProjectTrackExportRequest,
} from "@cuebench/domain";
import {
  CueBenchToolRegistry,
  createActiveRunTools,
  createAlwaysTools,
  createAudioDescriptionSelectionTools,
  createCaptionSelectionTools,
  createGapSelectionTools,
  featureDetectModelContext,
  type CueBenchWebMcpRuntime,
  ToolExecutionAbortedError,
  ToolGenerationInspectionError,
  ToolStaleRunError,
  ToolVisibleStateError,
  type ModelContextLike,
  type SelectionToolFamily,
  type WebMcpConfirmationRequest,
  type WebMcpGenerationStatus,
  type WebMcpProfileProposal,
} from "@cuebench/webmcp";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AudioDescriptionGenerationClient } from "../features/generation/ad-generation-client";
import {
  CaptionGenerationClient,
  GenerationClientError,
  type GenerationLifecycleOutcome,
} from "../features/generation/generation-client";
import { narrationPreviewRequestFor } from "../features/review/NarrationPreview";
import { loadPersistedCloudUpload, type PersistedCloudUploadRecovery } from "../features/project/cloud-upload";
import { WebMcpDebugDrawer } from "../features/webmcp/WebMcpDebugDrawer";
import {
  createWebMcpDebugStore,
  isWebMcpDebugEnabled,
  type WebMcpDebugStore,
} from "../features/webmcp/debug-store";
import {
  ProjectInstanceFenceError,
  type ProjectStore,
} from "../features/project/project-store";

const browserAgent = { type: "BrowserAgent" as const, id: "browser-agent" };
const systemExportActor = { type: "System" as const, id: "cuebench-export" };

interface DownloadPublication {
  readonly href: string;
  readonly filename: string;
  /** A download is valid only for the exact project revision that recorded it. */
  readonly sourceProjectId: string;
  readonly sourceProjectRevision: number;
  /** Page-private nonportable project-instance fence; never returned by a tool. */
  readonly sourceProjectInstanceEpoch: number;
  /** One-way durable owner-capability fingerprint; never rendered or returned. */
  readonly sourceProjectInstanceCapabilityFingerprint: string | null;
  /** A same-revision export is published only after this exact anchor exists. */
  readonly visualEpoch: number;
}

interface NarrationPublication {
  readonly href: string;
  readonly sourceProjectId: string;
  readonly sourceProjectRevision: number;
  /** Page-private nonportable project-instance fence; never returned by a tool. */
  readonly sourceProjectInstanceEpoch: number;
  /** One-way durable owner-capability fingerprint; never rendered or returned. */
  readonly sourceProjectInstanceCapabilityFingerprint: string | null;
  readonly beatId: string;
  readonly itemRevision: number;
  readonly measuredDurationMs: number;
  readonly source: "cache" | "fresh";
  /** Same-revision UI publication still needs a committed audio element proof. */
  readonly visualEpoch: number;
}

interface PendingConfirmation {
  readonly request: WebMcpConfirmationRequest;
  readonly resolve: (accepted: boolean) => void;
  readonly removeAbortListener: () => void;
}

interface RegistrationGroupTarget {
  readonly scopeId: string | null;
  readonly toolNames: readonly string[];
  readonly registered: boolean;
}

interface RegistrationTarget {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectInstanceEpoch: number;
  readonly projectInstanceCapabilityFingerprint: string | null;
  readonly projectKey: string;
  readonly runScope: string | null;
  readonly selectionScope: string | null;
  readonly always: RegistrationGroupTarget;
  readonly run: RegistrationGroupTarget;
  readonly selection: RegistrationGroupTarget;
}

interface ProjectInstance {
  readonly projectId: string;
  readonly projectRevision: number;
  /** Opaque browser-store epoch derived from its nonportable instance capability. */
  readonly projectInstanceEpoch: number;
  /** One-way private binding of this page instance to durable owner authority. */
  readonly projectInstanceCapabilityFingerprint: string | null;
}

interface ProjectInstanceOwner {
  readonly projectId: string;
  readonly projectInstanceEpoch: number;
  readonly projectInstanceCapabilityFingerprint: string | null;
}

/** Internal UI-only binding; an agent never receives this opaque epoch. */
export type BoundWebMcpProfileProposal = WebMcpProfileProposal & {
  readonly projectInstanceEpoch: number;
  /** Internal only; this is a one-way token, never an owner capability. */
  readonly projectInstanceCapabilityFingerprint: string | null;
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

export interface WebMcpBridgeProps {
  readonly project: CaptionProject;
  readonly store: ProjectStore;
  /** A test seam; production reads only the browser's native document.modelContext. */
  readonly modelContext?: ModelContextLike | null;
  /** This stores an unapplied diff for the existing Human-only profile-review dialog. */
  readonly onProfileProposal?: (proposal: BoundWebMcpProfileProposal, signal: AbortSignal) => Promise<void> | void;
  /** The workbench owns seek/focus so WebMCP never creates a parallel review clock. */
  readonly onRevealSelection?: (input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat" | "AudioDescriptionGap";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal?: AbortSignal;
    readonly visualEpoch: number;
  }) => boolean | void | Promise<boolean | void>;
  /** Runs the existing Review Docket dirty-draft guard before a Browser Agent persists SelectItem. */
  readonly onPrepareSelectionFocus?: (input: {
    readonly kind: "CaptionCue" | "AudioDescriptionBeat";
    readonly selectionId: string;
    readonly selectionRevision: number;
    readonly playheadMs: number;
    readonly evidenceId?: string;
    readonly signal: AbortSignal;
  }) => boolean | void | Promise<boolean | void>;
  /** The native video remains the only transport clock; no DOM query/parallel clock is created. */
  readonly onReadNativePlayheadMs?: () => number;
  /** Test seam only; production waits a bounded interval for exact host registration settlement. */
  readonly registrationTimeoutMs?: number;
  /**
   * The app passes this only from `?webmcpDebug=1`; a supplied store exists
   * solely to make the opt-in boundary directly testable.
   */
  readonly debugEnabled?: boolean;
  readonly debugStore?: WebMcpDebugStore;
}

const DEFAULT_REGISTRATION_SETTLEMENT_TIMEOUT_MS = 2_000;

const deferred = <T,>(): Deferred<T> => {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  // A React commit may fail registration before the tool invocation starts
  // awaiting this revision. Keep the original rejection available to that
  // invocation without allowing an unhandled-rejection side channel.
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (reason) => reject?.(reason),
  };
};

const namesMatch = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((name, index) => name === right[index])
);

const registrationGroupTarget = (
  available: boolean,
  scopeId: string | null,
  tools: readonly { readonly name: string }[],
): RegistrationGroupTarget => ({
  scopeId,
  toolNames: tools.map((tool) => tool.name),
  registered: available && tools.length > 0,
});

const assertExactRegistryTarget = (
  registry: CueBenchToolRegistry,
  target: RegistrationTarget,
): void => {
  const snapshot = registry.snapshot();
  const matches = (actual: { readonly scopeId: string | null; readonly toolNames: readonly string[]; readonly registered: boolean }, expected: RegistrationGroupTarget): boolean => (
    actual.scopeId === expected.scopeId
    && actual.registered === expected.registered
    && namesMatch(actual.toolNames, expected.toolNames)
  );
  if (
    snapshot.available !== registry.available
    || !matches(snapshot.always, target.always)
    || !matches(snapshot.run, target.run)
    || !matches(snapshot.selection, target.selection)
  ) throw new ToolVisibleStateError();
};

const waitForRegistrationSettlement = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ToolVisibleStateError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
};

const opaqueId = (prefix: string): string => {
  const id = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/gu, "")
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`.slice(0, 128);
};

const outputFormatMimeType = (format: "vtt" | "srt" | "ad-txt"): string => (
  format === "vtt" ? "text/vtt;charset=utf-8"
    : format === "srt" ? "application/x-subrip;charset=utf-8"
      : "text/plain;charset=utf-8"
);

const sanitizeGenerationWarning = (warning: string): string => Array.from(warning)
  .map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  })
  .join("")
  .trim()
  .slice(0, 500);

const statusForTool = (
  status: {
    readonly runId: string;
    readonly targetTrack: "Captions" | "AudioDescriptions";
    readonly stage: string;
    readonly progress?: number | undefined;
    readonly warnings?: readonly unknown[] | undefined;
    readonly retryable?: boolean | undefined;
    readonly code?: string | undefined;
  },
  receiptState: "available" | "missing" | "expired",
): WebMcpGenerationStatus => ({
  runId: status.runId,
  targetTrack: status.targetTrack,
  stage: status.stage,
  progress: typeof status.progress === "number" ? status.progress : null,
  // Hosted lifecycle warnings are not transcript/media text. Keep only a
  // bounded, control-character-free page-safe subset for the tool response.
  warnings: [...new Set((status.warnings ?? [])
    .filter((warning): warning is string => typeof warning === "string")
    .map(sanitizeGenerationWarning)
    .filter((warning) => warning.length > 0))].slice(0, 20),
  retryable: typeof status.retryable === "boolean" ? status.retryable : null,
  code: typeof status.code === "string" ? status.code.slice(0, 100) : null,
  receiptState,
});

const lifecycleStatusForTool = (outcome: GenerationLifecycleOutcome): WebMcpGenerationStatus => statusForTool({
  runId: outcome.runId,
  targetTrack: outcome.targetTrack,
  stage: outcome.disposition === "accepted-unknown" ? "AcceptedUnknown" : "LifecyclePending",
  warnings: [
    outcome.disposition === "accepted-unknown"
      ? "The hosted run may be accepted; inspect this exact run before retrying."
      : "CueBench retained this run identity for lifecycle recovery.",
  ],
  retryable: true,
  code: outcome.disposition === "accepted-unknown" ? "GENERATION_ACCEPTED_UNKNOWN" : "GENERATION_LIFECYCLE_PENDING",
}, outcome.receiptState ?? (outcome.operation === "cancel" ? "available" : "missing"));

const lifecycleOutcomeFrom = (error: unknown): GenerationLifecycleOutcome | null => (
  error instanceof GenerationClientError ? error.details.lifecycleOutcome ?? null : null
);

const throwIfToolAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new ToolExecutionAbortedError();
};

const projectInstanceEpochFor = (store: ProjectStore): number => {
  const epoch = (store as unknown as { readonly getProjectInstanceEpoch?: () => number }).getProjectInstanceEpoch?.();
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
};

const projectInstanceCapabilityFingerprintFor = (
  store: ProjectStore,
  project: Pick<CaptionProject, "projectId">,
): string | null => {
  const fence = (store as unknown as {
    readonly getProjectInstanceFence?: () => {
      readonly projectId: string;
      readonly projectInstanceEpoch: number;
      readonly projectInstanceCapabilityFingerprint?: string;
    } | null;
  }).getProjectInstanceFence?.();
  return fence?.projectId === project.projectId
    && fence.projectInstanceEpoch === projectInstanceEpochFor(store)
    && typeof fence.projectInstanceCapabilityFingerprint === "string"
    ? fence.projectInstanceCapabilityFingerprint
    : null;
};

const projectInstanceFor = (
  project: Pick<CaptionProject, "projectId" | "projectRevision">,
  projectInstanceEpoch: number,
  projectInstanceCapabilityFingerprint: string | null = null,
): ProjectInstance => ({
  projectId: project.projectId,
  projectRevision: project.projectRevision,
  projectInstanceEpoch,
  projectInstanceCapabilityFingerprint,
});

const projectInstanceForStore = (
  project: Pick<CaptionProject, "projectId" | "projectRevision">,
  store: ProjectStore,
): ProjectInstance => projectInstanceFor(
  project,
  projectInstanceEpochFor(store),
  projectInstanceCapabilityFingerprintFor(store, project),
);

/** Never pass the raw ProjectStore into an agent-triggered generation client. */
const boundGenerationStoreFor = (store: ProjectStore, project: ProjectInstance) => store.bindGenerationStore({
  projectId: project.projectId,
  projectInstanceEpoch: project.projectInstanceEpoch,
  ...(project.projectInstanceCapabilityFingerprint === null ? {} : {
    projectInstanceCapabilityFingerprint: project.projectInstanceCapabilityFingerprint,
  }),
});

/** Never pass the raw narration gateway into an agent-triggered preview. */
const boundNarrationPreviewGatewayFor = (store: ProjectStore, project: ProjectInstance) => store.bindNarrationPreviewGateway({
  projectId: project.projectId,
  projectInstanceEpoch: project.projectInstanceEpoch,
  ...(project.projectInstanceCapabilityFingerprint === null ? {} : {
    projectInstanceCapabilityFingerprint: project.projectInstanceCapabilityFingerprint,
  }),
});

const projectInstanceKey = (project: ProjectInstance): string => (
  `${project.projectId}:i${project.projectInstanceEpoch}:f${project.projectInstanceCapabilityFingerprint ?? "page"}:r${project.projectRevision}`
);

const sameProjectInstance = (
  candidate: Pick<CaptionProject, "projectId" | "projectRevision"> | null,
  expected: ProjectInstance,
  candidateInstanceEpoch: number,
  candidateInstanceCapabilityFingerprint: string | null = expected.projectInstanceCapabilityFingerprint,
): boolean => candidate !== null
  && candidate.projectId === expected.projectId
  && candidate.projectRevision === expected.projectRevision
  && candidateInstanceEpoch === expected.projectInstanceEpoch
  && candidateInstanceCapabilityFingerprint === expected.projectInstanceCapabilityFingerprint;

const sameProjectOwner = (
  candidate: Pick<CaptionProject, "projectId"> | null,
  expected: ProjectInstanceOwner,
  candidateInstanceEpoch: number,
  candidateInstanceCapabilityFingerprint: string | null = expected.projectInstanceCapabilityFingerprint,
): boolean => candidate !== null
  && candidate.projectId === expected.projectId
  && candidateInstanceEpoch === expected.projectInstanceEpoch
  && candidateInstanceCapabilityFingerprint === expected.projectInstanceCapabilityFingerprint;

const sameProjectInstanceForStore = (
  store: ProjectStore,
  candidate: Pick<CaptionProject, "projectId" | "projectRevision"> | null,
  expected: ProjectInstance,
): boolean => sameProjectInstance(
  candidate,
  expected,
  projectInstanceEpochFor(store),
  candidate === null ? null : projectInstanceCapabilityFingerprintFor(store, candidate),
);

const sameProjectOwnerForStore = (
  store: ProjectStore,
  candidate: Pick<CaptionProject, "projectId"> | null,
  expected: ProjectInstanceOwner,
): boolean => sameProjectOwner(
  candidate,
  expected,
  projectInstanceEpochFor(store),
  candidate === null ? null : projectInstanceCapabilityFingerprintFor(store, candidate),
);

const selectionFamilyFor = (
  runtime: CueBenchWebMcpRuntime,
  project: CaptionProject,
  projectInstance: ProjectInstance,
): SelectionToolFamily | null => {
  const selected = project.selectedItem;
  if (selected === null) return null;
  const scopeId = `${projectInstanceKey(projectInstance)}:${selected.kind}:${selected.itemId}:r${selected.itemRevision}`;
  if (selected.kind === "CaptionCue") return { scopeId, tools: createCaptionSelectionTools(runtime) };
  if (selected.kind === "AudioDescriptionBeat") return { scopeId, tools: createAudioDescriptionSelectionTools(runtime) };
  return { scopeId, tools: createGapSelectionTools(runtime) };
};

const validGenerationUpload = (
  upload: PersistedCloudUploadRecovery | null,
  project: CaptionProject,
): upload is PersistedCloudUploadRecovery & { readonly session: string; readonly operationReceipt: string } => (
  upload !== null
  && typeof upload.session === "string" && upload.session.length > 0
  && typeof upload.operationReceipt === "string" && upload.operationReceipt.length > 0
  && upload.sourceSha256.toLowerCase() === project.media.sha256.toLowerCase()
  && upload.durationMs === project.media.durationMs
);

const downloadMatchesProject = (
  publication: DownloadPublication,
  candidate: CaptionProject | null,
  candidateInstanceEpoch: number,
  candidateInstanceCapabilityFingerprint: string | null,
): boolean => candidate !== null
  && publication.sourceProjectId === candidate.projectId
  && publication.sourceProjectRevision === candidate.projectRevision
  && publication.sourceProjectInstanceEpoch === candidateInstanceEpoch
  && publication.sourceProjectInstanceCapabilityFingerprint === candidateInstanceCapabilityFingerprint;

const narrationMatchesProject = (
  publication: NarrationPublication,
  candidate: CaptionProject | null,
  candidateInstanceEpoch: number,
  candidateInstanceCapabilityFingerprint: string | null,
): boolean => {
  if (
    candidate === null
    || publication.sourceProjectId !== candidate.projectId
    || publication.sourceProjectRevision !== candidate.projectRevision
    || publication.sourceProjectInstanceEpoch !== candidateInstanceEpoch
    || publication.sourceProjectInstanceCapabilityFingerprint !== candidateInstanceCapabilityFingerprint
  ) return false;
  const selected = candidate.selectedItem;
  const beat = candidate.audioDescriptions.items[publication.beatId];
  return selected?.kind === "AudioDescriptionBeat"
    && selected.itemId === publication.beatId
    && selected.itemRevision === publication.itemRevision
    && beat !== undefined
    && beat.supersededByRunId === null
    && beat.current.itemRevision === publication.itemRevision;
};

/**
 * The page-owned WebMCP adapter. It never replaces Human controls: it gives a
 * Browser Agent the same persistent command boundary, visible timeline, and
 * explicit confirmation dialogs already used by the ordinary workbench.
 */
export function WebMcpBridge({ project, store, modelContext, onProfileProposal, onRevealSelection, onPrepareSelectionFocus, onReadNativePlayheadMs, registrationTimeoutMs, debugEnabled, debugStore: suppliedDebugStore }: WebMcpBridgeProps) {
  const projectRef = useRef(project);
  const storeRef = useRef(store);
  const profileProposalRef = useRef(onProfileProposal);
  const revealSelectionRef = useRef(onRevealSelection);
  const prepareSelectionFocusRef = useRef(onPrepareSelectionFocus);
  const playheadReaderRef = useRef(onReadNativePlayheadMs);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const confirmationRef = useRef<PendingConfirmation | null>(null);
  const [download, setDownload] = useState<DownloadPublication | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const downloadVisualEpochRef = useRef(0);
  const downloadPublicationWaitersRef = useRef(new Map<number, Deferred<void>>());
  /** Invalidates async browser-publication continuations at unmount. */
  const mountedRef = useRef(true);
  const publicationOwnerEpochRef = useRef(0);
  const [narration, setNarration] = useState<NarrationPublication | null>(null);
  const narrationUrlRef = useRef<string | null>(null);
  /** The producing bound gateway owns URL revocation; cleanup never reopens a raw gateway. */
  const narrationRevokeRef = useRef<(url: string) => void>((url) => {
    try { URL.revokeObjectURL(url); } catch { /* best-effort page cleanup */ }
  });
  const narrationVisualEpochRef = useRef(0);
  const narrationPublicationWaitersRef = useRef(new Map<number, Deferred<void>>());
  const focusVisualEpochRef = useRef(0);
  const visibleProjectKeyRef = useRef(projectInstanceKey(projectInstanceForStore(project, store)));
  const registrationTimeoutRef = useRef(Math.max(1, Math.trunc(registrationTimeoutMs ?? DEFAULT_REGISTRATION_SETTLEMENT_TIMEOUT_MS)));
  const registryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const revisionRegistrationsRef = useRef(new Map<string, Promise<RegistrationTarget>>());
  const revisionRegistrationTargetsRef = useRef(new Map<string, RegistrationTarget>());
  const revisionRegistrationWaitersRef = useRef(new Map<string, Deferred<RegistrationTarget>>());
  const registryRef = useRef<CueBenchToolRegistry | null>(null);
  const runtimeRef = useRef<CueBenchWebMcpRuntime | null>(null);
  const debugStoreRef = useRef<WebMcpDebugStore | null>(null);
  const debugRequested = debugEnabled ?? isWebMcpDebugEnabled();

  // The explicit query/prop gate is authoritative. In particular, a supplied
  // test store never turns diagnostics on by itself: without the exact opt-in
  // there is no observer, drawer, or metadata capture seam at all.
  if (debugRequested && debugStoreRef.current === null) {
    debugStoreRef.current = suppliedDebugStore ?? createWebMcpDebugStore(true);
  }
  const debugStore = debugRequested ? debugStoreRef.current : null;

  projectRef.current = project;
  storeRef.current = store;
  profileProposalRef.current = onProfileProposal;
  revealSelectionRef.current = onRevealSelection;
  prepareSelectionFocusRef.current = onPrepareSelectionFocus;
  playheadReaderRef.current = onReadNativePlayheadMs;
  registrationTimeoutRef.current = Math.max(1, Math.trunc(registrationTimeoutMs ?? DEFAULT_REGISTRATION_SETTLEMENT_TIMEOUT_MS));

  const currentProjectInstance = useCallback((): ProjectInstance | null => {
    const current = storeRef.current.getSnapshot().project;
    return current === null
      ? null
      : projectInstanceForStore(current, storeRef.current);
  }, []);

  const settleConfirmation = useCallback((accepted: boolean) => {
    const pending = confirmationRef.current;
    if (pending === null) return;
    confirmationRef.current = null;
    pending.removeAbortListener();
    setConfirmation(null);
    pending.resolve(accepted);
  }, []);

  const requestConfirmation = useCallback((request: WebMcpConfirmationRequest, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || confirmationRef.current !== null) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => settleConfirmation(false);
      signal.addEventListener("abort", onAbort, { once: true });
      const pending: PendingConfirmation = {
        request,
        resolve,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      };
      confirmationRef.current = pending;
      setConfirmation(pending);
    });
  }, [settleConfirmation]);

  /**
   * Await the exact project-instance registration produced by React. Numeric
   * revisions intentionally are not enough here: importing a second project
   * may reproduce a revision and selected-item tuple verbatim.
  */
  const afterVisibleChangeForProject = useCallback(async (owner: ProjectInstanceOwner): Promise<void> => {
    const visible = storeRef.current.getSnapshot().project;
    if (visible === null || !sameProjectOwnerForStore(storeRef.current, visible, owner)) throw new ToolVisibleStateError();
    const targetInstance = projectInstanceForStore(visible, storeRef.current);
    const targetKey = projectInstanceKey(targetInstance);
    let waiter = revisionRegistrationWaitersRef.current.get(targetKey);
    if (waiter === undefined) {
      waiter = deferred<RegistrationTarget>();
      revisionRegistrationWaitersRef.current.set(targetKey, waiter);
    }
    try {
      const registration = revisionRegistrationsRef.current.get(targetKey) ?? waiter.promise;
      const target = await waitForRegistrationSettlement(registration, registrationTimeoutRef.current);
      const current = storeRef.current.getSnapshot().project;
      if (
        !sameProjectInstanceForStore(storeRef.current, current, targetInstance)
        || visibleProjectKeyRef.current !== targetKey
        || target.projectId !== targetInstance.projectId
        || target.projectRevision !== targetInstance.projectRevision
        || target.projectInstanceEpoch !== targetInstance.projectInstanceEpoch
        || target.projectInstanceCapabilityFingerprint !== targetInstance.projectInstanceCapabilityFingerprint
        || target.projectKey !== targetKey
        || revisionRegistrationTargetsRef.current.get(targetKey) !== target
      ) throw new ToolVisibleStateError();
      const registry = registryRef.current;
      if (registry === null) throw new ToolVisibleStateError();
      assertExactRegistryTarget(registry, target);
    } catch {
      throw new ToolVisibleStateError();
    }
  }, []);

  const afterVisibleChange = useCallback(async (): Promise<void> => {
    const current = currentProjectInstance();
    if (current === null) throw new ToolVisibleStateError();
    await afterVisibleChangeForProject({
      projectId: current.projectId,
      projectInstanceEpoch: current.projectInstanceEpoch,
      projectInstanceCapabilityFingerprint: current.projectInstanceCapabilityFingerprint,
    });
  }, [afterVisibleChangeForProject, currentProjectInstance]);

  const assertPublicationOwner = useCallback((ownerEpoch: number): void => {
    if (!mountedRef.current || publicationOwnerEpochRef.current !== ownerEpoch) {
      throw new ToolVisibleStateError();
    }
  }, []);

  if (runtimeRef.current === null) {
    runtimeRef.current = {
      browserAgent,
      getProject: () => storeRef.current.getSnapshot().project,
      executeCommand: (command) => storeRef.current.executeCommand(command),
      getPlayheadMs: () => Math.max(0, Math.trunc(playheadReaderRef.current?.() ?? 0)),
      afterVisibleChange,
      revealSelection: async (input) => {
        const wasAborted = () => input.signal?.aborted === true;
        if (wasAborted()) throw new ToolExecutionAbortedError();
        const visualEpoch = focusVisualEpochRef.current + 1;
        focusVisualEpochRef.current = visualEpoch;
        const revealed = await revealSelectionRef.current?.({ ...input, visualEpoch });
        if (wasAborted()) throw new ToolExecutionAbortedError();
        if (revealed === false) throw new ToolExecutionAbortedError();
        await afterVisibleChange();
      },
      prepareSelectionFocus: async (input) => {
        if (input.signal.aborted) throw new ToolExecutionAbortedError();
        const prepared = await prepareSelectionFocusRef.current?.(input);
        if (input.signal.aborted) throw new ToolExecutionAbortedError();
        if (prepared === false) return false;
        // The preflight changes only local draft/dialog state. Require the old
        // project revision and currently registered family to remain proven
        // before the caller persists its BrowserAgent SelectItem.
        await afterVisibleChange();
        return true;
      },
      requestConfirmation,
      publishProfileProposal: async (proposal, signal) => {
        throwIfToolAborted(signal);
        const owner = currentProjectInstance();
        if (owner === null) throw new ToolVisibleStateError();
        try {
          await profileProposalRef.current?.({
            ...proposal,
            projectInstanceEpoch: owner.projectInstanceEpoch,
            projectInstanceCapabilityFingerprint: owner.projectInstanceCapabilityFingerprint,
          }, signal);
        } catch (error) {
          if (signal.aborted) throw new ToolExecutionAbortedError();
          throw error;
        }
        throwIfToolAborted(signal);
      },
      exportTrack: async (input) => {
        throwIfToolAborted(input.signal);
        const expectedProject = projectInstanceForStore(input.project, storeRef.current);
        const publicationOwnerEpoch = publicationOwnerEpochRef.current;
        const assertExactExportProject = (): void => {
          if (!sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, expectedProject)) {
            throw new ToolVisibleStateError();
          }
        };
        assertPublicationOwner(publicationOwnerEpoch);
        assertExactExportProject();
        const request: ProjectTrackExportRequest = {
          project: input.project,
          trackKind: input.trackKind,
          format: canonicalTrackFormat(input.format),
          disposition: input.disposition,
        };
        const fresh = await storeRef.current.prepareFreshTrackExport(request);
        throwIfToolAborted(input.signal);
        assertPublicationOwner(publicationOwnerEpoch);
        assertExactExportProject();
        if (!sameProjectInstance(
          fresh.project,
          expectedProject,
          expectedProject.projectInstanceEpoch,
          expectedProject.projectInstanceCapabilityFingerprint,
        )) throw new ToolVisibleStateError();
        if (typeof URL.createObjectURL !== "function") throw new Error("CueBench cannot offer a browser download in this environment.");
        // A download affordance is part of the recordable export outcome. Do
        // not write Court Record history before its Blob URL actually exists.
        let href: string | null = null;
        let ownsHref = false;
        try {
          href = URL.createObjectURL(new Blob([fresh.prepared.text], { type: outputFormatMimeType(input.format) }));
          throwIfToolAborted(input.signal);
          throwIfToolAborted(input.signal);
          assertPublicationOwner(publicationOwnerEpoch);
          assertExactExportProject();
          const result = await storeRef.current.executeCommand({
            type: "RecordExportRoundTrip",
            actor: systemExportActor,
            expectedProjectRevision: fresh.project.projectRevision,
            exportId: opaqueId("export"),
            trackKind: input.trackKind,
            format: canonicalTrackFormat(input.format),
            disposition: input.disposition,
            verifiedAtMs: Date.now(),
            text: fresh.prepared.text,
          }, {
            projectId: expectedProject.projectId,
            projectInstanceEpoch: expectedProject.projectInstanceEpoch,
            ...(expectedProject.projectInstanceCapabilityFingerprint === null ? {} : {
              projectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint,
            }),
          });
          if (result.error !== undefined) throw new Error("CueBench could not record this verified export.");
          // The record is durable even if the page disappeared while it was
          // pending. Mark it before testing ownership so the structured result
          // cannot claim the export was unchanged.
          input.onCommitted?.();
          assertPublicationOwner(publicationOwnerEpoch);
          if (!sameProjectOwnerForStore(storeRef.current, result.project, expectedProject)
            || !sameProjectInstance(
              storeRef.current.getSnapshot().project,
              projectInstanceFor(
                result.project,
                expectedProject.projectInstanceEpoch,
                expectedProject.projectInstanceCapabilityFingerprint,
              ),
              projectInstanceEpochFor(storeRef.current),
              projectInstanceCapabilityFingerprintFor(storeRef.current, result.project),
            )) {
            throw new ToolVisibleStateError();
          }
          if (downloadUrlRef.current !== null) URL.revokeObjectURL(downloadUrlRef.current);
          for (const waiter of downloadPublicationWaitersRef.current.values()) {
            waiter.reject(new ToolVisibleStateError());
          }
          downloadPublicationWaitersRef.current.clear();
          downloadUrlRef.current = href;
          ownsHref = true;
          const visualEpoch = downloadVisualEpochRef.current + 1;
          downloadVisualEpochRef.current = visualEpoch;
          const visualPublication = deferred<void>();
          downloadPublicationWaitersRef.current.set(visualEpoch, visualPublication);
          // Do not call React state setters after unmount. The ownership check
          // is intentionally immediately before the first publication write.
          assertPublicationOwner(publicationOwnerEpoch);
          setDownload({
            href,
            filename: fresh.prepared.filename,
            sourceProjectId: result.project.projectId,
            sourceProjectRevision: result.project.projectRevision,
            sourceProjectInstanceEpoch: expectedProject.projectInstanceEpoch,
            sourceProjectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint,
            visualEpoch,
          });
          // Export is not complete until the exact bound browser download
          // anchor is visible. Project/registry revision settlement alone is
          // insufficient because this publication does not add another command.
          await visualPublication.promise;
          assertPublicationOwner(publicationOwnerEpoch);
          return { prepared: fresh.prepared, published: true };
        } catch (error) {
          if (!ownsHref && href !== null) URL.revokeObjectURL(href);
          throw error;
        }
      },
      startGeneration: async ({ project: currentProject, targetTrack, onCommitted, signal, postCommitSignal }) => {
        const expectedProject = projectInstanceForStore(currentProject, storeRef.current);
        const generationStore = boundGenerationStoreFor(storeRef.current, expectedProject);
        const assertExactGenerationProject = (): void => {
          if (!sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, expectedProject)) throw new ToolVisibleStateError();
        };
        throwIfToolAborted(signal);
        assertExactGenerationProject();
        let owner: string | null;
        try {
          owner = await generationStore.getCloudProjectOwnerCapability(currentProject.projectId);
        } catch (error) {
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          throw error;
        }
        throwIfToolAborted(signal);
        assertExactGenerationProject();
        const upload = owner === null
          ? null
          : loadPersistedCloudUpload(
            currentProject.projectId,
            { sha256: currentProject.media.sha256, durationMs: currentProject.media.durationMs },
            undefined,
            owner,
          );
        if (!validGenerationUpload(upload, currentProject)) {
          throw new Error("Complete optional cloud processing in the visible CueBench UI before starting generation.");
        }
        let lifecycleSettlement: Promise<void> | null = null;
        const onLifecycleEvent = () => {
          onCommitted?.();
          // A start can acquire then compensate a lease. Preserve the most
          // recent event's exact visible target so an error is returned only
          // after the original tool family is restored.
          lifecycleSettlement = afterVisibleChangeForProject({
            projectId: expectedProject.projectId,
            projectInstanceEpoch: expectedProject.projectInstanceEpoch,
            projectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint,
          });
          void lifecycleSettlement.catch(() => undefined);
        };
        try {
          if (targetTrack === "Captions") {
            const started = await new CaptionGenerationClient().start({ project: currentProject, store: generationStore, upload, signal, ...(postCommitSignal === undefined ? {} : { postCommitSignal }), onLifecycleEvent });
            if (lifecycleSettlement !== null) await lifecycleSettlement;
            return { run: statusForTool(started.status, "available"), lifecycle: "ready" as const };
          }
          const started = await new AudioDescriptionGenerationClient().start({ project: currentProject, store: generationStore, upload, signal, ...(postCommitSignal === undefined ? {} : { postCommitSignal }), onLifecycleEvent });
          if (lifecycleSettlement !== null) await lifecycleSettlement;
          return { run: statusForTool(started.status, "available"), lifecycle: "ready" as const };
        } catch (error) {
          if (lifecycleSettlement !== null) await lifecycleSettlement;
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          const outcome = lifecycleOutcomeFrom(error);
          if (outcome === null) throw error;
          return { run: lifecycleStatusForTool(outcome), lifecycle: outcome.disposition };
        }
      },
      inspectGeneration: async ({ project: currentProject, signal }) => {
        const expectedProject = projectInstanceForStore(currentProject, storeRef.current);
        const generationStore = boundGenerationStoreFor(storeRef.current, expectedProject);
        throwIfToolAborted(signal);
        const active = currentProject.activeGenerationRun;
        if (active === null) return null;
        const assertExactRun = (): void => {
          const visible = storeRef.current.getSnapshot().project;
          if (
            visible === null
            || !sameProjectInstanceForStore(storeRef.current, visible, expectedProject)
            || visible.activeGenerationRun?.runId !== active.runId
            || visible.activeGenerationRun?.targetTrack !== active.targetTrack
          ) throw new ToolStaleRunError();
          // If a project/run replacement synchronously aborted this dynamic
          // family, report the more precise stale-run identity rather than a
          // generic scoped-selection cancellation.
          throwIfToolAborted(signal);
        };
        try {
          if (active.targetTrack === "Captions") {
            const client = new CaptionGenerationClient();
            const receipt = await client.peekStoredReceipt(generationStore, currentProject, active.runId);
            assertExactRun();
            if (receipt === null) return statusForTool({ ...active, stage: "Queued" }, "missing");
            if (Date.now() >= receipt.retentionExpiresAtMs) return statusForTool({ ...active, stage: "LifecyclePending", warnings: ["The retained browser receipt has expired; no status request was made."], retryable: true, code: "RECOVERY_ARTIFACT_EXPIRED" }, "expired");
            const status = await client.status(receipt, signal);
            assertExactRun();
            return statusForTool(status, "available");
          }
          const client = new AudioDescriptionGenerationClient();
          const receipt = await client.peekStoredReceipt(generationStore, currentProject, active.runId);
          assertExactRun();
          if (receipt === null) return statusForTool({ ...active, stage: "Queued" }, "missing");
          if (Date.now() >= receipt.retentionExpiresAtMs) return statusForTool({ ...active, stage: "LifecyclePending", warnings: ["The retained browser receipt has expired; no status request was made."], retryable: true, code: "RECOVERY_ARTIFACT_EXPIRED" }, "expired");
          const status = await client.status(receipt, signal);
          assertExactRun();
          return statusForTool(status, "available");
        } catch (error) {
          if (error instanceof ToolExecutionAbortedError || error instanceof ToolStaleRunError) throw error;
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          if (error instanceof GenerationClientError) throw new ToolGenerationInspectionError();
          throw error;
        }
      },
      cancelGeneration: async ({ project: currentProject, onCommitted, signal, postCommitSignal }) => {
        const expectedProject = projectInstanceForStore(currentProject, storeRef.current);
        const generationStore = boundGenerationStoreFor(storeRef.current, expectedProject);
        const assertExactGenerationProject = (): void => {
          if (!sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, expectedProject)) throw new ToolVisibleStateError();
        };
        throwIfToolAborted(signal);
        assertExactGenerationProject();
        const active = currentProject.activeGenerationRun;
        if (active === null) throw new Error("There is no active CueBench generation run to cancel.");
        if (active.targetTrack === "Captions") {
          const client = new CaptionGenerationClient();
          let receipt;
          try {
            receipt = await client.peekStoredReceipt(generationStore, currentProject, active.runId);
          } catch (error) {
            if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
            throw error;
          }
          throwIfToolAborted(signal);
          assertExactGenerationProject();
          if (receipt === null) throw new Error("CueBench cannot cancel a run without its durable browser recovery receipt.");
          if (Date.now() >= receipt.retentionExpiresAtMs) {
            return { run: statusForTool({ ...active, stage: "LifecyclePending", warnings: ["The retained browser receipt has expired; inspect recovery state."], retryable: true, code: "RECOVERY_ARTIFACT_EXPIRED" }, "expired"), lifecycle: "lifecycle-pending" as const };
          }
          try {
            const status = await client.cancel({ project: currentProject, store: generationStore, receipt, actor: browserAgent, signal, ...(postCommitSignal === undefined ? {} : { postCommitSignal }), onLifecycleEvent: () => { onCommitted?.(); void afterVisibleChangeForProject({ projectId: expectedProject.projectId, projectInstanceEpoch: expectedProject.projectInstanceEpoch, projectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint }).catch(() => undefined); } });
            return { run: statusForTool(status, "available"), lifecycle: "ready" as const };
          } catch (error) {
            if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
            const outcome = lifecycleOutcomeFrom(error);
            if (outcome === null) throw error;
            return { run: lifecycleStatusForTool(outcome), lifecycle: outcome.disposition };
          }
        }
        const client = new AudioDescriptionGenerationClient();
        let receipt;
        try {
          receipt = await client.peekStoredReceipt(generationStore, currentProject, active.runId);
        } catch (error) {
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          throw error;
        }
        throwIfToolAborted(signal);
        assertExactGenerationProject();
        if (receipt === null) throw new Error("CueBench cannot cancel a run without its durable browser recovery receipt.");
        if (Date.now() >= receipt.retentionExpiresAtMs) {
          return { run: statusForTool({ ...active, stage: "LifecyclePending", warnings: ["The retained browser receipt has expired; inspect recovery state."], retryable: true, code: "RECOVERY_ARTIFACT_EXPIRED" }, "expired"), lifecycle: "lifecycle-pending" as const };
        }
        try {
          const status = await client.cancel({ project: currentProject, store: generationStore, receipt, actor: browserAgent, signal, ...(postCommitSignal === undefined ? {} : { postCommitSignal }), onLifecycleEvent: () => { onCommitted?.(); void afterVisibleChangeForProject({ projectId: expectedProject.projectId, projectInstanceEpoch: expectedProject.projectInstanceEpoch, projectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint }).catch(() => undefined); } });
          return { run: statusForTool(status, "available"), lifecycle: "ready" as const };
        } catch (error) {
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          const outcome = lifecycleOutcomeFrom(error);
          if (outcome === null) throw error;
          return { run: lifecycleStatusForTool(outcome), lifecycle: outcome.disposition };
        }
      },
      previewNarration: async ({ project: currentProject, beatId, itemRevision, signal, onCommitted }) => {
        try {
          const expectedProject = projectInstanceForStore(currentProject, storeRef.current);
          const assertCurrent = (): CaptionProject => {
            if (signal.aborted) throw new ToolExecutionAbortedError();
            const visible = storeRef.current.getSnapshot().project;
            const selected = visible?.selectedItem;
            const visibleBeat = visible?.audioDescriptions.items[beatId];
            if (
              visible === null
              || !sameProjectInstanceForStore(storeRef.current, visible, expectedProject)
              || selected?.kind !== "AudioDescriptionBeat"
              || selected.itemId !== beatId
              || selected.itemRevision !== itemRevision
              || visibleBeat === undefined
              || visibleBeat.supersededByRunId !== null
              || visibleBeat.current.itemRevision !== itemRevision
            ) throw new ToolExecutionAbortedError();
            return visible;
          };
          const initial = assertCurrent();
          const beat = initial.audioDescriptions.items[beatId]!;
          const gateway = boundNarrationPreviewGatewayFor(storeRef.current, expectedProject);
          narrationRevokeRef.current = gateway.revokeObjectUrl;
          const request = narrationPreviewRequestFor(initial.projectId, beat);
          const cached = await gateway.loadCached({ projectId: request.projectId, cacheKey: request.cacheKey });
          assertCurrent();
          const resolved = cached === undefined
            ? await (async () => {
              // The hosted speech request can consume quota. Mark the attempt
              // before dispatch so an abort is never reported as unchanged.
              onCommitted?.();
              const synthesized = await gateway.synthesize(request, { signal });
              assertCurrent();
              const measuredDurationMs = await gateway.measureDurationMs(synthesized.blob);
              assertCurrent();
              // Saving the exact full-input cache is also a durable browser
              // effect. It may survive a cancelled agent invocation, but never
              // produces a stale visible preview.
              onCommitted?.();
              await gateway.saveCached({ ...request, blob: synthesized.blob, contentType: synthesized.contentType, measuredDurationMs });
              assertCurrent();
              return { blob: synthesized.blob, measuredDurationMs, source: "fresh" as const };
            })()
            : { blob: cached.blob, measuredDurationMs: cached.measuredDurationMs, source: "cache" as const };
          assertCurrent();
          let href: string | null = null;
          try {
            href = gateway.createObjectUrl(resolved.blob);
            // Creating a URL can itself fail in a hostile browser. Do not revoke
            // the current valid preview until a replacement actually exists.
            assertCurrent();
          } catch (error) {
            if (href !== null) gateway.revokeObjectUrl(href);
            throw error;
          }
          if (narrationUrlRef.current !== null) gateway.revokeObjectUrl(narrationUrlRef.current);
          for (const waiter of narrationPublicationWaitersRef.current.values()) {
            waiter.reject(new ToolVisibleStateError());
          }
          narrationPublicationWaitersRef.current.clear();
          narrationUrlRef.current = href;
          const visualEpoch = narrationVisualEpochRef.current + 1;
          narrationVisualEpochRef.current = visualEpoch;
          const visualPublication = deferred<void>();
          narrationPublicationWaitersRef.current.set(visualEpoch, visualPublication);
          setNarration({
            href,
            sourceProjectId: initial.projectId,
            sourceProjectRevision: initial.projectRevision,
            sourceProjectInstanceEpoch: expectedProject.projectInstanceEpoch,
            sourceProjectInstanceCapabilityFingerprint: expectedProject.projectInstanceCapabilityFingerprint,
            beatId,
            itemRevision,
            measuredDurationMs: resolved.measuredDurationMs,
            source: resolved.source,
            visualEpoch,
          });
          // Unlike a project mutation, preview audio changes no project revision.
          // Wait for the actual native audio element before reporting success.
          await visualPublication.promise;
          return {
            cacheKey: request.cacheKey,
            measuredDurationMs: resolved.measuredDurationMs,
            source: resolved.source,
            audioUrl: href,
          };
        } catch (error) {
          if (error instanceof ProjectInstanceFenceError) throw new ToolVisibleStateError();
          throw error;
        }
      },
      createOpaqueId: opaqueId,
    };
  }

  if (registryRef.current === null) {
    const resolvedModelContext = modelContext === undefined
      ? (typeof document === "undefined" ? null : featureDetectModelContext(document))
      : modelContext;
    registryRef.current = new CueBenchToolRegistry(resolvedModelContext, {
      ...(debugStore === null ? {} : { debugObserver: debugStore }),
    });
  }

  const runtime = runtimeRef.current;
  const registry = registryRef.current;

  // A query/prop change must revoke diagnostics without changing the WebMCP
  // surface. Existing host callbacks read the registry's current observer at
  // invocation time, so a retained callback cannot repopulate a cleared log.
  useLayoutEffect(() => {
    registry.setDebugObserver(debugStore ?? undefined);
    if (debugStore !== null) return;
    const retainedStore = debugStoreRef.current;
    if (retainedStore === null) return;
    retainedStore.dispose();
    debugStoreRef.current = null;
  }, [debugStore, registry]);

  useLayoutEffect(() => {
    const desiredProject = project;
    const projectInstance = projectInstanceForStore(desiredProject, storeRef.current);
    const projectKey = projectInstanceKey(projectInstance);
    visibleProjectKeyRef.current = projectKey;
    const assertProjectInstance = (): void => {
      if (!sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, projectInstance)) {
        throw new ToolVisibleStateError();
      }
    };
    /**
     * Every closure registered in this pass belongs to this exact visible
     * project instance. This is internal page state, not a wider tool input.
     */
    const scopedRuntime: CueBenchWebMcpRuntime = {
      ...runtime,
      projectInstance,
      isCurrentProjectInstance: () => sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, projectInstance),
      executeCommand: async (command) => {
        assertProjectInstance();
        const result = await storeRef.current.executeCommand(command, {
          projectId: projectInstance.projectId,
          projectInstanceEpoch: projectInstance.projectInstanceEpoch,
          ...(projectInstance.projectInstanceCapabilityFingerprint === null ? {} : {
            projectInstanceCapabilityFingerprint: projectInstance.projectInstanceCapabilityFingerprint,
          }),
        });
        if (!sameProjectOwnerForStore(storeRef.current, result.project, projectInstance)) throw new ToolVisibleStateError();
        return result;
      },
      afterVisibleChange: () => afterVisibleChangeForProject({
        projectId: projectInstance.projectId,
        projectInstanceEpoch: projectInstance.projectInstanceEpoch,
        projectInstanceCapabilityFingerprint: projectInstance.projectInstanceCapabilityFingerprint,
      }),
      ...(runtime.requestConfirmation === undefined ? {} : {
        requestConfirmation: async (request: WebMcpConfirmationRequest, signal: AbortSignal) => {
          assertProjectInstance();
          const accepted = await runtime.requestConfirmation!(request, signal);
          // A replacement may synchronously settle the dialog through the old
          // family signal. Prefer a structured stale-project result over
          // pretending the new project simply declined A's confirmation.
          if (!sameProjectInstanceForStore(storeRef.current, storeRef.current.getSnapshot().project, projectInstance)) {
            throw new ToolVisibleStateError();
          }
          if (!accepted || signal.aborted) return false;
          return true;
        },
      }),
      ...(runtime.prepareSelectionFocus === undefined ? {} : {
        prepareSelectionFocus: async (input: Parameters<NonNullable<CueBenchWebMcpRuntime["prepareSelectionFocus"]>>[0]) => {
          assertProjectInstance();
          const prepared = await runtime.prepareSelectionFocus!(input);
          if (prepared === false || input.signal.aborted) return false;
          assertProjectInstance();
          return prepared;
        },
      }),
      ...(runtime.revealSelection === undefined ? {} : {
        revealSelection: async (input: Parameters<NonNullable<CueBenchWebMcpRuntime["revealSelection"]>>[0]) => {
          // revealSelection is only reached after a successful visible
          // command, so its own project revision may already have advanced.
          // Keep a project-owner fence across the UI await instead.
          if (!sameProjectOwnerForStore(storeRef.current, storeRef.current.getSnapshot().project, projectInstance)) {
            throw new ToolVisibleStateError();
          }
          await runtime.revealSelection!(input);
          // A successful domain command advances the exact revision before it
          // asks the visible workbench to seek. Keep the project-instance
          // owner fence, but do not reject that command's own new revision.
          if (!sameProjectOwnerForStore(storeRef.current, storeRef.current.getSnapshot().project, projectInstance)) {
            throw new ToolVisibleStateError();
          }
        },
      }),
      ...(runtime.publishProfileProposal === undefined ? {} : {
        publishProfileProposal: async (proposal: WebMcpProfileProposal, signal: AbortSignal) => {
          assertProjectInstance();
          await runtime.publishProfileProposal!(proposal, signal);
          assertProjectInstance();
        },
      }),
    };
    const runScope = desiredProject.activeGenerationRun === null
      ? null
      : `${projectKey}:${desiredProject.activeGenerationRun.targetTrack}:${desiredProject.activeGenerationRun.runId}`;
    const alwaysScope = `${projectKey}:always`;
    const family = selectionFamilyFor(scopedRuntime, desiredProject, projectInstance);
    const selectionScope = family?.scopeId ?? null;
    const allAlwaysTools = createAlwaysTools(scopedRuntime);
    const runTools = runScope === null ? [] : createActiveRunTools(scopedRuntime);
    const visibleAlwaysTools = runScope === null
      ? allAlwaysTools
      : allAlwaysTools.filter((tool) => tool.name !== "start_caption_generation" && tool.name !== "start_ad_generation");
    const target: RegistrationTarget = {
      projectId: desiredProject.projectId,
      projectRevision: desiredProject.projectRevision,
      projectInstanceEpoch: projectInstance.projectInstanceEpoch,
      projectInstanceCapabilityFingerprint: projectInstance.projectInstanceCapabilityFingerprint,
      projectKey,
      runScope,
      selectionScope,
      always: registrationGroupTarget(registry.available, alwaysScope, visibleAlwaysTools),
      run: registrationGroupTarget(registry.available, runScope, runTools),
      selection: registrationGroupTarget(registry.available, selectionScope, family?.tools ?? []),
    };
    let waiter = revisionRegistrationWaitersRef.current.get(target.projectKey);
    if (waiter === undefined) {
      waiter = deferred<RegistrationTarget>();
      revisionRegistrationWaitersRef.current.set(target.projectKey, waiter);
    }
    // Continue a later revision after a prior host rejection, but never hide
    // that earlier revision's own failed promise from an in-flight tool call.
    // All three families replace in one browser-registration wave so a tool
    // never observes an owner-mixed partial surface.
    const sync = registryQueueRef.current.catch(() => undefined).then(async () => {
      await registry.synchronize({
        alwaysTools: allAlwaysTools,
        alwaysScopeId: alwaysScope,
        runTools: runScope === null ? null : runTools,
        runScopeId: runScope,
        selection: family,
      });
      assertExactRegistryTarget(registry, target);
      return target;
    });
    revisionRegistrationTargetsRef.current.set(target.projectKey, target);
    revisionRegistrationsRef.current.set(target.projectKey, sync);
    sync.then(waiter.resolve, waiter.reject);
    // This queue is only a sequencing mechanism. The revision-specific
    // promise above intentionally remains rejected for the caller that needs
    // a structured stale/changed result.
    registryQueueRef.current = sync.then(() => undefined, () => undefined);
    void sync.catch(() => undefined);
    if (revisionRegistrationsRef.current.size > 32) {
      const staleProjectKey = revisionRegistrationsRef.current.keys().next().value;
      if (typeof staleProjectKey === "string" && staleProjectKey !== target.projectKey) {
        revisionRegistrationsRef.current.delete(staleProjectKey);
        revisionRegistrationTargetsRef.current.delete(staleProjectKey);
        revisionRegistrationWaitersRef.current.delete(staleProjectKey);
      }
    }
  }, [afterVisibleChangeForProject, project, registry, runtime]);

  useEffect(() => {
    // React StrictMode intentionally rehearses cleanup/setup. Every setup owns
    // a fresh liveness epoch, and an older cleanup may tear down resources
    // only if no newer setup has reclaimed the bridge before its microtask.
    const ownerEpoch = publicationOwnerEpochRef.current + 1;
    publicationOwnerEpochRef.current = ownerEpoch;
    mountedRef.current = true;
    return () => {
      if (publicationOwnerEpochRef.current !== ownerEpoch) return;
      // Invalidate continuations synchronously: a durable command resolving
      // immediately after real unmount must fail before URL/state publication.
      mountedRef.current = false;
      const teardownEpoch = ownerEpoch + 1;
      publicationOwnerEpochRef.current = teardownEpoch;
      queueMicrotask(() => {
        // StrictMode's next setup runs before this microtask and claims a new
        // epoch. Only a real unmount retains this teardown owner.
        if (mountedRef.current || publicationOwnerEpochRef.current !== teardownEpoch) return;
        settleConfirmation(false);
        if (downloadUrlRef.current !== null) URL.revokeObjectURL(downloadUrlRef.current);
        for (const waiter of downloadPublicationWaitersRef.current.values()) {
          waiter.reject(new ToolVisibleStateError());
        }
        downloadPublicationWaitersRef.current.clear();
        if (narrationUrlRef.current !== null) {
          try { narrationRevokeRef.current(narrationUrlRef.current); } catch { /* best-effort page cleanup */ }
        }
        for (const waiter of narrationPublicationWaitersRef.current.values()) {
          waiter.reject(new ToolVisibleStateError());
        }
        narrationPublicationWaitersRef.current.clear();
        registry.setDebugObserver(undefined);
        void registry.dispose();
        // The development-only record belongs to this mounted page surface.
        // Disposing first lets its terminal aborts settle, then guarantees an
        // externally retained test reference cannot carry the record forward.
        debugStoreRef.current?.dispose();
        debugStoreRef.current = null;
      });
    };
  }, [registry, settleConfirmation]);

  // The canonical store is authoritative for stale publication cleanup. A
  // parent prop can lag one render behind an accepted command; hide during
  // that handoff, but do not revoke a still-current pending publication.
  useLayoutEffect(() => {
    if (download === null) return;
    const canonical = storeRef.current.getSnapshot().project;
    if (downloadMatchesProject(
      download,
      canonical,
      projectInstanceEpochFor(storeRef.current),
      canonical === null ? null : projectInstanceCapabilityFingerprintFor(storeRef.current, canonical),
    )) return;
    // A RecordExport command advances revision. Any later edit, backup import,
    // or project replacement invalidates the prior download affordance rather
    // than silently offering text from a different visible artifact.
    if (downloadUrlRef.current === download.href) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    const waiter = downloadPublicationWaitersRef.current.get(download.visualEpoch);
    downloadPublicationWaitersRef.current.delete(download.visualEpoch);
    waiter?.reject(new ToolVisibleStateError());
    setDownload((current) => current?.visualEpoch === download.visualEpoch ? null : current);
  }, [download, project]);

  useLayoutEffect(() => {
    if (narration === null) return;
    const canonical = storeRef.current.getSnapshot().project;
    if (narrationMatchesProject(
      narration,
      canonical,
      projectInstanceEpochFor(storeRef.current),
      canonical === null ? null : projectInstanceCapabilityFingerprintFor(storeRef.current, canonical),
    )) return;
    if (narrationUrlRef.current === narration.href) {
      try { narrationRevokeRef.current(narrationUrlRef.current); } catch { /* visual state still clears */ }
      narrationUrlRef.current = null;
    }
    const waiter = narrationPublicationWaitersRef.current.get(narration.visualEpoch);
    narrationPublicationWaitersRef.current.delete(narration.visualEpoch);
    waiter?.reject(new ToolVisibleStateError());
    setNarration((current) => current?.visualEpoch === narration.visualEpoch ? null : current);
  }, [narration, project, store]);

  const canonicalForPublication = storeRef.current.getSnapshot().project;
  const canonicalPublicationEpoch = projectInstanceEpochFor(storeRef.current);
  const canonicalPublicationFingerprint = canonicalForPublication === null
    ? null
    : projectInstanceCapabilityFingerprintFor(storeRef.current, canonicalForPublication);
  const propPublicationFingerprint = projectInstanceCapabilityFingerprintFor(storeRef.current, project);
  const visibleDownload = download !== null
    && downloadMatchesProject(download, canonicalForPublication, canonicalPublicationEpoch, canonicalPublicationFingerprint)
    && downloadMatchesProject(download, project, canonicalPublicationEpoch, propPublicationFingerprint)
    ? download
    : null;
  const visibleNarration = narration !== null
    && narrationMatchesProject(narration, canonicalForPublication, canonicalPublicationEpoch, canonicalPublicationFingerprint)
    && narrationMatchesProject(narration, project, canonicalPublicationEpoch, propPublicationFingerprint)
    ? narration
    : null;

  useLayoutEffect(() => {
    if (visibleDownload === null || typeof document === "undefined") return;
    const link = document.querySelector(`a[data-cuebench-download-epoch="${visibleDownload.visualEpoch}"]`);
    if (!(link instanceof HTMLAnchorElement) || link.href !== visibleDownload.href || link.download !== visibleDownload.filename) return;
    const waiter = downloadPublicationWaitersRef.current.get(visibleDownload.visualEpoch);
    if (waiter === undefined) return;
    downloadPublicationWaitersRef.current.delete(visibleDownload.visualEpoch);
    waiter.resolve();
  }, [visibleDownload]);

  useLayoutEffect(() => {
    if (visibleNarration === null || typeof document === "undefined") return;
    const element = document.querySelector(`audio[data-cuebench-narration-epoch="${visibleNarration.visualEpoch}"]`);
    if (element === null) return;
    const waiter = narrationPublicationWaitersRef.current.get(visibleNarration.visualEpoch);
    if (waiter === undefined) return;
    narrationPublicationWaitersRef.current.delete(visibleNarration.visualEpoch);
    waiter.resolve();
  }, [visibleNarration]);

  if (registry.available === false && confirmation === null && visibleDownload === null && visibleNarration === null && debugStore === null) return null;

  return (
    <>
      <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) settleConfirmation(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="storage-dialog export-dialog" aria-describedby="webmcp-confirmation-detail">
            <Dialog.Title>{confirmation?.request.title ?? "Confirm Browser Agent change"}</Dialog.Title>
            <Dialog.Description id="webmcp-confirmation-detail">
              {confirmation?.request.detail ?? "Review this Browser Agent request before changing the visible timeline."}
            </Dialog.Description>
            <div className="storage-dialog__actions">
              <button className="button button--outline" type="button" onClick={() => settleConfirmation(false)}>Keep current work</button>
              <button className="button button--signal" type="button" onClick={() => settleConfirmation(true)}>Confirm Browser Agent change</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {visibleDownload === null ? null : <p className="review-command-feedback" role="status">Browser Agent prepared a verified export. <a className="text-button" href={visibleDownload.href} download={visibleDownload.filename} data-cuebench-download-epoch={visibleDownload.visualEpoch}>Download {visibleDownload.filename}</a></p>}
      {visibleNarration === null ? null : (
        <section className="narration-preview" aria-label={`Browser Agent narration preview for ${visibleNarration.beatId}`}>
          <p className="narration-preview__notice" role="status">Browser Agent prepared a {visibleNarration.source} narration preview ({visibleNarration.measuredDurationMs} ms). It is review-only and not certification evidence.</p>
          <audio controls preload="metadata" src={visibleNarration.href} data-cuebench-narration-epoch={visibleNarration.visualEpoch} aria-label={`Narration preview for ${visibleNarration.beatId}`} />
        </section>
      )}
      {debugStore === null ? null : <WebMcpDebugDrawer store={debugStore} />}
    </>
  );
}
