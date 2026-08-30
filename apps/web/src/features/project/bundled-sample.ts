import bundledSampleUrl from "./bundled-sample.mp4?url";

/** A one-second H.264 MP4 fixture generated locally and emitted as a Vite asset. */
export const BUNDLED_SAMPLE_DURATION_MS = 1_000;
export const BUNDLED_SAMPLE_FILE_NAME = "cuebench-bundled-fixture.mp4";

/**
 * Fetches the same-origin emitted fixture into a fresh Blob so it follows the
 * exact inspect, hash, and durable-or-temporary lifecycle used for uploads.
 */
export const createBundledSampleFile = async (): Promise<File> => {
  const response = await fetch(bundledSampleUrl);
  if (!response.ok) throw new Error("CueBench could not load the bundled media fixture.");
  const blob = await response.blob();
  return new File([blob], BUNDLED_SAMPLE_FILE_NAME, {
    type: blob.type || "video/mp4",
    lastModified: 0,
  });
};
