import { canonicalHash, type AudioDescriptionBeat } from "@cuebench/domain";
import { useEffect, useMemo, useRef, useState } from "react";

/** An explicit policy prompt is part of the cache identity and never user-supplied. */
export const DEFAULT_NARRATION_INSTRUCTIONS = "Read this audio description clearly, neutrally, and at a measured pace. Do not add information, interpretation, or sound effects.";
export const DEFAULT_NARRATION_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_NARRATION_VOICE = "marin";
export const DEFAULT_NARRATION_FORMAT = "wav" as const;
export const DEFAULT_NARRATION_SPEED = 1;

export interface NarrationPreviewRequest {
  readonly projectId: string;
  /** Stable opaque idempotency identity for exactly this complete TTS input. */
  readonly operationId: string;
  readonly beatId: string;
  readonly itemRevision: number;
  readonly text: string;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly responseFormat: "wav";
  readonly speed: number;
  /** Canonical SHA-256 without a namespace prefix; also serves as request idempotency identity. */
  readonly cacheKey: string;
}

export interface NarrationPreviewSynthesis {
  readonly blob: Blob;
  readonly contentType: string;
  readonly model: string;
  readonly voice: string;
  readonly responseFormat: "wav";
  /** `/v1/audio/speech` has no supported store parameter. */
  readonly store: null;
  readonly warnings: readonly string[];
}

export interface CachedNarrationPreview {
  readonly blob: Blob;
  readonly contentType: string;
  readonly measuredDurationMs: number;
}

/**
 * Browser-facing boundary for the hosted preview endpoint and IndexedDB.
 * The component never receives provider credentials and never treats this
 * disposable preview as project/certification evidence.
 */
