"""FastAPI entry point.

    uv run uvicorn app.main:app --reload --port 8000

The app boots with zero external keys: demo mode seeds the acceptance trip and
a scripted agent.  Configure .env for live AMap / Tavily / LLM calls.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app.api.routes import router
from app.api.routes_mindtrip import router as mindtrip_router
from app.config import PROJECT_DIR, get_settings
from app.db import Database, set_db
from app.runtime import RuntimeSettingsStore
from app.seed.loader import seed_database
from app.services.wiring import wire_services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("trace")

FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    runtime = RuntimeSettingsStore(settings.runtime_path)
    runtime.load(settings)

    db = Database(settings)
    await db.connect()
    set_db(db)
    await db.cache_cleanup()
    try:
        seeded = await seed_database(db, settings)
        if seeded:
            logger.info("seeded sample trips")
    except Exception:
        logger.exception("seed failed (continuing)")

    app.state.settings = settings
    app.state.runtime = runtime
    app.state.db = db
    wire_services(app, settings, db)
    logger.info(
        "database=%s demo=%s llm=%s map=%s",
        db.backend,
        settings.demo_mode,
        settings.llm_configured,
        settings.effective_map_provider,
    )
    try:
        yield
    finally:
        await db.close()


app = FastAPI(title="Trace Planner", version="0.1.0", lifespan=lifespan)
settings = get_settings()
_origins = [o.strip() for o in settings.allow_origin.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in _origins else _origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(router)
app.include_router(mindtrip_router)


@app.get("/api")
async def api_root():
    return {"name": "Trace Planner API", "docs": "/docs"}


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    """Serve the Vite build if present, otherwise explain how to start the UI.

    The check happens per request so `pnpm build` can run while the API is up.
    """
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if FRONTEND_DIST.exists():
        root = FRONTEND_DIST.resolve()
        candidate = (FRONTEND_DIST / path).resolve() if path else None
        if candidate and candidate.is_file() and (candidate == root or root in candidate.parents):
            return FileResponse(candidate)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
    return JSONResponse(
        {
            "app": "Trace Planner",
            "frontend": "not built — run `cd frontend && pnpm dev` (proxy :8010) or `pnpm build`",
            "api": "/api/health",
        }
    )
