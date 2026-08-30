import type { R2Bucket } from "@cloudflare/workers-types";
import type { WorkerSettings } from "./env";
import { signOpaqueToken, verifyOpaqueToken, type SignedTokenFields } from "./session";

export interface UploadMediaMetadata {
  readonly byteLength: number;
  readonly durationMs: number;
  readonly contentType: string;
}

export interface UploadCapabilityClaims extends SignedTokenFields {
  readonly type: "upload-capability";
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly projectKey: string;
  readonly objectKey: string;
  readonly media: UploadMediaMetadata;
  readonly receiptExpiresAtMs: number;
}

export interface UploadReceiptClaims extends Omit<UploadCapabilityClaims, "type"> {
  readonly type: "upload-receipt";
}

export interface StoredPrivateObject {
  readonly byteLength: number;
  readonly contentType: string;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface PrivateObjectStore {
  put: (key: string, body: ArrayBuffer, options: { readonly contentType: string; readonly customMetadata: Readonly<Record<string, string>> }) => Promise<void>;
  head: (key: string) => Promise<StoredPrivateObject | null>;
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

const normaliseContentType = (value: string): string => value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

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

export const issueUploadCapability = async (input: {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly projectKey: string;
  readonly media: UploadMediaMetadata;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly receiptExpiresAtMs: number;
  readonly settings: Pick<WorkerSettings, "keyRing">;
}): Promise<string> => signOpaqueToken<UploadCapabilityClaims>({
  type: "upload-capability",
  sessionId: input.sessionId,
  sessionKey: input.sessionKey,
  operationId: input.operationId,
  operationKey: input.operationKey,
  projectKey: input.projectKey,
  objectKey: `processing/${input.sessionKey}/${input.operationKey}`,
  media: input.media,
  issuedAtMs: input.nowMs,
  expiresAtMs: input.expiresAtMs,
  receiptExpiresAtMs: input.receiptExpiresAtMs,
}, input.settings.keyRing);

export const verifyUploadCapability = (token: string, settings: Pick<WorkerSettings, "keyRing">, nowMs: number): Promise<UploadCapabilityClaims> => verifyOpaqueToken<UploadCapabilityClaims>(
  token,
  settings.keyRing,
  nowMs,
  "upload-capability",
);

export const issueUploadReceipt = (capability: UploadCapabilityClaims, settings: Pick<WorkerSettings, "keyRing">): Promise<string> => signOpaqueToken<UploadReceiptClaims>({
  ...capability,
  type: "upload-receipt",
  expiresAtMs: capability.receiptExpiresAtMs,
}, settings.keyRing);

export const verifyUploadReceipt = (token: string, settings: Pick<WorkerSettings, "keyRing">, nowMs: number): Promise<UploadReceiptClaims> => verifyOpaqueToken<UploadReceiptClaims>(
  token,
  settings.keyRing,
  nowMs,
  "upload-receipt",
);

/** Reads media into a bounded request-local buffer so a failed byte check cannot create an R2 object. */
export const readExactUploadBody = async (request: Request, expectedByteLength: number, maximumByteLength: number): Promise<ArrayBuffer> => {
  if (request.body === null) throw new UploadValidationError("BODY_SIZE", "CueBench did not receive the selected media bytes.");
  const body = await request.arrayBuffer();
  if (body.byteLength > maximumByteLength || body.byteLength !== expectedByteLength) {
    throw new UploadValidationError("BODY_SIZE", "CueBench could not verify the uploaded media size. No processing copy was stored.");
  }
  return body;
};

export const privateObjectMetadata = (claims: Pick<UploadCapabilityClaims, "operationKey" | "sessionKey">): Readonly<Record<string, string>> => ({
  operation: claims.operationKey,
  owner: claims.sessionKey,
});

export const isAuthoritativePrivateObject = (object: StoredPrivateObject | null, claims: Pick<UploadCapabilityClaims, "media" | "operationKey" | "sessionKey">): boolean => object !== null
  && object.byteLength === claims.media.byteLength
  && normaliseContentType(object.contentType) === claims.media.contentType
  && object.customMetadata.operation === claims.operationKey
  && object.customMetadata.owner === claims.sessionKey;

export class R2PrivateObjectStore implements PrivateObjectStore {
  public constructor(private readonly bucket: R2Bucket) {}

  public async put(key: string, body: ArrayBuffer, options: { readonly contentType: string; readonly customMetadata: Readonly<Record<string, string>> }): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: { ...options.customMetadata },
    });
  }

  public async head(key: string): Promise<StoredPrivateObject | null> {
    const object = await this.bucket.head(key);
    if (object === null) return null;
    return {
      byteLength: object.size,
      contentType: object.httpMetadata?.contentType ?? "",
      customMetadata: object.customMetadata ?? {},
    };
  }

  public delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}
