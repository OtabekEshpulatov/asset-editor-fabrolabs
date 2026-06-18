"""Runtime additions / renames layered on top of the generated static catalog.

The static catalog (`static_asset_catalog.py`) is a large auto-generated file we
must not hand-edit. User-created assets and slug renames are recorded in a small
JSON sidecar (canonical in the connected bucket, local cache in the data dir) and
applied **in place** to the shared catalog dicts so every consumer sees them.

Rename policy: slug-only — the storage file keeps its original path/URL; only the
catalog key (and its category-list membership) changes.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app import config
from app.catalog.static_asset_catalog import (
    BACKGROUND_CATALOG,
    BACKGROUND_CATEGORIES,
    CHARACTER_CATALOG,
    CHARACTER_CATEGORIES,
    OBJECT_CATALOG,
    OBJECT_CATEGORIES,
)
from app.storage import json_store

log = logging.getLogger(__name__)

# Local fallback/cache lives in the data dir; canonical copy lives in the bucket.
OVERRIDES_PATH = config.OVERRIDES_LOCAL_PATH
OVERRIDES_OBJECT_KEY = "manifests/asset_overrides.json"

# AssetKind -> (catalog dict, categories dict)
_TABLES: dict[str, tuple[dict, dict[str, list[str]]]] = {
    "object": (OBJECT_CATALOG, OBJECT_CATEGORIES),
    "background": (BACKGROUND_CATALOG, BACKGROUND_CATEGORIES),
    "character": (CHARACTER_CATALOG, CHARACTER_CATEGORIES),
}

# --- runtime config overlay (populated by apply(); read by gallery) -----------
# Per-asset config: enabled, description.
_ASSET_CONFIG: dict[str, dict[str, dict[str, Any]]] = {
    "object": {},
    "background": {},
    "character": {},
}
# Per-action config (characters): {slug: {action: {enabled, description, fps, frame_count}}}.
_ACTION_CONFIG: dict[str, dict[str, dict[str, Any]]] = {}

_DEFAULT_FPS = 12
_DEFAULT_FRAME_COUNT = 25


def reset_runtime() -> None:
    """Clear the in-memory config overlay (called on bucket switch before apply)."""
    for kind in _ASSET_CONFIG:
        _ASSET_CONFIG[kind].clear()
    _ACTION_CONFIG.clear()


def asset_config(kind: str, slug: str) -> dict[str, Any]:
    return _ASSET_CONFIG.get(kind, {}).get(slug, {})


def is_enabled(kind: str, slug: str) -> bool:
    return bool(asset_config(kind, slug).get("enabled", True))


def asset_rev(kind: str, slug: str) -> int:
    """Monotonic counter bumped on every destructive edit (cache-busts the URL)."""
    try:
        return int(asset_config(kind, slug).get("rev", 0) or 0)
    except (TypeError, ValueError):
        return 0


def action_rev(slug: str, action: str) -> int:
    try:
        return int(action_config(slug, action).get("rev", 0) or 0)
    except (TypeError, ValueError):
        return 0


def action_config(slug: str, action: str) -> dict[str, Any]:
    return _ACTION_CONFIG.get(slug, {}).get(action, {})


def all_action_config(slug: str) -> dict[str, dict[str, Any]]:
    return _ACTION_CONFIG.get(slug, {})


def is_action_enabled(slug: str, action: str) -> bool:
    return bool(action_config(slug, action).get("enabled", True))


def action_fps(slug: str, action: str, default: int = _DEFAULT_FPS) -> int:
    try:
        return int(action_config(slug, action).get("fps") or default)
    except (TypeError, ValueError):
        return default


def action_frame_count(slug: str, action: str, default: int = _DEFAULT_FRAME_COUNT) -> int:
    try:
        return int(action_config(slug, action).get("frame_count") or default)
    except (TypeError, ValueError):
        return default


def _empty() -> dict[str, Any]:
    data: dict[str, Any] = {
        kind: {"added": [], "renames": {}, "config": {}}
        for kind in ("object", "background", "character")
    }
    data["character"]["actions"] = {}
    return data


def _load() -> dict[str, Any]:
    config.seed_if_missing(OVERRIDES_PATH, "asset_overrides.json")
    raw = json_store.read_json(key=OVERRIDES_OBJECT_KEY, local_path=OVERRIDES_PATH)
    data = _empty()
    if isinstance(raw, dict):
        for kind in ("object", "background", "character"):
            section = raw.get(kind)
            if not isinstance(section, dict):
                continue
            if isinstance(section.get("added"), list):
                data[kind]["added"] = section["added"]
            if isinstance(section.get("renames"), dict):
                data[kind]["renames"] = section["renames"]
            if isinstance(section.get("config"), dict):
                data[kind]["config"] = section["config"]
        actions = raw.get("character", {}).get("actions") if isinstance(raw.get("character"), dict) else None
        if isinstance(actions, dict):
            data["character"]["actions"] = actions
    return data


def _save(data: dict[str, Any]) -> None:
    json_store.write_json(
        data,
        key=OVERRIDES_OBJECT_KEY,
        local_path=OVERRIDES_PATH,
        dumps=lambda d: json.dumps(d, indent=2).encode("utf-8"),
    )


# --- in-memory mutation (shared by apply() and the public record_* helpers) ---

def _mem_add(kind: str, slug: str, value: Any, category: str) -> None:
    cat, cats = _TABLES[kind]
    cat[slug] = value
    cats.setdefault(category, [])
    if slug not in cats[category]:
        cats[category].append(slug)


def _mem_rename(kind: str, old: str, new: str) -> None:
    cat, cats = _TABLES[kind]
    if old in cat:
        cat[new] = cat.pop(old)
    for name, slugs in cats.items():
        if old in slugs:
            cats[name] = [new if s == old else s for s in slugs]
    if kind == "character" and old in _ACTION_CONFIG:
        _ACTION_CONFIG[new] = _ACTION_CONFIG.pop(old)


def _mem_add_action(slug: str, name: str, spritesheet: str, atlas: str) -> None:
    entry = CHARACTER_CATALOG.get(slug)
    if not isinstance(entry, dict):
        return
    anims = entry.setdefault("animations", [])
    if name not in anims:
        entry["animations"] = sorted([*anims, name])
    entry.setdefault("animation_urls", {})[name] = {"spritesheet": spritesheet, "atlas": atlas}


def _mem_rename_action(slug: str, old: str, new: str) -> None:
    entry = CHARACTER_CATALOG.get(slug)
    if not isinstance(entry, dict):
        return
    urls = entry.get("animation_urls", {})
    if old in urls:
        urls[new] = urls.pop(old)
    anims = entry.get("animations", [])
    entry["animations"] = sorted({new if a == old else a for a in anims})
    actions = _ACTION_CONFIG.get(slug, {})
    if old in actions:
        actions[new] = actions.pop(old)


def _mem_delete_action(slug: str, name: str) -> None:
    entry = CHARACTER_CATALOG.get(slug)
    if isinstance(entry, dict):
        entry["animations"] = [a for a in entry.get("animations", []) if a != name]
        urls = entry.get("animation_urls")
        if isinstance(urls, dict):
            urls.pop(name, None)
    actions = _ACTION_CONFIG.get(slug)
    if isinstance(actions, dict):
        actions.pop(name, None)


def apply() -> None:
    """Re-apply the sidecar onto the in-memory catalog (idempotent per process)."""
    data = _load()
    for kind in ("object", "background", "character"):
        section = data[kind]
        for entry in section["added"]:
            slug = entry.get("slug")
            category = entry.get("category")
            value = entry.get("entry") if kind == "character" else entry.get("url")
            if slug and category and value is not None:
                _mem_add(kind, slug, value, category)
        for old, new in section["renames"].items():
            _mem_rename(kind, old, new)
        for slug, cfg in section.get("config", {}).items():
            if isinstance(cfg, dict):
                _ASSET_CONFIG[kind][slug] = dict(cfg)

    for slug, av in data["character"].get("actions", {}).items():
        for added in av.get("added", []):
            if added.get("name") and added.get("spritesheet") and added.get("atlas"):
                _mem_add_action(slug, added["name"], added["spritesheet"], added["atlas"])
        for old, new in av.get("renames", {}).items():
            _mem_rename_action(slug, old, new)
        for action, cfg in av.get("config", {}).items():
            if isinstance(cfg, dict):
                _ACTION_CONFIG.setdefault(slug, {})[action] = dict(cfg)
        # Deletions last: a base action renamed then deleted must resolve to
        # (rename -> delete), so apply removals after adds/renames.
        for name in av.get("deleted", []):
            _mem_delete_action(slug, name)


# --- public API used by the asset-management endpoints -----------------------

def record_add(kind: str, *, slug: str, category: str, url: str | None = None,
               entry: dict | None = None) -> None:
    """Persist + apply a new asset. Pass `url` for object/background, `entry` for character."""
    value = entry if kind == "character" else url
    if value is None:
        raise ValueError("add requires url (object/background) or entry (character)")
    _mem_add(kind, slug, value, category)
    data = _load()
    record = {"slug": slug, "category": category}
    if kind == "character":
        record["entry"] = entry
    else:
        record["url"] = url
    data[kind]["added"].append(record)
    _save(data)


def record_rename(kind: str, *, old: str, new: str) -> None:
    """Persist + apply a slug rename (slug-only; files untouched)."""
    _mem_rename(kind, old, new)
    data = _load()
    section = data[kind]
    added = next((a for a in section["added"] if a.get("slug") == old), None)
    if added is not None:
        added["slug"] = new
    else:
        section["renames"][old] = new
    if kind == "character":
        cfg = section.get("config", {})
        if old in cfg:
            cfg[new] = cfg.pop(old)
        actions = section.get("actions", {})
        if old in actions:
            actions[new] = actions.pop(old)
    _save(data)


def _action_section(data: dict[str, Any], slug: str) -> dict[str, Any]:
    return data["character"].setdefault("actions", {}).setdefault(
        slug, {"added": [], "renames": {}, "config": {}, "deleted": []}
    )


def record_asset_config(kind: str, slug: str, **fields: Any) -> None:
    """Persist + apply per-asset config (e.g. enabled, description)."""
    _ASSET_CONFIG[kind].setdefault(slug, {}).update(fields)
    data = _load()
    data[kind].setdefault("config", {}).setdefault(slug, {}).update(fields)
    _save(data)


def record_action_config(slug: str, action: str, **fields: Any) -> None:
    """Persist + apply per-action config (enabled, description, fps, frame_count)."""
    _ACTION_CONFIG.setdefault(slug, {}).setdefault(action, {}).update(fields)
    data = _load()
    sect = _action_section(data, slug)
    sect.setdefault("config", {}).setdefault(action, {}).update(fields)
    _save(data)


def record_add_action(slug: str, *, name: str, spritesheet: str, atlas: str) -> None:
    _mem_add_action(slug, name, spritesheet, atlas)
    data = _load()
    sect = _action_section(data, slug)
    added = sect.setdefault("added", [])
    # Idempotent: replace any prior record for this name so repeated add/mirror
    # cycles don't accumulate duplicate "added" entries.
    added[:] = [a for a in added if a.get("name") != name]
    added.append({"name": name, "spritesheet": spritesheet, "atlas": atlas})
    _save(data)


def record_delete_action(slug: str, *, name: str) -> None:
    """Persist + apply an action deletion. If the action was user-added we just
    drop its `added` record; otherwise (a base/static action) we record it in a
    `deleted` list so the removal survives a catalog re-apply."""
    _mem_delete_action(slug, name)
    data = _load()
    sect = _action_section(data, slug)
    added = sect.get("added", [])
    was_added = any(a.get("name") == name for a in added)
    sect["added"] = [a for a in added if a.get("name") != name]
    sect.get("config", {}).pop(name, None)
    if not was_added:
        deleted = sect.setdefault("deleted", [])
        if name not in deleted:
            deleted.append(name)
    _save(data)


def record_rename_action(slug: str, *, old: str, new: str) -> None:
    _mem_rename_action(slug, old, new)
    data = _load()
    sect = _action_section(data, slug)
    added = next((a for a in sect.get("added", []) if a.get("name") == old), None)
    if added is not None:
        added["name"] = new
    else:
        sect.setdefault("renames", {})[old] = new
    cfg = sect.setdefault("config", {})
    if old in cfg:
        cfg[new] = cfg.pop(old)
    _save(data)
