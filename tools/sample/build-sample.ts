#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sampleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sampleDirectory, "../..");
const lessonSvg = resolve(sampleDirectory, "slides/lesson.svg");
const narrationMix = resolve(sampleDirectory, "audio/gibbs-free-energy-narration-mix.flac");
const transcriptPath = resolve(sampleDirectory, "reference-transcript.json");
const referenceProjectPath = resolve(sampleDirectory, "reference-project.json");
const publicSampleDirectory = resolve(repositoryRoot, "apps/web/public/sample");
const outputPath = resolve(publicSampleDirectory, "gibbs-free-energy.mp4");
const publicReferenceProjectPath = resolve(publicSampleDirectory, "reference-project.json");
const mediaDockerfile = resolve(repositoryRoot, "services/media/Dockerfile");
const mediaBuildContext = resolve(repositoryRoot, "services/media");
const defaultImage = "cuebench-media:selftest";
const placeholderHash = "f".repeat(64);

interface Segment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: string | null;
  readonly text: string;
  readonly spoken: boolean;
}

interface ReferenceTranscript {
  readonly schemaVersion: 1;
  readonly durationMs: number;
  readonly segments: readonly Segment[];
}

interface ReferenceProject {
  readonly media: {
    readonly durationMs: number;
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly buildInputs: {
    readonly audioTrack: BuildInput & {
      readonly byteLength: number;
      readonly codec: "flac";
      readonly sampleRateHz: 48_000;
      readonly channels: 2;
    };
    readonly slideSvg: BuildInput;
    readonly transcript: BuildInput;
    readonly replayEvents: BuildInput;
    readonly ffmpegImage: {
      readonly imageId: string;
      readonly ffmpegVersion: string;
      readonly dockerfilePath: string;
      readonly dockerfileSha256: string;
    };
  };
}

interface BuildInput {
  readonly path: string;
  readonly sha256: string;
}

interface Options {
  readonly buildImage: boolean;
  readonly checkDeterminism: boolean;
  readonly image: string;
  readonly verifyOnly: boolean;
}

const parseOptions = (values: readonly string[]): Options => {
  let image = defaultImage;
  let buildImage = false;
  let checkDeterminism = false;
  let verifyOnly = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--build-image") buildImage = true;
    else if (value === "--check-determinism") checkDeterminism = true;
    else if (value === "--verify") verifyOnly = true;
    else if (value === "--image") {
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--image requires a Docker image name.");
      image = next;
      index += 1;
    } else throw new Error(`Unknown sample-build option: ${value ?? ""}`);
  }
  if (verifyOnly && (buildImage || checkDeterminism)) {
    throw new Error("--verify cannot be combined with --build-image or --check-determinism.");
  }
  return { buildImage, checkDeterminism, image, verifyOnly };
};

