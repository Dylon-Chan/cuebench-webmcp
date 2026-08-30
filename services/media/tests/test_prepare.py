from __future__ import annotations

import hashlib
import json
import struct
import threading
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cuebench_media.app import PreparationLimiter, create_app
from cuebench_media.models import (
    InternalMediaJob,
    MediaJobKey,
    MediaJobKeyRing,
    MediaLimits,
    MediaServiceSettings,
    sign_internal_job,
)
from cuebench_media.probe import CommandResult, FFmpegMediaTools, ProbeResult

SESSION_KEY = "b" * 64


def operation_key_for(operation_id: str) -> str:
    return hashlib.sha256(operation_id.encode("ascii")).hexdigest()


def webp(width: int = 1, height: int = 1) -> bytes:
    """A minimal VP8X WebP container sufficient for structural validation tests."""
    payload = b"\x00\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    return b"RIFF" + struct.pack("<I", 4 + 8 + len(payload)) + b"WEBPVP8X" + struct.pack("<I", len(payload)) + payload


def write_mono_wav(path: Path, duration_ms: int = 1_200) -> None:
    frame_count = 16_000 * duration_ms // 1_000
    samples = b"".join(struct.pack("<h", -1_000 if index % 2 == 0 else 1_000) for index in range(frame_count))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(samples)


