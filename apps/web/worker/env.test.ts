import { describe, expect, it } from "vitest";
import { WorkerConfigurationError, resolveWorkerSettings, type WorkerEnv } from "./env";

const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-secret-with-at-least-thirty-two-bytes",
  QUOTA_SALT: "quota-salt-with-at-least-thirty-two-bytes",
  TURNSTILE_SECRET: "turnstile-secret-with-at-least-32-bytes",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
  ...overrides,
});

describe("Worker cryptographic configuration", () => {
  it("rejects undersized secret bytes before the Worker can sign or verify", () => {
    expect(() => resolveWorkerSettings(env({ SESSION_HMAC_CURRENT_KEY: "too-short" }))).toThrow(WorkerConfigurationError);
    expect(() => resolveWorkerSettings(env({ TURNSTILE_SECRET: "also-too-short" }))).toThrow(/at least 32 bytes/i);
  });

  it("trims HMAC identifiers but preserves configured secret bytes exactly during key rotation", () => {
    const previousSecret = " previous-secret-with-at-least-thirty-two-bytes ";
    const settings = resolveWorkerSettings(env({
      SESSION_HMAC_CURRENT_KEY_ID: " current ",
      SESSION_HMAC_PREVIOUS_KEY_ID: " previous ",
      SESSION_HMAC_PREVIOUS_KEY: previousSecret,
    }));

    expect(settings.keyRing.current.id).toBe("current");
    expect(settings.keyRing.previous).toEqual({ id: "previous", secret: previousSecret });
  });
});
