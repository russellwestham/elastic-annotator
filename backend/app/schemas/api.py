from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from backend.app.core.constants import ERROR_TYPES

ErrorType = Literal[
    "synced_ts",
    "receive_ts",
    "player_id",
    "receiver_id",
    "spadl_type",
    "outcome",
    "false_positive",
    "missing",
]


class MatchSummary(BaseModel):
    match_id: str
    home_team: str | None = None
    away_team: str | None = None


class DefaultDatasetRootResponse(BaseModel):
    dataset_root: str
    exists: bool


class SessionCreateRequest(BaseModel):
    annotator_name: str = Field(min_length=1, max_length=100)
    match_id: str = Field(min_length=3, max_length=32)
    dataset_root: str | None = None
    generate_video: bool = True


class SheetMappingUpdateRequest(BaseModel):
    sheet_ref: str = Field(min_length=1, max_length=500)


class SheetMappingResponse(BaseModel):
    match_id: str
    sheet_id: str | None = None
    sheet_url: str | None = None


class EventRow(BaseModel):
    id: str
    period_id: int
    spadl_type: str
    player_id: str

    synced_frame_id: int | None = None
    synced_ts: str | None = None

    receiver_id: str | None = None
    receive_frame_id: int | None = None
    receive_ts: str | None = None

    outcome: bool
    error_type: ErrorType | None = None
    note: str = ""


class SessionStatusResponse(BaseModel):
    session_id: str
    annotator_name: str
    match_id: str
    status: Literal["processing", "ready", "error"]
    dataset_root: str
    progress: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime
    event_count: int = 0
    fps: float | None = None
    video_url: str | None = None
    video_urls: list[str] | None = None
    sheet_url: str | None = None


class EventListResponse(BaseModel):
    session_id: str
    events: list[EventRow]
    validation_warnings: list[str] = []


class EventSaveRequest(BaseModel):
    events: list[EventRow]
    sync_sheet: bool = True


class EventSaveResponse(BaseModel):
    ok: bool
    saved_count: int
    validation_warnings: list[str] = []
    sheet_synced: bool = False


class DatasetUploadResponse(BaseModel):
    dataset_root: str


class ErrorResponse(BaseModel):
    detail: str
    valid_error_types: list[str] = ERROR_TYPES
