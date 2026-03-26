from __future__ import annotations

import json
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.app.services.sheets import GoogleSheetsService

class SessionStore:
    def __init__(self, sessions_root: Path) -> None:
        self.sessions_root = sessions_root
        self.sessions_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(tz=timezone.utc).isoformat()

    def session_dir(self, session_id: str) -> Path:
        return self.sessions_root / session_id

    def initial_events_path(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "initial_events.json"

    def create_session(self, annotator_name: str, match_id: str, dataset_root: str, generate_video: bool) -> dict[str, Any]:
        session_id = uuid4().hex[:12]
        created_at = self._now_iso()
        payload = {
            "session_id": session_id,
            "annotator_name": annotator_name,
            "match_id": match_id,
            "dataset_root": dataset_root,
            "generate_video": bool(generate_video),
            "status": "processing",
            "progress": "queued",
            "error_message": None,
            "event_count": 0,
            "fps": None,
            "video_url": None,
            "video_urls": [],
            "sheet_url": None,
            "sheet_tab_name": None,
            "sheet_gid": None,
            "sheet_tab_url": None,
            "created_at": created_at,
            "updated_at": created_at,
        }

        session_dir = self.session_dir(session_id)
        session_dir.mkdir(parents=True, exist_ok=False)
        self._write_json(session_dir / "metadata.json", payload)
        self._write_json(session_dir / "events.json", {"events": []})
        self._write_json(session_dir / "initial_events.json", {"events": []})
        return payload

    def load_metadata(self, session_id: str) -> dict[str, Any]:
        path = self.session_dir(session_id) / "metadata.json"
        if not path.exists():
            raise FileNotFoundError(f"Unknown session: {session_id}")
        return self._read_json(path)

    def update_metadata(self, session_id: str, **fields: Any) -> dict[str, Any]:
        path = self.session_dir(session_id) / "metadata.json"
        with self._lock:
            metadata = self._read_json(path)
            metadata.update(fields)
            metadata["updated_at"] = self._now_iso()
            self._write_json(path, metadata)
        return metadata

    def load_events(self, session_id: str) -> list[dict[str, Any]]:
        path = self.session_dir(session_id) / "events.json"
        data = self._read_json(path)
        return data.get("events", [])

    def save_events(self, session_id: str, events: list[dict[str, Any]]) -> None:
        path = self.session_dir(session_id) / "events.json"
        with self._lock:
            self._write_json(path, {"events": events})

    def load_initial_events(self, session_id: str) -> list[dict[str, Any]]:
        path = self.initial_events_path(session_id)
        if not path.exists():
            raise FileNotFoundError(f"Unknown initial events for session: {session_id}")
        data = self._read_json(path)
        return data.get("events", [])

    def save_initial_events(self, session_id: str, events: list[dict[str, Any]]) -> None:
        path = self.initial_events_path(session_id)
        with self._lock:
            self._write_json(path, {"events": events})

    @staticmethod
    def _parse_iso(value: str | None) -> datetime:
        text = (value or "").strip()
        if not text:
            return datetime.fromtimestamp(0, tz=timezone.utc)
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return datetime.fromtimestamp(0, tz=timezone.utc)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt

    def prune_keep_latest_alive(self, keep_processing: bool = True) -> dict[str, Any]:
        snapshots: list[dict[str, Any]] = []
        for meta_path in self._iter_metadata_paths():
            try:
                metadata = self._read_json(meta_path)
            except Exception:
                continue
            metadata["_meta_path"] = str(meta_path)
            snapshots.append(metadata)

        latest_alive_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for metadata in snapshots:
            status = str(metadata.get("status") or "")
            session_id = str(metadata.get("session_id") or "").strip()
            if not session_id:
                continue
            if status == "processing" and not keep_processing:
                continue
            if status not in {"processing", "ready"}:
                continue

            match_id = str(metadata.get("match_id") or "").strip()
            sheet_tab_name = str(
                metadata.get("sheet_tab_name")
                or GoogleSheetsService.normalize_annotator_name(metadata.get("annotator_name"))
                or ""
            ).strip().lower()
            key = (match_id, sheet_tab_name)

            prev = latest_alive_by_key.get(key)
            if prev is None:
                latest_alive_by_key[key] = metadata
                continue

            prev_dt = self._parse_iso(prev.get("updated_at"))
            cur_dt = self._parse_iso(metadata.get("updated_at"))
            if cur_dt >= prev_dt:
                latest_alive_by_key[key] = metadata

        keep_ids = {meta.get("session_id") for meta in latest_alive_by_key.values() if meta.get("session_id")}

        deleted_ids: list[str] = []
        for metadata in snapshots:
            session_id = str(metadata.get("session_id") or "").strip()
            if not session_id or session_id in keep_ids:
                continue
            session_dir = self.session_dir(session_id)
            if session_dir.exists():
                shutil.rmtree(session_dir, ignore_errors=True)
            deleted_ids.append(session_id)

        kept_ids = sorted([sid for sid in keep_ids if isinstance(sid, str)])
        return {
            "total_before": len(snapshots),
            "kept_count": len(kept_ids),
            "deleted_count": len(deleted_ids),
            "kept_session_ids": kept_ids,
            "deleted_session_ids": sorted(deleted_ids),
        }

    def list_sessions(
        self,
        *,
        limit: int = 20,
        status: str | None = None,
        match_id: str | None = None,
    ) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        for meta_path in self._iter_metadata_paths():
            try:
                metadata = self._read_json(meta_path)
            except Exception:
                continue

            if status is not None and metadata.get("status") != status:
                continue
            if match_id is not None and metadata.get("match_id") != match_id:
                continue
            sessions.append(metadata)

        sessions.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)
        return sessions[: max(1, limit)]

    def find_processing_session(self, *, match_id: str | None = None, dataset_root: str | None = None) -> dict[str, Any] | None:
        candidates: list[dict[str, Any]] = []
        for meta_path in self._iter_metadata_paths():
            try:
                metadata = self._read_json(meta_path)
            except Exception:
                continue

            if metadata.get("status") != "processing":
                continue
            if match_id is not None and metadata.get("match_id") != match_id:
                continue
            if dataset_root is not None and metadata.get("dataset_root") != dataset_root:
                continue
            candidates.append(metadata)

        if not candidates:
            return None

        candidates.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)
        return candidates[0]

    def mark_processing_sessions_interrupted(self, reason: str) -> int:
        updated = 0
        for meta_path in self._iter_metadata_paths():
            with self._lock:
                try:
                    metadata = self._read_json(meta_path)
                except Exception:
                    continue
                if metadata.get("status") != "processing":
                    continue

                metadata["status"] = "error"
                metadata["progress"] = "failed"
                metadata["error_message"] = reason
                metadata["updated_at"] = self._now_iso()
                self._write_json(meta_path, metadata)
                updated += 1
        return updated

    def prepare_resume(self, session_id: str) -> dict[str, Any]:
        metadata_path = self.session_dir(session_id) / "metadata.json"
        events_path = self.session_dir(session_id) / "events.json"
        initial_events_path = self.initial_events_path(session_id)

        with self._lock:
            metadata = self._read_json(metadata_path)
            metadata.update(
                {
                    "status": "processing",
                    "progress": "queued",
                    "error_message": None,
                    "event_count": 0,
                    "fps": None,
                    "video_url": None,
                    "video_urls": [],
                    "sheet_url": None,
                    "sheet_tab_name": None,
                    "sheet_gid": None,
                    "sheet_tab_url": None,
                    "updated_at": self._now_iso(),
                }
            )
            self._write_json(metadata_path, metadata)
            self._write_json(events_path, {"events": []})
            self._write_json(initial_events_path, {"events": []})
        return metadata

    def _iter_metadata_paths(self) -> list[Path]:
        paths: list[Path] = []
        for item in self.sessions_root.iterdir():
            if not item.is_dir():
                continue
            meta_path = item / "metadata.json"
            if meta_path.exists():
                paths.append(meta_path)
        return paths

    def _read_json(self, path: Path) -> dict[str, Any]:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
