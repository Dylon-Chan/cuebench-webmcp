import { canonicalHash } from "@cuebench/domain";
import { describe, expect, it, vi } from "vitest";
import { resolveWorkerSettings, type WorkerEnv } from "./env";
import {
  InMemoryNarrationPreviewRecordStore,
  createNarrationPreviewRoutes,
} from "./narration-preview-routes";
import { createNarrationTtsProvider, type NarrationTtsProvider } from "./openai/tts";
import { OpenAIProviderError } from "./openai/client";
import { InMemoryQuotaLedger } from "./quota-ledger";
import { issueAnonymousSession } from "./session";

const now = 1_700_000_000_000;
const env: WorkerEnv = {
  SESSION_HMAC_CURRENT_KEY_ID: "current",
  SESSION_HMAC_CURRENT_KEY: "current-key-for-narration-preview-fixture-32-bytes",
  QUOTA_SALT: "narration-preview-quota-salt-fixture-32-bytes",
  TURNSTILE_SECRET: "narration-preview-turnstile-secret-fixture-32-bytes",
  TURNSTILE_EXPECTED_ACTION: "cuebench-upload",
};
const projectOwnerCapability = "a".repeat(64);

const cacheKey = (input: {
  readonly beatId: string;
  readonly itemRevision: number;
  readonly text: string;
  readonly model?: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly responseFormat?: "wav";
  readonly speed?: number;
}): string => canonicalHash("cuebench.narration-preview.cache.v1", {
  beatId: input.beatId,
  itemRevision: input.itemRevision,
  text: input.text,
  model: input.model ?? "gpt-4o-mini-tts",
  voice: input.voice ?? "marin",
  instructions: input.instructions ?? "Read this audio description clearly, neutrally, and at a measured pace. Do not add information, interpretation, or sound effects.",
  responseFormat: input.responseFormat ?? "wav",
  speed: input.speed ?? 1,
}).slice("sha256:".length);

const setup = async (tts?: NarrationTtsProvider) => {
  const settings = resolveWorkerSettings(env);
  const session = await issueAnonymousSession({
    sessionId: "narration-session",
    issuedAtMs: now,
    expiresAtMs: now + 60 * 60_000,
    keyRing: settings.keyRing,
  });
  const provider = tts ?? createNarrationTtsProvider({});
  const synthesize = vi.spyOn(provider, "synthesize");
  const ledger = new InMemoryQuotaLedger();
  const reserveTts = vi.spyOn(ledger, "reserveTtsOutcome");
  const previews = new InMemoryNarrationPreviewRecordStore();
  const app = createNarrationPreviewRoutes(env, {
    clock: () => now,
    quotaLedger: ledger,
    previews,
    tts: provider,
  });
  const request = (overrides: Record<string, unknown> = {}) => {
    const text = typeof overrides.text === "string" ? overrides.text : "A watershed map fills the screen.";
    const beatId = typeof overrides.beatId === "string" ? overrides.beatId : "ad01";
    const itemRevision = typeof overrides.itemRevision === "number" ? overrides.itemRevision : 1;
    const key = typeof overrides.cacheKey === "string" ? overrides.cacheKey : cacheKey({ beatId, itemRevision, text });
    return new Request("https://cuebench.test/api/narration-preview", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        "x-cuebench-project-owner": projectOwnerCapability,
      },
      body: JSON.stringify({
        projectId: "narration-project",
        operationId: "tts_preview_operation",
        beatId,
        itemRevision,
        text,
        model: "gpt-4o-mini-tts",
        voice: "marin",
        instructions: "Read this audio description clearly, neutrally, and at a measured pace. Do not add information, interpretation, or sound effects.",
        responseFormat: "wav",
        speed: 1,
        cacheKey: key,
        ...overrides,
      }),
    });
  };
  return { app, request, synthesize, reserveTts, previews };
};

