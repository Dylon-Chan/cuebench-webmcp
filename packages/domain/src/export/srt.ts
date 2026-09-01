import {
  assertCanonicalTimestamp,
  escapeTimedText,
  normalizeExportTrack,
  parsedTrack,
  type ExportTrackItem,
  type ParsedTrack,
  type TrackExportSource,
  type SerializeTrackOptions,
  TrackParseError,
  TrackSerializationError,
  unescapeTimedText,
} from "./types";

const SRT_TIMESTAMP = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/;
const SRT_TIMING = /^(\d{2,}:[0-5]\d:[0-5]\d,\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d,\d{3})$/;

export const formatSrtTimestamp = (milliseconds: number): string => {
  const value = assertCanonicalTimestamp(milliseconds);
  const hours = Math.floor(value / 3_600_000);
  const afterHours = value % 3_600_000;
  const minutes = Math.floor(afterHours / 60_000);
  const afterMinutes = afterHours % 60_000;
  const seconds = Math.floor(afterMinutes / 1_000);
  const ms = afterMinutes % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};

export const parseSrtTimestamp = (value: string): number => {
  const match = SRT_TIMESTAMP.exec(value);
  if (match === null) throw new TrackParseError(`Invalid canonical SRT timestamp ${JSON.stringify(value)}.`);
  const total = (((Number(match[1]) * 60) + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
  if (!Number.isSafeInteger(total)) throw new TrackParseError("SRT timestamp exceeds canonical integer-millisecond range.");
  return total;
};

export const serializeSrtTrack = (
  source: TrackExportSource,
  options: SerializeTrackOptions = {},
): string => {
  const track = normalizeExportTrack(source, options.trackKind);
  if (track.kind !== "Captions") {
    throw new TrackSerializationError("SRT is only supported for caption tracks; use VTT or AD TXT for audio descriptions.");
  }
  const cues = track.items.map((item, index) => {
    if (item.kind !== "CaptionCue") throw new TrackSerializationError("SRT cannot serialize an audio-description item.");
    return [
      String(index + 1),
      `${formatSrtTimestamp(item.startMs)} --> ${formatSrtTimestamp(item.endMs)}`,
      escapeTimedText(item.text),
    ].join("\n");
  }).join("\n\n");
  return cues.length === 0 ? "" : `${cues}\n`;
};

export const parseSrtTrack = (source: string): ParsedTrack => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const items: ExportTrackItem[] = [];
  let cursor = 0;
  let expectedIndex = 1;
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor] === "") cursor += 1;
    if (cursor >= lines.length) break;
    if (lines[cursor] !== String(expectedIndex)) {
      throw new TrackParseError(`SRT cue indexes must be contiguous and start at 1; expected ${expectedIndex}.`);
    }
    cursor += 1;
    const timing = lines[cursor] ?? "";
    const match = SRT_TIMING.exec(timing);
    if (match === null) {
      if (/\.\d{3}/.test(timing)) throw new TrackParseError("SRT timestamps must use a comma before milliseconds.");
      throw new TrackParseError("SRT cue timing must use canonical comma-millisecond timestamps.");
    }
    cursor += 1;
    const payload: string[] = [];
    while (cursor < lines.length && lines[cursor] !== "") {
      payload.push(lines[cursor]!);
      cursor += 1;
    }
    if (payload.length === 0) throw new TrackParseError("SRT cues must contain text.");
    const startMs = parseSrtTimestamp(match[1] ?? "");
    const endMs = parseSrtTimestamp(match[2] ?? "");
    if (endMs <= startMs) throw new TrackParseError("SRT cue end time must be after its start time.");
    items.push({
      kind: "CaptionCue",
      itemId: null,
      startMs,
      endMs,
      text: unescapeTimedText(payload.join("\n")),
      speaker: null,
    });
    expectedIndex += 1;
  }
  return parsedTrack("Captions", items, "srt", {
    trackIdentity: true,
    itemIdentity: false,
    speaker: false,
  }, [
    { field: "itemId", message: "SRT cue indexes are positional and do not preserve CueBench item ids." },
    { field: "speaker", message: "SRT does not have a portable speaker metadata field." },
  ]);
};
