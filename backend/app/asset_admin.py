"""Add / rename assets: upload to storage + record catalog overrides.

Rename is slug-only (the storage file keeps its path/URL). Adds upload the
file(s) and register the asset via `app.catalog.overrides`. Every mutation
invalidates the (no-op) search cache seam.
"""

from __future__ import annotations

import json
import logging
import re

from app import backgrounds, image_transforms
from app.asset_urls import _spritesheet_url
from app.cache import invalidate as invalidate_search
from app.catalog import catalog, overrides
from app.catalog.static_asset_catalog import (
    BACKGROUND_CATEGORIES,
    CHARACTER_CATEGORIES,
    OBJECT_CATEGORIES,
)
from app.storage import minio

log = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-z0-9_]+$")
_KINDS = ("object", "background", "character")
_DEFAULT_ACTION_CFG = {"enabled": True, "description": "", "fps": 12, "frame_count": 25}


def _validate_slug(slug: str, *, what: str = "slug") -> None:
    if not _SLUG_RE.match(slug or ""):
        raise ValueError(f"{what} must be lowercase letters, digits, and underscores only")


def _exists(kind: str, slug: str) -> bool:
    if kind == "object":
        return catalog.get_object_url(slug) is not None
    if kind == "background":
        return catalog.get_background_url(slug) is not None
    if kind == "character":
        return catalog.get_character(slug) is not None
    return False


def add_object(*, slug: str, category: str, data: bytes) -> dict:
    _validate_slug(slug)
    if category not in OBJECT_CATEGORIES:
        raise ValueError(f"unknown object category {category!r}")
    if _exists("object", slug):
        raise ValueError(f"object {slug!r} already exists")
    key = f"objects/{category}/{slug}.svg"
    if minio.object_exists(key):
        raise ValueError(f"a file already exists at {key}")
    url = minio.upload_bytes(data, key=key, content_type="image/svg+xml")
    overrides.record_add("object", slug=slug, category=category, url=url)
    invalidate_search()
    return {"kind": "object", "slug": slug, "category": category, "url": url}


def add_background(
    *, slug: str, category: str, data: bytes, scene_type: str = "", description: str = ""
) -> dict:
    _validate_slug(slug)
    if category not in BACKGROUND_CATEGORIES:
        raise ValueError(f"unknown background category {category!r}")
    if _exists("background", slug):
        raise ValueError(f"background {slug!r} already exists")
    key = f"backgrounds/{category}/{slug}.png"
    if minio.object_exists(key):
        raise ValueError(f"a file already exists at {key}")
    url = minio.upload_bytes(data, key=key, content_type="image/png")
    backgrounds.create_manifest_entry(
        category=category, slug=slug, scene_type=scene_type, description=description
    )
    overrides.record_add("background", slug=slug, category=category, url=url)
    invalidate_search()
    return {"kind": "background", "slug": slug, "category": category, "url": url}


def add_character(*, slug: str, category: str, animations: dict[str, dict[str, bytes]]) -> dict:
    """`animations` maps anim name -> {'spritesheet': png bytes, 'atlas': json bytes}."""
    _validate_slug(slug)
    if category not in CHARACTER_CATEGORIES:
        raise ValueError(f"unknown character category {category!r}")
    if _exists("character", slug):
        raise ValueError(f"character {slug!r} already exists")
    if not animations:
        raise ValueError("at least one animation is required")

    for name, files in animations.items():
        _validate_slug(name, what="animation name")
        if "spritesheet" not in files or "atlas" not in files:
            raise ValueError(f"animation {name!r} needs both a spritesheet (.png) and atlas (.json)")
        try:
            json.loads(files["atlas"])
        except (ValueError, TypeError):
            raise ValueError(f"atlas for animation {name!r} is not valid JSON")

    base = f"sprites/{category}/{slug}"
    animation_urls: dict[str, dict[str, str]] = {}
    for name, files in animations.items():
        sheet_key = f"{base}/{name}/spritesheet.png"
        atlas_key = f"{base}/{name}/atlas.json"
        if minio.object_exists(sheet_key):
            raise ValueError(f"a file already exists at {sheet_key}")
        sheet_url = minio.upload_bytes(files["spritesheet"], key=sheet_key, content_type="image/png")
        atlas_url = minio.upload_bytes(files["atlas"], key=atlas_key, content_type="application/json")
        animation_urls[name] = {"spritesheet": sheet_url, "atlas": atlas_url}

    entry = {
        "kind": _infer_kind(category),
        "subcategory": category.split("/", 1)[1] if "/" in category else category,
        "sprite_base_path": base,
        "animations": sorted(animations),
        "animation_urls": animation_urls,
    }
    overrides.record_add("character", slug=slug, category=category, entry=entry)
    invalidate_search()
    return {"kind": "character", "slug": slug, "category": category, "animations": entry["animations"]}


