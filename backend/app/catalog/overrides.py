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


def _load(*, prefer_local: bool = False) -> dict[str, Any]:
    config.seed_if_missing(OVERRIDES_PATH, "asset_overrides.json")
    raw = json_store.read_json(
        key=OVERRIDES_OBJECT_KEY, local_path=OVERRIDES_PATH, prefer_local=prefer_local
    )
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
    # This worker's in-memory overlay now matches the file it just wrote, so it
    # must NOT re-layer on its own next request (only pick up OTHER workers' writes).
    mark_synced()


# --- cross-worker coherence --------------------------------------------------
# The editor runs 2 uvicorn workers, each holding its OWN copy of the catalog /
# config dicts. A mutation handled by one worker updates that worker's dicts and
# the shared sidecar, but the other worker keeps serving its stale copy — so a
# deleted/copied action flickers depending on which worker answers. Every persist
# rewrites the local sidecar atomically (json_store), so its (mtime, size) is a
# cheap cross-process "the overlay changed" signal: each worker records the
# signature it last applied and re-layers the moment the file moves ahead of it.
# This keeps the actions list (and gallery) always consistent with storage — no
# manual /api/storage-reload, no stale cache. Size is folded in so a second write
# within the same mtime tick (coarse-granularity volumes) is still detected.
_UNSET = object()
_applied_sig: tuple[int, int] | None = None


def _sidecar_sig() -> tuple[int, int] | None:
    """(mtime_ns, size) of the local sidecar, or None if it does not exist yet."""
    return json_store.file_sig(OVERRIDES_PATH)


def mark_synced(sig: object = _UNSET) -> None:
    """Record that this worker's in-memory overlay matches the on-disk sidecar.
    Called after every persist and after a full (re)load. Pass the signature the
    reload was based on (captured BEFORE the read) so a write landing mid-reload is
    re-detected next request rather than being masked; omit it to stat afresh."""
    global _applied_sig
    _applied_sig = _sidecar_sig() if sig is _UNSET else sig  # type: ignore[assignment]


def sync_from_disk_if_changed() -> bool:
    """Re-layer the in-memory catalog + config from the sidecar iff another worker
    (or environment) persisted a change since this worker last applied it. Returns
    True when a reload happened.

    Cheap in the common case — a single stat() of the local sidecar; the full
    re-layer runs only when the signature actually moved. Restores the pristine
    base library first, then re-applies the (newer) sidecar: the same clean
    re-layer ``connection.reload_all()`` performs, so pre-corrupted rename chains
    resolve identically to a fresh process (a plain reset+apply is not idempotent
    for them). Reads the LOCAL sidecar (``prefer_local``) — the same file whose
    signature triggered us, so a swallowed MinIO upload can't feed us stale data.

    The signature is captured ONCE, before the read, and recorded as the applied
    signature: if a concurrent write bumps the file during the re-layer, the stored
    signature stays behind it and the next request re-syncs (a harmless redundant
    reload) instead of latching onto stale content.
    """
    sig = _sidecar_sig()
    if sig == _applied_sig:
        return False
    from app.catalog import base_snapshot

    base_snapshot.restore()
    reset_runtime()
    apply(prefer_local=True)
    mark_synced(sig)
    return True


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


def apply(*, prefer_local: bool = False) -> None:
    """Re-apply the sidecar onto the in-memory catalog (idempotent per process).

    `prefer_local` reads the local sidecar cache first (used by the cross-worker
    auto-sync, whose change signal is that local file); the default reads the
    MinIO-canonical copy first (startup / manual reload)."""
    data = _load(prefer_local=prefer_local)
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


def _folder_basename_from_url(url: str | None) -> str | None:
    """The action-folder segment of a `.../<folder>/spritesheet.png` catalog URL."""
    if not url:
        return None
    clean = url.split("?", 1)[0].rstrip("/")
    parts = clean.rsplit("/", 2)  # [..prefix.., <folder>, <filename>]
    return parts[-2] if len(parts) >= 2 else None


