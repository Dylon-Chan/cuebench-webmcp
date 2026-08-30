import type { CaptionProject } from "@cuebench/domain";
import type { WaveformPeakPyramid } from "../timeline/WaveformCanvas";

/**
 * A narrow projection of prepared media evidence for the workbench. It never
 * reads source bytes: prepared workers and later evidence tasks are the only
 * owners of decoding and peak construction.
 */
export type AudioEvidenceState = "no-audio" | "pending" | "ready" | "failed";

export interface PreparedMediaEvidence {
  readonly audioState: AudioEvidenceState;
  readonly peakPyramid: WaveformPeakPyramid | null;
  readonly failureMessage?: string;
}

const bundledFixtureTitle = "CueBench bundled media fixture";

/**
 * Task 8 knows the bundled visual fixture has no audio track. Other local
 * sources deliberately remain pending until bounded prepared-media evidence
 * is available; no main-thread fetch, decode, or PCM scan is attempted here.
 */
export const projectMediaEvidence = (project: CaptionProject): PreparedMediaEvidence => (
  project.title === bundledFixtureTitle
    ? { audioState: "no-audio", peakPyramid: null }
    : { audioState: "pending", peakPyramid: null }
);
