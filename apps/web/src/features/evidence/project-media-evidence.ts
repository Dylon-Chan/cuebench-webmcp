import type { CaptionProject } from "@cuebench/domain";
import { useEffect, useMemo, useState } from "react";
import type { SourceProvenance } from "../project/source-provenance";
import type { WaveformPeak, WaveformPeakLevel, WaveformPeakPyramid } from "../timeline/WaveformCanvas";

export type AudioEvidenceState = "no-audio" | "pending" | "ready" | "failed";

export interface PreparedMediaEvidence {
  readonly audioState: AudioEvidenceState;
  readonly peakPyramid: WaveformPeakPyramid | null;
  readonly failureMessage?: string;
}

export const BUNDLED_SAMPLE_MEDIA_SHA256 = "5ee0de5b26fa550da40bf4806b7c2e38dd9ec7457eeda770273e2500c6d1204a";
const artifactEncoding = "int16le-min-max-pairs-base64";
const artifactSchemaVersion = 1;

interface CompactWaveformArtifact {
  readonly schemaVersion: number;
  readonly mediaSha256: string;
  readonly durationMs: number;
  readonly baseResolutionMs: number;
  readonly baseBucketCount: number;
  readonly levelCounts: readonly number[];
  readonly levelResolutionsMs: readonly number[];
  readonly encoding: string;
  readonly peaksBase64: string;
}

type ProjectMediaIdentity = {
  readonly media: Pick<CaptionProject["media"], "sha256" | "durationMs">;
};

type ArtifactModule = { readonly default: unknown };
export type WaveformArtifactLoader = () => Promise<ArtifactModule>;

const defaultArtifactLoader: WaveformArtifactLoader = () => import("./bundled-sample-waveform.json");

const failed = (failureMessage: string): PreparedMediaEvidence => ({
  audioState: "failed",
  peakPyramid: null,
  failureMessage,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const decodeBasePeaks = (encoded: string, expectedCount: number): readonly WaveformPeak[] | null => {
  try {
    const binary = globalThis.atob(encoded);
    if (binary.length !== expectedCount * 4) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const peaks: WaveformPeak[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const minimum = view.getInt16(offset, true) / 32_767;
      const maximum = view.getInt16(offset + 2, true) / 32_767;
      if (minimum < -1 || maximum > 1 || minimum > maximum) return null;
      peaks.push({ min: minimum, max: maximum });
    }
    return peaks;
  } catch {
    return null;
  }
};

const expectedLevelCounts = (baseCount: number): readonly number[] => {
  const counts = [baseCount];
  while (counts.at(-1)! > 1) counts.push(Math.ceil(counts.at(-1)! / 2));
  return counts;
};

const reducePeaks = (peaks: readonly WaveformPeak[]): readonly WaveformPeak[] => {
  const reduced: WaveformPeak[] = [];
  for (let index = 0; index < peaks.length; index += 2) {
    const first = peaks[index];
    if (first === undefined) continue;
    const second = peaks[index + 1] ?? first;
    reduced.push({ min: Math.min(first.min, second.min), max: Math.max(first.max, second.max) });
  }
  return reduced;
};

const parseArtifact = (
  value: unknown,
  project: ProjectMediaIdentity,
): PreparedMediaEvidence => {
  if (!isRecord(value)) return failed("Bundled waveform artifact schema is invalid.");
  const artifact = value as unknown as CompactWaveformArtifact;
  if (artifact.schemaVersion !== artifactSchemaVersion || artifact.encoding !== artifactEncoding) {
    return failed("Bundled waveform artifact schema or encoding is unsupported.");
  }
  if (artifact.mediaSha256 !== BUNDLED_SAMPLE_MEDIA_SHA256 || artifact.mediaSha256 !== project.media.sha256) {
    return failed("Bundled waveform artifact hash does not match the loaded media.");
  }
  if (artifact.durationMs !== project.media.durationMs || artifact.baseResolutionMs !== 10) {
    return failed("Bundled waveform artifact duration or resolution does not match the loaded media.");
  }
  if (!Number.isInteger(artifact.baseBucketCount) || artifact.baseBucketCount <= 0) {
    return failed("Bundled waveform artifact bucket count is invalid.");
  }
  const counts = expectedLevelCounts(artifact.baseBucketCount);
  const resolutions = counts.map((_, index) => 10 * (2 ** index));
  if (!Array.isArray(artifact.levelCounts)
    || artifact.levelCounts.length !== counts.length
    || artifact.levelCounts.some((count, index) => count !== counts[index])
    || !Array.isArray(artifact.levelResolutionsMs)
    || artifact.levelResolutionsMs.length !== resolutions.length
    || artifact.levelResolutionsMs.some((resolution, index) => resolution !== resolutions[index])) {
    return failed("Bundled waveform artifact level counts are invalid.");
  }
  const basePeaks = decodeBasePeaks(artifact.peaksBase64, artifact.baseBucketCount);
  if (basePeaks === null) return failed("Bundled waveform artifact peak encoding is invalid.");
  const levels: WaveformPeakLevel[] = [];
  let peaks = basePeaks;
  for (let index = 0; index < counts.length; index += 1) {
    levels.push({ resolutionMs: resolutions[index]!, peaks });
    peaks = reducePeaks(peaks);
  }
  return { audioState: "ready", peakPyramid: { baseResolutionMs: 10, levels } };
};

/**
 * Loads the checked-in waveform only after both persisted source provenance
 * and the canonical project media hash identify the exact trusted fixture.
 * Uploaded and replaced media never request the waveform chunk.
 */
export const loadProjectMediaEvidence = async (
  project: ProjectMediaIdentity,
  sourceProvenance: SourceProvenance,
  artifactLoader: WaveformArtifactLoader = defaultArtifactLoader,
): Promise<PreparedMediaEvidence> => {
  if (sourceProvenance.audioPresence === "absent") return { audioState: "no-audio", peakPyramid: null };
  if (sourceProvenance.sourceKind !== "bundled-fixture") return { audioState: "pending", peakPyramid: null };
  if (project.media.sha256 !== BUNDLED_SAMPLE_MEDIA_SHA256) {
    return failed("Bundled source provenance no longer matches the loaded media hash.");
  }
  try {
    const module = await artifactLoader();
    return parseArtifact(module.default, project);
  } catch {
    return failed("Bundled waveform artifact could not be loaded.");
  }
};

export const useProjectMediaEvidence = (
  project: ProjectMediaIdentity,
  sourceProvenance: SourceProvenance,
): PreparedMediaEvidence => {
  const pending = useMemo<PreparedMediaEvidence>(() => sourceProvenance.audioPresence === "absent"
    ? { audioState: "no-audio", peakPyramid: null }
    : { audioState: "pending", peakPyramid: null }, [sourceProvenance.audioPresence]);
  const [evidence, setEvidence] = useState<PreparedMediaEvidence>(pending);

  useEffect(() => {
    let current = true;
    setEvidence(pending);
    void loadProjectMediaEvidence(project, sourceProvenance).then((next) => {
      if (current) setEvidence(next);
    });
    return () => { current = false; };
  }, [pending, project.media.durationMs, project.media.sha256, sourceProvenance.audioPresence, sourceProvenance.sourceKind]);

  return evidence;
};
