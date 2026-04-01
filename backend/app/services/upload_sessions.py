from __future__ import annotations

import csv
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

from backend.app.core.constants import ERROR_TYPES
from backend.app.services.session_store import SessionStore
from backend.app.utils.timecode import frame_to_timestamp, timestamp_to_seconds

DEFAULT_FPS = 25.0
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
    ) -> dict[str, Any]:
        video_suffix = Path(video_file.filename or "video.mp4").suffix.lower() or ".mp4"
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
        events, warnings = self.load_events_from_csv(csv_path, fps)
        self.store.save_initial_events(session_id, events)
        self.store.save_events(session_id, events)
        return self.store.update_metadata(
            session_id,
            status="ready",
            progress="uploaded",
            event_count=len(events),
            fps=fps,
            video_url=f"/artifacts/sessions/{session_id}/{video_name}",
            video_urls=[f"/artifacts/sessions/{session_id}/{video_name}"],
            validation_warnings=warnings,
        )

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
