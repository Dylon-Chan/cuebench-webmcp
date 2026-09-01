import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const scriptPath = fileURLToPath(new URL("./generate-sample-waveform.mjs", import.meta.url));
const samplePath = new URL("../public/sample/gibbs-free-energy.mp4", import.meta.url);
const checkedInPath = new URL("../src/features/evidence/bundled-sample-waveform.json", import.meta.url);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cuebench-waveform-"));
const regeneratedPath = join(temporaryDirectory, "waveform.json");

try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--output", regeneratedPath], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Waveform generator exited with ${code}.`)));
  });
  const [sampleBytes, checkedInBytes, regeneratedBytes] = await Promise.all([
    readFile(samplePath),
    readFile(checkedInPath),
    readFile(regeneratedPath),
  ]);
  const sampleSha256 = createHash("sha256").update(sampleBytes).digest("hex");
  const checkedIn = JSON.parse(checkedInBytes.toString("utf8"));
  if (checkedIn.mediaSha256 !== sampleSha256) throw new Error("Checked-in waveform hash does not match the repository MP4.");
  if (!checkedInBytes.equals(regeneratedBytes)) throw new Error("Regenerated waveform artifact differs byte-for-byte from the checked-in artifact.");
  process.stdout.write(`Verified deterministic waveform artifact for ${sampleSha256}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
