export interface CloudUploadFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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
}

export interface CloudUploadResult {
  /** Opaque Worker-signed receipt, never a storage URL. */
  readonly receipt: string;
}

export interface CancelCloudProcessingCopyInput {
  readonly fetcher?: CloudUploadFetch;
  readonly session: string;
  readonly operationId: string;
  readonly receipt: string;
}

export class CloudUploadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CloudUploadError";
  }
}

const defaultFetcher = (): CloudUploadFetch => {
  if (typeof globalThis.fetch !== "function") throw new CloudUploadError("Cloud processing is unavailable in this browser.");
  return globalThis.fetch.bind(globalThis);
};

const responseError = async (response: Response, fallback: string): Promise<CloudUploadError> => {
  try {
    const body = await response.json() as { readonly error?: { readonly message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message.trim().length > 0) {
      return new CloudUploadError(body.error.message);
    }
  } catch {
    // The Worker may return a non-JSON infrastructure response; do not surface its body as media context.
  }
  return new CloudUploadError(fallback);
};

const opaqueString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new CloudUploadError(fallback);
  return value;
};

/**
 * Creates a same-origin scoped operation before media bytes are sent. No names,
 * filenames, source URLs, captions, or frames are included in the transport.
 */
export const uploadCloudProcessingCopy = async (input: UploadCloudProcessingCopyInput): Promise<CloudUploadResult> => {
  if (!input.disclosureAccepted) {
    throw new CloudUploadError("Accept the temporary cloud processing disclosure before uploading a private processing copy.");
  }
  const fetcher = input.fetcher ?? defaultFetcher();
  const contentType = input.source.type.trim().toLowerCase();
  const operationResponse = await fetcher("/api/uploads", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId: input.projectId,
      operationId: input.operationId,
      media: {
        byteLength: input.source.size,
        durationMs: input.durationMs,
        contentType,
      },
      disclosureAccepted: true,
    }),
  });
  if (!operationResponse.ok) throw await responseError(operationResponse, "CueBench could not create a private upload operation.");
  const operation = await operationResponse.json() as { readonly uploadCapability?: unknown };
  const uploadCapability = opaqueString(operation.uploadCapability, "CueBench did not receive a private upload capability.");

  const uploaded = await fetcher(`/api/uploads/${encodeURIComponent(input.operationId)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${input.session}`,
      "content-type": contentType,
      "x-cuebench-upload-capability": uploadCapability,
    },
    body: input.source,
  });
  if (!uploaded.ok) throw await responseError(uploaded, "CueBench could not upload the private processing copy.");
  const result = await uploaded.json() as { readonly receipt?: unknown };
  return { receipt: opaqueString(result.receipt, "CueBench did not receive a signed upload receipt.") };
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
};
