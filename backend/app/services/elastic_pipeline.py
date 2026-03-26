from __future__ import annotations

import logging
import re
import sys
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

from backend.app.core.constants import PASS_LIKE_TYPES
from backend.app.core.settings import Settings
from backend.app.services.sheet_mapping_store import SheetMappingStore
from backend.app.services.session_store import SessionStore
from backend.app.services.sheets import GoogleSheetsService
from backend.app.utils.timecode import frame_to_timestamp

logger = logging.getLogger(__name__)

MATCH_ID_PATTERN = re.compile(r"DFL-MAT-([A-Z0-9]+)")
SEGMENT_FRAME_PATTERN = re.compile(r"_(\d+)-(\d+)\.mp4(?:$|\?)")


class ElasticPipelineService:
    def __init__(
        self,
        settings: Settings,
        store: SessionStore,
        sheets: GoogleSheetsService,
        sheet_mappings: SheetMappingStore,
    ) -> None:
        self.settings = settings
        self.store = store
        self.sheets = sheets
        self.sheet_mappings = sheet_mappings

    def list_matches(self, dataset_root: Path | None = None) -> list[dict[str, str | None]]:
        root = (dataset_root or self.settings.default_dataset_root).expanduser()
        metadata_dir = root / "metadata"
        if not metadata_dir.exists():
            return []

        matches: list[dict[str, str | None]] = []
        for xml_path in sorted(metadata_dir.glob("*.xml")):
            match_id = self._extract_match_id(xml_path.name)
            if match_id is None:
                continue

            home_team = None
            away_team = None
            try:
                tree = ET.parse(xml_path)
                general = tree.getroot().find(".//General")
                if general is not None:
                    home_team = general.attrib.get("HomeTeamName")
                    away_team = general.attrib.get("GuestTeamName")
            except Exception:
                logger.warning("Failed to parse metadata XML: %s", xml_path)

            matches.append(
                {
                    "match_id": match_id,
                    "home_team": home_team,
                    "away_team": away_team,
                }
            )

        return matches

    def build_session(self, session_id: str) -> None:
        metadata = self.store.load_metadata(session_id)
        dataset_root = Path(metadata["dataset_root"]).expanduser()
        match_id = metadata["match_id"]
        annotator_name = metadata["annotator_name"]

        try:
            self.store.update_metadata(session_id, status="processing", progress="loading_elastic")
            self._prepare_elastic_imports(dataset_root)
            self._patch_schema_validation()

            import matplotlib
            from matplotlib import animation

            matplotlib.use("Agg")

            from sync.elastic_nw import ELASTIC_NW
            from tools.animator import Animator
            from tools.evaluate import collapse_events
            from tools.match_data import MatchData
            from tools.sportec_data import SportecData

            self.store.update_metadata(
                session_id,
                progress="loading_match_data (this can take several minutes on small servers)",
            )
            match = SportecData(match_id=match_id)

            input_events = match.format_events_for_syncer()
            input_tracking = match.format_tracking_for_syncer()
            input_events["utc_timestamp"] = pd.to_datetime(input_events["utc_timestamp"]).astype("datetime64[ns]")
            input_tracking["utc_timestamp"] = pd.to_datetime(input_tracking["utc_timestamp"]).astype("datetime64[ns]")

            self.store.update_metadata(session_id, progress="running_elastic")
            syncer = ELASTIC_NW(input_events, input_tracking)
            synced_with_controls = syncer.run(simplify_one_touch=False)
            collapsed_events = collapse_events(synced_with_controls)
            rows = self._to_annotation_rows(collapsed_events, fps=match.fps)
            video_url = None
            video_urls: list[str] = []
            video_frame_range: tuple[int, int] | None = None

            if metadata.get("generate_video", True):
                self.store.update_metadata(session_id, progress="rendering_video")
                # Avoid a second syncer.run(events=...) call: ELASTIC_NW internally appends
                # foul alignment rows using self.events index, which can mismatch external
                # event indices and raise KeyError during assignment.
                synced_for_video = synced_with_controls.copy()
                control_mask = synced_for_video["spadl_type"] == "control"
                one_touch_mask = (synced_for_video["frame_id"].shift(-1) == synced_for_video["frame_id"]) | (
                    synced_for_video["frame_id"].shift(-1).isna()
                )
                synced_for_video = synced_for_video.loc[~(control_mask & one_touch_mask)].reset_index(drop=True)
                merged = MatchData.merge_synced_events_and_tracking(
                    synced_for_video,
                    match.tracking,
                    match.fps,
                    ffill=True,
                )
                segment_data = merged.set_index("frame_id").copy()
                session_dir = self.store.session_dir(session_id)
                writer = animation.FFMpegWriter(fps=match.fps)

                if segment_data.empty:
                    raise RuntimeError("No tracking rows available for video rendering")

                start_frame = int(segment_data.index.min())
                end_frame = int(segment_data.index.max())
                video_frame_range = (start_frame, end_frame)
                segment_frames = max(1, int(round(match.fps * self.settings.video_segment_seconds)))
                total_segments = ((end_frame - start_frame) // segment_frames) + 1

                for seg_idx, frame_from in enumerate(range(start_frame, end_frame + 1, segment_frames), start=1):
                    frame_to = min(frame_from + segment_frames - 1, end_frame)
                    segment_df = segment_data.loc[frame_from:frame_to].copy()
                    if segment_df.shape[0] < 2:
                        continue

                    self.store.update_metadata(
                        session_id,
                        progress=f"rendering_video {seg_idx}/{total_segments}",
                    )

                    animator = Animator({"main": segment_df}, show_events=True)
                    anim = animator.run(fps=match.fps)

                    seg_name = f"animation_{seg_idx:03d}_{frame_from}-{frame_to}.mp4"
                    seg_path = session_dir / seg_name
                    anim.save(str(seg_path), writer=writer)

                    seg_url = f"/artifacts/sessions/{session_id}/{seg_name}"
                    video_urls.append(seg_url)
                    self.store.update_metadata(
                        session_id,
                        progress=f"rendering_video {seg_idx}/{total_segments}",
                        video_url=video_urls[0],
                        video_urls=video_urls,
                    )

                if video_urls:
                    video_url = video_urls[0]
                else:
                    raise RuntimeError("Video rendering produced no segments")

            if video_frame_range is not None:
                frame_start, frame_end = video_frame_range
                before_count = len(rows)
                rows = [
                    row
                    for row in rows
                    if row.get("synced_frame_id") is None
                    or (frame_start <= int(row["synced_frame_id"]) <= frame_end)
                ]
                dropped = before_count - len(rows)
                if dropped > 0:
                    logger.info(
                        "Dropped %d out-of-range events outside rendered frame range [%d, %d]",
                        dropped,
                        frame_start,
                        frame_end,
                    )

            self.store.save_initial_events(session_id, rows)
            self.store.save_events(session_id, rows)

            sheet_meta: dict[str, str | None] = {
                "sheet_url": None,
                "sheet_tab_name": None,
                "sheet_gid": None,
                "sheet_tab_url": None,
            }
            if self.sheets.enabled:
                self.store.update_metadata(session_id, progress="syncing_google_sheets")
                mapped_sheet_id = self.sheet_mappings.get_sheet_id(match_id)
                sheet_meta = self.sheets.upsert_annotations(
                    match_id,
                    annotator_name,
                    rows,
                    sheet_id=mapped_sheet_id,
                )

            self.store.update_metadata(
                session_id,
                status="ready",
                progress="done",
                event_count=len(rows),
                fps=float(match.fps),
                video_url=video_url,
                video_urls=video_urls,
                sheet_url=sheet_meta.get("sheet_url"),
                sheet_tab_name=sheet_meta.get("sheet_tab_name"),
                sheet_gid=sheet_meta.get("sheet_gid"),
                sheet_tab_url=sheet_meta.get("sheet_tab_url"),
            )

        except Exception as exc:
            logger.exception("Failed to build session %s", session_id)
            self.store.update_metadata(
                session_id,
                status="error",
                progress="failed",
                error_message=f"{exc}\n{traceback.format_exc(limit=5)}",
            )

    def sync_sheet(self, session_id: str) -> str | None:
        if not self.sheets.enabled:
            return None

        metadata = self.store.load_metadata(session_id)
        events = self.store.load_events(session_id)
        match_id = metadata["match_id"]
        mapped_sheet_id = self.sheet_mappings.get_sheet_id(match_id)
        sheet_meta = self.sheets.upsert_annotations(
            match_id,
            metadata["annotator_name"],
            events,
            sheet_id=mapped_sheet_id,
        )
        self.store.update_metadata(
            session_id,
            sheet_url=sheet_meta.get("sheet_url"),
            sheet_tab_name=sheet_meta.get("sheet_tab_name"),
            sheet_gid=sheet_meta.get("sheet_gid"),
            sheet_tab_url=sheet_meta.get("sheet_tab_url"),
        )
        return sheet_meta.get("sheet_url")

    def reset_sheet(self, session_id: str) -> str | None:
        if not self.sheets.enabled:
            return None

        metadata = self.store.load_metadata(session_id)
        match_id = metadata["match_id"]
        mapped_sheet_id = self.sheet_mappings.get_sheet_id(match_id)
        sheet_url = self.sheets.reset_sheet(match_id, sheet_id=mapped_sheet_id)
        self.store.update_metadata(session_id, sheet_url=sheet_url)
        return sheet_url

    def reset_events_to_initial(self, session_id: str) -> tuple[list[dict], str]:
        metadata = self.store.load_metadata(session_id)

        source = "snapshot"
        try:
            initial_events = self.store.load_initial_events(session_id)
            # Old sessions may not have a proper baseline even if the file exists.
            if not initial_events and metadata.get("status") == "ready":
                raise FileNotFoundError("Initial snapshot empty; fallback to recompute")
        except FileNotFoundError:
            initial_events = self._recompute_initial_rows(metadata)
            self.store.save_initial_events(session_id, initial_events)
            source = "recomputed"

        self.store.save_events(session_id, initial_events)
        self.store.update_metadata(session_id, event_count=len(initial_events), progress="reset_to_initial")
        return initial_events, source

    def validate_events(self, events: list[dict]) -> list[str]:
        warnings: list[str] = []
        for event in events:
            spadl_type = str(event.get("spadl_type") or "")
            error_type = event.get("error_type")
            if spadl_type in PASS_LIKE_TYPES and error_type != "false_positive" and not event.get("receive_ts"):
                synced_frame_id = event.get("synced_frame_id")
                frame_label = f"frame_id={synced_frame_id}" if synced_frame_id is not None else "frame_id=unknown"
                warnings.append(
                    f"{frame_label}: pass-like event {event.get('id')} ({spadl_type}) has empty receive_ts"
                )
        return warnings

    @staticmethod
    def _extract_match_id(filename: str) -> str | None:
        match = MATCH_ID_PATTERN.search(filename)
        return match.group(1) if match else None

    def _prepare_elastic_imports(self, dataset_root: Path) -> None:
        repo_path = self.settings.elastic_repo_path.expanduser()
        if not repo_path.exists():
            raise FileNotFoundError(f"ELASTIC repo not found: {repo_path}")

        if str(repo_path) not in sys.path:
            sys.path.insert(0, str(repo_path))

        from tools import sportec_data

        sportec_data.META_DIR = str(dataset_root / "metadata")
        sportec_data.EVENT_DIR = str(dataset_root / "event")
        sportec_data.TRACKING_DIR = str(dataset_root / "tracking")

    @staticmethod
    def _patch_schema_validation() -> None:
        from sync import schema as sync_schema

        for schema_name in ["elastic_event_schema", "tracking_schema"]:
            schema_obj = getattr(sync_schema, schema_name, None)
            if schema_obj is not None and hasattr(schema_obj, "validate"):
                schema_obj.validate = lambda df, *_args, **_kwargs: df

    @staticmethod
    def _to_annotation_rows(collapsed_events: pd.DataFrame, fps: float) -> list[dict]:
        rows: list[dict] = []
        for idx, row in collapsed_events.reset_index(drop=True).iterrows():
            synced_frame_id = int(row["frame_id"]) if pd.notna(row.get("frame_id")) else None
            receive_frame_id = int(row["receive_frame_id"]) if pd.notna(row.get("receive_frame_id")) else None

            synced_ts = row.get("synced_ts")
            if pd.isna(synced_ts):
                synced_ts = frame_to_timestamp(synced_frame_id, fps)

            receive_ts = row.get("receive_ts")
            if pd.isna(receive_ts):
                receive_ts = frame_to_timestamp(receive_frame_id, fps)

            rows.append(
                {
                    "id": f"ev_{idx + 1:05d}",
                    "period_id": int(row["period_id"]),
                    "spadl_type": str(row["spadl_type"]),
                    "player_id": str(row["player_id"]),
                    "synced_frame_id": synced_frame_id,
                    "synced_ts": synced_ts,
                    "receiver_id": None if pd.isna(row.get("receiver_id")) else str(row.get("receiver_id")),
                    "receive_frame_id": receive_frame_id,
                    "receive_ts": receive_ts,
                    "outcome": bool(row.get("success", False)),
                    "error_type": None,
                    "note": "",
                }
            )

        return rows

    @staticmethod
    def _extract_video_frame_range(metadata: dict) -> tuple[int, int] | None:
        candidates: list[tuple[int, int]] = []
        video_urls = metadata.get("video_urls") or []
        if metadata.get("video_url"):
            video_urls = [metadata.get("video_url"), *video_urls]

        for video_path in video_urls:
            match = SEGMENT_FRAME_PATTERN.search(str(video_path))
            if not match:
                continue
            start = int(match.group(1))
            end = int(match.group(2))
            candidates.append((start, end))

        if not candidates:
            return None

        starts = [start for start, _ in candidates]
        ends = [end for _, end in candidates]
        return min(starts), max(ends)

    def _recompute_initial_rows(self, metadata: dict) -> list[dict]:
        dataset_root = Path(metadata["dataset_root"]).expanduser()
        match_id = metadata["match_id"]

        self._prepare_elastic_imports(dataset_root)
        self._patch_schema_validation()

        from sync.elastic_nw import ELASTIC_NW
        from tools.evaluate import collapse_events
        from tools.sportec_data import SportecData

        match = SportecData(match_id=match_id)
        input_events = match.format_events_for_syncer()
        input_tracking = match.format_tracking_for_syncer()
        input_events["utc_timestamp"] = pd.to_datetime(input_events["utc_timestamp"]).astype("datetime64[ns]")
        input_tracking["utc_timestamp"] = pd.to_datetime(input_tracking["utc_timestamp"]).astype("datetime64[ns]")

        syncer = ELASTIC_NW(input_events, input_tracking)
        synced_with_controls = syncer.run(simplify_one_touch=False)
        collapsed_events = collapse_events(synced_with_controls)
        rows = self._to_annotation_rows(collapsed_events, fps=match.fps)

        frame_range = self._extract_video_frame_range(metadata)
        if frame_range is None:
            return rows

        frame_start, frame_end = frame_range
        return [
            row
            for row in rows
            if row.get("synced_frame_id") is None
            or (frame_start <= int(row["synced_frame_id"]) <= frame_end)
        ]
