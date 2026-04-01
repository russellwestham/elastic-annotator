from __future__ import annotations

import argparse

from backend.app.core.settings import get_settings
from backend.app.services.elastic_pipeline import ElasticPipelineService
from backend.app.services.session_store import SessionStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Run ELASTIC session build as a detached worker process")
    parser.add_argument("session_id", help="Session ID to build")
    args = parser.parse_args()

    settings = get_settings()
    store = SessionStore(settings.sessions_root)
    pipeline = ElasticPipelineService(settings, store)
    pipeline.build_session(args.session_id)


if __name__ == "__main__":
    main()
