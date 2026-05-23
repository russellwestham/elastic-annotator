from __future__ import annotations

import csv
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


MATCH_IDS = ["J03WN1", "J03WMX", "J03WPY"]
ANNOTATORS = ["hyunsung", "hoyoung", "kunhee"]
FPS = 25.0


def build_events(match_id: str) -> list[dict[str, object]]:
    base_frame = 10000
    event_types = ["control", "pass", "control", "foul", "pass", "shot"]
    events: list[dict[str, object]] = []
    for index, spadl_type in enumerate(event_types, start=1):
        frame = base_frame + index * 50
        seconds = (frame - base_frame) / FPS
        events.append(
            {
                "id": f"seed_{match_id}_{index:03d}",
                "period_id": 1,
                "spadl_type": spadl_type,
                "player_id": f"{'home' if index % 2 else 'away'}_{index}",
                "synced_frame_id": frame,
                "synced_ts": f"00:{seconds:05.2f}",
                "receiver_id": f"{'home' if index % 2 else 'away'}_{index + 1}" if spadl_type == "pass" else "",
                "receive_frame_id": frame + 8 if spadl_type == "pass" else None,
                "receive_ts": f"00:{seconds + 8 / FPS:05.2f}" if spadl_type == "pass" else "",
                "outcome": index != 4,
                "error_type": None,
                "note": "local public mock",
            }
        )
    return events


def write_uploaded_csv(path: Path, events: list[dict[str, object]]) -> None:
    fields = [
        "id",
        "period_id",
        "spadl_type",
        "player_id",
        "synced_frame_id",
        "synced_ts",
        "receiver_id",
        "receive_frame_id",
        "receive_ts",
        "outcome",
        "error_type",
        "note",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for event in events:
            writer.writerow({field: event.get(field) for field in fields})


def main() -> int:
    from backend.app.core.settings import get_settings
    from backend.app.services.session_store import SessionStore

    settings = get_settings()
    store = SessionStore(settings.sessions_root)
    existing_names = {
        str(metadata.get("session_name") or "").strip()
        for metadata in store.list_sessions(limit=100_000, include_ephemeral=True)
    }

    created: list[str] = []
    skipped: list[str] = []
    for match_id in MATCH_IDS:
        events = build_events(match_id)
        for annotator in ANNOTATORS:
            session_name = f"{match_id}_{annotator}"
            if session_name in existing_names:
                skipped.append(session_name)
                continue

            metadata = store.create_session(
                annotator_name=annotator,
                match_id=match_id,
                dataset_root="",
                generate_video=False,
                session_mode="upload_csv",
                persist=True,
                session_name=session_name,
            )
            session_id = str(metadata["session_id"])
            store.save_initial_events(session_id, events)
            store.save_events(session_id, events)
            write_uploaded_csv(store.session_dir(session_id) / "uploaded_events.csv", events)
            store.update_metadata(
                session_id,
                status="ready",
                progress="seeded_public_mock",
                event_count=len(events),
                fps=FPS,
                validation_warnings=[],
            )
            created.append(f"{session_name} ({session_id})")

    print(f"public mock sessions created={len(created)} skipped={len(skipped)}")
    for item in created:
        print(f"created {item}")
    for item in skipped:
        print(f"skipped {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
