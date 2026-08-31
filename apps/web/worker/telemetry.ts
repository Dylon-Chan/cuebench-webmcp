import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

export interface SanitizedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly audioSeconds?: number;
  readonly requests?: number;
}

export interface SanitizedTelemetryEvent {
  readonly durationMs?: number;
  readonly byteSize?: number;
  readonly stage?: string;
  readonly latencyMs?: number;
  readonly usage?: SanitizedUsage;
  readonly costCents?: number;
  readonly status?: string;
  readonly errorCode?: string;
}

export interface TelemetrySink {
  record: (event: SanitizedTelemetryEvent) => void | Promise<void>;
}

/**
 * Maps the strict telemetry allowlist to one Analytics Engine point. The
 * binding sees only fixed-position measurements and already-sanitized labels;
 * it never receives a request, file name, transcript, URL, or receipt.
 */
export const analyticsEngineTelemetrySink = (dataset: AnalyticsEngineDataset | undefined): TelemetrySink | undefined => {
  if (dataset === undefined) return undefined;
  return {
    record: (event) => {
      const safe = redactTelemetryEvent(event);
      dataset.writeDataPoint({
        // Analytics Engine supports one sampling index. Keep it fixed so no
        // request-derived value (including stage/status) can create a second
        // cardinality dimension; those already-redacted labels live in the
        // fixed blob positions below instead.
        indexes: ["cuebench"],
        blobs: [safe.stage ?? "unknown", safe.status ?? "unknown", safe.errorCode ?? "none"],
        // Fixed ordering keeps Analytics Engine schema stable without turning
        // optional data into caller-controlled shape or content.
        doubles: [
          safe.durationMs ?? 0,
          safe.byteSize ?? 0,
          safe.latencyMs ?? 0,
          safe.costCents ?? 0,
          safe.usage?.inputTokens ?? 0,
          safe.usage?.outputTokens ?? 0,
          safe.usage?.audioSeconds ?? 0,
          safe.usage?.requests ?? 0,
        ],
      });
    },
  };
};

const safeNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const safeLabel = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;

/** Strict allowlist: fields not named here are discarded before any telemetry sink sees them. */
export const redactTelemetryEvent = (input: unknown): SanitizedTelemetryEvent => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const event = input as Readonly<Record<string, unknown>>;
  const usageCandidate = typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage)
    ? event.usage as Readonly<Record<string, unknown>>
    : null;
  const usage: { inputTokens?: number; outputTokens?: number; audioSeconds?: number; requests?: number } = {};
  if (usageCandidate !== null) {
    const inputTokens = safeNumber(usageCandidate.inputTokens);
    const outputTokens = safeNumber(usageCandidate.outputTokens);
    const audioSeconds = safeNumber(usageCandidate.audioSeconds);
    const requests = safeNumber(usageCandidate.requests);
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (audioSeconds !== undefined) usage.audioSeconds = audioSeconds;
    if (requests !== undefined) usage.requests = requests;
  }
  const result: {
    durationMs?: number;
    byteSize?: number;
    stage?: string;
    latencyMs?: number;
    usage?: SanitizedUsage;
    costCents?: number;
    status?: string;
    errorCode?: string;
  } = {};
  const durationMs = safeNumber(event.durationMs);
  const byteSize = safeNumber(event.byteSize);
  const stage = safeLabel(event.stage);
  const latencyMs = safeNumber(event.latencyMs);
  const costCents = safeNumber(event.costCents);
  const status = safeLabel(event.status);
  const errorCode = safeLabel(event.errorCode);
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (byteSize !== undefined) result.byteSize = byteSize;
  if (stage !== undefined) result.stage = stage;
  if (latencyMs !== undefined) result.latencyMs = latencyMs;
  if (Object.keys(usage).length > 0) result.usage = usage;
  if (costCents !== undefined) result.costCents = costCents;
  if (status !== undefined) result.status = status;
  if (errorCode !== undefined) result.errorCode = errorCode;
  return result;
};

export const recordTelemetry = (sink: TelemetrySink | undefined, input: unknown): void => {
  if (sink === undefined) return;
  void Promise.resolve(sink.record(redactTelemetryEvent(input))).catch(() => {
    // Telemetry is operationally useful but never blocks a privacy or quota decision.
  });
};
