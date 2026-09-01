import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CloudCleanupStatus } from "./CloudCleanupStatus";

describe("CloudCleanupStatus", () => {
  it("does not offer a browser retry after lifecycle-pending has scrubbed private authority", () => {
    const onRetry = vi.fn(async () => undefined);

    render(<CloudCleanupStatus
      entries={[{
        receiptId: "opaque-cleanup-entry",
        state: "lifecycle-pending",
        message: "not used by the public projection",
        attempts: 1,
      }]}
      onRetry={onRetry}
    />);

    expect(screen.getByRole("region", { name: "Private cloud cleanup" })).toHaveTextContent(/lifecycle pending/i);
    expect(screen.queryByRole("button", { name: /retry private cleanup/i })).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
