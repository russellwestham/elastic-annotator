from __future__ import annotations

from typing import Optional


def timestamp_to_seconds(value: str | float | int | None) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return None

    parts = text.split(":")
    if len(parts) == 2:
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return float(text)


def seconds_to_timestamp(seconds: float | None) -> Optional[str]:
    if seconds is None:
        return None
    sec = float(seconds)
    if sec < 0:
        sec = 0.0
    minutes = int(sec // 60)
    rem = sec % 60
    return f"{minutes:02d}:{rem:05.2f}"


def frame_to_timestamp(frame_id: int | float | None, fps: float) -> Optional[str]:
    if frame_id is None:
        return None
    return seconds_to_timestamp(float(frame_id) / float(fps))
