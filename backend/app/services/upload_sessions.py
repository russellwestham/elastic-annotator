from __future__ import annotations

import csv
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from backend.app.core.constants import ERROR_TYPES
from backend.app.services.session_store import SessionStore
from backend.app.utils.timecode import frame_to_timestamp, timestamp_to_seconds

DEFAULT_FPS = 25.0
TIMING_MAPPING_FPS = 25.0
VIDEO_FRAME_RANGE_PATTERN = re.compile(r"(?:^|[_-])(\d+)-(\d+)$")
CSV_EXPORT_COLUMNS = [
    "period_id",
    "spadl_type",
    "player_id",
    "synced_ts",
    "receiver_id",
    "receive_ts",
    "outcome",
    "error_type",
    "note",
    "synced_frame_id",
    "receive_frame_id",
    "id",
]


def _normalize_header(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower())
    return text.strip("_")


FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "id": ("id", "event_id"),
    "period_id": ("period_id", "period", "half", "periodid"),
    "spadl_type": ("spadl_type", "type", "event_type", "spadl"),
    "player_id": ("player_id", "player", "actor", "object_id", "playerid"),
    "synced_ts": ("synced_ts", "timestamp", "time", "synced_time"),
    "receiver_id": ("receiver_id", "receiver", "recipient", "receiverid"),
    "receive_ts": ("receive_ts", "receive_time", "receiver_ts"),
    "outcome": ("outcome", "success", "successful"),
    "error_type": ("error_type", "error"),
    "note": ("note", "notes", "comment"),
    "synced_frame_id": ("synced_frame_id", "frame_id", "frame", "syncedframeid"),
    "receive_frame_id": ("receive_frame_id", "receiver_frame_id", "receiveframeid"),
}


