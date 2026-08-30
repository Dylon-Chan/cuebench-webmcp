from __future__ import annotations

import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .models import MediaServiceError


class DeadlineCheck(Protocol):
    def check(self) -> None: ...


@dataclass(frozen=True)
class PeakBucket:
    minimum: int
    maximum: int

    def as_dict(self) -> dict[str, int]:
        return {"min": self.minimum, "max": self.maximum}


@dataclass(frozen=True)
class PeakLevel:
    resolution_ms: int
    buckets: tuple[PeakBucket, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "bucket_ms": self.resolution_ms,
            "buckets": [bucket.as_dict() for bucket in self.buckets],
        }


@dataclass(frozen=True)
class WaveformPyramid:
    bucket_ms: int
    levels: tuple[PeakLevel, ...]

    def as_dict(self) -> dict[str, object]:
        return {"bucket_ms": self.bucket_ms, "levels": [level.as_dict() for level in self.levels]}


def _coarser_level(level: PeakLevel) -> PeakLevel:
    buckets: list[PeakBucket] = []
    for index in range(0, len(level.buckets), 2):
        pair = level.buckets[index : index + 2]
        buckets.append(PeakBucket(min(bucket.minimum for bucket in pair), max(bucket.maximum for bucket in pair)))
    return PeakLevel(level.resolution_ms * 2, tuple(buckets))


def build_waveform_pyramid(
    path: Path,
    bucket_ms: int = 10,
    maximum_bytes: int | None = None,
    deadline: DeadlineCheck | None = None,
) -> WaveformPyramid:
    """Streams bounded normalized PCM once, then derives coarser levels from base peaks."""

    try:
        if maximum_bytes is not None and (maximum_bytes <= 44 or path.stat().st_size > maximum_bytes):
            raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
        with wave.open(str(path), "rb") as source:
            sample_rate = source.getframerate()
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getcomptype() != "NONE":
                raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
            samples_per_bucket, remainder = divmod(sample_rate * bucket_ms, 1_000)
            if samples_per_bucket <= 0 or remainder != 0:
                raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
            base_buckets: list[PeakBucket] = []
            samples_in_bucket = 0
            current_min = 32_767
            current_max = -32_768
            consumed_bytes = 0
            while True:
                if deadline is not None:
                    deadline.check()
                frames = source.readframes(8_192)
                if not frames:
                    break
                consumed_bytes += len(frames)
                if maximum_bytes is not None and consumed_bytes + 44 > maximum_bytes:
                    raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
                if len(frames) % 2:
                    raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
                for (sample,) in struct.iter_unpack("<h", frames):
                    current_min = min(current_min, sample)
                    current_max = max(current_max, sample)
                    samples_in_bucket += 1
                    if samples_in_bucket == samples_per_bucket:
                        base_buckets.append(PeakBucket(current_min, current_max))
                        samples_in_bucket = 0
                        current_min = 32_767
                        current_max = -32_768
            if samples_in_bucket:
                base_buckets.append(PeakBucket(current_min, current_max))
    except (OSError, wave.Error):
        raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.") from None
    if not base_buckets:
        raise MediaServiceError("AUDIO_INVALID", 422, "CueBench could not read normalized media audio.")
    levels = [PeakLevel(bucket_ms, tuple(base_buckets))]
    while len(levels[-1].buckets) > 1:
        levels.append(_coarser_level(levels[-1]))
    return WaveformPyramid(bucket_ms=bucket_ms, levels=tuple(levels))
