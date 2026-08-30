import { QUOTA_WINDOW_MS, type AnonymousQuotaLimits } from "./env";

export type QuotaRejectionCode = "DUPLICATE_OPERATION" | "SESSION_QUOTA" | "IP_QUOTA" | "GLOBAL_BREAKER";
export type UploadOperationState = "missing" | "issued" | "uploading" | "uploaded" | "cleaned";
export type UploadClaimResult = "claimed" | "missing" | "uploading" | "uploaded" | "cleaned";

export interface UploadReservation {
  /** All identifiers are already salted one-way digests before this boundary. */
  readonly sessionKey: string;
  readonly ipKey: string;
  readonly operationKey: string;
  readonly mediaMinutes: number;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly quotas: AnonymousQuotaLimits;
}

export type UploadReservationResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: QuotaRejectionCode };

export interface QuotaLedgerPort {
  reserveUpload: (input: UploadReservation) => Promise<UploadReservationResult>;
  operationState: (input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }) => Promise<UploadOperationState>;
  /** Atomically moves an issued operation into the single-writer upload state. */
  claimUpload: (input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }) => Promise<UploadClaimResult>;
  markUploaded: (input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }) => Promise<boolean>;
  releaseUpload: (input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }) => Promise<boolean>;
  markCleaned: (input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }) => Promise<boolean>;
  recordGeneration: (input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }) => Promise<boolean>;
  recordTts: (input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }) => Promise<boolean>;
}

interface IdempotencyMarker {
  readonly expiresAtMs: number;
  readonly state: Exclude<UploadOperationState, "missing">;
}

interface CounterBucket {
  readonly expiresAtMs: number;
  readonly mediaMinutes: number;
  readonly generationCount: number;
  readonly ttsCount: number;
  readonly operations: Readonly<Record<string, IdempotencyMarker>>;
}

interface GlobalSpendState {
  readonly expiresAtMs: number;
  readonly spendCents: number;
  readonly breakerOpen: boolean;
}

interface LedgerState {
  readonly sessions: Readonly<Record<string, CounterBucket>>;
  readonly networks: Readonly<Record<string, CounterBucket>>;
  readonly global: GlobalSpendState;
}

export interface LedgerStorage {
  get: <Value>(key: string) => Promise<Value | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: LedgerStorage;
}

const emptyBucket = (expiresAtMs: number): CounterBucket => ({
  expiresAtMs,
  mediaMinutes: 0,
  generationCount: 0,
  ttsCount: 0,
  operations: {},
});

const emptyState = (nowMs: number): LedgerState => ({
  sessions: {},
  networks: {},
  global: { expiresAtMs: nowMs + QUOTA_WINDOW_MS, spendCents: 0, breakerOpen: false },
});

const activeBucket = (bucket: CounterBucket | undefined, nowMs: number, expiresAtMs: number): CounterBucket => {
  if (bucket === undefined || bucket.expiresAtMs <= nowMs) return emptyBucket(expiresAtMs);
  const operations = Object.fromEntries(Object.entries(bucket.operations).filter(([, marker]) => marker.expiresAtMs > nowMs));
  return { ...bucket, operations };
};

const normaliseState = (input: LedgerState | undefined, nowMs: number): LedgerState => {
  const state = input ?? emptyState(nowMs);
  const sessions = Object.fromEntries(Object.entries(state.sessions)
    .filter(([, bucket]) => bucket.expiresAtMs > nowMs)
    .map(([key, bucket]) => [key, activeBucket(bucket, nowMs, bucket.expiresAtMs)]));
  const networks = Object.fromEntries(Object.entries(state.networks)
    .filter(([, bucket]) => bucket.expiresAtMs > nowMs)
    .map(([key, bucket]) => [key, activeBucket(bucket, nowMs, bucket.expiresAtMs)]));
  return {
    sessions,
    networks,
    global: state.global.expiresAtMs > nowMs
      ? state.global
      : { expiresAtMs: nowMs + QUOTA_WINDOW_MS, spendCents: 0, breakerOpen: false },
  };
};

const withOperation = (bucket: CounterBucket, operationKey: string, marker: IdempotencyMarker): CounterBucket => ({
  ...bucket,
  operations: { ...bucket.operations, [operationKey]: marker },
});

