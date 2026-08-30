import { QUOTA_WINDOW_MS, type AnonymousQuotaLimits } from "./env";

export type QuotaRejectionCode =
  | "PENDING_SESSION_LIMIT"
  | "PENDING_IP_LIMIT"
  | "SESSION_QUOTA"
  | "IP_QUOTA"
  | "GLOBAL_BREAKER"
  | "RESERVATION_MISSING";

export interface UploadReservation {
  /** Every identity has already been salted before it reaches Durable Object storage. */
  readonly sessionKey: string;
  readonly ipKey: string;
  readonly reservationKey: string;
  readonly byteLength: number;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly quotas: AnonymousQuotaLimits;
}

export interface ActualMediaUsage {
  readonly reservationKey: string;
  readonly actualByteLength: number;
  readonly actualDurationMs: number;
  readonly nowMs: number;
  readonly quotas: AnonymousQuotaLimits;
}

export interface UsageReservation {
  readonly sessionKey: string;
  readonly ipKey: string;
  readonly usageKey: string;
  readonly nowMs: number;
  readonly quotas: AnonymousQuotaLimits;
}

export type UploadReservationResult =
  | { readonly accepted: true; readonly existing: boolean }
  | { readonly accepted: false; readonly code: QuotaRejectionCode };

export type CommitMediaResult =
  | { readonly accepted: true; readonly committedMinutes: number }
  | { readonly accepted: false; readonly code: QuotaRejectionCode; readonly releasedPending: boolean };

export interface QuotaLedgerPort {
  reserveUpload: (input: UploadReservation) => Promise<UploadReservationResult>;
  releaseUploadReservation: (input: { readonly reservationKey: string; readonly nowMs: number }) => Promise<boolean>;
  commitMedia: (input: ActualMediaUsage) => Promise<CommitMediaResult>;
  reserveGeneration: (input: UsageReservation) => Promise<boolean>;
  reserveTts: (input: UsageReservation) => Promise<boolean>;
  recordSpend: (input: { readonly cents: number; readonly nowMs: number; readonly globalSpendLimitCents: number }) => Promise<{ readonly breakerOpen: boolean; readonly spendCents: number }>;
}

interface CounterBucket {
  readonly expiresAtMs: number;
  readonly committedMediaMinutes: number;
  readonly generationCount: number;
  readonly ttsCount: number;
  readonly pendingBytes: number;
  readonly pendingOperations: number;
}

interface PendingReservation {
  readonly sessionKey: string;
  readonly ipKey: string;
  readonly byteLength: number;
  readonly expiresAtMs: number;
}

interface UsageMarker {
  readonly type: "generation" | "tts";
  readonly expiresAtMs: number;
}

interface MediaCommitMarker {
  readonly expiresAtMs: number;
  readonly result: CommitMediaResult;
}

interface GlobalSpendState {
  readonly expiresAtMs: number;
  readonly spendCents: number;
  readonly breakerOpen: boolean;
}

interface LedgerState {
  readonly sessions: Readonly<Record<string, CounterBucket>>;
  readonly networks: Readonly<Record<string, CounterBucket>>;
  readonly reservations: Readonly<Record<string, PendingReservation>>;
  readonly mediaCommitMarkers: Readonly<Record<string, MediaCommitMarker>>;
  readonly usageMarkers: Readonly<Record<string, UsageMarker>>;
  readonly global: GlobalSpendState;
}

export interface LedgerStorage {
  get: <Value>(key: string) => Promise<Value | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: LedgerStorage;
}

const stateKey = "cuebench-anonymous-quota-ledger-v2";

const emptyBucket = (expiresAtMs: number): CounterBucket => ({
  expiresAtMs,
  committedMediaMinutes: 0,
  generationCount: 0,
  ttsCount: 0,
  pendingBytes: 0,
  pendingOperations: 0,
});

const emptyState = (nowMs: number): LedgerState => ({
  sessions: {},
  networks: {},
  reservations: {},
  mediaCommitMarkers: {},
  usageMarkers: {},
  global: { expiresAtMs: nowMs + QUOTA_WINDOW_MS, spendCents: 0, breakerOpen: false },
});

