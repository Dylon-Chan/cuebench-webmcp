import {
  escapeTimedText,
  normalizeExportTrack,
  parsedTrack,
  type ExportAudioDescriptionItem,
  type ExportTrackItem,
  type ParsedTrack,
  type TrackExportSource,
  type SerializeTrackOptions,
  TrackParseError,
  TrackSerializationError,
  unescapeTimedText,
} from "./types";
import { formatVttTimestamp, parseVttTimestamp } from "./vtt";

const AD_TIMING = /^(\d{2,}:[0-5]\d:[0-5]\d\.\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d\.\d{3})$/;

/** A deliberately small, strict timed AD script format with explicit track identity. */
export const serializeAdTextTrack = (
  source: TrackExportSource,
  options: SerializeTrackOptions = {},
): string => {
  const track = normalizeExportTrack(source, options.trackKind ?? "AudioDescriptions");
  if (track.kind !== "AudioDescriptions") {
    throw new TrackSerializationError("AD TXT is only supported for audio-description tracks.");
  }
  const cues = track.items.map((item, index) => {
    if (item.kind !== "AudioDescriptionBeat") throw new TrackSerializationError("AD TXT cannot serialize a caption item.");
    const itemId = item.itemId ?? `ad-${index + 1}`;
    if (/\r|\n|-->/.test(itemId)) throw new TrackSerializationError("AD TXT item ids cannot contain line breaks or timing arrows.");
    return [
      itemId,
      `${formatVttTimestamp(item.startMs)} --> ${formatVttTimestamp(item.endMs)}`,
      escapeTimedText(item.text),
    ].join("\n");
  });
  const header = ["CUEBENCH-AD-TEXT", "X-CUEBENCH-TRACK: AudioDescriptions"].join("\n");
  return cues.length === 0 ? `${header}\n\n` : `${header}\n\n${cues.join("\n\n")}\n`;
};

export const parseAdTextTrack = (source: string): ParsedTrack => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "") !== "CUEBENCH-AD-TEXT") {
    throw new TrackParseError("A strict AD TXT export must begin with CUEBENCH-AD-TEXT.");
  }
  if (lines[1] !== "X-CUEBENCH-TRACK: AudioDescriptions") {
    throw new TrackParseError("AD TXT must declare the AudioDescriptions track identity.");
  }
  if (lines.length > 2 && lines[2] !== "") throw new TrackParseError("AD TXT headers must be followed by one blank line.");
  const items: ExportTrackItem[] = [];
  const identities = new Set<string>();
  let cursor = 3;
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor] === "") cursor += 1;
    if (cursor >= lines.length) break;
    const itemId = lines[cursor]!;
    if (itemId.length === 0 || /-->/.test(itemId) || identities.has(itemId)) {
      throw new TrackParseError("AD TXT item ids must be unique and cannot contain timing arrows.");
    }
    identities.add(itemId);
    cursor += 1;
    const timing = lines[cursor] ?? "";
    const match = AD_TIMING.exec(timing);
    if (match === null) throw new TrackParseError("AD TXT timing must use canonical dot-millisecond timestamps.");
    cursor += 1;
    const payload: string[] = [];
    while (cursor < lines.length && lines[cursor] !== "") {
      payload.push(lines[cursor]!);
      cursor += 1;
    }
    if (payload.length === 0) throw new TrackParseError("AD TXT entries must contain a description.");
    const startMs = parseVttTimestamp(match[1] ?? "");
    const endMs = parseVttTimestamp(match[2] ?? "");
    if (endMs <= startMs) throw new TrackParseError("AD TXT entry end time must be after its start time.");
    const item: ExportAudioDescriptionItem = {
      kind: "AudioDescriptionBeat",
      itemId,
      startMs,
      endMs,
      text: unescapeTimedText(payload.join("\n")),
    };
    items.push(item);
  }
  return parsedTrack("AudioDescriptions", items, "ad-txt", {
    trackIdentity: true,
    itemIdentity: true,
    speaker: false,
  });
};
