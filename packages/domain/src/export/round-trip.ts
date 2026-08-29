import type { CaptionProject, ProjectCertification } from "../model";
import { domainError, type DomainError } from "../errors";
import { parseAdTextTrack, serializeAdTextTrack } from "./ad-text";
import { parseSrtTrack, serializeSrtTrack } from "./srt";
import {
  canonicalTrackFormat,
  normalizeExportTrack,
  type CanonicalTrackFormat,
  type ExportTrackKind,
  type ExportTrackItem,
  type NormalizedTrack,
  type ParsedTrack,
  type SerializeTrackOptions,
  type TrackExportSource,
  type TrackFormat,
  TrackSerializationError,
} from "./types";
import { parseVttTrack, serializeVttTrack } from "./vtt";

export type ExportDisposition = "draft" | "certified";

export interface RoundTripDifference {
  readonly index: number | null;
  readonly field: "trackIdentity" | "itemCount" | "itemId" | "startMs" | "endMs" | "text" | "speaker";
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface RoundTripSuccess {
  readonly ok: true;
}

export interface RoundTripMismatch {
  readonly ok: false;
  readonly error: DomainError;
  readonly firstDifference: RoundTripDifference;
}

export type RoundTripResult = RoundTripSuccess | RoundTripMismatch;

const mismatch = (difference: RoundTripDifference): RoundTripMismatch => ({
  ok: false,
  error: domainError(
    "EXPORT_ROUND_TRIP_MISMATCH",
    `Serialized track differs at ${difference.index === null ? "track" : `item ${difference.index + 1}`} field ${difference.field}.`,
  ),
  firstDifference: difference,
});

const compareItem = (
  expected: ExportTrackItem,
  actual: ExportTrackItem,
  index: number,
  parsed: ParsedTrack,
): RoundTripMismatch | undefined => {
  if (parsed.capabilities.itemIdentity && expected.itemId !== null && actual.itemId !== expected.itemId) {
    return mismatch({ index, field: "itemId", expected: expected.itemId, actual: actual.itemId });
  }
  if (actual.startMs !== expected.startMs) return mismatch({ index, field: "startMs", expected: expected.startMs, actual: actual.startMs });
  if (actual.endMs !== expected.endMs) return mismatch({ index, field: "endMs", expected: expected.endMs, actual: actual.endMs });
  if (actual.text !== expected.text) return mismatch({ index, field: "text", expected: expected.text, actual: actual.text });
  if (
    expected.kind === "CaptionCue"
    && actual.kind === "CaptionCue"
    && parsed.capabilities.speaker
    && actual.speaker !== expected.speaker
  ) return mismatch({ index, field: "speaker", expected: expected.speaker, actual: actual.speaker });
  return undefined;
};

/**
 * Compares only fields that the serialized format can carry. SRT intentionally
 * cannot carry CueBench item ids or portable speaker metadata; VTT and AD TXT
 * do carry their explicit identities.
 */
export const verifyRoundTrip = (
  source: TrackExportSource,
  parsed: ParsedTrack,
  options: SerializeTrackOptions = {},
): RoundTripResult => {
  const expected = normalizeExportTrack(source, options.trackKind);
  if (parsed.capabilities.trackIdentity && parsed.kind !== expected.kind) {
    return mismatch({ index: null, field: "trackIdentity", expected: expected.kind, actual: parsed.kind });
  }
  if (expected.items.length !== parsed.items.length) {
    return mismatch({ index: null, field: "itemCount", expected: expected.items.length, actual: parsed.items.length });
  }
  for (let index = 0; index < expected.items.length; index += 1) {
    const expectedItem = expected.items[index];
    const actualItem = parsed.items[index];
    if (expectedItem === undefined || actualItem === undefined) {
      return mismatch({ index, field: "itemCount", expected: expected.items.length, actual: parsed.items.length });
    }
    if (expectedItem.kind !== actualItem.kind) {
      return mismatch({ index, field: "trackIdentity", expected: expectedItem.kind, actual: actualItem.kind });
    }
    const result = compareItem(expectedItem, actualItem, index, parsed);
    if (result !== undefined) return result;
  }
  return { ok: true };
};

const extensionFor = (format: CanonicalTrackFormat): "vtt" | "srt" | "txt" =>
  format === "ad-txt" ? "txt" : format;

const slug = (title: string): string => {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return compact.length > 0 ? compact : "cuebench-track";
};

/** The file label is intentionally part of the filename, not only UI copy. */
export const buildTrackFilename = (
  title: string,
  format: TrackFormat,
  disposition: ExportDisposition,
): string => `${slug(title)}.${disposition}.${extensionFor(canonicalTrackFormat(format))}`;

/** Alias for UI callers that prefer the noun-first name. */
export const trackExportFilename = buildTrackFilename;

const serializeCanonicalTrack = (
  source: TrackExportSource,
  format: CanonicalTrackFormat,
  options: SerializeTrackOptions,
): string => {
  if (format === "vtt") return serializeVttTrack(source, options);
  if (format === "srt") return serializeSrtTrack(source, options);
  return serializeAdTextTrack(source, options);
};

export const serializeTrack = (
  source: TrackExportSource,
  format: TrackFormat,
  options: SerializeTrackOptions = {},
): string => serializeCanonicalTrack(source, canonicalTrackFormat(format), options);

export const parseTrack = (source: string, format: TrackFormat): ParsedTrack => {
  const canonical = canonicalTrackFormat(format);
  if (canonical === "vtt") return parseVttTrack(source);
  if (canonical === "srt") return parseSrtTrack(source);
  return parseAdTextTrack(source);
};

export interface ProjectTrackExportRequest {
  readonly project: CaptionProject;
  readonly trackKind: ExportTrackKind;
  readonly format: TrackFormat;
  readonly disposition: ExportDisposition;
}

export interface ProjectTrackExport {
  readonly filename: string;
  readonly text: string;
  readonly source: NormalizedTrack;
  readonly parsed: ParsedTrack;
  readonly roundTrip: RoundTripResult;
}

const certifiedSnapshot = (project: CaptionProject): ProjectCertification => {
  const pointer = project.certification;
  if (pointer.status !== "Current") {
    throw new TrackSerializationError("A certified export requires a current human certification.");
  }
  const certification = project.certifications.find((candidate) => candidate.certificationId === pointer.certificationId);
  if (certification === undefined) {
    throw new TrackSerializationError("The current certification snapshot is unavailable for export.");
  }
  return certification;
};

/**
 * Selects either the mutable draft or the immutable certification snapshot,
 * then verifies the exact serialized text before the caller creates a Blob or
 * object URL for download.
 */
export const prepareTrackExport = (request: ProjectTrackExportRequest): ProjectTrackExport => {
  const source: TrackExportSource = request.disposition === "draft"
    ? request.project
    : certifiedSnapshot(request.project);
  const options: SerializeTrackOptions = { trackKind: request.trackKind };
  const text = serializeTrack(source, request.format, options);
  const parsed = parseTrack(text, request.format);
  const roundTrip = verifyRoundTrip(source, parsed, options);
  if (!roundTrip.ok) {
    throw new TrackSerializationError(roundTrip.error.message);
  }
  return {
    filename: buildTrackFilename(request.project.title, request.format, request.disposition),
    text,
    source: normalizeExportTrack(source, request.trackKind),
    parsed,
    roundTrip,
  };
};