const activeBucket = (bucket: CounterBucket | undefined, nowMs: number): CounterBucket | null => bucket === undefined || bucket.expiresAtMs <= nowMs
  ? null
  : { ...bucket, pendingBytes: 0, pendingOperations: 0 };

const addPending = (buckets: Readonly<Record<string, CounterBucket>>, key: string, byteLength: number, expiresAtMs: number): Readonly<Record<string, CounterBucket>> => {
  const bucket = buckets[key] ?? emptyBucket(expiresAtMs);
  return {
    ...buckets,
    [key]: {
      ...bucket,
      expiresAtMs: Math.max(bucket.expiresAtMs, expiresAtMs),
      pendingBytes: bucket.pendingBytes + byteLength,
      pendingOperations: bucket.pendingOperations + 1,
    },
  };
};

/** Rebuilds pending counters from the only persisted reservation records, safely releasing expired leases. */
const normaliseState = (input: LedgerState | undefined, nowMs: number): LedgerState => {
  const state = input ?? emptyState(nowMs);
  let sessions = Object.fromEntries(Object.entries(state.sessions)
    .map(([key, bucket]) => [key, activeBucket(bucket, nowMs)] as const)
    .filter((entry): entry is readonly [string, CounterBucket] => entry[1] !== null));
  let networks = Object.fromEntries(Object.entries(state.networks)
    .map(([key, bucket]) => [key, activeBucket(bucket, nowMs)] as const)
    .filter((entry): entry is readonly [string, CounterBucket] => entry[1] !== null));
  const reservations = Object.fromEntries(Object.entries(state.reservations).filter(([, reservation]) => reservation.expiresAtMs > nowMs));
  for (const reservation of Object.values(reservations)) {
    sessions = addPending(sessions, reservation.sessionKey, reservation.byteLength, reservation.expiresAtMs);
    networks = addPending(networks, reservation.ipKey, reservation.byteLength, reservation.expiresAtMs);
  }
  return {
    sessions,
    networks,
    reservations,
    mediaCommitMarkers: Object.fromEntries(Object.entries(state.mediaCommitMarkers ?? {}).filter(([, marker]) => marker.expiresAtMs > nowMs)),
    usageMarkers: Object.fromEntries(Object.entries(state.usageMarkers).filter(([, marker]) => marker.expiresAtMs > nowMs)),
    global: state.global.expiresAtMs > nowMs
      ? state.global
      : { expiresAtMs: nowMs + QUOTA_WINDOW_MS, spendCents: 0, breakerOpen: false },
  };
};

const replaceBucket = (state: LedgerState, scope: "sessions" | "networks", key: string, bucket: CounterBucket): LedgerState => ({
  ...state,
  [scope]: { ...state[scope], [key]: bucket },
});

const reserveUpload = (state: LedgerState, input: UploadReservation): { readonly state: LedgerState; readonly result: UploadReservationResult } => {
  const existing = state.reservations[input.reservationKey];
  if (existing !== undefined) return { state, result: { accepted: true, existing: true } };
  if (state.global.breakerOpen || state.global.spendCents >= input.quotas.globalSpendLimitCents) {
    return { state, result: { accepted: false, code: "GLOBAL_BREAKER" } };
  }
  const session = state.sessions[input.sessionKey] ?? emptyBucket(input.expiresAtMs);
  const network = state.networks[input.ipKey] ?? emptyBucket(input.nowMs + QUOTA_WINDOW_MS);
  if (session.pendingOperations + 1 > input.quotas.pendingSessionOperations || session.pendingBytes + input.byteLength > input.quotas.pendingSessionBytes) {
    return { state, result: { accepted: false, code: "PENDING_SESSION_LIMIT" } };
  }
  if (network.pendingOperations + 1 > input.quotas.pendingIpOperations || network.pendingBytes + input.byteLength > input.quotas.pendingIpBytes) {
    return { state, result: { accepted: false, code: "PENDING_IP_LIMIT" } };
  }
  const next = normaliseState({
    ...state,
    reservations: {
      ...state.reservations,
      [input.reservationKey]: {
        sessionKey: input.sessionKey,
        ipKey: input.ipKey,
        byteLength: input.byteLength,
        expiresAtMs: Math.min(input.expiresAtMs, input.nowMs + QUOTA_WINDOW_MS),
      },
    },
  }, input.nowMs);
  return { state: next, result: { accepted: true, existing: false } };
};

