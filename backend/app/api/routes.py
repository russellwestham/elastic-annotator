from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from backend.app.core.constants import SPADL_EXTENDED_TYPES
from backend.app.core.settings import PROJECT_ROOT, get_settings
from backend.app.schemas.api import (
    DefaultDatasetRootResponse,
    DatasetUploadResponse,
    ErrorResponse,
    EventListResponse,
    EventSaveRequest,
    EventSaveResponse,
    MatchSummary,
    SessionCreateRequest,
    SessionDeleteResponse,
    SessionMetadataUpdateRequest,
    SessionStatusResponse,
    VideoSegmentTimingUpdateRequest,
)
from backend.app.services.elastic_pipeline import ElasticPipelineService
from backend.app.services.session_store import SessionStore
from backend.app.services.upload_sessions import UploadSessionService

settings = get_settings()
store = SessionStore(settings.sessions_root)
pipeline = ElasticPipelineService(settings, store)
upload_sessions = UploadSessionService(store)

router = APIRouter(prefix="/api", tags=["api"])


def _spawn_session_build(session_id: str) -> None:
    subprocess.Popen(
        [sys.executable, "-m", "backend.app.worker.run_session", session_id],
        cwd=str(PROJECT_ROOT),
        start_new_session=True,
    )


def _contains_dataset_dirs(path: Path) -> bool:
    required = ["metadata", "event", "tracking"]
    return all((path / name).is_dir() for name in required)


def _detect_dataset_root(extracted_root: Path) -> Path:
    # Case 1: directly extracted to expected structure.
    if _contains_dataset_dirs(extracted_root):
        return extracted_root

    # Case 2: nested folder(s), e.g. dataset-name/metadata... or __MACOSX + dataset-name.
    candidates = sorted([p for p in extracted_root.rglob("*") if p.is_dir()])
    for candidate in candidates:
        if candidate.name.startswith(".") or candidate.name == "__MACOSX":
            continue
        if _contains_dataset_dirs(candidate):
            return candidate

    raise HTTPException(
        status_code=400,
        detail=(
            "Uploaded zip does not contain required folders: metadata/, event/, tracking/. "
            "Please upload a zip with that structure."
        ),
    )


def _to_status_response(metadata: dict) -> SessionStatusResponse:
    return SessionStatusResponse(
        session_id=metadata["session_id"],
        annotator_name=metadata["annotator_name"],
        match_id=metadata["match_id"],
        session_mode=metadata.get("session_mode", "legacy_elastic"),
        persist=bool(metadata.get("persist", True)),
        session_name=metadata.get("session_name"),
        status=metadata["status"],
        dataset_root=metadata["dataset_root"],
        progress=metadata.get("progress"),
        error_message=metadata.get("error_message"),
        created_at=datetime.fromisoformat(metadata["created_at"]),
        updated_at=datetime.fromisoformat(metadata["updated_at"]),
        event_count=metadata.get("event_count", 0),
        fps=metadata.get("fps"),
        video_url=metadata.get("video_url"),
        video_urls=metadata.get("video_urls"),
        video_start_frame=metadata.get("video_start_frame"),
        original_video_filename=metadata.get("original_video_filename"),
        video_start_frame_source=metadata.get("video_start_frame_source"),
        video_start_frame_confirmed=bool(metadata.get("video_start_frame_confirmed", False)),
        video_duration_seconds=metadata.get("video_duration_seconds"),
        video_frame_count=metadata.get("video_frame_count"),
        video_segments=metadata.get("video_segments") or [],
    )


def _session_has_video_artifact(metadata: dict) -> bool:
    session_id = str(metadata.get("session_id") or "").strip()
    if not session_id:
        return False

    normalized_segments = metadata.get("video_segments") or upload_sessions.normalize_video_segments(session_id, metadata)
    if not normalized_segments:
        return False

    has_any = False
    for segment in normalized_segments:
        url = str(segment.get("url") or "")
        if not url:
            continue
        if url.startswith("http://") or url.startswith("https://"):
            has_any = True
            continue
        local_path = upload_sessions._artifact_path_for_url(session_id, url)
        if local_path is not None and local_path.exists():
            has_any = True
    return has_any


def _ready_integrity_reasons(metadata: dict) -> list[str]:
    reasons: list[str] = []
    if not _session_has_video_artifact(metadata):
        reasons.append("video_not_prepared")
    return reasons


