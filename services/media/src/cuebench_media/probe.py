from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import BinaryIO, Protocol

from .models import MediaServiceError
from .scenes import parse_scene_timestamps


class CommandExecutionError(Exception):
    """Does not retain argv, paths, stdout, or stderr because those may contain private media data."""

    def __init__(self, message: str = "CueBench's fixed media tool could not complete.") -> None:
        super().__init__(message)


class CommandTimeoutError(CommandExecutionError):
    def __init__(self) -> None:
        super().__init__("CueBench's fixed media tool exceeded its preparation time limit.")


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


class CommandRunner(Protocol):
    def run(self, argv: list[str], timeout_seconds: float | None = None) -> CommandResult: ...


class _BoundedCapture:
    def __init__(self, maximum_bytes: int) -> None:
        self._maximum_bytes = maximum_bytes
        self.value = bytearray()
        self.truncated = False

    def consume(self, stream: BinaryIO) -> None:
        while True:
            chunk = stream.read(8_192)
            if not chunk:
                return
            remaining = self._maximum_bytes - len(self.value)
            if remaining > 0:
                self.value.extend(chunk[:remaining])
            if len(chunk) > max(remaining, 0):
                self.truncated = True


class SafeCommandRunner:
    """Runs only fixed executable aliases with argv arrays and bounded pipe capture."""

    def __init__(
        self,
        *,
        executable_paths: Mapping[str, str],
        default_timeout_seconds: float,
        maximum_output_bytes: int,
    ) -> None:
        if not executable_paths or default_timeout_seconds <= 0 or maximum_output_bytes <= 0:
            raise ValueError("Invalid fixed-command runner configuration.")
        self._executable_paths = dict(executable_paths)
        self._default_timeout_seconds = default_timeout_seconds
        self._maximum_output_bytes = maximum_output_bytes

    @staticmethod
    def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
                return
            except ProcessLookupError:
                return
        process.kill()

    def run(self, argv: list[str], timeout_seconds: float | None = None) -> CommandResult:
        if not argv or any(not isinstance(argument, str) or "\x00" in argument for argument in argv):
            raise CommandExecutionError()
        executable = self._executable_paths.get(argv[0])
        if executable is None:
            raise CommandExecutionError()
        timeout = self._default_timeout_seconds if timeout_seconds is None else timeout_seconds
        if timeout <= 0:
            raise CommandExecutionError()
        try:
            process = subprocess.Popen(
                [executable, *argv[1:]],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=True,
                start_new_session=True,
            )
        except OSError:
            raise CommandExecutionError() from None
        assert process.stdout is not None
        assert process.stderr is not None
        stdout_capture = _BoundedCapture(self._maximum_output_bytes)
        stderr_capture = _BoundedCapture(self._maximum_output_bytes)
        stdout_thread = threading.Thread(target=stdout_capture.consume, args=(process.stdout,), daemon=True)
        stderr_thread = threading.Thread(target=stderr_capture.consume, args=(process.stderr,), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        try:
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._kill_process_group(process)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
            stdout_thread.join(timeout=2)
            stderr_thread.join(timeout=2)
            process.stdout.close()
            process.stderr.close()
            raise CommandTimeoutError() from None
        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)
        process.stdout.close()
        process.stderr.close()
        if stdout_thread.is_alive() or stderr_thread.is_alive() or returncode != 0:
            raise CommandExecutionError()
        return CommandResult(
            returncode=returncode,
            stdout=bytes(stdout_capture.value),
            stderr=bytes(stderr_capture.value),
            stdout_truncated=stdout_capture.truncated,
            stderr_truncated=stderr_capture.truncated,
        )


@dataclass(frozen=True)
class ProbeResult:
    container: str
    mime_type: str
    codec: str
    duration_ms: int
    byte_length: int


class MediaTools(Protocol):
    def probe(self, input_path: Path) -> ProbeResult: ...

    def normalise_audio(self, input_path: Path, output_path: Path) -> None: ...

    def detect_scenes(self, input_path: Path, duration_ms: int, maximum_count: int) -> list[int]: ...

    def extract_thumbnail(self, input_path: Path, at_ms: int, output_path: Path) -> None: ...

    def versions(self) -> dict[str, str]: ...


def _tool_error() -> MediaServiceError:
    return MediaServiceError("UNSUPPORTED_MEDIA", 415, "CueBench could not read this video as supported media.")


