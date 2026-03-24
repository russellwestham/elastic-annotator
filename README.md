# elastic-annotator

ELASTIC 동기화 결과를 사람이 검수/수정하는 로컬 우선 웹앱입니다.

- Backend: FastAPI
- Frontend: React + Vite

## 1. 팀원 빠른 시작 (clone -> 실행)

### 1.1 사전 준비

아래가 로컬에 설치되어 있어야 합니다.

- `git`
- Python `3.11+`
- `uv`
- Node.js `20+` + `npm`
- `ffmpeg` (비디오 렌더링 사용 시)

### 1.2 저장소 클론

```bash
git clone https://github.com/russellwestham/elastic-annotator.git
cd elastic-annotator
```

### 1.3 환경 변수 파일 생성

```bash
cp .env.example .env
```

`.env`에서 최소한 아래 값은 로컬 환경에 맞게 수정하세요.

```bash
FRONTEND_ORIGIN=http://localhost:5173

ELASTIC_REPO_PATH=/absolute/path/to/elastic
DEFAULT_DATASET_ROOT=/absolute/path/to/sportec

SESSIONS_ROOT=/absolute/path/to/elastic-annotator/backend/storage/sessions
DATASETS_ROOT=/absolute/path/to/elastic-annotator/backend/storage/datasets
SHEET_MAPPINGS_PATH=/absolute/path/to/elastic-annotator/backend/storage/sheet_mappings.json

ENABLE_GOOGLE_SHEETS=false
```

Google Sheets를 사용할 때만 아래를 채우세요.

```bash
ENABLE_GOOGLE_SHEETS=true
GOOGLE_SERVICE_ACCOUNT_JSON=/absolute/path/to/service-account.json
GOOGLE_SHEET_SHARE_EMAILS=user1@example.com,user2@example.com
GOOGLE_SHEET_SHARE_ROLE=writer
GOOGLE_SHEET_SHARE_NOTIFY=false
```

### 1.4 의존성 설치

```bash
# repo root
uv sync

# frontend
cd frontend
npm ci
cd ..
```

### 1.5 서버 실행 (터미널 2개)

터미널 1 (backend):

```bash
uv run uvicorn backend.app.main:app --reload --port 8000
```

터미널 2 (frontend dev server):

```bash
cd frontend
npm run dev
```

브라우저 접속:

- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend health: [http://localhost:8000/api/health](http://localhost:8000/api/health)

참고: 개발 모드에서 `frontend`는 Vite proxy로 `/api`, `/artifacts`를 `:8000`으로 전달합니다.

## 2. 데이터 전제

Sportec 데이터셋 기본 구조:

- `metadata/*.xml`
- `event/*.xml`
- `tracking/*` (xml/parquet 등)

데이터셋이 로컬에 없다면 Session Setup 화면에서 ZIP 업로드를 사용할 수 있습니다.

## 3. 사용 플로우 (End-to-End)

1. Session Setup에서 annotator 이름 입력
2. match 선택
3. 필요 시 dataset root 지정 또는 ZIP 업로드
4. 필요 시 Google Sheet URL/ID 입력 후 `Save Sheet Mapping`
5. `Create Session` 클릭
6. 백엔드가 세션 생성 + ELASTIC 실행 + (옵션)비디오 렌더링
7. 완료되면 Annotation 화면에서 이벤트 수정
8. `Confirm Row Changes`로 행 수정 확정
9. 필요 시 `Sync Sheet`로 수동 동기화

## 4. 키보드/컨트롤

- `Space`: 재생/정지
- `← / →`: 0.2초 이동
- `Shift + ← / →`: 1프레임 이동
- `-5s / +5s`: 5초 이동
- `Use Current`: 현재 프레임을 `synced/receive`에 반영

## 5. Google Sheets 동기화

- 매치별로 Sheet URL/ID를 저장할 수 있습니다.
- 동기화 시 우선순위:
  1. 저장된 매핑 `sheet_id`
  2. 기존 제목 규칙(`ELASTIC_ANNOTATOR_<match_id>` 등) 탐색
  3. 없으면 생성 시도

매핑 정보는 `backend/storage/sheet_mappings.json`에 저장됩니다.

## 6. 프로젝트 구조

- `backend/app/main.py`: FastAPI 엔트리
- `backend/app/api/routes.py`: API 라우트
- `backend/app/services/elastic_pipeline.py`: ELASTIC 실행 파이프라인
- `backend/app/services/sheets.py`: Google Sheets 연동
- `backend/app/services/sheet_mapping_store.py`: match-sheet 매핑 저장소
- `frontend/src/pages/SessionCreatePage.tsx`: 세션 생성/매핑 설정 화면
- `frontend/src/pages/AnnotationPage.tsx`: 비디오+이벤트 편집 화면

## 7. 배포

배포/운영 절차는 별도 문서:

- [DEPLOYMENT.md](DEPLOYMENT.md)

### 7.1 main 푸시 자동 배포 (EC2)

이 저장소에는 `main` 브랜치 푸시 시 EC2에 자동 반영하는 GitHub Actions 워크플로가 포함되어 있습니다.

- 워크플로 파일: `.github/workflows/deploy-main-ec2.yml`
- 서버 실행 스크립트: `deploy/ec2/deploy_on_server.sh`

GitHub Repository Secrets에 아래 값을 등록해야 동작합니다.

- `EC2_HOST` (예: `54.82.227.199`)
- `EC2_USER` (예: `ubuntu`)
- `EC2_SSH_KEY` (EC2 접속용 private key 전체 내용)
