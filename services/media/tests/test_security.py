from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cuebench_media.app import create_app, create_app_from_environment
from cuebench_media.models import (
    InternalMediaJob,
    MediaJobKey,
    MediaJobKeyRing,
    MediaLimits,
    MediaServiceSettings,
    sign_internal_job,
    verify_internal_job,
)
from cuebench_media.probe import CommandExecutionError, CommandTimeoutError, SafeCommandRunner

SESSION_KEY = "c" * 64


def operation_key_for(operation_id: str) -> str:
    return hashlib.sha256(operation_id.encode("ascii")).hexdigest()


class MinimalTools:
    def probe(self, input_path: Path):  # type: ignore[no-untyped-def]
        from cuebench_media.probe import ProbeResult

        return ProbeResult("mp4", "video/mp4", "h264", 1_000, input_path.stat().st_size)

    def normalise_audio(self, input_path: Path, output_path: Path) -> None:
        import struct
        import wave

        del input_path
        with wave.open(str(output_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16_000)
            wav.writeframes(struct.pack("<h", 0) * 16_000)

    def detect_scenes(self, input_path: Path, duration_ms: int, maximum_count: int) -> list[int]:
        del input_path, duration_ms, maximum_count
        return []

    def extract_thumbnail(self, input_path: Path, at_ms: int, output_path: Path) -> None:
        raise AssertionError("No scene should request a thumbnail")

    def versions(self) -> dict[str, str]:
        return {"ffmpeg": "fixture", "ffprobe": "fixture"}


@pytest.fixture
def secure_client(tmp_path: Path) -> tuple[TestClient, MediaJobKeyRing, Path, Path]:
    input_root = tmp_path / "input-root"
    output_root = tmp_path / "output-root"
    input_path = input_root / "processing" / SESSION_KEY / operation_key_for("operation-security-0001")
    input_path.parent.mkdir(parents=True)
    input_path.write_bytes(b"private source content")
    key_ring = MediaJobKeyRing(
        current=MediaJobKey("current", b"current-media-job-secret-for-tests-0001"),
        previous=MediaJobKey("previous", b"previous-media-job-secret-for-tests-0001"),
    )
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=input_root,
        output_root=output_root,
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(max_request_bytes=4 * 1024),
        clock=lambda: 1_000,
    )
    return TestClient(create_app(settings=settings, tools=MinimalTools())), key_ring, input_root, output_root


def signed_body(
    keys: MediaJobKeyRing,
    *,
    operation_id: str = "operation-security-0001",
    operation_key: str | None = None,
    input_key: str | None = None,
    output_prefix: str | None = None,
    issued_at_ms: int = 1_000,
    expires_at_ms: int = 61_000,
    receipt_sha256: str = "a" * 64,
    idempotency_key: str | None = None,
) -> dict[str, str]:
    resolved_operation_key = operation_key or operation_key_for(operation_id)
    return {
        "job": sign_internal_job(
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
    }


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _resign_raw_payload(payload: bytes, key: MediaJobKey) -> str:
    encoded_payload = _base64url_encode(payload)
    signature = hmac.new(key.secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_base64url_encode(signature)}"


def test_worker_and_python_share_the_exact_media_job_signature_vector() -> None:
    fixture_path = Path(__file__).resolve().parents[3] / "apps/web/worker/fixtures/media-job-signature-vectors.json"
    vector = json.loads(fixture_path.read_text(encoding="utf-8"))[0]
    key_ring = MediaJobKeyRing(
        current=MediaJobKey(vector["current_key"]["id"], vector["current_key"]["secret"].encode()),
        previous=MediaJobKey(vector["previous_key"]["id"], vector["previous_key"]["secret"].encode()),
    )

    job = verify_internal_job(vector["token"], key_ring, vector["job"]["issued_at_ms"] + 1)

    assert job.operation_id == vector["job"]["operation_id"]
    assert job.operation_key == vector["job"]["operation_key"]
    assert job.input_key == vector["job"]["input_key"]
    assert job.output_prefix == vector["job"]["output_prefix"]
    assert job.receipt_sha256 == vector["job"]["receipt_sha256"]
    assert job.idempotency_key == vector["job"]["idempotency_key"]


def test_media_job_key_rejects_a_trivially_repeated_secret() -> None:
    with pytest.raises(ValueError, match="Invalid media-signing key configuration"):
        MediaJobKey("current", b"a" * 32)


@pytest.mark.parametrize(
    ("input_key", "output_prefix"),
    [
        ("processing/../../outside.mp4", None),
        ("/processing/lesson.mp4", None),
        (None, "prepared/../../outside/"),
        (None, "outside/security/"),
    ],
)
def test_private_input_and_output_paths_cannot_escape_prefixes(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
    input_key: str | None,
    output_prefix: str | None,
) -> None:
    client, keys, _, output_root = secure_client

    response = client.post("/v1/prepare", json=signed_body(keys, input_key=input_key, output_prefix=output_prefix))

    assert response.status_code == 401
    error = response.json()["error"]
    assert error["code"] == "JOB_INVALID"
    assert input_key is None or input_key not in error["message"]
    assert output_prefix is None or output_prefix not in error["message"]
    assert not list(output_root.rglob("*"))


def test_private_input_symlink_cannot_escape_root(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
    tmp_path: Path,
) -> None:
    client, keys, input_root, output_root = secure_client
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"must not be read")
    target = input_root / "processing" / SESSION_KEY / operation_key_for("operation-security-0001")
    target.unlink()
    os.symlink(outside, target)

    response = client.post("/v1/prepare", json=signed_body(keys))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "PRIVATE_PATH"
    assert "outside.mp4" not in response.text
    assert not list(output_root.rglob("*"))


