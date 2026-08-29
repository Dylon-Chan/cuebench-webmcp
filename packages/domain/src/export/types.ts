import type {
  AudioDescriptionTrack,
  CaptionProject,
  CaptionTrack,
  ProjectCertification,
} from "../model";

export type ExportTrackKind = "Captions" | "AudioDescriptions";
export type CanonicalTrackFormat = "vtt" | "srt" | "ad-txt";
/** `ad-vtt` and `txt` are ergonomic aliases for callers at the UI boundary. */
export type TrackFormat = CanonicalTrackFormat | "ad-vtt" | "ad-text" | "txt";

export interface ExportCaptionItem {
  readonly kind: "CaptionCue";
  readonly itemId: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string | null;
}

export interface ExportAudioDescriptionItem {
  readonly kind: "AudioDescriptionBeat";
  readonly itemId: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export type ExportTrackItem = ExportCaptionItem | ExportAudioDescriptionItem;

/** A compact, format-neutral projection used for export and round-trip checks. */
export interface NormalizedTrack {
  readonly kind: ExportTrackKind;
  readonly items: readonly ExportTrackItem[];
}

export interface TrackCapabilities {
  readonly trackIdentity: boolean;
  readonly itemIdentity: boolean;
  readonly speaker: boolean;
}

export type UnsupportedMetadataField = "speaker" | "itemId" | "cueSettings" | "styling" | "header";

export interface UnsupportedTrackMetadata {
  readonly field: UnsupportedMetadataField;
  readonly message: string;
}

export interface ParsedTrack extends NormalizedTrack {
  readonly format: CanonicalTrackFormat;
  readonly capabilities: TrackCapabilities;
  readonly unsupportedMetadata: readonly UnsupportedTrackMetadata[];
}

export interface SerializeTrackOptions {
  /** Required only when the source contains both tracks, such as a project. */
  readonly trackKind?: ExportTrackKind;
}

/**
 * WebVTT has no portable field for distinguishing a caption track from an
 * audio-description track. Callers therefore supply that identity out of
 * band when parsing an AD VTT export.
 */
export interface ParseTrackOptions {
  readonly trackKind?: ExportTrackKind;
}

export type TrackExportSource =
  | CaptionTrack
  | AudioDescriptionTrack
  | CaptionProject
  | ProjectCertification
  | NormalizedTrack;

export class TrackSerializationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TrackSerializationError";
  }
}

export class TrackParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TrackParseError";
  }
}

/** A strict parser found metadata that this portable Core format does not preserve. */
export class UnsupportedTrackMetadataError extends TrackParseError {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedTrackMetadataError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTrackKind = (value: unknown): value is ExportTrackKind =>
  value === "Captions" || value === "AudioDescriptions";

const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n");

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || normalizeLineEndings(value).trim().length === 0) {
    throw new TrackSerializationError(`${label} must contain non-whitespace text.`);
  }
  return normalizeLineEndings(value);
};

const requireItemId = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TrackSerializationError("Track item ids must be non-empty single-line strings.");
  }
  return value;
};

const requireTiming = (startMs: unknown, endMs: unknown): { readonly startMs: number; readonly endMs: number } => {
  if (
    typeof startMs !== "number"
    || typeof endMs !== "number"
    || !Number.isSafeInteger(startMs)
    || !Number.isSafeInteger(endMs)
    || startMs < 0
    || endMs <= startMs
  ) throw new TrackSerializationError("Track times must be canonical non-negative integer milliseconds.");
  return { startMs, endMs };
};

const normalizedCaption = (item: Readonly<Record<string, unknown>>): ExportCaptionItem => {
  const { startMs, endMs } = requireTiming(item.startMs, item.endMs);
  const speaker = item.speaker;
  if (speaker !== null && speaker !== undefined && (typeof speaker !== "string" || speaker.trim().length === 0 || /[\r\n]/.test(speaker))) {
    throw new TrackSerializationError("Caption speakers must be non-empty single-line strings or null.");
  }
  return {
    kind: "CaptionCue",
    itemId: requireItemId(item.itemId),
    startMs,
    endMs,
    text: requireText(item.text, "Caption text"),
    speaker: speaker ?? null,
  };
};

