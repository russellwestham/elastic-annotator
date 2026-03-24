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
sleep 2
curl -fsS http://127.0.0.1:8000/api/health
