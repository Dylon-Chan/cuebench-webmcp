from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import sys
import threading
import time
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cuebench_media.app import BridgeObjectStore, FileSystemObjectStore, create_app, create_app_from_environment
from cuebench_media.models import (
    InternalMediaJob,
    MediaJobKey,
    MediaJobKeyRing,
    MediaLimits,
    MediaServiceError,
    MediaServiceSettings,
    sign_internal_job,
    verify_internal_job,
)
from cuebench_media.probe import CommandExecutionError, CommandTimeoutError, SafeCommandRunner

SESSION_KEY = "c" * 64


def operation_key_for(operation_id: str) -> str:
    return hashlib.sha256(operation_id.encode("ascii")).hexdigest()


class MinimalTools:
    def probe(self, input_path: Path, deadline: object | None = None):  # type: ignore[no-untyped-def]
        from cuebench_media.probe import ProbeResult

        del deadline
        return ProbeResult("mp4", "video/mp4", "h264", 1_000, input_path.stat().st_size)

    def normalise_audio(
        self,
        input_path: Path,
        output_path: Path,
        duration_ms: int,
        maximum_pcm_bytes: int,
        deadline: object | None = None,
    ) -> None:
        import struct
        import wave

        del input_path, duration_ms, maximum_pcm_bytes, deadline
        with wave.open(str(output_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16_000)
            wav.writeframes(struct.pack("<h", 0) * 16_000)

    def detect_scenes(
        self, input_path: Path, duration_ms: int, maximum_count: int, deadline: object | None = None
    ) -> list[int]:
        del input_path, duration_ms, maximum_count, deadline
        return []

    def extract_thumbnail(
        self, input_path: Path, at_ms: int, output_path: Path, deadline: object | None = None
    ) -> None:
        del input_path, at_ms, output_path, deadline
        raise AssertionError("No scene should request a thumbnail")

    def versions(self, deadline: object | None = None) -> dict[str, str]:
        del deadline
        return {"ffmpeg": "fixture", "ffprobe": "fixture"}


class FakeBridgeResponse:
    def __init__(self, body: bytes, *, status: int, headers: dict[str, str]) -> None:
        self._body = io.BytesIO(body)
        self.status = status
        self.headers = headers

    def __enter__(self) -> FakeBridgeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        self._body.close()

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)


def test_probe_scopes_the_verified_capability_to_the_private_storage_bridge(tmp_path: Path) -> None:
    source = b"private bridge source"
    operation_id = "operation-bridge-0001"
    operation_key = operation_key_for(operation_id)
    input_key = f"processing/{SESSION_KEY}/{operation_key}"
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=tmp_path / "unused-input",
        output_root=tmp_path / "unused-output",
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(max_request_bytes=4 * 1024),
        clock=lambda: 1_000,
    )
    requests: list[object] = []

    def opener(request: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        requests.append(request)
        url = request.full_url
        if url.endswith("/healthz"):
            return FakeBridgeResponse(b"", status=204, headers={})
        assert request.get_method() == "GET"
        assert url.endswith(f"/{input_key}")
        assert request.get_header("X-cuebench-media-job")
        return FakeBridgeResponse(
            source,
            status=200,
            headers={
                "content-type": "video/mp4",
                "content-length": str(len(source)),
                "x-cuebench-sha256": hashlib.sha256(source).hexdigest(),
            },
        )

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=opener,
    )
    client = TestClient(create_app(settings=settings, tools=MinimalTools(), store=bridge))

    response = client.post(
        "/v1/probe",
        json=signed_body(
            key_ring,
            action="probe",
            operation_id=operation_id,
            operation_key=operation_key,
            input_key=input_key,
            input_byte_length=len(source),
            input_content_type="video/mp4",
        ),
    )

    assert response.status_code == 200
    assert len(requests) == 1


