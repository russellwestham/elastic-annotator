from __future__ import annotations

from pathlib import Path, PurePosixPath

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from backend.app.api.routes import router
from backend.app.core.settings import PROJECT_ROOT, get_settings

settings = get_settings()

app = FastAPI(title=settings.app_name)


def _request_host(request: Request) -> str:
    host = request.headers.get("host", "")
    return host.split(":", 1)[0].strip().lower()


def _settings_hosts(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(",") if item.strip()}


def _is_public_host(request: Request) -> bool:
    public_hosts = _settings_hosts(settings.public_hosts)
    return bool(public_hosts) and _request_host(request) in public_hosts


def _is_public_allowed_path(path: str) -> bool:
    if path.startswith("/api/public"):
        return True
    if path.startswith("/artifacts"):
        return True
    if path.startswith("/public") or path.startswith("/annotate"):
        return True
    if path.startswith("/assets") or path in {"/", "/index.html", "/favicon.ico"}:
        return True
    return bool(Path(path).suffix) and not path.startswith("/api/")


class PublicHostGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if _is_public_host(request) and not _is_public_allowed_path(request.url.path):
            return PlainTextResponse("Not found", status_code=404)
        return await call_next(request)


def _has_hidden_path_part(path: str) -> bool:
    return any(
        part not in {"", ".", ".."} and part.startswith(".")
        for part in PurePosixPath(path).parts
    )


class SafeStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore[override]
        # Never expose dotfiles such as .env or .bash_history even if they exist on disk.
        if _has_hidden_path_part(path):
            raise StarletteHTTPException(status_code=404)
        return await super().get_response(path, scope)


class SPAStaticFiles(SafeStaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore[override]
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and not Path(path).suffix and not _has_hidden_path_part(path):
                return await super().get_response("index.html", scope)
            raise

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(PublicHostGuardMiddleware)

app.include_router(router)

storage_root = Path(__file__).resolve().parents[1] / "storage"
app.mount("/artifacts", SafeStaticFiles(directory=str(storage_root)), name="artifacts")

# Production convenience: when frontend build output exists,
# serve it from the same FastAPI origin.
frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", SPAStaticFiles(directory=str(frontend_dist), html=True), name="frontend")
