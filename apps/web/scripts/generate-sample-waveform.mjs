import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { chromium } from "@playwright/test";

const samplePath = new URL("../public/sample/gibbs-free-energy.mp4", import.meta.url);
const checkedInOutputPath = new URL("../src/features/evidence/bundled-sample-waveform.json", import.meta.url);
const outputArgumentIndex = process.argv.indexOf("--output");
const outputPath = outputArgumentIndex === -1
  ? checkedInOutputPath
  : pathToFileURL(process.argv[outputArgumentIndex + 1]);
if (outputArgumentIndex !== -1 && process.argv[outputArgumentIndex + 1] === undefined) {
  throw new Error("--output requires a filesystem path.");
}

const sampleBytes = await readFile(samplePath);
const mediaSha256 = createHash("sha256").update(sampleBytes).digest("hex");
const sampleBase64 = sampleBytes.toString("base64");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const decoded = await page.evaluate(async ({ encodedBytes }) => {
    const binary = globalThis.atob(encodedBytes);
    const exactBytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) exactBytes[index] = binary.charCodeAt(index);
    const audioContext = new globalThis.AudioContext();
    const buffer = await audioContext.decodeAudioData(exactBytes.buffer.slice(0));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const sampleCount = Math.max(...channels.map((channel) => channel.length));
    const basePeaks = [];
    const clamp = (value) => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    for (let bucketIndex = 0; bucketIndex < Math.ceil((sampleCount * 100) / buffer.sampleRate); bucketIndex += 1) {
      const start = Math.floor((bucketIndex * buffer.sampleRate) / 100);
      const end = Math.min(sampleCount, Math.floor(((bucketIndex + 1) * buffer.sampleRate) / 100));
      let min = 1;
      let max = -1;
      for (const channel of channels) {
        for (let index = start; index < end; index += 1) {
          min = Math.min(min, clamp(channel[index] ?? 0));
          max = Math.max(max, clamp(channel[index] ?? 0));
        }
      }
      basePeaks.push([min, max]);
    }
    const durationMs = Math.round(buffer.duration * 1_000);
    await audioContext.close();
    return { decodedByteLength: exactBytes.byteLength, durationMs, basePeaks };
  }, { encodedBytes: sampleBase64 });

  if (decoded.decodedByteLength !== sampleBytes.byteLength) throw new Error("Chromium received a different media byte sequence length.");
  const packedPeaks = Buffer.alloc(decoded.basePeaks.length * 4);
  decoded.basePeaks.forEach(([minimum, maximum], index) => {
    packedPeaks.writeInt16LE(Math.round(minimum * 32_767), index * 4);
    packedPeaks.writeInt16LE(Math.round(maximum * 32_767), index * 4 + 2);
  });
  const levelCounts = [decoded.basePeaks.length];
  while (levelCounts.at(-1) > 1) levelCounts.push(Math.ceil(levelCounts.at(-1) / 2));
  const artifact = {
    schemaVersion: 1,
    source: "public/sample/gibbs-free-energy.mp4",
    mediaSha256,
    durationMs: decoded.durationMs,
    baseResolutionMs: 10,
    baseBucketCount: decoded.basePeaks.length,
    levelCounts,
    levelResolutionsMs: levelCounts.map((_, index) => 10 * (2 ** index)),
    encoding: "int16le-min-max-pairs-base64",
    derivation: "Exact repository MP4 bytes hashed before base64 transfer to Chromium AudioContext; no network/origin fetch; 10 ms channel-combined min/max buckets quantized to signed 16-bit pairs",
    peaksBase64: packedPeaks.toString("base64"),
  };
  await writeFile(outputPath, `${JSON.stringify(artifact)}\n`);
  process.stdout.write(`Wrote ${fileURLToPath(outputPath)} from ${mediaSha256}\n`);
} finally {
  await browser.close();
}
