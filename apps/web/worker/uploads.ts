import type { R2Bucket } from "@cloudflare/workers-types";
import type { WorkerSettings } from "./env";
import { signOpaqueToken, verifyOpaqueToken, type SignedTokenFields } from "./session";

export interface UploadMediaMetadata {
  /** Browser-provided planning metadata. It is never used to authorize processing. */
  readonly byteLength: number;
  readonly durationMs: number;
  readonly contentType: string;
}

interface UploadOperationTokenFields {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly ipKey: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly projectKey: string;
  readonly reservationKey: string;
  readonly objectKey: string;
  readonly metadataHash: string;
  readonly media: UploadMediaMetadata;
  readonly partSize: number;
  readonly partCount: number;
  readonly receiptExpiresAtMs: number;
}

export interface UploadCapabilityClaims extends SignedTokenFields, UploadOperationTokenFields {
  readonly type: "upload-capability";
}

/** Stable, opaque operation recovery token. It is intentionally not an R2 URL. */
export interface UploadReceiptClaims extends SignedTokenFields, UploadOperationTokenFields {
  readonly type: "upload-receipt";
}

export interface UploadPartReceiptClaims extends SignedTokenFields {
  readonly type: "upload-part-receipt";
  readonly sessionId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly partNumber: number;
  readonly etag: string;
}

/** The only object-store surface exposed to the upload routes. */
export interface MultipartPrivateObjectStore {
  createMultipart: (key: string, options: { readonly contentType: string; readonly customMetadata: Readonly<Record<string, string>> }) => Promise<{ readonly uploadId: string }>;
  uploadPart: (input: { readonly key: string; readonly uploadId: string; readonly partNumber: number; readonly body: ArrayBuffer }) => Promise<{ readonly etag: string }>;
  completeMultipart: (input: { readonly key: string; readonly uploadId: string; readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }> }) => Promise<void>;
  abortMultipart: (input: { readonly key: string; readonly uploadId: string }) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export class UploadValidationError extends Error {
  public constructor(
    public readonly code: "INVALID_METADATA" | "UNSUPPORTED_MEDIA" | "SIZE_LIMIT" | "DURATION_LIMIT" | "BODY_SIZE",
    message: string,
  ) {
    super(message);
    this.name = "UploadValidationError";
  }
}

const supportedVideoType = (contentType: string): boolean => contentType.startsWith("video/");

export const normaliseContentType = (value: string): string => value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const validateUploadMetadata = (input: UploadMediaMetadata, settings: Pick<WorkerSettings, "maxUploadBytes" | "maxUploadDurationMs">): UploadMediaMetadata => {
  const contentType = normaliseContentType(input.contentType);
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
    throw new UploadValidationError("INVALID_METADATA", "CueBench needs a positive, whole-number media size.");
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
    throw new UploadValidationError("INVALID_METADATA", "CueBench needs a positive, whole-number media duration.");
  }
  if (!supportedVideoType(contentType)) {
    throw new UploadValidationError("UNSUPPORTED_MEDIA", "Choose a supported video file for CueBench processing.");
  }
  if (input.byteLength > settings.maxUploadBytes) {
    throw new UploadValidationError("SIZE_LIMIT", "CueBench supports videos up to 500 MB.");
  }
  if (input.durationMs > settings.maxUploadDurationMs) {
    throw new UploadValidationError("DURATION_LIMIT", "CueBench supports videos up to 15 minutes long.");
  }
  return { ...input, contentType };
};

export interface UploadOperationAuthorization extends UploadOperationTokenFields {
  readonly issuedAtMs: number;
}

export const issueUploadCapability = async (input: UploadOperationAuthorization & {
  readonly expiresAtMs: number;
  readonly settings: Pick<WorkerSettings, "keyRing">;
}): Promise<string> => signOpaqueToken<UploadCapabilityClaims>({
  type: "upload-capability",
  sessionId: input.sessionId,
  sessionKey: input.sessionKey,
  ipKey: input.ipKey,
  operationId: input.operationId,
  operationKey: input.operationKey,
  projectKey: input.projectKey,
  reservationKey: input.reservationKey,
  objectKey: input.objectKey,
  metadataHash: input.metadataHash,
  media: input.media,
  partSize: input.partSize,
  partCount: input.partCount,
  receiptExpiresAtMs: input.receiptExpiresAtMs,
  issuedAtMs: input.issuedAtMs,
  expiresAtMs: input.expiresAtMs,
}, input.settings.keyRing);

export const verifyUploadCapability = (token: string, settings: Pick<WorkerSettings, "keyRing">, nowMs: number): Promise<UploadCapabilityClaims> => verifyOpaqueToken<UploadCapabilityClaims>(
  token,
  settings.keyRing,
  nowMs,
  "upload-capability",
);

