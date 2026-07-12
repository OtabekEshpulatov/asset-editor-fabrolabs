"""Live backgrounds v2 (mp4): discover ``live_backgrounds_v2/{world}/*.mp4``.

The v2 pipeline re-animates each live background from its own first frame via
WAN (static camera, ambient motion only, CLEAN PLATE — no creatures baked in,
so the engine's composited objects/characters sit on top) and closes the loop
with a tail-over-head crossfade. This tab exists to review v2 candidates next
to the originals; per-video config (description, enabled) lives in
``manifests/live_bgs_v2_manifest.json``. Zones are NOT edited here — a v2 that
graduates replaces its original under ``live_backgrounds/`` and inherits the
slug's existing zones.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app import config
from app.storage import json_store, minio

log = logging.getLogger(__name__)

V2_PREFIX = "live_backgrounds_v2/"
MANIFEST_OBJECT_KEY = "manifests/live_bgs_v2_manifest.json"
MANIFEST_LOCAL_PATH = config.DATA_DIR / "live_bgs_v2_manifest.json"
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")


def _video_keys() -> dict[str, str]:
    """Map slug (filename stem) -> object key under the v2 prefix."""
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(V2_PREFIX)
    except Exception as exc:
        log.warning("live_bgs_v2: listing %s failed: %r", V2_PREFIX, exc)
        return {}
    for key in keys:
        if key.lower().endswith(VIDEO_EXTS):
            out[Path(key).stem] = key
    return out


def _world_of_key(key: str) -> str:
    rel = key[len(V2_PREFIX):]
    return rel.split("/", 1)[0] if "/" in rel else "uncategorized"


def _read_manifest() -> dict[str, Any]:
    raw = json_store.read_json(key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_LOCAL_PATH)
    return raw if isinstance(raw, dict) else {}


def _write_manifest(doc: dict[str, Any]) -> None:
    json_store.write_json(
        doc,
        key=MANIFEST_OBJECT_KEY,
        local_path=MANIFEST_LOCAL_PATH,
        dumps=lambda d: json.dumps(d, indent=2).encode("utf-8"),
    )


def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """Same {kind,total,categories} shape as the other kinds, grouped by world."""
    doc = _read_manifest()
    by_world: dict[str, list[dict[str, Any]]] = {}
    for slug, key in sorted(_video_keys().items()):
        entry = doc.get(slug) if isinstance(doc.get(slug), dict) else {}
        enabled = bool(entry.get("enabled", True))
        if not enabled and not include_disabled:
            continue
        by_world.setdefault(_world_of_key(key), []).append({
            "slug": slug,
            "url": minio.public_url_for_key(key),
            "description": str(entry.get("description") or ""),
            "enabled": enabled,
        })
    categories = [{"name": w, "count": len(items), "items": items}
                  for w, items in sorted(by_world.items())]
    total = sum(len(c["items"]) for c in categories)
    return {"kind": "video_v2", "total": total, "categories": categories}


def _view(slug: str, key: str, entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "video_v2",
        "slug": slug,
        "action": None,
        "world": _world_of_key(key),
        "manifest_key": key,
        "url": minio.public_url_for_key(key),
        "enabled": bool(entry.get("enabled", True)),
        "description": str(entry.get("description") or ""),
        "manifest": entry,
    }


def config_view(slug: str) -> dict[str, Any]:
    key = _video_keys().get(slug)
    if key is None:
        raise KeyError(slug)
    entry = _read_manifest().get(slug)
    return _view(slug, key, entry if isinstance(entry, dict) else {})


def set_config(slug: str, *, enabled: bool | None = None, description: str | None = None) -> dict[str, Any]:
    key = _video_keys().get(slug)
    if key is None:
        raise KeyError(slug)
    doc = _read_manifest()
    entry = doc.get(slug) if isinstance(doc.get(slug), dict) else {}
    if enabled is not None:
        entry["enabled"] = bool(enabled)
    if description is not None:
        entry["description"] = str(description)
    doc[slug] = entry
    _write_manifest(doc)
    return _view(slug, key, entry)
