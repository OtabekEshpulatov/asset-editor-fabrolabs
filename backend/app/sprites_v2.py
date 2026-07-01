"""Animations v2: discover regenerated sprite libraries under ``sprites-v2/`` in the bucket and
present them in the gallery's "Animations v2" tab. Layout (per char, per action, per view):

    sprites-v2/<category>/<char>/<action>/<char>_<action>_<view>_spritesheet.png
    sprites-v2/<category>/<char>/config.json          (optional: description / enabled / fps)

Each character becomes ONE gallery item under its <category>; every action x view sheet is an entry
in ``animation_urls`` (keyed ``<action>_<view>``) so SpriteCanvas plays it. Read-only discovery, no
static catalog — the same approach as live backgrounds (see app.videos).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.storage import minio

log = logging.getLogger(__name__)

SPRITES_V2_PREFIX = "sprites-v2/"
_SHEET_SUFFIX = "_spritesheet.png"


def _parse_key(key: str) -> tuple[str, str, str, str] | None:
    """``sprites-v2/<category.../>/<char>/<action>/<char>_<action>_<view>_spritesheet.png``
    -> (category, char, action, view), or None if the key isn't a v2 spritesheet."""
    if not key.startswith(SPRITES_V2_PREFIX) or not key.endswith(_SHEET_SUFFIX):
        return None
    parts = key[len(SPRITES_V2_PREFIX):].split("/")
    if len(parts) < 4:
        return None
    filename, action, char = parts[-1], parts[-2], parts[-3]
    category = "/".join(parts[:-3])
    stem = filename[: -len(_SHEET_SUFFIX)]                 # <char>_<action>_<view>
    pfx = f"{char}_{action}_"
    view = stem[len(pfx):] if stem.startswith(pfx) else stem
    return category, char, action, view


def _read_config(category: str, char: str) -> dict[str, Any]:
    try:
        raw = minio.download_bytes(f"{SPRITES_V2_PREFIX}{category}/{char}/config.json")
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def _read_progress() -> dict[str, dict[str, Any]]:
    """Live batch progress written by scripts/v5_spritegen_animals.py -> {char: {category, status,
    done, total}}. Lets the gallery show in-flight chars (with a progress bar) before their sheets
    exist."""
    try:
        raw = minio.download_bytes(f"{SPRITES_V2_PREFIX}_progress.json")
        doc = json.loads(raw) if raw else {}
        chars = doc.get("chars") if isinstance(doc, dict) else None
        return chars if isinstance(chars, dict) else {}
    except Exception:
        return {}


def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """The same ``{kind, total, categories}`` shape the gallery expects, grouped by the category
    folder. Each char is one item whose ``animation_urls`` maps ``<action>_<view>`` -> sheet URL, plus
    an optional ``progress`` ({done,total,status}) so in-flight chars show a loader even with 0 sheets."""
    try:
        keys = minio.list_objects(SPRITES_V2_PREFIX)
    except Exception as exc:
        log.warning("sprites_v2: listing %s failed: %r", SPRITES_V2_PREFIX, exc)
        keys = []

    tree: dict[str, dict[str, dict[str, str]]] = {}   # category -> char -> {anim_name: url}
    for key in keys:
        parsed = _parse_key(key)
        if not parsed:
            continue
        category, char, action, view = parsed
        tree.setdefault(category, {}).setdefault(char, {})[f"{action}_{view}"] = (
            minio.public_url_for_key(key)
        )

    progress = _read_progress()
    # Ensure every char the batch knows about has a slot, even with no sheets yet (pending/generating).
    for char, pr in progress.items():
        cat = str(pr.get("category") or "")
        if cat:
            tree.setdefault(cat, {}).setdefault(char, {})

    categories: list[dict[str, Any]] = []
    for category in sorted(tree):
        items: list[dict[str, Any]] = []
        for char in sorted(tree[category]):
            anim_urls = dict(sorted(tree[category][char].items()))
            pr = progress.get(char) or {}
            if not anim_urls and not pr:
                continue
            cfg = _read_config(category, char)
            enabled = bool(cfg.get("enabled", True))
            if not enabled and not include_disabled:
                continue
            fps = int(cfg.get("fps", 16) or 16)
            default = next((a for a in anim_urls if a.startswith(("idle", "happy"))),
                           next(iter(anim_urls), None))
            item: dict[str, Any] = {
                "slug": char,
                "url": anim_urls.get(default) if default else None,
                "description": str(cfg.get("description") or ""),
                "enabled": enabled,
                "animation_urls": anim_urls,
                "action_fps": {a: fps for a in anim_urls},
                "action_rev": {a: 0 for a in anim_urls},
            }
            if pr:
                item["progress"] = {
                    "done": int(pr.get("done", len(anim_urls))),
                    "total": int(pr.get("total", 39)),
                    "status": str(pr.get("status") or ""),
                }
            items.append(item)
        if items:
            categories.append({"name": category, "count": len(items), "items": items})

    total = sum(len(c["items"]) for c in categories)
    return {"kind": "animation", "total": total, "categories": categories}
