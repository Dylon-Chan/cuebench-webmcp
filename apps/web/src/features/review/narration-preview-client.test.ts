import { describe, expect, it } from "vitest";
import type { CachedNarrationPreview, NarrationPreviewRequest } from "./NarrationPreview";
import { createNarrationPreviewGateway } from "./narration-preview-client";

const request: NarrationPreviewRequest = {
  projectId: "preview-project",
  operationId: `tts_${"a".repeat(64)}`,
  beatId: "ad01",
  itemRevision: 1,
  text: "A watershed map fills the screen.",
  model: "gpt-4o-mini-tts",
  voice: "marin",
  instructions: "Read clearly.",
  responseFormat: "wav",
  speed: 1,
  cacheKey: "a".repeat(64),
};

const wav = (durationMs = 1_000): Uint8Array => {
  const sampleRate = 24_000;
  const bytesPerSample = 2;
  const dataBytes = Math.floor((durationMs * sampleRate / 1_000) * bytesPerSample);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
};

const responseBody = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const setup = (response: Response) => {
  const calls: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit | undefined }> = [];
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return response;
  };
  let cached: CachedNarrationPreview | undefined;
  const saved: CachedNarrationPreview[] = [];
  const cache = {
    load: async (): Promise<CachedNarrationPreview | undefined> => cached,
    save: async (input: NarrationPreviewRequest & CachedNarrationPreview): Promise<void> => { saved.push(input); },
  };
  const urls = { createObjectURL: () => "blob:cuebench:narration", revokeObjectURL: () => undefined };
  const gateway = createNarrationPreviewGateway({
    resolveAuthorization: async () => ({ session: "signed-session", projectOwnerCapability: "b".repeat(64) }),
    cache,
    fetcher,
    urlApi: urls,
  });
  return {
    gateway,
    calls,
    setCached: (value: CachedNarrationPreview | undefined) => { cached = value; },
    saved,
  };
};

describe("hosted narration-preview browser gateway", () => {
  it("sends only a signed session/owner and complete idempotent request, then accepts a duration-validated WAV", async () => {
    const bytes = wav();
    const fixture = setup(new Response(responseBody(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": "audio/wav",
        "x-cuebench-narration-duration-ms": "1000",
        "x-cuebench-narration-store": "not-applicable",
      },
    }));

    const result = await fixture.gateway.synthesize(request);

    expect(result).toMatchObject({ contentType: "audio/wav", responseFormat: "wav", store: null });
    expect(await fixture.gateway.measureDurationMs(result.blob)).toBe(1_000);
    const sent = fixture.calls[0]?.init;
    if (sent === undefined) throw new Error("Expected a hosted narration request.");
    expect(fixture.calls[0]?.input).toBe("/api/narration-preview");
    expect(sent.headers).toEqual(expect.objectContaining({
      authorization: "Bearer signed-session",
      "x-cuebench-project-owner": "b".repeat(64),
    }));
    expect(JSON.parse(sent.body as string)).toEqual(expect.objectContaining({
      operationId: request.operationId,
      cacheKey: request.cacheKey,
      text: request.text,
    }));
    expect(JSON.stringify(sent.headers)).not.toMatch(/openai|api[_-]?key/i);
  });

  it("forwards an agent cancellation signal to the hosted narration request", async () => {
    const bytes = wav();
    const fixture = setup(new Response(responseBody(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-length": String(bytes.byteLength),
        "content-type": "audio/wav",
        "x-cuebench-narration-duration-ms": "1000",
        "x-cuebench-narration-store": "not-applicable",
      },
    }));
    const controller = new AbortController();

    await fixture.gateway.synthesize(request, { signal: controller.signal });
    expect(fixture.calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("rejects a hosted WAV receipt whose declared duration does not match the measured bytes", async () => {
    const bytes = wav();
    const fixture = setup(new Response(responseBody(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-type": "audio/wav",
        "x-cuebench-narration-duration-ms": "999",
        "x-cuebench-narration-store": "not-applicable",
      },
    }));

    await expect(fixture.gateway.synthesize(request)).rejects.toThrow(/duration/i);
  });

  it("does not return a corrupt cached narration blob to the audio element", async () => {
    const response = new Response(responseBody(wav()), { headers: { "content-type": "audio/wav" } });
    const fixture = setup(response);
    fixture.setCached({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      contentType: "audio/wav",
      measuredDurationMs: 1_000,
    });

    await expect(fixture.gateway.loadCached({ projectId: request.projectId, cacheKey: request.cacheKey })).resolves.toBeUndefined();
  });
});