export interface NarrationPreviewGateway {
  readonly loadCached: (input: Pick<NarrationPreviewRequest, "projectId" | "cacheKey">) => Promise<CachedNarrationPreview | undefined>;
  readonly saveCached: (input: NarrationPreviewRequest & CachedNarrationPreview) => Promise<void>;
  readonly synthesize: (input: NarrationPreviewRequest) => Promise<NarrationPreviewSynthesis>;
  readonly measureDurationMs: (blob: Blob) => Promise<number>;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

export interface NarrationPreviewProps {
  readonly projectId: string;
  readonly beat: AudioDescriptionBeat | null;
  readonly gateway: NarrationPreviewGateway;
  readonly disabled?: boolean;
}

interface ResolvedPreview {
  readonly source: "cache" | "fresh";
  readonly blob: Blob;
  readonly contentType: string;
  readonly measuredDurationMs: number;
  readonly cacheKey: string;
}

const cacheKeyFor = (input: Omit<NarrationPreviewRequest, "cacheKey" | "operationId">): string => {
  const full = canonicalHash("cuebench.narration-preview.cache.v1", {
    beatId: input.beatId,
    itemRevision: input.itemRevision,
    text: input.text,
    model: input.model,
    voice: input.voice,
    instructions: input.instructions,
    responseFormat: input.responseFormat,
    speed: input.speed,
  });
  return full.slice("sha256:".length);
};

/** Exposed for WebMCP/UI adapters so the cache identity stays exactly shared. */
export const narrationPreviewRequestFor = (
  projectId: string,
  beat: Pick<AudioDescriptionBeat, "itemId" | "current">,
): NarrationPreviewRequest => {
  const base = {
    projectId,
    beatId: beat.itemId,
    itemRevision: beat.current.itemRevision,
    text: beat.current.description.trim(),
    model: DEFAULT_NARRATION_MODEL,
    voice: DEFAULT_NARRATION_VOICE,
    instructions: DEFAULT_NARRATION_INSTRUCTIONS,
    responseFormat: DEFAULT_NARRATION_FORMAT,
    speed: DEFAULT_NARRATION_SPEED,
  } as const;
  const cacheKey = cacheKeyFor(base);
  return { ...base, cacheKey, operationId: `tts_${cacheKey}` };
};

const sameCurrentBeat = (
  current: AudioDescriptionBeat | null,
  request: Pick<NarrationPreviewRequest, "beatId" | "itemRevision" | "text">,
): boolean => current !== null
  && current.itemId === request.beatId
  && current.current.itemRevision === request.itemRevision
  && current.current.description.trim() === request.text;

const durationLabel = (durationMs: number): string => `${(durationMs / 1_000).toFixed(2)} s measured preview`;

const validMeasuredDuration = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 60_000;

/**
 * A deterministic, local-only review delta. It is calculated only for the
 * exact beat revision that owns the preview cache key; it neither mutates the
 * canonical finding set nor participates in certification.
 */
export const narrationPreviewFitDeltaMs = (
  beat: Pick<AudioDescriptionBeat, "current">,
  measuredDurationMs: number,
): number | null => {
  const availableMs = beat.current.endMs - beat.current.startMs;
  return validMeasuredDuration(measuredDurationMs) && Number.isSafeInteger(availableMs) && availableMs > 0
    ? measuredDurationMs - availableMs
    : null;
};

const fitLabel = (deltaMs: number): string => deltaMs <= 0
  ? `Fit check: ${Math.abs(deltaMs)} ms spare in this beat's dialogue-free slot.`
  : `Fit check: narration overruns this beat's dialogue-free slot by ${deltaMs} ms.`;

/**
 * A selected beat's listening check. A user starts it explicitly; cached
 * audio is keyed by every output-affecting synthesis input and is intentionally
 * separate from the canonical project aggregate.
 */
export function NarrationPreview({ projectId, beat, gateway, disabled = false }: NarrationPreviewProps) {
  const request = useMemo(() => beat === null ? null : narrationPreviewRequestFor(projectId, beat), [beat, projectId]);
  const latestBeat = useRef(beat);
  const objectUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  latestBeat.current = beat;

  const replacePreview = (next: ResolvedPreview): void => {
    if (objectUrl.current !== null) gateway.revokeObjectUrl(objectUrl.current);
    objectUrl.current = gateway.createObjectUrl(next.blob);
    setPreview(next);
  };

  useEffect(() => () => {
    if (objectUrl.current !== null) gateway.revokeObjectUrl(objectUrl.current);
    objectUrl.current = null;
  }, [gateway]);

  useEffect(() => {
    // A preview can never be displayed after an edit changes the complete
    // synthesis identity. It stays available in IndexedDB only under its old,
    // now-unreachable full-input key.
    if (preview !== null && (request === null || preview.cacheKey !== request.cacheKey)) {
      if (objectUrl.current !== null) gateway.revokeObjectUrl(objectUrl.current);
      objectUrl.current = null;
      setPreview(null);
      setNotice(null);
      setError(null);
    }
  }, [gateway, preview, request]);

  const generate = async (): Promise<void> => {
    if (request === null || busy || disabled) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cached = await gateway.loadCached({ projectId: request.projectId, cacheKey: request.cacheKey });
      if (!sameCurrentBeat(latestBeat.current, request)) {
        setError("This audio-description beat changed while CueBench was preparing its preview. Generate a preview for the current revision instead.");
        return;
      }
      if (cached !== undefined) {
        if (!validMeasuredDuration(cached.measuredDurationMs)) throw new Error("CueBench found an invalid cached narration duration and did not play it.");
        replacePreview({ ...cached, cacheKey: request.cacheKey, source: "cache" });
        setNotice("Cached in this browser for this exact narration revision.");
        return;
      }
      const synthesized = await gateway.synthesize(request);
      if (!sameCurrentBeat(latestBeat.current, request)) {
        // Measure to drain/check the exact returned Blob but never persist or
        // expose an obsolete revision after a concurrent human/agent change.
        await gateway.measureDurationMs(synthesized.blob);
        setError("This audio-description beat changed while CueBench was preparing its preview. Generate a preview for the current revision instead.");
        return;
      }
      if (
        synthesized.store !== null
        || synthesized.responseFormat !== "wav"
        || synthesized.contentType.trim().toLowerCase() !== "audio/wav"
      ) throw new Error("CueBench rejected a narration preview without its validated WAV privacy and format boundary.");
      const measuredDurationMs = await gateway.measureDurationMs(synthesized.blob);
      if (!validMeasuredDuration(measuredDurationMs)) throw new Error("CueBench could not measure this narration preview safely.");
      if (!sameCurrentBeat(latestBeat.current, request)) {
        setError("This audio-description beat changed while CueBench was preparing its preview. Generate a preview for the current revision instead.");
        return;
      }
      const cachedPreview = {
        blob: synthesized.blob,
        contentType: synthesized.contentType,
        measuredDurationMs,
      };
      await gateway.saveCached({ ...request, ...cachedPreview });
      if (!sameCurrentBeat(latestBeat.current, request)) {
        setError("This audio-description beat changed while CueBench was preparing its preview. Generate a preview for the current revision instead.");
        return;
      }
      replacePreview({ ...cachedPreview, cacheKey: request.cacheKey, source: "fresh" });
      setNotice(synthesized.warnings.length === 0
        ? "Synthetic narration preview is ready for listening."
        : `Synthetic narration preview is ready. ${synthesized.warnings.join(" ")}`);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.trim().length > 0
        ? cause.message
        : "CueBench could not prepare this narration preview. Try again without changing the beat.");
    } finally {
      setBusy(false);
    }
  };

  if (beat === null) return null;
  const audioUrl = preview === null ? null : objectUrl.current;
  const fitDeltaMs = preview === null ? null : narrationPreviewFitDeltaMs(beat, preview.measuredDurationMs);
  return (
    <section className="narration-preview" aria-labelledby="narration-preview-heading" aria-busy={busy || undefined}>
      <div className="panel-heading">
        <div>
          <h3 id="narration-preview-heading">Narration preview</h3>
          <p>Synthetic voice preview · {DEFAULT_NARRATION_MODEL} / {DEFAULT_NARRATION_VOICE}</p>
        </div>
        <span>AD{beat.itemId.replace(/^ad/iu, "").toUpperCase()}</span>
      </div>
      <p className="narration-preview__boundary">This listens for timing and delivery only. It is not certification evidence or a rendered narration track.</p>
      <div className="narration-preview__actions">
        <button className="button button--outline" type="button" disabled={disabled || busy} onClick={() => void generate()}>
          {busy ? "Preparing narration preview" : preview === null ? "Generate narration preview" : "Refresh narration preview"}
        </button>
        {preview === null ? null : <span className="narration-preview__duration">{durationLabel(preview.measuredDurationMs)}</span>}
      </div>
      {fitDeltaMs === null ? null : <p className="narration-preview__fit" role="status">{fitLabel(fitDeltaMs)} This review-only delta does not certify the beat.</p>}
      {audioUrl === null ? null : <audio aria-label={`Narration preview for ${beat.itemId.toUpperCase()}`} controls preload="metadata" src={audioUrl} />}
      {notice === null ? null : <p className="narration-preview__notice" role="status">{notice}</p>}
      {error === null ? null : <p className="narration-preview__error" role="alert">{error}</p>}
    </section>
  );
}