def _integer_duration_ms(value: object) -> int:
    if not isinstance(value, str):
        raise _tool_error()
    try:
        duration_ms = int((Decimal(value) * 1_000).to_integral_value(rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        raise _tool_error() from None
    if duration_ms <= 0:
        raise _tool_error()
    return duration_ms


def _integer_size(value: object) -> int:
    if not isinstance(value, str) or not value.isdecimal():
        raise _tool_error()
    size = int(value)
    if size <= 0:
        raise _tool_error()
    return size


class FFmpegMediaTools:
    """The only production adapter permitted to invoke FFprobe and FFmpeg."""

    def __init__(self, runner: CommandRunner) -> None:
        self._runner = runner

    def probe(self, input_path: Path) -> ProbeResult:
        try:
            output = self._runner.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=format_name,duration,size:stream=codec_type,codec_name",
                    "-of",
                    "json",
                    str(input_path),
                ]
            )
            if output.stdout_truncated:
                raise _tool_error()
            decoded = json.loads(output.stdout)
        except (CommandExecutionError, json.JSONDecodeError, UnicodeDecodeError):
            raise _tool_error() from None
        if not isinstance(decoded, dict):
            raise _tool_error()
        format_data = decoded.get("format")
        streams = decoded.get("streams")
        if not isinstance(format_data, dict) or not isinstance(streams, list):
            raise _tool_error()
        format_name = format_data.get("format_name")
        if not isinstance(format_name, str) or not format_name:
            raise _tool_error()
        names = {name.strip().lower() for name in format_name.split(",") if name.strip()}
        if "mp4" in names:
            container, mime_type = "mp4", "video/mp4"
        elif "webm" in names:
            container, mime_type = "webm", "video/webm"
        else:
            container, mime_type = next(iter(names), "unknown"), "application/octet-stream"
        codec: str | None = None
        for stream in streams:
            if (
                isinstance(stream, dict)
                and stream.get("codec_type") == "video"
                and isinstance(stream.get("codec_name"), str)
            ):
                codec = stream["codec_name"].lower()
                break
        if codec is None:
            raise _tool_error()
        duration_ms = _integer_duration_ms(format_data.get("duration"))
        reported_size = _integer_size(format_data.get("size"))
        try:
            actual_size = input_path.stat().st_size
        except OSError:
            raise _tool_error() from None
        if actual_size <= 0 or reported_size != actual_size:
            raise _tool_error()
        return ProbeResult(container, mime_type, codec, duration_ms, actual_size)

    def normalise_audio(self, input_path: Path, output_path: Path) -> None:
        try:
            self._runner.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    str(input_path),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    "-f",
                    "wav",
                    "-y",
                    str(output_path),
                ]
            )
        except CommandTimeoutError:
            raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.") from None
        except CommandExecutionError:
            raise _tool_error() from None

    def detect_scenes(self, input_path: Path, duration_ms: int, maximum_count: int) -> list[int]:
        try:
            result = self._runner.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-v",
                    "info",
                    "-i",
                    str(input_path),
                    "-filter:v",
                    "select='gt(scene,0.35)',showinfo",
                    "-frames:v",
                    str(maximum_count),
                    "-an",
                    "-f",
                    "null",
                    "-",
                ]
            )
        except CommandTimeoutError:
            raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.") from None
        except CommandExecutionError:
            raise _tool_error() from None
        return parse_scene_timestamps(result.stderr, duration_ms, maximum_count)

    def extract_thumbnail(self, input_path: Path, at_ms: int, output_path: Path) -> None:
        seek_seconds = f"{at_ms / 1_000:.3f}"
        try:
            self._runner.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-v",
                    "error",
                    "-ss",
                    seek_seconds,
                    "-i",
                    str(input_path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=320:180:force_original_aspect_ratio=decrease",
                    "-c:v",
                    "libwebp",
                    "-compression_level",
                    "4",
                    "-q:v",
                    "70",
                    "-fs",
                    "65536",
                    "-f",
                    "webp",
                    "-y",
                    str(output_path),
                ]
            )
        except CommandTimeoutError:
            raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.") from None
        except CommandExecutionError:
            raise _tool_error() from None

    def versions(self) -> dict[str, str]:
        versions: dict[str, str] = {}
        try:
            for executable in ("ffmpeg", "ffprobe"):
                result = self._runner.run([executable, "-version"])
                if result.stdout_truncated or not result.stdout:
                    raise CommandExecutionError()
                versions[executable] = result.stdout.decode("ascii", errors="replace").splitlines()[0]
        except CommandTimeoutError:
            raise MediaServiceError("PROCESSING_TIMEOUT", 504, "CueBench's media preparation timed out.") from None
        except CommandExecutionError:
            raise MediaServiceError(
                "PREPARATION_FAILED",
                500,
                "CueBench could not initialize media preparation.",
            ) from None
        return versions
