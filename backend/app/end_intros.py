"""World END cards (mp4): discover ``intros/{world}/end_bg.mp4`` in the bucket.

Each world publishes ONE goodnight end-card clip inside its intro pack (a
sleeping resident, the lower-center left open for the story hero composited at
runtime by story-gen). The gallery groups them by world like intros. Per-video
config (description, enabled) lives in ``manifests/end_intros_manifest.json``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app import config
from app.storage import json_store, minio

log = logging.getLogger(__name__)

INTROS_PREFIX = "intros/"
END_FILE = "end_bg.mp4"
MANIFEST_OBJECT_KEY = "manifests/end_intros_manifest.json"
MANIFEST_LOCAL_PATH = config.DATA_DIR / "end_intros_manifest.json"


def _video_keys() -> dict[str, str]:
    """Map slug (``{world}_end``) -> the world's end_bg.mp4 object key."""
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(INTROS_PREFIX)
    except Exception as exc:
        log.warning("end_intros: listing %s failed: %r", INTROS_PREFIX, exc)
        return {}
    for key in keys:
        if key.endswith("/" + END_FILE):
            world = key[len(INTROS_PREFIX):].split("/", 1)[0]
            out[f"{world}_end"] = key
    return out


def _world_of_key(key: str) -> str:
    rel = key[len(INTROS_PREFIX):]
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
    return {"kind": "intro_end", "total": total, "categories": categories}


def _view(slug: str, key: str, entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "intro_end",
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
    """Read-only config for one end card — same flat shape as intros.config_view."""
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