def rename(*, kind: str, old_slug: str, new_slug: str) -> dict:
    if kind not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}")
    _validate_slug(new_slug)
    if not _exists(kind, old_slug):
        raise KeyError(old_slug)
    if old_slug == new_slug:
        raise ValueError("new slug is identical to the current slug")
    if _exists(kind, new_slug):
        raise ValueError(f"{kind} {new_slug!r} already exists")
    overrides.record_rename(kind, old=old_slug, new=new_slug)
    invalidate_search()
    return {"kind": kind, "old_slug": old_slug, "new_slug": new_slug}


def _infer_kind(category: str) -> str:
    if category.startswith("people"):
        return "people"
    if category.startswith("animals/birds"):
        return "bird"
    return "animal"


# --- sprite action management -----------------------------------------------

def add_action(
    *, slug: str, action: str, spritesheet: bytes, atlas: bytes, overwrite: bool = False
) -> dict:
    _validate_slug(action, what="action name")
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if action in entry.get("animations", []):
        raise ValueError(f"action {action!r} already exists on {slug!r}")
    try:
        json.loads(atlas)
    except (ValueError, TypeError):
        raise ValueError("atlas is not valid JSON")

    base = str(entry["sprite_base_path"]).strip("/")
    sheet_key = f"{base}/{action}/spritesheet.png"
    atlas_key = f"{base}/{action}/atlas.json"
    # `action` is guaranteed not to be a registered animation here (checked above),
    # so files at this path are an orphan from a prior failed/renamed op. Direct
    # uploads keep the protective guard; mirror passes overwrite=True to reclaim it.
    if not overwrite and minio.object_exists(sheet_key):
        raise ValueError(f"a file already exists at {sheet_key}")
    sheet_url = minio.upload_bytes(spritesheet, key=sheet_key, content_type="image/png")
    atlas_url = minio.upload_bytes(atlas, key=atlas_key, content_type="application/json")

    overrides.record_add_action(slug, name=action, spritesheet=sheet_url, atlas=atlas_url)
    overrides.record_action_config(slug, action, **_DEFAULT_ACTION_CFG)
    # new action -> no existing sidecar; the merge creates it with the defaults
    _patch_action_sidecar(base, action, overrides.action_config(slug, action))
    invalidate_search()
    return {"slug": slug, "action": action, "spritesheet": sheet_url, "atlas": atlas_url}


def _mirror_name(source: str) -> str:
    """Name for the mirrored action: the source with a `_mirrored` suffix,
    regardless of which way the source faces."""
    return f"{source}_mirrored"


def _mirror_spritesheet(sheet: bytes, atlas: bytes) -> bytes:
    """Horizontally mirror EACH frame in place so the character faces the other
    way while the animation frame order is preserved. A whole-image flip would
    reverse the left-to-right frame order within each row, so we flip per frame
    using the atlas rectangles (atlas layout is therefore unchanged)."""
    import io

    from PIL import Image, ImageOps

    meta = json.loads(atlas) if isinstance(atlas, (bytes, str)) else atlas
    img = Image.open(io.BytesIO(sheet)).convert("RGBA")
    out = img.copy()
    frames = (meta or {}).get("frames") or {}
    if frames:
        for fr in frames.values():
            box = (fr["x"], fr["y"], fr["x"] + fr["w"], fr["y"] + fr["h"])
            out.paste(ImageOps.mirror(img.crop(box)), box)
    else:
        out = ImageOps.mirror(img)  # no atlas frames -> flip the whole sheet
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def _action_storage(entry: dict, action: str) -> tuple[str | None, str | None, str | None]:
    """Resolve the real (sheet_key, atlas_key, folder_prefix) for an action from
    the catalog's recorded URLs. Renames are name-only, so the storage folder of a
    renamed action differs from its action name (e.g. `happy_right` lives under
    `happy/`); reconstructing the path from the name is therefore wrong."""
    value = (entry.get("animation_urls") or {}).get(action)
    sheet_key = _key_from_storage_url(_spritesheet_url(value))
    if not sheet_key:
        return None, None, None
    folder = sheet_key.rsplit("/", 1)[0] + "/"
    atlas_key = None
    if isinstance(value, dict) and value.get("atlas"):
        atlas_key = _key_from_storage_url(value["atlas"])
    return sheet_key, (atlas_key or folder + "atlas.json"), folder


