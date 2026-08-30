from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

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
from .probe import FFmpegMediaTools, MediaTools, ProbeResult, SafeCommandRunner
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

    def _write_if_absent(self, target: Path, write: Any) -> bool:
        target.parent.mkdir(parents=True, exist_ok=True)
        self._within(self._output_root, target.parent)
        try:
            with target.open("xb") as destination:
                try:
                    write(destination)
                except BaseException:
                    destination.close()
                    target.unlink(missing_ok=True)
                    raise
            return True
        except FileExistsError:
            return False
        except OSError:
            raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not store prepared media evidence.") from None

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
            previous = self._records.get(job.operation_id)
            if previous is None:
                self._records[job.operation_id] = _ReplayRecord(fingerprint, job.expires_at_ms)
                return "new"
            if previous.fingerprint != fingerprint:
                raise _safe_error("JOB_REPLAYED", 409, "CueBench rejected a replayed internal media job.")
            if previous.result is not None:
                return previous.result
            return "in_progress"

    def complete(self, job: InternalMediaJob, result: dict[str, object]) -> None:
        with self._lock:
            record = self._records.get(job.operation_id)
            if record is not None and record.fingerprint == job_fingerprint(job):
                record.result = result

    def abandon(self, job: InternalMediaJob) -> None:
        with self._lock:
            record = self._records.get(job.operation_id)
            if record is not None and record.fingerprint == job_fingerprint(job) and record.result is None:
                del self._records[job.operation_id]


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


class MediaPreparer:
    def __init__(self, settings: MediaServiceSettings, store: FileSystemObjectStore, tools: MediaTools) -> None:
        self._settings = settings
        self._store = store
        self._tools = tools

    def authoritative_facts(self, job: InternalMediaJob) -> dict[str, object]:
        input_path = self._store.input_path(job.input_key)
        self._store.validate_output_prefix(job.output_prefix)
        if input_path.stat().st_size > self._settings.limits.max_input_bytes:
            raise _safe_error("MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit.")
        probe = self._tools.probe(input_path)
        _validate_probe(probe, self._settings.limits)
        return _metadata(probe, sha256_file(input_path))

    def _cache_key(self, job: InternalMediaJob, input_sha256: str, tool_versions: dict[str, str]) -> str:
        identity = _sha256(
            _canonical_json(
                {
                    "input_sha256": input_sha256,
                    "limits": {
                        "thumbnail_bytes": self._settings.limits.max_thumbnail_bytes,
                        "thumbnail_count": self._settings.limits.max_thumbnail_count,
                        "thumbnail_height": self._settings.limits.max_thumbnail_height,
                        "thumbnail_width": self._settings.limits.max_thumbnail_width,
                    },
                    "preparation_version": PREPARATION_VERSION,
                    "tools": tool_versions,
                }
            )
        )
        return f"{job.output_prefix}indexes/{identity}.json"

    def _cached_result(self, cache_key: str) -> dict[str, object] | None:
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

    def prepare(self, job: InternalMediaJob) -> dict[str, object]:
        input_path = self._store.input_path(job.input_key)
        self._store.validate_output_prefix(job.output_prefix)
        actual_size = input_path.stat().st_size
        if actual_size <= 0 or actual_size > self._settings.limits.max_input_bytes:
            raise _safe_error("MEDIA_SIZE_LIMIT", 413, "CueBench rejected media outside its size limit.")
        probe = self._tools.probe(input_path)
        _validate_probe(probe, self._settings.limits)
        input_sha256 = sha256_file(input_path)
        tool_versions = self._tools.versions()
        cache_key = self._cache_key(job, input_sha256, tool_versions)
        if cached := self._cached_result(cache_key):
            return cached
        created_keys: list[str] = []
        try:
            with tempfile.TemporaryDirectory(prefix="cuebench-media-") as temporary:
                temporary_root = Path(temporary)
                normalized_path = temporary_root / "normalized.wav"
                self._tools.normalise_audio(input_path, normalized_path)
                audio = normalized_audio_facts(normalized_path)
                waveform = build_waveform_pyramid(normalized_path)
                scene_points = self._tools.detect_scenes(
                    input_path,
                    probe.duration_ms,
                    self._settings.limits.max_thumbnail_count,
                )
                if any(isinstance(point, bool) or not isinstance(point, int) for point in scene_points):
                    raise _safe_error("PREPARATION_FAILED", 500, "CueBench could not prepare media evidence.")
                scenes = sorted({point for point in scene_points if 0 <= point < probe.duration_ms})[
                    : self._settings.limits.max_thumbnail_count
                ]
                thumbnails: list[tuple[int, bytes, int, int, str]] = []
                for index, at_ms in enumerate(scenes):
                    thumbnail_path = temporary_root / f"thumbnail-{index}.webp"
                    self._tools.extract_thumbnail(input_path, at_ms, thumbnail_path)
                    thumbnail = thumbnail_path.read_bytes()
                    if len(thumbnail) == 0 or len(thumbnail) > self._settings.limits.max_thumbnail_bytes:
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
                    created = (
                        self._store.put_file_if_absent(key, artifact)
                        if isinstance(artifact, Path)
                        else self._store.put_bytes_if_absent(key, artifact)
                    )
                    if created:
                        created_keys.append(key)
                pointer_bytes = _canonical_json({"key": manifest_key, "sha256": manifest_sha256})
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
    store: FileSystemObjectStore | None = None,
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

    def verified_job(request: SignedJobRequest) -> InternalMediaJob:
        return verify_internal_job(request.job, settings.key_ring, settings.clock())

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"status": "ok", "contract_version": CONTRACT_VERSION}

    @app.post("/v1/probe")
    async def probe(request: SignedJobRequest) -> dict[str, object]:
        job = verified_job(request)
        facts = await run_in_threadpool(preparer.authoritative_facts, job)
        return {
            "container": facts["container"],
            "mimeType": facts["mime_type"],
            "codec": facts["codec"],
            "durationMs": facts["duration_ms"],
            "byteLength": facts["byte_length"],
            "sha256": facts["sha256"],
        }

    @app.post("/v1/prepare")
    async def prepare(request: SignedJobRequest) -> dict[str, object]:
        job = verified_job(request)
        claimed = ledger.claim(job, settings.clock())
        if isinstance(claimed, dict):
            return claimed
        if claimed == "in_progress":
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already preparing this media evidence.")
        if not preparation_limiter.try_acquire():
            ledger.abandon(job)
            raise _safe_error("SERVICE_BUSY", 429, "CueBench is already preparing the permitted media evidence.")
        try:
            result = await run_in_threadpool(preparer.prepare, job)
        except BaseException:
            ledger.abandon(job)
            raise
        finally:
            preparation_limiter.release()
        ledger.complete(job, result)
        return result

    return app


def create_app_from_environment() -> FastAPI:
    """Uvicorn factory: missing signing configuration fails the Container closed at startup."""

    settings = MediaServiceSettings.from_environment()
    runner = SafeCommandRunner(
        executable_paths={"ffmpeg": "ffmpeg", "ffprobe": "ffprobe"},
        default_timeout_seconds=settings.limits.command_timeout_seconds,
        maximum_output_bytes=settings.limits.max_command_output_bytes,
    )
    return create_app(settings=settings, tools=FFmpegMediaTools(runner))
