/** Authoritative media facts come from the private preparation service, never browser or R2 metadata. */
export interface AuthoritativeMediaFacts {
  readonly container: string;
  readonly mimeType: string;
  readonly codec: string;
  readonly durationMs: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface MediaProbe {
  probe: (input: { readonly objectKey: string; readonly operationReceipt: string }) => Promise<AuthoritativeMediaFacts>;
}

export interface MediaProbeBinding {
  fetch: (request: Request) => Promise<Response>;
}

/** HTTP binding reserved for the Task 12 media service; its absence deliberately fails closed. */
export class MediaProbeServiceBinding implements MediaProbe {
  public constructor(private readonly binding: MediaProbeBinding) {}

  public async probe(input: { readonly objectKey: string; readonly operationReceipt: string }): Promise<AuthoritativeMediaFacts> {
    const response = await this.binding.fetch(new Request("https://cuebench-media.internal/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    if (!response.ok) throw new Error("CueBench's authoritative media probe is unavailable.");
    const value = await response.json() as unknown;
    if (!isAuthoritativeMediaFacts(value)) throw new Error("CueBench's authoritative media probe returned incomplete facts.");
    return value;
  }
}

export const isAuthoritativeMediaFacts = (value: unknown): value is AuthoritativeMediaFacts => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const facts = value as Readonly<Record<string, unknown>>;
  return typeof facts.container === "string"
    && typeof facts.mimeType === "string"
    && typeof facts.codec === "string"
    && Number.isSafeInteger(facts.durationMs)
    && Number.isSafeInteger(facts.byteLength)
    && typeof facts.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(facts.sha256);
};

export const isSupportedAuthoritativeMedia = (facts: AuthoritativeMediaFacts, limits: { readonly maxBytes: number; readonly maxDurationMs: number }): boolean => (
  facts.byteLength > 0
  && facts.byteLength <= limits.maxBytes
  && facts.durationMs > 0
  && facts.durationMs <= limits.maxDurationMs
  && ((facts.container === "webm" && facts.mimeType === "video/webm" && ["vp8", "vp9", "av1"].includes(facts.codec.toLowerCase()))
    || (facts.container === "mp4" && facts.mimeType === "video/mp4" && ["h264", "avc1", "hevc"].includes(facts.codec.toLowerCase())))
);
