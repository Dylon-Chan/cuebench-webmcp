from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION: Final = 1
PREPARATION_VERSION: Final = "1"
MAX_INTERNAL_JOB_BYTES: Final = 8 * 1024
MAX_FUTURE_ISSUED_MS: Final = 30_000
MAX_JOB_LIFETIME_MS: Final = 15 * 60 * 1_000
_KEY_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_OPERATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_OPERATION_KEY = re.compile(r"^[a-f0-9]{64}$")
_RECEIPT_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class MediaServiceError(Exception):
    """A deliberately content-free error that is safe to return at the service boundary."""

    def __init__(self, code: str, status_code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.safe_message = message


def private_path_error() -> MediaServiceError:
    return MediaServiceError("PRIVATE_PATH", 400, "CueBench rejected a private media location.")


def invalid_job_error() -> MediaServiceError:
    return MediaServiceError("JOB_INVALID", 401, "CueBench could not verify the internal media job.")


@dataclass(frozen=True)
class MediaJobKey:
    key_id: str
    secret: bytes

    def __post_init__(self) -> None:
        if not _KEY_ID.fullmatch(self.key_id) or len(self.secret) < 32 or len(set(self.secret)) < 8:
            raise ValueError("Invalid media-signing key configuration.")


@dataclass(frozen=True)
class MediaJobKeyRing:
    current: MediaJobKey
    previous: MediaJobKey | None = None

    def __post_init__(self) -> None:
        if self.previous is not None and hmac.compare_digest(self.current.key_id, self.previous.key_id):
            raise ValueError("Media-signing key ids must be distinct during rotation.")

    def key_for_id(self, key_id: str) -> MediaJobKey | None:
        if hmac.compare_digest(key_id, self.current.key_id):
            return self.current
        if self.previous is not None and hmac.compare_digest(key_id, self.previous.key_id):
            return self.previous
        return None


@dataclass(frozen=True)
class InternalMediaJob:
    """The job-scoped, signed capability presented only by internal callers."""

    operation_id: str
    operation_key: str
    input_key: str
    output_prefix: str
    receipt_sha256: str
    idempotency_key: str
    issued_at_ms: int
    expires_at_ms: int


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    if not value or any(character not in alphabet for character in value):
        raise ValueError("invalid base64url")
    padding = "=" * (-len(value) % 4)
    return base64.b64decode(value + padding, altchars=b"-_", validate=True)


def _payload(job: InternalMediaJob, key_id: str) -> bytes:
    return json.dumps(
        {
            "contract_version": CONTRACT_VERSION,
            "expires_at_ms": job.expires_at_ms,
            "idempotency_key": job.idempotency_key,
            "input_key": job.input_key,
            "issued_at_ms": job.issued_at_ms,
            "key_id": key_id,
            "operation_id": job.operation_id,
            "operation_key": job.operation_key,
            "output_prefix": job.output_prefix,
            "receipt_sha256": job.receipt_sha256,
            "type": "cuebench-media-job",
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sign_internal_job(job: InternalMediaJob, key_ring: MediaJobKeyRing) -> str:
    """Signs the entire authority tuple using a canonical, cross-runtime JSON form."""

    encoded_payload = _base64url_encode(_payload(job, key_ring.current.key_id))
    signature = hmac.new(key_ring.current.secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_base64url_encode(signature)}"


def _without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, item in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = item
    return result


def _required_job_fields(value: object) -> tuple[str, str, str, str, str, str, str, int, int] | None:
    if not isinstance(value, dict) or set(value) != {
        "contract_version",
        "expires_at_ms",
        "idempotency_key",
        "input_key",
        "issued_at_ms",
        "key_id",
        "operation_id",
        "operation_key",
        "output_prefix",
        "receipt_sha256",
        "type",
    }:
        return None
    key_id = value.get("key_id")
    operation_id = value.get("operation_id")
    operation_key = value.get("operation_key")
    input_key = value.get("input_key")
    output_prefix = value.get("output_prefix")
    receipt_sha256 = value.get("receipt_sha256")
    idempotency_key = value.get("idempotency_key")
    issued_at_ms = value.get("issued_at_ms")
    expires_at_ms = value.get("expires_at_ms")
    if (
        value.get("type") != "cuebench-media-job"
        or value.get("contract_version") != CONTRACT_VERSION
        or not isinstance(key_id, str)
        or not _KEY_ID.fullmatch(key_id)
        or not isinstance(operation_id, str)
        or not _OPERATION_ID.fullmatch(operation_id)
        or not isinstance(operation_key, str)
        or not _OPERATION_KEY.fullmatch(operation_key)
        or not isinstance(input_key, str)
        or not isinstance(output_prefix, str)
        or not isinstance(receipt_sha256, str)
        or not _RECEIPT_SHA256.fullmatch(receipt_sha256)
        or not isinstance(idempotency_key, str)
        or isinstance(issued_at_ms, bool)
        or isinstance(expires_at_ms, bool)
        or not isinstance(issued_at_ms, int)
        or not isinstance(expires_at_ms, int)
    ):
        return None
    if (
        re.fullmatch(rf"processing/[a-f0-9]{{64}}/{operation_key}", input_key) is None
        or output_prefix != f"prepared/{operation_key}/"
        or idempotency_key != f"probe:{operation_key}"
    ):
        return None
    return (
        key_id,
        operation_id,
        operation_key,
        input_key,
        output_prefix,
        receipt_sha256,
        idempotency_key,
        issued_at_ms,
        expires_at_ms,
    )


def verify_internal_job(
    token: str,
    key_ring: MediaJobKeyRing,
    now_ms: int,
    *,
    maximum_future_issued_ms: int = MAX_FUTURE_ISSUED_MS,
    maximum_lifetime_ms: int = MAX_JOB_LIFETIME_MS,
) -> InternalMediaJob:
    """Verifies integrity before lifecycle semantics, including the one-key rotation window."""

    if len(token.encode("utf-8")) > MAX_INTERNAL_JOB_BYTES:
        raise invalid_job_error()
    parts = token.split(".")
    if len(parts) != 2:
        raise invalid_job_error()
    encoded_payload, encoded_signature = parts
    try:
        payload_bytes = _base64url_decode(encoded_payload)
        signature = _base64url_decode(encoded_signature)
        decoded = json.loads(payload_bytes.decode("utf-8"), object_pairs_hook=_without_duplicate_keys)
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise invalid_job_error() from None
    fields = _required_job_fields(decoded)
    if fields is None:
        raise invalid_job_error()
    (
        key_id,
        operation_id,
        operation_key,
        input_key,
        output_prefix,
        receipt_sha256,
        idempotency_key,
        issued_at_ms,
        expires_at_ms,
    ) = fields
    job = InternalMediaJob(
        operation_id=operation_id,
        operation_key=operation_key,
        input_key=input_key,
        output_prefix=output_prefix,
        receipt_sha256=receipt_sha256,
        idempotency_key=idempotency_key,
        issued_at_ms=issued_at_ms,
        expires_at_ms=expires_at_ms,
    )
    if not hmac.compare_digest(encoded_payload, _base64url_encode(_payload(job, key_id))):
        raise invalid_job_error()
    key = key_ring.key_for_id(key_id)
    if key is None:
        raise invalid_job_error()
    expected = hmac.new(key.secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, signature):
        raise invalid_job_error()
    if issued_at_ms >= expires_at_ms or expires_at_ms - issued_at_ms > maximum_lifetime_ms:
        raise invalid_job_error()
    if expires_at_ms <= now_ms:
        raise MediaServiceError("JOB_EXPIRED", 401, "This internal media job has expired.")
    if issued_at_ms > now_ms + maximum_future_issued_ms:
        raise MediaServiceError("JOB_NOT_YET_VALID", 401, "This internal media job is not yet valid.")
    return job


def job_fingerprint(job: InternalMediaJob) -> str:
    # Time bounds and signing-key rotation authenticate transport but must not
    # turn a newly minted equivalent capability into a conflicting replay.
    return hashlib.sha256(
        json.dumps(
            {
                "contract_version": CONTRACT_VERSION,
                "idempotency_key": job.idempotency_key,
                "input_key": job.input_key,
                "operation_id": job.operation_id,
                "operation_key": job.operation_key,
                "output_prefix": job.output_prefix,
                "receipt_sha256": job.receipt_sha256,
                "type": "cuebench-media-job",
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()


@dataclass(frozen=True)
class MediaLimits:
    max_input_bytes: int = 500 * 1024 * 1024
    max_duration_ms: int = 15 * 60 * 1_000
    max_thumbnail_count: int = 12
    max_thumbnail_width: int = 320
    max_thumbnail_height: int = 180
    max_thumbnail_bytes: int = 64 * 1024
    max_request_bytes: int = 16 * 1024
    max_concurrent_preparations: int = 2
    command_timeout_seconds: float = 60.0
    max_command_output_bytes: int = 64 * 1024

    def __post_init__(self) -> None:
        if (
            self.max_input_bytes <= 0
            or self.max_duration_ms <= 0
            or self.max_thumbnail_count <= 0
            or self.max_thumbnail_width <= 0
            or self.max_thumbnail_height <= 0
            or self.max_thumbnail_bytes <= 0
            or self.max_request_bytes <= 0
            or self.max_concurrent_preparations <= 0
            or self.command_timeout_seconds <= 0
            or self.max_command_output_bytes <= 0
        ):
            raise ValueError("Media limits must be positive.")


@dataclass(frozen=True)
class MediaServiceSettings:
    key_ring: MediaJobKeyRing
    input_root: Path
    output_root: Path
    input_prefix: str = "processing/"
    output_prefix: str = "prepared/"
    limits: MediaLimits = field(default_factory=MediaLimits)
    clock: Callable[[], int] = field(default=lambda: int(time.time() * 1_000), compare=False, repr=False)

    def __post_init__(self) -> None:
        if not self.input_prefix.endswith("/") or not self.output_prefix.endswith("/"):
            raise ValueError("Private object prefixes must end in a slash.")

    @classmethod
    def from_environment(cls) -> MediaServiceSettings:
        import os

        current_id = os.environ.get("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY_ID", "").strip() or None
        current_secret = os.environ.get("CUEBENCH_MEDIA_JOB_HMAC_CURRENT_KEY")
        previous_id = os.environ.get("CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY_ID", "").strip() or None
        previous_secret = os.environ.get("CUEBENCH_MEDIA_JOB_HMAC_PREVIOUS_KEY")
        if not current_id or not current_secret or (bool(previous_id) != bool(previous_secret)):
            raise ValueError("Media signing keys are not configured.")
        previous = None
        if previous_id:
            assert previous_secret is not None
            previous = MediaJobKey(previous_id, previous_secret.encode("utf-8"))
        return cls(
            key_ring=MediaJobKeyRing(MediaJobKey(current_id, current_secret.encode("utf-8")), previous),
            input_root=Path(os.environ.get("CUEBENCH_MEDIA_INPUT_ROOT", "/data/input")),
            output_root=Path(os.environ.get("CUEBENCH_MEDIA_OUTPUT_ROOT", "/data/output")),
            input_prefix=os.environ.get("CUEBENCH_MEDIA_INPUT_PREFIX", "processing/"),
            output_prefix=os.environ.get("CUEBENCH_MEDIA_OUTPUT_PREFIX", "prepared/"),
        )


class SignedJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_max_length=MAX_INTERNAL_JOB_BYTES)

    job: str = Field(min_length=1)
