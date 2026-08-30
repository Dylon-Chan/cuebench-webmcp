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
