/** Minimal signed, opaque capability primitives shared by anonymous sessions and upload receipts. */

export interface HmacKey {
  readonly id: string;
  readonly secret: string;
}

export interface HmacKeyRing {
  readonly current: HmacKey;
  readonly previous?: HmacKey;
}

export interface SignedTokenFields {
  readonly type: string;
  readonly version: 1;
  readonly keyId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AnonymousSessionClaims extends SignedTokenFields {
  readonly type: "anonymous-session";
  readonly sessionId: string;
  /** Cleanup-only sessions can remove an existing private copy but cannot start work. */
  readonly purpose?: "upload" | "cleanup";
}

export class SignedTokenError extends Error {
  public constructor(
    public readonly code: "malformed" | "signature" | "expired" | "type",
    message: string,
  ) {
    super(message);
    this.name = "SignedTokenError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (value: Uint8Array): string => btoa(String.fromCharCode(...value))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(`${normalized}${padding}`), (character) => character.charCodeAt(0));
};

const subtle = (): SubtleCrypto => {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("CueBench requires Web Crypto for anonymous session signing.");
  }
  return globalThis.crypto.subtle;
};

const importHmacKey = (secret: string): Promise<CryptoKey> => subtle().importKey(
  "raw",
  encoder.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

const sign = async (value: string, key: HmacKey): Promise<string> => toBase64Url(new Uint8Array(await subtle().sign(
  "HMAC",
  await importHmacKey(key.secret),
  encoder.encode(value),
)));

const parseFields = (value: unknown): SignedTokenFields | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Readonly<Record<string, unknown>>;
  if (
    typeof fields.type !== "string"
    || fields.version !== 1
    || typeof fields.keyId !== "string"
    || !Number.isFinite(fields.issuedAtMs)
    || !Number.isFinite(fields.expiresAtMs)
  ) return null;
  return fields as unknown as SignedTokenFields;
};

/** Signs a compact, integrity-protected opaque token with the currently active HMAC key. */
export const signOpaqueToken = async <Claims extends SignedTokenFields>(
  fields: Omit<Claims, "version" | "keyId">,
  keyRing: HmacKeyRing,
): Promise<string> => {
  const payload = JSON.stringify({ ...fields, version: 1, keyId: keyRing.current.id });
  const encoded = toBase64Url(encoder.encode(payload));
  return `${encoded}.${await sign(encoded, keyRing.current)}`;
};

/** Verifies the current key and, during rotation, exactly one previous key. */
export const verifyOpaqueToken = async <Claims extends SignedTokenFields>(
  token: string,
  keyRing: HmacKeyRing,
  nowMs: number,
  expectedType: Claims["type"],
): Promise<Claims> => {
  const [encoded, signature, ...remainder] = token.split(".");
  if (encoded === undefined || signature === undefined || remainder.length > 0) {
    throw new SignedTokenError("malformed", "CueBench could not read the signed capability.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(encoded)));
  } catch {
    throw new SignedTokenError("malformed", "CueBench could not read the signed capability.");
  }
  const fields = parseFields(parsed);
  if (fields === null) throw new SignedTokenError("malformed", "CueBench received an incomplete signed capability.");
  if (fields.type !== expectedType) throw new SignedTokenError("type", "CueBench received a capability for a different operation.");
  const key = fields.keyId === keyRing.current.id
    ? keyRing.current
    : fields.keyId === keyRing.previous?.id
      ? keyRing.previous
      : undefined;
  if (key === undefined) throw new SignedTokenError("signature", "CueBench cannot verify this signed capability.");

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    throw new SignedTokenError("malformed", "CueBench could not read the signed capability.");
  }
  // `Uint8Array.from` owns an ArrayBuffer, which satisfies both browser and Worker Web Crypto typings.
  const valid = await subtle().verify("HMAC", await importHmacKey(key.secret), Uint8Array.from(signatureBytes), encoder.encode(encoded));
  if (!valid) throw new SignedTokenError("signature", "CueBench cannot verify this signed capability.");
  // Expiry is reported only after integrity verification. An unsigned string
  // must never obtain even a lifecycle hint such as UPLOAD_EXPIRED.
  if (fields.expiresAtMs <= nowMs || fields.issuedAtMs > fields.expiresAtMs) {
    throw new SignedTokenError("expired", "This signed CueBench capability has expired. Start again to receive a fresh one.");
  }
  return parsed as Claims;
};

export const issueAnonymousSession = async (input: {
  readonly sessionId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly purpose?: "upload" | "cleanup";
  readonly keyRing: HmacKeyRing;
}): Promise<string> => signOpaqueToken<AnonymousSessionClaims>(
  {
    type: "anonymous-session",
    sessionId: input.sessionId,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
  },
  input.keyRing,
);

export const verifyAnonymousSession = async (token: string, keyRing: HmacKeyRing, nowMs: number): Promise<AnonymousSessionClaims> => {
  const claims = await verifyOpaqueToken<AnonymousSessionClaims>(token, keyRing, nowMs, "anonymous-session");
  if (claims.purpose !== undefined && claims.purpose !== "upload" && claims.purpose !== "cleanup") {
    throw new SignedTokenError("malformed", "CueBench received an anonymous session with an invalid scope.");
  }
  return claims;
};
