import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { HmacKeyRing } from "./session";
import type { MediaJobSigningSettings } from "./probe";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_DURATION_MS = 15 * 60 * 1_000;
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export type ProcessingWorkflowInstanceStatus = "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown";

/** The Cloudflare Workflows binding surface used for deterministic reconciliation. */
export interface ProcessingWorkflowBinding {
  create: (options: { readonly id: string; readonly params: unknown }) => Promise<unknown>;
  /** `Workflow.get(id)` returns an instance whose status must then be queried. */
  get?: (id: string) => Promise<{
    readonly status: () => Promise<{ readonly status: ProcessingWorkflowInstanceStatus }>;
    /** Events are Worker-internal control messages, never browser callable. */
    readonly sendEvent?: (input: { readonly type: string; readonly payload: unknown }) => Promise<void>;
  }>;
}

export interface WorkerEnv {
  readonly SESSION_HMAC_CURRENT_KEY_ID: string;
  readonly SESSION_HMAC_CURRENT_KEY: string;
  readonly SESSION_HMAC_PREVIOUS_KEY_ID?: string;
  readonly SESSION_HMAC_PREVIOUS_KEY?: string;
  /** Dedicated internal capability key; never exposed to browser code or Wrangler vars. */
  readonly MEDIA_JOB_HMAC_CURRENT_KEY_ID?: string;
  readonly MEDIA_JOB_HMAC_CURRENT_KEY?: string;
  readonly MEDIA_JOB_HMAC_PREVIOUS_KEY_ID?: string;
  readonly MEDIA_JOB_HMAC_PREVIOUS_KEY?: string;
  readonly MEDIA_JOB_TTL_SECONDS?: string;
  readonly QUOTA_SALT: string;
  readonly SESSION_TTL_SECONDS?: string;
  readonly UPLOAD_CAPABILITY_TTL_SECONDS?: string;
  readonly RECOVERY_TTL_SECONDS?: string;
  readonly MAX_SESSION_MEDIA_MINUTES?: string;
  readonly MAX_IP_MEDIA_MINUTES?: string;
  readonly MAX_SESSION_GENERATIONS?: string;
  readonly MAX_SESSION_TTS?: string;
  readonly MAX_IP_GENERATIONS?: string;
  readonly MAX_IP_TTS?: string;
  readonly MAX_PENDING_SESSION_BYTES?: string;
  readonly MAX_PENDING_IP_BYTES?: string;
  readonly MAX_PENDING_SESSION_OPERATIONS?: string;
  readonly MAX_PENDING_IP_OPERATIONS?: string;
  readonly GLOBAL_SPEND_LIMIT_CENTS?: string;
  readonly GLOBAL_SPEND_BREAKER_OPEN?: string;
  /** Fixture is the safe default; live requires this explicit server-only opt-in. */
  readonly CUEBENCH_OPENAI_MODE?: "fixture" | "live" | string;
  /** Explicit test-only media-preparation fixture; production leaves it unset. */
  readonly CUEBENCH_MEDIA_PREPARATION_MODE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  /** Defaults in the provider adapter, but can be pinned explicitly per deployment. */
  readonly CUEBENCH_RECONCILIATION_MODEL?: string;
  readonly GENERATION_RUN_TTL_SECONDS?: string;
  /** Conservative per-operation reservations before external providers run. */
  readonly MAX_WORKFLOW_PROVIDER_COST_CENTS?: string;
  readonly MAX_MEDIA_PROBE_COST_CENTS?: string;
  readonly TURNSTILE_SECRET: string;
  readonly TURNSTILE_VERIFY_URL?: string;
  readonly TURNSTILE_EXPECTED_HOSTNAME?: string;
  readonly TURNSTILE_EXPECTED_ACTION?: string;
  readonly PROCESSING_BUCKET?: R2Bucket;
  readonly QUOTA_LEDGER?: DurableObjectNamespace;
  readonly UPLOAD_COORDINATOR?: DurableObjectNamespace;
  readonly PROCESSING_WORKFLOW?: ProcessingWorkflowBinding;
  /** Operation-keyed Cloudflare Container Durable Object, never browser reachable. */
  readonly MEDIA_PREPARER?: DurableObjectNamespace;
  readonly ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

export interface AnonymousQuotaLimits {
  readonly sessionMediaMinutes: number;
  readonly ipMediaMinutes: number;
  readonly sessionGenerations: number;
  readonly sessionTts: number;
  readonly ipGenerations: number;
  readonly ipTts: number;
  readonly globalSpendLimitCents: number;
  readonly pendingSessionBytes: number;
  readonly pendingIpBytes: number;
  readonly pendingSessionOperations: number;
  readonly pendingIpOperations: number;
}

export interface WorkerSettings {
  readonly keyRing: HmacKeyRing;
  /** Omitted only when the private media binding is intentionally unavailable. */
  readonly mediaJobSigning?: MediaJobSigningSettings;
  readonly quotaSalt: string;
  readonly sessionTtlMs: number;
  readonly uploadCapabilityTtlMs: number;
  readonly recoveryTtlMs: number;
  readonly partSizeBytes: number;
  readonly partLeaseMs: number;
  readonly maxUploadBytes: number;
  readonly maxUploadDurationMs: number;
  readonly quotas: AnonymousQuotaLimits;
  readonly globalSpendBreakerOpen: boolean;
  readonly maxWorkflowProviderCostCents: number;
  readonly maxMediaProbeCostCents: number;
  readonly turnstileSecret: string;
  readonly turnstileVerifyUrl: string;
  /** An explicit production host override; otherwise the Worker verifies its own request host. */
  readonly turnstileExpectedHostname?: string;
  readonly turnstileExpectedAction: string;
}

export class WorkerConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerConfigurationError";
  }
}

