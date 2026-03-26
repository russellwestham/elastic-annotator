from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from backend.app.core.settings import Settings

logger = logging.getLogger(__name__)
SHEET_URL_PATTERN = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")
SHEET_ID_PATTERN = re.compile(r"^[a-zA-Z0-9-_]+$")
DEFAULT_ANNOTATOR_NAME = "kunhee"
SYSTEM_ANNOTATOR_NAMES = {
    "",
    "server-render-queue",
    "server_render_queue",
    "system",
    "unknown",
    "none",
    "null",
}
SYSTEM_ANNOTATOR_PREFIXES = (
    "batch-",
    "batch_",
)


class GoogleSheetsService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None

    @property
    def enabled(self) -> bool:
        return bool(self.settings.enable_google_sheets and self.settings.google_service_account_json)

    def _authorize(self):
        if self._client is not None:
            return self._client

        if not self.enabled:
            raise RuntimeError("Google Sheets is disabled. Set ENABLE_GOOGLE_SHEETS=true and credential path.")

        import gspread
        from google.oauth2.service_account import Credentials

        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = Credentials.from_service_account_file(str(self.settings.google_service_account_json), scopes=scopes)
        self._client = gspread.authorize(creds)
        return self._client

    @staticmethod
    def normalize_sheet_id(sheet_ref: str) -> str:
        text = sheet_ref.strip()
        if not text:
            raise ValueError("Google Sheet URL or ID is required")

        matched = SHEET_URL_PATTERN.search(text)
        if matched:
            return matched.group(1)

        if SHEET_ID_PATTERN.fullmatch(text):
            return text

        raise ValueError("Invalid Google Sheet URL/ID format")

    @staticmethod
    def build_sheet_url(sheet_id: str) -> str:
        return f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"

    @staticmethod
    def _sheet_title_candidates(match_id: str) -> list[str]:
        return [
            f"ELASTIC_ANNOTATOR_ {match_id}",
            f"ELASTIC_ANNOTATOR_{match_id}",
            match_id,
        ]

    @staticmethod
    def normalize_annotator_name(annotator_name: str | None) -> str:
        normalized = (annotator_name or "").strip()
        lowered = normalized.lower()
        if lowered in SYSTEM_ANNOTATOR_NAMES or any(lowered.startswith(prefix) for prefix in SYSTEM_ANNOTATOR_PREFIXES):
            return DEFAULT_ANNOTATOR_NAME
        return normalized

    @staticmethod
    def build_sheet_tab_url(sheet_url: str, worksheet_gid: str | int | None) -> str:
        if not sheet_url:
            return ""
        if worksheet_gid is None:
            return sheet_url
        parsed = urlsplit(sheet_url)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, f"gid={worksheet_gid}"))

    def _open_target_sheet(
        self,
        client: Any,
        match_id: str,
        *,
        create_if_missing: bool,
        sheet_id: str | None = None,
    ) -> Any:
        if sheet_id:
            try:
                return client.open_by_key(sheet_id)
            except Exception as exc:
                raise RuntimeError(
                    "Mapped Google Sheet is not accessible. "
                    f"match_id={match_id}, sheet_id={sheet_id}. "
                    "Check sharing for the service-account email."
                ) from exc

        sheet_title_candidates = self._sheet_title_candidates(match_id)

        for title in sheet_title_candidates:
            try:
                return client.open(title)
            except Exception:
                continue

        if not create_if_missing:
            raise RuntimeError(
                "Target Google Sheet not found. "
                f"Tried titles={sheet_title_candidates}. "
                "Create the sheet manually and share it with the service-account email."
            )

        preferred_title = sheet_title_candidates[0]
        try:
            return client.create(preferred_title)
        except Exception as exc:
            raise RuntimeError(
                "Cannot open or create target Google Sheet. "
                f"Tried titles={sheet_title_candidates}. "
                "Create the sheet manually and share it with the service-account email."
            ) from exc

    def find_existing_sheet_id(self, match_id: str) -> str | None:
        if not self.enabled:
            return None

        client = self._authorize()
        try:
            sheet = self._open_target_sheet(client, match_id, create_if_missing=False)
        except Exception:
            return None

        sheet_url = getattr(sheet, "url", "") or ""
        if sheet_url:
            try:
                return self.normalize_sheet_id(sheet_url)
            except ValueError:
                pass

        sheet_id = getattr(sheet, "id", None)
        if isinstance(sheet_id, str) and sheet_id.strip():
            return sheet_id.strip()
        return None

    def upsert_annotations(
        self,
        match_id: str,
        annotator_name: str,
        events: list[dict[str, Any]],
        sheet_id: str | None = None,
    ) -> dict[str, str | None]:
        client = self._authorize()
        annotator_key = self.normalize_annotator_name(annotator_name)
        sheet = self._open_target_sheet(client, match_id, create_if_missing=True, sheet_id=sheet_id)

        worksheet = None
        for ws in sheet.worksheets():
            if ws.title.strip().lower() == annotator_key.lower():
                worksheet = ws
                break

        if worksheet is None:
            worksheet_title = annotator_key if annotator_key else DEFAULT_ANNOTATOR_NAME
            worksheet = sheet.add_worksheet(title=worksheet_title, rows=2000, cols=20)

        columns = [
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

        rows = [columns]
        for event in events:
            rows.append([
                event.get("period_id"),
                event.get("spadl_type"),
                event.get("player_id"),
                event.get("synced_ts"),
                event.get("receiver_id"),
                event.get("receive_ts"),
                bool(event.get("outcome")),
                event.get("error_type") or "",
                event.get("note") or "",
                event.get("synced_frame_id"),
                event.get("receive_frame_id"),
                event.get("id"),
            ])

        worksheet.clear()
        worksheet.update(values=rows, range_name="A1")

        for email in self.settings.share_emails:
            try:
                sheet.share(
                    email,
                    perm_type="user",
                    role=self.settings.google_sheet_share_role,
                    notify=self.settings.google_sheet_share_notify,
                )
            except Exception as exc:
                logger.warning("Failed to share sheet to %s: %s", email, exc)

        worksheet_gid = str(getattr(worksheet, "id", "")) or None
        sheet_url = str(getattr(sheet, "url", "") or "")
        return {
            "sheet_url": sheet_url,
            "sheet_tab_name": worksheet.title,
            "sheet_gid": worksheet_gid,
            "sheet_tab_url": self.build_sheet_tab_url(sheet_url, worksheet_gid),
        }

    def worksheet_exists(
        self,
        match_id: str,
        *,
        sheet_id: str | None,
        worksheet_name: str | None = None,
        worksheet_gid: str | None = None,
    ) -> bool:
        if not self.enabled:
            return True
        if not sheet_id:
            return False
        target_name = (worksheet_name or "").strip().lower()
        target_gid = (worksheet_gid or "").strip()
        if not target_name and not target_gid:
            return False

        client = self._authorize()
        sheet = self._open_target_sheet(client, match_id, create_if_missing=False, sheet_id=sheet_id)
        for ws in sheet.worksheets():
            gid = str(getattr(ws, "id", "") or "")
            title = str(getattr(ws, "title", "") or "").strip().lower()
            if target_gid and gid == target_gid:
                return True
            if target_name and title == target_name:
                return True
        return False

    def reset_sheet(self, match_id: str, sheet_id: str | None = None) -> str:
        client = self._authorize()
        sheet = self._open_target_sheet(client, match_id, create_if_missing=False, sheet_id=sheet_id)

        for ws in sheet.worksheets():
            ws.clear()

        return sheet.url
