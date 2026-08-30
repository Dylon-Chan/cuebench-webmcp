"""Build-time real-media verification for the immutable CueBench Container image."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from cuebench_media.app import FileSystemObjectStore, MediaPreparer
from cuebench_media.models import InternalMediaJob, MediaJobKey, MediaJobKeyRing, MediaLimits, MediaServiceSettings
from cuebench_media.probe import FFmpegMediaTools, SafeCommandRunner
from cuebench_media.scenes import webp_dimensions


def _generate_fixture(path: Path) -> None:
    """Uses fixed argv only: three color scenes plus tone/silence/tone audio."""

    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TMPDIR": "/tmp"}
    subprocess.run(
        [
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=25:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=320x180:r=25:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x180:r=25:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=mono:sample_rate=16000:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:sample_rate=16000:duration=0.5",
            "-filter_complex",
            "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-y",
            str(path),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=environment,
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cuebench-media-selftest-") as temporary:
        root = Path(temporary)
        input_root = root / "input"
        output_root = root / "output"
        operation_key = "d" * 64
        input_key = f"processing/{'e' * 64}/{operation_key}"
        source = input_root / input_key
        source.parent.mkdir(parents=True)
        _generate_fixture(source)
        now_ms = int(time.time() * 1_000)
        settings = MediaServiceSettings(
            key_ring=MediaJobKeyRing(MediaJobKey("selftest", b"cuebench-docker-selftest-signing-key-0001")),
            input_root=input_root,
            output_root=output_root,
            limits=MediaLimits(
                max_input_bytes=8 * 1024 * 1024,
                max_duration_ms=5_000,
                # The deterministic fixture has two high-contrast cuts. Keep
                # one representative thumbnail to prove scene evidence is not
                # silently truncated to the thumbnail cap.
                max_thumbnail_count=1,
                max_thumbnail_width=320,
                max_thumbnail_height=180,
                max_thumbnail_bytes=64 * 1024,
                max_thumbnail_total_bytes=128 * 1024,
                command_timeout_seconds=30,
            ),
        )
        tools = FFmpegMediaTools(
            SafeCommandRunner(
                executable_paths={"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
                default_timeout_seconds=30,
                maximum_output_bytes=64 * 1024,
            ),
            maximum_scene_output_bytes=settings.limits.max_scene_output_bytes,
        )
        job = InternalMediaJob(
            action="prepare",
            operation_id="docker-selftest",
            operation_key=operation_key,
            input_key=input_key,
            input_byte_length=source.stat().st_size,
            input_content_type="video/mp4",
            output_prefix=f"prepared/{operation_key}/",
            receipt_sha256="a" * 64,
            idempotency_key=f"prepare:{operation_key}",
            issued_at_ms=now_ms,
            expires_at_ms=now_ms + 5 * 60_000,
        )
        result = MediaPreparer(
            settings,
            FileSystemObjectStore(input_root, output_root, "processing/", "prepared/"),
            tools,
        ).prepare(job)

        normalized = result["normalized_audio"]
        assert isinstance(normalized, dict)
        normalized_path = output_root / str(normalized["key"])
        with wave.open(str(normalized_path), "rb") as audio:
            assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16_000)

        waveform = result["waveform"]
        assert isinstance(waveform, dict) and waveform["bucket_ms"] == 10
        levels = waveform["levels"]
        assert isinstance(levels, list) and len(levels) > 1
        assert all(
            isinstance(bucket["min"], int) and isinstance(bucket["max"], int)
            for level in levels
            for bucket in level["buckets"]
        )

        thumbnails = result["thumbnails"]
        assert isinstance(thumbnails, list) and thumbnails
        scenes = result["scenes"]
        assert isinstance(scenes, list) and len(scenes) > settings.limits.max_thumbnail_count
        assert len(thumbnails) <= settings.limits.max_thumbnail_count
        assert sum(int(item["byte_length"]) for item in thumbnails) <= settings.limits.max_thumbnail_total_bytes
        for thumbnail in thumbnails:
            value = (output_root / str(thumbnail["key"])).read_bytes()
            assert len(value) <= settings.limits.max_thumbnail_bytes
            assert webp_dimensions(value) == (int(thumbnail["width"]), int(thumbnail["height"]))

        manifest = result["manifest"]
        assert isinstance(manifest, dict)
        manifest_bytes = (output_root / str(manifest["key"])).read_bytes()
        assert hashlib.sha256(manifest_bytes).hexdigest() == manifest["sha256"]
        decoded_manifest = json.loads(manifest_bytes)
        assert decoded_manifest["metadata"]["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
        assert all(decoded_manifest["tools"][tool].startswith(f"{tool} version") for tool in ("ffmpeg", "ffprobe"))


if __name__ == "__main__":
    # The Docker image invokes this directly; it intentionally accepts no
    # environment credentials, user paths, or shell-composed commands.
    main()
