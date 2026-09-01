import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_LIFECYCLE_BACKSTOP_MS,
  classifyRecoveryState,
  recoveryAccessFor,
  redactRecoveryError,
  redactWorkflowFailure,
  transitionRecoveryState,
} from "./recovery";
import {
  createCleanupReceipt,
  settleCleanupReceipt,
} from "./cleanup";
import { redactAudioDescriptionWorkflowFailure } from "./workflows/audio-description-generation";
import { analyticsEngineTelemetrySink } from "./telemetry";

const wranglerConfig = (): Record<string, unknown> => JSON.parse(
  readFileSync(`${process.cwd()}/wrangler.jsonc`, "utf8"),
) as Record<string, unknown>;

describe("Task 18 recovery and privacy boundaries", () => {
  it("maps verified run facts into the explicit recovery state machine", () => {
    // A live durable workflow has not staged a human-reviewable artifact.
    // Calling it staged would invite a detached tab to make a false claim.
    expect(classifyRecoveryState({ stage: "Queued" })).toBe("processing");
    expect(classifyRecoveryState({ stage: "PreparingMedia" })).toBe("processing");
    expect(classifyRecoveryState({ stage: "AnalyzingVisuals" })).toBe("processing");
    expect(classifyRecoveryState({ stage: "AwaitingAdoption" })).toBe("staged");
    expect(classifyRecoveryState({ stage: "Failed", retryable: true })).toBe("failed-retryable");
    expect(classifyRecoveryState({ stage: "Failed", retryable: false })).toBe("failed-terminal");
    expect(classifyRecoveryState({ stage: "Cancelled", cleanup: "pending" })).toBe("deleting");
    expect(classifyRecoveryState({ stage: "Cancelled", cleanup: "completed" })).toBe("deleted");

    expect(transitionRecoveryState("staged", "adopt")).toBe("adopted");
    expect(transitionRecoveryState("processing", "stage")).toBe("staged");
    // A bounded retry queues a fresh durable Workflow attempt. It is not a
    // staged proposal until that attempt reaches AwaitingAdoption.
    expect(transitionRecoveryState("failed-retryable", "retry")).toBe("processing");
    expect(transitionRecoveryState("failed-terminal", "request-delete")).toBe("deleting");
    expect(() => transitionRecoveryState("deleted", "retry")).toThrow(/cannot transition/i);
  });

  it("requires the verified owner and keeps recovery bounded by the 24-hour lifecycle ceiling", () => {
    const nowMs = 1_000_000;
    const receipt = { ownerKey: "owner-current", expiresAtMs: nowMs + RECOVERY_LIFECYCLE_BACKSTOP_MS };

    expect(recoveryAccessFor(receipt, "owner-current", nowMs)).toEqual({ allowed: true, code: null });
    expect(recoveryAccessFor(receipt, "owner-other", nowMs)).toEqual({ allowed: false, code: "RECOVERY_OWNER_MISMATCH" });
    expect(recoveryAccessFor(receipt, "owner-current", receipt.expiresAtMs)).toEqual({ allowed: false, code: "RECOVERY_EXPIRED" });
  });

  it("never echoes private provider, filename, or receipt details into a recovery error", () => {
    const privateFailure = new Error("OpenAI rejected /private/teacher-lecture.mp4 with receipt eyJhbGciOiJIUzI1NiJ9");
    const message = redactRecoveryError(privateFailure);

    expect(message).toMatch(/could not resume private processing/i);
    expect(message).not.toContain("teacher-lecture");
    expect(message).not.toContain("eyJ");
    expect(message).not.toContain("OpenAI");

    const workflowMessage = redactWorkflowFailure(privateFailure);
    expect(workflowMessage).toMatch(/could not complete private processing/i);
    expect(workflowMessage).not.toContain("teacher-lecture");
    expect(workflowMessage).not.toContain("eyJ");
    expect(workflowMessage).not.toContain("OpenAI");
    expect(workflowMessage).not.toContain("provider");
  });

  it("redacts adversarial audio-description provider failures before they become durable status", () => {
    const providerBody = new Error([
      "provider body: <video name=teacher-private-lecture.mp4>",
      "https://storage.example/private/teacher-private-lecture.mp4?sig=very-secret",
      "receipt=eyJhbGciOiJIUzI1NiJ9.private-receipt",
    ].join("\n"));

    const message = redactAudioDescriptionWorkflowFailure(providerBody);

    expect(message).toMatch(/could not complete private processing/i);
    expect(message).not.toContain("teacher-private-lecture");
    expect(message).not.toContain("storage.example");
    expect(message).not.toContain("eyJ");
    expect(message).not.toContain("provider body");
    expect(message).not.toContain("provider");
  });

  it("is idempotent and never upgrades an unconfirmed deletion into an immediate delete", () => {
    const receipt = createCleanupReceipt({ ownerKey: "owner-current", requestedAtMs: 100, expiresAtMs: 100 + RECOVERY_LIFECYCLE_BACKSTOP_MS });
    const pending = settleCleanupReceipt(receipt, { kind: "unconfirmed", nowMs: 101 });
    const lifecyclePending = settleCleanupReceipt(pending, { kind: "unconfirmed", nowMs: receipt.expiresAtMs });
    const deleted = settleCleanupReceipt(lifecyclePending, { kind: "confirmed-deleted", nowMs: receipt.expiresAtMs + 1 });

    expect(pending).toMatchObject({ state: "deleting", attempts: 1 });
    expect(lifecyclePending).toMatchObject({ state: "lifecycle-pending", attempts: 2 });
    expect(deleted).toMatchObject({ state: "deleted", attempts: 3 });
    expect(settleCleanupReceipt(deleted, { kind: "unconfirmed", nowMs: receipt.expiresAtMs + 2 })).toEqual(deleted);
  });

  it("keeps local, preview, and production private infrastructure distinct without committing secret values", () => {
    const config = wranglerConfig();
    const namedEnvironments = [
      ["local", config],
      ...Object.entries((config.env ?? {}) as Record<string, Record<string, unknown>>),
    ] as const;
    const environments = namedEnvironments.map(([, environment]) => environment);
    const buckets = environments.flatMap((environment) => ((environment.r2_buckets ?? []) as Array<{ readonly bucket_name?: unknown }>)
      .map((binding) => binding.bucket_name));
    const workflows = environments.flatMap((environment) => ((environment.workflows ?? []) as Array<{ readonly name?: unknown }>)
      .map((binding) => binding.name));

    expect(buckets).toEqual(["cuebench-processing-local", "cuebench-processing-preview", "cuebench-processing-production"]);
    expect(workflows).toEqual(expect.arrayContaining([
      "cuebench-caption-generation-local",
      "cuebench-caption-generation-preview",
      "cuebench-caption-generation-production",
      "cuebench-audio-description-generation-local",
      "cuebench-audio-description-generation-preview",
      "cuebench-audio-description-generation-production",
    ]));
    expect(new Set(buckets).size).toBe(3);
    expect(new Set(workflows).size).toBe(6);
    for (const [environmentName, environment] of namedEnvironments) {
      const vars = (environment.vars ?? {}) as Record<string, unknown>;
      const bindings = ((environment.durable_objects ?? {}) as { readonly bindings?: readonly { readonly name?: unknown; readonly class_name?: unknown }[] }).bindings ?? [];
      const containerBindings = (environment.containers ?? []) as readonly { readonly class_name?: unknown; readonly max_instances?: unknown }[];
      expect(vars.CUEBENCH_ENVIRONMENT).toBe(environmentName);
      expect(vars.SESSION_HMAC_CURRENT_KEY_ID).toBe(environmentName === "local" ? "v1" : `${environmentName}-v1`);
      expect(bindings.map((binding) => binding.name).sort()).toEqual(["MEDIA_PREPARER", "QUOTA_LEDGER", "UPLOAD_COORDINATOR"]);
      expect(bindings.map((binding) => binding.class_name).sort()).toEqual(["MediaPreparationContainer", "QuotaLedger", "UploadCoordinator"]);
      expect(containerBindings).toEqual(expect.arrayContaining([expect.objectContaining({ class_name: "MediaPreparationContainer" })]));
      const analytics = (environment.analytics_engine_datasets ?? []) as readonly { readonly binding?: unknown; readonly dataset?: unknown }[];
      expect(analytics).toEqual([{ binding: "CUEBENCH_TELEMETRY", dataset: `cuebench_${environmentName}` }]);
      expect(vars.CUEBENCH_OPENAI_MODE).toBe(environmentName === "production" ? "live" : "fixture");
      expect((environment.triggers as { readonly crons?: unknown } | undefined)?.crons).toEqual(["*/5 * * * *"]);
    }
    const telemetryDatasets = namedEnvironments.map(([, environment]) => ((environment.analytics_engine_datasets ?? []) as readonly { readonly dataset?: unknown }[])[0]?.dataset);
    const keyIds = namedEnvironments.map(([, environment]) => ((environment.vars ?? {}) as Record<string, unknown>).SESSION_HMAC_CURRENT_KEY_ID);
    expect(new Set(telemetryDatasets).size).toBe(3);
    expect(new Set(keyIds).size).toBe(3);
    expect(JSON.stringify(config)).not.toMatch(/SESSION_HMAC_CURRENT_KEY"\s*:/);
    expect(JSON.stringify(config)).not.toMatch(/OPENAI_API_KEY"\s*:/);
  });

  it("writes only redacted measurement fields to the concrete Analytics Engine binding", () => {
    const writeDataPoint = vi.fn();
    const sink = analyticsEngineTelemetrySink({ writeDataPoint });
    sink?.record({
      stage: "caption-generation",
      status: "failed",
      errorCode: "PROVIDER_FAILURE",
      durationMs: 500,
      byteSize: 42,
      usage: { inputTokens: 12, outputTokens: 8 },
      // The adapter must discard both the unknown field and its content.
      captionText: "Dr. Nguyen at https://private.example/video.mp4?sig=receipt",
    } as unknown as Parameters<NonNullable<typeof sink>["record"]>[0]);

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const payload = writeDataPoint.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).not.toContain("Nguyen");
    expect(JSON.stringify(payload)).not.toContain("private.example");
    expect(payload).toEqual(expect.objectContaining({
      // Analytics Engine accepts exactly one stable sampling index. Human
      // content never influences it; stage/status remain redacted blobs.
      indexes: ["cuebench"],
      blobs: ["caption-generation", "failed", "PROVIDER_FAILURE"],
      doubles: [500, 42, 0, 0, 12, 8, 0, 0],
    }));
  });
});