def mirror_action(*, slug: str, source: str, new: str | None = None) -> dict:
    """Create a horizontally-mirrored copy of an existing action. The mirrored
    spritesheet is a per-frame flip (atlas reused unchanged); the new action is
    registered via the normal add_action path so the catalog/sidecar stay in sync."""
    _validate_slug(source, what="source action")
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if source not in entry.get("animations", []):
        raise ValueError(f"action {source!r} does not exist on {slug!r}")
    target = (new or _mirror_name(source)).strip()
    if target == source:
        raise ValueError("mirrored action name must differ from the source")

    sheet_key, atlas_key, _ = _action_storage(entry, source)
    if not sheet_key:
        raise ValueError(f"source action {source!r} has no resolvable spritesheet URL")
    sheet = minio.download_bytes(sheet_key)
    atlas = minio.download_bytes(atlas_key) if atlas_key else None
    if sheet is None or atlas is None:
        raise ValueError(f"source action {source!r} is missing its spritesheet or atlas")

    mirrored = _mirror_spritesheet(sheet, atlas)

    if target in entry.get("animations", []):
        # Idempotent: the mirror already exists — regenerate its sheet/atlas in
        # place, keeping its catalog entry + config. Re-clicking mirror refreshes
        # rather than dead-ending on "already exists".
        t_sheet, t_atlas, _ = _action_storage(entry, target)
        if not t_sheet:
            base = str(entry["sprite_base_path"]).strip("/")
            t_sheet = f"{base}/{target}/spritesheet.png"
            t_atlas = f"{base}/{target}/atlas.json"
        minio.upload_bytes(mirrored, key=t_sheet, content_type="image/png")
        minio.upload_bytes(atlas, key=t_atlas, content_type="application/json")
        invalidate_search()
        return {
            "slug": slug, "action": target, "source": source, "refreshed": True,
            "spritesheet": minio.public_url_for_key(t_sheet),
            "atlas": minio.public_url_for_key(t_atlas),
        }

    # New mirror. overwrite=True reclaims any stale orphan file at the target path
    # (e.g. from an earlier failed mirror) instead of dead-ending.
    result = add_action(
        slug=slug, action=target, spritesheet=mirrored, atlas=atlas, overwrite=True
    )
    result["source"] = source
    return result


# --- destructive in-place transforms (flip / rotate, baked into the file) ----

def _content_type_for_key(key: str) -> str:
    k = key.lower()
    if k.endswith(".svg"):
        return "image/svg+xml"
    if k.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    return "image/png"


def transform_asset(*, kind: str, slug: str, flip_h: bool = False,
                    flip_v: bool = False, rotate: float = 0.0) -> dict:
    """Flip/rotate an object or background (whole image), or every action of a
    character, overwriting the file(s) in storage and bumping the cache-bust rev."""
    if kind not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}")
    ops = {"flip_h": flip_h, "flip_v": flip_v, "rotate": rotate}
    if image_transforms.is_noop(**ops):
        raise ValueError("no transform requested (need flip and/or rotate)")
    if not _exists(kind, slug):
        raise KeyError(slug)

    if kind == "character":
        return _transform_character(slug, ops)

    url = catalog.get_object_url(slug) if kind == "object" else catalog.get_background_url(slug)
    key = _key_from_storage_url(url)
    if not key:
        raise ValueError(f"cannot resolve a storage key for {kind} {slug!r}")
    data = minio.download_bytes(key)
    if data is None:
        raise ValueError(f"file for {kind} {slug!r} not found in storage")
    if key.lower().endswith(".svg"):
        baked = image_transforms.transform_svg(data, **ops)
    else:
        baked = image_transforms.transform_png(data, **ops)
    minio.upload_bytes(baked, key=key, content_type=_content_type_for_key(key))
    rev = overrides.asset_rev(kind, slug) + 1
    overrides.record_asset_config(kind, slug, rev=rev)
    invalidate_search()
    return {"kind": kind, "slug": slug, "rev": rev, "url": url}