const releaseUploadReservation = (state: LedgerState, reservationKey: string, nowMs: number): { readonly state: LedgerState; readonly released: boolean } => {
  if (state.reservations[reservationKey] === undefined) return { state, released: false };
  const reservations = Object.fromEntries(Object.entries(state.reservations).filter(([key]) => key !== reservationKey));
  return { state: normaliseState({ ...state, reservations }, nowMs), released: true };
};

const commitMedia = (state: LedgerState, input: ActualMediaUsage): { readonly state: LedgerState; readonly result: CommitMediaResult } => {
  const marker = state.mediaCommitMarkers[input.reservationKey];
  if (marker !== undefined) return { state, result: marker.result };
  const reservation = state.reservations[input.reservationKey];
  if (reservation === undefined) return { state, result: { accepted: false, code: "RESERVATION_MISSING", releasedPending: false } };
  const released = releaseUploadReservation(state, input.reservationKey, input.nowMs);
  const withoutPending = released.state;
  if (withoutPending.global.breakerOpen || withoutPending.global.spendCents >= input.quotas.globalSpendLimitCents) {
    const result: CommitMediaResult = { accepted: false, code: "GLOBAL_BREAKER", releasedPending: true };
    return { state: { ...withoutPending, mediaCommitMarkers: { ...withoutPending.mediaCommitMarkers, [input.reservationKey]: { expiresAtMs: input.nowMs + QUOTA_WINDOW_MS, result } } }, result };
  }
  const session = withoutPending.sessions[reservation.sessionKey] ?? emptyBucket(input.nowMs + QUOTA_WINDOW_MS);
  const network = withoutPending.networks[reservation.ipKey] ?? emptyBucket(input.nowMs + QUOTA_WINDOW_MS);
  const minutes = Math.ceil(input.actualDurationMs / 60_000);
  if (!Number.isSafeInteger(input.actualByteLength) || input.actualByteLength <= 0 || !Number.isSafeInteger(input.actualDurationMs) || input.actualDurationMs <= 0) {
    const result: CommitMediaResult = { accepted: false, code: "RESERVATION_MISSING", releasedPending: true };
    return { state: { ...withoutPending, mediaCommitMarkers: { ...withoutPending.mediaCommitMarkers, [input.reservationKey]: { expiresAtMs: input.nowMs + QUOTA_WINDOW_MS, result } } }, result };
  }
  if (session.committedMediaMinutes + minutes > input.quotas.sessionMediaMinutes) {
    const result: CommitMediaResult = { accepted: false, code: "SESSION_QUOTA", releasedPending: true };
    return { state: { ...withoutPending, mediaCommitMarkers: { ...withoutPending.mediaCommitMarkers, [input.reservationKey]: { expiresAtMs: input.nowMs + QUOTA_WINDOW_MS, result } } }, result };
  }
  if (network.committedMediaMinutes + minutes > input.quotas.ipMediaMinutes) {
    const result: CommitMediaResult = { accepted: false, code: "IP_QUOTA", releasedPending: true };
    return { state: { ...withoutPending, mediaCommitMarkers: { ...withoutPending.mediaCommitMarkers, [input.reservationKey]: { expiresAtMs: input.nowMs + QUOTA_WINDOW_MS, result } } }, result };
  }
  let next = replaceBucket(withoutPending, "sessions", reservation.sessionKey, { ...session, committedMediaMinutes: session.committedMediaMinutes + minutes });
  next = replaceBucket(next, "networks", reservation.ipKey, { ...network, committedMediaMinutes: network.committedMediaMinutes + minutes });
  const result: CommitMediaResult = { accepted: true, committedMinutes: minutes };
  return { state: { ...next, mediaCommitMarkers: { ...next.mediaCommitMarkers, [input.reservationKey]: { expiresAtMs: input.nowMs + QUOTA_WINDOW_MS, result } } }, result };
};

