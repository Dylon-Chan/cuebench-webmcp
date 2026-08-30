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
from cuebench_media.audio import sha256_file
from cuebench_media.models import (
    InternalMediaJob,
    MediaJobKey,
    MediaJobKeyRing,
    MediaLimits,
    MediaServiceError,
    MediaServiceSettings,
    sign_internal_job,
)
from cuebench_media.probe import CommandResult, CommandTimeoutError, FFmpegMediaTools, PreparationDeadline, ProbeResult
from cuebench_media.waveform import build_waveform_pyramid

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

    def probe(self, input_path: Path, deadline: object | None = None) -> ProbeResult:
        del deadline
        return self.probe_result or ProbeResult(
            container="mp4",
            mime_type="video/mp4",
            codec="h264",
            duration_ms=1_200,
            byte_length=input_path.stat().st_size,
        )

    def normalise_audio(
        self,
        input_path: Path,
        output_path: Path,
        duration_ms: int,
        maximum_pcm_bytes: int,
        deadline: object | None = None,
    ) -> None:
        del input_path, duration_ms, maximum_pcm_bytes, deadline
        self.normalise_calls += 1
        write_mono_wav(output_path)

    def detect_scenes(
        self, input_path: Path, duration_ms: int, maximum_count: int, deadline: object | None = None
    ) -> list[int]:
        del input_path, duration_ms, deadline
        return list(self.scene_points[:maximum_count])

    def extract_thumbnail(
        self, input_path: Path, at_ms: int, output_path: Path, deadline: object | None = None
    ) -> None:
        del input_path, at_ms, deadline
        output_path.write_bytes(self.thumbnail)
        if self.fail_after_thumbnail:
            raise RuntimeError("fixture thumbnail failure")

    def versions(self, deadline: object | None = None) -> dict[str, str]:
        del deadline
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
    action: str = "prepare",
    operation_id: str = "prepare-operation-0001",
    operation_key: str | None = None,
    input_key: str | None = None,
    input_byte_length: int = len(b"synthetic CueBench source"),
    input_content_type: str = "video/mp4",
    output_prefix: str | None = None,
    issued_at_ms: int = 1_000,
    expires_at_ms: int = 61_000,
    receipt_sha256: str = "a" * 64,
    idempotency_key: str | None = None,
) -> dict[str, str]:
    resolved_operation_key = operation_key or operation_key_for(operation_id)
    token = sign_internal_job(
        InternalMediaJob(
            action=action,  # type: ignore[arg-type]
            operation_id=operation_id,
            operation_key=resolved_operation_key,
            input_key=input_key or f"processing/{SESSION_KEY}/{resolved_operation_key}",
            input_byte_length=input_byte_length,
            input_content_type=input_content_type,  # type: ignore[arg-type]
            output_prefix=output_prefix or f"prepared/{resolved_operation_key}/",
            receipt_sha256=receipt_sha256,
            idempotency_key=idempotency_key or f"{action}:{resolved_operation_key}",
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


def test_prepare_can_return_only_the_bounded_manifest_reference_to_the_container_proxy(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, _, _ = prepared_client

    full_response = client.post("/v1/prepare", json=job_body(keys))
    response = client.post(
        "/v1/prepare",
        json=job_body(keys),
        headers={"x-cuebench-media-result": "manifest-ref"},
    )

    assert full_response.status_code == 200
    assert "waveform" in full_response.json()
    assert response.status_code == 200
    assert set(response.json()) == {"manifest"}
    manifest = response.json()["manifest"]
    assert manifest["key"].startswith(f"prepared/{operation_key_for('prepare-operation-0001')}/manifests/")
    assert manifest["sha256"] == manifest["key"].rsplit("/", 1)[-1].removesuffix(".json")


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


def test_prepare_rejects_thumbnail_collection_that_exceeds_the_total_byte_budget(tmp_path: Path) -> None:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    operation_key = operation_key_for("prepare-operation-0001")
    source = input_root / "processing" / SESSION_KEY / operation_key
    source.parent.mkdir(parents=True)
    source.write_bytes(b"synthetic CueBench source")
    keys = MediaJobKeyRing(current=MediaJobKey("current", b"thumbnail-total-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=keys,
        input_root=input_root,
        output_root=output_root,
        limits=MediaLimits(
            max_thumbnail_count=2,
            max_thumbnail_width=320,
            max_thumbnail_height=180,
            max_thumbnail_bytes=64 * 1024,
            max_thumbnail_total_bytes=80,
        ),
        clock=lambda: 1_000,
    )
    tools = FakeMediaTools(scene_points=(100, 700), thumbnail=webp() + b"x" * 32)
    client = TestClient(create_app(settings=settings, tools=tools))

    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "THUMBNAIL_LIMIT"
    assert not list(output_root.rglob("*"))


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

    response = client.post("/v1/probe", json=job_body(keys, action="probe"))

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


def test_ffprobe_timeout_consumes_the_shared_job_deadline_not_an_unsupported_media_response(tmp_path: Path) -> None:
    class TimeoutRunner:
        def run(self, argv: list[str], timeout_seconds: float | None = None) -> CommandResult:
            del argv, timeout_seconds
            raise CommandTimeoutError()

    source = tmp_path / "source.mp4"
    source.write_bytes(b"actual bytes")

    with pytest.raises(MediaServiceError) as timeout:
        FFmpegMediaTools(TimeoutRunner()).probe(source, PreparationDeadline(1))

    assert timeout.value.code == "PROCESSING_TIMEOUT"


def test_normalization_uses_authoritative_duration_pcm_disk_cap_and_remaining_deadline(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"actual bytes")
    output = tmp_path / "normalized.wav"
    runner = RecordingRunner(b"")
    tools = FFmpegMediaTools(runner=runner)
    deadline = PreparationDeadline(1)

    with pytest.raises(MediaServiceError, match="supported media"):
        tools.normalise_audio(source, output, 1_234, 39_532, deadline)

    argv = runner.argv[0]
    assert argv[0] == "ffmpeg"
    assert argv[argv.index("-t") + 1] == "1.234"
    assert argv[argv.index("-fs") + 1] == "39532"


def test_scene_detection_rejects_truncated_fixed_tool_output(tmp_path: Path) -> None:
    class TruncatedSceneRunner:
        def run(self, argv: list[str], timeout_seconds: float | None = None) -> CommandResult:
            del argv, timeout_seconds
            return CommandResult(
                returncode=0,
                stdout=b"",
                stderr=b"[Parsed_showinfo] pts_time:0.100\n",
                stdout_truncated=False,
                stderr_truncated=True,
            )

    source = tmp_path / "source.mp4"
    source.write_bytes(b"actual bytes")

    with pytest.raises(MediaServiceError) as rejected:
        FFmpegMediaTools(TruncatedSceneRunner()).detect_scenes(source, 1_000, 1, PreparationDeadline(1))

    assert rejected.value.code == "UNSUPPORTED_MEDIA"


def test_one_signed_job_deadline_covers_probe_and_all_following_stages(tmp_path: Path) -> None:
    input_root = tmp_path / "in"
    output_root = tmp_path / "out"
    operation_id = "deadline-operation-0001"
    operation_key = operation_key_for(operation_id)
    source = input_root / "processing" / SESSION_KEY / operation_key
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    keys = MediaJobKeyRing(current=MediaJobKey("deadline", b"deadline-media-job-secret-for-tests-0001"))
    monotonic_now = [0.0]

    class DeadlineExhaustingTools(FakeMediaTools):
        def probe(self, input_path: Path, deadline: object | None = None) -> ProbeResult:
            result = super().probe(input_path, deadline)
            monotonic_now[0] = 61.0
            return result

        def versions(self, deadline: object | None = None) -> dict[str, str]:
            assert isinstance(deadline, PreparationDeadline)
            deadline.remaining_seconds(60)
            return super().versions(deadline)

    settings = MediaServiceSettings(
        key_ring=keys,
        input_root=input_root,
        output_root=output_root,
        limits=MediaLimits(),
        clock=lambda: 1_000,
        monotonic_clock=lambda: monotonic_now[0],
    )
    client = TestClient(create_app(settings=settings, tools=DeadlineExhaustingTools()))

    response = client.post("/v1/prepare", json=job_body(keys, operation_id=operation_id, input_byte_length=6))

    assert response.status_code == 504
    assert response.json()["error"]["code"] == "PROCESSING_TIMEOUT"


def test_preparer_rejects_normalized_audio_larger_than_authoritative_pcm_cap(
    prepared_client: tuple[TestClient, MediaJobKeyRing, Path, Path, FakeMediaTools],
) -> None:
    client, keys, _, _, tools = prepared_client

    def oversized_audio(_: Path, output: Path, __: int, ___: int, ____: object | None = None) -> None:
        write_mono_wav(output, duration_ms=1_201)

    tools.normalise_audio = oversized_audio  # type: ignore[method-assign]
    response = client.post("/v1/prepare", json=job_body(keys))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "AUDIO_LIMIT"


def test_waveform_stream_rejects_a_pcm_file_that_exceeds_its_byte_budget(tmp_path: Path) -> None:
    source = tmp_path / "oversized.wav"
    write_mono_wav(source, duration_ms=20)

    with pytest.raises(MediaServiceError) as rejected:
        build_waveform_pyramid(source, maximum_bytes=44 + 16)

    assert rejected.value.code == "AUDIO_INVALID"


def test_hashing_and_waveform_streaming_consume_the_shared_deadline_between_chunks(tmp_path: Path) -> None:
    class ExpiringDeadline:
        def __init__(self) -> None:
            self.checks = 0

        def check(self) -> None:
            self.checks += 1
            if self.checks > 1:
                raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.")

    source = tmp_path / "large-source.bin"
    source.write_bytes(b"x" * (1024 * 1024 + 1))
    with pytest.raises(MediaServiceError) as hash_timeout:
        sha256_file(source, deadline=ExpiringDeadline())
    assert hash_timeout.value.code == "PROCESSING_TIMEOUT"

    pcm = tmp_path / "large-normalized.wav"
    write_mono_wav(pcm, duration_ms=1_200)
    deadline = ExpiringDeadline()
    with pytest.raises(MediaServiceError) as waveform_timeout:
        build_waveform_pyramid(pcm, deadline=deadline)
    assert waveform_timeout.value.code == "PROCESSING_TIMEOUT"
    assert deadline.checks > 1


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
        def normalise_audio(
            self,
            input_path: Path,
            output_path: Path,
            duration_ms: int,
            maximum_pcm_bytes: int,
            deadline: object | None = None,
        ) -> None:
            started.set()
            assert release.wait(timeout=2)
            super().normalise_audio(input_path, output_path, duration_ms, maximum_pcm_bytes, deadline)

    app = create_app(settings=settings, tools=BlockingTools(), limiter=PreparationLimiter(1))
    body = job_body(keys, input_byte_length=6)
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
