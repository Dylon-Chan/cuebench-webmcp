export interface CloudUploadFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CloudUploadReceiptStore {
  load: (key: string) => unknown | null;
  save: (key: string, value: unknown) => void;
  remove: (key: string) => void;
}

export interface CloudUploadErrorDetails {
  readonly code?: string;
  readonly retrySafe?: boolean;
  readonly stateChanged?: boolean;
  readonly nextAction?: string;
}

export class CloudUploadError extends Error {
  public constructor(message: string, public readonly details: CloudUploadErrorDetails = {}) {
    super(message);
    this.name = "CloudUploadError";
  }
}

export interface AnonymousCloudSession {
  readonly session: string;
  readonly expiresAtMs: number;
}

export interface CreateAnonymousCloudSessionInput {
  readonly fetcher?: CloudUploadFetch;
  readonly turnstileToken: string;
  readonly idempotencyKey: string;
}

export interface PersistedCloudUpload {
  readonly version: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly sourceByteLength: number;
  readonly sourceContentType: string;
  readonly durationMs: number;
  /** Opaque anonymous bearer needed to resume this exact owner-bound operation. */
  readonly session?: string;
  readonly operationReceipt: string;
  readonly uploadCapability: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly partReceipts: Readonly<Record<number, string>>;
}

export interface UploadCloudProcessingCopyInput {
  readonly fetcher?: CloudUploadFetch;
  /** A short-lived anonymous session returned by the same-origin Worker after Turnstile. */
  readonly session: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly source: Blob;
  readonly durationMs: number;
  /** Must be an affirmative UI choice; the client never infers consent. */
  readonly disclosureAccepted: boolean;
  readonly receiptStore?: CloudUploadReceiptStore;
}

export interface CloudUploadResult {
  /** Opaque Worker-signed operation receipt, never a storage URL. */
  readonly receipt: string;
  readonly operationReceipt: string;
  readonly status: string;
  readonly operation: PersistedCloudUpload;
}

export interface CancelCloudProcessingCopyInput {
  readonly fetcher?: CloudUploadFetch;
  readonly session: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly receipt: string;
  readonly receiptStore?: CloudUploadReceiptStore;
}

interface WorkerOperationResponse {
  readonly operationReceipt: string;
  readonly uploadCapability: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly uploadedPartNumbers: readonly number[];
  readonly status: string;
}

const receiptKey = (projectId: string): string => `cuebench-cloud-upload:${projectId}`;

const defaultFetcher = (): CloudUploadFetch => {
  if (typeof globalThis.fetch !== "function") throw new CloudUploadError("Cloud processing is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const defaultReceiptStore = (): CloudUploadReceiptStore | null => {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return {
      load: (key) => {
        const value = globalThis.localStorage.getItem(key);
        if (value === null) return null;
        try { return JSON.parse(value) as unknown; } catch { return null; }
      },
      save: (key, value) => globalThis.localStorage.setItem(key, JSON.stringify(value)),
      remove: (key) => globalThis.localStorage.removeItem(key),
    };
  } catch {
    return null;
  }
};

const opaqueString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new CloudUploadError(fallback);
  return value;
};

const positiveInteger = (value: unknown, fallback: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new CloudUploadError(fallback);
  return value as number;
};

const responseError = async (response: Response, fallback: string): Promise<CloudUploadError> => {
  try {
    const body = await response.json() as { readonly error?: Readonly<Record<string, unknown>> };
    const error = body.error;
    if (typeof error?.message === "string" && error.message.trim().length > 0) {
      return new CloudUploadError(error.message, {
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.retrySafe === "boolean" ? { retrySafe: error.retrySafe } : {}),
        ...(typeof error.stateChanged === "boolean" ? { stateChanged: error.stateChanged } : {}),
        ...(typeof error.nextAction === "string" ? { nextAction: error.nextAction } : {}),
      });
    }
  } catch {
    // Do not surface an infrastructure response body: it may contain private request context.
  }
  return new CloudUploadError(fallback);
};

const parseWorkerOperation = (value: unknown): WorkerOperationResponse => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CloudUploadError("CueBench did not receive resumable private-upload state.");
  const record = value as Readonly<Record<string, unknown>>;
  const parts = Array.isArray(record.uploadedPartNumbers) && record.uploadedPartNumbers.every((part) => Number.isSafeInteger(part) && (part as number) > 0)
    ? record.uploadedPartNumbers as readonly number[]
    : [];
  return {
    operationReceipt: opaqueString(record.operationReceipt, "CueBench did not receive a signed private-operation receipt."),
    uploadCapability: opaqueString(record.uploadCapability, "CueBench did not receive a private multipart capability."),
    partSize: positiveInteger(record.partSize, "CueBench did not receive a valid multipart part size."),
    partCount: positiveInteger(record.partCount, "CueBench did not receive a valid multipart part count."),
    uploadedPartNumbers: parts,
    status: opaqueString(record.status, "CueBench did not receive a private-upload status."),
  };
};

