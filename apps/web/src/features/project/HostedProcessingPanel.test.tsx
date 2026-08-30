import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostedProcessingPanel } from "./HostedProcessingPanel";

describe("HostedProcessingPanel", () => {
  afterEach(() => cleanup());

  it("renders the production disclosure in the workbench flow and never enables upload when Turnstile is not configured", async () => {
    const user = userEvent.setup();
    render(createElement(HostedProcessingPanel, {
      projectId: "project-fixture",
      durationMs: 60_000,
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
});
