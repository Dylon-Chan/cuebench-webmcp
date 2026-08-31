import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDIO_DESCRIPTION_MODEL,
  createAudioDescriptionProvider,
  type AudioDescriptionProviderRequest,
} from "./audio-description";

const digest = (character: string): string => character.repeat(64);

const input: AudioDescriptionProviderRequest = {
  runId: "run-ad-1",
  window: { windowId: "ad-window-1", startMs: 0, endMs: 60_000 },
  transcript: [{ itemId: "cue-1", itemRevision: 1, startMs: 1_000, endMs: 4_000, text: "Dr. Nguyen introduces the map." }],
  speechGaps: [{ startMs: 4_000, endMs: 8_000 }],
  sceneTimestamps: [0, 5_000],
  frames: [{
    evidenceId: "frame-1",
    atMs: 5_000,
    mimeType: "image/webp",
    sha256: digest("a"),
    bytes: new TextEncoder().encode("private-thumbnail"),
  }],
};

describe("AudioDescriptionOpenAIProvider", () => {
  it("defaults to deterministic fixture proposals and never reaches the network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createAudioDescriptionProvider({}, { fetch });

    const result = await provider.propose(input);

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      store: false,
      background: false,
      model: "fixture",
      value: { proposals: expect.any(Array) },
    });
  });

  it("uses foreground non-retained strict Responses output and bounded frame input only after live opt-in", async () => {
    const requests: Request[] = [];
    const provider = createAudioDescriptionProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          id: "resp-ad-1",
          status: "completed",
          model: DEFAULT_AUDIO_DESCRIPTION_MODEL,
          output_text: JSON.stringify({
            proposals: [{
              proposal_id: "ad-proposal-1",
              text: "A watershed map fills the screen.",
              rationale: "The map establishes the visual comparison.",
              evidence_ids: ["frame-1"],
              placement_intent: { anchor_ms: 4_000, desired_duration_ms: 2_500 },
            }],
          }),
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        });
      },
    });

    const result = await provider.propose(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer server-only-test-key");
    const body = await requests[0]?.clone().json() as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEFAULT_AUDIO_DESCRIPTION_MODEL,
      background: false,
      store: false,
      stream: false,
      tools: [],
      tool_choice: "none",
      parallel_tool_calls: false,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(JSON.stringify(body.input)).toContain("data:image/webp;base64,");
    expect(result).toMatchObject({
      store: false,
      background: false,
      model: DEFAULT_AUDIO_DESCRIPTION_MODEL,
      value: { proposals: [{ evidenceIds: ["frame-1"] }] },
    });
  });

  it("fails closed when structured output tries to cite evidence that was not in the bounded window", async () => {
    const provider = createAudioDescriptionProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, {
      fetch: async () => Response.json({
        id: "resp-ad-invalid",
        status: "completed",
        output_text: JSON.stringify({
          proposals: [{
            proposal_id: "ad-proposal-invalid",
            text: "An unsupported visual appears.",
            rationale: "This is intentionally invalid.",
            evidence_ids: ["not-in-window"],
            placement_intent: { anchor_ms: 4_000, desired_duration_ms: 2_500 },
          }],
        }),
      }),
    });

    await expect(provider.propose(input)).rejects.toThrow(/evidence/i);
  });

  it.each([
    ["incomplete", { id: "resp-ad-incomplete", status: "incomplete", output_text: "{}" }],
    ["refusal", {
      id: "resp-ad-refusal",
      status: "completed",
      output: [{ content: [{ type: "refusal", refusal: "I cannot comply." }] }],
    }],
  ])("treats a %s Responses result as accepted-unknown rather than replayable", async (_name, response) => {
    const provider = createAudioDescriptionProvider({
      CUEBENCH_OPENAI_MODE: "live",
      OPENAI_API_KEY: "server-only-test-key",
    }, { fetch: async () => Response.json(response) });

    await expect(provider.propose(input)).rejects.toMatchObject({
      name: "OpenAIProviderError",
      safeToReplay: false,
      replaySafety: "accepted-unknown",
    });
  });
});
