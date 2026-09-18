"""Animations v3: a CURATED subset of v1 characters shown in a separate "Animations v3" gallery tab.

Unlike v2 (which discovers real files under ``sprites-v2/``), v3 duplicates NOTHING. It reads a curated
list from ``manifests/v3_curated.json`` — each entry ``{slug, category}`` — and re-presents those
characters' EXISTING v1 animations (idle/happy/… plus the newly generated emotions), grouped by the
curated category. So the same sprites appear both in the main "Sprites" tab and, isolated, in
"Animations v3" — no extra storage, always in sync with the live character catalog + overrides.

    manifests/v3_curated.json  ->  {"chars": [{"slug": "king", "category": "folklore_and_fantasy"}, ...]}
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.asset_urls import _spritesheet_url
from app.catalog import catalog as char_catalog, overrides
from app.storage import minio

log = logging.getLogger(__name__)

V3_MANIFEST_KEY = "manifests/v3_curated.json"


def _load_curated() -> list[dict[str, str]]:
    """Read the curated list from the bucket: [{slug, category}, ...] (empty if missing/unreadable)."""
    try:
        raw = minio.download_bytes(V3_MANIFEST_KEY)
        doc = json.loads(raw) if raw else {}
    except Exception as exc:
        log.warning("sprites_v3: reading %s failed: %r", V3_MANIFEST_KEY, exc)
        return []
    chars = doc.get("chars") if isinstance(doc, dict) else None
    if not isinstance(chars, list):
        return []
    return [x for x in chars if isinstance(x, dict) and x.get("slug")]


def character_item(slug: str, *, include_disabled: bool = False) -> dict[str, Any] | None:
    """One v1 character as a gallery item whose ``animation_urls`` are its live sprite sheets (built the
    exact same way as the character catalog in routes/assets.py, so URLs/fps/rev stay consistent).
    None when it is disabled (and those are hidden) or has no sheet to show."""
    enabled = overrides.is_enabled("character", slug)
    if not enabled and not include_disabled:
        return None
    entry = char_catalog.get_character(slug) or {}
    anim_urls = {
        anim: url
        for anim, value in (entry.get("animation_urls") or {}).items()
        if (url := _spritesheet_url(value))
        and (include_disabled or overrides.is_action_enabled(slug, anim))
    }
    if not anim_urls:
        return None
    default = next((a for a in ("idle", "happy", "move") if a in anim_urls), None)
    cfg = overrides.asset_config("character", slug)
    return {
        "slug": slug,
        "url": anim_urls.get(default) if default else next(iter(anim_urls.values())),
        "description": cfg.get("description", ""),
        "enabled": enabled,
        "animation_urls": anim_urls,
        "action_fps": {a: overrides.action_fps(slug, a) for a in anim_urls},
        "action_rev": {a: overrides.action_rev(slug, a) for a in anim_urls},
    }


def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """Same ``{kind, total, categories}`` shape the gallery expects, grouped by the curated category.
    Each curated character is one item from ``character_item``."""
    tree: dict[str, list[dict[str, Any]]] = {}
    for item in _load_curated():
        category = str(item.get("category") or "uncategorized")
        entry = character_item(item["slug"], include_disabled=include_disabled)
        if entry is None:
            continue                                   # curated but not generated yet -> skip
        tree.setdefault(category, []).append(entry)

    categories = [
        {"name": cat, "count": len(items), "items": sorted(items, key=lambda x: x["slug"])}
        for cat, items in sorted(tree.items())
    ]
    total = sum(len(c["items"]) for c in categories)
    return {"kind": "animation_v3", "total": total, "categories": categories}