describe("narration-preview hosted route", () => {
  it("authenticates a signed session/project/beat revision, reserves quota before TTS, and returns only validated WAV bytes", async () => {
    const fixture = await setup();

    const response = await fixture.app.fetch(fixture.request());

    expect(response.status).toBe(200);
    expect(fixture.reserveTts).toHaveBeenCalledTimes(1);
    expect(fixture.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      input: "A watershed map fills the screen.",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      responseFormat: "wav",
    }));
    expect(fixture.reserveTts.mock.invocationCallOrder[0]).toBeLessThan(fixture.synthesize.mock.invocationCallOrder[0]!);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-cuebench-narration-duration-ms")).toMatch(/^\d+$/u);
    expect([...new Uint8Array(await response.arrayBuffer()).subarray(0, 4)]).toEqual([...new TextEncoder().encode("RIFF")]);
  });

  it("never issues a second billable call after an existing completed operation", async () => {
    const fixture = await setup();

    expect((await fixture.app.fetch(fixture.request())).status).toBe(200);
    const replay = await fixture.app.fetch(fixture.request());

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_PREVIEW_COMPLETED", retrySafe: false }),
    });
    expect(fixture.synthesize).toHaveBeenCalledTimes(1);
  });

  it("persists an accepted-unknown receipt for a transport or 5xx ambiguity and fails closed on retry", async () => {
    const provider: NarrationTtsProvider = {
      mode: "live",
      synthesize: vi.fn(async () => {
        throw new OpenAIProviderError("provider response was lost", true, "accepted-unknown");
      }),
    };
    const fixture = await setup(provider);

    const ambiguous = await fixture.app.fetch(fixture.request());
    const replay = await fixture.app.fetch(fixture.request());

    expect(ambiguous.status).toBe(503);
    await expect(ambiguous.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_PREVIEW_ACCEPTED_UNKNOWN", retrySafe: false }),
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_PREVIEW_ACCEPTED_UNKNOWN", retrySafe: false }),
    });
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it("binds one operation id to the exact cache identity instead of silently reusing it for another beat revision", async () => {
    const fixture = await setup();

    expect((await fixture.app.fetch(fixture.request())).status).toBe(200);
    const text = "The updated watershed diagram fills the screen.";
    const conflict = await fixture.app.fetch(fixture.request({
      itemRevision: 2,
      text,
      cacheKey: cacheKey({ beatId: "ad01", itemRevision: 2, text }),
    }));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_IDEMPOTENCY_CONFLICT" }),
    });
    expect(fixture.synthesize).toHaveBeenCalledTimes(1);
  });

  it("records an invalid WAV as accepted-unknown rather than returning uncached/unvalidated provider bytes or replaying", async () => {
    const provider: NarrationTtsProvider = {
      mode: "live",
      synthesize: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "audio/wav",
        model: "gpt-4o-mini-tts",
        voice: "marin",
        responseFormat: "wav" as const,
        store: null,
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        warnings: [],
      })),
    };
    const fixture = await setup(provider);

    const invalid = await fixture.app.fetch(fixture.request());
    const replay = await fixture.app.fetch(fixture.request());

    expect(invalid.status).toBe(503);
    await expect(invalid.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_PREVIEW_ACCEPTED_UNKNOWN", retrySafe: false }),
    });
    expect(replay.status).toBe(409);
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it("fails closed if an adapter returns audio outside the server-pinned TTS model/voice profile", async () => {
    const fixtureProvider = createNarrationTtsProvider({});
    const provider: NarrationTtsProvider = {
      mode: "live",
      synthesize: async (input) => ({
        ...await fixtureProvider.synthesize(input),
        // The request was pinned, but a server boundary must also reject a
        // compromised/misconfigured adapter response before exposing audio.
        voice: "alloy",
      }),
    };
    const fixture = await setup(provider);

    const response = await fixture.app.fetch(fixture.request());
    const replay = await fixture.app.fetch(fixture.request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "TTS_PREVIEW_ACCEPTED_UNKNOWN", retrySafe: false }),
    });
    expect(replay.status).toBe(409);
  });

  it("rejects over-cap or non-allowlisted TTS input before a provider call", async () => {
    const fixture = await setup();
    const oversized = "x".repeat(4_097);
    const cases = [
      fixture.request({ text: oversized, cacheKey: cacheKey({ beatId: "ad01", itemRevision: 1, text: oversized }) }),
      fixture.request({ model: "gpt-4o-tts", cacheKey: cacheKey({ beatId: "ad01", itemRevision: 1, text: "A watershed map fills the screen.", model: "gpt-4o-tts" }) }),
      fixture.request({ voice: "alloy", cacheKey: cacheKey({ beatId: "ad01", itemRevision: 1, text: "A watershed map fills the screen.", voice: "alloy" }) }),
      fixture.request({ speed: 1.1, cacheKey: cacheKey({ beatId: "ad01", itemRevision: 1, text: "A watershed map fills the screen.", speed: 1.1 }) }),
    ];

    for (const request of cases) expect((await fixture.app.fetch(request)).status).toBe(400);
    expect(fixture.synthesize).not.toHaveBeenCalled();
  });
});