def test_tampered_signed_job_cannot_change_bound_input_or_output_prefix(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, keys, _, output_root = secure_client
    valid = signed_body(keys)
    payload, signature = valid["job"].split(".")
    replacement = "A" if payload[-1] != "A" else "B"

    response = client.post("/v1/prepare", json={"job": f"{payload[:-1]}{replacement}.{signature}"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "JOB_INVALID"
    assert not list(output_root.rglob("*"))


def test_signed_job_requires_exact_canonical_json_without_duplicate_keys(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, keys, _, output_root = secure_client
    encoded_payload, _ = signed_body(keys)["job"].split(".")
    payload = base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
    whitespace_payload = json.dumps(
        json.loads(payload), ensure_ascii=True, separators=(", ", ": "), sort_keys=True
    ).encode("utf-8")
    duplicate_payload = payload.replace(
        b'"operation_id":"operation-security-0001",',
        b'"operation_id":"operation-security-0001","operation_id":"other",',
        1,
    )

    assert whitespace_payload != payload
    assert duplicate_payload != payload
    for raw_payload in (whitespace_payload, duplicate_payload):
        response = client.post("/v1/prepare", json={"job": _resign_raw_payload(raw_payload, keys.current)})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "JOB_INVALID"
    assert not list(output_root.rglob("*"))


def test_expired_future_and_replayed_internal_jobs_are_rejected_without_leaking_content(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, keys, _, _ = secure_client

    expired = client.post("/v1/prepare", json=signed_body(keys, issued_at_ms=0, expires_at_ms=999))
    future = client.post(
        "/v1/prepare",
        json=signed_body(keys, operation_id="future-operation-0001", issued_at_ms=31_001, expires_at_ms=61_000),
    )
    first = client.post("/v1/prepare", json=signed_body(keys))
    replay = client.post(
        "/v1/prepare",
        json=signed_body(keys, receipt_sha256="b" * 64),
    )

    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "JOB_EXPIRED"
    assert future.status_code == 401
    assert future.json()["error"]["code"] == "JOB_NOT_YET_VALID"
    assert first.status_code == 200
    assert replay.status_code == 409
    assert replay.json()["error"]["code"] == "JOB_REPLAYED"
    assert "lesson.mp4" not in replay.text


def test_previous_key_is_accepted_during_key_rotation(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, keys, _, _ = secure_client
    previous_only = MediaJobKeyRing(current=keys.previous)
    token = signed_body(previous_only)["job"]

    response = client.post("/v1/prepare", json={"job": token})

    assert response.status_code == 200


def test_malformed_json_and_oversized_request_have_sanitized_bounded_errors(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, _, _, _ = secure_client

    malformed = client.post("/v1/prepare", content=b'{"job":', headers={"content-type": "application/json"})
    oversized = client.post("/v1/prepare", content=b"x" * 5_000, headers={"content-type": "application/json"})

    assert malformed.status_code == 422
    assert malformed.json() == {
        "error": {"code": "INVALID_REQUEST", "message": "CueBench could not read the preparation request."}
    }
    assert oversized.status_code == 413
    assert oversized.json() == {
        "error": {"code": "REQUEST_TOO_LARGE", "message": "CueBench rejected an oversized internal request."}
    }


def test_environment_factory_starts_without_openai_configuration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for name in (
        "OPENAI_API_KEY",
        "CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY_ID",
        "CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY_ID", "environment-current")
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY", "environment-media-job-secret-with-at-least-32-bytes")
    monkeypatch.setenv("CUEBENCH_MEDIA_INPUT_ROOT", str(tmp_path / "private-input"))
    monkeypatch.setenv("CUEBENCH_MEDIA_OUTPUT_ROOT", str(tmp_path / "private-output"))

    response = TestClient(create_app_from_environment()).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "contract_version": 1}


def test_environment_key_ids_match_worker_normalization_without_rewriting_secret_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current_secret = " current-media-job-secret-with-at-least-32-bytes "
    previous_secret = " previous-media-job-secret-with-at-least-32-bytes "
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY_ID", " current ")
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY", current_secret)
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY_ID", " previous ")
    monkeypatch.setenv("CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY", previous_secret)

    settings = MediaServiceSettings.from_environment()

    assert settings.key_ring.current == MediaJobKey("current", current_secret.encode("utf-8"))
    assert settings.key_ring.previous == MediaJobKey("previous", previous_secret.encode("utf-8"))


def test_safe_command_runner_uses_an_allowlist_argv_timeout_and_bounded_output(tmp_path: Path) -> None:
    runner = SafeCommandRunner(
        executable_paths={"python-test": sys.executable},
        default_timeout_seconds=0.2,
        maximum_output_bytes=64,
    )
    marker = tmp_path / "child-survived"
    grandchild_code = f"import pathlib, time; time.sleep(1); pathlib.Path({str(marker)!r}).write_text('bad')"
    child_code = (
        "import pathlib, subprocess, sys, time; "
        f"subprocess.Popen([sys.executable, '-c', {grandchild_code!r}]); "
        "time.sleep(10)"
    )

    with pytest.raises(CommandTimeoutError) as timeout:
        runner.run(["python-test", "-c", child_code])
    time.sleep(0.4)
    result = runner.run(["python-test", "-c", "import sys; sys.stdout.write('x' * 200); sys.stderr.write('y' * 200)"])

    assert "python-test" not in str(timeout.value)
    assert not marker.exists()
    assert len(result.stdout) == len(result.stderr) == 64
    assert result.stdout_truncated and result.stderr_truncated
    with pytest.raises(CommandExecutionError) as failed:
        runner.run(["python-test", "-c", "import sys; sys.stderr.write('/private/source.mp4 CAPTION'); sys.exit(7)"])
    assert "/private/source.mp4" not in str(failed.value)
    assert "CAPTION" not in str(failed.value)
    with pytest.raises(CommandExecutionError):
        runner.run(["not-allowed", "--version"])


def test_safe_command_runner_never_interpolates_an_argument_as_shell_code(tmp_path: Path) -> None:
    runner = SafeCommandRunner(
        executable_paths={"python-test": sys.executable}, default_timeout_seconds=1, maximum_output_bytes=256
    )
    marker = tmp_path / "should-not-exist"
    malicious_argument = f"value; pathlib.Path({str(marker)!r}).write_text('bad')"

    result = runner.run(["python-test", "-c", "import sys; print(sys.argv[1])", malicious_argument])

    assert result.stdout.decode().strip() == malicious_argument
    assert not marker.exists()
