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

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import connection
from app.storage import minio

log = logging.getLogger(__name__)

router = APIRouter(prefix="/storage")


@router.get("/{first}/{key:path}")
async def get_object(first: str, key: str, request: Request):
    """`first` is the (ignored) bucket segment; `key` is the object key.

    Honors HTTP Range requests (replies 206 + Content-Range) so large mp4
    backgrounds stream and seek in a <video> element.
    """
    if not connection.is_configured():
        raise HTTPException(status_code=428, detail="storage not configured")
    byte_range = request.headers.get("range")
    try:
        result = minio.stream_object(key, byte_range=byte_range)
    except Exception as exc:  # connection/auth failure
        raise HTTPException(status_code=502, detail=f"storage read failed: {exc}")
    if result is None:
        raise HTTPException(status_code=404, detail=f"no object {key!r}")

    headers = {"Cache-Control": "public, max-age=86400", "Accept-Ranges": "bytes"}
    if result["content_length"] is not None:
        headers["Content-Length"] = str(result["content_length"])
    status_code = 200
    if result["content_range"]:
        headers["Content-Range"] = result["content_range"]
        status_code = 206
    return StreamingResponse(
        result["body"].iter_chunks(chunk_size=64 * 1024),
        status_code=status_code,
        media_type=result["content_type"],
        headers=headers,
    )
