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


class VideoSegmentResponse(BaseModel):
    id: str
    url: str
    original_filename: str | None = None
    start_frame: int = Field(ge=0)
    period_start_frame: int | None = Field(default=None, ge=0)
    video_start_time_seconds: float | None = Field(default=None, ge=0)
    timing_confirmed: bool = False
    frame_count: int | None = Field(default=None, ge=1)
    duration_seconds: float | None = Field(default=None, ge=0)
    fps: float | None = Field(default=None, gt=0)
    created_at: datetime


class SessionStatusResponse(BaseModel):
    session_id: str
    annotator_name: str
    match_id: str
    session_mode: Literal["legacy_elastic", "upload_csv"] = "legacy_elastic"
    persist: bool = True
    session_name: str | None = None
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
    video_start_frame: int | None = None
    original_video_filename: str | None = None
    video_start_frame_source: str | None = None
    video_start_frame_confirmed: bool = False
    video_duration_seconds: float | None = None
    video_frame_count: int | None = None
    video_segments: list[VideoSegmentResponse] = Field(default_factory=list)
    event_undo_available: bool = False
    display_name: str | None = None
    public_read_only: bool = False
    public_baseline: bool = False
    public_editable: bool = False
    public_source: str | None = None
    edit_token: str | None = None


class SessionMetadataUpdateRequest(BaseModel):
    video_start_frame: int | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, max_length=200)


class VideoSegmentTimingUpdateRequest(BaseModel):
    period_start_frame: int = Field(ge=0)
    video_start_time_seconds: float = Field(ge=0)


class SessionDeleteResponse(BaseModel):
    ok: bool
    session_id: str


class ImportNoteSummary(BaseModel):
    code: str
    title: str
    summary: str
    count: int = 0
    sample_rows: list[int] = Field(default_factory=list)


class QAFlagSummary(BaseModel):
    code: str
    title: str
    summary: str
    count: int = 0
    sample_frame_ids: list[int] = Field(default_factory=list)


class EventListResponse(BaseModel):
    session_id: str
    events: list[EventRow]
    validation_warnings: list[str] = Field(default_factory=list)
    import_notes: list[ImportNoteSummary] = Field(default_factory=list)
    qa_flags: list[QAFlagSummary] = Field(default_factory=list)


class EventSaveRequest(BaseModel):
    events: list[EventRow]


class EventSaveResponse(BaseModel):
    ok: bool
    saved_count: int
    event_undo_available: bool = False
    validation_warnings: list[str] = Field(default_factory=list)
    import_notes: list[ImportNoteSummary] = Field(default_factory=list)
    qa_flags: list[QAFlagSummary] = Field(default_factory=list)


class DatasetUploadResponse(BaseModel):
    dataset_root: str


class ErrorResponse(BaseModel):
    detail: str
    valid_error_types: list[str] = ERROR_TYPES
