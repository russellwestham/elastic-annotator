#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/elastic-annotator}"
UV_BIN="${UV_BIN:-/home/ubuntu/.local/bin/uv}"

cd "$REPO_DIR"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "deploy blocked: server branch must be main" >&2
  exit 1
fi

if ! git diff --quiet --ignore-submodules --; then
  echo "deploy blocked: tracked file edits exist on server; commit/push from local first" >&2
  git status --short
  exit 1
fi

if ! git diff --cached --quiet --ignore-submodules --; then
  echo "deploy blocked: staged changes exist on server; commit/push from local first" >&2
  git status --short
  exit 1
fi

if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "deploy blocked: untracked non-ignored files exist on server" >&2
  git status --short
  exit 1
fi

for attempt in 1 2 3; do
  if git fetch origin main; then
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "git fetch failed after retries" >&2
    exit 1
  fi
  sleep 5
done
git checkout main
git pull --ff-only origin main

DEPLOY_SHA="$(git rev-parse --short HEAD)"
echo "deploying commit: $DEPLOY_SHA"

"$UV_BIN" sync

cd frontend
install_ok=false
for attempt in 1 2; do
  if ! npm ci; then
    echo "npm ci failed (attempt $attempt); cleaning node_modules and retrying" >&2
    rm -rf node_modules
    continue
  fi
  if [ -x node_modules/.bin/tsc ] && [ -x node_modules/.bin/vite ]; then
    install_ok=true
    break
  fi
  echo "npm ci completed but tsc/vite binaries are missing (attempt $attempt)" >&2
  rm -rf node_modules
done

if [ "$install_ok" != "true" ]; then
  echo "frontend dependency install validation failed after retries" >&2
  exit 1
fi
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
