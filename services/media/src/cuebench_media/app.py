from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .audio import normalized_audio_facts, sha256_file
from .models import (
    CONTRACT_VERSION,
    PREPARATION_VERSION,
    InternalMediaJob,
    MediaLimits,
    MediaServiceError,
    MediaServiceSettings,
    SignedJobRequest,
    job_fingerprint,
    private_path_error,
    verify_internal_job,
)
from .probe import FFmpegMediaTools, MediaTools, PreparationDeadline, ProbeResult, SafeCommandRunner
from .scenes import webp_dimensions
from .waveform import build_waveform_pyramid

_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _safe_error(code: str, status: int, message: str) -> MediaServiceError:
    return MediaServiceError(code, status, message)


def _validate_private_prefix(prefix: str) -> None:
    if not prefix.endswith("/") or prefix.startswith("/") or "\\" in prefix or "//" in prefix:
        raise ValueError("Invalid private object prefix configuration.")
    pieces = prefix[:-1].split("/")
    if not pieces or any(not _SAFE_SEGMENT.fullmatch(piece) for piece in pieces):
        raise ValueError("Invalid private object prefix configuration.")


def _validate_private_key(value: str, expected_prefix: str, *, require_prefix: bool) -> tuple[str, ...]:
    if (
        not value
        or len(value) > 1_024
        or value.startswith("/")
        or "\\" in value
        or "//" in value
        or "\x00" in value
        or (require_prefix and not value.startswith(expected_prefix))
    ):
        raise private_path_error()
    suffix = value[len(expected_prefix) :] if require_prefix else value
    if not suffix:
        raise private_path_error()
    pieces = suffix.rstrip("/").split("/")
    if value.endswith("/") and not suffix.rstrip("/"):
        raise private_path_error()
    if any(not _SAFE_SEGMENT.fullmatch(piece) for piece in pieces):
        raise private_path_error()
    return tuple(value.rstrip("/").split("/"))


class FileSystemObjectStore:
    """A strict local implementation of the private-object adapter used by Container tests and local runs."""

    def __init__(self, input_root: Path, output_root: Path, input_prefix: str, output_prefix: str) -> None:
        _validate_private_prefix(input_prefix)
        _validate_private_prefix(output_prefix)
        self._input_root = input_root.resolve()
        self._output_root = output_root.resolve()
        self._input_prefix = input_prefix
        self._output_prefix = output_prefix
        self._output_root.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def job_scope(
        self,
        job: InternalMediaJob,
        raw_job_token: str | None,
        deadline: PreparationDeadline | None = None,
    ) -> Any:
        del job, raw_job_token, deadline
        yield

    def health(self) -> bool:
        return self._input_root.is_dir() and self._output_root.is_dir()

    @staticmethod
    def _within(root: Path, candidate: Path) -> Path:
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(root)
        except ValueError:
            raise private_path_error() from None
        return resolved

    def input_path(self, key: str) -> Path:
        parts = _validate_private_key(key, self._input_prefix, require_prefix=True)
        path = self._within(self._input_root, self._input_root.joinpath(*parts))
        if not path.is_file():
            raise private_path_error()
        return path

    def validate_output_prefix(self, prefix: str) -> None:
        if not prefix.endswith("/"):
            raise private_path_error()
        _validate_private_key(prefix, self._output_prefix, require_prefix=True)
        self._within(self._output_root, self._output_root.joinpath(*prefix.rstrip("/").split("/")))

    def output_path(self, key: str) -> Path:
        parts = _validate_private_key(key, self._output_prefix, require_prefix=True)
        return self._within(self._output_root, self._output_root.joinpath(*parts))

    def read_output_bytes(self, key: str) -> bytes | None:
        path = self.output_path(key)
        if not path.is_file():
            return None
        try:
            return path.read_bytes()
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not read prepared media evidence.") from None

    @staticmethod
    def _digest_and_size(path: Path) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        try:
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not verify prepared media evidence.") from None
        return digest.hexdigest(), size

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        try:
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        except OSError:
            raise _safe_error(
                "PREPARATION_FAILED", 500, "CueBench could not publish prepared media evidence."
            ) from None

    def _existing_matches(self, target: Path, expected_digest: str, expected_size: int) -> bool:
        try:
            if target.is_symlink() or not target.is_file():
                return False
        except OSError:
            return False
        digest, size = self._digest_and_size(target)
        return size == expected_size and hmac.compare_digest(digest, expected_digest)

    def _write_if_absent(self, target: Path, write: Any) -> bool:
        target.parent.mkdir(parents=True, exist_ok=True)
        self._within(self._output_root, target.parent)
        descriptor: int | None = None
        temporary: Path | None = None
        try:
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
            temporary = Path(temporary_name)
            with os.fdopen(descriptor, "wb") as destination:
                descriptor = None
                try:
                    write(destination)
                    destination.flush()
                    os.fsync(destination.fileno())
                except BaseException:
                    raise
            expected_digest, expected_size = self._digest_and_size(temporary)
            try:
                os.link(temporary, target, follow_symlinks=False)
            except FileExistsError:
                if self._existing_matches(target, expected_digest, expected_size):
                    return False
                raise _safe_error(
                    "PREPARATION_FAILED", 500, "CueBench could not verify prepared media evidence."
                ) from None
            self._fsync_directory(target.parent)
            return True
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not store prepared media evidence.") from None
        finally:
            if descriptor is not None:
                with suppress(OSError):
                    os.close(descriptor)
            if temporary is not None:
                with suppress(OSError):
                    temporary.unlink(missing_ok=True)

    def put_bytes_if_absent(self, key: str, value: bytes) -> bool:
        target = self.output_path(key)
        return self._write_if_absent(target, lambda destination: destination.write(value))

    def put_file_if_absent(self, key: str, source: Path) -> bool:
        target = self.output_path(key)

        def copy(destination: Any) -> None:
            with source.open("rb") as input_file:
                shutil.copyfileobj(input_file, destination, length=1024 * 1024)

        return self._write_if_absent(target, copy)

    def delete_output_key(self, key: str) -> None:
        path = self.output_path(key)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            return
        parent = path.parent
        while parent != self._output_root:
            try:
                parent.rmdir()
            except OSError:
                return
            parent = parent.parent


