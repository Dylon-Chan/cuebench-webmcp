import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { clampMediaTime } from "./time-transform";

interface VideoFrameMetadataLike {
  readonly mediaTime: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameMetadataLike) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface PlayheadController {
  readonly mediaTimeMs: number;
  readonly isPlaying: boolean;
  readonly seekToMediaTime: (mediaTimeMs: number) => void;
  readonly togglePlayback: () => void;
}

export interface UsePlayheadOptions {
  readonly durationMs: number;
  readonly timeupdateThrottleMs?: number;
}

/**
 * The video element owns time. React only reads `currentTime` from that source
 * on native frame/timing events and exposes an integer Media Time projection.
 */
export function usePlayhead(
  videoRef: RefObject<HTMLVideoElement | null>,
  { durationMs, timeupdateThrottleMs = 80 }: UsePlayheadOptions,
): PlayheadController {
  const [mediaTimeMs, setMediaTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const lastPublishedMs = useRef<number | null>(null);

  const publishCurrentTime = useCallback((force = false) => {
    const video = videoRef.current;
    if (video === null) return;
    const nextMediaTimeMs = clampMediaTime(video.currentTime * 1_000, durationMs);
    if (force || lastPublishedMs.current !== nextMediaTimeMs) {
      lastPublishedMs.current = nextMediaTimeMs;
      setMediaTimeMs(nextMediaTimeMs);
    }
    setIsPlaying(!video.paused && !video.ended);
  }, [durationMs, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return undefined;
    const frameVideo = video as FrameCallbackVideo;
    let frameHandle: number | null = null;
    let cancelled = false;
    let lastTimeupdateAt = -Infinity;
    const publish = () => publishCurrentTime(true);
    const onTimeUpdate = () => {
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (now - lastTimeupdateAt < timeupdateThrottleMs) return;
      lastTimeupdateAt = now;
      publishCurrentTime();
    };
    const requestFrame = () => {
      if (frameVideo.requestVideoFrameCallback === undefined || cancelled) return;
      frameHandle = frameVideo.requestVideoFrameCallback(() => {
        // `currentTime`, not callback metadata, remains the authoritative clock.
        publishCurrentTime();
        requestFrame();
      });
    };

    video.addEventListener("loadedmetadata", publish);
    video.addEventListener("seeking", publish);
    video.addEventListener("seeked", publish);
    video.addEventListener("play", publish);
    video.addEventListener("pause", publish);
    video.addEventListener("ended", publish);
    if (frameVideo.requestVideoFrameCallback === undefined) video.addEventListener("timeupdate", onTimeUpdate);
    else requestFrame();
    publish();

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", publish);
      video.removeEventListener("seeking", publish);
      video.removeEventListener("seeked", publish);
      video.removeEventListener("play", publish);
      video.removeEventListener("pause", publish);
      video.removeEventListener("ended", publish);
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (frameHandle !== null) frameVideo.cancelVideoFrameCallback?.(frameHandle);
    };
  }, [publishCurrentTime, timeupdateThrottleMs, videoRef]);

  const seekToMediaTime = useCallback((nextMediaTimeMs: number) => {
    const video = videoRef.current;
    if (video === null) return;
    video.currentTime = clampMediaTime(nextMediaTimeMs, durationMs) / 1_000;
    publishCurrentTime(true);
  }, [durationMs, publishCurrentTime, videoRef]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) {
      void video.play().catch(() => publishCurrentTime(true));
      return;
    }
    video.pause();
  }, [publishCurrentTime, videoRef]);

  return { mediaTimeMs, isPlaying, seekToMediaTime, togglePlayback };
}