def analyze_action_folder_move(
    slug: str, action: str, *, old_folder_basename: str
) -> dict[str, Any]:
    """Decide whether `action`'s storage folder can be *safely* materialized to
    match its name, and how, by statically analysing the sidecar rename chain.

    `old_folder_basename` is the last path segment of the action's CURRENT storage
    folder (resolved from the live catalog by the caller).

    Returns a dict with at least ``safe`` (bool) and ``reason``. When ``safe`` it
    also carries ``origin`` ("added" | "base"), ``root``, ``chain_links`` (rename
    edges to remove) and ``drop_added`` (stale colliding added names to remove).

    A move is refused (``safe=False``) for corrupted chains, so the live catalog is
    never made worse:
      * cyclic chain (a name reachable from itself);
      * converging chain (a name is the rename target of more than one key);
      * origin/folder mismatch (an added-origin carrier or a base-origin root whose
        folder does not match the action's current folder) — the fingerprint of the
        known idle_3q / lifeguard corruptions.
    The clean left/right/3q renames and the eagle/woodpecker `sad` collision (an
    added mirror a base rename clobbered) are all reported ``safe``.
    """
    data = _load()
    sect = _action_section(data, slug)
    renames: dict = sect.get("renames", {}) or {}
    added: list = sect.get("added", []) or []
    added_by_name = {a.get("name"): a for a in added if isinstance(a, dict)}

    # Converging edges: any rename target reached from >1 key means the chain graph
    # is not a clean forest — refuse anything touching such a node.
    target_counts: dict[str, int] = {}
    for _k, v in renames.items():
        target_counts[v] = target_counts.get(v, 0) + 1
    value_to_key = {v: k for k, v in renames.items()}

    # Walk backward action <- ... <- root, with cycle + convergence detection.
    chain_links: list[tuple[str, str]] = []
    nodes: set[str] = {action}
    cur, seen = action, {action}
    while cur in value_to_key:
        if target_counts.get(cur, 0) > 1:
            return {"safe": False, "reason": f"converging chain at {cur!r}"}
        prev = value_to_key[cur]
        if prev in seen:
            return {"safe": False, "reason": f"cyclic chain at {prev!r}"}
        chain_links.append((prev, cur))
        nodes.add(prev)
        seen.add(prev)
        cur = prev
    root = cur

    base = {"slug": slug, "action": action, "chain_links": chain_links,
            "root": root, "drop_added": []}

    if root in added_by_name:
        # ADDED-origin: the carrier entry must actually point at the current folder,
        # else the chain that produced `action` did not come from this added entry
        # (corruption) and collapsing it would move the wrong art.
        carrier_fb = _folder_basename_from_url(
            (added_by_name[root] or {}).get("spritesheet"))
        if carrier_fb != old_folder_basename:
            return {"safe": False,
                    "reason": f"added-origin folder mismatch "
                              f"(carrier={carrier_fb!r} != current={old_folder_basename!r})"}
        origin = "added"
    else:
        # BASE-origin: a pristine base action always lives in a folder named after
        # it, so the current folder basename must equal the chain root.
        if root != old_folder_basename:
            return {"safe": False,
                    "reason": f"base-origin folder mismatch "
                              f"(root={root!r} != current folder={old_folder_basename!r})"}
        origin = "base"

    # Stale added entries colliding with a non-root intermediate chain node (the
    # eagle/woodpecker `sad_right` mirror): safe to drop only when they point at a
    # *different* folder than the one being moved.
    for name in nodes - {action, root}:
        entry = added_by_name.get(name)
        if entry is None:
            continue
        if _folder_basename_from_url(entry.get("spritesheet")) == old_folder_basename:
            return {"safe": False,
                    "reason": f"collision {name!r} shares the source folder"}
        base["drop_added"].append(name)

    base.update(safe=True, reason="ok", origin=origin)
    return base