def transform_action(*, slug: str, action: str, flip_h: bool = False,
                     flip_v: bool = False, rotate: float = 0.0) -> dict:
    """Flip/rotate one sprite action in place — per frame, so the atlas stays valid."""
    ops = {"flip_h": flip_h, "flip_v": flip_v, "rotate": rotate}
    if image_transforms.is_noop(**ops):
        raise ValueError("no transform requested (need flip and/or rotate)")
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if action not in entry.get("animations", []):
        raise KeyError(action)
    sheet_key, atlas_key, _ = _action_storage(entry, action)
    if not sheet_key:
        raise ValueError(f"action {action!r} has no resolvable spritesheet URL")
    sheet = minio.download_bytes(sheet_key)
    atlas = minio.download_bytes(atlas_key) if atlas_key else None
    if sheet is None:
        raise ValueError(f"spritesheet for {slug!r}/{action!r} not found in storage")
    baked = image_transforms.transform_spritesheet(sheet, atlas, **ops)
    minio.upload_bytes(baked, key=sheet_key, content_type="image/png")
    rev = overrides.action_rev(slug, action) + 1
    overrides.record_action_config(slug, action, rev=rev)
    invalidate_search()
    return {"slug": slug, "action": action, "rev": rev,
            "spritesheet": minio.public_url_for_key(sheet_key)}


def _rewrite_action_frames(slug: str, action: str, fn) -> dict:
    """Shared write path for the frame editors (trim / reorder). Downloads the
    action's spritesheet (+ atlas), runs `fn(sheet, atlas, frame_count) ->
    (new_sheet, new_atlas_or_None, new_count)`, overwrites the stored files in
    place, bumps `rev`, and updates `frame_count`. Only ever called from an
    explicit editor Save — never implicitly."""
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if action not in entry.get("animations", []):
        raise KeyError(action)
    sheet_key, atlas_key, _ = _action_storage(entry, action)
    if not sheet_key:
        raise ValueError(f"action {action!r} has no resolvable spritesheet URL")
    sheet = minio.download_bytes(sheet_key)
    if sheet is None:
        raise ValueError(f"spritesheet for {slug!r}/{action!r} not found in storage")
    atlas = minio.download_bytes(atlas_key) if atlas_key else None

    new_sheet, new_atlas, new_count = fn(sheet, atlas, overrides.action_frame_count(slug, action))
    minio.upload_bytes(new_sheet, key=sheet_key, content_type="image/png")
    if new_atlas is not None and atlas_key:
        minio.upload_bytes(new_atlas, key=atlas_key, content_type="application/json")

    rev = overrides.action_rev(slug, action) + 1
    overrides.record_action_config(slug, action, rev=rev, frame_count=new_count)
    base = str(entry["sprite_base_path"]).strip("/")
    _patch_action_sidecar(base, action, {"frame_count": new_count})
    invalidate_search()
    return {
        "slug": slug, "action": action, "rev": rev, "frame_count": new_count,
        "spritesheet": minio.public_url_for_key(sheet_key),
    }


def remove_action_frames(*, slug: str, action: str, remove: list[int]) -> dict:
    """Delete specific frames from an action's spritesheet (repack + atlas rewrite +
    frame_count update). Special case of `reorder_action_frames`."""
    return _rewrite_action_frames(
        slug, action,
        lambda sheet, atlas, fc: image_transforms.remove_frames(
            sheet, atlas, frame_count=fc, remove=remove
        ),
    )


def reorder_action_frames(*, slug: str, action: str, order: list[int]) -> dict:
    """Rebuild an action's spritesheet as an arbitrary sequence of its own frames
    (reorder / duplicate / delete via `order` = new list of source frame indices).
    Repacks into a dense row, rewrites the atlas (if any), updates `frame_count`,
    overwrites the stored files in place and bumps `rev`."""
    return _rewrite_action_frames(
        slug, action,
        lambda sheet, atlas, fc: image_transforms.reorder_frames(
            sheet, atlas, frame_count=fc, order=order
        ),
    )


def _transform_character(slug: str, ops: dict) -> dict:
    """Apply the same transform to every action's spritesheet (mirror a whole sprite)."""
    entry = catalog.get_character(slug) or {}
    revs: dict[str, int] = {}
    for action in entry.get("animations", []):
        try:
            res = transform_action(slug=slug, action=action, **ops)
            revs[action] = res["rev"]
        except (KeyError, ValueError) as exc:
            log.warning("transform_character: skipped %s/%s: %r", slug, action, exc)
    if not revs:
        raise ValueError(f"no transformable actions for character {slug!r}")
    return {"kind": "character", "slug": slug, "action_rev": revs}


