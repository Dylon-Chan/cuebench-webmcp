import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryNotice } from "./RecoveryNotice";
import { CloudCleanupStatus } from "../project/CloudCleanupStatus";

describe("recovery lifecycle notices", () => {
  afterEach(() => cleanup());

  it("makes a detached retryable run recoverable without exposing receipt material", () => {
    render(<RecoveryNotice state="failed-retryable" track="captions" />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/retryable/i);
    expect(notice).toHaveTextContent(/reconnect/i);
    expect(notice).not.toHaveTextContent(/receipt|token|owner|capability|provider/i);
  });

  it("never calls a live workflow staged before its durable review boundary", () => {
    render(<RecoveryNotice state="processing" track="audio descriptions" />);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/processing in progress/i);
    expect(notice).toHaveTextContent(/no proposal is ready/i);
    expect(notice).not.toHaveTextContent(/staged for human review/i);
  });

  it("labels an unconfirmed cloud deletion as lifecycle-pending without offering a browser retry after authority expires", () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <CloudCleanupStatus
        entries={[{
          receiptId: "delete-opaque",
          state: "lifecycle-pending",
          message: "CueBench is waiting for a private cleanup acknowledgement.",
          attempts: 2,
        }]}
        onRetry={retry}
      />,
    );

    expect(screen.getByRole("region", { name: "Private cloud cleanup" })).toHaveTextContent(/lifecycle pending/i);
    expect(screen.getByText(/24-hour lifecycle backstop/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry private cleanup" })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it("renders confirmed cleanup separately from a still-authorized deletion retry", async () => {
    const user = userEvent.setup();
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <CloudCleanupStatus
        entries={[
          { receiptId: "delete-confirmed", state: "deleted", message: "CueBench confirmed private cleanup.", attempts: 1 },
          { receiptId: "delete-pending", state: "deleting", message: "CueBench is waiting for private cleanup.", attempts: 1 },
        ]}
        onRetry={retry}
      />,
    );

    expect(screen.getByText("Deleted")).toBeVisible();
    expect(screen.getByText("Deletion pending")).toBeVisible();
    expect(screen.queryByText("Lifecycle pending")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry private cleanup" }));
    expect(retry).toHaveBeenCalledWith("delete-pending");
  });
});