const nextState = (state: LedgerState, input: UploadReservation): { readonly state: LedgerState; readonly result: UploadReservationResult } => {
  const session = activeBucket(state.sessions[input.sessionKey], input.nowMs, input.expiresAtMs);
  const network = activeBucket(state.networks[input.ipKey], input.nowMs, input.nowMs + QUOTA_WINDOW_MS);
  if (session.operations[input.operationKey] !== undefined) {
    return { state, result: { accepted: false, code: "DUPLICATE_OPERATION" } };
  }
  if (state.global.breakerOpen || state.global.spendCents >= input.quotas.globalSpendLimitCents) {
    return { state, result: { accepted: false, code: "GLOBAL_BREAKER" } };
  }
  if (session.mediaMinutes + input.mediaMinutes > input.quotas.sessionMediaMinutes) {
    return { state, result: { accepted: false, code: "SESSION_QUOTA" } };
  }
  if (network.mediaMinutes + input.mediaMinutes > input.quotas.ipMediaMinutes) {
    return { state, result: { accepted: false, code: "IP_QUOTA" } };
  }
  const marker = { expiresAtMs: Math.min(input.expiresAtMs, input.nowMs + QUOTA_WINDOW_MS), state: "issued" as const };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: withOperation({ ...session, mediaMinutes: session.mediaMinutes + input.mediaMinutes }, input.operationKey, marker),
      },
      networks: {
        ...state.networks,
        [input.ipKey]: { ...network, mediaMinutes: network.mediaMinutes + input.mediaMinutes },
      },
    },
    result: { accepted: true },
  };
};

const operationState = (state: LedgerState, sessionKey: string, operationKey: string): UploadOperationState => state.sessions[sessionKey]?.operations[operationKey]?.state ?? "missing";

const claimUpload = (state: LedgerState, input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): { readonly state: LedgerState; readonly result: UploadClaimResult } => {
  const session = state.sessions[input.sessionKey];
  const marker = session?.operations[input.operationKey];
  if (session === undefined || marker === undefined || marker.expiresAtMs <= input.nowMs) return { state, result: "missing" };
  if (marker.state !== "issued") return { state, result: marker.state };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: withOperation(session, input.operationKey, { ...marker, state: "uploading" }),
      },
    },
    result: "claimed",
  };
};

const markUploaded = (state: LedgerState, input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): { readonly state: LedgerState; readonly changed: boolean } => {
  const session = state.sessions[input.sessionKey];
  const marker = session?.operations[input.operationKey];
  if (session === undefined || marker === undefined || marker.expiresAtMs <= input.nowMs) return { state, changed: false };
  if (marker.state === "uploaded") return { state, changed: true };
  if (marker.state !== "uploading") return { state, changed: false };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: withOperation(session, input.operationKey, { ...marker, state: "uploaded" }),
      },
    },
    changed: true,
  };
};

const releaseUpload = (state: LedgerState, input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): { readonly state: LedgerState; readonly changed: boolean } => {
  const session = state.sessions[input.sessionKey];
  const marker = session?.operations[input.operationKey];
  if (session === undefined || marker === undefined || marker.expiresAtMs <= input.nowMs || marker.state !== "uploading") {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: withOperation(session, input.operationKey, { ...marker, state: "issued" }),
      },
    },
    changed: true,
  };
};

const markCleaned = (state: LedgerState, input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): { readonly state: LedgerState; readonly changed: boolean } => {
  const session = state.sessions[input.sessionKey];
  const marker = session?.operations[input.operationKey];
  if (session === undefined || marker === undefined || marker.expiresAtMs <= input.nowMs) return { state, changed: false };
  if (marker.state === "cleaned") return { state, changed: true };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: withOperation(session, input.operationKey, { ...marker, state: "cleaned" }),
      },
    },
    changed: true,
  };
};

const incrementCounter = (state: LedgerState, input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }, counter: "generationCount" | "ttsCount"): { readonly state: LedgerState; readonly accepted: boolean } => {
  const session = activeBucket(state.sessions[input.sessionKey], input.nowMs, input.nowMs + QUOTA_WINDOW_MS);
  const limit = counter === "generationCount" ? input.quotas.sessionGenerations : input.quotas.sessionTts;
  if (session[counter] >= limit) return { state, accepted: false };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        [input.sessionKey]: { ...session, [counter]: session[counter] + 1 },
      },
    },
    accepted: true,
  };
};

const stateKey = "cuebench-anonymous-quota-ledger-v1";

/** Durable Object storage contains only salted keys, counters, expiry buckets, and global spend state. */
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

type LedgerAction =
  | { readonly type: "reserve-upload"; readonly nowMs: number; readonly input: UploadReservation }
  | { readonly type: "operation-state"; readonly nowMs: number; readonly input: { readonly sessionKey: string; readonly operationKey: string } }
  | { readonly type: "claim-upload" | "mark-uploaded" | "release-upload" | "mark-cleaned"; readonly nowMs: number; readonly input: { readonly sessionKey: string; readonly operationKey: string } }
  | { readonly type: "record-generation" | "record-tts"; readonly nowMs: number; readonly input: { readonly sessionKey: string; readonly quotas: AnonymousQuotaLimits } };