const normalizedAudioDescription = (item: Readonly<Record<string, unknown>>): ExportAudioDescriptionItem => {
  const { startMs, endMs } = requireTiming(item.startMs, item.endMs);
  const description = typeof item.description === "string" ? item.description : item.text;
  return {
    kind: "AudioDescriptionBeat",
    itemId: requireItemId(item.itemId),
    startMs,
    endMs,
    text: requireText(description, "Audio-description text"),
  };
};

const normalizedItem = (kind: ExportTrackKind, value: unknown): ExportTrackItem => {
  if (!isRecord(value)) throw new TrackSerializationError("Track items must be objects.");
  return kind === "Captions" ? normalizedCaption(value) : normalizedAudioDescription(value);
};

const orderedDomainTrack = (source: CaptionTrack | AudioDescriptionTrack): NormalizedTrack => {
  const seen = new Set<string>();
  const items: ExportTrackItem[] = [];
  for (const itemId of source.order) {
    if (seen.has(itemId)) throw new TrackSerializationError("Track order contains duplicate item ids.");
    seen.add(itemId);
    if (source.kind === "Captions") {
      const item = (source as CaptionTrack).items[itemId];
      if (item === undefined) throw new TrackSerializationError(`Track order references missing item ${itemId}.`);
      if (item.mergedIntoItemId !== null) continue;
      items.push(normalizedCaption({
        itemId: item.itemId,
        startMs: item.current.startMs,
        endMs: item.current.endMs,
        text: item.current.text,
        speaker: item.current.speaker,
      }));
    } else {
      const item = (source as AudioDescriptionTrack).items[itemId];
      if (item === undefined) throw new TrackSerializationError(`Track order references missing item ${itemId}.`);
      items.push(normalizedAudioDescription({
        itemId: item.itemId,
        startMs: item.current.startMs,
        endMs: item.current.endMs,
        description: item.current.description,
      }));
    }
  }
  return { kind: source.kind, items };
};

const normalizedSnapshotTrack = (
  certification: ProjectCertification,
  kind: ExportTrackKind,
): NormalizedTrack => {
  const input = certification.validationRun.input;
  const rawItems = kind === "Captions" ? input.captions.items : input.audioDescriptions.items;
  const byId = new Map(rawItems.map((item) => [item.itemId, item]));
  const order = kind === "Captions" ? input.captions.order : input.audioDescriptions.order;
  const seen = new Set<string>();
  const items: ExportTrackItem[] = [];
  for (const itemId of order) {
    if (seen.has(itemId)) throw new TrackSerializationError("Certification track order contains duplicate item ids.");
    seen.add(itemId);
    const item = byId.get(itemId);
    if (item === undefined) throw new TrackSerializationError(`Certification track order references missing item ${itemId}.`);
    if (kind === "Captions") {
      if (item.kind !== "CaptionCue" || item.mergedIntoItemId !== null && item.mergedIntoItemId !== undefined) continue;
      items.push(normalizedCaption({
        itemId: item.itemId,
        startMs: item.startMs,
        endMs: item.endMs,
        text: item.text,
        speaker: item.speaker,
      }));
    } else {
      if (item.kind !== "AudioDescriptionBeat") throw new TrackSerializationError("Certification AD track contains a caption item.");
      items.push(normalizedAudioDescription({
        itemId: item.itemId,
        startMs: item.startMs,
        endMs: item.endMs,
        text: item.text,
      }));
    }
  }
  return { kind, items };
};

const normalizedCompactTrack = (source: Readonly<Record<string, unknown>>): NormalizedTrack => {
  const kind = source.kind;
  if (!isTrackKind(kind) || !Array.isArray(source.items)) {
    throw new TrackSerializationError("A compact export track needs a kind and item array.");
  }
  return { kind, items: source.items.map((item) => normalizedItem(kind, item)) };
};

