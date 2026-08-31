/**
 * A Worker-only operation fence. It is intentionally not an R2 prefix delete:
 * media preparation checks this exact marker before publishing any additional
 * derivative after a terminal generation action. Lifecycle reaps the tiny
 * marker with the rest of the prepared operation prefix within 24 hours.
 */
export const generationCleanupMarkerKey = (operationKey: string): string =>
  `prepared/${operationKey}/generation-cleanup.json`;

/**
 * A bridge write registers this exact key before its first terminal-marker
 * check. Cleanup can therefore keep its tombstone pending while a request
 * that began just before cancellation is still capable of reaching R2.
 */
export const generationPreparationWriteLeaseKey = (operationKey: string, outputKey: string): string => {
  const match = outputKey.match(new RegExp(`^prepared/${operationKey}/(audio|waveforms|thumbnails|manifests|indexes)/([a-f0-9]{64})\\.(wav|json|webp)$`));
  if (
    match === null
    || match[1] === undefined
    || match[2] === undefined
    || match[3] === undefined
    || (match[1] === "audio" && match[3] !== "wav")
    || (match[1] === "thumbnails" && match[3] !== "webp")
    || (match[1] !== "audio" && match[1] !== "thumbnails" && match[3] !== "json")
  ) {
    throw new Error("CueBench cannot create a preparation-write lease for an invalid private output key.");
  }
  return `prepared/${operationKey}/generation-inflight/${match[1]}-${match[2]}.json`;
};

/**
 * Workflow checkpoints are immutable R2 objects too. They use their own
 * scoped writer lease so terminal cleanup can drain a provider/Workflow write
 * that started immediately before its operation fence was published.
 */
export const generationArtifactWriteLeaseKey = (
  operationKey: string,
  runId: string,
  artifactKey: string,
): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error("CueBench cannot create a generation-artifact lease for an invalid run id.");
  }
  const match = artifactKey.match(new RegExp(`^prepared/${operationKey}/generation-runs/${runId}/artifacts/(workflow-state|staged-result|provider-result)-([a-f0-9]{64})\\.json$`));
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("CueBench cannot create a generation-artifact lease for an invalid private checkpoint key.");
  }
  return `prepared/${operationKey}/generation-inflight/artifact/${runId}/${match[1]}-${match[2]}.json`;
};
