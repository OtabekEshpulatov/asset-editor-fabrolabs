"""Storage read-proxy.

Catalog URLs are baked as `/storage/{bucket}/{key}`. Because the S3 endpoint is
now chosen at runtime in the UI, the frontend can't proxy `/storage` to a fixed
target — so the backend streams objects itself using the active connection's
credentials. The bucket segment in the URL is ignored; the active connection's
bucket is used, so a renamed bucket still resolves as long as the object keys
(`sprites/...`, `backgrounds/...`, `objects/...`) match.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app import connection
from app.storage import minio

log = logging.getLogger(__name__)

router = APIRouter(prefix="/storage")


@router.get("/{first}/{key:path}")
async def get_object(first: str, key: str):
    """`first` is the (ignored) bucket segment; `key` is the object key."""
    if not connection.is_configured():
        raise HTTPException(status_code=428, detail="storage not configured")
    try:
        result = minio.stream_object(key)
    except Exception as exc:  # connection/auth failure
        raise HTTPException(status_code=502, detail=f"storage read failed: {exc}")
    if result is None:
        raise HTTPException(status_code=404, detail=f"no object {key!r}")
    body, content_type, content_length = result
    headers = {"Cache-Control": "public, max-age=86400"}
    if content_length is not None:
        headers["Content-Length"] = str(content_length)
    return StreamingResponse(
        body.iter_chunks(chunk_size=64 * 1024),
        media_type=content_type,
        headers=headers,
    )
