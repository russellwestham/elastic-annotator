from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

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
    SheetMappingResponse,
    SheetMappingUpdateRequest,
    SessionCreateRequest,
    SessionStatusResponse,
)
from backend.app.services.elastic_pipeline import ElasticPipelineService
from backend.app.services.sheet_mapping_store import SheetMappingStore
from backend.app.services.session_store import SessionStore
from backend.app.services.sheets import GoogleSheetsService

settings = get_settings()
store = SessionStore(settings.sessions_root)
sheets = GoogleSheetsService(settings)
sheet_mappings = SheetMappingStore(settings.sheet_mappings_path)
pipeline = ElasticPipelineService(settings, store, sheets, sheet_mappings)

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
        sheet_url=metadata.get("sheet_url"),
    )


def _to_sheet_mapping_response(match_id: str, sheet_id: str | None) -> SheetMappingResponse:
    sheet_url = GoogleSheetsService.build_sheet_url(sheet_id) if sheet_id else None
    return SheetMappingResponse(match_id=match_id, sheet_id=sheet_id, sheet_url=sheet_url)


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


@router.get("/sheet-mappings/{match_id}", response_model=SheetMappingResponse)
def get_sheet_mapping(match_id: str) -> SheetMappingResponse:
    sheet_id = sheet_mappings.get_sheet_id(match_id)
    if not sheet_id:
        discovered_sheet_id = sheets.find_existing_sheet_id(match_id)
        if discovered_sheet_id:
            sheet_mappings.set_sheet_id(match_id, discovered_sheet_id)
            sheet_id = discovered_sheet_id
    return _to_sheet_mapping_response(match_id, sheet_id)


@router.put("/sheet-mappings/{match_id}", response_model=SheetMappingResponse)
def upsert_sheet_mapping(match_id: str, request: SheetMappingUpdateRequest) -> SheetMappingResponse:
    try:
        normalized_sheet_id = sheets.normalize_sheet_id(request.sheet_ref)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    sheet_mappings.set_sheet_id(match_id, normalized_sheet_id)
    return _to_sheet_mapping_response(match_id, normalized_sheet_id)


@router.delete("/sheet-mappings/{match_id}", response_model=SheetMappingResponse)
def clear_sheet_mapping(match_id: str) -> SheetMappingResponse:
    sheet_mappings.clear_sheet_id(match_id)
    return _to_sheet_mapping_response(match_id, None)


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

    existing = store.find_processing_session(match_id=request.match_id, dataset_root=str(dataset_root))
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


@router.get("/sessions/{session_id}", response_model=SessionStatusResponse)
def get_session(session_id: str) -> SessionStatusResponse:
    try:
        metadata = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _to_status_response(metadata)


@router.get("/sessions", response_model=list[SessionStatusResponse])
def list_sessions(
    limit: int = Query(default=20, ge=1, le=200),
    status: str | None = Query(default=None),
    match_id: str | None = Query(default=None),
) -> list[SessionStatusResponse]:
    if status is not None and status not in {"processing", "ready", "error"}:
        raise HTTPException(status_code=400, detail="status must be one of: processing, ready, error")
    sessions = store.list_sessions(limit=limit, status=status, match_id=match_id)
    return [_to_status_response(metadata) for metadata in sessions]


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
def get_events(session_id: str) -> EventListResponse:
    try:
        events = store.load_events(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    warnings = pipeline.validate_events(events)
    return EventListResponse(session_id=session_id, events=events, validation_warnings=warnings)


@router.put("/sessions/{session_id}/events", response_model=EventSaveResponse)
def save_events(session_id: str, request: EventSaveRequest) -> EventSaveResponse:
    try:
        _ = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    events = [event.model_dump() for event in request.events]
    warnings = pipeline.validate_events(events)
    store.save_events(session_id, events)
    store.update_metadata(session_id, event_count=len(events), progress="autosaved")

    sheet_synced = False
    if request.sync_sheet and sheets.enabled:
        try:
            pipeline.sync_sheet(session_id)
            sheet_synced = True
        except Exception as exc:
            warnings.append(f"google sheet sync failed: {exc}")

    return EventSaveResponse(
        ok=True,
        saved_count=len(events),
        validation_warnings=warnings,
        sheet_synced=sheet_synced,
    )


@router.post("/sessions/{session_id}/sync-sheet")
def sync_sheet(session_id: str) -> dict[str, str | None]:
    try:
        _ = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if not sheets.enabled:
        raise HTTPException(status_code=400, detail="Google Sheets integration is disabled")

    url = pipeline.sync_sheet(session_id)
    return {"sheet_url": url}


@router.post("/sessions/{session_id}/reset-sheet")
def reset_sheet(session_id: str) -> dict[str, str | None]:
    try:
        _ = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if not sheets.enabled:
        raise HTTPException(status_code=400, detail="Google Sheets integration is disabled")

    try:
        url = pipeline.reset_sheet(session_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"sheet_url": url}


@router.post("/sessions/{session_id}/reset-events")
def reset_events(session_id: str, sync_sheet: bool = Query(default=True)) -> dict[str, object]:
    try:
        _ = store.load_metadata(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        events, source = pipeline.reset_events_to_initial(session_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    warnings = pipeline.validate_events(events)
    sheet_url = None
    if sync_sheet and sheets.enabled:
        try:
            sheet_url = pipeline.sync_sheet(session_id)
        except Exception as exc:
            warnings.append(f"google sheet sync failed: {exc}")

    return {
        "ok": True,
        "restored_count": len(events),
        "source": source,
        "validation_warnings": warnings,
        "sheet_url": sheet_url,
    }


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
