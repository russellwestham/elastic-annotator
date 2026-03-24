from __future__ import annotations

import logging
import re
from typing import Any

from backend.app.core.settings import Settings

logger = logging.getLogger(__name__)
SHEET_URL_PATTERN = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")
SHEET_ID_PATTERN = re.compile(r"^[a-zA-Z0-9-_]+$")


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
    ) -> str:
        client = self._authorize()
        annotator_key = annotator_name.strip()
        sheet = self._open_target_sheet(client, match_id, create_if_missing=True, sheet_id=sheet_id)

        worksheet = None
        for ws in sheet.worksheets():
            if ws.title.strip().lower() == annotator_key.lower():
                worksheet = ws
                break

        if worksheet is None:
            worksheet_title = annotator_key.title() if annotator_key else "Annotator"
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

        return sheet.url

    def reset_sheet(self, match_id: str, sheet_id: str | None = None) -> str:
        client = self._authorize()
        sheet = self._open_target_sheet(client, match_id, create_if_missing=False, sheet_id=sheet_id)

        for ws in sheet.worksheets():
            ws.clear()

        return sheet.url