class PrivateMediaStore(Protocol):
    """Private-storage interface; browser paths and public object URLs are absent by design."""

    def job_scope(
        self,
        job: InternalMediaJob,
        raw_job_token: str | None,
        deadline: PreparationDeadline | None = None,
    ) -> Any: ...

    def health(self) -> bool: ...

    def input_path(self, key: str) -> Path: ...

    def validate_output_prefix(self, prefix: str) -> None: ...

    def read_output_bytes(self, key: str) -> bytes | None: ...

    def put_bytes_if_absent(self, key: str, value: bytes) -> bool: ...

    def put_file_if_absent(self, key: str, source: Path) -> bool: ...

    def delete_output_key(self, key: str) -> None: ...


@dataclass
class _BridgeJobScope:
    job: InternalMediaJob
    token: str
    temporary: tempfile.TemporaryDirectory[str]
    deadline: PreparationDeadline | None


class BridgeObjectStore:
    """Container-side client for the Worker-owned, job-scoped private R2 bridge."""

    _OUTPUT_TYPES: tuple[tuple[re.Pattern[str], str, int, bool], ...] = (
        (re.compile(r"^audio/[a-f0-9]{64}\.wav$"), "audio/wav", 30 * 1024 * 1024, True),
        (re.compile(r"^waveforms/[a-f0-9]{64}\.json$"), "application/json", 8 * 1024 * 1024, True),
        (re.compile(r"^thumbnails/[a-f0-9]{64}\.webp$"), "image/webp", 64 * 1024, True),
        (re.compile(r"^manifests/[a-f0-9]{64}\.json$"), "application/json", 8 * 1024 * 1024, True),
        # Cache pointers are deterministic names; their metadata digest still
        # verifies the body, while their identity is intentionally stable.
        (re.compile(r"^indexes/[a-f0-9]{64}\.json$"), "application/json", 8 * 1024 * 1024, False),
    )

    def __init__(
        self,
        bridge_url: str,
        *,
        input_prefix: str,
        output_prefix: str,
        maximum_input_bytes: int,
        opener: Any = urllib.request.urlopen,
    ) -> None:
        _validate_private_prefix(input_prefix)
        _validate_private_prefix(output_prefix)
        parsed = urllib.parse.urlparse(bridge_url)
        if parsed.scheme != "http" or parsed.netloc != "cuebench-r2.internal" or parsed.path not in {"", "/"}:
            raise ValueError("Invalid private storage bridge configuration.")
        if maximum_input_bytes <= 0:
            raise ValueError("Invalid private storage bridge configuration.")
        self._bridge_url = bridge_url.rstrip("/")
        self._input_prefix = input_prefix
        self._output_prefix = output_prefix
        self._maximum_input_bytes = maximum_input_bytes
        self._opener = opener
        self._scope = threading.local()

    @staticmethod
    def _status(response: Any) -> int:
        status = getattr(response, "status", None)
        return status if isinstance(status, int) else int(response.getcode())

    @staticmethod
    def _header(response: Any, name: str) -> str | None:
        headers = getattr(response, "headers", None)
        value = headers.get(name) if headers is not None else None
        return value if isinstance(value, str) else None

    def _active_scope(self) -> _BridgeJobScope:
        scope = getattr(self._scope, "value", None)
        if not isinstance(scope, _BridgeJobScope):
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not access private media storage.")
        return scope

    @contextmanager
    def job_scope(
        self,
        job: InternalMediaJob,
        raw_job_token: str | None,
        deadline: PreparationDeadline | None = None,
    ) -> Any:
        if raw_job_token is None or len(raw_job_token.encode("utf-8")) > 8 * 1024:
            raise _safe_error("JOB_INVALID", 401, "CueBench could not verify the internal media job.")
        previous = getattr(self._scope, "value", None)
        scope = _BridgeJobScope(
            job=job,
            token=raw_job_token,
            temporary=tempfile.TemporaryDirectory(prefix="cuebench-bridge-"),
            deadline=deadline,
        )
        self._scope.value = scope
        try:
            yield
        finally:
            scope.temporary.cleanup()
            self._scope.value = previous

    def _url(self, key: str) -> str:
        _validate_private_key(key, self._input_prefix, require_prefix=False)
        return f"{self._bridge_url}/{urllib.parse.quote(key, safe='/')}"

    @staticmethod
    def _check_deadline(scope: _BridgeJobScope) -> None:
        if scope.deadline is not None:
            scope.deadline.check()

    def _open(self, request: urllib.request.Request, deadline: PreparationDeadline | None = None) -> Any:
        try:
            timeout = 15 if deadline is None else deadline.remaining_seconds(15)
            return self._opener(request, timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except (OSError, urllib.error.URLError):
            raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not access private media storage.") from None

    def _request(self, method: str, key: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
        scope = self._active_scope()
        self._check_deadline(scope)
        request = urllib.request.Request(
            self._url(key),
            data=data,
            method=method,
            headers={"x-cuebench-media-job": scope.token, **(headers or {})},
        )
        return self._open(request, scope.deadline)

    def health(self) -> bool:
        try:
            request = urllib.request.Request(f"{self._bridge_url}/healthz", method="HEAD")
            with self._opener(request, timeout=3) as response:
                return self._status(response) == 204
        except (OSError, urllib.error.URLError, urllib.error.HTTPError):
            return False

    def input_path(self, key: str) -> Path:
        scope = self._active_scope()
        self._check_deadline(scope)
        if key != scope.job.input_key:
            raise private_path_error()
        try:
            response = self._request("GET", key)
            with response:
                if (
                    self._status(response) != 200
                    or self._header(response, "content-type") != scope.job.input_content_type
                ):
                    raise _safe_error(
                        "INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata."
                    )
                declared = self._header(response, "content-length")
                if declared is not None and (not declared.isdecimal() or int(declared) != scope.job.input_byte_length):
                    raise _safe_error(
                        "INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata."
                    )
                target = Path(scope.temporary.name) / "input-media"
                descriptor, temporary_name = tempfile.mkstemp(prefix=".input-", suffix=".tmp", dir=scope.temporary.name)
                digest = hashlib.sha256()
                byte_length = 0
                try:
                    with os.fdopen(descriptor, "wb") as destination:
                        while chunk := response.read(1024 * 1024):
                            self._check_deadline(scope)
                            byte_length += len(chunk)
                            if byte_length > self._maximum_input_bytes:
                                raise _safe_error(
                                    "MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit."
                                )
                            digest.update(chunk)
                            destination.write(chunk)
                        destination.flush()
                        os.fsync(destination.fileno())
                    self._check_deadline(scope)
                    if byte_length != scope.job.input_byte_length:
                        raise _safe_error(
                            "INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata."
                        )
                    expected_digest = self._header(response, "x-cuebench-sha256")
                    if expected_digest is not None and (
                        not re.fullmatch(r"[a-f0-9]{64}", expected_digest)
                        or not hmac.compare_digest(expected_digest, digest.hexdigest())
                    ):
                        raise _safe_error(
                            "INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata."
                        )
                    os.replace(temporary_name, target)
                    return target
                finally:
                    Path(temporary_name).unlink(missing_ok=True)
        except MediaServiceError:
            raise
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not access private media storage.") from None

    def validate_output_prefix(self, prefix: str) -> None:
        scope = self._active_scope()
        if scope.job.action != "prepare" or prefix != scope.job.output_prefix:
            raise private_path_error()
        _validate_private_key(prefix, self._output_prefix, require_prefix=True)

    def _output_type(self, key: str) -> tuple[str, int, bool]:
        scope = self._active_scope()
        if scope.job.action != "prepare" or not key.startswith(scope.job.output_prefix):
            raise private_path_error()
        suffix = key[len(scope.job.output_prefix) :]
        for pattern, content_type, maximum_bytes, content_addressed in self._OUTPUT_TYPES:
            if pattern.fullmatch(suffix):
                return content_type, maximum_bytes, content_addressed
        raise private_path_error()

    def read_output_bytes(self, key: str) -> bytes | None:
        content_type, maximum_bytes, _ = self._output_type(key)
        scope = self._active_scope()
        self._check_deadline(scope)
        try:
            response = self._request("GET", key)
            with response:
                if self._status(response) == 404:
                    return None
                if self._status(response) != 200 or self._header(response, "content-type") != content_type:
                    raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not verify prepared media evidence.")
                value = bytes(response.read(maximum_bytes + 1))
                self._check_deadline(scope)
                if len(value) == 0 or len(value) > maximum_bytes:
                    raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not verify prepared media evidence.")
                expected = self._header(response, "x-cuebench-sha256")
                if (
                    expected is None
                    or not re.fullmatch(r"[a-f0-9]{64}", expected)
                    or not hmac.compare_digest(expected, _sha256(value))
                ):
                    raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not verify prepared media evidence.")
                return value
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not access private media storage.") from None

    def _put(self, key: str, value: bytes) -> bool:
        content_type, maximum_bytes, content_addressed = self._output_type(key)
        scope = self._active_scope()
        self._check_deadline(scope)
        digest = _sha256(value)
        if not value or len(value) > maximum_bytes:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not store prepared media evidence.")
        if content_addressed and key.rsplit("/", 1)[-1].split(".", 1)[0] != digest:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not verify prepared media evidence.")
        try:
            response = self._request(
                "PUT",
                key,
                value,
                {
                    "content-type": content_type,
                    "content-length": str(len(value)),
                    "if-none-match": "*",
                    "x-cuebench-sha256": digest,
                },
            )
            with response:
                self._check_deadline(scope)
                if self._status(response) not in {200, 201}:
                    raise _safe_error(
                        "PREPARATION_FAILED", 503, "CueBench could not safely publish prepared media evidence."
                    )
                if (
                    self._header(response, "content-type") != content_type
                    or self._header(response, "content-length") != str(len(value))
                    or self._header(response, "x-cuebench-sha256") != digest
                ):
                    raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not verify prepared media evidence.")
                return self._status(response) == 201
        except MediaServiceError:
            raise
        except (OSError, urllib.error.URLError, urllib.error.HTTPError):
            raise _safe_error("PREPARATION_FAILED", 503, "CueBench could not access private media storage.") from None

    def put_bytes_if_absent(self, key: str, value: bytes) -> bool:
        return self._put(key, value)

    def put_file_if_absent(self, key: str, source: Path) -> bool:
        content_type, maximum_bytes, _ = self._output_type(key)
        scope = self._active_scope()
        self._check_deadline(scope)
        del content_type
        try:
            if source.stat().st_size > maximum_bytes:
                raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not store prepared media evidence.")
            value = source.read_bytes()
            self._check_deadline(scope)
            return self._put(key, value)
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not store prepared media evidence.") from None

    def delete_output_key(self, key: str) -> None:
        # The bridge deliberately exposes no delete: orphaned, unpublished
        # artifacts are unreachable and the verified 24-hour lifecycle clears them.
        self._output_type(key)


class PreparationLimiter:
    def __init__(self, maximum: int) -> None:
        if maximum <= 0:
            raise ValueError("Preparation limit must be positive.")
        self._maximum = maximum
        self._active = 0
        self._lock = threading.Lock()

    def try_acquire(self) -> bool:
        with self._lock:
            if self._active >= self._maximum:
                return False
            self._active += 1
            return True

    def release(self) -> None:
        with self._lock:
            if self._active > 0:
                self._active -= 1


@dataclass
class _ReplayRecord:
    fingerprint: str
    expires_at_ms: int
    result: dict[str, object] | None = None


class InMemoryReplayLedger:
    """Protects one running instance; persistent object storage provides restart-safe output idempotence."""

    def __init__(self) -> None:
        self._records: dict[str, _ReplayRecord] = {}
        self._lock = threading.Lock()

    def claim(self, job: InternalMediaJob, now_ms: int) -> Literal["new", "in_progress"] | dict[str, object]:
        fingerprint = job_fingerprint(job)
        with self._lock:
            self._records = {key: record for key, record in self._records.items() if record.expires_at_ms > now_ms}
            previous = self._records.get(job.idempotency_key)
            if previous is None:
                self._records[job.idempotency_key] = _ReplayRecord(fingerprint, job.expires_at_ms)
                return "new"
            if previous.fingerprint != fingerprint:
                raise _safe_error("JOB_REPLAYED", 409, "CueBench rejected a replayed internal media job.")
            if previous.result is not None:
                return previous.result
            return "in_progress"

    def complete(self, job: InternalMediaJob, result: dict[str, object]) -> None:
        with self._lock:
            record = self._records.get(job.idempotency_key)
            if record is not None and record.fingerprint == job_fingerprint(job):
                record.result = result

    def abandon(self, job: InternalMediaJob) -> None:
        with self._lock:
            record = self._records.get(job.idempotency_key)
            if record is not None and record.fingerprint == job_fingerprint(job) and record.result is None:
                del self._records[job.idempotency_key]


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _metadata(probe: ProbeResult, input_sha256: str) -> dict[str, object]:
    return {
        "container": probe.container,
        "mime_type": probe.mime_type,
        "codec": probe.codec,
        "duration_ms": probe.duration_ms,
        "byte_length": probe.byte_length,
        "sha256": input_sha256,
    }


def _validate_probe(probe: ProbeResult, limits: MediaLimits) -> None:
    supported = {
        ("mp4", "video/mp4"): {"h264", "avc1", "hevc"},
        ("webm", "video/webm"): {"vp8", "vp9", "av1"},
    }
    codecs = supported.get((probe.container.lower(), probe.mime_type.lower()))
    if codecs is None or probe.codec.lower() not in codecs:
        raise _safe_error("UNSUPPORTED_MEDIA", 415, "CueBench could not prepare this media format.")
    if probe.duration_ms <= 0 or probe.duration_ms > limits.max_duration_ms:
        raise _safe_error("MEDIA_DURATION_LIMIT", 413, "CueBench rejected media outside its duration limit.")
    if probe.byte_length <= 0 or probe.byte_length > limits.max_input_bytes:
        raise _safe_error("MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit.")


def _maximum_normalized_pcm_bytes(duration_ms: int) -> int:
    # 16 kHz × mono × signed 16-bit samples plus a conservative 44-byte WAV header.
    return 44 + ((duration_ms * 16_000 * 2 + 999) // 1_000)


class MediaPreparer:
    def __init__(self, settings: MediaServiceSettings, store: PrivateMediaStore, tools: MediaTools) -> None:
        self._settings = settings
        self._store = store
        self._tools = tools

    def _deadline(self, job: InternalMediaJob) -> PreparationDeadline:
        remaining_ms = job.expires_at_ms - self._settings.clock()
        return PreparationDeadline(remaining_ms / 1_000, monotonic_clock=self._settings.monotonic_clock)

    def authoritative_facts(self, job: InternalMediaJob, raw_job_token: str | None = None) -> dict[str, object]:
        deadline = self._deadline(job)
        with self._store.job_scope(job, raw_job_token, deadline):
            return self._authoritative_facts(job, deadline)

    def _authoritative_facts(self, job: InternalMediaJob, deadline: PreparationDeadline) -> dict[str, object]:
        deadline.check()
        input_path = self._store.input_path(job.input_key)
        actual_size = input_path.stat().st_size
        deadline.check()
        if actual_size != job.input_byte_length:
            raise _safe_error("INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata.")
        if actual_size > self._settings.limits.max_input_bytes:
            raise _safe_error("MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit.")
        probe = self._tools.probe(input_path, deadline)
        _validate_probe(probe, self._settings.limits)
        if probe.mime_type != job.input_content_type:
            raise _safe_error("INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata.")
        return _metadata(probe, sha256_file(input_path, deadline))

    def _cache_key(self, job: InternalMediaJob, input_sha256: str, tool_versions: dict[str, str]) -> str:
        identity = _sha256(
            _canonical_json(
                {
                    "input_sha256": input_sha256,
                    "limits": {
                        "thumbnail_bytes": self._settings.limits.max_thumbnail_bytes,
                        "thumbnail_count": self._settings.limits.max_thumbnail_count,
                        "thumbnail_height": self._settings.limits.max_thumbnail_height,
                        "thumbnail_total_bytes": self._settings.limits.max_thumbnail_total_bytes,
                        "thumbnail_width": self._settings.limits.max_thumbnail_width,
                    },
                    "preparation_version": PREPARATION_VERSION,
                    "tools": tool_versions,
                }
            )
        )
        return f"{job.output_prefix}indexes/{identity}.json"

    def _cached_result(self, cache_key: str, deadline: PreparationDeadline) -> dict[str, object] | None:
        deadline.check()
        cached = self._store.read_output_bytes(cache_key)
        if cached is None:
            return None
        try:
            pointer = json.loads(cached)
            if not isinstance(pointer, dict) or set(pointer) != {"key", "sha256"}:
                return None
            key = pointer["key"]
            manifest_sha256 = pointer["sha256"]
            if not isinstance(key, str) or not isinstance(manifest_sha256, str):
                return None
            manifest = self._store.read_output_bytes(key)
            deadline.check()
            if manifest is None or _sha256(manifest) != manifest_sha256:
                return None
            value = json.loads(manifest)
            if not isinstance(value, dict):
                return None
            response: dict[str, object] = dict(value)
            response["manifest"] = {"key": key, "sha256": manifest_sha256}
            return response
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def prepare(self, job: InternalMediaJob, raw_job_token: str | None = None) -> dict[str, object]:
        deadline = self._deadline(job)
        with self._store.job_scope(job, raw_job_token, deadline):
            return self._prepare(job, deadline)

    def _prepare(self, job: InternalMediaJob, deadline: PreparationDeadline) -> dict[str, object]:
        deadline.check()
        input_path = self._store.input_path(job.input_key)
        self._store.validate_output_prefix(job.output_prefix)
        actual_size = input_path.stat().st_size
        deadline.check()
        if actual_size != job.input_byte_length:
            raise _safe_error("INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata.")
        if actual_size <= 0 or actual_size > self._settings.limits.max_input_bytes:
            raise _safe_error("MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit.")
        probe = self._tools.probe(input_path, deadline)
        _validate_probe(probe, self._settings.limits)
        if probe.mime_type != job.input_content_type:
            raise _safe_error("INPUT_METADATA_MISMATCH", 422, "CueBench could not verify private media metadata.")
        input_sha256 = sha256_file(input_path, deadline)
        tool_versions = self._tools.versions(deadline)
        cache_key = self._cache_key(job, input_sha256, tool_versions)
        if cached := self._cached_result(cache_key, deadline):
            return cached
        created_keys: list[str] = []
        try:
            with tempfile.TemporaryDirectory(prefix="cuebench-media-") as temporary:
                temporary_root = Path(temporary)
                normalized_path = temporary_root / "normalized.wav"
                maximum_pcm_bytes = _maximum_normalized_pcm_bytes(probe.duration_ms)
                self._tools.normalise_audio(
                    input_path,
                    normalized_path,
                    probe.duration_ms,
                    maximum_pcm_bytes,
                    deadline,
                )
                audio = normalized_audio_facts(normalized_path, deadline)
                if audio.byte_length > maximum_pcm_bytes:
                    raise _safe_error("AUDIO_LIMIT", 422, "CueBench rejected unsafe normalized media audio.")
                waveform = build_waveform_pyramid(normalized_path, maximum_bytes=maximum_pcm_bytes, deadline=deadline)
                scene_points = self._tools.detect_scenes(
                    input_path,
                    probe.duration_ms,
                    self._settings.limits.max_thumbnail_count,
                    deadline,
                )
                if any(isinstance(point, bool) or not isinstance(point, int) for point in scene_points):
                    raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence.")
                scenes = sorted({point for point in scene_points if 0 <= point < probe.duration_ms})[
                    : self._settings.limits.max_thumbnail_count
                ]
                thumbnails: list[tuple[int, bytes, int, int, str]] = []
                thumbnail_total_bytes = 0
                for index, at_ms in enumerate(scenes):
                    deadline.check()
                    thumbnail_path = temporary_root / f"thumbnail-{index}.webp"
                    self._tools.extract_thumbnail(input_path, at_ms, thumbnail_path, deadline)
                    thumbnail = thumbnail_path.read_bytes()
                    deadline.check()
                    if len(thumbnail) == 0 or len(thumbnail) > self._settings.limits.max_thumbnail_bytes:
                        raise _safe_error("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
                    thumbnail_total_bytes += len(thumbnail)
                    if thumbnail_total_bytes > self._settings.limits.max_thumbnail_total_bytes:
                        raise _safe_error("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
                    width, height = webp_dimensions(thumbnail)
                    if (
                        width > self._settings.limits.max_thumbnail_width
                        or height > self._settings.limits.max_thumbnail_height
                    ):
                        raise _safe_error("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
                    thumbnails.append((at_ms, thumbnail, width, height, _sha256(thumbnail)))

                audio_key = f"{job.output_prefix}audio/{audio.sha256}.wav"
                waveform_bytes = _canonical_json(waveform.as_dict())
                waveform_sha256 = _sha256(waveform_bytes)
                waveform_key = f"{job.output_prefix}waveforms/{waveform_sha256}.json"
                thumbnail_records = [
                    {
                        "at_ms": at_ms,
                        "key": f"{job.output_prefix}thumbnails/{thumbnail_sha256}.webp",
                        "sha256": thumbnail_sha256,
                        "mime_type": "image/webp",
                        "width": width,
                        "height": height,
                        "byte_length": len(thumbnail),
                    }
                    for at_ms, thumbnail, width, height, thumbnail_sha256 in thumbnails
                ]
                manifest_core: dict[str, object] = {
                    "contract_version": CONTRACT_VERSION,
                    "preparation_version": PREPARATION_VERSION,
                    "metadata": _metadata(probe, input_sha256),
                    "normalized_audio": audio.as_dict(audio_key),
                    "waveform": {**waveform.as_dict(), "key": waveform_key, "sha256": waveform_sha256},
                    "scenes": [{"at_ms": point} for point in scenes],
                    "thumbnails": thumbnail_records,
                    "tools": tool_versions,
                }
                manifest_bytes = _canonical_json(manifest_core)
                manifest_sha256 = _sha256(manifest_bytes)
                manifest_key = f"{job.output_prefix}manifests/{manifest_sha256}.json"
                artifacts: list[tuple[str, bytes | Path]] = [
                    (audio_key, normalized_path),
                    (waveform_key, waveform_bytes),
                ]
                artifacts.extend(
                    (f"{job.output_prefix}thumbnails/{thumbnail_sha256}.webp", thumbnail)
                    for _, thumbnail, _, _, thumbnail_sha256 in thumbnails
                )
                artifacts.append((manifest_key, manifest_bytes))
                for key, artifact in artifacts:
                    deadline.check()
                    created = (
                        self._store.put_file_if_absent(key, artifact)
                        if isinstance(artifact, Path)
                        else self._store.put_bytes_if_absent(key, artifact)
                    )
                    if created:
                        created_keys.append(key)
                pointer_bytes = _canonical_json({"key": manifest_key, "sha256": manifest_sha256})
                deadline.check()
                if self._store.put_bytes_if_absent(cache_key, pointer_bytes):
                    created_keys.append(cache_key)
                result = dict(manifest_core)
                result["manifest"] = {"key": manifest_key, "sha256": manifest_sha256}
                return result
        except MediaServiceError:
            for key in reversed(created_keys):
                self._store.delete_output_key(key)
            raise
        except Exception:
            for key in reversed(created_keys):
                self._store.delete_output_key(key)
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence.") from None


class _RequestBodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    def __init__(self, app: Any, maximum_bytes: int) -> None:
        self.app = app
        self.maximum_bytes = maximum_bytes

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("path") not in {"/v1/prepare", "/v1/probe"}:
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        content_length = headers.get("content-length")
        if content_length is not None and (not content_length.isdecimal() or int(content_length) > self.maximum_bytes):
            response = JSONResponse(
                {"error": {"code": "REQUEST_TOO_LARGE", "message": "CueBench rejected an oversized internal request."}},
                status_code=413,
            )
            await response(scope, receive, send)
            return
        consumed = 0

        async def bounded_receive() -> dict[str, Any]:
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.maximum_bytes:
                    raise _RequestBodyTooLarge()
            return cast(dict[str, Any], message)

        try:
            await self.app(scope, bounded_receive, send)
        except _RequestBodyTooLarge:
            response = JSONResponse(
                {"error": {"code": "REQUEST_TOO_LARGE", "message": "CueBench rejected an oversized internal request."}},
                status_code=413,
            )
            await response(scope, receive, send)


def _error_response(error: MediaServiceError) -> JSONResponse:
    return JSONResponse({"error": {"code": error.code, "message": error.safe_message}}, status_code=error.status_code)


def create_app(
    settings: MediaServiceSettings,
    tools: MediaTools,
    *,
    store: PrivateMediaStore | None = None,
    limiter: PreparationLimiter | None = None,
    replay_ledger: InMemoryReplayLedger | None = None,
) -> FastAPI:
    object_store = store or FileSystemObjectStore(
        settings.input_root,
        settings.output_root,
        settings.input_prefix,
        settings.output_prefix,
    )
    preparer = MediaPreparer(settings, object_store, tools)
    preparation_limiter = limiter or PreparationLimiter(settings.limits.max_concurrent_preparations)
    ledger = replay_ledger or InMemoryReplayLedger()
    app = FastAPI(title="CueBench media preparation", version=PREPARATION_VERSION, docs_url=None, redoc_url=None)
    app.add_middleware(RequestBodyLimitMiddleware, maximum_bytes=settings.limits.max_request_bytes)

    @app.exception_handler(MediaServiceError)
    async def media_error_handler(_: Request, error: MediaServiceError) -> JSONResponse:
        return _error_response(error)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": "INVALID_REQUEST", "message": "CueBench could not read the preparation request."}},
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_: Request, __: Exception) -> JSONResponse:
        return _error_response(_safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence."))

    def verified_job(request: SignedJobRequest, expected_action: Literal["probe", "prepare"]) -> InternalMediaJob:
        return verify_internal_job(
            request.job,
            settings.key_ring,
            settings.clock(),
            expected_action=expected_action,
        )

    @app.get("/healthz", response_model=None)
    async def healthz() -> dict[str, object] | JSONResponse:
        def ready() -> bool:
            if not object_store.health():
                return False
            try:
                versions = tools.versions(
                    PreparationDeadline(
                        settings.limits.command_timeout_seconds,
                        monotonic_clock=settings.monotonic_clock,
                    )
                )
            except Exception:
                return False
            return all(isinstance(versions.get(tool), str) and versions[tool] for tool in ("ffmpeg", "ffprobe"))

        if not await run_in_threadpool(ready):
            return JSONResponse(
                {"error": {"code": "SERVICE_UNAVAILABLE", "message": "CueBench media preparation is unavailable."}},
                status_code=503,
            )
        return {"status": "ok", "contract_version": CONTRACT_VERSION}

    @app.post("/v1/probe")
    async def probe(request: SignedJobRequest) -> dict[str, object]:
        job = verified_job(request, "probe")
        claimed = ledger.claim(job, settings.clock())
        if isinstance(claimed, dict):
            return claimed
        if claimed == "in_progress":
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already inspecting this media evidence.")
        if not preparation_limiter.try_acquire():
            ledger.abandon(job)
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already inspecting permitted media evidence.")
        try:
            facts = await run_in_threadpool(preparer.authoritative_facts, job, request.job)
            result = {
                "container": facts["container"],
                "mimeType": facts["mime_type"],
                "codec": facts["codec"],
                "durationMs": facts["duration_ms"],
                "byteLength": facts["byte_length"],
                "sha256": facts["sha256"],
            }
        except BaseException:
            ledger.abandon(job)
            raise
        finally:
            preparation_limiter.release()
        ledger.complete(job, result)
        return result

    @app.post("/v1/prepare")
    async def prepare(request: SignedJobRequest, raw_request: Request) -> dict[str, object]:
        def response_for(result: dict[str, object]) -> dict[str, object]:
            # Only the operation-keyed Container proxy adds this private header.
            # Direct local/test callers retain the complete service contract.
            if raw_request.headers.get("x-cuebench-media-result") != "manifest-ref":
                return result
            manifest = result.get("manifest")
            if not isinstance(manifest, dict) or set(manifest) != {"key", "sha256"}:
                raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence.")
            key = manifest.get("key")
            digest = manifest.get("sha256")
            if not isinstance(key, str) or not isinstance(digest, str):
                raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence.")
            return {"manifest": {"key": key, "sha256": digest}}

        job = verified_job(request, "prepare")
        claimed = ledger.claim(job, settings.clock())
        if isinstance(claimed, dict):
            return response_for(claimed)
        if claimed == "in_progress":
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already preparing this media evidence.")
        if not preparation_limiter.try_acquire():
            ledger.abandon(job)
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already preparing the permitted media evidence.")
        try:
            result = await run_in_threadpool(preparer.prepare, job, request.job)
        except BaseException:
            ledger.abandon(job)
            raise
        finally:
            preparation_limiter.release()
        ledger.complete(job, result)
        return response_for(result)

    return app


def create_app_from_environment() -> FastAPI:
    """Uvicorn factory: missing signing configuration fails the Container closed at startup."""

    settings = MediaServiceSettings.from_environment()
    runner = SafeCommandRunner(
        executable_paths={"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"},
        default_timeout_seconds=settings.limits.command_timeout_seconds,
        maximum_output_bytes=settings.limits.max_command_output_bytes,
    )
    bridge_url = os.environ.get("CUEBENCH_MEDIA_STORAGE_BRIDGE_URL")
    store: PrivateMediaStore | None = None
    if bridge_url:
        store = BridgeObjectStore(
            bridge_url,
            input_prefix=settings.input_prefix,
            output_prefix=settings.output_prefix,
            maximum_input_bytes=settings.limits.max_input_bytes,
        )
    return create_app(settings=settings, tools=FFmpegMediaTools(runner), store=store)
