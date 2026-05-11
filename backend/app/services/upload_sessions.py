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
    def _extract_frame_range_from_filename(filename: str | None) -> tuple[int, int] | None:
        stem = Path(filename or "").stem
        match = VIDEO_FRAME_RANGE_PATTERN.search(stem) or re.search(r"(\d+)-(\d+)", stem)
        if not match:
            return None

        start = int(match.group(1))
        end = int(match.group(2))
        if end <= start:
            return None
        return start, end

    @staticmethod
    def _extract_start_frame_from_filename(filename: str | None) -> int | None:
        frame_range = UploadSessionService._extract_frame_range_from_filename(filename)
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
        filename_start = self._extract_start_frame_from_filename(original_video_filename)
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
        start_frame = segment.get("start_frame")
        frame_count = segment.get("frame_count")
        if not isinstance(start_frame, int) or not isinstance(frame_count, int) or frame_count <= 0:
            return None
        return start_frame + frame_count - 1

    @staticmethod
    def _segment_sort_key(segment: dict[str, Any]) -> tuple[int, str, str]:
        start_frame = segment.get("start_frame")
        created_at = str(segment.get("created_at") or "")
        segment_id = str(segment.get("id") or "")
        if not isinstance(start_frame, int):
            start_frame = 0
        return start_frame, created_at, segment_id

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
    ) -> dict[str, Any] | None:
        url = str(raw_segment.get("url") or "").strip()
        if not url:
            return None

        original_filename = str(raw_segment.get("original_filename") or "").strip() or Path(url.split("?", 1)[0]).name
        frame_range = self._extract_frame_range_from_filename(original_filename)
        fps = self._parse_positive_float(raw_segment.get("fps")) or default_fps
        raw_start_frame = raw_segment.get("start_frame")
        start_frame = self._parse_int(None if raw_start_frame is None else str(raw_start_frame))
        if start_frame is None and frame_range is not None:
            start_frame = frame_range[0]
        if start_frame is None or start_frame < 0:
            start_frame = 0

        frame_count = self._parse_positive_int(raw_segment.get("frame_count"))
        if frame_count is None and frame_range is not None:
            frame_count = frame_range[1] - frame_range[0] + 1

        duration_seconds = self._parse_positive_float(raw_segment.get("duration_seconds"))
        if duration_seconds is None and frame_count is not None and fps is not None:
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

        if isinstance(raw_segments, list) and raw_segments:
            for item in raw_segments:
                if not isinstance(item, dict):
                    continue
                segment = self._normalize_segment_payload(
                    session_id,
                    item,
                    default_created_at=default_created_at,
                    default_fps=default_fps,
                )
                if segment is not None:
                    normalized.append(segment)
        else:
            urls = self._unique_video_urls(metadata)
            for index, url in enumerate(urls):
                filename = Path(url.split("?", 1)[0]).name
                frame_range = self._extract_frame_range_from_filename(filename)
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
                        "frame_count": frame_count,
                        "duration_seconds": duration_seconds,
                        "fps": default_fps,
                        "created_at": default_created_at,
                    },
                    default_created_at=default_created_at,
                    default_fps=default_fps,
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
        patch["video_start_frame"] = primary.get("start_frame")
        patch["original_video_filename"] = primary.get("original_filename")
        patch["video_duration_seconds"] = primary.get("duration_seconds")
        patch["video_frame_count"] = primary.get("frame_count")
        primary_fps = self._parse_positive_float(primary.get("fps"))
        if primary_fps is not None:
            patch["fps"] = primary_fps

        patch["video_start_frame_source"] = primary_source if primary_source is not None else metadata.get("video_start_frame_source")
        patch["video_start_frame_confirmed"] = (
            primary_confirmed if primary_confirmed is not None else bool(metadata.get("video_start_frame_confirmed", False))
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
        left_start = left.get("start_frame")
        right_start = right.get("start_frame")
        if not isinstance(left_start, int) or not isinstance(right_start, int):
            return False

        left_end = UploadSessionService._segment_end_frame(left)
        right_end = UploadSessionService._segment_end_frame(right)
        if left_end is None or right_end is None:
            return left_start == right_start
        return not (right_end < left_start or left_end < right_start)

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
                warnings.append(f"row {index}: skipped because synced_frame_id/synced_ts is missing")
                continue

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
            if not self._canonical_value(row, "id").strip():
                warnings.append(f"row {index}: missing id, generated {event_id}")

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

    def create_upload_session(
        self,
        *,
        video_file: UploadFile,
        csv_file: UploadFile,
        persist: bool,
        session_name: str | None = None,
        video_start_frame: int | None = None,
    ) -> dict[str, Any]:
        original_video_filename = Path(video_file.filename or "video.mp4").name
        video_suffix = Path(original_video_filename).suffix.lower() or ".mp4"
        if video_suffix not in {".mp4", ".mov", ".m4v", ".webm"}:
            raise HTTPException(status_code=400, detail="Video upload must be mp4/mov/m4v/webm")
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

        video_name = f"uploaded_video{video_suffix}"
        csv_name = "uploaded_events.csv"
        video_path = session_dir / video_name
        csv_path = session_dir / csv_name

        try:
            self._copy_upload(video_file, video_path)
            self._copy_upload(csv_file, csv_path)
        finally:
            video_file.file.close()
            csv_file.file.close()

        fps = self._probe_video_fps(video_path)
        video_duration_seconds = self._probe_video_duration_seconds(video_path)
        events, warnings = self.load_events_from_csv(csv_path, fps)
        inferred_start_frame, video_start_frame_source, video_frame_count = self._recommend_video_start_frame(
            original_video_filename=original_video_filename,
            events=events,
            fps=fps,
            video_duration_seconds=video_duration_seconds,
        )
        resolved_start_frame = int(video_start_frame) if video_start_frame is not None else inferred_start_frame
        primary_source = "manual" if video_start_frame is not None else video_start_frame_source
        primary_confirmed = video_start_frame is not None
        initial_segment = {
            "id": uuid4().hex[:12],
            "url": self._artifact_url(session_id, video_name),
            "original_filename": original_video_filename,
            "start_frame": resolved_start_frame,
            "frame_count": video_frame_count,
            "duration_seconds": video_duration_seconds,
            "fps": fps,
            "created_at": metadata["created_at"],
        }
        self.store.save_initial_events(session_id, events)
        self.store.save_events(session_id, events)
        patch = self.build_video_metadata_patch(
            [initial_segment],
            metadata,
            primary_source=primary_source,
            primary_confirmed=primary_confirmed,
        )
        return self.store.update_metadata(
            session_id,
            status="ready",
            progress="uploaded",
            event_count=len(events),
            fps=fps,
            validation_warnings=warnings,
            **patch,
        )

    def add_video_segment(
        self,
        *,
        session_id: str,
        metadata: dict[str, Any],
        video_file: UploadFile,
        start_frame: int,
    ) -> dict[str, Any]:
        original_video_filename = Path(video_file.filename or "video.mp4").name
        video_suffix = Path(original_video_filename).suffix.lower() or ".mp4"
        if video_suffix not in {".mp4", ".mov", ".m4v", ".webm"}:
            raise HTTPException(status_code=400, detail="Video upload must be mp4/mov/m4v/webm")

        session_dir = self.store.session_dir(session_id)
        segment_filename = f"uploaded_video_{start_frame}_{uuid4().hex[:8]}{video_suffix}"
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
            "start_frame": int(start_frame),
            "frame_count": frame_count,
            "duration_seconds": duration_seconds,
            "fps": fps,
            "created_at": created_at,
        }

        existing_segments = self.normalize_video_segments(session_id, metadata)
        kept_segments: list[dict[str, Any]] = []
        removed_paths: list[Path] = []
        for segment in existing_segments:
            if self._segments_overlap(segment, new_segment):
                local_path = self._artifact_path_for_url(session_id, str(segment.get("url") or ""))
                if local_path is not None:
                    removed_paths.append(local_path)
                continue
            kept_segments.append(segment)

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
