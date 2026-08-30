import { useEffect, useRef } from "react";
import type { TimeTransform } from "./time-transform";

export interface WaveformPeak {
  readonly min: number;
  readonly max: number;
}

export interface WaveformPeakLevel {
  readonly resolutionMs: number;
  readonly peaks: readonly WaveformPeak[];
}

/** A 10 ms base level plus deterministic power-of-two coarser levels. */
export interface WaveformPeakPyramid {
  readonly baseResolutionMs: 10;
  readonly levels: readonly WaveformPeakLevel[];
}

/** Kept in lockstep with the rendered `.timeline-waveform` viewport. */
export const TIMELINE_WAVEFORM_HEIGHT_PX = 58;

export const EMPTY_WAVEFORM_PEAK_PYRAMID: WaveformPeakPyramid = {
  baseResolutionMs: 10,
  levels: [],
};

const clampAmplitude = (value: number): number => Number.isFinite(value)
  ? Math.max(-1, Math.min(1, value))
  : 0;

const reduceLevel = (level: WaveformPeakLevel): WaveformPeakLevel => {
  const peaks: WaveformPeak[] = [];
  for (let index = 0; index < level.peaks.length; index += 2) {
    const first = level.peaks[index];
    const second = level.peaks[index + 1];
    if (first === undefined) continue;
    peaks.push({
      min: Math.min(first.min, second?.min ?? first.min),
      max: Math.max(first.max, second?.max ?? first.max),
    });
  }
  return { resolutionMs: level.resolutionMs * 2, peaks };
};

/**
 * Builds the same 10 ms min/max pyramid that prepared-media evidence supplies
 * later. It only derives amplitudes from real decoded PCM and never invents a
 * decorative signal when decoding is unavailable.
 */
export const createPeakPyramid = (
  channels: readonly Float32Array[],
  sampleRate: number,
): WaveformPeakPyramid => {
  if (channels.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return EMPTY_WAVEFORM_PEAK_PYRAMID;
  const sampleCount = Math.max(...channels.map((channel) => channel.length));
  if (sampleCount === 0) return EMPTY_WAVEFORM_PEAK_PYRAMID;

  const basePeaks: WaveformPeak[] = [];
  const bucketCount = Math.ceil((sampleCount * 100) / sampleRate);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    // Derive both edges from time rather than rounding a samples-per-bucket
    // increment. This keeps the base level anchored to exact 10 ms windows
    // for sample rates that do not divide evenly by 100.
    const start = Math.floor((bucketIndex * sampleRate) / 100);
    const end = Math.min(sampleCount, Math.floor(((bucketIndex + 1) * sampleRate) / 100));
    if (end <= start) continue;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex];
      if (channel === undefined) continue;
      for (let index = start; index < end; index += 1) {
        const sample = channel[index];
        if (sample === undefined) continue;
        const amplitude = clampAmplitude(sample);
        minimum = Math.min(minimum, amplitude);
        maximum = Math.max(maximum, amplitude);
      }
    }
    // A bucket can be empty only with deliberately irregular input channels.
    // Preserve its deterministic time slot without inventing a signal.
    basePeaks.push(
      minimum === Number.POSITIVE_INFINITY || maximum === Number.NEGATIVE_INFINITY
        ? { min: 0, max: 0 }
        : { min: minimum, max: maximum },
    );
  }

  const levels: WaveformPeakLevel[] = [{ resolutionMs: 10, peaks: basePeaks }];
  while (levels.at(-1)?.peaks.length !== undefined && levels.at(-1)!.peaks.length > 1) {
    levels.push(reduceLevel(levels.at(-1)!));
  }
  return { baseResolutionMs: 10, levels };
};

export const createPeakPyramidFromAudioBuffer = (buffer: AudioBuffer): WaveformPeakPyramid => createPeakPyramid(
  Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)),
  buffer.sampleRate,
);

export const selectPeakLevel = (
  peakPyramid: WaveformPeakPyramid | null | undefined,
  transform: TimeTransform,
): WaveformPeakLevel | null => {
  const levels = peakPyramid?.levels ?? [];
  if (levels.length === 0 || transform.visibleDurationMs === 0) return null;
  const targetResolutionMs = Math.max(10, transform.visibleDurationMs / Math.max(1, transform.widthPx));
  let selected = levels[0];
  for (const level of levels) {
    if (level.resolutionMs > targetResolutionMs * 1.5) break;
    selected = level;
  }
  return selected ?? null;
};

export interface WaveformCanvasProps {
  readonly peakPyramid: WaveformPeakPyramid | null | undefined;
  readonly transform: TimeTransform;
  readonly height?: number;
}

/** Canvas is intentionally paint-only; all interaction lives in semantic DOM. */
export function WaveformCanvas({ peakPyramid, transform, height = TIMELINE_WAVEFORM_HEIGHT_PX }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const width = Math.max(1, Math.round(transform.widthPx));
    const devicePixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * devicePixelRatio);
    canvas.height = Math.round(height * devicePixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const level = selectPeakLevel(peakPyramid, transform);
    if (level === null) return;
    const firstBucket = Math.max(0, Math.floor(transform.visibleStartMs / level.resolutionMs));
    const lastBucket = Math.min(level.peaks.length - 1, Math.ceil(transform.visibleEndMs / level.resolutionMs));
    const middle = height / 2;
    context.strokeStyle = "#56df94";
    context.lineWidth = 1;
    context.beginPath();
    for (let index = firstBucket; index <= lastBucket; index += 1) {
      const peak = level.peaks[index];
      if (peak === undefined) continue;
      const bucketStartMs = index * level.resolutionMs;
      const x = Math.round(transform.msToX(bucketStartMs)) + 0.5;
      if (x < -1 || x > width + 1) continue;
      context.moveTo(x, middle + clampAmplitude(peak.min) * middle * 0.9);
      context.lineTo(x, middle + clampAmplitude(peak.max) * middle * 0.9);
    }
    context.stroke();
  }, [height, peakPyramid, transform]);

  return <canvas ref={canvasRef} className="waveform-canvas" data-testid="waveform-canvas" data-rendered-height={height} aria-hidden="true" />;
}