class FakeMediaTools:
    def __init__(
        self,
        *,
        probe_result: ProbeResult | None = None,
        scene_points: tuple[int, ...] = (100, 700, 1_100),
        thumbnail: bytes | None = None,
        fail_after_thumbnail: bool = False,
    ) -> None:
        self.probe_result = probe_result
        self.scene_points = scene_points
        self.thumbnail = thumbnail or webp()
        self.fail_after_thumbnail = fail_after_thumbnail
        self.normalise_calls = 0

    def probe(self, input_path: Path) -> ProbeResult:
        return self.probe_result or ProbeResult(
            container="mp4",
            mime_type="video/mp4",
            codec="h264",
            duration_ms=1_200,
            byte_length=input_path.stat().st_size,
        )

    def normalise_audio(self, input_path: Path, output_path: Path) -> None:
        del input_path
        self.normalise_calls += 1
        write_mono_wav(output_path)

    def detect_scenes(self, input_path: Path, duration_ms: int, maximum_count: int) -> list[int]:
        del input_path, duration_ms
        return list(self.scene_points[:maximum_count])

    def extract_thumbnail(self, input_path: Path, at_ms: int, output_path: Path) -> None:
        del input_path, at_ms
        output_path.write_bytes(self.thumbnail)
        if self.fail_after_thumbnail:
            raise RuntimeError("fixture thumbnail failure")

    def versions(self) -> dict[str, str]:
        return {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"}


@pytest.fixture
def prepared_client(tmp_path: Path) -> tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools]:
    input_root = tmp_path / "private-input"
    output_root = tmp_path / "private-output"
    input_path = input_root / "processing" / SESSION_KEY / operation_key_for("prepare-operation-0001")
    input_path.parent.mkdir(parents=True)
    input_path.write_bytes(b"synthetic CueBench source")
    keys = MediaJobKeyRing(current=MediaJobKey("current", b"prepare-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=keys,
        input_root=input_root,
        output_root=output_root,
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(
            max_input_bytes=500 * 1024 * 1024,
            max_duration_ms=15 * 60 * 1_000,
            max_thumbnail_count=3,
            max_thumbnail_width=320,
            max_thumbnail_height=180,
            max_thumbnail_bytes=64 * 1024,
            max_request_bytes=4 * 1024,
            max_concurrent_preparations=2,
        ),
        clock=lambda: 1_000,
    )
    tools = FakeMediaTools()
    return TestClient(create_app(settings=settings, tools=tools)), keys, input_root, output_root, tools


def job_body(
    keys: MediaJobKeyRing,
    *,
    operation_id: str = "prepare-operation-0001",
    operation_key: str | None = None,
    input_key: str | None = None,
    output_prefix: str | None = None,
    issued_at_ms: int = 1_000,
    expires_at_ms: int = 61_000,
    receipt_sha256: str = "a" * 64,
    idempotency_key: str | None = None,
) -> dict[str, str]:
    resolved_operation_key = operation_key or operation_key_for(operation_id)
    token = sign_internal_job(
        InternalMediaJob(
            operation_id=operation_id,
            operation_key=resolved_operation_key,
            input_key=input_key or f"processing/{SESSION_KEY}/{resolved_operation_key}",
            output_prefix=output_prefix or f"prepared/{resolved_operation_key}/",
            receipt_sha256=receipt_sha256,
            idempotency_key=idempotency_key or f"probe:{resolved_operation_key}",
            issued_at_ms=issued_at_ms,
            expires_at_ms=expires_at_ms,
        ),
        keys,
    )
    return {"job": token}


def test_prepare_returns_integer_millisecond_evidence(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, _, _ = prepared_client

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 200
    result = response.json()
    assert result["contract_version"] == 1
    assert all(isinstance(scene["at_ms"], int) for scene in result["scenes"])
    assert result["waveform"]["bucket_ms"] == 10
    assert len(result["waveform"]["levels"]) > 1
    assert all(
        "min" in bucket and "max" in bucket for level in result["waveform"]["levels"] for bucket in level["buckets"]
    )
    assert result["metadata"] == {
        "container": "mp4",
        "mime_type": "video/mp4",
        "codec": "h264",
        "duration_ms": 1_200,
        "byte_length": len(b"synthetic CueBench source"),
        "sha256": hashlib.sha256(b"synthetic CueBench source").hexdigest(),
    }
    assert result["normalized_audio"]["sample_rate_hz"] == 16_000
    assert result["normalized_audio"]["channels"] == 1
    assert result["tools"] == {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"}


def test_prepare_outputs_are_content_addressed_and_repeat_is_idempotent(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, output_root, tools = prepared_client
    body = job_body(keys)

    first = client.post("/v1/prepare", json=body)
    second = client.post("/v1/prepare", json=body)
    # A Worker retry mints a fresh short-lived transport capability for the
    # same signed receipt identity. It must reuse evidence, not conflict.
    refreshed = client.post(
        "/v1/prepare",
        json=job_body(keys, issued_at_ms=1_001, expires_at_ms=61_001),
    )

    assert first.status_code == second.status_code == refreshed.status_code == 200
    assert first.json() == second.json()
    assert first.json() == refreshed.json()
    result = first.json()
    expected_prefix = f"prepared/{operation_key_for('prepare-operation-0001')}/"
    assert result["manifest"]["key"].startswith(f"{expected_prefix}manifests/")
    assert result["normalized_audio"]["key"].startswith(f"{expected_prefix}audio/")
    assert all(item["key"].startswith(f"{expected_prefix}thumbnails/") for item in result["thumbnails"])
    output_files = [path for path in output_root.rglob("*") if path.is_file()]
    assert output_files
    assert len(output_files) == len({path.read_bytes() for path in output_files})
    assert tools.normalise_calls == 1


def test_prepare_bounds_thumbnail_count_dimensions_and_bytes(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, _, tools = prepared_client
    tools.scene_points = tuple(range(0, 10_000, 100))

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 200
    result = response.json()
    assert len(result["thumbnails"]) == 3
    assert all(item["mime_type"] == "image/webp" for item in result["thumbnails"])
    assert all(item["width"] <= 320 and item["height"] <= 180 for item in result["thumbnails"])
    assert all(item["byte_length"] <= 64 * 1024 for item in result["thumbnails"])
    assert "frames" not in result


@pytest.mark.parametrize(
    ("probe_result", "expected_code"),
    [
        (ProbeResult("avi", "video/x-msvideo", "h264", 1_200, 1), "UNSUPPORTED_MEDIA"),
        (ProbeResult("mp4", "video/mp4", "mpeg4", 1_200, 1), "UNSUPPORTED_MEDIA"),
        (ProbeResult("mp4", "video/mp4", "h264", 15 * 60 * 1_000 + 1, 1), "MEDIA_DURATION_LIMIT"),
        (ProbeResult("mp4", "video/mp4", "h264", 1_200, 500 * 1024 * 1024 + 1), "MEDIA_SIZE_LIMIT"),
    ],
)
def test_prepare_rejects_authoritative_unsupported_or_oversized_media(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
    probe_result: ProbeResult,
    expected_code: str,
) -> None:
    client, keys, _, _, tools = prepared_client
    tools.probe_result = probe_result

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code in {413, 415}
    assert response.json()["error"]["code"] == expected_code


def test_prepare_rejects_thumbnail_that_exceeds_dimensions_and_cleans_output(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, output_root, tools = prepared_client
    tools.thumbnail = webp(width=321, height=1)

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "THUMBNAIL_LIMIT"
    assert not list(output_root.rglob("*"))


def test_prepare_cleans_new_outputs_when_a_later_step_fails(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, output_root, tools = prepared_client
    tools.fail_after_thumbnail = True

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "PREPARATION_FAILED"
    assert not list(output_root.rglob("*"))


def test_probe_adapter_returns_the_task_eleven_authoritative_shape(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, _, _ = prepared_client

    response = client.post("/v1/probe", json=job_body(keys))

    assert response.status_code == 200
    assert response.json() == {
        "container": "mp4",
        "mimeType": "video/mp4",
        "codec": "h264",
        "durationMs": 1_200,
        "byteLength": len(b"synthetic CueBench source"),
        "sha256": hashlib.sha256(b"synthetic CueBench source").hexdigest(),
    }


class RecordingRunner:
    def __init__(self, output: bytes) -> None:
        self.output = output
        self.argv: list[list[str]] = []

    def run(self, argv: list[str], timeout_seconds: float | None = None) -> CommandResult:
        self.argv.append(argv)
        return CommandResult(
            returncode=0, stdout=self.output, stderr=b"", stdout_truncated=False, stderr_truncated=False
        )


def test_ffprobe_parses_actual_container_codec_duration_and_file_size(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"actual bytes")
    runner = RecordingRunner(
        json.dumps(
            {
                "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.234", "size": "12"},
                "streams": [{"codec_type": "video", "codec_name": "h264"}],
            }
        ).encode(),
    )
    tools = FFmpegMediaTools(runner=runner)

    result = tools.probe(source)

    assert result == ProbeResult("mp4", "video/mp4", "h264", 1_234, len(b"actual bytes"))
    assert runner.argv == [
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration,size:stream=codec_type,codec_name",
            "-of",
            "json",
            str(source),
        ]
    ]


def test_preparation_limit_rejects_a_parallel_job_before_media_work(tmp_path: Path) -> None:
    input_root = tmp_path / "in"
    output_root = tmp_path / "out"
    input_path = input_root / "processing" / SESSION_KEY / operation_key_for("prepare-operation-0001")
    input_path.parent.mkdir(parents=True)
    input_path.write_bytes(b"source")
    keys = MediaJobKeyRing(current=MediaJobKey("current", b"limit-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=keys,
        input_root=input_root,
        output_root=output_root,
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(max_concurrent_preparations=1),
        clock=lambda: 1_000,
    )
    started = threading.Event()
    release = threading.Event()

    class BlockingTools(FakeMediaTools):
        def normalise_audio(self, input_path: Path, output_path: Path) -> None:
            started.set()
            assert release.wait(timeout=2)
            super().normalise_audio(input_path, output_path)

    app = create_app(settings=settings, tools=BlockingTools(), limiter=PreparationLimiter(1))
    body = job_body(keys)
    first_status: list[int] = []

    def run_first() -> None:
        with TestClient(app) as client:
            first_status.append(client.post("/v1/prepare", json=body).status_code)

    thread = threading.Thread(target=run_first)
    thread.start()
    assert started.wait(timeout=2)
    with TestClient(app) as client:
        second = client.post(
            "/v1/prepare",
            json=job_body(keys, operation_id="prepare-operation-0002"),
        )
    release.set()
    thread.join(timeout=3)

    assert second.status_code == 429
    assert second.json()["error"]["code"] == "SERVICE_BUSY"
    assert first_status == [200]
