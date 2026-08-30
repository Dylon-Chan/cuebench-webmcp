import type { CaptionProject } from "@cuebench/domain";
import { useEffect, useRef, useState } from "react";
import {
  Timeline,
  type TimelineCommandExecutor,
} from "../timeline/Timeline";
import { formatMediaTime } from "../timeline/time-transform";
import { usePlayhead } from "../timeline/use-playhead";
import type { PreparedMediaEvidence } from "./project-media-evidence";

export interface VideoEvidenceBayProps {
  readonly project: CaptionProject;
  /** The live Blob URL owned by ProjectStore; no proxy media source is introduced. */
  readonly sourceObjectUrl: string;
  readonly onCommand: TimelineCommandExecutor;
  /** Prepared-media evidence is supplied by the project/evidence adapter. */
  readonly evidence: PreparedMediaEvidence;
  /** Lets adjacent semantic review controls seek the one native media clock. */
  readonly onSeekReady?: (seekToMediaTime: (mediaTimeMs: number) => void) => void;
}

/**
 * Evidence-first playback surface. The native `<video>` element is the only
 * source of playback time; Timeline receives a projection and a seek callback.
 */
export function VideoEvidenceBay({
  project,
  sourceObjectUrl,
  onCommand,
  evidence,
  onSeekReady,
}: VideoEvidenceBayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const playhead = usePlayhead(videoRef, { durationMs: project.media.durationMs });

  useEffect(() => {
    onSeekReady?.(playhead.seekToMediaTime);
  }, [onSeekReady, playhead.seekToMediaTime]);

  const syncNativeAudioState = () => {
    const video = videoRef.current;
    if (video === null) return;
    setIsMuted(video.muted);
    setVolume(video.volume);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (video === null) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const changeVolume = (nextVolume: number) => {
    const video = videoRef.current;
    if (video === null) return;
    video.volume = Math.max(0, Math.min(1, nextVolume));
    setVolume(video.volume);
  };

  const peakStatusMessage = evidence.audioState === "ready"
    ? "Audio peak evidence is ready."
    : evidence.audioState === "no-audio"
      ? "No audio track in this source."
      : evidence.audioState === "failed"
        ? `Waveform evidence preparation failed${evidence.failureMessage === undefined ? "." : `: ${evidence.failureMessage}`}`
        : "Waveform pending local evidence preparation.";

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
          playsInline
          preload="metadata"
          aria-label="Verified local source media"
          onLoadedMetadata={syncNativeAudioState}
          onVolumeChange={syncNativeAudioState}
          onError={() => setMediaError("CueBench could not play this local source media.")}
        />
        <div className="specimen-view__note">Local source media verified in this browser.</div>
      </div>
      <div className="transport-bar" aria-label="Playback transport">
        <button className="transport-control" type="button" onClick={playhead.togglePlayback}>
          {playhead.isPlaying ? "Pause" : "Play"}
        </button>
        <button className="transport-control" type="button" onClick={toggleMute} aria-label={isMuted ? "Unmute source audio" : "Mute source audio"}>
          {isMuted ? "Unmute" : "Mute"}
        </button>
        <label className="transport-volume">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            aria-label="Source audio volume"
            onChange={(event) => changeVolume(Number(event.currentTarget.value))}
          />
        </label>
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
        peakPyramid={evidence.audioState === "ready" ? evidence.peakPyramid : null}
      />
      <p className="timeline-evidence-status" data-testid="media-evidence-status" role="status" aria-live="polite">{peakStatusMessage}</p>
    </section>
  );
}