class UploadSessionService:
    def __init__(self, store: SessionStore) -> None:
        self.store = store

    @staticmethod
    def _sanitize_name(value: str | None) -> str:
        text = re.sub(r"[^a-zA-Z0-9._-]+", "_", (value or "").strip()).strip("._-")
        return text or "uploaded"

    @staticmethod
    def _parse_bool(raw: str | None) -> bool | None:
        text = (raw or "").strip().lower()
        if not text:
            return None
        if text in {"1", "true", "t", "yes", "y", "success", "successful"}:
            return True
        if text in {"0", "false", "f", "no", "n", "fail", "failed"}:
            return False
        return None

    @staticmethod
    def _parse_int(raw: str | None) -> int | None:
        text = (raw or "").strip()
        if not text:
            return None
        try:
            return int(round(float(text)))
        except ValueError:
            return None

    @staticmethod
    def _parse_positive_float(raw: Any) -> float | None:
        if raw is None:
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        if value <= 0:
            return None
        return round(value, 3)

    @staticmethod
    def _parse_positive_int(raw: Any) -> int | None:
        if raw is None:
            return None
        try:
            value = int(round(float(raw)))
        except (TypeError, ValueError):
            return None
        if value <= 0:
            return None
        return value

    @staticmethod
    def _parse_nonnegative_float(raw: Any) -> float | None:
        if raw is None:
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        if value < 0:
            return None
        return round(value, 3)

    @staticmethod
    def _copy_upload(file: UploadFile, target_path: Path) -> None:
        with target_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

    @staticmethod
    def _probe_video_fps(video_path: Path) -> float:
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            return DEFAULT_FPS

        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=avg_frame_rate",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(video_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            value = result.stdout.strip()
            if not value:
                return DEFAULT_FPS
            if "/" in value:
                num, den = value.split("/", 1)
                fps = float(num) / float(den)
            else:
                fps = float(value)
            if fps <= 0:
                return DEFAULT_FPS
            return round(fps, 3)
        except Exception:
            return DEFAULT_FPS

    @staticmethod
    def _probe_video_duration_seconds(video_path: Path) -> float | None:
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            return None

        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(video_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            value = result.stdout.strip()
            if not value:
                return None
            seconds = float(value)
            if seconds <= 0:
                return None
            return round(seconds, 3)
        except Exception:
            return None

    @staticmethod
    def _extract_frame_range_from_filename(filename: str | None, fps: float) -> tuple[int, int] | None:
        stem = Path(filename or "").stem
        match = VIDEO_FRAME_RANGE_PATTERN.search(stem) or re.search(r"(\d+)-(\d+)", stem)
        if not match:
            return None

        try:
            start_frame = int(match.group(1))
            end_frame = int(match.group(2))
            if end_frame < start_frame:
                return None
            return start_frame, end_frame
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _extract_start_frame_from_filename(filename: str | None, fps: float) -> int | None:
        frame_range = UploadSessionService._extract_frame_range_from_filename(filename, fps)
        if frame_range is None:
            return None
        return frame_range[0]

    @staticmethod
    def _min_event_frame(events: list[dict[str, Any]]) -> int | None:
        frames: list[int] = []
        for event in events:
            synced_frame = event.get("synced_frame_id")
            if isinstance(synced_frame, (int, float)):
                frames.append(int(synced_frame))

        if not frames:
            for event in events:
                receive_frame = event.get("receive_frame_id")
                if isinstance(receive_frame, (int, float)):
                    frames.append(int(receive_frame))

        return min(frames) if frames else None

    def _recommend_video_start_frame(
        self,
        *,
        original_video_filename: str,
        events: list[dict[str, Any]],
        fps: float,
        video_duration_seconds: float | None,
    ) -> tuple[int, str, int | None]:
        filename_start = self._extract_start_frame_from_filename(original_video_filename, fps)
        video_frame_count = (
            max(1, int(round(video_duration_seconds * fps)))
            if video_duration_seconds is not None and fps > 0
            else None
        )
        if filename_start is not None:
            return filename_start, "filename", video_frame_count

        csv_min_frame = self._min_event_frame(events)
        if csv_min_frame is not None and video_frame_count is not None:
            return (csv_min_frame // video_frame_count) * video_frame_count, "duration", video_frame_count

        return 0, "fallback", video_frame_count

    @staticmethod
    def _artifact_url(session_id: str, filename: str) -> str:
        return f"/artifacts/sessions/{session_id}/{filename}"

    def _artifact_path_for_url(self, session_id: str, url: str | None) -> Path | None:
        prefix = self._artifact_url(session_id, "")
        normalized = str(url or "").strip()
        if not normalized or not normalized.startswith(prefix):
            return None
        filename = normalized[len(prefix):].split("?", 1)[0].strip("/")
        if not filename:
            return None
        return self.store.session_dir(session_id) / filename

    @staticmethod
    def _segment_end_frame(segment: dict[str, Any]) -> int | None:
        start_frame = UploadSessionService._effective_segment_start_frame(segment)
        frame_count = UploadSessionService._segment_mapping_frame_count(segment)
        if start_frame is None or frame_count is None:
            return None
        return start_frame + frame_count - 1

    @staticmethod
    def _segment_sort_key(segment: dict[str, Any]) -> tuple[int, str, str]:
        start_frame = UploadSessionService._effective_segment_start_frame(segment)
        created_at = str(segment.get("created_at") or "")
        segment_id = str(segment.get("id") or "")
        if start_frame is None:
            start_frame = 0
        return start_frame, created_at, segment_id

    @staticmethod
    def _derive_start_frame(period_start_frame: int | None, video_start_time_seconds: float | None) -> int | None:
        if period_start_frame is None or video_start_time_seconds is None:
            return None
        return max(0, int(round(period_start_frame + video_start_time_seconds * TIMING_MAPPING_FPS)))

    @staticmethod
    def _segment_mapping_frame_count(segment: dict[str, Any]) -> int | None:
        duration_seconds = segment.get("duration_seconds")
        if isinstance(duration_seconds, (int, float)) and duration_seconds > 0:
            return max(1, int(round(float(duration_seconds) * TIMING_MAPPING_FPS)))
        frame_count = segment.get("frame_count")
        if isinstance(frame_count, int) and frame_count > 0:
            return frame_count
        return None

    @staticmethod
    def _effective_segment_start_frame(segment: dict[str, Any]) -> int | None:
        period_start_frame = segment.get("period_start_frame")
        video_start_time_seconds = segment.get("video_start_time_seconds")
        if isinstance(period_start_frame, int) and isinstance(video_start_time_seconds, (int, float)):
            return UploadSessionService._derive_start_frame(period_start_frame, float(video_start_time_seconds))

        start_frame = segment.get("start_frame")
        if isinstance(start_frame, int):
            return start_frame
        return None

    @staticmethod
    def _unique_video_urls(metadata: dict[str, Any]) -> list[str]:
        values: list[str] = []
        seen: set[str] = set()
        for candidate in [metadata.get("video_url"), *(metadata.get("video_urls") or [])]:
            text = str(candidate or "").strip()
            if not text or text in seen:
                continue
            values.append(text)
            seen.add(text)
        return values

    def _normalize_segment_payload(
        self,
        session_id: str,
        raw_segment: dict[str, Any],
        *,
        default_created_at: str,
        default_fps: float | None,
        prefer_filename_range: bool = False,
    ) -> dict[str, Any] | None:
        url = str(raw_segment.get("url") or "").strip()
        if not url:
            return None

        original_filename = str(raw_segment.get("original_filename") or "").strip() or Path(url.split("?", 1)[0]).name
        fps = self._parse_positive_float(raw_segment.get("fps")) or default_fps or DEFAULT_FPS
        frame_range = self._extract_frame_range_from_filename(original_filename, fps)
        raw_period_start_frame = raw_segment.get("period_start_frame")
        period_start_frame = self._parse_int(None if raw_period_start_frame is None else str(raw_period_start_frame))
        if period_start_frame is not None and period_start_frame < 0:
            period_start_frame = None
        video_start_time_seconds = self._parse_nonnegative_float(raw_segment.get("video_start_time_seconds"))
        derived_start_frame = self._derive_start_frame(period_start_frame, video_start_time_seconds)
        timing_confirmed = bool(raw_segment.get("timing_confirmed")) or derived_start_frame is not None
        raw_start_frame = raw_segment.get("start_frame")
        start_frame = self._parse_int(None if raw_start_frame is None else str(raw_start_frame))
        if derived_start_frame is not None:
            start_frame = derived_start_frame
        elif prefer_filename_range and frame_range is not None:
            start_frame = frame_range[0]
        elif start_frame is None and frame_range is not None:
            start_frame = frame_range[0]
        if start_frame is None or start_frame < 0:
            start_frame = 0

        frame_count = self._parse_positive_int(raw_segment.get("frame_count"))
        if prefer_filename_range and frame_range is not None:
            frame_count = frame_range[1] - frame_range[0] + 1
        elif frame_count is None and frame_range is not None:
            frame_count = frame_range[1] - frame_range[0] + 1

        duration_seconds = self._parse_positive_float(raw_segment.get("duration_seconds"))
        if prefer_filename_range and frame_count is not None and fps is not None:
            duration_seconds = round(frame_count / fps, 3)
        elif duration_seconds is None and frame_count is not None and fps is not None:
            duration_seconds = round(frame_count / fps, 3)
        if frame_count is None and duration_seconds is not None and fps is not None:
            frame_count = max(1, int(round(duration_seconds * fps)))

        created_at = str(raw_segment.get("created_at") or default_created_at or datetime.now(tz=timezone.utc).isoformat())
        segment_id = str(raw_segment.get("id") or "").strip() or uuid4().hex[:12]

        return {
            "id": segment_id,
            "url": url,
            "original_filename": original_filename or None,
            "start_frame": start_frame,
            "period_start_frame": period_start_frame,
            "video_start_time_seconds": video_start_time_seconds,
            "timing_confirmed": timing_confirmed,
            "frame_count": frame_count,
            "duration_seconds": duration_seconds,
            "fps": fps,
            "created_at": created_at,
        }

    def normalize_video_segments(self, session_id: str, metadata: dict[str, Any]) -> list[dict[str, Any]]:
        default_created_at = str(metadata.get("updated_at") or metadata.get("created_at") or datetime.now(tz=timezone.utc).isoformat())
        default_fps = self._parse_positive_float(metadata.get("fps"))
        raw_segments = metadata.get("video_segments") or []
        normalized: list[dict[str, Any]] = []
        session_mode = str(metadata.get("session_mode") or "")

        if isinstance(raw_segments, list) and raw_segments:
            for item in raw_segments:
                if not isinstance(item, dict):
                    continue
                segment_id = str(item.get("id") or "").strip()
                has_manual_timing = bool(item.get("timing_confirmed")) or (
                    item.get("period_start_frame") is not None and item.get("video_start_time_seconds") is not None
                )
                segment = self._normalize_segment_payload(
                    session_id,
                    item,
                    default_created_at=default_created_at,
                    default_fps=default_fps,
                    prefer_filename_range=(
                        session_mode == "legacy_elastic"
                        and segment_id.startswith("legacy-")
                        and not has_manual_timing
                    ),
                )
                if segment is not None:
                    normalized.append(segment)
        else:
            urls = self._unique_video_urls(metadata)
            for index, url in enumerate(urls):
                filename = Path(url.split("?", 1)[0]).name
                frame_range = self._extract_frame_range_from_filename(filename, default_fps or DEFAULT_FPS)
                frame_count = None
                duration_seconds = None
                start_frame = None
                original_filename = filename

                if frame_range is not None:
                    start_frame, end_frame = frame_range
                    frame_count = end_frame - start_frame + 1
                    if frame_count > 0 and default_fps is not None:
                        duration_seconds = round(frame_count / default_fps, 3)
                elif index == 0:
                    raw_start_frame = metadata.get("video_start_frame")
                    start_frame = self._parse_int(None if raw_start_frame is None else str(raw_start_frame))
                    if start_frame is None or start_frame < 0:
                        start_frame = 0
                    frame_count = self._parse_positive_int(metadata.get("video_frame_count"))
                    duration_seconds = self._parse_positive_float(metadata.get("video_duration_seconds"))
                    original_filename = str(metadata.get("original_video_filename") or "").strip() or filename
                else:
                    start_frame = 0

                segment = self._normalize_segment_payload(
                    session_id,
                    {
                        "id": f"legacy-{index + 1}",
                        "url": url,
                        "original_filename": original_filename,
                        "start_frame": start_frame,
                        "period_start_frame": None,
                        "video_start_time_seconds": None,
                        "timing_confirmed": False,
                        "frame_count": frame_count,
                        "duration_seconds": duration_seconds,
                        "fps": default_fps,
                        "created_at": default_created_at,
                    },
                    default_created_at=default_created_at,
                    default_fps=default_fps,
                    prefer_filename_range=True,
                )
                if segment is not None:
                    normalized.append(segment)

        normalized.sort(key=self._segment_sort_key)
        return normalized

    def build_video_metadata_patch(
        self,
        segments: list[dict[str, Any]],
        metadata: dict[str, Any],
        *,
        primary_source: str | None = None,
        primary_confirmed: bool | None = None,
    ) -> dict[str, Any]:
        ordered = sorted(segments, key=self._segment_sort_key)
        patch: dict[str, Any] = {
            "video_segments": ordered,
            "video_urls": [str(segment.get("url") or "") for segment in ordered if str(segment.get("url") or "").strip()],
            "video_url": None,
            "video_start_frame": None,
            "original_video_filename": None,
            "video_duration_seconds": None,
            "video_frame_count": None,
        }

        if not ordered:
            patch["video_start_frame_source"] = primary_source if primary_source is not None else metadata.get("video_start_frame_source")
            patch["video_start_frame_confirmed"] = (
                primary_confirmed if primary_confirmed is not None else bool(metadata.get("video_start_frame_confirmed", False))
            )
            return patch

        primary = ordered[0]
        patch["video_url"] = primary.get("url")
        patch["video_start_frame"] = self._effective_segment_start_frame(primary)
        patch["original_video_filename"] = primary.get("original_filename")
        patch["video_duration_seconds"] = primary.get("duration_seconds")
        patch["video_frame_count"] = primary.get("frame_count")
        primary_fps = self._parse_positive_float(primary.get("fps"))
        if primary_fps is not None:
            patch["fps"] = primary_fps

        patch["video_start_frame_source"] = (
            "timing"
            if bool(primary.get("timing_confirmed"))
            else primary_source if primary_source is not None else metadata.get("video_start_frame_source")
        )
        patch["video_start_frame_confirmed"] = (
            primary_confirmed if primary_confirmed is not None else bool(primary.get("timing_confirmed", False))
        )
        return patch

    def normalize_video_metadata(self, metadata: dict[str, Any]) -> dict[str, Any]:
        session_id = str(metadata.get("session_id") or "").strip()
        if not session_id:
            return metadata

        normalized = dict(metadata)
        segments = self.normalize_video_segments(session_id, metadata)
        normalized.update(self.build_video_metadata_patch(segments, normalized))
        return normalized

    @staticmethod
    def _segments_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
        left_start = UploadSessionService._effective_segment_start_frame(left)
        right_start = UploadSessionService._effective_segment_start_frame(right)
        if left_start is None or right_start is None:
            return False

        left_end = UploadSessionService._segment_end_frame(left)
        right_end = UploadSessionService._segment_end_frame(right)
        if left_end is None or right_end is None:
            return left_start == right_start

        intersection_start = max(left_start, right_start)
        intersection_end = min(left_end, right_end)
        overlap_count = intersection_end - intersection_start + 1
        return overlap_count > 1

    @staticmethod
    def _canonical_value(row: dict[str, str], field: str) -> str:
        for alias in FIELD_ALIASES[field]:
            if alias in row:
                return row[alias]
        return ""

    def load_events_from_csv(self, csv_path: Path, fps: float) -> tuple[list[dict[str, Any]], list[str]]:
        try:
            raw_text = csv_path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            raw_text = csv_path.read_text(encoding="utf-8", errors="replace")

        reader = csv.DictReader(raw_text.splitlines())
        if not reader.fieldnames:
            raise HTTPException(status_code=400, detail="CSV header is missing")

        normalized_rows: list[dict[str, str]] = []
        for raw_row in reader:
            canonical_row: dict[str, str] = {}
            for key, value in raw_row.items():
                normalized_key = _normalize_header(str(key or ""))
                if normalized_key:
                    canonical_row[normalized_key] = (value or "").strip()
            normalized_rows.append(canonical_row)

        events: list[dict[str, Any]] = []
        warnings: list[str] = []
        for index, row in enumerate(normalized_rows, start=2):
            spadl_type = self._canonical_value(row, "spadl_type").strip()
            player_id = self._canonical_value(row, "player_id").strip()
            if not spadl_type or not player_id:
                warnings.append(f"row {index}: skipped because spadl_type/player_id is missing")
                continue

            synced_frame_id = self._parse_int(self._canonical_value(row, "synced_frame_id"))
            synced_ts_raw = self._canonical_value(row, "synced_ts")
            synced_seconds = timestamp_to_seconds(synced_ts_raw) if synced_ts_raw else None
            if synced_ts_raw and synced_seconds is None:
                warnings.append(f"row {index}: invalid synced_ts '{synced_ts_raw}', ignoring timestamp")

            if synced_frame_id is None and synced_seconds is not None:
                synced_frame_id = int(round(synced_seconds * fps))
            synced_ts = synced_ts_raw if synced_seconds is not None else None
            if synced_ts is None and synced_frame_id is not None:
                synced_ts = frame_to_timestamp(synced_frame_id, fps)

            if synced_frame_id is None and synced_ts is None:
                warnings.append(f"row {index}: synced_frame_id/synced_ts is missing, but kept for annotation")

            receive_frame_id = self._parse_int(self._canonical_value(row, "receive_frame_id"))
            receive_ts_raw = self._canonical_value(row, "receive_ts")
            receive_seconds = timestamp_to_seconds(receive_ts_raw) if receive_ts_raw else None
            if receive_ts_raw and receive_seconds is None:
                warnings.append(f"row {index}: invalid receive_ts '{receive_ts_raw}', ignoring timestamp")
            if receive_frame_id is None and receive_seconds is not None:
                receive_frame_id = int(round(receive_seconds * fps))
            receive_ts = receive_ts_raw if receive_seconds is not None else None
            if receive_ts is None and receive_frame_id is not None:
                receive_ts = frame_to_timestamp(receive_frame_id, fps)

            period_id_raw = self._canonical_value(row, "period_id")
            period_id = self._parse_int(period_id_raw)
            if period_id is None:
                period_id = 1
                if period_id_raw:
                    warnings.append(f"row {index}: invalid period_id '{period_id_raw}', defaulted to 1")

            outcome_raw = self._canonical_value(row, "outcome")
            outcome = self._parse_bool(outcome_raw)
            if outcome is None:
                if outcome_raw:
                    warnings.append(f"row {index}: invalid outcome '{outcome_raw}', defaulted to true")
                outcome = True

            error_type = self._canonical_value(row, "error_type").strip() or None
            if error_type and error_type not in ERROR_TYPES:
                warnings.append(f"row {index}: unknown error_type '{error_type}', cleared")
                error_type = None

            event_id = self._canonical_value(row, "id").strip() or f"upload_{len(events) + 1:05d}"

            events.append(
                {
                    "id": event_id,
                    "period_id": period_id,
                    "spadl_type": spadl_type,
                    "player_id": player_id,
                    "synced_frame_id": synced_frame_id,
                    "synced_ts": synced_ts,
                    "receiver_id": self._canonical_value(row, "receiver_id").strip() or None,
                    "receive_frame_id": receive_frame_id,
                    "receive_ts": receive_ts,
                    "outcome": outcome,
                    "error_type": error_type,
                    "note": self._canonical_value(row, "note"),
                }
            )

        if not events:
            preview = "\n".join(warnings[:10]) if warnings else "No usable rows found"
            raise HTTPException(status_code=400, detail=f"CSV import failed.\n{preview}")

        return events, warnings

    @staticmethod
    def _is_missing_sync_anchor_event(event: dict[str, Any]) -> bool:
        return event.get("synced_frame_id") is None and not str(event.get("synced_ts") or "").strip()

    @classmethod
    def _same_missing_sync_anchor_event(cls, left: dict[str, Any], right: dict[str, Any]) -> bool:
        if not cls._is_missing_sync_anchor_event(right):
            return False
        return (
            left.get("period_id") == right.get("period_id")
            and str(left.get("spadl_type") or "") == str(right.get("spadl_type") or "")
            and str(left.get("player_id") or "") == str(right.get("player_id") or "")
            and str(left.get("receiver_id") or "") == str(right.get("receiver_id") or "")
            and bool(left.get("outcome")) == bool(right.get("outcome"))
        )

    @staticmethod
    def _missing_sync_anchor_search_radius(
        *,
        event_count: int,
        parsed_count: int,
        missing_count: int,
    ) -> int:
        row_count_drift = abs(event_count - parsed_count)
        return min(80, max(8, row_count_drift + missing_count + 4))

    @staticmethod
    def _dedupe_event_id(base_id: str, existing_ids: set[str]) -> str:
        candidate = base_id
        suffix = 2
        while candidate in existing_ids:
            candidate = f"{base_id}_{suffix}"
            suffix += 1
        existing_ids.add(candidate)
        return candidate

    def _backfill_missing_sync_anchor_events(
        self,
        events: list[dict[str, Any]],
        parsed_events: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], bool]:
        missing_positions = [
            (index, row)
            for index, row in enumerate(parsed_events)
            if self._is_missing_sync_anchor_event(row)
        ]
        if not missing_positions:
            return events, False

        result = [dict(row) for row in events]
        existing_ids = {str(row.get("id") or "") for row in result if row.get("id")}
        changed = False
        search_radius = self._missing_sync_anchor_search_radius(
            event_count=len(result),
            parsed_count=len(parsed_events),
            missing_count=len(missing_positions),
        )

        for parsed_index, parsed_row in missing_positions:
            base_id = f"csv_missing_{parsed_index + 1:05d}"
            nearby_start = max(0, parsed_index - search_radius)
            nearby_end = min(len(result), parsed_index + search_radius + 1)
            nearby_matches = [
                (index, candidate)
                for index, candidate in enumerate(result[nearby_start:nearby_end], start=nearby_start)
                if self._same_missing_sync_anchor_event(candidate, parsed_row)
            ]
            has_timed_match = any(
                not self._is_missing_sync_anchor_event(candidate)
                for _, candidate in nearby_matches
            )
            if has_timed_match:
                stale_backfill_indices = [
                    index
                    for index, candidate in nearby_matches
                    if self._is_missing_sync_anchor_event(candidate)
                    and str(candidate.get("id") or "") == base_id
                ]
                for index in reversed(stale_backfill_indices):
                    removed = result.pop(index)
                    existing_ids.discard(str(removed.get("id") or ""))
                    changed = True
                continue

            if base_id in existing_ids:
                continue

            if nearby_matches:
                continue

            restored = dict(parsed_row)
            restored["id"] = self._dedupe_event_id(base_id, existing_ids)
            insert_at = min(parsed_index, len(result))
            result.insert(insert_at, restored)
            changed = True

        return result, changed

    def backfill_upload_csv_missing_sync_anchors(
        self,
        session_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        if metadata.get("session_mode") != "upload_csv":
            return metadata

        csv_path = self.store.session_dir(session_id) / "uploaded_events.csv"
        if not csv_path.exists():
            return metadata

        fps = self._parse_positive_float(metadata.get("fps")) or DEFAULT_FPS
        parsed_events, warnings = self.load_events_from_csv(csv_path, fps)

        current_events = self.store.load_events(session_id)
        restored_current, current_changed = self._backfill_missing_sync_anchor_events(
            current_events,
            parsed_events,
        )
        if current_changed:
            self.store.save_events(session_id, restored_current)

        try:
            initial_events = self.store.load_initial_events(session_id)
        except FileNotFoundError:
            initial_events = []
        restored_initial, initial_changed = self._backfill_missing_sync_anchor_events(
            initial_events,
            parsed_events,
        )
        if initial_changed:
            self.store.save_initial_events(session_id, restored_initial)

        if not current_changed and not initial_changed:
            return metadata

        merged_warnings = list(metadata.get("validation_warnings") or [])
        for warning in warnings:
            if warning not in merged_warnings:
                merged_warnings.append(warning)

        return self.store.update_metadata(
            session_id,
            event_count=len(restored_current),
            validation_warnings=merged_warnings,
        )

    def create_upload_session(
        self,
        *,
        csv_file: UploadFile,
        persist: bool,
        session_name: str | None = None,
    ) -> dict[str, Any]:
        uploaded_csv_name = (Path(csv_file.filename or "uploaded_events.csv").name or "uploaded_events.csv").strip()
        csv_suffix = Path(uploaded_csv_name).suffix.lower()
        if csv_suffix != ".csv":
            raise HTTPException(status_code=400, detail="CSV upload must be a .csv file")

        inferred_name = self._sanitize_name(Path(uploaded_csv_name).stem)
        metadata = self.store.create_session(
            annotator_name="uploaded",
            match_id=inferred_name,
            dataset_root="",
            generate_video=False,
            session_mode="upload_csv",
            persist=persist,
            session_name=session_name or uploaded_csv_name,
        )
        session_id = metadata["session_id"]
        session_dir = self.store.session_dir(session_id)

        csv_name = "uploaded_events.csv"
        csv_path = session_dir / csv_name

        try:
            self._copy_upload(csv_file, csv_path)
        finally:
            csv_file.file.close()

        fps = DEFAULT_FPS
        events, warnings = self.load_events_from_csv(csv_path, fps)
        self.store.save_initial_events(session_id, events)
        self.store.save_events(session_id, events)
        return self.store.update_metadata(
            session_id,
            status="ready",
            progress="uploaded",
            event_count=len(events),
            fps=fps,
            validation_warnings=warnings,
        )

    def add_video_segment(
        self,
        *,
        session_id: str,
        metadata: dict[str, Any],
        video_file: UploadFile,
        start_frame: int | None = None,
    ) -> dict[str, Any]:
        original_video_filename = Path(video_file.filename or "video.mp4").name
        video_suffix = Path(original_video_filename).suffix.lower() or ".mp4"
        if video_suffix not in {".mp4", ".mov", ".m4v", ".webm"}:
            raise HTTPException(status_code=400, detail="Video upload must be mp4/mov/m4v/webm")

        session_dir = self.store.session_dir(session_id)
        fallback_start_frame = (
            int(start_frame)
            if start_frame is not None
            else self._extract_start_frame_from_filename(original_video_filename, TIMING_MAPPING_FPS) or 0
        )
        segment_filename = f"uploaded_video_{fallback_start_frame}_{uuid4().hex[:8]}{video_suffix}"
        video_path = session_dir / segment_filename
        try:
            self._copy_upload(video_file, video_path)
        finally:
            video_file.file.close()

        fps = self._probe_video_fps(video_path)
        duration_seconds = self._probe_video_duration_seconds(video_path)
        frame_count = (
            max(1, int(round(duration_seconds * fps)))
            if duration_seconds is not None and fps > 0
            else None
        )

        created_at = datetime.now(tz=timezone.utc).isoformat()
        new_segment = {
            "id": uuid4().hex[:12],
            "url": self._artifact_url(session_id, segment_filename),
            "original_filename": original_video_filename,
            "start_frame": fallback_start_frame,
            "period_start_frame": None,
            "video_start_time_seconds": None,
            "timing_confirmed": False,
            "frame_count": frame_count,
            "duration_seconds": duration_seconds,
            "fps": fps,
            "created_at": created_at,
        }

        existing_segments = self.normalize_video_segments(session_id, metadata)
        kept_segments: list[dict[str, Any]] = []
        removed_paths: list[Path] = []
        if start_frame is not None:
            for segment in existing_segments:
                if self._segments_overlap(segment, new_segment):
                    local_path = self._artifact_path_for_url(session_id, str(segment.get("url") or ""))
                    if local_path is not None:
                        removed_paths.append(local_path)
                    continue
                kept_segments.append(segment)
        else:
            kept_segments = existing_segments

        updated_segments = [*kept_segments, new_segment]
        updated_segments.sort(key=self._segment_sort_key)
        primary_is_new_segment = bool(updated_segments) and updated_segments[0].get("id") == new_segment["id"]
        patch = self.build_video_metadata_patch(
            updated_segments,
            metadata,
            primary_source="manual" if primary_is_new_segment else None,
            primary_confirmed=True if primary_is_new_segment else None,
        )
        updated = self.store.update_metadata(session_id, **patch)

        for old_path in removed_paths:
            if old_path == video_path:
                continue
            try:
                old_path.unlink(missing_ok=True)
            except OSError:
                continue

        return updated

    def update_video_segment_timing(
        self,
        *,
        session_id: str,
        metadata: dict[str, Any],
        segment_id: str,
        period_start_frame: int,
        video_start_time_seconds: float,
    ) -> dict[str, Any]:
        segments = self.normalize_video_segments(session_id, metadata)
        target_index = next((index for index, segment in enumerate(segments) if segment.get("id") == segment_id), -1)
        if target_index < 0:
            raise HTTPException(status_code=404, detail=f"Unknown video segment: {segment_id}")

        updated_target = dict(segments[target_index])
        updated_target["period_start_frame"] = int(period_start_frame)
        updated_target["video_start_time_seconds"] = round(float(video_start_time_seconds), 3)
        updated_target["timing_confirmed"] = True
        derived_start_frame = self._derive_start_frame(
            updated_target["period_start_frame"],
            updated_target["video_start_time_seconds"],
        )
        if derived_start_frame is not None:
            updated_target["start_frame"] = derived_start_frame

        kept_segments: list[dict[str, Any]] = []
        removed_paths: list[Path] = []
        for index, segment in enumerate(segments):
            if index == target_index:
                continue
            if self._segments_overlap(segment, updated_target):
                local_path = self._artifact_path_for_url(session_id, str(segment.get("url") or ""))
                if local_path is not None:
                    removed_paths.append(local_path)
                continue
            kept_segments.append(segment)

        updated_segments = [*kept_segments, updated_target]
        updated_segments.sort(key=self._segment_sort_key)
        updated = self.store.update_metadata(
            session_id,
            **self.build_video_metadata_patch(updated_segments, metadata),
        )

        for old_path in removed_paths:
            try:
                old_path.unlink(missing_ok=True)
            except OSError:
                continue

        return updated

    def export_events_csv(self, session_id: str, events: list[dict[str, Any]], *, variant: str = "current") -> Path:
        suffix = "initial" if variant == "initial" else "current"
        export_path = self.store.session_dir(session_id) / f"gt_events_{suffix}.csv"
        with export_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_EXPORT_COLUMNS)
            writer.writeheader()
            for event in events:
                writer.writerow(
                    {
                        "period_id": event.get("period_id"),
                        "spadl_type": event.get("spadl_type"),
                        "player_id": event.get("player_id"),
                        "synced_ts": event.get("synced_ts") or "",
                        "receiver_id": event.get("receiver_id") or "",
                        "receive_ts": event.get("receive_ts") or "",
                        "outcome": "true" if bool(event.get("outcome")) else "false",
                        "error_type": event.get("error_type") or "",
                        "note": event.get("note") or "",
                        "synced_frame_id": event.get("synced_frame_id") if event.get("synced_frame_id") is not None else "",
                        "receive_frame_id": event.get("receive_frame_id") if event.get("receive_frame_id") is not None else "",
                        "id": event.get("id"),
                    }
                )
        return export_path
