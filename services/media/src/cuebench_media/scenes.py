from __future__ import annotations

import re
import struct
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .models import MediaServiceError

_PTS_TIME = re.compile(rb"pts_time:([0-9]+(?:\.[0-9]+)?)")


def parse_scene_timestamps(stderr: bytes, duration_ms: int, maximum_count: int) -> list[int]:
    """Returns unique, bounded integer media times parsed from FFmpeg's fixed showinfo filter."""

    timestamps: list[int] = []
    seen: set[int] = set()
    for match in _PTS_TIME.finditer(stderr):
        try:
            at_ms = int((Decimal(match.group(1).decode("ascii")) * 1_000).to_integral_value(rounding=ROUND_HALF_UP))
        except (InvalidOperation, ValueError):
            continue
        if at_ms < 0 or at_ms >= duration_ms or at_ms in seen:
            continue
        seen.add(at_ms)
        timestamps.append(at_ms)
        if len(timestamps) == maximum_count:
            break
    return timestamps


def representative_scene_timestamps(timestamps: list[int], maximum_count: int) -> list[int]:
    """Chooses bounded thumbnails across the full already-bounded scene timeline."""

    if maximum_count <= 0:
        raise ValueError("Maximum scene thumbnail count must be positive.")
    if len(timestamps) <= maximum_count:
        return list(timestamps)
    if maximum_count == 1:
        return [timestamps[0]]
    # Integer interpolation preserves the first and final detected cut, so a
    # late scene is not silently lost merely because early cuts are denser.
    positions = [round(index * (len(timestamps) - 1) / (maximum_count - 1)) for index in range(maximum_count)]
    return [timestamps[position] for position in positions]


def webp_dimensions(value: bytes) -> tuple[int, int]:
    """Reads a WebP canvas header without decoding a full frame into memory."""

    if len(value) < 20 or value[:4] != b"RIFF" or value[8:12] != b"WEBP":
        raise MediaServiceError("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
    declared_size = struct.unpack_from("<I", value, 4)[0]
    if declared_size + 8 > len(value):
        raise MediaServiceError("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
    offset = 12
    while offset + 8 <= len(value):
        kind = value[offset : offset + 4]
        length = struct.unpack_from("<I", value, offset + 4)[0]
        data_start = offset + 8
        data_end = data_start + length
        if data_end > len(value):
            break
        payload = value[data_start:data_end]
        if kind == b"VP8X" and len(payload) >= 10:
            return int.from_bytes(payload[4:7], "little") + 1, int.from_bytes(payload[7:10], "little") + 1
        if kind == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
            return struct.unpack_from("<H", payload, 6)[0] & 0x3FFF, struct.unpack_from("<H", payload, 8)[0] & 0x3FFF
        if kind == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
            bits = int.from_bytes(payload[1:5], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        offset = data_end + (length % 2)
    raise MediaServiceError("THUMBNAIL_LIMIT", 422, "CueBench rejected unsafe evidence thumbnail output.")