def _ensure_ready_session_integrity(metadata: dict) -> dict:
    if metadata.get("status") != "ready":
        return metadata

    reasons = _ready_integrity_reasons(metadata)
    if not reasons:
        return metadata

    session_id = str(metadata.get("session_id") or "")
    reason_text = ", ".join(reasons)
    updated = store.update_metadata(
        session_id,
        status="error",
        progress="invalid_ready_state",
        error_message=f"Session marked invalid from ready: {reason_text}",
    )
    return updated


def _ensure_invalid_ready_state_recovery(metadata: dict) -> dict:
    if metadata.get("status") != "error":
        return metadata
    if metadata.get("progress") != "invalid_ready_state":
        return metadata

    message = str(metadata.get("error_message") or "")
    if not message.startswith("Session marked invalid from ready:"):
        return metadata

    reasons = _ready_integrity_reasons(metadata)
    session_id = str(metadata.get("session_id") or "")
    if reasons:
        reason_text = ", ".join(reasons)
        next_message = f"Session marked invalid from ready: {reason_text}"
        if message == next_message:
            return metadata
        return store.update_metadata(
            session_id,
            status="error",
            progress="invalid_ready_state",
            error_message=next_message,
        )

    return store.update_metadata(
        session_id,
        status="ready",
        progress="autosaved",
        error_message=None,
    )


def _normalize_session_integrity(metadata: dict) -> dict:
    normalized = upload_sessions.normalize_video_metadata(metadata)
    normalized = _ensure_ready_session_integrity(normalized)
    normalized = _ensure_invalid_ready_state_recovery(normalized)
    normalized = upload_sessions.normalize_video_metadata(normalized)
    return normalized


def _collect_validation_warnings(metadata: dict, events: list[dict]) -> list[str]:
    stored = metadata.get("validation_warnings") or []
    dynamic = pipeline.validate_events(events)
    return [str(item) for item in [*stored, *dynamic] if str(item).strip()]


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/meta/spadl-types", response_model=list[str])
def list_spadl_types() -> list[str]:
    return SPADL_EXTENDED_TYPES


@router.get("/meta/default-dataset-root", response_model=DefaultDatasetRootResponse)
def get_default_dataset_root() -> DefaultDatasetRootResponse:
    root = settings.default_dataset_root.expanduser().resolve()
    return DefaultDatasetRootResponse(dataset_root=str(root), exists=root.exists())


@router.get("/matches", response_model=list[MatchSummary])
def list_matches(dataset_root: str | None = None) -> list[MatchSummary]:
    root_path = Path(dataset_root).expanduser() if dataset_root else None
    matches = pipeline.list_matches(root_path)
    return [MatchSummary(**m) for m in matches]


@router.post(
    "/sessions",
    response_model=SessionStatusResponse,
    responses={400: {"model": ErrorResponse}},
)
def create_session(request: SessionCreateRequest) -> SessionStatusResponse:
    dataset_root = Path(request.dataset_root).expanduser() if request.dataset_root else settings.default_dataset_root
    dataset_root = dataset_root.resolve()

    if not dataset_root.exists():
        raise HTTPException(status_code=400, detail=f"dataset_root not found: {dataset_root}")

    existing = store.find_processing_session(
        match_id=request.match_id,
        dataset_root=str(dataset_root),
        session_mode="legacy_elastic",
    )
    if existing is not None:
        return _to_status_response(existing)

    metadata = store.create_session(
        annotator_name=request.annotator_name,
        match_id=request.match_id,
        dataset_root=str(dataset_root),
        generate_video=request.generate_video,
    )

    _spawn_session_build(metadata["session_id"])

    return _to_status_response(metadata)


@router.post(
    "/upload-sessions",
    response_model=SessionStatusResponse,
    responses={400: {"model": ErrorResponse}},
)
def create_upload_session(
    video_file: UploadFile = File(...),
    csv_file: UploadFile = File(...),
    persist: bool = Form(default=False),
    session_name: str | None = Form(default=None),
    video_start_frame: int | None = Form(default=None),
) -> SessionStatusResponse:
    metadata = upload_sessions.create_upload_session(
        video_file=video_file,
        csv_file=csv_file,
        persist=persist,
        session_name=session_name,
        video_start_frame=video_start_frame,
    )
    metadata = _normalize_session_integrity(metadata)
    return _to_status_response(metadata)


@router.get("/sessions/{session_id}", response_model=SessionStatusResponse)
def get_session(session_id: str) -> SessionStatusResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    metadata = _normalize_session_integrity(metadata)
    return _to_status_response(metadata)


