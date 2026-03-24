from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class SheetMappingStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self._write_json({})

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(tz=timezone.utc).isoformat()

    def get_sheet_id(self, match_id: str) -> str | None:
        data = self._read_json()
        entry = data.get(match_id)
        if not isinstance(entry, dict):
            return None
        sheet_id = entry.get("sheet_id")
        if isinstance(sheet_id, str) and sheet_id.strip():
            return sheet_id.strip()
        return None

    def set_sheet_id(self, match_id: str, sheet_id: str) -> str:
        normalized = sheet_id.strip()
        if not normalized:
            raise ValueError("sheet_id cannot be empty")

        with self._lock:
            data = self._read_json()
            data[match_id] = {
                "sheet_id": normalized,
                "updated_at": self._now_iso(),
            }
            self._write_json(data)
        return normalized

    def clear_sheet_id(self, match_id: str) -> None:
        with self._lock:
            data = self._read_json()
            if match_id in data:
                data.pop(match_id, None)
                self._write_json(data)

    def _read_json(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        with self.path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else {}

    def _write_json(self, payload: dict[str, Any]) -> None:
        with self.path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