export const canonicalTrackFormat = (format: TrackFormat): CanonicalTrackFormat => {
  if (format === "ad-vtt") return "vtt";
  if (format === "txt" || format === "ad-text") return "ad-txt";
  return format;
};

export const normalizeExportTrack = (
  source: TrackExportSource,
  trackKind?: ExportTrackKind,
): NormalizedTrack => {
  const value = source as unknown;
  if (!isRecord(value)) throw new TrackSerializationError("Export source must be a track, project, or certification snapshot.");
  if (isTrackKind(value.kind) && isRecord(value.items) && Array.isArray(value.order)) {
    return orderedDomainTrack(source as CaptionTrack | AudioDescriptionTrack);
  }
  if (isTrackKind(value.kind) && Array.isArray(value.items)) return normalizedCompactTrack(value);
  if (isRecord(value.captions) && isRecord(value.audioDescriptions)) {
    if (trackKind === undefined) throw new TrackSerializationError("Exporting a project requires an explicit track kind.");
    return normalizeExportTrack(trackKind === "Captions"
      ? (value.captions as unknown as CaptionTrack)
      : (value.audioDescriptions as unknown as AudioDescriptionTrack));
  }
  if (typeof value.certificationId === "string" && isRecord(value.validationRun)) {
    if (trackKind === undefined) throw new TrackSerializationError("Exporting a certification requires an explicit track kind.");
    return normalizedSnapshotTrack(source as ProjectCertification, trackKind);
  }
  throw new TrackSerializationError("Unsupported export source.");
};

export const normalizedLineEndings = normalizeLineEndings;

export const assertCanonicalTimestamp = (milliseconds: number): number => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TrackSerializationError("Timestamps must be non-negative safe integer milliseconds.");
  }
  return milliseconds;
};

const escapeMarkup = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const unescapeMarkup = (value: string): string => {
  if (/&(?!amp;|lt;|gt;)/.test(value)) {
    throw new UnsupportedTrackMetadataError("Only escaped ampersand, less-than, and greater-than text is supported.");
  }
  return value.replace(/&(amp|lt|gt);/g, (_all, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!);
};

/**
 * VTT and SRT use blank lines as cue delimiters. Rather than introduce a
 * private sentinel (which would alter what standards-compliant players show),
 * reject an otherwise unrepresentable blank payload line. Every accepted
 * payload is literal/reversible: backslashes retain their original meaning.
 */
export const escapeTimedText = (value: string): string => {
  const lines = normalizedLineEndings(value).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new TrackSerializationError("VTT and SRT cannot represent blank lines inside one cue payload.");
  }
  return lines.map(escapeMarkup).join("\n");
};

export const unescapeTimedText = (value: string): string => {
  const lines = normalizedLineEndings(value).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new TrackParseError("VTT and SRT cue payloads cannot contain blank lines.");
  }
  return lines
  .map((line) => {
    if (/[<>]/.test(line)) {
      throw new UnsupportedTrackMetadataError("Raw timed-text markup is unsupported; literal markup must be escaped.");
    }
    return unescapeMarkup(line);
  })
  .join("\n");
};

export const escapeVoiceAnnotation = (speaker: string): string => {
  if (speaker.trim().length === 0 || /[\r\n]/.test(speaker)) {
    throw new TrackSerializationError("VTT voice annotations must be non-empty and single-line.");
  }
  return escapeMarkup(speaker);
};

export const unescapeVoiceAnnotation = (speaker: string): string => {
  if (/[<>\r\n]/.test(speaker)) throw new UnsupportedTrackMetadataError("VTT voice annotation markup is unsupported.");
  const result = unescapeMarkup(speaker);
  if (result.trim().length === 0) throw new TrackParseError("VTT voice annotation must not be blank.");
  return result;
};

export const parsedTrack = (
  kind: ExportTrackKind,
  items: readonly ExportTrackItem[],
  format: CanonicalTrackFormat,
  capabilities: TrackCapabilities,
  unsupportedMetadata: readonly UnsupportedTrackMetadata[] = [],
): ParsedTrack => ({ kind, items, format, capabilities, unsupportedMetadata });
