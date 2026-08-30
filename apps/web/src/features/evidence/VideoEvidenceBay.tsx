import type { CaptionProject } from "@cuebench/domain";
import { useEffect, useRef, useState } from "react";
import {
  Timeline,
  type TimelineCommandExecutor,
} from "../timeline/Timeline";
import {
  createPeakPyramidFromAudioBuffer,
  type WaveformPeakPyramid,
} from "../timeline/WaveformCanvas";
import { formatMediaTime } from "../timeline/time-transform";
import { usePlayhead } from "../timeline/use-playhead";

type AudioContextConstructor = new () => AudioContext;

const browserAudioContext = (): AudioContextConstructor | null => {
  const candidate = globalThis as typeof globalThis & { readonly webkitAudioContext?: AudioContextConstructor };
  return globalThis.AudioContext ?? candidate.webkitAudioContext ?? null;
};

export interface VideoEvidenceBayProps {
  readonly project: CaptionProject;
  /** The live Blob URL owned by ProjectStore; no proxy media source is introduced. */
  readonly sourceObjectUrl: string;
  readonly onCommand: TimelineCommandExecutor;
  /** Task 11 prepared-media evidence can provide the server-built pyramid directly. */
  readonly sourcePeakPyramid?: WaveformPeakPyramid | null;
}

/**
 * Evidence-first playback surface. The native `<video>` element is the only
 * source of playback time; Timeline receives a projection and a seek callback.
 */
export function VideoEvidenceBay({
  project,
  sourceObjectUrl,
  onCommand,
  sourcePeakPyramid,
}: VideoEvidenceBayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [derivedPeakPyramid, setDerivedPeakPyramid] = useState<WaveformPeakPyramid | null>(null);
  const [peakStatus, setPeakStatus] = useState<"preparing" | "ready" | "unavailable">(
    sourcePeakPyramid === undefined ? "preparing" : sourcePeakPyramid === null ? "unavailable" : "ready",
  );
  const [mediaError, setMediaError] = useState<string | null>(null);
  const playhead = usePlayhead(videoRef, { durationMs: project.media.durationMs });

  useEffect(() => {
    if (sourcePeakPyramid !== undefined) {
      setDerivedPeakPyramid(null);
      setPeakStatus(sourcePeakPyramid === null ? "unavailable" : "ready");
      return undefined;
    }
    const AudioContext = browserAudioContext();
    if (AudioContext === null || typeof globalThis.fetch !== "function") {
      setDerivedPeakPyramid(null);
      setPeakStatus("unavailable");
      return undefined;
    }
    const controller = new AbortController();
    const context = new AudioContext();
    let active = true;
    let closingContext = false;
    const closeContext = () => {
      if (closingContext) return;
      closingContext = true;
      void context.close().catch(() => undefined);
    };
    setDerivedPeakPyramid(null);
    setPeakStatus("preparing");
    void (async () => {
      try {
        const response = await fetch(sourceObjectUrl, { signal: controller.signal });
        if (!response.ok) throw new Error("Source media could not be read for waveform preparation.");
        const bytes = await response.arrayBuffer();
        const audio = await context.decodeAudioData(bytes);
        if (!active) return;
        setDerivedPeakPyramid(createPeakPyramidFromAudioBuffer(audio));
        setPeakStatus("ready");
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setDerivedPeakPyramid(null);
        setPeakStatus("unavailable");
      } finally {
        closeContext();
      }
    })();
    return () => {
      active = false;
      controller.abort();
      closeContext();
    };
  }, [sourceObjectUrl, sourcePeakPyramid]);

  const peakPyramid = sourcePeakPyramid === undefined ? derivedPeakPyramid : sourcePeakPyramid;
  const peakStatusMessage = peakStatus === "ready"
    ? "Audio peak evidence is ready."
    : peakStatus === "preparing"
      ? "Preparing deterministic 10 ms audio peak evidence from this local source."
      : "Audio peak evidence is unavailable for this source; no decorative waveform is substituted.";

  return (
    <section className="evidence-bay" aria-labelledby="evidence-bay-heading">
      <div className="region-heading">
        <div>
          <h1 id="evidence-bay-heading">Evidence bay</h1>
          <p>{project.media.sourceId} · {formatMediaTime(project.media.durationMs)}</p>
        </div>
        <span className="measurement-label">Native clock</span>
      </div>
      <div className="specimen-view" aria-label="Source media specimen">
        <video
          ref={videoRef}
          className="specimen-view__media"
          src={sourceObjectUrl}
          muted
          playsInline
          preload="metadata"
          aria-label="Verified local source media"
          onError={() => setMediaError("CueBench could not play this local source media.")}
        />
        <div className="specimen-view__note" role="status">Local source media verified in this browser.</div>
      </div>
      <div className="transport-bar" aria-label="Playback transport">
        <button className="transport-control" type="button" onClick={playhead.togglePlayback}>
          {playhead.isPlaying ? "Pause" : "Play"}
        </button>
        <output aria-label="Current media time">{formatMediaTime(playhead.mediaTimeMs)}</output>
        <span aria-hidden="true">/</span>
        <output aria-label="Source duration">{formatMediaTime(project.media.durationMs)}</output>
        <span className="transport-bar__spacer" />
        <span className="transport-note">Native video time drives every timeline lane.</span>
      </div>
      {mediaError === null ? null : <p className="form-error" role="alert">{mediaError}</p>}
      <Timeline
        project={project}
        playheadMs={playhead.mediaTimeMs}
        seekToMediaTime={playhead.seekToMediaTime}
        onCommand={onCommand}
        peakPyramid={peakPyramid}
      />
      <p className="timeline-evidence-status" role="status">{peakStatusMessage}</p>
    </section>
  );
}