const reserveUsage = (state: LedgerState, input: UsageReservation, type: "generation" | "tts"): { readonly state: LedgerState; readonly accepted: boolean } => {
  if (state.usageMarkers[input.usageKey] !== undefined) return { state, accepted: true };
  if (state.global.breakerOpen || state.global.spendCents >= input.quotas.globalSpendLimitCents) return { state, accepted: false };
  const session = state.sessions[input.sessionKey] ?? emptyBucket(input.nowMs + QUOTA_WINDOW_MS);
  const network = state.networks[input.ipKey] ?? emptyBucket(input.nowMs + QUOTA_WINDOW_MS);
  const field = type === "generation" ? "generationCount" : "ttsCount";
  const sessionLimit = type === "generation" ? input.quotas.sessionGenerations : input.quotas.sessionTts;
  const ipLimit = type === "generation" ? input.quotas.ipGenerations : input.quotas.ipTts;
  if (session[field] >= sessionLimit || network[field] >= ipLimit) return { state, accepted: false };
  let next = replaceBucket(state, "sessions", input.sessionKey, { ...session, [field]: session[field] + 1 });
  next = replaceBucket(next, "networks", input.ipKey, { ...network, [field]: network[field] + 1 });
  return {
    state: {
      ...next,
      usageMarkers: {
        ...next.usageMarkers,
        [input.usageKey]: { type, expiresAtMs: input.nowMs + QUOTA_WINDOW_MS },
      },
    },
    accepted: true,
  };
};

const recordSpend = (state: LedgerState, cents: number, limit: number): { readonly state: LedgerState; readonly result: { readonly breakerOpen: boolean; readonly spendCents: number } } => {
  const safeCents = Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
  const spendCents = state.global.spendCents + safeCents;
  const breakerOpen = state.global.breakerOpen || spendCents >= limit;
  const next = { ...state, global: { ...state.global, spendCents, breakerOpen } };
  return { state: next, result: { breakerOpen, spendCents } };
};

type LedgerAction =
  | { readonly type: "reserve-upload"; readonly nowMs: number; readonly input: UploadReservation }
  | { readonly type: "release-upload"; readonly nowMs: number; readonly reservationKey: string }
  | { readonly type: "commit-media"; readonly nowMs: number; readonly input: ActualMediaUsage }
  | { readonly type: "reserve-generation" | "reserve-tts"; readonly nowMs: number; readonly input: UsageReservation }
  | { readonly type: "record-spend"; readonly nowMs: number; readonly cents: number; readonly limit: number };

const applyAction = (state: LedgerState, action: LedgerAction): { readonly state: LedgerState; readonly value: unknown } => {
  if (action.type === "reserve-upload") {
    const applied = reserveUpload(state, action.input);
    return { state: applied.state, value: applied.result };
  }
  if (action.type === "release-upload") {
    const applied = releaseUploadReservation(state, action.reservationKey, action.nowMs);
    return { state: applied.state, value: { released: applied.released } };
  }
  if (action.type === "commit-media") {
    const applied = commitMedia(state, action.input);
    return { state: applied.state, value: applied.result };
  }
  if (action.type === "reserve-generation" || action.type === "reserve-tts") {
    const applied = reserveUsage(state, action.input, action.type === "reserve-generation" ? "generation" : "tts");
    return { state: applied.state, value: { accepted: applied.accepted } };
  }
  if (action.type !== "record-spend") return { state, value: null };
  const applied = recordSpend(state, action.cents, action.limit);
  return { state: applied.state, value: applied.result };
};

/** Durable Object storage contains only salted keys, numeric counters, bounded pending leases, expiry, and spend state. */
export class QuotaLedger {
  public constructor(private readonly state: DurableObjectStateLike) {}

  public async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method-not-allowed" }, { status: 405 });
    let action: LedgerAction;
    try {
      action = await request.json() as LedgerAction;
    } catch {
      return Response.json({ error: "invalid-json" }, { status: 400 });
    }
    const current = normaliseState(await this.state.storage.get<LedgerState>(stateKey), action.nowMs);
    const applied = applyAction(current, action);
    await this.state.storage.put(stateKey, applied.state);
    return Response.json(applied.value);
  }
}

/** Deterministic local adapter for unit tests; it never retains media or project content. */
export class InMemoryQuotaLedger implements QuotaLedgerPort {
  private state: LedgerState;

