import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudProcessingDisclosure } from "./CloudProcessingDisclosure";
import { cancelCloudProcessingCopy, uploadCloudProcessingCopy } from "./cloud-upload";

const source = (): Blob => new Blob(["hello"], { type: "video/webm" });

describe("cloud upload client", () => {
  afterEach(() => cleanup());

  it("refuses to make a network request before explicit cloud-processing acceptance", async () => {
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

  it("creates a private upload operation then sends media only to its same-origin capability endpoint", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadCapability: "opaque-capability" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ receipt: "opaque-receipt" }), { status: 201 }));

    const result = await uploadCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      projectId: "project-fixture",
      operationId: "operation-fixture",
      source: source(),
      durationMs: 60_000,
      disclosureAccepted: true,
    });

    expect(result).toEqual({ receipt: "opaque-receipt" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/uploads");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer signed-session" }),
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/uploads/operation-fixture");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({
        authorization: "Bearer signed-session",
        "x-cuebench-upload-capability": "opaque-capability",
      }),
      body: expect.any(Blob),
    });
  });

  it("requests immediate private-object cleanup for a cancelled operation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await cancelCloudProcessingCopy({
      fetcher,
      session: "signed-session",
      operationId: "operation-fixture",
      receipt: "opaque-receipt",
    });

    expect(fetcher).toHaveBeenCalledWith("/api/uploads/operation-fixture", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        authorization: "Bearer signed-session",
        "x-cuebench-operation-receipt": "opaque-receipt",
      }),
    }));
  });

  it("names every processing and retention commitment before its affirmative control", async () => {
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
