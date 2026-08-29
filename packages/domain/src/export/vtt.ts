import {
  assertCanonicalTimestamp,
  escapeTimedText,
  escapeVoiceAnnotation,
  normalizeExportTrack,
  parsedTrack,
  type ExportTrackItem,
  type ParsedTrack,
  type ParseTrackOptions,
  type TrackExportSource,
  type SerializeTrackOptions,
  TrackParseError,
  TrackSerializationError,
  UnsupportedTrackMetadataError,
  unescapeTimedText,
  unescapeVoiceAnnotation,
} from "./types";

const VTT_TIMESTAMP = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;
const VTT_TIMING = /^(\d{2,}:[0-5]\d:[0-5]\d\.\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d\.\d{3})$/;

export const formatVttTimestamp = (milliseconds: number): string => {
  const value = assertCanonicalTimestamp(milliseconds);
  const hours = Math.floor(value / 3_600_000);
  const afterHours = value % 3_600_000;
  const minutes = Math.floor(afterHours / 60_000);
  const afterMinutes = afterHours % 60_000;
  const seconds = Math.floor(afterMinutes / 1_000);
  const ms = afterMinutes % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
};

export const parseVttTimestamp = (value: string): number => {
  const match = VTT_TIMESTAMP.exec(value);
  if (match === null) throw new TrackParseError(`Invalid canonical VTT timestamp ${JSON.stringify(value)}.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  const total = (((hours * 60) + minutes) * 60 + seconds) * 1_000 + milliseconds;
  if (!Number.isSafeInteger(total)) throw new TrackParseError("VTT timestamp exceeds canonical integer-millisecond range.");
  return total;
};

const cueText = (item: ExportTrackItem): string => {
  const text = escapeTimedText(item.text);
  if (item.kind === "CaptionCue" && item.speaker !== null) {
    return `<v ${escapeVoiceAnnotation(item.speaker)}>${text}</v>`;
  }
  return text;
};

const cueId = (item: ExportTrackItem, index: number): string => {
  const identity = item.itemId ?? `cue-${index + 1}`;
  if (/\r|\n|-->/.test(identity)) throw new TrackSerializationError("VTT cue ids cannot contain line breaks or timing arrows.");
  return identity;
};

export const serializeVttTrack = (
  source: TrackExportSource,
  options: SerializeTrackOptions = {},
): string => {
  const track = normalizeExportTrack(source, options.trackKind);
  const cues = track.items.map((item, index) => [
    cueId(item, index),
    `${formatVttTimestamp(item.startMs)} --> ${formatVttTimestamp(item.endMs)}`,
    cueText(item),
  ].join("\n"));
  /** The required blank line after WEBVTT is deliberately literal. */
  return cues.length === 0 ? "WEBVTT\n\n" : `WEBVTT\n\n${cues.join("\n\n")}\n`;
};

interface ParsedVttCueText {
  readonly text: string;
  readonly speaker: string | null;
}

const parseVttCueText = (kind: "Captions" | "AudioDescriptions", payload: string): ParsedVttCueText => {
  if (kind === "AudioDescriptions") {
    if (/<\/?v(?:\s|>)/.test(payload)) {
      throw new UnsupportedTrackMetadataError("Audio-description VTT cannot contain a speaker voice annotation.");
    }
    return { text: unescapeTimedText(payload), speaker: null };
  }
  const voice = /^<v ([^>\r\n]+)>([\s\S]*)<\/v>$/.exec(payload);
  if (voice !== null) {
    return { text: unescapeTimedText(voice[2] ?? ""), speaker: unescapeVoiceAnnotation(voice[1] ?? "") };
  }
  if (/<\/?v(?:\s|>)/.test(payload)) {
    throw new UnsupportedTrackMetadataError("Only one complete VTT voice annotation is supported.");
  }
  return { text: unescapeTimedText(payload), speaker: null };
};

const parseHeader = (
  source: string,
  options: ParseTrackOptions,
): { readonly lines: readonly string[]; readonly kind: "Captions" | "AudioDescriptions"; readonly cursor: number } => {
  const normalized = source.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("WEBVTT\n\n")) {
    throw new TrackParseError("A strict CueBench VTT must begin with WEBVTT followed immediately by one blank line.");
  }
  const kind = options.trackKind ?? "Captions";
  if (kind !== "Captions" && kind !== "AudioDescriptions") {
    throw new TrackParseError("VTT track identity must be Captions or AudioDescriptions when supplied by the caller.");
  }
  return { lines: normalized.split("\n"), kind, cursor: 2 };
};

export const parseVttTrack = (source: string, options: ParseTrackOptions = {}): ParsedTrack => {
  const header = parseHeader(source, options);
  const lines = header.lines;
  let cursor = header.cursor;
  const identities = new Set<string>();
  const items: ExportTrackItem[] = [];
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor] === "") cursor += 1;
    if (cursor >= lines.length) break;
    const first = lines[cursor]!;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(first)) {
      throw new UnsupportedTrackMetadataError(`Unsupported VTT metadata block ${first.split(/\s/, 1)[0] ?? ""}.`);
    }
    let itemId: string | null = null;
    let timing = first;
    if (!VTT_TIMING.test(timing)) {
      itemId = first;
      if (itemId.length === 0 || /-->/.test(itemId) || identities.has(itemId)) {
        throw new TrackParseError("VTT cue ids must be unique and cannot contain timing arrows.");
      }
      identities.add(itemId);
      cursor += 1;
      timing = lines[cursor] ?? "";
    }
    const timingMatch = VTT_TIMING.exec(timing);
    if (timingMatch === null) {
      if (/ --> .*\s+\S/.test(timing)) {
        throw new UnsupportedTrackMetadataError("VTT cue settings are unsupported by CueBench Core.");
      }
      throw new TrackParseError("VTT cue timing must use canonical dot-millisecond timestamps and no settings.");
    }
    cursor += 1;
    const payload: string[] = [];
    while (cursor < lines.length && lines[cursor] !== "") {
      payload.push(lines[cursor]!);
      cursor += 1;
    }
    if (payload.length === 0) throw new TrackParseError("VTT cues must contain text.");
    const text = parseVttCueText(header.kind, payload.join("\n"));
    const startMs = parseVttTimestamp(timingMatch[1] ?? "");
    const endMs = parseVttTimestamp(timingMatch[2] ?? "");
    if (endMs <= startMs) throw new TrackParseError("VTT cue end time must be after its start time.");
    if (header.kind === "Captions") {
      items.push({
        kind: "CaptionCue",
        itemId,
        startMs,
        endMs,
        text: text.text,
        speaker: text.speaker,
      });
    } else {
      items.push({ kind: "AudioDescriptionBeat", itemId, startMs, endMs, text: text.text });
    }
  }
  return parsedTrack(header.kind, items, "vtt", {
    trackIdentity: options.trackKind !== undefined,
    itemIdentity: true,
    speaker: header.kind === "Captions",
  });
};
