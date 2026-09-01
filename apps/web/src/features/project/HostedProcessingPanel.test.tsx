import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedProcessingPanel } from "./HostedProcessingPanel";

const cloudUploadMocks = vi.hoisted(() => ({
  cancelCloudProcessingCopy: vi.fn(),
  createAnonymousCloudSession: vi.fn(),
  loadPersistedCloudUpload: vi.fn(),
  uploadCloudProcessingCopy: vi.fn(),
}));

vi.mock("./cloud-upload", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloud-upload")>(),
  ...cloudUploadMocks,
}));

const ownerCapability = "b".repeat(64);
const mediaSha256 = "a".repeat(64);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const uploadedOperation = {
  version: 1 as const,
  projectId: "project-fixture",
  operationId: "operation-fixture",
  sourceByteLength: 5,
  sourceSha256: mediaSha256,
  sourceContentType: "video/mp4",
  durationMs: 60_000,
  projectOwnerCapability: ownerCapability,
  session: "signed-session",
  sessionExpiresAtMs: Date.now() + 60_000,
  operationReceipt: "operation-receipt",
  uploadCapability: "upload-capability",
  partSize: 5,
  partCount: 1,
  partReceipts: {},
};

const panel = (
  storageMode: "durable" | "temporary",
  resolveProjectOwnerCapability: (projectId: string) => Promise<string | null>,
  overrides: Partial<{
    readonly projectId: string;
    readonly durationMs: number;
    readonly mediaSha256: string;
    readonly sourceObjectUrl: string;
  }> = {},
) => createElement(HostedProcessingPanel, {
  projectId: overrides.projectId ?? "project-fixture",
  durationMs: overrides.durationMs ?? 60_000,
  mediaSha256: overrides.mediaSha256 ?? mediaSha256,
  sourceObjectUrl: overrides.sourceObjectUrl ?? "blob:cuebench:source",
  resolveProjectOwnerCapability,
  storageMode,
  siteKey: "real-public-site-key",
});

const installTurnstile = () => {
  let completeVerification: ((token: string) => void) | undefined;
  Object.defineProperty(window, "turnstile", {
    configurable: true,
    value: {
      render: (_container: HTMLElement, options: { readonly callback: (token: string) => void }) => {
        completeVerification = options.callback;
        return "turnstile-widget";
      },
      remove: vi.fn(),
    },
  });
  return () => completeVerification?.("verified-turnstile-token");
};

const prepareDurableStart = async (resolveProjectOwnerCapability: (projectId: string) => Promise<string | null>) => {
  const completeVerification = installTurnstile();
  const user = userEvent.setup();
  const view = render(panel("durable", resolveProjectOwnerCapability));
  await screen.findByText("Anti-abuse check is ready. Complete it to enable cloud processing.");
  await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
  act(completeVerification);
  const start = await screen.findByRole("button", { name: /start cloud processing/i });
  await waitFor(() => expect(start).toBeEnabled());
  return { ...view, start, user };
};

