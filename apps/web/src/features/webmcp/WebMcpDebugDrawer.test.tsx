import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebMcpDebugStore,
  isWebMcpDebugEnabled,
} from "./debug-store";
import {
  WebMcpDebugDrawer,
} from "./WebMcpDebugDrawer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebMcpDebugDrawer", () => {
  it("is enabled only by the exact opt-in query flag", () => {
    expect(isWebMcpDebugEnabled("?webmcpDebug=1")).toBe(true);
    expect(isWebMcpDebugEnabled("?from=judge&webmcpDebug=1")).toBe(true);
    expect(isWebMcpDebugEnabled("?webmcpDebug=0")).toBe(false);
    expect(isWebMcpDebugEnabled("?webmcpDebug=1x")).toBe(false);
    expect(isWebMcpDebugEnabled("?webmcpdebug=1")).toBe(false);
    expect(isWebMcpDebugEnabled("?webmcpDebug=%31")).toBe(true);
    expect(isWebMcpDebugEnabled("")).toBe(false);
  });

  it("keeps an opt-in, bounded, redacted in-memory inspection record", () => {
    const storageSetItem = vi.spyOn(Storage.prototype, "setItem");
    const store = createWebMcpDebugStore(true, { maxEvents: 2 });

    store.record({
      kind: "registration",
      toolName: "inspect_project",
      schemaVersion: 1,
      group: "always",
      status: "registered",
    });
    store.record({
      kind: "call",
      toolName: "revise_selected_cue",
      schemaVersion: 1,
      group: "selection",
      args: {
        kind: "object",
        fieldCount: 4,
        valueKinds: ["number", "string"],
        truncated: false,
      },
      durationMs: 18,
      durationCapped: false,
      resultCode: "OK",
      revisions: {
        projectRevision: 7,
        selectionRevision: 3,
        itemRevision: 4,
      },
      cancelled: false,
      // A hostile caller may try to attach raw media/caption content. The
      // debug store must retain only the fixed allowlisted shape.
      rawCaptionText: "Dr. Nguyen says the sensitive thing.",
      rawSpeaker: "Professor Nguyen",
      rawFilename: "private-lecture.mov",
      rawUrl: "https://private.example/media",
      rawEvidenceFrame: "data:image/png;base64,private-frame",
      rawModelOutput: "The model's private caption answer.",
      rawError: "A private model failure detail.",
    } as never);
    store.record({
      kind: "call",
      toolName: "inspect_selected_cue_evidence",
      schemaVersion: 1,
      group: "selection",
      args: { kind: "object", fieldCount: 1, valueKinds: ["number"], truncated: false },
      durationMs: 2,
      durationCapped: false,
      resultCode: "STALE_SELECTION",
      revisions: { projectRevision: 7, selectionRevision: 3, itemRevision: null },
      cancelled: true,
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.events).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("Nguyen");
    expect(JSON.stringify(snapshot)).not.toContain("private-lecture");
    expect(JSON.stringify(snapshot)).not.toContain("private.example");
    expect(JSON.stringify(snapshot)).not.toContain("private-frame");
    expect(JSON.stringify(snapshot)).not.toContain("model's private");
    expect(JSON.stringify(snapshot)).not.toContain("private model failure");
    expect(storageSetItem).not.toHaveBeenCalled();
    const call = snapshot.events.find((event) => event.kind === "call");
    if (call === undefined || call.kind !== "call") throw new Error("Expected the allowlisted call event.");
    expect(Object.keys(call).sort()).toEqual([
      "args",
      "cancelled",
      "durationCapped",
      "durationMs",
      "group",
      "kind",
      "resultCode",
      "revisions",
      "schemaVersion",
      "toolName",
    ]);
    expect(Object.keys(call.args).sort()).toEqual(["fieldCount", "kind", "truncated", "valueKinds"]);
  });

  it("caps the opt-in memory record at 200 events without persistence", () => {
    const storageSetItem = vi.spyOn(Storage.prototype, "setItem");
    const store = createWebMcpDebugStore(true);
    for (let index = 0; index <= 200; index += 1) {
      store.record({
        kind: "registration",
        toolName: "inspect_project",
        schemaVersion: 1,
        group: "always",
        status: "registered",
      });
    }

    const events = store.getSnapshot().events;
    expect(events).toHaveLength(200);
    expect(events.every((event) => event.toolName === "inspect_project")).toBe(true);
    expect(storageSetItem).not.toHaveBeenCalled();
  });

  it("rejects arbitrary tool identifiers and upper-case error prose instead of retaining them", () => {
    const store = createWebMcpDebugStore(true);
    store.record({
      kind: "call",
      toolName: "private-lecture.mov",
      schemaVersion: 1,
      group: "selection",
      args: { kind: "object", fieldCount: 1, valueKinds: ["string"], truncated: false },
      durationMs: 2,
      durationCapped: false,
      resultCode: "TOP_SECRET_CAPTION_FAILURE",
      revisions: { projectRevision: 7, selectionRevision: 3, itemRevision: 4 },
      cancelled: false,
    } as never);
    expect(store.getSnapshot().events).toEqual([]);

    store.record({
      kind: "call",
      toolName: "inspect_project",
      schemaVersion: 1,
      group: "always",
      args: { kind: "object", fieldCount: 1, valueKinds: ["string"], truncated: false },
      durationMs: 2,
      durationCapped: false,
      resultCode: "TOP_SECRET_CAPTION_FAILURE",
      revisions: { projectRevision: 7, selectionRevision: 3, itemRevision: 4 },
      cancelled: false,
    } as never);
    expect(store.getSnapshot().events).toEqual([
      expect.objectContaining({ toolName: "inspect_project", resultCode: "UNEXPECTED_ERROR" }),
    ]);
    expect(JSON.stringify(store.getSnapshot())).not.toContain("TOP_SECRET_CAPTION_FAILURE");
  });

  it("marks a capped duration instead of presenting a bounded number as exact", () => {
    const store = createWebMcpDebugStore(true);
    store.record({
      kind: "call",
      toolName: "inspect_project",
      schemaVersion: 1,
      group: "always",
      args: { kind: "object", fieldCount: 0, valueKinds: [], truncated: false },
      durationMs: 700_000,
      durationCapped: true,
      resultCode: "OK",
      revisions: { projectRevision: 7, selectionRevision: null, itemRevision: null },
      cancelled: false,
    } as never);

    const event = store.getSnapshot().events[0] as { readonly durationMs?: unknown; readonly durationCapped?: unknown } | undefined;
    expect(event).toMatchObject({ durationMs: 600_000, durationCapped: true });
    render(<WebMcpDebugDrawer store={store} />);
    expect(screen.getByText("≥ 600000 ms · capped")).toBeInTheDocument();
  });

  it("renders only sanitized registrations and call metadata, and can be cleared", () => {
    const store = createWebMcpDebugStore(true);
    store.record({
      kind: "registration",
      toolName: "inspect_project",
      schemaVersion: 1,
      group: "always",
      status: "registered",
    });
    store.record({
      kind: "call",
      toolName: "adjust_selected_cue_timing",
      schemaVersion: 1,
      group: "selection",
      args: { kind: "object", fieldCount: 5, valueKinds: ["number"], truncated: false },
      durationMs: 12,
      durationCapped: false,
      resultCode: "OK",
      revisions: { projectRevision: 8, selectionRevision: 4, itemRevision: 5 },
      cancelled: false,
    });

    render(<WebMcpDebugDrawer store={store} />);

    expect(screen.getByRole("complementary", { name: "WebMCP inspection drawer" })).toBeInTheDocument();
    expect(screen.getByText("inspect_project")).toBeInTheDocument();
    expect(screen.getByText("adjust_selected_cue_timing")).toBeInTheDocument();
    expect(screen.getAllByText("schema v1")).toHaveLength(2);
    expect(screen.getByText("object · 5 fields · number")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("p8 · s4 · i5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear inspection record" }));
    expect(screen.getByText("No registration or call metadata yet.")).toBeInTheDocument();
  });

  it("captures nothing and renders nothing when the opt-in is absent", () => {
    const store = createWebMcpDebugStore(false);
    store.record({
      kind: "registration",
      toolName: "inspect_project",
      schemaVersion: 1,
      group: "always",
      status: "registered",
    });

    const { container } = render(<WebMcpDebugDrawer store={store} />);
    expect(store.getSnapshot().events).toEqual([]);
    expect(container).toBeEmptyDOMElement();
  });
});
