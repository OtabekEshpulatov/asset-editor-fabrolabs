"""Orchestration for the live-bg OBJECT editor (drag moving objects + re-render).

GET  -> read the bucket bundle's spec, return a draggable mover view (mirrors
        story-gen-exps backend/api/routes_livebg.py:_mover_view).
POST -> apply the edits to the spec, re-render the mp4 from the bundle (NO LLM),
        upscale to 1080p (publish parity), upload it over the existing video object,
        and persist the updated spec back into the bundle.

Re-renders are serialised per slug and run off the event loop. Heavy deps
(numpy/rlottie via app.livebg.render) are imported lazily so importing the routes
at startup stays light.
"""
from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image

from app import videos
from app.livebg import bundle
from app.storage import minio

W = 1280                                              # render width — mover x/w are % / px of this
_WDEF = {"pulse": 40, "peek": 90, "patrol": 90}       # default cutout width by kind (matches spec_to_layers)
_POSITIONABLE = {"float", "pulse", "peek", "patrol"}  # movers the editor lets you drag freely (have x,y)

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


class NotEditable(Exception):
    """The video has no editable source bundle in the bucket (HTTP 409)."""


def _mover_view(m: dict, i: int, cut_urls: dict[str, str]) -> dict:
    kind = m.get("kind", "float")
    mid = m.get("id", "")
    w = m.get("w", _WDEF.get(kind, 80))
    has_cut = kind not in ("fall", "bubbles")
    view = {
        "index": i, "id": mid, "kind": kind,
        "x": m.get("x"), "y": m.get("y"), "w": w, "w_pct": round(w / W * 100, 3),
        "flip": bool(m.get("flip", False)), "to_left": bool(m.get("to_left", False)),
        "x0": m.get("x0"), "x1": m.get("x1"),         # swim flight band (null = full off-screen cross)
        "positionable": kind in _POSITIONABLE,
        "has_y": kind in _POSITIONABLE or kind == "swim",
        "cutout_url": cut_urls.get(mid) if has_cut else None,
    }
    if kind == "peek" and m.get("bush"):        # the foreground bush a peek critter hides behind — also draggable/resizable
        bush_id = str(m["bush"])
        bw = int(m.get("bush_w", 210))
        view.update({
            "bush_id": bush_id,
            "bush_x": m.get("bush_x", m.get("x")),                 # render defaults: x, y+6 (spec_to_layers)
            "bush_y": m.get("bush_y", (m.get("y") or 0) + 6),
            "bush_w": bw, "bush_w_pct": round(bw / W * 100, 3),
            "bush_cutout_url": cut_urls.get(bush_id),
        })
    return view


def _video_url(key: str, slug: str) -> str:
    return (minio.public_url_for_key(key) or "") + f"?t={int(time.time())}"


def get_movers(slug: str) -> dict:
    key = videos.video_key(slug)
    if key is None:
        raise KeyError(slug)
    spec = bundle.read_spec(key)
    if spec is None:
        raise NotEditable(slug)
    movers = spec.get("movers", [])
    ids = [m.get("id", "") for m in movers]
    ids += [str(m["bush"]) for m in movers if m.get("kind") == "peek" and m.get("bush")]  # bush previews too
    cut_urls = bundle.cutout_preview_urls(key, ids)
    return {
        "slug": slug,
        "video_url": _video_url(key, slug),
        "loop_s": spec.get("loop_s", 24),
        "water": spec.get("water"),
        "movers": [_mover_view(m, i, cut_urls) for i, m in enumerate(movers)],
    }


def _apply_edits(spec: dict, edits: list[dict]) -> dict:
    """Write x/y/w/flip (and the swim flight band) back into the spec by index — the
    exact rule from routes_livebg.save_scene (only fields the editor sent)."""
    movers = spec.get("movers", [])
    for edit in edits:
        i = edit.get("index")
        if i is None or not (0 <= i < len(movers)):
            continue
        for k in ("x", "y", "w", "flip", "bush_x", "bush_y", "bush_w"):  # bush_* = peek's foreground bush
            if k in edit and edit[k] is not None:
                movers[i][k] = edit[k]
        if "x0" in edit and "x1" in edit:             # swim flight band: write if confined, drop if full-width
            x0v, x1v = edit.get("x0"), edit.get("x1")
            if x0v is None or x1v is None or (x0v <= 0.5 and x1v >= 99.5):
                movers[i].pop("x0", None)
                movers[i].pop("x1", None)
            else:
                movers[i]["x0"], movers[i]["x1"] = x0v, x1v
    spec["movers"] = movers
    return spec


def _to_1080p(mp4: Path, workdir: Path) -> Path:
    """Upscale the native 1280x720 render to 1080p, matching the published resolution."""
    from app.livebg.ffmpeg import ensure_ffmpeg

    out = Path(workdir) / "final_1080.mp4"
    subprocess.run(
        [ensure_ffmpeg(), "-y", "-loglevel", "error", "-i", str(mp4),
         "-vf", "scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-crf", "18",
         "-pix_fmt", "yuv420p", "-preset", "veryfast", str(out)],
        check=True,
    )
    return out


def _rerender_blocking(key: str, slug: str, edits: list[dict]) -> str:
    spec = bundle.read_spec(key)
    if spec is None:
        raise NotEditable(slug)
    spec = _apply_edits(spec, edits)
    work = Path(tempfile.mkdtemp("livebg_edit_"))
    try:
        bundle.download_to_workdir(key, spec, work)
        from app.livebg import render  # lazy: keep numpy/rlottie out of the import path

        mp4 = render.rerender(spec, Image.open(work / bundle.PLATE), work)
        final = _to_1080p(mp4, work)
        data = final.read_bytes()
        # guard: never overwrite a live video with a broken/truncated render — require a
        # real mp4 container (ftyp box) and a non-trivial size, not a byte-count threshold
        # (a short flat clip can legitimately be <10 KB).
        if len(data) < 1024 or data[4:8] != b"ftyp":
            raise RuntimeError(f"re-render produced an invalid mp4 ({len(data)} bytes)")
        # Persist the spec BEFORE overwriting the video: if the upload then fails, the next
        # render re-derives the same video from the saved spec (self-healing). The reverse
        # order could pair a new video with a stale spec that silently reverts on next save.
        bundle.write_spec(key, spec)
        minio.upload_bytes(data, key=key, content_type="video/mp4")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return _video_url(key, slug)


async def save_movers(slug: str, edits: list[dict]) -> dict:
    key = videos.video_key(slug)
    if key is None:
        raise KeyError(slug)
    async with _locks[slug]:
        video_url = await asyncio.to_thread(_rerender_blocking, key, slug, edits)
    return {"ok": True, "video_url": video_url}