const nonEmpty = (value: string | undefined, name: string): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new WorkerConfigurationError(`${name} is not configured.`);
  }
  return value;
};

/** Keeps the configured bytes exactly as supplied while rejecting toy secrets. */
const strongSecret = (value: string | undefined, name: string): string => {
  const secret = nonEmpty(value, name);
  const bytes = new TextEncoder().encode(secret);
  // The exact bytes are passed through unchanged to Web Crypto. This check is
  // deliberately on decoded UTF-8 bytes rather than trimmed string length.
  if (bytes.byteLength < 32) {
    throw new WorkerConfigurationError(`${name} must contain at least 32 bytes.`);
  }
  if (new Set(bytes).size < 8) {
    throw new WorkerConfigurationError(`${name} must contain sufficient secret-byte diversity.`);
  }
  return secret;
};

const boundedInt = (value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number => {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

const truthy = (value: string | undefined): boolean => value === "true";

const optionalMediaJobSigning = (env: WorkerEnv): MediaJobSigningSettings | undefined => {
  const currentId = env.MEDIA_JOB_HMAC_CURRENT_KEY_ID?.trim() || undefined;
  const currentSecret = env.MEDIA_JOB_HMAC_CURRENT_KEY === undefined || env.MEDIA_JOB_HMAC_CURRENT_KEY.trim().length === 0
    ? undefined
    : strongSecret(env.MEDIA_JOB_HMAC_CURRENT_KEY, "MEDIA_JOB_HMAC_CURRENT_KEY");
  const previousId = env.MEDIA_JOB_HMAC_PREVIOUS_KEY_ID?.trim() || undefined;
  const previousSecret = env.MEDIA_JOB_HMAC_PREVIOUS_KEY === undefined || env.MEDIA_JOB_HMAC_PREVIOUS_KEY.trim().length === 0
    ? undefined
    : strongSecret(env.MEDIA_JOB_HMAC_PREVIOUS_KEY, "MEDIA_JOB_HMAC_PREVIOUS_KEY");
  if (currentId === undefined && currentSecret === undefined && previousId === undefined && previousSecret === undefined) return undefined;
  if (currentId === undefined || currentSecret === undefined) {
    throw new WorkerConfigurationError("MEDIA_JOB_HMAC_CURRENT_KEY_ID and MEDIA_JOB_HMAC_CURRENT_KEY must be configured together.");
  }
  if ((previousId === undefined) !== (previousSecret === undefined)) {
    throw new WorkerConfigurationError("The previous media-job HMAC key id and secret must be configured together.");
  }
  if (previousId === currentId) throw new WorkerConfigurationError("Media-job HMAC key ids must be distinct during rotation.");
  return {
    keyRing: {
      current: { id: currentId, secret: currentSecret },
      ...(previousId === undefined || previousSecret === undefined ? {} : { previous: { id: previousId, secret: previousSecret } }),
    },
    ttlMs: boundedInt(env.MEDIA_JOB_TTL_SECONDS, 10 * 60, "MEDIA_JOB_TTL_SECONDS", 60, 15 * 60) * 1_000,
  };
};

/** Parses no secret values into responses; invalid configuration fails closed at the API boundary. */
export const resolveWorkerSettings = (env: WorkerEnv): WorkerSettings => {
  // Identifiers are normalized; cryptographic material below is deliberately
  // not trimmed or otherwise rewritten before Web Crypto imports its bytes.
  const currentId = nonEmpty(env.SESSION_HMAC_CURRENT_KEY_ID, "SESSION_HMAC_CURRENT_KEY_ID").trim();
  const currentSecret = strongSecret(env.SESSION_HMAC_CURRENT_KEY, "SESSION_HMAC_CURRENT_KEY");
  const previousId = env.SESSION_HMAC_PREVIOUS_KEY_ID?.trim() || undefined;
  const previousSecret = env.SESSION_HMAC_PREVIOUS_KEY === undefined || env.SESSION_HMAC_PREVIOUS_KEY.trim().length === 0
    ? undefined
    : strongSecret(env.SESSION_HMAC_PREVIOUS_KEY, "SESSION_HMAC_PREVIOUS_KEY");
  if ((previousId === undefined) !== (previousSecret === undefined)) {
    throw new WorkerConfigurationError("The previous HMAC key id and secret must be configured together.");
  }
  if (previousId === currentId) throw new WorkerConfigurationError("HMAC key ids must be distinct during rotation.");
  const sessionTtlSeconds = boundedInt(env.SESSION_TTL_SECONDS, 24 * 60 * 60, "SESSION_TTL_SECONDS", 60, 24 * 60 * 60);
  const capabilityTtlSeconds = boundedInt(env.UPLOAD_CAPABILITY_TTL_SECONDS, 10 * 60, "UPLOAD_CAPABILITY_TTL_SECONDS", 60, 60 * 60);
  const recoveryTtlSeconds = boundedInt(env.RECOVERY_TTL_SECONDS, 24 * 60 * 60, "RECOVERY_TTL_SECONDS", 60, 24 * 60 * 60);
  const mediaJobSigning = optionalMediaJobSigning(env);
  return {
    keyRing: {
      current: { id: currentId, secret: currentSecret },
      ...(previousId === undefined || previousSecret === undefined ? {} : { previous: { id: previousId, secret: previousSecret } }),
    },
    ...(mediaJobSigning === undefined ? {} : { mediaJobSigning }),
    quotaSalt: strongSecret(env.QUOTA_SALT, "QUOTA_SALT"),
    sessionTtlMs: sessionTtlSeconds * 1_000,
    uploadCapabilityTtlMs: capabilityTtlSeconds * 1_000,
    recoveryTtlMs: recoveryTtlSeconds * 1_000,
    partSizeBytes: UPLOAD_PART_BYTES,
    partLeaseMs: Math.min(capabilityTtlSeconds * 1_000, 5 * 60 * 1_000),
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxUploadDurationMs: MAX_UPLOAD_DURATION_MS,
    quotas: {
      sessionMediaMinutes: boundedInt(env.MAX_SESSION_MEDIA_MINUTES, 30, "MAX_SESSION_MEDIA_MINUTES", 1, 10_000),
      ipMediaMinutes: boundedInt(env.MAX_IP_MEDIA_MINUTES, 90, "MAX_IP_MEDIA_MINUTES", 1, 100_000),
      sessionGenerations: boundedInt(env.MAX_SESSION_GENERATIONS, 6, "MAX_SESSION_GENERATIONS", 1, 10_000),
      sessionTts: boundedInt(env.MAX_SESSION_TTS, 50, "MAX_SESSION_TTS", 1, 100_000),
      ipGenerations: boundedInt(env.MAX_IP_GENERATIONS, 18, "MAX_IP_GENERATIONS", 1, 100_000),
      ipTts: boundedInt(env.MAX_IP_TTS, 150, "MAX_IP_TTS", 1, 100_000),
      globalSpendLimitCents: boundedInt(env.GLOBAL_SPEND_LIMIT_CENTS, 10_000, "GLOBAL_SPEND_LIMIT_CENTS", 1, 1_000_000_000),
      pendingSessionBytes: boundedInt(env.MAX_PENDING_SESSION_BYTES, MAX_UPLOAD_BYTES, "MAX_PENDING_SESSION_BYTES", 1, MAX_UPLOAD_BYTES * 10),
      pendingIpBytes: boundedInt(env.MAX_PENDING_IP_BYTES, MAX_UPLOAD_BYTES * 2, "MAX_PENDING_IP_BYTES", 1, MAX_UPLOAD_BYTES * 100),
      pendingSessionOperations: boundedInt(env.MAX_PENDING_SESSION_OPERATIONS, 2, "MAX_PENDING_SESSION_OPERATIONS", 1, 100),
      pendingIpOperations: boundedInt(env.MAX_PENDING_IP_OPERATIONS, 8, "MAX_PENDING_IP_OPERATIONS", 1, 1_000),
    },
    globalSpendBreakerOpen: truthy(env.GLOBAL_SPEND_BREAKER_OPEN),
    // A non-zero upper bound is reserved before every external processing
    // provider call. The workflow may settle authoritative usage later.
    maxWorkflowProviderCostCents: boundedInt(env.MAX_WORKFLOW_PROVIDER_COST_CENTS, 100, "MAX_WORKFLOW_PROVIDER_COST_CENTS", 1, 1_000_000_000),
    maxMediaProbeCostCents: boundedInt(env.MAX_MEDIA_PROBE_COST_CENTS, 1, "MAX_MEDIA_PROBE_COST_CENTS", 1, 1_000_000_000),
    turnstileSecret: strongSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"),
    turnstileVerifyUrl: env.TURNSTILE_VERIFY_URL?.trim() || "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    ...(env.TURNSTILE_EXPECTED_HOSTNAME?.trim()
      ? { turnstileExpectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME.trim() }
      : {}),
    turnstileExpectedAction: nonEmpty(env.TURNSTILE_EXPECTED_ACTION, "TURNSTILE_EXPECTED_ACTION"),
  };
};
