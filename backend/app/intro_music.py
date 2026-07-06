"""Intro music pool (mp3): discover ``intro_music/*.mp3`` in the bucket.

A flat pool of ~10 licensed-by-us theme songs the story engine picks from at
generation time (intro_music/meta.json carries the LLM-facing descriptions).
Per-track config (description, enabled) for the gallery lives in
``manifests/intro_music_manifest.json``.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app import config
from app.storage import json_store, minio

log = logging.getLogger(__name__)

MUSIC_PREFIX = "intro_music/"
MANIFEST_OBJECT_KEY = "manifests/intro_music_manifest.json"
MANIFEST_LOCAL_PATH = config.DATA_DIR / "intro_music_manifest.json"
AUDIO_EXTS = (".mp3", ".ogg", ".wav", ".m4a")


def _audio_keys() -> dict[str, str]:
    """Map slug (filename stem) -> object key under the ``intro_music/`` prefix."""
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(MUSIC_PREFIX)
    except Exception as exc:
        log.warning("intro_music: listing %s failed: %r", MUSIC_PREFIX, exc)
        return {}
    for key in keys:
        if key.lower().endswith(AUDIO_EXTS):
            out[Path(key).stem] = key
    return out


def _world_of_key(key: str) -> str:
    return "intro music pool"


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
    for slug, key in sorted(_audio_keys().items()):
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
    return {"kind": "intro_music", "total": total, "categories": categories}


def _view(slug: str, key: str, entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "intro_music",
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
    """Read-only config for one intro — same flat shape as videos.config_view."""
    key = _audio_keys().get(slug)
    if key is None:
        raise KeyError(slug)
    entry = _read_manifest().get(slug)
    return _view(slug, key, entry if isinstance(entry, dict) else {})


def set_config(slug: str, *, enabled: bool | None = None, description: str | None = None) -> dict[str, Any]:
    key = _audio_keys().get(slug)
    if key is None:
        raise KeyError(slug)
    doc = _read_manifest()
    entry = doc.get(slug)
    entry = dict(entry) if isinstance(entry, dict) else {}
    if enabled is not None:
        entry["enabled"] = bool(enabled)
    if description is not None:
        entry["description"] = str(description)
    doc[slug] = entry
    _write_manifest(doc)
    return _view(slug, key, entry)