const parseStored = (value: unknown, input: Pick<UploadCloudProcessingCopyInput, "projectId" | "operationId" | "source" | "durationMs">): PersistedCloudUpload | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== 1
    || record.projectId !== input.projectId
    || record.operationId !== input.operationId
    || record.sourceByteLength !== input.source.size
    || record.sourceContentType !== input.source.type.trim().toLowerCase()
    || record.durationMs !== input.durationMs
    || !Number.isSafeInteger(record.partSize)
    || !Number.isSafeInteger(record.partCount)
    || typeof record.partReceipts !== "object"
    || record.partReceipts === null
    || Array.isArray(record.partReceipts)
  ) return null;
  try {
    const partReceipts = Object.fromEntries(Object.entries(record.partReceipts as Readonly<Record<string, unknown>>)
      .filter(([part, receipt]) => /^[1-9][0-9]*$/.test(part) && typeof receipt === "string" && receipt.length > 0)
      .map(([part, receipt]) => [Number(part), receipt as string]));
    return {
      version: 1,
      projectId: input.projectId,
      operationId: input.operationId,
      sourceByteLength: input.source.size,
      sourceContentType: input.source.type.trim().toLowerCase(),
      durationMs: input.durationMs,
      ...(typeof record.session === "string" && record.session.length > 0 ? { session: record.session } : {}),
      operationReceipt: opaqueString(record.operationReceipt, "CueBench's saved private-operation receipt is incomplete."),
      uploadCapability: opaqueString(record.uploadCapability, "CueBench's saved multipart capability is incomplete."),
      partSize: positiveInteger(record.partSize, "CueBench's saved multipart size is incomplete."),
      partCount: positiveInteger(record.partCount, "CueBench's saved multipart count is incomplete."),
      partReceipts,
    };
  } catch {
    return null;
  }
};

const persist = (store: CloudUploadReceiptStore | null, operation: PersistedCloudUpload): void => {
  store?.save(receiptKey(operation.projectId), operation);
};

const createOperation = async (input: UploadCloudProcessingCopyInput, fetcher: CloudUploadFetch): Promise<{ readonly operation: PersistedCloudUpload; readonly uploadedPartNumbers: readonly number[]; readonly status: string }> => {
  const response = await fetcher("/api/uploads", {
    method: "POST",
    headers: { authorization: `Bearer ${input.session}`, "content-type": "application/json" },
    body: JSON.stringify({
      projectId: input.projectId,
      operationId: input.operationId,
      media: {
        byteLength: input.source.size,
        durationMs: input.durationMs,
        contentType: input.source.type.trim().toLowerCase(),
      },
      disclosureAccepted: true,
    }),
  });
  if (!response.ok) throw await responseError(response, "CueBench could not create a resumable private upload operation.");
  const worker = parseWorkerOperation(await response.json());
  return {
    operation: {
      version: 1,
      projectId: input.projectId,
      operationId: input.operationId,
      sourceByteLength: input.source.size,
      sourceContentType: input.source.type.trim().toLowerCase(),
      durationMs: input.durationMs,
      session: input.session,
      operationReceipt: worker.operationReceipt,
      uploadCapability: worker.uploadCapability,
      partSize: worker.partSize,
      partCount: worker.partCount,
      partReceipts: {},
    },
    uploadedPartNumbers: worker.uploadedPartNumbers,
    status: worker.status,
  };
};

/** Returns only opaque recovery state; callers must still obtain explicit user acceptance before using it. */
export const loadPersistedCloudUpload = (projectId: string, store: CloudUploadReceiptStore | null = defaultReceiptStore()): Pick<PersistedCloudUpload, "operationId" | "session"> | null => {
  const value = store?.load(receiptKey(projectId));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.version !== 1 || typeof record.operationId !== "string" || record.operationId.length === 0) return null;
  return {
    operationId: record.operationId,
    ...(typeof record.session === "string" && record.session.length > 0 ? { session: record.session } : {}),
  };
};

const refreshOperation = async (input: UploadCloudProcessingCopyInput, fetcher: CloudUploadFetch, operation: PersistedCloudUpload): Promise<{ readonly operation: PersistedCloudUpload; readonly uploadedPartNumbers: readonly number[]; readonly status: string }> => {
  const response = await fetcher(`/api/uploads/${encodeURIComponent(input.operationId)}`, {
    headers: {
      authorization: `Bearer ${input.session}`,
      "x-cuebench-operation-receipt": operation.operationReceipt,
    },
  });
  if (!response.ok) throw await responseError(response, "CueBench could not refresh this private upload's resumable state.");
  const worker = parseWorkerOperation(await response.json());
  return {
    operation: {
      ...operation,
      operationReceipt: worker.operationReceipt,
      uploadCapability: worker.uploadCapability,
      partSize: worker.partSize,
      partCount: worker.partCount,
    },
    uploadedPartNumbers: worker.uploadedPartNumbers,
    status: worker.status,
  };
};