def record_materialize_action_folder(
    slug: str, action: str, *, spritesheet: str, atlas: str, old_folder_basename: str
) -> dict[str, Any]:
    """Repoint the sidecar so `action` natively lives at the given (new) URLs — the
    folder-move counterpart of the name-only rename.

    After a *fresh* apply() (pristine base catalog + this sidecar) `action` resolves
    to `spritesheet`/`atlas` with NO leftover rename pointing at the old folder and
    NO tombstone shadowing `action`. Two representations are handled:

      * added action  — collapse its `added` entry onto the new URLs (rename in
        place). No tombstone: the action is not in the base library.
      * renamed base  — add a fresh `added` entry at the new URLs and tombstone the
        base *root* (the pristine base action the rename chain started from) so it
        does not resurface as a duplicate once its rename chain is removed.

    The whole rename chain that produced `action` is removed, and any stale `added`
    entry colliding with a non-root intermediate chain node is dropped (repairs the
    eagle/woodpecker case where a base rename clobbered an added mirror, without
    resurrecting the orphan). Per-action config is left untouched — it is already
    keyed by the current `action` name, so the move preserves is_3q / fps /
    frame_count / description / enabled / rev.

    Refuses (raises ValueError) on a chain that `analyze_action_folder_move` reports
    unsafe, so corrupted chains are never rewritten. Returns a change summary.
    """
    analysis = analyze_action_folder_move(
        slug, action, old_folder_basename=old_folder_basename)
    if not analysis.get("safe"):
        raise ValueError(f"unsafe folder move for {slug}/{action}: {analysis.get('reason')}")

    origin = analysis["origin"]
    chain_links = analysis["chain_links"]
    root = analysis["root"]
    drop_added = set(analysis["drop_added"])

    data = _load()
    sect = _action_section(data, slug)
    renames: dict = sect.setdefault("renames", {})
    added: list = sect.setdefault("added", [])
    deleted: list = sect.setdefault("deleted", [])

    # Drop the whole chain so no leftover rename points at the old folder.
    for old, _new in chain_links:
        renames.pop(old, None)

    summary: dict[str, Any] = {
        "slug": slug, "action": action, "origin": origin,
        "removed_renames": [f"{o}->{n}" for o, n in chain_links],
        "tombstoned": None, "dropped_added": [],
    }

    if origin == "added":
        # Collapse the carrier `added` entry onto the new URLs + name in place.
        carrier = next((a for a in added if a.get("name") == root), None)
        if carrier is not None:
            carrier["name"] = action
            carrier["spritesheet"] = spritesheet
            carrier["atlas"] = atlas
    else:
        # The pristine base action `root` resurfaces once its rename chain is gone —
        # register a native entry at the new folder and tombstone `root`.
        added[:] = [a for a in added if a.get("name") != action]
        added.append({"name": action, "spritesheet": spritesheet, "atlas": atlas})
        if root not in deleted:
            deleted.append(root)
        summary["tombstoned"] = root

    # Drop the stale colliding added entries (verified safe in the analysis).
    if drop_added:
        kept = []
        for a in added:
            if a.get("name") in drop_added and a.get("name") != action:
                summary["dropped_added"].append(a.get("name"))
            else:
                kept.append(a)
        added[:] = kept

    # Safety: exactly one `added` entry may carry the target name.
    target_seen, deduped = False, []
    for a in added:
        if a.get("name") == action:
            if target_seen:
                continue
            target_seen = True
        deduped.append(a)
    added[:] = deduped

    _save(data)
    # Refresh the in-memory catalog exactly as a fresh process would: rebuild from
    # the pristine base library, then re-layer the (repointed) sidecar. A plain
    # reset_runtime()+apply() is NOT idempotent for the pre-corrupted rename chains
    # (a base rename that clobbered an added mirror on the first apply resurrects
    # that mirror on a second apply onto the already-mutated catalog), so restore
    # first — the same clean re-layer that connection.reload_all() performs.
    from app.catalog import base_snapshot
    base_snapshot.restore()
    reset_runtime()
    apply(prefer_local=True)  # _save just wrote the local sidecar; read it, not a lagging MinIO
    mark_synced()
    return summary
