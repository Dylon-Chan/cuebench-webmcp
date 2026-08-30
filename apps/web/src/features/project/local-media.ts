import { saveSourceMedia, type CueBenchDatabase } from "@cuebench/storage";

export const MAX_LOCAL_MEDIA_BYTES = 500 * 1024 * 1024;
export const MAX_LOCAL_MEDIA_DURATION_MS = 15 * 60 * 1_000;

export type LocalMediaErrorCode =
  | "unsupported-media"
  | "file-too-large"
  | "duration-unavailable"
  | "duration-too-long"
  | "object-url-unavailable";

export class LocalMediaError extends Error {
  public constructor(
    public readonly code: LocalMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalMediaError";
  }
}

export type MediaDurationProbe = (file: File) => Promise<number>;

export interface ObjectUrlApi {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const browserObjectUrlApi = (): ObjectUrlApi => {
  if (typeof URL.createObjectURL !== "function" || typeof URL.revokeObjectURL !== "function") {
    throw new LocalMediaError("object-url-unavailable", "This browser cannot safely preview local media.");
  }
  return URL;
};

/** Keeps only the active media preview address alive. */
export class ObjectUrlLease {
  private currentUrl: string | null = null;

  public constructor(private readonly api: ObjectUrlApi = browserObjectUrlApi()) {}

  public replace(blob: Blob): string {
    this.revoke();
    const nextUrl = this.api.createObjectURL(blob);
    this.currentUrl = nextUrl;
    return nextUrl;
  }

  public revoke(): void {
    if (this.currentUrl === null) return;
    this.api.revokeObjectURL(this.currentUrl);
    this.currentUrl = null;
  }

  /** Avoid revoking a newer URL after a stale asynchronous persistence continuation. */
  public revokeIfCurrent(url: string): void {
    if (this.currentUrl !== url) return;
    this.revoke();
  }
}

const isVideoFile = (file: File): boolean => file.type.length === 0 || file.type.startsWith("video/");

const asDurationMs = (durationMs: number): number => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new LocalMediaError("duration-unavailable", "CueBench could not read this video’s duration.");
  }
  if (durationMs > MAX_LOCAL_MEDIA_DURATION_MS) {
    throw new LocalMediaError("duration-too-long", "CueBench supports videos up to 15 minutes long.");
  }
  return Math.round(durationMs);
};

export interface InspectedLocalMedia {
  readonly durationMs: number;
}

/** Checks browser-enforceable limits before the Blob enters persistent storage. */
export const inspectLocalMedia = async (
  file: File,
  probeDuration: MediaDurationProbe,
): Promise<InspectedLocalMedia> => {
  if (!isVideoFile(file)) {
    throw new LocalMediaError("unsupported-media", "Choose a supported video file.");
  }
  if (file.size > MAX_LOCAL_MEDIA_BYTES) {
    throw new LocalMediaError("file-too-large", "CueBench supports videos up to 500 MB.");
  }
  return { durationMs: asDurationMs(await probeDuration(file)) };
};

/** Uses metadata only and immediately releases the temporary probing URL. */
export const probeVideoDuration: MediaDurationProbe = async (file) => new Promise((resolve, reject) => {
  if (typeof document === "undefined") {
    reject(new LocalMediaError("duration-unavailable", "Video metadata is unavailable outside a browser."));
    return;
  }
  let probeUrl: string;
  try {
    probeUrl = browserObjectUrlApi().createObjectURL(file);
  } catch (error) {
    reject(error);
    return;
  }
  const video = document.createElement("video");
  const clear = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(probeUrl);
  };
  video.preload = "metadata";
  video.onloadedmetadata = () => {
    const durationMs = video.duration * 1_000;
    clear();
    resolve(durationMs);
  };
  video.onerror = () => {
    clear();
    reject(new LocalMediaError("duration-unavailable", "CueBench could not read this video’s duration."));
  };
  video.src = probeUrl;
});

export interface IngestLocalMediaInput {
  readonly database: CueBenchDatabase;
  readonly projectId: string;
  readonly sourceId: string;
  readonly file: File;
  readonly probeDuration: MediaDurationProbe;
  readonly urlLease?: ObjectUrlLease;
}

export interface IngestedLocalMedia extends InspectedLocalMedia {
  readonly projectId: string;
  readonly sourceId: string;
  readonly sha256: string;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly contentType: string;
  readonly objectUrl: string | null;
}

/** Hashes a temporary in-memory source once, without creating an IndexedDB row. */
export const hashLocalMedia = async (blob: Blob): Promise<string> => {
  const crypto = globalThis.crypto;
  if (crypto?.subtle === undefined) throw new Error("Web Crypto SHA-256 is required for local media.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Hashes immutable source bytes, keeps the Blob in IndexedDB, and owns its preview URL. */
export const ingestLocalMedia = async ({
  database,
  projectId,
  sourceId,
  file,
  probeDuration,
  urlLease,
}: IngestLocalMediaInput): Promise<IngestedLocalMedia> => {
  const inspected = await inspectLocalMedia(file, probeDuration);
  const saved = await saveSourceMedia(database, projectId, {
    sourceId,
    blob: file,
    fileName: file.name,
    contentType: file.type,
  });
  return {
    ...inspected,
    projectId: saved.projectId,
    sourceId: saved.sourceId,
    sha256: saved.sha256,
    blob: saved.blob,
    byteLength: saved.byteLength,
    contentType: saved.contentType,
    objectUrl: urlLease === undefined ? null : urlLease.replace(file),
  };
};
