from __future__ import annotations

import hashlib
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .models import MediaServiceError


class DeadlineCheck(Protocol):
    def check(self) -> None: ...


def sha256_file(path: Path, deadline: DeadlineCheck | None = None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            if deadline is not None:
                deadline.check()
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class NormalizedAudioFacts:
    sha256: str
    byte_length: int
    sample_rate_hz: int
    channels: int
    codec: str

    def as_dict(self, key: str) -> dict[str, object]:
        return {
            "key": key,
            "sha256": self.sha256,
            "byte_length": self.byte_length,
            "sample_rate_hz": self.sample_rate_hz,
            "channels": self.channels,
            "codec": self.codec,
        }


def normalized_audio_facts(path: Path, deadline: DeadlineCheck | None = None) -> NormalizedAudioFacts:
    try:
        with wave.open(str(path), "rb") as source:
            if (
                source.getnchannels() != 1
                or source.getsampwidth() != 2
                or source.getframerate() != 16_000
                or source.getcomptype() != "NONE"
            ):
                raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
    except (OSError, wave.Error):
        raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.") from None
    return NormalizedAudioFacts(
        sha256=sha256_file(path, deadline),
        byte_length=path.stat().st_size,
        sample_rate_hz=16_000,
        channels=1,
        codec="pcm_s16le",
    )
