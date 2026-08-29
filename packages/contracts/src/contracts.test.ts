import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolErrorSchema, ToolSuccessSchema } from "./index";

describe("tool result envelopes", () => {
  it("requires contract and project revisions on success", () => {
    const schema = ToolSuccessSchema(z.object({ cueId: z.string() }));

    expect(() => schema.parse({ ok: true, data: { cueId: "c05" } })).toThrow();
  });

  it("represents stale selection without throwing", () => {
    expect(
      ToolErrorSchema.parse({
        ok: false,
        contractVersion: 1,
        code: "STALE_SELECTION",
        message: "Selection changed",
        retryable: true,
        changed: false,
        nextActions: ["inspect_project"],
      }).code,
    ).toBe("STALE_SELECTION");
  });
});
