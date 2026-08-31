const bundledSampleUrl = "/sample/gibbs-free-energy.mp4";

/** The original, repository-authored Gibbs lesson emitted as a public Vite asset. */
export const BUNDLED_SAMPLE_DURATION_MS = 90_000;
export const BUNDLED_SAMPLE_FILE_NAME = "gibbs-free-energy.mp4";

/**
 * Fetches the same-origin emitted fixture into a fresh Blob so it follows the
 * exact inspect, hash, and durable-or-temporary lifecycle used for uploads.
 */
export const createBundledSampleFile = async (): Promise<File> => {
  const response = await fetch(bundledSampleUrl);
  if (!response.ok) throw new Error("CueBench could not load the bundled Gibbs lesson.");
  const blob = await response.blob();
  return new File([blob], BUNDLED_SAMPLE_FILE_NAME, {
    type: blob.type || "video/mp4",
    lastModified: 0,
  });
};
