from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "elastic-annotator-backend"
    frontend_origin: str = "http://localhost:5173"
    video_segment_seconds: int = 300

    elastic_repo_path: Path = Path("/Users/leekunhee_dyve/dev/elastic")
    default_dataset_root: Path = Path("/Users/leekunhee_dyve/dev/elastic/data/sportec")

    sessions_root: Path = PROJECT_ROOT / "backend" / "storage" / "sessions"
    datasets_root: Path = PROJECT_ROOT / "backend" / "storage" / "datasets"
    sheet_mappings_path: Path = PROJECT_ROOT / "backend" / "storage" / "sheet_mappings.json"

    enable_google_sheets: bool = False
    google_service_account_json: Path | None = None
    google_sheet_share_emails: str = ""
    google_sheet_share_role: str = "writer"
    google_sheet_share_notify: bool = False

    @field_validator(
        "elastic_repo_path",
        "default_dataset_root",
        "sessions_root",
        "datasets_root",
        "sheet_mappings_path",
        mode="before",
    )
    @classmethod
    def _expand_path(cls, value: str | Path) -> Path:
        return Path(value).expanduser()

    @property
    def share_emails(self) -> list[str]:
        raw = self.google_sheet_share_emails.strip()
        if not raw:
            return []
        return [email.strip() for email in raw.split(",") if email.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.sessions_root.mkdir(parents=True, exist_ok=True)
    settings.datasets_root.mkdir(parents=True, exist_ok=True)
    settings.sheet_mappings_path.parent.mkdir(parents=True, exist_ok=True)
    return settings
