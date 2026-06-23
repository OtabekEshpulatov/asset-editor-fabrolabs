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
_ADDABLE_KINDS = {"float", "swim", "patrol", "pulse"}  # kinds the editor can ADD a fresh mover as
_WADD = {"float": 80, "swim": 80, "patrol": 90, "pulse": 40}  # default width when adding, by kind

_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


class NotEditable(Exception):
    """The video has no editable source bundle in the bucket (HTTP 409)."""


def _mover_view(m: dict, i: int, cut_urls: dict[str, str]) -> dict:
    kind = m.get("kind", "float")
    mid = m.get("id", "")
    w = m.get("w", _WDEF.get(kind, 80))
    has_cut = kind not in ("fall", "bubbles")
    return {
        "index": i, "id": mid, "kind": kind,
        "x": m.get("x"), "y": m.get("y"), "w": w, "w_pct": round(w / W * 100, 3),
        "flip": bool(m.get("flip", False)), "to_left": bool(m.get("to_left", False)),
        "x0": m.get("x0"), "x1": m.get("x1"),         # swim flight band (null = full off-screen cross)
        "positionable": kind in _POSITIONABLE,
        "has_y": kind in _POSITIONABLE or kind == "swim",
        "cutout_url": cut_urls.get(mid) if has_cut else None,
    }


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
    cut_urls = bundle.cutout_preview_urls(key, [m.get("id", "") for m in movers])
    return {
        "slug": slug,
        "video_url": _video_url(key, slug),
        "loop_s": spec.get("loop_s", 24),
        "water": spec.get("water"),
        "movers": [_mover_view(m, i, cut_urls) for i, m in enumerate(movers)],
    }


def list_palette() -> list[dict]:
    """Every creature shipped in any scene bundle — the set you can drop into a scene.
    The bundle flattens the source namespace, so a creature here is renderable in any scene
    (its source gets copied in on add). Each carries a preview cutout if one was shipped."""
    sources, cuts = bundle.scan_global_sources()
    out: list[dict] = []
    for mid in sorted(sources):
        url = minio.public_url_for_key(cuts[mid]) if mid in cuts else None
        out.append({"id": mid, "preview_url": url})
    return out


def _coord(v, default: int) -> int:
    """Tolerant %-coordinate coercion: a bad/non-numeric field falls back instead of 500ing."""
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _new_mover(a: dict, loop_s: float) -> dict | None:
    """Build a spec mover from an editor 'add'. The editor supplies id/kind/position/size
    (+ optional still/flip/x0/x1); engine animation params are filled here to match
    render.spec_to_layers defaults. No `shared`/`prompt` — the bundle flattens sources."""
    mid = str(a.get("id") or "").strip()
    kind = str(a.get("kind") or "float").strip()
    if not mid or kind not in _ADDABLE_KINDS:
        return None
    w = int(a.get("w") or _WADD[kind])
    flip, still = bool(a.get("flip", False)), bool(a.get("still", False))
    x, y = _coord(a.get("x"), 50), _coord(a.get("y"), 50)
    m: dict = {"id": mid, "kind": kind, "w": w}
    if kind == "swim":
        m.update({"y": _coord(a.get("y"), 16),
                  "to_left": flip, "start": 0.1, "dur": 0.5, "ay": 2.5, "ty": 6})
        x0v, x1v = a.get("x0"), a.get("x1")           # optional confined flight band
        if x0v is not None and x1v is not None and not (x0v <= 0.5 and x1v >= 99.5):
            m["x0"], m["x1"] = _coord(x0v, 0), _coord(x1v, 100)
    elif kind == "float":
        m.update({"x": x, "y": y, "flip": flip,
                  "ax": 0 if still else 2, "tx": loop_s, "ay": 0 if still else 1, "ty": loop_s})
        if bool(a.get("breathe")):                    # "stay in place but gently pulse size"
            m["breathe"], m["tb"] = 0.08, 4
    elif kind == "patrol":
        m.update({"x": x, "y": y, "ax": 6, "period": 14, "ay": 0, "ty": 9})
    elif kind == "pulse":
        m.update({"x": x, "y": y, "period": 3.0, "base_op": 0.25, "max_op": 1.0})
    return m


def _apply_edits(spec: dict, edits: list[dict]) -> dict:
    """Write x/y/w/flip/to_left (and the swim flight band) back into existing movers BY
    ORIGINAL INDEX (only fields the editor sent). Swim facing lives in `to_left`, the rest
    in `flip` — render.spec_to_layers reads them on those separate keys."""
    movers = spec.get("movers", [])
    for edit in edits:
        i = edit.get("index")
        if i is None or not (0 <= i < len(movers)):
            continue
        for k in ("x", "y", "w", "flip", "to_left"):
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


def _apply_removed_added(spec: dict, key: str, removed: list, added: list) -> dict:
    """Drop `removed` original indices, then append `added` creatures (copying each one's
    source art into this bundle so the LLM-free render can key it). Must run AFTER _apply_edits
    so edit/removed indices both reference the ORIGINAL mover order."""
    movers = spec.get("movers", [])
    # bool is an int subclass — exclude it so a stray JSON true/false can't drop index 0/1
    rm = {int(i) for i in (removed or []) if isinstance(i, int) and not isinstance(i, bool)}
    kept = [m for i, m in enumerate(movers) if i not in rm]
    if added:
        loop_s = float(spec.get("loop_s", 24))
        sources, cuts = bundle.scan_global_sources()
        for a in added:
            nm = _new_mover(a, loop_s)
            if nm is None:
                continue
            if not bundle.ensure_source(key, nm["id"], sources, cuts):
                raise FileNotFoundError(f"no source art for creature {nm['id']!r}")
            kept.append(nm)
    spec["movers"] = kept
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


def _rerender_blocking(key: str, slug: str, edits: list[dict], removed: list, added: list) -> str:
    spec = bundle.read_spec(key)
    if spec is None:
        raise NotEditable(slug)
    spec = _apply_edits(spec, edits)
    spec = _apply_removed_added(spec, key, removed, added)
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


async def save_movers(slug: str, edits: list[dict], removed: list | None = None,
                      added: list | None = None) -> dict:
    key = videos.video_key(slug)
    if key is None:
        raise KeyError(slug)
    async with _locks[slug]:
        video_url = await asyncio.to_thread(
            _rerender_blocking, key, slug, edits, removed or [], added or [])
    return {"ok": True, "video_url": video_url}
