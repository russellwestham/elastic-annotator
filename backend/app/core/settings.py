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
    public_hosts: str = ""
    admin_hosts: str = ""
    public_contributions_enabled: bool = False

    @field_validator(
        "elastic_repo_path",
        "default_dataset_root",
        "sessions_root",
        "datasets_root",
        mode="before",
    )
    @classmethod
    def _expand_path(cls, value: str | Path) -> Path:
        return Path(value).expanduser()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.sessions_root.mkdir(parents=True, exist_ok=True)
    settings.datasets_root.mkdir(parents=True, exist_ok=True)
    return settings