const applyAction = (state: LedgerState, action: LedgerAction): { readonly state: LedgerState; readonly value: unknown } => {
  if (action.type === "reserve-upload") {
    const applied = nextState(state, action.input);
    return { state: applied.state, value: applied.result };
  }
  if (action.type === "operation-state") {
    return { state, value: { state: operationState(state, action.input.sessionKey, action.input.operationKey) } };
  }
  if (action.type === "claim-upload") {
    const applied = claimUpload(state, { ...action.input, nowMs: action.nowMs });
    return { state: applied.state, value: { result: applied.result } };
  }
  if (action.type === "mark-uploaded") {
    const applied = markUploaded(state, { ...action.input, nowMs: action.nowMs });
    return { state: applied.state, value: { changed: applied.changed } };
  }
  if (action.type === "release-upload") {
    const applied = releaseUpload(state, { ...action.input, nowMs: action.nowMs });
    return { state: applied.state, value: { changed: applied.changed } };
  }
  if (action.type === "mark-cleaned") {
    const applied = markCleaned(state, { ...action.input, nowMs: action.nowMs });
    return { state: applied.state, value: { changed: applied.changed } };
  }
  if (action.type === "record-generation" || action.type === "record-tts") {
    const applied = incrementCounter(
      state,
      { ...action.input, nowMs: action.nowMs },
      action.type === "record-generation" ? "generationCount" : "ttsCount",
    );
    return { state: applied.state, value: { accepted: applied.accepted } };
  }
  return { state, value: { error: "unknown-action" } };
};

/** Fixture adapter used by local tests; it has the same no-content state shape as the Durable Object. */
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

  public async reserveUpload(input: UploadReservation): Promise<UploadReservationResult> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = nextState(this.state, input);
    this.state = applied.state;
    return applied.result;
  }

  public async operationState(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<UploadOperationState> {
    this.state = normaliseState(this.state, input.nowMs);
    return operationState(this.state, input.sessionKey, input.operationKey);
  }

  public async claimUpload(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<UploadClaimResult> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = claimUpload(this.state, input);
    this.state = applied.state;
    return applied.result;
  }

  public async markUploaded(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = markUploaded(this.state, input);
    this.state = applied.state;
    return applied.changed;
  }

  public async releaseUpload(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = releaseUpload(this.state, input);
    this.state = applied.state;
    return applied.changed;
  }

  public async markCleaned(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = markCleaned(this.state, input);
    this.state = applied.state;
    return applied.changed;
  }

  public async recordGeneration(input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }): Promise<boolean> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = incrementCounter(this.state, input, "generationCount");
    this.state = applied.state;
    return applied.accepted;
  }

  public async recordTts(input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }): Promise<boolean> {
    this.state = normaliseState(this.state, input.nowMs);
    const applied = incrementCounter(this.state, input, "ttsCount");
    this.state = applied.state;
    return applied.accepted;
  }
}

export class DurableObjectQuotaLedger implements QuotaLedgerPort {
  public constructor(private readonly namespace: { readonly idFromName: (name: string) => unknown; readonly get: (id: unknown) => { fetch: (request: Request) => Promise<Response> } }) {}

  private async call<Value>(action: LedgerAction): Promise<Value> {
    const stub = this.namespace.get(this.namespace.idFromName("cuebench-anonymous-quota-ledger-v1"));
    const response = await stub.fetch(new Request("https://quota-ledger.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    }));
    if (!response.ok) throw new Error("CueBench quota enforcement is unavailable.");
    return response.json() as Promise<Value>;
  }

  public async reserveUpload(input: UploadReservation): Promise<UploadReservationResult> {
    return this.call<UploadReservationResult>({ type: "reserve-upload", nowMs: input.nowMs, input });
  }

  public async operationState(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<UploadOperationState> {
    const result = await this.call<{ readonly state: UploadOperationState }>({ type: "operation-state", nowMs: input.nowMs, input });
    return result.state;
  }

  public async claimUpload(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<UploadClaimResult> {
    return (await this.call<{ readonly result: UploadClaimResult }>({ type: "claim-upload", nowMs: input.nowMs, input })).result;
  }

  public async markUploaded(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    return (await this.call<{ readonly changed: boolean }>({ type: "mark-uploaded", nowMs: input.nowMs, input })).changed;
  }

  public async releaseUpload(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    return (await this.call<{ readonly changed: boolean }>({ type: "release-upload", nowMs: input.nowMs, input })).changed;
  }

  public async markCleaned(input: { readonly sessionKey: string; readonly operationKey: string; readonly nowMs: number }): Promise<boolean> {
    return (await this.call<{ readonly changed: boolean }>({ type: "mark-cleaned", nowMs: input.nowMs, input })).changed;
  }

  public async recordGeneration(input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }): Promise<boolean> {
    return (await this.call<{ readonly accepted: boolean }>({ type: "record-generation", nowMs: input.nowMs, input })).accepted;
  }

  public async recordTts(input: { readonly sessionKey: string; readonly nowMs: number; readonly quotas: AnonymousQuotaLimits }): Promise<boolean> {
    return (await this.call<{ readonly accepted: boolean }>({ type: "record-tts", nowMs: input.nowMs, input })).accepted;
  }
}

/** Produces a one-way, scoped identifier before any quota data is persisted. */
export const saltedLedgerKey = async (salt: string, scope: string, rawValue: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\u0000${scope}\u0000${rawValue}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