  public constructor(options: { readonly globalSpendCents?: number; readonly globalBreakerOpen?: boolean } = {}) {
    this.state = {
      ...emptyState(0),
      global: {
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        spendCents: options.globalSpendCents ?? 0,
        breakerOpen: options.globalBreakerOpen ?? false,
      },
    };
  }

  private apply(action: LedgerAction): unknown {
    this.state = normaliseState(this.state, action.nowMs);
    const applied = applyAction(this.state, action);
    this.state = applied.state;
    return applied.value;
  }

  public reserveUpload(input: UploadReservation): Promise<UploadReservationResult> { return Promise.resolve(this.apply({ type: "reserve-upload", nowMs: input.nowMs, input }) as UploadReservationResult); }
  public releaseUploadReservation(input: { readonly reservationKey: string; readonly nowMs: number }): Promise<boolean> { return Promise.resolve((this.apply({ type: "release-upload", ...input }) as { readonly released: boolean }).released); }
  public commitMedia(input: ActualMediaUsage): Promise<CommitMediaResult> { return Promise.resolve(this.apply({ type: "commit-media", nowMs: input.nowMs, input }) as CommitMediaResult); }
  public reserveGeneration(input: UsageReservation): Promise<boolean> { return Promise.resolve((this.apply({ type: "reserve-generation", nowMs: input.nowMs, input }) as { readonly accepted: boolean }).accepted); }
  public reserveTts(input: UsageReservation): Promise<boolean> { return Promise.resolve((this.apply({ type: "reserve-tts", nowMs: input.nowMs, input }) as { readonly accepted: boolean }).accepted); }
  public recordSpend(input: { readonly cents: number; readonly nowMs: number; readonly globalSpendLimitCents: number }): Promise<{ readonly breakerOpen: boolean; readonly spendCents: number }> {
    return Promise.resolve(this.apply({ type: "record-spend", nowMs: input.nowMs, cents: input.cents, limit: input.globalSpendLimitCents }) as { readonly breakerOpen: boolean; readonly spendCents: number });
  }
}

export class DurableObjectQuotaLedger implements QuotaLedgerPort {
  public constructor(private readonly namespace: { readonly idFromName: (name: string) => unknown; readonly get: (id: unknown) => { fetch: (request: Request) => Promise<Response> } }) {}

  private async call<Value>(action: LedgerAction): Promise<Value> {
    const response = await this.namespace.get(this.namespace.idFromName("cuebench-anonymous-quota-ledger-v2")).fetch(new Request("https://quota-ledger.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    }));
    if (!response.ok) throw new Error("CueBench quota enforcement is unavailable.");
    return response.json() as Promise<Value>;
  }

  public reserveUpload(input: UploadReservation): Promise<UploadReservationResult> { return this.call({ type: "reserve-upload", nowMs: input.nowMs, input }); }
  public async releaseUploadReservation(input: { readonly reservationKey: string; readonly nowMs: number }): Promise<boolean> { return (await this.call<{ readonly released: boolean }>({ type: "release-upload", ...input })).released; }
  public commitMedia(input: ActualMediaUsage): Promise<CommitMediaResult> { return this.call({ type: "commit-media", nowMs: input.nowMs, input }); }
  public async reserveGeneration(input: UsageReservation): Promise<boolean> { return (await this.call<{ readonly accepted: boolean }>({ type: "reserve-generation", nowMs: input.nowMs, input })).accepted; }
  public async reserveTts(input: UsageReservation): Promise<boolean> { return (await this.call<{ readonly accepted: boolean }>({ type: "reserve-tts", nowMs: input.nowMs, input })).accepted; }
  public recordSpend(input: { readonly cents: number; readonly nowMs: number; readonly globalSpendLimitCents: number }): Promise<{ readonly breakerOpen: boolean; readonly spendCents: number }> {
    return this.call({ type: "record-spend", nowMs: input.nowMs, cents: input.cents, limit: input.globalSpendLimitCents });
  }
}

/** Produces a one-way, scoped identifier before any quota state is persisted. */
export const saltedLedgerKey = async (salt: string, scope: string, rawValue: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\u0000${scope}\u0000${rawValue}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