def rename_action(*, slug: str, old: str, new: str) -> dict:
    _validate_slug(new, what="action name")
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if old not in entry.get("animations", []):
        raise KeyError(old)
    if old == new:
        raise ValueError("new action name is identical to the current one")
    if new in entry.get("animations", []):
        raise ValueError(f"action {new!r} already exists on {slug!r}")
    overrides.record_rename_action(slug, old=old, new=new)
    invalidate_search()
    return {"slug": slug, "old": old, "new": new}


def delete_action(*, slug: str, action: str) -> dict:
    """Remove an action from a character: drop it from the catalog/overrides
    (the source of truth for what the editor + generator see) and best-effort
    delete the per-action files from storage. Refuses to delete the last action."""
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    animations = list(entry.get("animations", []))
    if action not in animations:
        raise KeyError(action)
    if len(animations) <= 1:
        raise ValueError("cannot delete the only action; a character needs at least one")

    # Resolve the real storage folder BEFORE the catalog removal (renamed actions
    # live under their original folder, not one named after the action).
    _, _, folder = _action_storage(entry, action)
    overrides.record_delete_action(slug, name=action)
    removed = 0
    if folder:
        try:
            removed = minio.delete_prefix(folder)
        except Exception as exc:  # storage cleanup is best-effort; catalog is the truth
            log.warning("delete_action: storage cleanup failed for %s: %r", folder, exc)
    invalidate_search()
    return {"slug": slug, "action": action, "files_removed": removed}


def set_action_config(*, slug: str, action: str, fields: dict) -> dict:
    entry = catalog.get_character(slug)
    if entry is None:
        raise KeyError(slug)
    if action not in entry.get("animations", []):
        raise KeyError(action)
    clean = _clean_config_fields(fields, allow={"enabled", "description", "fps", "frame_count", "is_3q"})
    overrides.record_action_config(slug, action, **clean)
    base = str(entry["sprite_base_path"]).strip("/")
    _patch_action_sidecar(base, action, clean)
    invalidate_search()
    return {"slug": slug, "action": action, **overrides.action_config(slug, action)}


def set_asset_config(*, kind: str, slug: str, fields: dict) -> dict:
    if kind not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}")
    if not _exists(kind, slug):
        raise KeyError(slug)
    clean = _clean_config_fields(fields, allow={"enabled", "description"})
    overrides.record_asset_config(kind, slug, **clean)
    _patch_asset_sidecar(kind, slug, clean)
    invalidate_search()
    return {"kind": kind, "slug": slug, **overrides.asset_config(kind, slug)}


def _read_config_file(key: str | None) -> dict:
    """Read a co-located config file from storage as a dict ({} if absent/bad)."""
    if not key:
        return {}
    raw = minio.download_bytes(key)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def flat_config(*, kind: str, slug: str, action: str | None = None,
                authored: dict | None = None) -> dict:
    """The single flat config the system uses for an asset/action, as a union:
    the co-located config file's authored fields (an object's keywords /
    real_world_height_cm / rest_surface, a background's zones/description) form the
    base; the overrides index overlays on top where it has an opinion; and the
    authoritative enabled/fps/frame_count are guaranteed last. Never subtracts a
    field, so it can't drop authored data. Pass `authored` to reuse an already-read
    file (the migration does this); otherwise it is fetched from storage."""
    if action is not None:
        key = _action_config_key(slug, action)
        idx = dict(overrides.action_config(slug, action))
        guaranteed = {
            "enabled": overrides.is_action_enabled(slug, action),
            "fps": overrides.action_fps(slug, action),
            "frame_count": overrides.action_frame_count(slug, action),
        }
    else:
        key = _asset_sidecar_key(kind, slug)
        idx = dict(overrides.asset_config(kind, slug))
        guaranteed = {"enabled": overrides.is_enabled(kind, slug)}
    base = authored if authored is not None else _read_config_file(key)
    merged = {**base, **idx, **guaranteed}
    merged.pop("rev", None)                  # internal cache-buster, not config
    merged.setdefault("description", "")
    return merged


def _action_config_key(slug: str, action: str) -> str | None:
    entry = catalog.get_character(slug) or {}
    base = str(entry.get("sprite_base_path", "")).strip("/")
    return f"{base}/{action}/config.json" if base else None