describe("HostedProcessingPanel", () => {
  beforeEach(() => {
    cloudUploadMocks.cancelCloudProcessingCopy.mockReset();
    cloudUploadMocks.createAnonymousCloudSession.mockReset();
    cloudUploadMocks.loadPersistedCloudUpload.mockReset().mockReturnValue(null);
    cloudUploadMocks.uploadCloudProcessingCopy.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "turnstile");
  });

  it("renders the production disclosure in the workbench flow and never enables upload when Turnstile is not configured", async () => {
    const user = userEvent.setup();
    render(createElement(HostedProcessingPanel, {
      projectId: "project-fixture",
      durationMs: 60_000,
      mediaSha256: "a".repeat(64),
      sourceObjectUrl: "blob:cuebench:source",
      storageMode: "durable",
      siteKey: "",
    }));

    expect(screen.getByLabelText("Cloud processing disclosure")).toBeVisible();
    expect(screen.getByText(/anti-abuse verification is unavailable/i)).toBeVisible();
    const start = screen.getByRole("button", { name: /start cloud processing/i });
    expect(start).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
    expect(start).toBeDisabled();
  });

  it("distinguishes a challenge that awaits the human from a completed verification", async () => {
    let completeVerification: ((token: string) => void) | undefined;
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      value: {
        render: (_container: HTMLElement, options: { readonly callback: (token: string) => void }) => {
          completeVerification = options.callback;
          return "turnstile-widget";
        },
        remove: () => undefined,
      },
    });
    const user = userEvent.setup();
    render(createElement(HostedProcessingPanel, {
      projectId: "project-fixture",
      durationMs: 60_000,
      mediaSha256: "a".repeat(64),
      sourceObjectUrl: "blob:cuebench:source",
      resolveProjectOwnerCapability: async () => "b".repeat(64),
      storageMode: "durable",
      siteKey: "real-public-site-key",
    }));

    const gate = screen.getByLabelText("Anti-abuse verification");
    expect(gate).toHaveAttribute("data-turnstile-site-key", "real-public-site-key");
    expect(await screen.findByText("Anti-abuse check is ready. Complete it to enable cloud processing.")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
    const start = screen.getByRole("button", { name: /start cloud processing/i });
    expect(start).toBeDisabled();

    act(() => completeVerification?.("verified-turnstile-token"));

    expect(await screen.findByText("Anti-abuse verification is complete.")).toBeVisible();
    expect(start).toBeEnabled();
  });

  it("keeps Turnstile and cloud processing unavailable for a temporary-session project", () => {
    const renderChallenge = vi.fn();
    const resolveProjectOwnerCapability = vi.fn(async () => "b".repeat(64));
    const turnstileScriptCount = document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]').length;
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      value: {
        render: renderChallenge,
        remove: vi.fn(),
      },
    });
    render(createElement(HostedProcessingPanel, {
      projectId: "temporary-project",
      durationMs: 60_000,
      mediaSha256: "a".repeat(64),
      sourceObjectUrl: "blob:cuebench:source",
      resolveProjectOwnerCapability,
      storageMode: "temporary",
      siteKey: "real-public-site-key",
    }));

    expect(screen.queryByLabelText("Anti-abuse verification")).not.toBeInTheDocument();
    expect(renderChallenge).not.toHaveBeenCalled();
    expect(resolveProjectOwnerCapability).not.toHaveBeenCalled();
    expect(document.querySelectorAll('script[src*="challenges.cloudflare.com/turnstile"]')).toHaveLength(turnstileScriptCount);
    expect(screen.getByRole("status")).toHaveTextContent(
      /durable browser storage is required.*recoverable processing receipts/i,
    );

    expect(screen.queryByRole("checkbox", { name: /accept temporary cloud processing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start cloud processing/i })).not.toBeInTheDocument();
  });

  it("invalidates a paused session request when durable storage becomes temporary", async () => {
    const pendingSession = deferred<{ readonly session: string; readonly expiresAtMs: number }>();
    cloudUploadMocks.createAnonymousCloudSession.mockReturnValue(pendingSession.promise);
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const { rerender, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(cloudUploadMocks.createAnonymousCloudSession).toHaveBeenCalledOnce());
    rerender(panel("temporary", resolveOwner));
    expect(cloudUploadMocks.createAnonymousCloudSession.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingSession.resolve({ session: "signed-session", expiresAtMs: Date.now() + 60_000 }));

    expect(fetchSource).not.toHaveBeenCalled();
    expect(resolveOwner).toHaveBeenCalledOnce();
    expect(cloudUploadMocks.uploadCloudProcessingCopy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /start cloud processing/i })).not.toBeInTheDocument();

    rerender(panel("durable", resolveOwner));
    await user.click(await screen.findByRole("checkbox", { name: /accept temporary cloud processing/i }));
    expect(screen.getByRole("button", { name: /start cloud processing/i })).toBeDisabled();
  });

  it("does not upload after a paused owner check crosses into temporary storage", async () => {
    const pendingOwner = deferred<string | null>();
    const resolveOwner = vi.fn()
      .mockResolvedValueOnce(ownerCapability)
      .mockReturnValueOnce(pendingOwner.promise);
    cloudUploadMocks.createAnonymousCloudSession.mockResolvedValue({ session: "signed-session", expiresAtMs: Date.now() + 60_000 });
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const { rerender, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(resolveOwner).toHaveBeenCalledTimes(2));
    rerender(panel("temporary", resolveOwner));
    expect(fetchSource.mock.calls[0]?.[1]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingOwner.resolve(ownerCapability));

    expect(fetchSource).toHaveBeenCalledOnce();
    expect(cloudUploadMocks.uploadCloudProcessingCopy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /start cloud processing/i })).not.toBeInTheDocument();
  });

  it("does not repopulate recovery or status after a paused upload crosses into temporary storage", async () => {
    const pendingUpload = deferred<{ readonly receipt: string; readonly operationReceipt: string; readonly status: string; readonly operation: typeof uploadedOperation }>();
    cloudUploadMocks.createAnonymousCloudSession.mockResolvedValue({ session: "signed-session", expiresAtMs: Date.now() + 60_000 });
    cloudUploadMocks.uploadCloudProcessingCopy.mockReturnValue(pendingUpload.promise);
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const { rerender, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(cloudUploadMocks.uploadCloudProcessingCopy).toHaveBeenCalledOnce());
    rerender(panel("temporary", resolveOwner));
    expect(cloudUploadMocks.uploadCloudProcessingCopy.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingUpload.resolve({
      receipt: uploadedOperation.operationReceipt,
      operationReceipt: uploadedOperation.operationReceipt,
      status: "queued",
      operation: uploadedOperation,
    }));

    expect(screen.getByRole("status")).toHaveTextContent(/durable browser storage is required/i);
    rerender(panel("durable", resolveOwner));
    expect(await screen.findByText("Cloud processing is optional. Your browser remains the canonical project store.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /cancel cloud processing/i })).not.toBeInTheDocument();
  });

  it("does not write stale cleanup status after a paused cancellation crosses into temporary storage", async () => {
    cloudUploadMocks.loadPersistedCloudUpload.mockReturnValue(uploadedOperation);
    const pendingCancel = deferred<void>();
    cloudUploadMocks.cancelCloudProcessingCopy.mockReturnValue(pendingCancel.promise);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const completeVerification = installTurnstile();
    const user = userEvent.setup();
    const view = render(panel("durable", resolveOwner));
    await screen.findByText("Anti-abuse check is ready. Complete it to enable cloud processing.");
    await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
    act(completeVerification);
    const cancel = await screen.findByRole("button", { name: /cancel cloud processing and delete copy/i });
    await waitFor(() => expect(cancel).toBeEnabled());

    await user.click(cancel);
    await waitFor(() => expect(cloudUploadMocks.cancelCloudProcessingCopy).toHaveBeenCalledOnce());
    view.rerender(panel("temporary", resolveOwner));
    expect(cloudUploadMocks.cancelCloudProcessingCopy.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingCancel.resolve());

    cloudUploadMocks.loadPersistedCloudUpload.mockReturnValue(null);
    view.rerender(panel("durable", resolveOwner));
    expect(await screen.findByText("Cloud processing is optional. Your browser remains the canonical project store.")).toBeVisible();
    expect(screen.queryByText(/confirmed immediate cleanup/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel cloud processing/i })).not.toBeInTheDocument();
  });

  it("aborts a paused session request when the durable panel unmounts", async () => {
    const pendingSession = deferred<{ readonly session: string; readonly expiresAtMs: number }>();
    cloudUploadMocks.createAnonymousCloudSession.mockReturnValue(pendingSession.promise);
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const { unmount, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(cloudUploadMocks.createAnonymousCloudSession).toHaveBeenCalledOnce());
    unmount();
    expect(cloudUploadMocks.createAnonymousCloudSession.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingSession.resolve({ session: "signed-session", expiresAtMs: Date.now() + 60_000 }));

    expect(fetchSource).not.toHaveBeenCalled();
    expect(resolveOwner).toHaveBeenCalledOnce();
    expect(cloudUploadMocks.uploadCloudProcessingCopy).not.toHaveBeenCalled();
  });

  it("invalidates a paused owner check when the durable project identity is replaced", async () => {
    const pendingOwner = deferred<string | null>();
    const resolveOwner = vi.fn()
      .mockResolvedValueOnce(ownerCapability)
      .mockReturnValueOnce(pendingOwner.promise);
    const replacementOwner = vi.fn(async () => "c".repeat(64));
    cloudUploadMocks.createAnonymousCloudSession.mockResolvedValue({ session: "signed-session", expiresAtMs: Date.now() + 60_000 });
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const { rerender, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(resolveOwner).toHaveBeenCalledTimes(2));
    rerender(panel("durable", replacementOwner, {
      projectId: "replacement-project",
      durationMs: 61_000,
      mediaSha256: "d".repeat(64),
      sourceObjectUrl: "blob:cuebench:replacement-source",
    }));
    expect(fetchSource.mock.calls[0]?.[1]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingOwner.resolve(ownerCapability));

    expect(cloudUploadMocks.uploadCloudProcessingCopy).not.toHaveBeenCalled();
    expect(replacementOwner).toHaveBeenCalledWith("replacement-project");
    expect(screen.getByRole("button", { name: /start cloud processing/i })).toBeDisabled();
  });

  it("does not adopt a paused upload after durable media and source identity replacement", async () => {
    const pendingUpload = deferred<{ readonly receipt: string; readonly operationReceipt: string; readonly status: string; readonly operation: typeof uploadedOperation }>();
    cloudUploadMocks.createAnonymousCloudSession.mockResolvedValue({ session: "signed-session", expiresAtMs: Date.now() + 60_000 });
    cloudUploadMocks.uploadCloudProcessingCopy.mockReturnValue(pendingUpload.promise);
    const fetchSource = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(new Blob(["video"], { type: "video/mp4" })));
    vi.stubGlobal("fetch", fetchSource);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const replacementOwner = vi.fn(async () => "c".repeat(64));
    const { rerender, start, user } = await prepareDurableStart(resolveOwner);

    await user.click(start);
    await waitFor(() => expect(cloudUploadMocks.uploadCloudProcessingCopy).toHaveBeenCalledOnce());
    rerender(panel("durable", replacementOwner, {
      projectId: "replacement-project",
      mediaSha256: "d".repeat(64),
      sourceObjectUrl: "blob:cuebench:replacement-source",
    }));
    expect(cloudUploadMocks.uploadCloudProcessingCopy.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingUpload.resolve({
      receipt: uploadedOperation.operationReceipt,
      operationReceipt: uploadedOperation.operationReceipt,
      status: "queued",
      operation: uploadedOperation,
    }));

    expect(await screen.findByText("Cloud processing is optional. Your browser remains the canonical project store.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /cancel cloud processing/i })).not.toBeInTheDocument();
    expect(replacementOwner).toHaveBeenCalledWith("replacement-project");
  });

  it("aborts a paused cleanup request when the durable panel unmounts", async () => {
    cloudUploadMocks.loadPersistedCloudUpload.mockReturnValue(uploadedOperation);
    const pendingCancel = deferred<void>();
    cloudUploadMocks.cancelCloudProcessingCopy.mockReturnValue(pendingCancel.promise);
    const resolveOwner = vi.fn(async () => ownerCapability);
    const completeVerification = installTurnstile();
    const user = userEvent.setup();
    const view = render(panel("durable", resolveOwner));
    await screen.findByText("Anti-abuse check is ready. Complete it to enable cloud processing.");
    await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
    act(completeVerification);
    const cancel = await screen.findByRole("button", { name: /cancel cloud processing and delete copy/i });
    await waitFor(() => expect(cancel).toBeEnabled());

    await user.click(cancel);
    await waitFor(() => expect(cloudUploadMocks.cancelCloudProcessingCopy).toHaveBeenCalledOnce());
    view.unmount();
    expect(cloudUploadMocks.cancelCloudProcessingCopy.mock.calls[0]?.[0]).toMatchObject({ signal: { aborted: true } });
    await act(async () => pendingCancel.resolve());

    expect(cloudUploadMocks.cancelCloudProcessingCopy).toHaveBeenCalledOnce();
    expect(cloudUploadMocks.createAnonymousCloudSession).not.toHaveBeenCalled();
  });
});
