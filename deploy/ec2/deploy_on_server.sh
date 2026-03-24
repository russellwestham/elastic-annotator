#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/elastic-annotator}"
UV_BIN="${UV_BIN:-/home/ubuntu/.local/bin/uv}"

cd "$REPO_DIR"

git fetch origin main
git checkout main
git reset --hard origin/main

"$UV_BIN" sync

cd frontend
npm ci
npm run build
cd ..

sudo systemctl restart elastic-annotator

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:8000/api/health
    exit 0
  fi
  sleep 2
done

echo "health check failed after restart" >&2
exit 1
