import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { HmacKeyRing } from "./session";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_DURATION_MS = 15 * 60 * 1_000;
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface ProcessingWorkflowBinding {
  create: (options: { readonly id: string; readonly params: unknown }) => Promise<unknown>;
}

export interface WorkerEnv {
  readonly SESSION_HMAC_CURRENT_KEY_ID: string;
  readonly SESSION_HMAC_CURRENT_KEY: string;
  readonly SESSION_HMAC_PREVIOUS_KEY_ID?: string;
  readonly SESSION_HMAC_PREVIOUS_KEY?: string;
  readonly QUOTA_SALT: string;
  readonly SESSION_TTL_SECONDS?: string;
  readonly UPLOAD_CAPABILITY_TTL_SECONDS?: string;
  readonly RECOVERY_TTL_SECONDS?: string;
  readonly MAX_SESSION_MEDIA_MINUTES?: string;
  readonly MAX_IP_MEDIA_MINUTES?: string;
  readonly MAX_SESSION_GENERATIONS?: string;
  readonly MAX_SESSION_TTS?: string;
  readonly GLOBAL_SPEND_LIMIT_CENTS?: string;
  readonly GLOBAL_SPEND_BREAKER_OPEN?: string;
  readonly TURNSTILE_SECRET: string;
  readonly TURNSTILE_VERIFY_URL?: string;
  readonly PROCESSING_BUCKET?: R2Bucket;
  readonly QUOTA_LEDGER?: DurableObjectNamespace;
  readonly PROCESSING_WORKFLOW?: ProcessingWorkflowBinding;
  readonly ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

export interface AnonymousQuotaLimits {
  readonly sessionMediaMinutes: number;
  readonly ipMediaMinutes: number;
  readonly sessionGenerations: number;
  readonly sessionTts: number;
  readonly globalSpendLimitCents: number;
}

export interface WorkerSettings {
  readonly keyRing: HmacKeyRing;
  readonly quotaSalt: string;
  readonly sessionTtlMs: number;
  readonly uploadCapabilityTtlMs: number;
  readonly recoveryTtlMs: number;
  readonly maxUploadBytes: number;
  readonly maxUploadDurationMs: number;
  readonly quotas: AnonymousQuotaLimits;
  readonly globalSpendBreakerOpen: boolean;
  readonly turnstileSecret: string;
  readonly turnstileVerifyUrl: string;
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

const boundedInt = (value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number => {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
};

const truthy = (value: string | undefined): boolean => value === "true";

/** Parses no secret values into responses; invalid configuration fails closed at the API boundary. */
export const resolveWorkerSettings = (env: WorkerEnv): WorkerSettings => {
  const currentId = nonEmpty(env.SESSION_HMAC_CURRENT_KEY_ID, "SESSION_HMAC_CURRENT_KEY_ID");
  const currentSecret = nonEmpty(env.SESSION_HMAC_CURRENT_KEY, "SESSION_HMAC_CURRENT_KEY");
  const previousId = env.SESSION_HMAC_PREVIOUS_KEY_ID?.trim();
  const previousSecret = env.SESSION_HMAC_PREVIOUS_KEY?.trim();
  if ((previousId === undefined) !== (previousSecret === undefined)) {
    throw new WorkerConfigurationError("The previous HMAC key id and secret must be configured together.");
  }
  if (previousId === currentId) throw new WorkerConfigurationError("HMAC key ids must be distinct during rotation.");
  const sessionTtlSeconds = boundedInt(env.SESSION_TTL_SECONDS, 24 * 60 * 60, "SESSION_TTL_SECONDS", 60, 24 * 60 * 60);
  const capabilityTtlSeconds = boundedInt(env.UPLOAD_CAPABILITY_TTL_SECONDS, 10 * 60, "UPLOAD_CAPABILITY_TTL_SECONDS", 60, 60 * 60);
  const recoveryTtlSeconds = boundedInt(env.RECOVERY_TTL_SECONDS, 24 * 60 * 60, "RECOVERY_TTL_SECONDS", 60, 24 * 60 * 60);
  return {
    keyRing: {
      current: { id: currentId, secret: currentSecret },
      ...(previousId === undefined || previousSecret === undefined ? {} : { previous: { id: previousId, secret: previousSecret } }),
    },
    quotaSalt: nonEmpty(env.QUOTA_SALT, "QUOTA_SALT"),
    sessionTtlMs: sessionTtlSeconds * 1_000,
    uploadCapabilityTtlMs: capabilityTtlSeconds * 1_000,
    recoveryTtlMs: recoveryTtlSeconds * 1_000,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxUploadDurationMs: MAX_UPLOAD_DURATION_MS,
    quotas: {
      sessionMediaMinutes: boundedInt(env.MAX_SESSION_MEDIA_MINUTES, 30, "MAX_SESSION_MEDIA_MINUTES", 1, 10_000),
      ipMediaMinutes: boundedInt(env.MAX_IP_MEDIA_MINUTES, 90, "MAX_IP_MEDIA_MINUTES", 1, 100_000),
      sessionGenerations: boundedInt(env.MAX_SESSION_GENERATIONS, 6, "MAX_SESSION_GENERATIONS", 1, 10_000),
      sessionTts: boundedInt(env.MAX_SESSION_TTS, 50, "MAX_SESSION_TTS", 1, 100_000),
      globalSpendLimitCents: boundedInt(env.GLOBAL_SPEND_LIMIT_CENTS, 10_000, "GLOBAL_SPEND_LIMIT_CENTS", 1, 1_000_000_000),
    },
    globalSpendBreakerOpen: truthy(env.GLOBAL_SPEND_BREAKER_OPEN),
    turnstileSecret: nonEmpty(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"),
    turnstileVerifyUrl: env.TURNSTILE_VERIFY_URL?.trim() || "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  };
};
