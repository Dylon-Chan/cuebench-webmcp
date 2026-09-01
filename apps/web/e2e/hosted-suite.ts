/**
 * Every browser-only release scenario is safe against a deployed origin. The
 * one excluded spec deliberately rewrites `/api/**` to a loopback fake Worker
 * and therefore must never be mistaken for hosted evidence.
 */
export const HOSTED_SAFE_SPECS = [
  "accessibility.spec.ts",
  "export-roundtrip.spec.ts",
  "hosted-processing-smoke.spec.ts",
  "hosted-smoke.spec.ts",
  "human-sample.spec.ts",
  "smoke.spec.ts",
  "timeline-hit-targets.spec.ts",
  "webmcp-collaboration.spec.ts",
] as const;

export const LOOPBACK_FAKE_WORKER_SPECS = ["upload-recovery.spec.ts"] as const;