def test_private_storage_bridge_maps_a_missing_input_to_a_sanitized_availability_error(tmp_path: Path) -> None:
    operation_id = "operation-bridge-missing-0001"
    operation_key = operation_key_for(operation_id)
    input_key = f"processing/{SESSION_KEY}/{operation_key}"
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-missing-media-job-secret-for-tests"))
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=tmp_path / "unused-input",
        output_root=tmp_path / "unused-output",
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(max_request_bytes=4 * 1024),
        clock=lambda: 1_000,
    )

    def missing(request: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=missing,
    )
    response = TestClient(create_app(settings=settings, tools=MinimalTools(), store=bridge)).post(
        "/v1/probe",
        json=signed_body(
            key_ring,
            action="probe",
            operation_id=operation_id,
            operation_key=operation_key,
            input_key=input_key,
            input_byte_length=1,
            input_content_type="video/mp4",
        ),
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PREPARATION_FAILED"
    assert input_key not in response.text


def test_private_storage_bridge_treats_a_missing_cache_pointer_as_a_cache_miss() -> None:
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-cache-secret-for-tests-0001"))
    operation_key = operation_key_for("operation-bridge-cache-0001")
    job = InternalMediaJob(
        action="prepare",
        operation_id="operation-bridge-cache-0001",
        operation_key=operation_key,
        input_key=f"processing/{SESSION_KEY}/{operation_key}",
        input_byte_length=1,
        input_content_type="video/mp4",
        output_prefix=f"prepared/{operation_key}/",
        receipt_sha256="a" * 64,
        idempotency_key=f"prepare:{operation_key}",
        issued_at_ms=1_000,
        expires_at_ms=61_000,
    )
    token = sign_internal_job(job, key_ring)

    def not_found(request: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=not_found,
    )
    cache_key = f"prepared/{operation_key}/indexes/{'b' * 64}.json"

    with bridge.job_scope(job, token):
        assert bridge.read_output_bytes(cache_key) is None


def test_private_storage_bridge_checks_the_job_deadline_while_streaming_an_input(tmp_path: Path) -> None:
    operation_id = "operation-bridge-deadline-0001"
    operation_key = operation_key_for(operation_id)
    input_key = f"processing/{SESSION_KEY}/{operation_key}"
    source = b"x" * (1024 * 1024 + 1)
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-deadline-media-job-secret-for-tests"))
    job = InternalMediaJob(
        action="probe",
        operation_id=operation_id,
        operation_key=operation_key,
        input_key=input_key,
        input_byte_length=len(source),
        input_content_type="video/mp4",
        output_prefix=f"prepared/{operation_key}/",
        receipt_sha256="a" * 64,
        idempotency_key=f"probe:{operation_key}",
        issued_at_ms=1_000,
        expires_at_ms=61_000,
    )

    class ExpiringDeadline:
        def __init__(self) -> None:
            self.checks = 0

        def check(self) -> None:
            self.checks += 1
            if self.checks > 1:
                from cuebench_media.models import MediaServiceError

                raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.")

    def opener(_: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        return FakeBridgeResponse(
            source,
            status=200,
            headers={
                "content-type": "video/mp4",
                "content-length": str(len(source)),
                "x-cuebench-sha256": hashlib.sha256(source).hexdigest(),
            },
        )

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=opener,
    )
    deadline = ExpiringDeadline()
    with (
        bridge.job_scope(job, sign_internal_job(job, key_ring), deadline=deadline),
        pytest.raises(MediaServiceError) as timeout,
    ):
        bridge.input_path(input_key)

    assert timeout.value.code == "PROCESSING_TIMEOUT"
    assert deadline.checks > 1


def test_prepare_publishes_only_verified_artifacts_through_the_private_r2_bridge(tmp_path: Path) -> None:
    source = b"private bridge preparation source"
    operation_id = "operation-bridge-prepare-0001"
    operation_key = operation_key_for(operation_id)
    input_key = f"processing/{SESSION_KEY}/{operation_key}"
    output_prefix = f"prepared/{operation_key}/"
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-prepare-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=tmp_path / "unused-input",
        output_root=tmp_path / "unused-output",
        input_prefix="processing/",
        output_prefix="prepared/",
        limits=MediaLimits(max_request_bytes=4 * 1024),
        clock=lambda: 1_000,
    )
    stored: dict[str, tuple[bytes, dict[str, str]]] = {}

    def opener(request: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        key = request.full_url.removeprefix("http://cuebench-r2.internal/")
        if request.get_method() == "GET" and key == input_key:
            return FakeBridgeResponse(
                source,
                status=200,
                headers={
                    "content-type": "video/mp4",
                    "content-length": str(len(source)),
                    "x-cuebench-sha256": hashlib.sha256(source).hexdigest(),
                },
            )
        if request.get_method() == "GET" and key not in stored:
            raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)
        if request.get_method() == "GET":
            value, headers = stored[key]
            return FakeBridgeResponse(value, status=200, headers=headers)
        assert request.get_method() == "PUT"
        assert key.startswith(output_prefix)
        assert request.get_header("X-cuebench-media-job")
        assert request.get_header("If-none-match") == "*"
        value = request.data
        assert isinstance(value, bytes)
        headers = {
            "content-type": request.get_header("Content-type"),
            "content-length": str(len(value)),
            "x-cuebench-sha256": request.get_header("X-cuebench-sha256"),
        }
        if key in stored:
            previous, previous_headers = stored[key]
            assert previous == value and previous_headers == headers
            return FakeBridgeResponse(b"", status=200, headers=headers)
        stored[key] = (value, headers)
        return FakeBridgeResponse(b"", status=201, headers=headers)

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=opener,
    )
    client = TestClient(create_app(settings=settings, tools=MinimalTools(), store=bridge))

    response = client.post(
        "/v1/prepare",
        json=signed_body(
            key_ring,
            action="prepare",
            operation_id=operation_id,
            operation_key=operation_key,
            input_key=input_key,
            input_byte_length=len(source),
            input_content_type="video/mp4",
        ),
    )

    assert response.status_code == 200
    assert stored
    assert all(key.startswith(output_prefix) for key in stored)
    assert any("/manifests/" in key for key in stored)
    assert any("/indexes/" in key for key in stored)


