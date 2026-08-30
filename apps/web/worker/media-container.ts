import { Container } from "@cloudflare/containers";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  MEDIA_CONTAINER_OUTBOUND_POLICY,
  MEDIA_STORAGE_BRIDGE_HOST,
  MEDIA_STORAGE_HEALTH_PATH,
  forbidden,
  handleMediaStorageBridge,
  readBoundedBody,
  readJobEnvelope,
  signingFromEnvironment,
  unavailable,
  type MediaContainerEnv,
} from "./media-bridge";
import { verifyMediaJob, type MediaJobAction, type VerifiedMediaJob } from "./probe";

export {
  MEDIA_CONTAINER_OUTBOUND_POLICY,
  MEDIA_STORAGE_BRIDGE_HOST,
  handleMediaStorageBridge,
  type MediaBridgeBucket,
  type MediaBridgeObject,
  type MediaContainerEnv,
} from "./media-bridge";

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_PREPARE_RESULT_BYTES = 4 * 1024;
const OPERATION_KEY = /^[a-f0-9]{64}$/;
const stateKey = "cuebench-media-container-v1";

export interface MediaContainerCapability {
  readonly action: MediaJobAction;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly capabilityFingerprint: string;
}

export interface StoredResult extends Omit<MediaContainerCapability, "operationKey"> {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly expiresAtMs: number;
}

export interface MediaContainerState {
  readonly operationKey: string;
  readonly inFlight?: Omit<MediaContainerCapability, "operationKey"> & { readonly expiresAtMs: number };
  readonly results: Record<string, StoredResult>;
}

/** A one-way, constant-size state record instead of retaining a bearer capability in DO storage. */
export const mediaCapabilityFingerprint = async (token: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
};

/**
 * The R2 bridge requires the exact capability currently delegated to the
 * Container. A Container with a valid HMAC must not upgrade `probe` into
 * `prepare` merely because both share an operation key.
 */
export const isMediaCapabilityAuthorized = (
  state: MediaContainerState | undefined,
  capability: MediaContainerCapability,
  nowMs: number,
): boolean => {
  if (state === undefined || state.operationKey !== capability.operationKey) return false;
  const matches = (candidate: Omit<MediaContainerCapability, "operationKey"> & { readonly expiresAtMs: number }): boolean => (
    candidate.expiresAtMs > nowMs
    && candidate.action === capability.action
    && candidate.idempotencyKey === capability.idempotencyKey
    && candidate.capabilityFingerprint === capability.capabilityFingerprint
  );
  return (state.inFlight !== undefined && matches(state.inFlight))
    || Object.values(state.results).some(matches);
};

const cachedResponse = (result: StoredResult): Response => new Response(result.body, {
  status: result.status,
  headers: { "content-type": result.contentType },
});

/**
 * One Durable Object per server-derived operation key serializes work, retains
 * in-flight state across Container restarts, and only delegates after the
 * same action-bound capability is verified again.
 */
export class MediaPreparationContainer extends Container<MediaContainerEnv> {
  public static readonly outboundPolicy = MEDIA_CONTAINER_OUTBOUND_POLICY;
  public defaultPort = 8080;
  public sleepAfter = "2m";
  public enableInternet = false;
  public allowedHosts = [MEDIA_STORAGE_BRIDGE_HOST];
  public pingEndpoint = "/healthz";
  private readonly durableState: DurableObjectState;
  private readonly mediaEnv: MediaContainerEnv;

