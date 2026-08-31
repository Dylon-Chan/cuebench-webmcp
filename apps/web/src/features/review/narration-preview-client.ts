import { measureNarrationWavBlob } from "../../shared/wav";
import type {
  CachedNarrationPreview,
  NarrationPreviewGateway,
  NarrationPreviewRequest,
  NarrationPreviewSynthesis,
} from "./NarrationPreview";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface NarrationPreviewAuthorization {
  readonly session: string;
  readonly projectOwnerCapability: string;
}

export interface NarrationPreviewCachePort {
  readonly load: (input: Pick<NarrationPreviewRequest, "projectId" | "cacheKey">) => Promise<CachedNarrationPreview | undefined>;
  readonly save: (input: NarrationPreviewRequest & CachedNarrationPreview) => Promise<void>;
}

export interface NarrationPreviewObjectUrlApi {
  readonly createObjectURL: (object: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

export interface NarrationPreviewGatewayOptions {
  readonly resolveAuthorization: (projectId: string) => Promise<NarrationPreviewAuthorization>;
  readonly cache: NarrationPreviewCachePort;
  readonly fetcher?: typeof globalThis.fetch;
  readonly urlApi?: NarrationPreviewObjectUrlApi;
}

export class NarrationPreviewClientError extends Error {
  public constructor(
    message: string,
    public readonly details: { readonly code?: string; readonly retrySafe?: boolean; readonly status?: number } = {},
  ) {
    super(message);
    this.name = "NarrationPreviewClientError";
  }
}

const validSession = (value: string): boolean => value.trim().length > 0 && value.length <= 8_192;
const validOwner = (value: string): boolean => /^[0-9a-f]{64}$/iu.test(value);

const errorFromResponse = async (response: Response): Promise<NarrationPreviewClientError> => {
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 8 * 1024)) {
      return new NarrationPreviewClientError("CueBench returned an unsupported narration-preview error response. Refresh before trying again.", { code: "UNSUPPORTED_ERROR_RESPONSE", status: response.status });
    }
    const body = await response.json() as { readonly error?: Readonly<Record<string, unknown>> };
    const error = body.error;
    if (error?.version !== 1 || typeof error.message !== "string") {
      return new NarrationPreviewClientError("CueBench returned an unsupported narration-preview error response. Refresh before trying again.", { code: "UNSUPPORTED_ERROR_RESPONSE", status: response.status });
    }
    return new NarrationPreviewClientError(error.message, {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.retrySafe === "boolean" ? { retrySafe: error.retrySafe } : {}),
      status: response.status,
    });
  } catch {
    return new NarrationPreviewClientError("CueBench could not prepare this narration preview. Try again without changing the beat.", { status: response.status });
  }
};

const validDurationHeader = (value: string | null): number | null => value !== null && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 60_000
  ? Number(value)
  : null;

const sameOriginFetcher = (fetcher: typeof globalThis.fetch | undefined): typeof globalThis.fetch => {
  if (fetcher !== undefined) return fetcher;
  if (typeof globalThis.fetch !== "function") throw new NarrationPreviewClientError("CueBench narration preview is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const urlApiFor = (urlApi: NarrationPreviewGatewayOptions["urlApi"]): NarrationPreviewObjectUrlApi => {
  if (urlApi !== undefined) return urlApi;
  if (typeof URL.createObjectURL !== "function" || typeof URL.revokeObjectURL !== "function") {
    throw new NarrationPreviewClientError("CueBench narration preview is unavailable because this browser cannot safely create a local audio URL.");
  }
  return URL;
};

/**
 * Browser endpoint adapter. It owns no OpenAI credential and only gives the
 * component a valid, measured WAV preview after the Worker authenticated it.
 */
export const createNarrationPreviewGateway = (options: NarrationPreviewGatewayOptions): NarrationPreviewGateway => {
  const fetcher = sameOriginFetcher(options.fetcher);
  const urls = urlApiFor(options.urlApi);
  return {
    loadCached: async (input) => {
      const cached = await options.cache.load(input);
      if (cached === undefined || cached.contentType.trim().toLowerCase() !== "audio/wav") return undefined;
      try {
        const measuredDurationMs = await measureNarrationWavBlob(cached.blob);
        return measuredDurationMs === cached.measuredDurationMs ? cached : undefined;
      } catch {
        // A malformed/corrupt disposable cache row is never returned to an
        // <audio> element. A fresh route request can safely make a new local
        // cache only if its idempotent receipt permits one.
        return undefined;
      }
    },
    saveCached: async (input) => {
      if (input.contentType.trim().toLowerCase() !== "audio/wav") throw new NarrationPreviewClientError("CueBench only caches validated WAV narration previews.");
      const measuredDurationMs = await measureNarrationWavBlob(input.blob);
      if (measuredDurationMs !== input.measuredDurationMs) throw new NarrationPreviewClientError("CueBench refused to cache a narration preview with an inconsistent measured duration.");
      await options.cache.save(input);
    },
    synthesize: async (input, requestOptions = {}): Promise<NarrationPreviewSynthesis> => {
      const authorization = await options.resolveAuthorization(input.projectId);
      if (!validSession(authorization.session) || !validOwner(authorization.projectOwnerCapability)) {
        throw new NarrationPreviewClientError("CueBench needs a current anti-abuse session and browser-project owner identity before narration preview can start.");
      }
      let response: Response;
      try {
        response = await fetcher("/api/narration-preview", {
          method: "POST",
          ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          headers: {
            authorization: `Bearer ${authorization.session}`,
            "content-type": "application/json",
            "x-cuebench-project-owner": authorization.projectOwnerCapability.toLowerCase(),
          },
          body: JSON.stringify({
            projectId: input.projectId,
            operationId: input.operationId,
            beatId: input.beatId,
            itemRevision: input.itemRevision,
            text: input.text,
            model: input.model,
            voice: input.voice,
            instructions: input.instructions,
            responseFormat: input.responseFormat,
            speed: input.speed,
            cacheKey: input.cacheKey,
          }),
        });
      } catch {
        throw new NarrationPreviewClientError("CueBench could not reach the narration-preview service. It did not retry a possibly billable request automatically.");
      }
      if (!response.ok) throw await errorFromResponse(response);
      if (
        response.headers.get("cache-control") !== "no-store"
        || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "audio/wav"
        || response.headers.get("x-cuebench-narration-store") !== "not-applicable"
      ) throw new NarrationPreviewClientError("CueBench rejected an unsafe narration-preview response.");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
        throw new NarrationPreviewClientError("CueBench rejected an oversized narration-preview response.");
      }
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > MAX_RESPONSE_BYTES) throw new NarrationPreviewClientError("CueBench rejected an invalid narration-preview response.");
      const measuredDurationMs = await measureNarrationWavBlob(new Blob([blob], { type: "audio/wav" }));
      const serverDurationMs = validDurationHeader(response.headers.get("x-cuebench-narration-duration-ms"));
      if (serverDurationMs === null || serverDurationMs !== measuredDurationMs) {
        throw new NarrationPreviewClientError("CueBench rejected a narration preview whose validated duration did not match the hosted receipt.");
      }
      return {
        blob: new Blob([blob], { type: "audio/wav" }),
        contentType: "audio/wav",
        model: input.model,
        voice: input.voice,
        responseFormat: "wav",
        store: null,
        warnings: [],
      };
    },
    measureDurationMs: measureNarrationWavBlob,
    createObjectUrl: (blob) => urls.createObjectURL(blob),
    revokeObjectUrl: (url) => urls.revokeObjectURL(url),
  };
};