def get_config_view(*, kind: str, slug: str, action: str | None = None) -> dict:
    """Flat, single-object view of an asset/action's config (one object, no
    effective/sidecar split). The config body is `flat_config`; this just adds the
    addressing fields and, where useful, the spritesheet key / background manifest."""
    out: dict = {"kind": kind, "slug": slug, "action": action}
    if action is not None:
        entry = catalog.get_character(slug)
        if entry is None:
            raise KeyError(slug)
        if action not in entry.get("animations", []):
            raise KeyError(action)
        out["spritesheet_key"] = _action_storage(entry, action)[0]
    else:
        if kind not in _KINDS:
            raise ValueError(f"kind must be one of {_KINDS}")
        if not _exists(kind, slug):
            raise KeyError(slug)
        if kind == "background":
            # backgrounds keep their richer config (zones/placements) in the manifest
            out["manifest"] = backgrounds.compact_context_for_slug(slug)
    out.update(flat_config(kind=kind, slug=slug, action=action))
    return out


def _clean_config_fields(fields: dict, *, allow: set[str]) -> dict:
    clean: dict = {}
    for k, v in fields.items():
        if k not in allow or v is None:
            continue
        if k in ("fps", "frame_count"):
            clean[k] = max(1, int(v))
        elif k in ("enabled", "is_3q"):
            clean[k] = bool(v)
        else:
            clean[k] = str(v)
    return clean


def _asset_sidecar_key(kind: str, slug: str) -> str | None:
    """Storage key of an asset's co-located config sidecar. Single source of this
    derivation, shared by the read view (`get_config_view`) and the write path."""
    if kind == "character":
        entry = catalog.get_character(slug) or {}
        base = str(entry.get("sprite_base_path", "")).strip("/")
        return f"{base}/config.json" if base else None
    url = catalog.get_object_url(slug) if kind == "object" else catalog.get_background_url(slug)
    key = _key_from_storage_url(url)
    return (key.rsplit(".", 1)[0] + ".json") if key else None


def _patch_asset_sidecar(kind: str, slug: str, updates: dict) -> None:
    key = _asset_sidecar_key(kind, slug)
    if key:
        _merge_into_sidecar(key, updates)


def _patch_action_sidecar(base: str, action: str, updates: dict) -> None:
    if base:
        _merge_into_sidecar(f"{base}/{action}/config.json", updates)


def _merge_into_sidecar(key: str, updates: dict) -> None:
    """Change ONLY `updates` in the sidecar, preserving every other authored field.

    Objects keep `keywords`/`real_world_height_cm`/`rest_surface`; the overrides
    index only tracks a subset (`enabled`/`description`), so rewriting the file
    wholesale from the index would silently drop the rest. Read-modify-write:
      * unreachable storage -> skip the write (leave the file intact, never clobber);
      * absent file         -> create it with just the updates;
      * unparseable file    -> refuse to overwrite (logged).
    """
    if not updates:
        return
    try:
        raw = minio.download_bytes(key)
    except Exception as exc:  # connection failure: never clobber a file we couldn't read
        log.warning("asset_admin: sidecar read failed for %s; skipping write: %r", key, exc)
        return
    current: dict = {}
    if raw:
        try:
            loaded = json.loads(raw)
        except (ValueError, TypeError):
            log.warning("asset_admin: sidecar %s is not valid JSON; refusing to overwrite", key)
            return
        if isinstance(loaded, dict):
            current = loaded
    merged = {**current, **updates}
    if merged != current:
        _upload_json(key, merged)


def _upload_json(key: str, doc: dict) -> None:
    # Best-effort: the index (overrides) already holds the truth; a sidecar
    # upload failure must not fail the operation.
    try:
        minio.upload_bytes(json.dumps(doc, indent=2).encode("utf-8"), key=key,
                           content_type="application/json")
    except Exception as exc:
        log.warning("asset_admin: config sidecar upload failed for %s: %r", key, exc)


def _key_from_storage_url(url: str | None) -> str | None:
    """Extract the object key from a baked `/storage/{bucket}/{key}` catalog URL.

    Bucket-agnostic: strips the `/storage/<bucket>/` prefix so a renamed
    connected bucket still resolves to the right key.
    """
    if not url:
        return None
    clean = url.split("?", 1)[0]
    marker = "/storage/"
    idx = clean.find(marker)
    if idx == -1:
        return None
    rest = clean[idx + len(marker):]  # {bucket}/{key...}
    parts = rest.split("/", 1)
    if len(parts) < 2:
        return None
    return parts[1].lstrip("/")