/** Issuing from the persisted creation timestamp makes retries return byte-for-byte the same receipt. */
export const issueUploadReceipt = (input: UploadOperationAuthorization & {
  readonly settings: Pick<WorkerSettings, "keyRing">;
}): Promise<string> => signOpaqueToken<UploadReceiptClaims>({
  type: "upload-receipt",
  sessionId: input.sessionId,
  sessionKey: input.sessionKey,
  ipKey: input.ipKey,
  operationId: input.operationId,
  operationKey: input.operationKey,
  projectKey: input.projectKey,
  reservationKey: input.reservationKey,
  objectKey: input.objectKey,
  metadataHash: input.metadataHash,
  media: input.media,
  partSize: input.partSize,
  partCount: input.partCount,
  receiptExpiresAtMs: input.receiptExpiresAtMs,
  issuedAtMs: input.issuedAtMs,
  expiresAtMs: input.receiptExpiresAtMs,
}, input.settings.keyRing);

export const verifyUploadReceipt = (token: string, settings: Pick<WorkerSettings, "keyRing">, nowMs: number): Promise<UploadReceiptClaims> => verifyOpaqueToken<UploadReceiptClaims>(
  token,
  settings.keyRing,
  nowMs,
  "upload-receipt",
);

export const issueUploadPartReceipt = (input: {
  readonly sessionId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly partNumber: number;
  readonly etag: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly settings: Pick<WorkerSettings, "keyRing">;
}): Promise<string> => signOpaqueToken<UploadPartReceiptClaims>({
  type: "upload-part-receipt",
  sessionId: input.sessionId,
  operationId: input.operationId,
  operationKey: input.operationKey,
  partNumber: input.partNumber,
  etag: input.etag,
  issuedAtMs: input.issuedAtMs,
  expiresAtMs: input.expiresAtMs,
}, input.settings.keyRing);

export const verifyUploadPartReceipt = (token: string, settings: Pick<WorkerSettings, "keyRing">, nowMs: number): Promise<UploadPartReceiptClaims> => verifyOpaqueToken<UploadPartReceiptClaims>(
  token,
  settings.keyRing,
  nowMs,
  "upload-part-receipt",
);

export const privateObjectMetadata = (claims: Pick<UploadCapabilityClaims, "operationKey" | "sessionKey">): Readonly<Record<string, string>> => ({
  operation: claims.operationKey,
  owner: claims.sessionKey,
});

/**
 * Reads exactly one bounded multipart chunk. The route claims the part before
 * calling this function; this is the only materialization point for upload bytes.
 */
export const readExactUploadPart = async (request: Request, expectedByteLength: number, maximumPartByteLength: number): Promise<ArrayBuffer> => {
  if (request.body === null) throw new UploadValidationError("BODY_SIZE", "CueBench did not receive this private upload part.");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== expectedByteLength) {
    throw new UploadValidationError("BODY_SIZE", "CueBench could not verify this private upload part size.");
  }
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0 || expectedByteLength > maximumPartByteLength) {
    throw new UploadValidationError("BODY_SIZE", "CueBench rejected an invalid private upload part boundary.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumPartByteLength || byteLength > expectedByteLength) {
        await reader.cancel();
        throw new UploadValidationError("BODY_SIZE", "CueBench could not verify this private upload part size.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength !== expectedByteLength) {
    throw new UploadValidationError("BODY_SIZE", "CueBench could not verify this private upload part size.");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

export class R2PrivateObjectStore implements MultipartPrivateObjectStore {
  public constructor(private readonly bucket: R2Bucket) {}

  public async createMultipart(key: string, options: { readonly contentType: string; readonly customMetadata: Readonly<Record<string, string>> }): Promise<{ readonly uploadId: string }> {
    const upload = await this.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: { ...options.customMetadata },
    });
    return { uploadId: upload.uploadId };
  }

  public async uploadPart(input: { readonly key: string; readonly uploadId: string; readonly partNumber: number; readonly body: ArrayBuffer }): Promise<{ readonly etag: string }> {
    const part = await this.bucket.resumeMultipartUpload(input.key, input.uploadId).uploadPart(input.partNumber, input.body);
    return { etag: part.etag };
  }

  public async completeMultipart(input: { readonly key: string; readonly uploadId: string; readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }> }): Promise<void> {
    await this.bucket.resumeMultipartUpload(input.key, input.uploadId).complete(input.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
  }

  public async abortMultipart(input: { readonly key: string; readonly uploadId: string }): Promise<void> {
    await this.bucket.resumeMultipartUpload(input.key, input.uploadId).abort();
  }

  public delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}
