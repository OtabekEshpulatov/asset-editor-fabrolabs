"""FastAPI app factory for the standalone asset editor.

No database, no story pipeline — just the asset/background editing routes and
the storage read-proxy. Storage is auto-connected from the environment.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config, connection
from app.routes.assets import router as assets_router
from app.routes.storage import router as storage_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def build_app() -> FastAPI:
    config.ensure_data_dir()
    connection.init_from_env()
    if connection.is_configured():
        try:
            connection.reload_all()
            log.info("connected to storage bucket %s", connection.require().bucket)
        except Exception as exc:  # noqa: BLE001 — never block startup on a flaky bucket
            log.warning("could not warm catalog from storage: %r", exc)

    app = FastAPI(title="asset-editor", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],   # single-user / internal tool
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(assets_router)
    app.include_router(storage_router)

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "configured": connection.is_configured()}

    @app.get("/api/storage-info")
    async def storage_info() -> dict:
        """Read-only storage info for the UI (bucket/endpoint, masked key)."""
        return connection.status()

    @app.post("/api/storage-reload")
    async def storage_reload() -> dict:
        """Re-read the bucket overrides/manifest after out-of-band edits."""
        connection.reload_all()
        return connection.status()

    # Single-image mode: serve the built React app + client-side routing. Skipped
    # in local backend-only dev (no web dir) — use the Vite dev server there.
    if config.WEB_DIR.exists():
        app.mount("/static", StaticFiles(directory=config.WEB_DIR / "static"), name="static")

        @app.get("/{full_path:path}")
        async def spa(full_path: str):
            # API + storage are handled by the routers above; never fall through.
            if full_path.startswith(("api/", "storage/")):
                raise HTTPException(status_code=404, detail="not found")
            candidate = config.WEB_DIR / full_path
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(config.WEB_DIR / "index.html")  # SPA deep links

        log.info("serving frontend from %s", config.WEB_DIR)

    return app


app = build_app()
