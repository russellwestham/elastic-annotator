from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

def main() -> int:
    from backend.app.core.settings import get_settings
    from backend.app.services.session_store import SessionStore
    from backend.app.services.upload_sessions import UploadSessionService

    settings = get_settings()
    store = SessionStore(settings.sessions_root)
    upload_sessions = UploadSessionService(store)

    scanned = 0
    changed: list[tuple[str, int, int]] = []
    errors: list[tuple[str, str]] = []

    for csv_path in sorted(settings.sessions_root.glob("*/uploaded_events.csv")):
        session_id = csv_path.parent.name
        scanned += 1
        try:
            before_count = len(store.load_events(session_id))
            metadata = store.load_metadata(session_id)
            upload_sessions.backfill_upload_csv_missing_sync_anchors(session_id, metadata)
            after_count = len(store.load_events(session_id))
        except Exception as exc:
            errors.append((session_id, str(exc)))
            continue

        if after_count != before_count:
            changed.append((session_id, before_count, after_count))

    print(f"upload CSV backfill scanned={scanned} changed={len(changed)} errors={len(errors)}")
    for session_id, before_count, after_count in changed:
        print(f"backfilled {session_id}: {before_count} -> {after_count}")
    for session_id, message in errors:
        print(f"error {session_id}: {message}", file=sys.stderr)

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
