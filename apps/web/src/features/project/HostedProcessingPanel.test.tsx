import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostedProcessingPanel } from "./HostedProcessingPanel";

describe("HostedProcessingPanel", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "turnstile");
  });

  it("renders the production disclosure in the workbench flow and never enables upload when Turnstile is not configured", async () => {
    const user = userEvent.setup();
    render(createElement(HostedProcessingPanel, {
      projectId: "project-fixture",
      durationMs: 60_000,
      mediaSha256: "a".repeat(64),
      sourceObjectUrl: "blob:cuebench:source",
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
});
