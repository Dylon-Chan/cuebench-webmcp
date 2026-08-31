/** The bounded WAV contract used by hosted TTS and the browser cache gate. */
export const MAX_NARRATION_WAV_BYTES = 4 * 1024 * 1024;
const MAX_NARRATION_DURATION_MS = 60_000;
const decoder = new TextDecoder();

const validDuration = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= MAX_NARRATION_DURATION_MS;

/**
 * Validates a RIFF/WAVE PCM or IEEE-float payload and calculates duration from
 * its byte rate. This is deliberately stricter than trusting a MIME type or
 * an HTTP duration header before the browser puts a preview Blob in IndexedDB.
 */
export const wavDurationMs = (bytes: Uint8Array): number | null => {
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_NARRATION_WAV_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (offset: number): string => decoder.decode(bytes.subarray(offset, offset + 4));
  if (label(0) !== "RIFF" || label(8) !== "WAVE") return null;
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunk = label(offset);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const padded = size + (size % 2);
    if (size > bytes.byteLength - dataOffset || padded > bytes.byteLength - dataOffset) return null;
    if (chunk === "fmt ") {
      if (size < 16) return null;
      const encoding = view.getUint16(dataOffset, true);
      const channels = view.getUint16(dataOffset + 2, true);
      const sampleRate = view.getUint32(dataOffset + 4, true);
      const candidateByteRate = view.getUint32(dataOffset + 8, true);
      const blockAlign = view.getUint16(dataOffset + 12, true);
      const bitsPerSample = view.getUint16(dataOffset + 14, true);
      if (
        (encoding !== 1 && encoding !== 3)
        || channels < 1 || channels > 8
        || sampleRate < 8_000 || sampleRate > 192_000
        || candidateByteRate <= 0
        || blockAlign <= 0
        || bitsPerSample < 8 || bitsPerSample > 32
        || candidateByteRate !== sampleRate * blockAlign
      ) return null;
      byteRate = candidateByteRate;
    } else if (chunk === "data") {
      dataBytes = size;
    }
    offset = dataOffset + padded;
  }
  if (byteRate === null || dataBytes === null || dataBytes === 0) return null;
  const durationMs = Math.round((dataBytes * 1_000) / byteRate);
  return validDuration(durationMs) ? durationMs : null;
};

export const measureNarrationWavBlob = async (blob: Blob): Promise<number> => {
  if (blob.type.trim().toLowerCase() !== "audio/wav") throw new Error("CueBench only caches validated WAV narration previews.");
  const durationMs = wavDurationMs(new Uint8Array(await blob.arrayBuffer()));
  if (durationMs === null) throw new Error("CueBench could not validate the narration preview WAV duration.");
  return durationMs;
};
