"""Render Lottie (Bodymovin) vector animations to Pillow frames via rlottie.

Verbatim copy of story-gen-exps backend/video/lottie.py.

rlottie (Samsung) is a pure-CPU, headless vector rasterizer — no GPU or display.
This lets engine_v5 swap a flat 25-frame spritesheet for a RIGGED vector
character with ZERO change to the compositor: the sprite cache detects a
Lottie-backed asset, renders the active frame here, and returns a Pillow RGBA
image exactly like the spritesheet crop path.

Licensing: the Samsung rlottie ENGINE is MIT; the rlottie-python WRAPPER is
LGPL-2.1 — dynamic use on a server is unencumbered (do NOT use python-lottie,
which is AGPL). rlottie intentionally OMITS some After Effects features
(Expressions, all Effects, Merge Paths, and ALL Text); author character rigs
within its supported subset (transforms, parenting, masks, mattes, gradients,
trim paths, repeaters) and test before committing a rig.
"""
from __future__ import annotations

import json
from collections import OrderedDict
from threading import Lock

from PIL import Image

# A small LRU of PARSED animations keyed by (asset, anim): from_data parses the
# JSON, so reuse the handle across the frames of one render. Bounded so a long
# run with many distinct sheets can't grow without limit.
_ANIM_CACHE: OrderedDict[str, object] = OrderedDict()
_ANIM_MAX = 64
_LOCK = Lock()  # guards the parsed-animation LRU
# Serializes the actual rasterize: rlottie's sync render mutates per-handle state
# AND the rlottie-python wrapper rewrites the MODULE-GLOBAL render argtypes per
# call, so a handle shared across the concurrent scene-render threads must not
# rasterize at the same time (otherwise: torn frames or a ctypes crash).
_RENDER_LOCK = Lock()


def looks_like_lottie(data: bytes) -> bool:
    """True if `data` is Lottie/Bodymovin JSON (vs a PNG spritesheet or an SVG).
    Cheap-rejects non-JSON before the full parse, and type-checks the marker
    fields so a stray non-Lottie JSON isn't mis-routed to the rasterizer."""
    head = data[:64].lstrip()
    if head[:1] != b"{":
        return False
    try:
        obj = json.loads(data)
    except (ValueError, UnicodeDecodeError, RecursionError, MemoryError):
        return False
    # Bodymovin always carries a numeric framerate + out-point and a layer LIST.
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("layers"), list)
        and isinstance(obj.get("fr"), (int, float))
        and isinstance(obj.get("op"), (int, float))
    )


def _animation(data: bytes, cache_key: str):
    from rlottie_python import LottieAnimation

    with _LOCK:
        anim = _ANIM_CACHE.get(cache_key)
        if anim is not None:
            _ANIM_CACHE.move_to_end(cache_key)
            return anim
    text = data.decode("utf-8") if isinstance(data, bytes) else data
    try:
        anim = LottieAnimation.from_data(text)
    except OSError as exc:  # native rlottie lib missing/unreadable
        raise OSError(
            f"rlottie could not load Lottie asset {cache_key!r} "
            f"(native library missing or unreadable): {exc}"
        ) from exc
    with _LOCK:
        # A racer may have parsed + stored the same key while we were parsing;
        # reuse theirs (and let ours be GC'd) so one handle exists per key.
        existing = _ANIM_CACHE.get(cache_key)
        if existing is not None:
            _ANIM_CACHE.move_to_end(cache_key)
            return existing
        _ANIM_CACHE[cache_key] = anim
        _ANIM_CACHE.move_to_end(cache_key)
        while len(_ANIM_CACHE) > _ANIM_MAX:
            _ANIM_CACHE.popitem(last=False)
    return anim


def lottie_frame_count(data: bytes, *, cache_key: str) -> int:
    """Total frames in the clip (what the manifest reports as anim_frame_count)."""
    return int(_animation(data, cache_key).lottie_animation_get_totalframe())


def render_lottie_frame(
    data: bytes, frame_idx: int, size: tuple[int, int], *, cache_key: str
) -> Image.Image:
    """Render `frame_idx` (clamped to the clip) straight to an RGBA image of
    `size` — vector, so it rasterizes sharp at the target resolution."""
    anim = _animation(data, cache_key)
    total = max(1, int(anim.lottie_animation_get_totalframe()))
    fi = max(0, min(int(frame_idx), total - 1))
    w, h = max(1, int(size[0])), max(1, int(size[1]))
    # Serialize the raster: the handle is shared across scene-render threads and
    # rlottie's render is not reentrant (see _RENDER_LOCK).
    with _RENDER_LOCK:
        img = anim.render_pillow_frame(frame_num=fi, width=w, height=h)
    return img if img.mode == "RGBA" else img.convert("RGBA")
