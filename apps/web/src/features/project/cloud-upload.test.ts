import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudProcessingDisclosure } from "./CloudProcessingDisclosure";
import {
  cancelCloudProcessingCopy,
  createAnonymousCloudSession,
  uploadCloudProcessingCopy,
  type CloudUploadReceiptStore,
} from "./cloud-upload";

const source = (): Blob => new Blob(["hello"], { type: "video/webm" });

const operation = (overrides: Record<string, unknown> = {}) => ({
  operationReceipt: "opaque-operation-receipt",
  uploadCapability: "opaque-capability",
  capabilityExpiresAtMs: 9_999,
  partSize: 3,
  partCount: 2,
  uploadedPartNumbers: [],
  status: "pending",
  ...overrides,
});

const receiptStore = (): { readonly store: CloudUploadReceiptStore; readonly values: Map<string, unknown> } => {
  const values = new Map<string, unknown>();
  return {
    values,
    store: {
      load: (key) => values.get(key) ?? null,
      save: (key, value) => { values.set(key, value); },
      remove: (key) => { values.delete(key); },
    },
  };
};

describe("resumable cloud upload client", () => {
  afterEach(() => cleanup());

  it("does not make a network request before explicit cloud-processing acceptance", async () => {
    const fetcher = vi.fn();

    await expect(uploadCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      projectId: "project-fixture",
      operationId: "operation-fixture",
      source: source(),
      durationMs: 60_000,
      disclosureAccepted: false,
    })).rejects.toThrow(/accept.*cloud processing/i);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("slices the browser Blob into bounded same-origin multipart requests and persists opaque recovery receipts", async () => {
    const persisted = receiptStore();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(operation()), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partReceipt: "opaque-part-1", partNumber: 1 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partReceipt: "opaque-part-2", partNumber: 2 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationReceipt: "opaque-operation-receipt", status: "queued" }), { status: 202 }));

    const result = await uploadCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      projectId: "project-fixture",
      operationId: "operation-fixture",
      source: source(),
      durationMs: 60_000,
      disclosureAccepted: true,
      receiptStore: persisted.store,
    });

    expect(result).toMatchObject({ receipt: "opaque-operation-receipt", status: "queued" });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/uploads",
      "/api/uploads/operation-fixture/parts/1",
      "/api/uploads/operation-fixture/parts/2",
      "/api/uploads/operation-fixture/complete",
    ]);
    const firstPart = fetcher.mock.calls[1]?.[1] as RequestInit;
    const secondPart = fetcher.mock.calls[2]?.[1] as RequestInit;
    expect(firstPart.body).toBeInstanceOf(Blob);
    expect((firstPart.body as Blob).size).toBe(3);
    expect((secondPart.body as Blob).size).toBe(2);
    expect(persisted.values.size).toBe(1);
    expect(JSON.stringify([...persisted.values.values()])).toContain("opaque-part-2");
    expect(JSON.stringify([...persisted.values.values()])).not.toContain("hello");
  });

  it("resumes an ambiguous part request from persisted opaque state and server-reported uploaded parts", async () => {
    const persisted = receiptStore();
    const stored = {
      version: 1,
      projectId: "project-fixture",
      operationId: "operation-fixture",
      sourceByteLength: 5,
      sourceContentType: "video/webm",
      durationMs: 60_000,
      operationReceipt: "opaque-operation-receipt",
      uploadCapability: "expired-capability",
      partSize: 3,
      partCount: 2,
      partReceipts: { 1: "opaque-part-1" },
    };
    persisted.store.save("cuebench-cloud-upload:project-fixture", stored);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(operation({ uploadedPartNumbers: [1], uploadCapability: "fresh-capability" })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ partReceipt: "opaque-part-2", partNumber: 2 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationReceipt: "opaque-operation-receipt", status: "queued" }), { status: 202 }));

    const result = await uploadCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      projectId: "project-fixture",
      operationId: "operation-fixture",
      source: source(),
      durationMs: 60_000,
      disclosureAccepted: true,
      receiptStore: persisted.store,
    });

    expect(result.status).toBe("queued");
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/uploads/operation-fixture",
      "/api/uploads/operation-fixture/parts/2",
      "/api/uploads/operation-fixture/complete",
    ]);
  });

  it("uses a same-origin Turnstile token and opaque idempotency key to create its anonymous session", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: "signed-session", expiresAtMs: 9_999 }), { status: 201 }));

    await expect(createAnonymousCloudSession({ fetcher, turnstileToken: "turnstile-token", idempotencyKey: "opaque-idempotency" })).resolves.toEqual({ session: "signed-session", expiresAtMs: 9_999 });
    expect(fetcher).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "POST" }));
  });

  it("requests immediate cleanup for cancellation and removes only opaque local recovery state after success", async () => {
    const persisted = receiptStore();
    persisted.store.save("cuebench-cloud-upload:project-fixture", { operationReceipt: "opaque-receipt" });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await cancelCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      projectId: "project-fixture",
      operationId: "operation-fixture",
      receipt: "opaque-receipt",
      receiptStore: persisted.store,
    });

    expect(fetcher).toHaveBeenCalledWith("/api/uploads/operation-fixture", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ "x-cuebench-operation-receipt": "opaque-receipt" }),
    }));
    expect(persisted.values.size).toBe(0);
  });

  it("names Cloudflare, OpenAI, browser-canonical storage, immediate success/cancel cleanup, and the 24-hour ceiling before acceptance", async () => {
    const onAcceptedChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(CloudProcessingDisclosure, { accepted: false, onAcceptedChange }));

    expect(screen.getByLabelText("Cloud processing disclosure")).toHaveTextContent(/Cloudflare/i);
    expect(screen.getByLabelText("Cloud processing disclosure")).toHaveTextContent(/OpenAI/i);
    expect(screen.getByLabelText("Cloud processing disclosure")).toHaveTextContent(/canonical project store/i);
    expect(screen.getByLabelText("Cloud processing disclosure")).toHaveTextContent(/success or cancellation/i);
    expect(screen.getByLabelText("Cloud processing disclosure")).toHaveTextContent(/24 hours/i);

    await user.click(screen.getByRole("checkbox", { name: /accept temporary cloud processing/i }));
    expect(onAcceptedChange).toHaveBeenCalledWith(true);
  });
});
