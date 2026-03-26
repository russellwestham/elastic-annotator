# Deployment (Low Cost, 3 Users)

This project runs cheapest and most reliably as a **single always-on machine** (lab PC/mini server) with:

- FastAPI backend (also serving built frontend)
- Local dataset + local ELASTIC repo access
- Cloudflare Tunnel + Access for private remote login

## Why this architecture

This app currently depends on:

- local dataset paths (`DEFAULT_DATASET_ROOT`)
- local ELASTIC repo path (`ELASTIC_REPO_PATH`)
- local artifact/session storage (`backend/storage`)
- optional heavy rendering (matplotlib/ffmpeg)

So a small PaaS/serverless setup usually adds migration work (object storage, queue workers, persistent volumes).

## 1) Build once

```bash
# repo root
uv sync

cd frontend
npm ci
npm run build
cd ..
```

`backend/app/main.py` now serves `frontend/dist` automatically if it exists.

## 2) Configure env

Use `.env` in repo root:

```bash
FRONTEND_ORIGIN=https://annotator.example.com
VIDEO_SEGMENT_SECONDS=300

ELASTIC_REPO_PATH=/absolute/path/to/elastic
DEFAULT_DATASET_ROOT=/absolute/path/to/sportec

SESSIONS_ROOT=/absolute/path/to/elastic-annotator/backend/storage/sessions
DATASETS_ROOT=/absolute/path/to/elastic-annotator/backend/storage/datasets
SHEET_MAPPINGS_PATH=/absolute/path/to/elastic-annotator/backend/storage/sheet_mappings.json

ENABLE_GOOGLE_SHEETS=true
GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/to/service-account.json
GOOGLE_SHEET_SHARE_EMAILS=user1@gmail.com,user2@gmail.com,user3@gmail.com
GOOGLE_SHEET_SHARE_ROLE=writer
GOOGLE_SHEET_SHARE_NOTIFY=false
```

## 3) Run backend in production mode

```bash
uv run uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Health check:

```bash
curl http://127.0.0.1:8000/api/health
```

## 4) Keep process alive with systemd (recommended)

Template file:

- `deploy/systemd/elastic-annotator.service`

After editing `User`, `Group`, `WorkingDirectory`, run:

```bash
sudo cp deploy/systemd/elastic-annotator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now elastic-annotator
sudo systemctl status elastic-annotator
```

## 5) Private access with Cloudflare Tunnel + Access

### Create tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create elastic-annotator
cloudflared tunnel route dns elastic-annotator annotator.example.com
```

### Configure tunnel

- Copy `deploy/cloudflared/config.yml.example` to `/etc/cloudflared/config.yml`
- Replace tunnel UUID and hostname

Run tunnel:

```bash
sudo systemctl enable --now cloudflared
```

### Restrict to 3 users

In Cloudflare Zero Trust dashboard:

- Access > Applications > Add self-hosted app
- Domain: `annotator.example.com`
- Policy: Allow only 3 Google emails

## 6) Deploy update flow

```bash
git pull
uv sync
cd frontend && npm ci && npm run build && cd ..
sudo systemctl restart elastic-annotator
```

### Deployment Sync Rule (Required)

- Always deploy through this order: `local edit -> push to main -> deploy`.
- Do not edit code directly on the EC2 server.
- `deploy/ec2/deploy_on_server.sh` blocks deploy when server git state is dirty or diverged from fast-forward pull.

## 7) Backup minimum set

Back up these paths regularly:

- `backend/storage/sessions/`
- `backend/storage/sheet_mappings.json`
- `.env`
- Google service account key JSON