@router.patch("/sessions/{session_id}", response_model=SessionStatusResponse)
def update_session_metadata(
    session_id: str,
    request: SessionMetadataUpdateRequest,
) -> SessionStatusResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    metadata = upload_sessions.normalize_video_metadata(metadata)
    update_kwargs: dict[str, object] = {}

    if "video_start_frame" in request.model_fields_set:
        segments = upload_sessions.normalize_video_segments(session_id, metadata)
        if len(segments) > 1:
            raise HTTPException(
                status_code=409,
                detail="Start frame editing is only available while the session has a single video segment.",
            )

        if segments and request.video_start_frame is not None:
            primary_segment = dict(segments[0])
            primary_segment["start_frame"] = request.video_start_frame
            update_kwargs.update(
                upload_sessions.build_video_metadata_patch(
                    [primary_segment],
                    metadata,
                    primary_source="manual",
                    primary_confirmed=True,
                )
            )
        else:
            update_kwargs["video_start_frame"] = request.video_start_frame
            update_kwargs["video_start_frame_confirmed"] = request.video_start_frame is not None

    if "title" in request.model_fields_set:
        normalized_title = (request.title or "").strip()
        update_kwargs["session_name"] = normalized_title or None

    if update_kwargs:
        metadata = store.update_metadata(session_id, **update_kwargs)

    metadata = _normalize_session_integrity(metadata)
    return _to_status_response(metadata)


@router.post("/sessions/{session_id}/videos", response_model=SessionStatusResponse)
def add_session_video(
    session_id: str,
    video_file: UploadFile = File(...),
    start_frame: int | None = Form(default=None),
) -> SessionStatusResponse:
    if start_frame is not None and start_frame < 0:
        raise HTTPException(status_code=400, detail="start_frame must be non-negative")

    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if metadata.get("status") == "processing":
        raise HTTPException(
            status_code=409,
            detail="Cannot replace videos while the session is still processing.",
        )

    updated = upload_sessions.add_video_segment(
        session_id=session_id,
        metadata=metadata,
        video_file=video_file,
        start_frame=start_frame,
    )
    updated = _normalize_session_integrity(updated)
    return _to_status_response(updated)


@router.patch("/sessions/{session_id}/videos/{segment_id}/timing", response_model=SessionStatusResponse)
def update_session_video_timing(
    session_id: str,
    segment_id: str,
    request: VideoSegmentTimingUpdateRequest,
) -> SessionStatusResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if metadata.get("status") == "processing":
        raise HTTPException(
            status_code=409,
            detail="Cannot update video timing while the session is still processing.",
        )

    updated = upload_sessions.update_video_segment_timing(
        session_id=session_id,
        metadata=metadata,
        segment_id=segment_id,
        period_start_frame=request.period_start_frame,
        video_start_time_seconds=request.video_start_time_seconds,
    )
    updated = _normalize_session_integrity(updated)
    return _to_status_response(updated)


@router.delete("/sessions/{session_id}", response_model=SessionDeleteResponse)
def delete_session(session_id: str) -> SessionDeleteResponse:
    try:
        store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    deleted = store.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Unknown session: {session_id}")

    return SessionDeleteResponse(ok=True, session_id=session_id)


@router.get("/sessions", response_model=list[SessionStatusResponse])
def list_sessions(
    limit: int = Query(default=20, ge=1, le=200),
    status: str | None = Query(default=None),
    match_id: str | None = Query(default=None),
    session_mode: str | None = Query(default=None),
    include_ephemeral: bool = Query(default=False),
) -> list[SessionStatusResponse]:
    if status is not None and status not in {"processing", "ready", "error"}:
        raise HTTPException(status_code=400, detail="status must be one of: processing, ready, error")
    if session_mode is not None and session_mode not in {"legacy_elastic", "upload_csv"}:
        raise HTTPException(status_code=400, detail="session_mode must be one of: legacy_elastic, upload_csv")
    base_limit = 100_000 if status is not None else limit
    sessions = store.list_sessions(
        limit=base_limit,
        status=None,
        match_id=match_id,
        session_mode=session_mode,
        include_ephemeral=include_ephemeral,
    )
    normalized: list[dict] = []
    for metadata in sessions:
        normalized.append(_normalize_session_integrity(metadata))
    if status is not None:
        normalized = [metadata for metadata in normalized if metadata.get("status") == status]
    sessions = normalized[: max(1, limit)]
    return [_to_status_response(metadata) for metadata in sessions]