def test_healthz_fails_closed_when_ffprobe_is_unavailable(tmp_path: Path) -> None:
    class MissingFfprobeTools(MinimalTools):
        def versions(self, deadline: object | None = None) -> dict[str, str]:
            del deadline
            return {"ffmpeg": "fixture"}

    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"health-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=tmp_path / "input",
        output_root=tmp_path / "output",
        input_prefix="processing/",
        output_prefix="prepared/",
    )
    settings.input_root.mkdir(parents=True)
    client = TestClient(create_app(settings=settings, tools=MissingFfprobeTools()))

    response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"


def test_healthz_fails_closed_when_the_private_r2_bridge_is_unavailable(tmp_path: Path) -> None:
    key_ring = MediaJobKeyRing(current=MediaJobKey("current", b"bridge-health-media-job-secret-for-tests-0001"))
    settings = MediaServiceSettings(
        key_ring=key_ring,
        input_root=tmp_path / "unused-input",
        output_root=tmp_path / "unused-output",
        input_prefix="processing/",
        output_prefix="prepared/",
    )

    def unavailable_bridge(_: object, timeout: int) -> FakeBridgeResponse:
        del timeout
        raise urllib.error.URLError("fixture unavailable")

    bridge = BridgeObjectStore(
        "http://cuebench-r2.internal",
        input_prefix="processing/",
        output_prefix="prepared/",
        maximum_input_bytes=500 * 1024 * 1024,
        opener=unavailable_bridge,
    )

    response = TestClient(create_app(settings=settings, tools=MinimalTools(), store=bridge)).get("/healthz")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"


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
    action: str = "prepare",
    operation_id: str = "operation-security-0001",
    operation_key: str | None = None,
    input_key: str | None = None,
    input_byte_length: int = len(b"private source content"),
    input_content_type: str = "video/mp4",
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

    canonical_payload = {
        "action": vector["job"]["action"],
        "contract_version": 1,
        "expires_at_ms": vector["job"]["expires_at_ms"],
        "idempotency_key": vector["job"]["idempotency_key"],
        "input_byte_length": vector["job"]["input_byte_length"],
        "input_content_type": vector["job"]["input_content_type"],
        "input_key": vector["job"]["input_key"],
        "issued_at_ms": vector["job"]["issued_at_ms"],
        "key_id": vector["current_key"]["id"],
        "operation_id": vector["job"]["operation_id"],
        "operation_key": vector["job"]["operation_key"],
        "output_prefix": vector["job"]["output_prefix"],
        "receipt_sha256": vector["job"]["receipt_sha256"],
        "type": "cuebench-media-job",
    }
    encoded_payload = _base64url_encode(json.dumps(canonical_payload, separators=(",", ":"), sort_keys=True).encode())
    token = f"{encoded_payload}.{vector['signature']}"
    job = verify_internal_job(token, key_ring, vector["job"]["issued_at_ms"] + 1)

    assert job.action == vector["job"]["action"]
    assert job.operation_id == vector["job"]["operation_id"]
    assert job.operation_key == vector["job"]["operation_key"]
    assert job.input_key == vector["job"]["input_key"]
    assert job.input_byte_length == vector["job"]["input_byte_length"]
    assert job.input_content_type == vector["job"]["input_content_type"]
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


