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
4. `Create Session` 클릭
5. 백엔드가 세션 생성 + ELASTIC 실행 + (옵션)비디오 렌더링
6. 완료되면 Annotation 화면에서 이벤트 수정
7. `Confirm Row Changes`로 행 수정 확정
8. 필요 시 CSV export로 결과 다운로드

작업자용 상세 UX 매뉴얼:

- [docs/ANNOTATOR_UX_GUIDE_KR.md](docs/ANNOTATOR_UX_GUIDE_KR.md)

## 4. 키보드/컨트롤

- `Space`: 재생/정지
- `← / →`: 0.2초 이동
- `Shift + ← / →`: 1프레임 이동
- `-5s / +5s`: 5초 이동
- `Use Current`: 현재 프레임을 `synced/receive`에 반영

## 5. 프로젝트 구조

- `backend/app/main.py`: FastAPI 엔트리
- `backend/app/api/routes.py`: API 라우트
- `backend/app/services/elastic_pipeline.py`: ELASTIC 실행 파이프라인
- `frontend/src/pages/SessionCreatePage.tsx`: 세션 생성/업로드 화면
- `frontend/src/pages/AnnotationPage.tsx`: 비디오+이벤트 편집 화면

## 6. 배포

배포/운영 절차는 별도 문서:

- [DEPLOYMENT.md](DEPLOYMENT.md)

### 6.1 동기화 운영 규칙 (필수)

- 코드 수정은 반드시 `로컬 수정 -> main push -> 배포` 순서로 진행합니다.
- 서버에서 직접 코드 수정/커밋하지 않습니다.
- 배포 스크립트(`deploy/ec2/deploy_on_server.sh`)는 서버 워킹트리가 dirty이면 실패하도록 되어 있습니다.

### 6.2 main 푸시 자동 배포 (EC2)

이 저장소에는 `main` 브랜치 푸시 시 EC2에 자동 반영하는 GitHub Actions 워크플로가 포함되어 있습니다.

- 워크플로 파일: `.github/workflows/deploy-main-ec2.yml`
- 서버 실행 스크립트: `deploy/ec2/deploy_on_server.sh`

GitHub Repository Secrets에 아래 값을 등록해야 동작합니다.

- `EC2_HOST` (예: `54.82.227.199`)
- `EC2_USER` (예: `ubuntu`)
- `EC2_SSH_KEY` (EC2 접속용 private key 전체 내용)