@router.post("/maintenance/prune-sessions")
def prune_sessions(keep_processing: bool = Query(default=True)) -> dict[str, object]:
    snapshots = store.list_sessions(limit=100_000, status=None, match_id=None)
    for metadata in snapshots:
        _normalize_session_integrity(metadata)
    return store.prune_keep_latest_alive(keep_processing=keep_processing)


@router.post("/sessions/{session_id}/resume", response_model=SessionStatusResponse)
def resume_session(session_id: str, force: bool = Query(default=False)) -> SessionStatusResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if metadata.get("status") == "processing":
        if not force:
            return _to_status_response(metadata)

    if metadata.get("status") == "ready":
        raise HTTPException(
            status_code=400,
            detail="This session is already completed (ready). Create a new session if you need a fresh run.",
        )

    conflict = store.find_processing_session(
        match_id=metadata.get("match_id"),
        dataset_root=metadata.get("dataset_root"),
    )
    if conflict is not None and conflict.get("session_id") != session_id:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Another session is already processing for this match: {conflict.get('session_id')}. "
                "Wait for it to finish or resume that session."
            ),
        )

    resumed = store.prepare_resume(session_id)
    _spawn_session_build(session_id)
    return _to_status_response(resumed)


@router.get("/sessions/{session_id}/events", response_model=EventListResponse)
def get_events(
    session_id: str,
    variant: str = Query(default="current"),
) -> EventListResponse:
    if variant not in {"current", "initial"}:
        raise HTTPException(status_code=400, detail="variant must be one of: current, initial")

    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if variant == "initial":
        try:
            events = store.load_initial_events(session_id)
        except FileNotFoundError:
            events = store.load_events(session_id)
        if not events:
            events = store.load_events(session_id)
    else:
        events = store.load_events(session_id)

    warnings = _collect_validation_warnings(metadata, events)
    return EventListResponse(session_id=session_id, events=events, validation_warnings=warnings)


@router.put("/sessions/{session_id}/events", response_model=EventSaveResponse)
def save_events(session_id: str, request: EventSaveRequest) -> EventSaveResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    events = [event.model_dump() for event in request.events]
    warnings = _collect_validation_warnings(metadata, events)
    store.save_events(session_id, events)
    store.update_metadata(session_id, event_count=len(events), progress="autosaved")

    return EventSaveResponse(
        ok=True,
        saved_count=len(events),
        validation_warnings=warnings,
    )


@router.post("/sessions/{session_id}/reset-events")
def reset_events(session_id: str) -> dict[str, object]:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        events, source = pipeline.reset_events_to_initial(session_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    warnings = _collect_validation_warnings(metadata, events)
    return {
        "ok": True,
        "restored_count": len(events),
        "source": source,
        "validation_warnings": warnings,
    }


@router.get("/sessions/{session_id}/export.csv")
def export_session_csv(
    session_id: str,
    variant: str = Query(default="current"),
) -> FileResponse:
    if variant not in {"current", "initial"}:
        raise HTTPException(status_code=400, detail="variant must be one of: current, initial")

    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if variant == "initial":
        try:
            events = store.load_initial_events(session_id)
        except FileNotFoundError:
            events = store.load_events(session_id)
    else:
        events = store.load_events(session_id)

    if not events:
        events = store.load_events(session_id)

    export_path = upload_sessions.export_events_csv(session_id, events, variant=variant)
    match_label = str(metadata.get("match_id") or session_id).strip() or session_id
    suffix = "original" if variant == "initial" else "edited"
    filename = f"{match_label}_{suffix}_gt_events.csv"
    return FileResponse(path=export_path, filename=filename, media_type="text/csv")


@router.post("/datasets/upload", response_model=DatasetUploadResponse)
def upload_dataset(zip_file: UploadFile = File(...)) -> DatasetUploadResponse:
    if not zip_file.filename or not zip_file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Please upload a .zip file")

    dataset_name = Path(zip_file.filename).stem
    target_dir = settings.datasets_root / dataset_name

    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    temp_zip = target_dir / "upload.zip"
    with temp_zip.open("wb") as f:
        shutil.copyfileobj(zip_file.file, f)

    with zipfile.ZipFile(temp_zip, "r") as archive:
        archive.extractall(target_dir)

    temp_zip.unlink(missing_ok=True)

    normalized_root = _detect_dataset_root(target_dir)

    return DatasetUploadResponse(dataset_root=str(normalized_root.resolve()))
