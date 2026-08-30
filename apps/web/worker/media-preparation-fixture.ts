import type { MediaPreparation, MediaJobSigningSettings, VerifiedMediaJob } from "./probe";
import { MediaPreparationServiceBinding, verifyMediaJob } from "./probe";
import {
  MEDIA_STORAGE_BRIDGE_HOST,
  forbidden,
  handleMediaStorageBridge,
  readBoundedBody,
  readJobEnvelope,
  type MediaContainerEnv,
} from "./media-bridge";
import { sha256Hex } from "./openai/client";
import type { WorkerEnv } from "./env";

const MAX_FIXTURE_SOURCE_BYTES = 1024 * 1024;

/**
 * Local Workerd does not implement Cloudflare Containers. This switch is
 * deliberately narrower than normal fixture mode: it requires both fixture
 * provider mode and this otherwise-unset preparation flag. Production and
 * live-provider deployments therefore continue to use the strict Container
 * Durable Object path.
 */
export const fixtureMediaPreparationEnabled = (env: Pick<WorkerEnv, "CUEBENCH_OPENAI_MODE" | "CUEBENCH_MEDIA_PREPARATION_MODE" | "PROCESSING_BUCKET">): boolean => (
  env.CUEBENCH_OPENAI_MODE === "fixture"
  && env.CUEBENCH_MEDIA_PREPARATION_MODE === "fixture"
  && env.PROCESSING_BUCKET !== undefined
);

const bridgeRequest = (
  method: "GET" | "PUT",
  key: string,
  job: string,
  body?: Uint8Array,
  headers: HeadersInit = {},
): Request => new Request(`http://${MEDIA_STORAGE_BRIDGE_HOST}/${key}`, {
  method,
  headers: { "x-cuebench-media-job": job, ...headers },
  ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
});

const fixtureManifestResponse = async (
  env: WorkerEnv,
  signedJob: string,
  job: VerifiedMediaJob,
): Promise<Response> => {
  const sourceResponse = await handleMediaStorageBridge(
    bridgeRequest("GET", job.inputKey, signedJob),
    env as unknown as MediaContainerEnv,
  );
  if (!sourceResponse.ok) return sourceResponse;
  const source = await readBoundedBody(sourceResponse.body, MAX_FIXTURE_SOURCE_BYTES);
  if (source === null || source.byteLength !== job.inputByteLength) return new Response("CueBench fixture source bridge read is unavailable.", { status: 503 });
  const sourceSha256 = await sha256Hex(source);
  const audio = new TextEncoder().encode("cuebench deterministic fixture normalized audio");
  const audioSha256 = await sha256Hex(audio);
  const audioKey = `prepared/${job.operationKey}/audio/${audioSha256}.wav`;
  const publishArtifact = async (key: string, contentType: string, body: Uint8Array): Promise<Response> => {
    const digest = await sha256Hex(body);
    const response = await handleMediaStorageBridge(bridgeRequest("PUT", key, signedJob, body, {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "if-none-match": "*",
      "x-content-sha256": digest,
    }), env as unknown as MediaContainerEnv);
    return response;
  };
  const publishedAudio = await publishArtifact(audioKey, "audio/wav", audio);
  if (publishedAudio.status !== 200 && publishedAudio.status !== 201) return publishedAudio;
  // Exercise the same complete Task12 artifact shape as production
  // preparation. The fixture bytes are intentionally tiny, but every object
  // still crosses the signed bridge and therefore participates in terminal
  // exact-key cleanup and cancellation fencing.
  const waveform = new TextEncoder().encode(JSON.stringify({ bucket_ms: 10, levels: [{ buckets: [{ min: 0, max: 0 }] }] }));
  const waveformSha256 = await sha256Hex(waveform);
  const waveformKey = `prepared/${job.operationKey}/waveforms/${waveformSha256}.json`;
  const publishedWaveform = await publishArtifact(waveformKey, "application/json", waveform);
  if (publishedWaveform.status !== 200 && publishedWaveform.status !== 201) return publishedWaveform;
  const thumbnail = new TextEncoder().encode("cuebench-fixture-webp");
  const thumbnailSha256 = await sha256Hex(thumbnail);
  const thumbnailKey = `prepared/${job.operationKey}/thumbnails/${thumbnailSha256}.webp`;
  const publishedThumbnail = await publishArtifact(thumbnailKey, "image/webp", thumbnail);
  if (publishedThumbnail.status !== 200 && publishedThumbnail.status !== 201) return publishedThumbnail;
  const manifestBody = new TextEncoder().encode(JSON.stringify({
    metadata: {
      sha256: sourceSha256,
      byte_length: job.inputByteLength,
      duration_ms: 31_000,
    },
    normalized_audio: {
      key: audioKey,
      sha256: audioSha256,
      byte_length: audio.byteLength,
    },
    waveform: {
      key: waveformKey,
      sha256: waveformSha256,
      byte_length: waveform.byteLength,
    },
    thumbnails: [{
      at_ms: 0,
      key: thumbnailKey,
      sha256: thumbnailSha256,
      mime_type: "image/webp",
      width: 1,
      height: 1,
      byte_length: thumbnail.byteLength,
    }],
  }));
  const manifestSha256 = await sha256Hex(manifestBody);
  const manifestKey = `prepared/${job.operationKey}/manifests/${manifestSha256}.json`;
  const publishedManifest = await publishArtifact(manifestKey, "application/json", manifestBody);
  if (publishedManifest.status !== 200 && publishedManifest.status !== 201) return publishedManifest;
  const indexIdentity = await sha256Hex(`fixture-preparation-index:${sourceSha256}`);
  const index = new TextEncoder().encode(JSON.stringify({ key: manifestKey, sha256: manifestSha256 }));
  const indexKey = `prepared/${job.operationKey}/indexes/${indexIdentity}.json`;
  const publishedIndex = await publishArtifact(indexKey, "application/json", index);
  if (publishedIndex.status !== 200 && publishedIndex.status !== 201) return publishedIndex;
  return Response.json({ manifest: { key: manifestKey, sha256: manifestSha256 } });
};

/** Test-visible only so Workerd contracts can assert the signed boundary itself. */
export const fixtureMediaPreparationResponse = async (
  env: WorkerEnv,
  signing: MediaJobSigningSettings,
  request: Request,
): Promise<Response> => {
  if (!fixtureMediaPreparationEnabled(env) || request.method !== "POST" || new URL(request.url).pathname !== "/v1/prepare") return forbidden();
  const envelope = await readJobEnvelope(request);
  if (envelope === null) return forbidden();
  let job: VerifiedMediaJob;
  try {
    job = await verifyMediaJob(envelope.job, signing.keyRing, Date.now(), "prepare");
  } catch {
    return forbidden();
  }
  return fixtureManifestResponse(env, envelope.job, job);
};

/**
 * Explicit local-only adapter. It deliberately invokes the same signed
 * MediaPreparationServiceBinding request/response contract as the deployed
 * Container, verifies that capability again, and invokes the real scoped R2
 * bridge for every source read and artifact write.
 */
export const fixtureMediaPreparation = (
  env: WorkerEnv,
  signing: MediaJobSigningSettings | undefined,
): MediaPreparation | null => {
  if (!fixtureMediaPreparationEnabled(env) || signing === undefined) return null;
  return new MediaPreparationServiceBinding({
    fetch: (request: Request): Promise<Response> => fixtureMediaPreparationResponse(env, signing, request),
  }, signing);
};