  public constructor(state: DurableObjectState, env: MediaContainerEnv) {
    super(state, env);
    this.durableState = state;
    this.mediaEnv = env;
    const signing = signingFromEnvironment(env);
    // HMAC material intentionally enters only the private Container runtime;
    // the R2 binding itself remains in the Worker runtime.
    this.envVars = {
      CUEBENCH_MEDIA_STORAGE_BRIDGE_URL: `http://${MEDIA_STORAGE_BRIDGE_HOST}`,
      ...(signing === null ? {} : {
        CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY_ID: signing.keyRing.current.id,
        CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY: signing.keyRing.current.secret,
        ...(signing.keyRing.previous === undefined ? {} : {
          CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY_ID: signing.keyRing.previous.id,
          CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY: signing.keyRing.previous.secret,
        }),
      }),
    };
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_cuebench/bridge-authorize") return this.authorizeBridge(request);
    if (request.method !== "POST" || (url.pathname !== "/v1/probe" && url.pathname !== "/v1/prepare")) return new Response("Not found.", { status: 404 });
    const envelope = await readJobEnvelope(request.clone());
    const signing = signingFromEnvironment(this.mediaEnv);
    if (envelope === null || signing === null) return forbidden();
    const expectedAction: MediaJobAction = url.pathname === "/v1/probe" ? "probe" : "prepare";
    let job: VerifiedMediaJob;
    try {
      job = await verifyMediaJob(envelope.job, signing.keyRing, Date.now(), expectedAction);
    } catch {
      return forbidden();
    }
    const capabilityFingerprint = await mediaCapabilityFingerprint(envelope.job);
    const prior = await this.durableState.storage.get<MediaContainerState>(stateKey);
    if (prior !== undefined && prior.operationKey !== job.operationKey) return forbidden();
    const resultKey = `${job.action}:${job.idempotencyKey}`;
    const cached = prior?.results[resultKey];
    if (cached !== undefined && cached.expiresAtMs > Date.now()) return cachedResponse(cached);
    if (prior?.inFlight !== undefined && prior.inFlight.expiresAtMs > Date.now()) {
      return prior.inFlight.action === job.action
        && prior.inFlight.idempotencyKey === job.idempotencyKey
        && prior.inFlight.capabilityFingerprint === capabilityFingerprint
        ? new Response("CueBench is already preparing this media evidence.", { status: 409 })
        : forbidden();
    }
    const state: MediaContainerState = {
      operationKey: job.operationKey,
      inFlight: {
        action: job.action,
        idempotencyKey: job.idempotencyKey,
        capabilityFingerprint,
        expiresAtMs: job.expiresAtMs,
      },
      results: prior?.results ?? {},
    };
    await this.durableState.storage.put(stateKey, state);
    try {
      const headers = new Headers(request.headers);
      if (expectedAction === "prepare") headers.set("x-cuebench-media-result", "manifest-ref");
      const response = await this.containerFetch(new Request(request, { headers }));
      const bytes = await readBoundedBody(response.body, expectedAction === "prepare" ? MAX_PREPARE_RESULT_BYTES : MAX_RESULT_BYTES);
      if (bytes === null) throw new Error("media response exceeded its bounded result envelope");
      const result: StoredResult = {
        action: job.action,
        idempotencyKey: job.idempotencyKey,
        capabilityFingerprint,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: new TextDecoder().decode(bytes),
        expiresAtMs: job.expiresAtMs,
      };
      await this.durableState.storage.put(stateKey, { operationKey: job.operationKey, results: { ...(prior?.results ?? {}), [resultKey]: result } } satisfies MediaContainerState);
      return cachedResponse(result);
    } catch {
      await this.durableState.storage.put(stateKey, { operationKey: job.operationKey, results: prior?.results ?? {} } satisfies MediaContainerState);
      return unavailable();
    }
  }

  private async authorizeBridge(request: Request): Promise<Response> {
    const body = await readJobEnvelope(request);
    if (body === null) return forbidden();
    const signing = signingFromEnvironment(this.mediaEnv);
    if (signing === null) return forbidden();
    try {
      const job = await verifyMediaJob(body.job, signing.keyRing, Date.now());
      const current = await this.durableState.storage.get<MediaContainerState>(stateKey);
      const capabilityFingerprint = await mediaCapabilityFingerprint(body.job);
      return isMediaCapabilityAuthorized(current, {
        action: job.action,
        operationKey: job.operationKey,
        idempotencyKey: job.idempotencyKey,
        capabilityFingerprint,
      }, Date.now()) ? new Response(null, { status: 204 }) : forbidden();
    } catch {
      return forbidden();
    }
  }
}

/**
 * Container egress is intercepted inside the Worker: the Container receives
 * no R2 credentials and can only reach this single virtual host. The object
 * itself rechecks its operation fence before the scoped R2 handler runs.
 */
MediaPreparationContainer.outboundByHost = {
  [MEDIA_STORAGE_BRIDGE_HOST]: async (request, env, context) => {
    const mediaEnv = env as MediaContainerEnv;
    if (new URL(request.url).pathname === MEDIA_STORAGE_HEALTH_PATH) return handleMediaStorageBridge(request, mediaEnv);
    const token = request.headers.get("x-cuebench-media-job");
    const signing = signingFromEnvironment(mediaEnv);
    if (token === null || signing === null || mediaEnv.MEDIA_PREPARER === undefined) return forbidden();
    try {
      const job = await verifyMediaJob(token, signing.keyRing, Date.now());
      const stub = mediaEnv.MEDIA_PREPARER.get(mediaEnv.MEDIA_PREPARER.idFromString(context.containerId));
      const authorization = await stub.fetch(new Request("http://cuebench-container.internal/_cuebench/bridge-authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: token }),
      }) as unknown as Parameters<typeof stub.fetch>[0]);
      if (!authorization.ok || !OPERATION_KEY.test(job.operationKey)) return forbidden();
    } catch {
      return forbidden();
    }
    return handleMediaStorageBridge(request, mediaEnv);
  },
};
