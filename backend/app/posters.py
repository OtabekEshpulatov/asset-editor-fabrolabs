"""First-frame poster JPEGs for live-background mp4s.

The zones / transitions / relation-map views only need a STILL of each
background; streaming the full multi-MB mp4 through the uncached proxy just
to show frame 1 made those pages take 20+ seconds. Instead the first frame is
extracted server-side (ffmpeg — the app sits next to MinIO, so reading the
mp4 is fast), cached in the bucket under ``live_backgrounds_posters/`` and
served with long browser caching. Only the Objects tab still uses real video.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from app import videos
from app.livebg.ffmpeg import ensure_ffmpeg
from app.storage import minio

log = logging.getLogger(__name__)

POSTERS_PREFIX = "live_backgrounds_posters/"


def poster_jpeg(slug: str) -> bytes:
    """The cached poster for one video, generating it on first request.
    Raises KeyError when the slug has no mp4."""
    key = f"{POSTERS_PREFIX}{slug}.jpg"
    try:
        cached = minio.download_bytes(key)
        if cached:
            return cached
    except Exception as exc:  # noqa: BLE001 — cache miss path, regenerate
        log.warning("posters: cache read failed for %s: %r", slug, exc)

    vkey = videos._video_keys().get(slug)
    if vkey is None:
        raise KeyError(slug)
    raw = minio.download_bytes(vkey)
    if raw is None:
        raise KeyError(slug)
    exe = ensure_ffmpeg()
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "v.mp4"
        dst = Path(td) / "p.jpg"
        src.write_bytes(raw)
        ff = subprocess.run(
            [exe, "-y", "-i", str(src), "-frames:v", "1",
             "-vf", "scale=1280:-2", "-q:v", "3", str(dst)],
            capture_output=True,
        )
        if ff.returncode != 0 or not dst.exists():
            raise RuntimeError(f"ffmpeg poster failed for {slug} (exit {ff.returncode})")
        data = dst.read_bytes()
    try:
        minio.upload_bytes(data, key=key, content_type="image/jpeg")
    except Exception as exc:  # noqa: BLE001 — still return the bytes we made
        log.warning("posters: cache write failed for %s: %r", slug, exc)
    return data


def invalidate(slug: str) -> None:
    """Drop the cached poster (call after the mp4 itself is re-rendered)."""
    try:
        minio.delete_object(f"{POSTERS_PREFIX}{slug}.jpg")
    except Exception as exc:  # noqa: BLE001 — stale poster is cosmetic
        log.warning("posters: invalidate failed for %s: %r", slug, exc)