const run = (
  command: string,
  args: readonly string[],
  options: { readonly capture?: boolean; readonly cwd?: string } = {},
): string => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stderr ?? ""}`.trim() : "";
    throw new Error(`${command} exited with status ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`);
  }
  return options.capture ? `${result.stdout ?? ""}` : "";
};

const parseJson = <Value>(path: string): Value => JSON.parse(readFileSync(path, "utf8")) as Value;

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const assertFixture = (transcript: ReferenceTranscript, reference: ReferenceProject): void => {
  if (transcript.schemaVersion !== 1 || transcript.durationMs !== 90_000 || transcript.segments.length !== 11) {
    throw new Error("The reference transcript must remain the authored 90-second, eleven-segment lesson.");
  }
  const spoken = transcript.segments.filter((segment) => segment.spoken);
  if (
    spoken.length !== 10
    || spoken.some((segment) => segment.text.trim() === "" || segment.speaker === null)
    || !spoken.some((segment) => segment.speaker === "Dr. Nguyen")
    || !spoken.some((segment) => segment.speaker === "Student")
  ) throw new Error("The reference transcript must retain both speakers and every authored speech segment.");
  const pause = transcript.segments.find((segment) => !segment.spoken);
  if (pause?.startMs !== 50_000 || pause.endMs !== 65_000) {
    throw new Error("The reference transcript must retain the 15-second silent diagram window.");
  }
  if (reference.media.durationMs !== transcript.durationMs) {
    throw new Error("Reference project and transcript durations disagree.");
  }
};

const buildImage = (image: string): void => {
  run("/usr/local/bin/docker", [
    "build",
    "--tag", image,
    "--file", mediaDockerfile,
    mediaBuildContext,
  ]);
};

const requireImage = (image: string, reference: ReferenceProject): void => {
  const result = spawnSync("/usr/local/bin/docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`Docker image ${image} is missing. Run this script once with --build-image.`);
  }
  const actualImageId = result.stdout.trim();
  if (actualImageId !== reference.buildInputs.ffmpegImage.imageId) {
    throw new Error(`Docker image ${image} resolved to ${actualImageId}; expected pinned ${reference.buildInputs.ffmpegImage.imageId}.`);
  }
  const version = dockerRun(image, [], ["ffmpeg", "-version"], true).split("\n")[0]?.trim();
  if (version !== reference.buildInputs.ffmpegImage.ffmpegVersion) {
    throw new Error(`Pinned image FFmpeg version changed: ${version ?? "missing"}.`);
  }
};

const dockerRun = (image: string, mounts: readonly string[], command: readonly string[], capture = false): string => run(
  "/usr/local/bin/docker",
  [
    "run",
    "--rm",
    "--network", "none",
    "--env", "HOME=/tmp",
    "--env", "XDG_CACHE_HOME=/tmp/.cache",
    ...(typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : []),
    ...mounts.flatMap((mount) => ["--volume", mount]),
    image,
    ...command,
  ],
  { capture },
);

const renderSlideStrip = (workingDirectory: string, image: string): string => {
  const rendered = resolve(workingDirectory, "lesson-strip.png");
  dockerRun(image, [
    `${dirname(lessonSvg)}:/slides:ro`,
    `${workingDirectory}:/build`,
  ], [
    "ffmpeg",
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-i", "/slides/lesson.svg",
    "-frames:v", "1",
    "-update", "1",
    "-c:v", "png",
    "-compression_level", "9",
    "/build/lesson-strip.png",
  ]);
  if (!existsSync(rendered) || statSync(rendered).size <= 0) {
    throw new Error("Pinned FFmpeg/librsvg did not render the authored SVG slide strip.");
  }
  const dimensions = dockerRun(image, [`${workingDirectory}:/build:ro`], [
    "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", "/build/lesson-strip.png",
  ], true).trim();
  if (dimensions !== "1280,5760") {
    throw new Error(`Authored slide strip rendered at an unexpected size: ${dimensions}`);
  }
  return rendered;
};

const slideDurationsSeconds = [10, 17, 8, 15, 15, 15, 5, 5] as const;

const assembleVideo = (
  workingDirectory: string,
  image: string,
  slideStrip: string,
  targetName: string,
): string => {
  const stagedOutput = resolve(workingDirectory, targetName);
  const stripInContainer = `/build/${slideStrip.split("/").at(-1) ?? "lesson.svg.png"}`;
  const inputArguments = slideDurationsSeconds.flatMap((duration) => [
    "-loop", "1",
    "-framerate", "30",
    "-t", String(duration),
    "-i", stripInContainer,
  ]);
  inputArguments.push("-i", "/audio/gibbs-free-energy-narration-mix.flac");
  const videoFilters = slideDurationsSeconds.map((_, index) => (
    `[${index}:v]crop=1280:720:0:${index * 720},setsar=1,fps=30,format=yuv420p[v${index}]`
  ));
  const audioInputIndex = slideDurationsSeconds.length;
  const filter = [
    ...videoFilters,
    `${slideDurationsSeconds.map((_, index) => `[v${index}]`).join("")}concat=n=${slideDurationsSeconds.length}:v=1:a=0[vout]`,
    `[${audioInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=90,apad=whole_dur=90,asetpts=PTS-STARTPTS[aout]`,
  ].join(";");
  dockerRun(image, [`${workingDirectory}:/build`, `${dirname(narrationMix)}:/audio:ro`], [
    "ffmpeg",
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    ...inputArguments,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", "[aout]",
    "-t", "90",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-profile:v", "high",
    "-level:v", "4.0",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
    "-threads", "1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-map_metadata", "-1",
    "-metadata", "title=CueBench Gibbs free energy demonstration",
    "-metadata", "comment=Original SVG and repository-pinned lossless synthetic narration input; deterministic demonstration asset.",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-movflags", "+faststart",
    `/build/${targetName}`,
  ]);
  if (!existsSync(stagedOutput) || statSync(stagedOutput).size <= 0) {
    throw new Error("FFmpeg did not produce the CueBench demonstration MP4.");
  }
  return stagedOutput;
};

const assertBuildInput = (input: BuildInput, expectedPath: string, label: string): void => {
  if (resolve(repositoryRoot, input.path) !== expectedPath) throw new Error(`${label} path changed in reference-project.json.`);
  if (!existsSync(expectedPath)) throw new Error(`Missing pinned ${label}: ${expectedPath}`);
  if (sha256File(expectedPath) !== input.sha256.toLowerCase()) throw new Error(`${label} SHA-256 no longer matches reference-project.json.`);
};

const assertBuildInputs = (reference: ReferenceProject): void => {
  assertBuildInput(reference.buildInputs.audioTrack, narrationMix, "lossless narration mix");
  assertBuildInput(reference.buildInputs.slideSvg, lessonSvg, "authored slide SVG");
  assertBuildInput(reference.buildInputs.transcript, transcriptPath, "reference transcript");
  assertBuildInput(reference.buildInputs.replayEvents, resolve(sampleDirectory, "replay-events.json"), "replay events");
  assertBuildInput({
    path: reference.buildInputs.ffmpegImage.dockerfilePath,
    sha256: reference.buildInputs.ffmpegImage.dockerfileSha256,
  }, mediaDockerfile, "media Dockerfile");
  if (statSync(narrationMix).size !== reference.buildInputs.audioTrack.byteLength) {
    throw new Error("Lossless narration mix byte length no longer matches reference-project.json.");
  }
};

const probe = (image: string, path: string): { readonly duration: number; readonly size: number } => {
  const directory = dirname(path);
  const name = path.split("/").at(-1) ?? "gibbs-free-energy.mp4";
  const output = dockerRun(image, [`${directory}:/media:ro`], [
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-of", "json",
    `/media/${name}`,
  ], true);
  const parsed = JSON.parse(output) as { readonly format?: { readonly duration?: string; readonly size?: string } };
  const duration = Number(parsed.format?.duration);
  const size = Number(parsed.format?.size);
  if (!Number.isFinite(duration) || !Number.isSafeInteger(size)) throw new Error("ffprobe returned invalid sample metadata.");
  return { duration, size };
};

const verify = (image: string, reference: ReferenceProject): void => {
  assertBuildInputs(reference);
  if (!existsSync(outputPath)) throw new Error(`Missing checked-in sample: ${outputPath}`);
  const digest = sha256File(outputPath);
  const metadata = probe(image, outputPath);
  if (Math.abs(metadata.duration - 90) > 0.05) throw new Error(`Sample duration ${metadata.duration} is not approximately 90 seconds.`);
  if (metadata.size > 25 * 1024 * 1024) throw new Error(`Sample size ${metadata.size} exceeds the bounded 25 MB fixture target.`);
  if (reference.media.sha256 !== placeholderHash && digest !== reference.media.sha256.toLowerCase()) {
    throw new Error(`Sample SHA-256 ${digest} does not match reference-project.json (${reference.media.sha256}).`);
  }
  if (reference.media.byteLength !== 1 && metadata.size !== reference.media.byteLength) {
    throw new Error(`Sample byte length ${metadata.size} does not match reference-project.json (${reference.media.byteLength}).`);
  }
  if (!existsSync(publicReferenceProjectPath) || sha256File(publicReferenceProjectPath) !== sha256File(referenceProjectPath)) {
    throw new Error("The public reference-project.json is missing or differs from its authored source.");
  }
  process.stdout.write(`${JSON.stringify({ duration: metadata.duration, size: metadata.size, sha256: digest }, null, 2)}\n`);
};

const buildOnce = (image: string, targetName: string): { readonly directory: string; readonly output: string } => {
  const directory = mkdtempSync(resolve(tmpdir(), "cuebench-gibbs-sample-"));
  try {
    const slideStrip = renderSlideStrip(directory, image);
    return { directory, output: assembleVideo(directory, image, slideStrip, targetName) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

const build = (options: Options, _transcript: ReferenceTranscript, reference: ReferenceProject): void => {
  if (options.buildImage) buildImage(options.image);
  requireImage(options.image, reference);
  assertBuildInputs(reference);
  const first = buildOnce(options.image, "gibbs-free-energy.mp4");
  let second: ReturnType<typeof buildOnce> | null = null;
  try {
    if (options.checkDeterminism) {
      second = buildOnce(options.image, "gibbs-free-energy.mp4");
      if (sha256File(first.output) !== sha256File(second.output)) {
        throw new Error("Two complete independent builds from the pinned authored inputs did not produce the same SHA-256.");
      }
    }
    mkdirSync(publicSampleDirectory, { recursive: true });
    copyFileSync(first.output, outputPath);
    copyFileSync(referenceProjectPath, publicReferenceProjectPath);
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
    if (second !== null) rmSync(second.directory, { recursive: true, force: true });
  }
  verify(options.image, reference);
};

const options = parseOptions(process.argv.slice(2));
const transcript = parseJson<ReferenceTranscript>(transcriptPath);
const reference = parseJson<ReferenceProject>(referenceProjectPath);
assertFixture(transcript, reference);
if (options.verifyOnly) {
  requireImage(options.image, reference);
  verify(options.image, reference);
} else {
  build(options, transcript, reference);
}