def test_action_bound_capabilities_cannot_cross_probe_and_prepare_routes(
    secure_client: tuple[TestClient, MediaJobKeyRing, Path, Path],
) -> None:
    client, keys, _, output_root = secure_client

    probe_on_prepare = client.post("/v1/prepare", json=signed_body(keys, action="probe"))
    prepare_on_probe = client.post("/v1/probe", json=signed_body(keys, action="prepare"))

    assert probe_on_prepare.status_code == prepare_on_probe.status_code == 403
    assert probe_on_prepare.json()["error"]["code"] == prepare_on_probe.json()["error"]["code"] == "JOB_ACTION"
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

    app = create_app_from_environment()

    # Readiness is deliberately checked separately: this host has no fixed
    # FFmpeg binaries, so `/healthz` correctly fails closed here. Factory
    # construction itself must never require an OpenAI configuration.
    assert app.title == "CueBench media preparation"


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


def test_safe_command_runner_strips_media_storage_and_ai_secrets_from_parser_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY",
        "CUEBENCH_MEDIA_STORAGE_BRIDGE_URL",
        "R2_ACCESS_KEY_ID",
        "OPENAI_API_KEY",
    ):
        monkeypatch.setenv(name, f"fixture-{name}")
    runner = SafeCommandRunner(
        executable_paths={"python-test": sys.executable},
        default_timeout_seconds=1,
        maximum_output_bytes=4_096,
    )

    result = runner.run(["python-test", "-c", "import json, os; print(json.dumps(sorted(os.environ)))"])
    environment = set(json.loads(result.stdout))

    assert {"PATH", "LANG", "TMPDIR"}.issubset(environment)
    assert not any(name.startswith(("CUEBENCH", "R2_", "OPENAI")) for name in environment)


def test_content_addressed_local_publication_is_atomic_verifies_existing_and_cleans_partial_files(
    tmp_path: Path,
) -> None:
    store = FileSystemObjectStore(tmp_path / "input", tmp_path / "output", "processing/", "prepared/")
    operation_key = "d" * 64
    value = b'{"artifact":"verified"}'
    digest = hashlib.sha256(value).hexdigest()
    key = f"prepared/{operation_key}/manifests/{digest}.json"
    target = tmp_path / "output" / key

    assert store.put_bytes_if_absent(key, value)
    assert not store.put_bytes_if_absent(key, value)
    target.write_bytes(b"partial")
    with pytest.raises(Exception) as corrupted:
        store.put_bytes_if_absent(key, value)
    assert "partial" not in str(corrupted.value)

    failed_key = f"prepared/{operation_key}/manifests/{'e' * 64}.json"
    failed_target = tmp_path / "output" / failed_key
    with pytest.raises(RuntimeError):
        store._write_if_absent(
            failed_target, lambda destination: (_ for _ in ()).throw(RuntimeError("fixture failure"))
        )
    assert not failed_target.exists()
    assert not list((tmp_path / "output").rglob("*.tmp"))


def test_content_addressed_local_publication_has_one_atomic_winner_under_concurrency(tmp_path: Path) -> None:
    store = FileSystemObjectStore(tmp_path / "input", tmp_path / "output", "processing/", "prepared/")
    operation_key = "e" * 64
    value = b"concurrent-verified-artifact"
    key = f"prepared/{operation_key}/waveforms/{hashlib.sha256(value).hexdigest()}.json"
    outcomes: list[bool] = []
    failures: list[BaseException] = []

    def publish() -> None:
        try:
            outcomes.append(store.put_bytes_if_absent(key, value))
        except BaseException as error:  # pragma: no cover - asserted below
            failures.append(error)

    threads = [threading.Thread(target=publish) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert not failures
    assert outcomes.count(True) == 1
    assert outcomes.count(False) == 3
    assert store.read_output_bytes(key) == value