/** Obtains the short-lived anonymous session only after a rendered Turnstile widget yields a token. */
export const createAnonymousCloudSession = async (input: CreateAnonymousCloudSessionInput): Promise<AnonymousCloudSession> => {
  const fetcher = input.fetcher ?? defaultFetcher();
  const response = await fetcher("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: input.turnstileToken, idempotencyKey: input.idempotencyKey }),
  });
  if (!response.ok) throw await responseError(response, "CueBench could not create an anonymous cloud-processing session.");
  const result = await response.json() as Readonly<Record<string, unknown>>;
  return {
    session: opaqueString(result.session, "CueBench did not return an anonymous cloud-processing session."),
    expiresAtMs: positiveInteger(result.expiresAtMs, "CueBench did not return an anonymous session expiry."),
  };
};

/**
 * Sends one Blob slice per Worker request. It persists only opaque signed
 * recovery material in browser storage, never media bytes, file names, or URLs.
 */
export const uploadCloudProcessingCopy = async (input: UploadCloudProcessingCopyInput): Promise<CloudUploadResult> => {
  if (!input.disclosureAccepted) {
    throw new CloudUploadError("Accept the temporary cloud processing disclosure before uploading a private processing copy.");
  }
  const contentType = input.source.type.trim().toLowerCase();
  if (!contentType.startsWith("video/")) throw new CloudUploadError("Choose a supported local video before starting cloud processing.");
  const fetcher = input.fetcher ?? defaultFetcher();
  const store = input.receiptStore ?? defaultReceiptStore();
  const saved = parseStored(store?.load(receiptKey(input.projectId)) ?? null, input);
  let state = saved === null
    ? await createOperation(input, fetcher)
    : await refreshOperation(input, fetcher, saved);
  let operation = state.operation;
  persist(store, operation);
  if (state.status === "creating") {
    state = await refreshOperation(input, fetcher, operation);
    operation = state.operation;
    persist(store, operation);
    if (state.status === "creating") {
      throw new CloudUploadError("CueBench is still creating the private multipart lease. The opaque recovery receipt was saved; retry without choosing a new operation.", { retrySafe: true, nextAction: "wait-for-status" });
    }
  }
  if (state.status === "queued" || state.status === "completed") return { receipt: operation.operationReceipt, operationReceipt: operation.operationReceipt, status: state.status, operation };
  const uploaded = new Set<number>(state.uploadedPartNumbers);
  for (let index = 1; index <= operation.partCount; index += 1) {
    if (uploaded.has(index)) continue;
    const start = (index - 1) * operation.partSize;
    const end = Math.min(input.source.size, start + operation.partSize);
    const part = input.source.slice(start, end, contentType);
    const response = await fetcher(`/api/uploads/${encodeURIComponent(input.operationId)}/parts/${index}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${input.session}`,
        "content-type": contentType,
        "x-cuebench-upload-capability": operation.uploadCapability,
      },
      body: part,
    });
    if (!response.ok) throw await responseError(response, "CueBench could not upload this bounded private media part.");
    const partResult = await response.json() as Readonly<Record<string, unknown>>;
    const recordedPart = positiveInteger(partResult.partNumber, "CueBench did not return this private multipart receipt's part number.");
    if (recordedPart !== index) throw new CloudUploadError("CueBench returned a private multipart receipt for a different part.");
    operation = { ...operation, partReceipts: { ...operation.partReceipts, [index]: opaqueString(partResult.partReceipt, "CueBench did not return a private multipart receipt.") } };
    persist(store, operation);
  }
  const completion = await fetcher(`/api/uploads/${encodeURIComponent(input.operationId)}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.session}`,
      "content-type": "application/json",
      "x-cuebench-operation-receipt": operation.operationReceipt,
    },
    body: "{}",
  });
  if (!completion.ok) throw await responseError(completion, "CueBench could not begin authoritative private-media processing.");
  const completed = await completion.json() as Readonly<Record<string, unknown>>;
  const receipt = opaqueString(completed.operationReceipt, "CueBench did not return the private operation receipt after completion.");
  return { receipt, operationReceipt: receipt, status: opaqueString(completed.status, "CueBench did not return private-processing status."), operation };
};

/** Requests immediate best-effort deletion for a cancelled processing operation. */
export const cancelCloudProcessingCopy = async (input: CancelCloudProcessingCopyInput): Promise<void> => {
  const fetcher = input.fetcher ?? defaultFetcher();
  const response = await fetcher(`/api/uploads/${encodeURIComponent(input.operationId)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${input.session}`,
      "x-cuebench-operation-receipt": input.receipt,
    },
  });
  if (!response.ok) throw await responseError(response, "CueBench could not confirm private-copy cleanup. It remains subject to the 24-hour deletion ceiling.");
  (input.receiptStore ?? defaultReceiptStore())?.remove(receiptKey(input.projectId));
};
