"""Asset + background management routes (extracted from story-gen-exps v4).

Prefix kept as /api/v4 so the copied gallery/zone-editor frontend works
unchanged. A router-level guard returns 428 until a storage connection is set.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app import asset_admin, backgrounds, connection, videos
from app.asset_urls import _spritesheet_url, resolve_asset_url
from app.livebg import service as livebg_service
from app.catalog import catalog, overrides
from app.catalog.static_asset_catalog import (
    BACKGROUND_CATEGORIES,
    CHARACTER_CATEGORIES,
    OBJECT_CATEGORIES,
)
from app.schemas import AssetKind

log = logging.getLogger(__name__)


def _require_storage() -> None:
    if not connection.is_configured():
        raise HTTPException(status_code=428, detail="storage not configured")


router = APIRouter(prefix="/api/v4", dependencies=[Depends(_require_storage)])


def _admin_error(exc: Exception):
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=500, detail=str(exc))


# --- preview / metadata / catalog -------------------------------------------

@router.get("/assets/preview")
async def asset_preview_url(slug: str, kind: AssetKind) -> dict:
    url = resolve_asset_url(slug, kind)
    if url is None:
        raise HTTPException(status_code=404, detail=f"no preview URL for {kind} {slug!r}")
    return {"slug": slug, "kind": kind, "url": url}


@router.get("/assets/metadata")
async def asset_metadata(slug: str, kind: AssetKind) -> dict:
    url = resolve_asset_url(slug, kind)
    if kind != "character":
        if url is None:
            raise HTTPException(status_code=404, detail=f"no asset metadata for {kind} {slug!r}")
        metadata = backgrounds.compact_context_for_slug(slug) if kind == "background" else None
        return {"slug": slug, "kind": kind, "url": url, **(metadata or {})}

    entry = catalog.get_character(slug)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"no asset metadata for character {slug!r}")

    animation_urls = {
        anim: spritesheet
        for anim, value in (entry.get("animation_urls") or {}).items()
        if (spritesheet := _spritesheet_url(value))
    }
    return {
        "slug": slug,
        "kind": kind,
        "url": url,
        "character_kind": entry.get("kind"),
        "subcategory": entry.get("subcategory"),
        "sprite_base_path": entry.get("sprite_base_path"),
        "animations": list(entry.get("animations", [])),
        "animation_urls": animation_urls,
    }


_CATEGORY_MAPS = {
    "character": CHARACTER_CATEGORIES,
    "object": OBJECT_CATEGORIES,
    "background": BACKGROUND_CATEGORIES,
}


@router.get("/assets/catalog")
async def asset_catalog(kind: AssetKind, include_disabled: bool = False) -> dict:
    """The full asset library for one kind, grouped by category, for the gallery.

    Each item carries a `/storage/...` preview URL (served by the backend proxy)
    and an `enabled` flag. Character items also carry `animation_urls` so the UI
    can animate every sprite sheet client-side. Disabled assets are omitted
    unless `include_disabled` is set.
    """
    if kind == "video":
        # Live mp4 backgrounds aren't in the static catalog — discovered in MinIO.
        return videos.catalog(include_disabled=include_disabled)
    categories_map = _CATEGORY_MAPS[kind]
    categories: list[dict] = []
    total = 0
    for name in sorted(categories_map):
        items: list[dict] = []
        for slug in sorted(categories_map[name]):
            enabled = overrides.is_enabled(kind, slug)
            if not enabled and not include_disabled:
                continue
            cfg = overrides.asset_config(kind, slug)
            if kind == "character":
                entry = catalog.get_character(slug) or {}
                anim_urls = {
                    anim: url
                    for anim, value in (entry.get("animation_urls") or {}).items()
                    if (url := _spritesheet_url(value))
                    and (include_disabled or overrides.is_action_enabled(slug, anim))
                }
                if not anim_urls:
                    continue
                default = next((a for a in ("idle", "happy", "move") if a in anim_urls), None)
                items.append(
                    {
                        "slug": slug,
                        "url": anim_urls.get(default) if default else next(iter(anim_urls.values())),
                        "description": cfg.get("description", ""),
                        "enabled": enabled,
                        "animation_urls": anim_urls,
                        "action_fps": {a: overrides.action_fps(slug, a) for a in anim_urls},
                        "action_rev": {a: overrides.action_rev(slug, a) for a in anim_urls},
                    }
                )
            else:
                url = resolve_asset_url(slug, kind)
                if not url:
                    continue
                if kind == "background":
                    description = str((backgrounds.entry_for_slug(slug) or {}).get("description") or "")
                else:
                    description = cfg.get("description", "")
                items.append({
                    "slug": slug, "url": url, "description": description,
                    "enabled": enabled, "rev": overrides.asset_rev(kind, slug),
                })
        if items:
            categories.append({"name": name, "count": len(items), "items": items})
            total += len(items)
    return {"kind": kind, "total": total, "categories": categories}


# --- background zone editor --------------------------------------------------

class BgZoneIn(BaseModel):
    name: str
    # Free-form polygon (normalized 0-100 [x, y] points) — the authoritative shape.
    polygon: list[list[float]] | None = None
    # Placement surface this zone offers (matches object rest_surface vocabulary).
    surface: str | None = None
    description: str = ""
    # Optional custom overlay colour (hex) for the editor.
    color: str | None = None
    # Legacy y-band — still accepted (migrated to a full-width polygon) for old payloads.
    y_start_pct: float | None = None
    y_end_pct: float | None = None


class BackgroundUpdate(BaseModel):
    description: str | None = None
    zones: list[BgZoneIn]


@router.get("/backgrounds/{slug}")
async def get_background(slug: str) -> dict:
    """Editable zone/placement data for one background (for the zone editor)."""
    entry = backgrounds.editable_entry_for_slug(slug)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"no background {slug!r}")
    return entry


@router.put("/backgrounds/{slug}")
async def update_background(slug: str, body: BackgroundUpdate) -> dict:
    """Persist edited zones/placements to the per-bg config sidecar + index."""
    try:
        return backgrounds.save_entry_for_slug(slug, body.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no background {slug!r}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/backgrounds/backfill-configs")
async def backfill_background_configs() -> dict:
    """Write a per-background config sidecar for every background (migration)."""
    return {"written": backgrounds.backfill_sidecars()}


@router.post("/backgrounds/rebuild-index")
async def rebuild_background_index() -> dict:
    """Regenerate the aggregate index by scanning per-background sidecars."""
    return {"entries": backgrounds.rebuild_index_from_sidecars()}


@router.post("/backgrounds/normalize")
async def normalize_backgrounds() -> dict:
    """Strip legacy fields (scene_type, character/object_placement, y-band/px) from
    every stored background, leaving the lean polygon-only zone schema."""
    return {"normalized": backgrounds.normalize_all()}


# --- live (mp4) background zone editor --------------------------------------

class VideoUpdate(BaseModel):
    description: str | None = None
    enabled: bool | None = None
    # Optional: omit to save only config (enabled/description) without touching zones.
    zones: list[BgZoneIn] | None = None


@router.get("/videos/{slug}")
async def get_video(slug: str) -> dict:
    """Editable zone data for one live (mp4) background."""
    entry = videos.editable_entry_for_slug(slug)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"no video {slug!r}")
    return entry


@router.put("/videos/{slug}")
async def update_video(slug: str, body: VideoUpdate) -> dict:
    """Persist edited zones / config for one live background."""
    try:
        return videos.save_entry_for_slug(slug, body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no video {slug!r}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# --- live (mp4) background OBJECT editor (drag moving objects + re-render) ----

class MoverEditIn(BaseModel):
    index: int
    x: float | None = None
    y: float | None = None
    w: int | None = None
    flip: bool | None = None
    x0: float | None = None
    x1: float | None = None


class MoversUpdate(BaseModel):
    movers: list[MoverEditIn]


@router.get("/videos/{slug}/movers")
async def get_video_movers(slug: str) -> dict:
    """Draggable moving-object view for one live background (needs a source bundle)."""
    try:
        return await asyncio.to_thread(livebg_service.get_movers, slug)  # blocking MinIO reads off the loop
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no video {slug!r}")
    except livebg_service.NotEditable:
        raise HTTPException(status_code=409, detail=f"video {slug!r} has no editable source bundle")


@router.post("/videos/{slug}/movers")
async def save_video_movers(slug: str, body: MoversUpdate) -> dict:
    """Apply object-position edits, re-render the mp4 (no LLM) and upload it back."""
    edits = [e.model_dump(exclude_unset=True) for e in body.movers]
    try:
        return await livebg_service.save_movers(slug, edits)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no video {slug!r}")
    except livebg_service.NotEditable:
        raise HTTPException(status_code=409, detail=f"video {slug!r} has no editable source bundle")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=f"incomplete source bundle: {exc}")
    except Exception as exc:  # noqa: BLE001 — surface render/ffmpeg failures
        log.exception("livebg re-render failed for %s", slug)
        raise HTTPException(status_code=500, detail=f"re-render failed: {exc}")


# --- asset management: add new / rename existing -----------------------------

@router.post("/assets/objects", status_code=201)
async def add_object(
    slug: str = Form(...),
    category: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    try:
        return asset_admin.add_object(slug=slug, category=category, data=await file.read())
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.post("/assets/backgrounds", status_code=201)
async def add_background(
    slug: str = Form(...),
    category: str = Form(...),
    scene_type: str = Form(""),
    description: str = Form(""),
    file: UploadFile = File(...),
) -> dict:
    try:
        return asset_admin.add_background(
            slug=slug,
            category=category,
            data=await file.read(),
            scene_type=scene_type,
            description=description,
        )
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.post("/assets/characters", status_code=201)
async def add_character(
    slug: str = Form(...),
    category: str = Form(...),
    files: list[UploadFile] = File(...),
) -> dict:
    # Pair uploads by filename stem: "<anim>.png" = spritesheet, "<anim>.json" = atlas.
    animations: dict[str, dict[str, bytes]] = {}
    for f in files:
        stem = Path(f.filename or "").stem
        ext = Path(f.filename or "").suffix.lower()
        slot = "spritesheet" if ext == ".png" else "atlas" if ext == ".json" else None
        if not stem or slot is None:
            continue
        animations.setdefault(stem, {})[slot] = await f.read()
    try:
        return asset_admin.add_character(slug=slug, category=category, animations=animations)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class AssetRename(BaseModel):
    kind: AssetKind
    old_slug: str
    new_slug: str


@router.post("/assets/rename")
async def rename_asset(body: AssetRename) -> dict:
    try:
        if body.kind == "video":
            return videos.rename(body.old_slug, body.new_slug)
        return asset_admin.rename(kind=body.kind, old_slug=body.old_slug, new_slug=body.new_slug)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class AssetConfigUpdate(BaseModel):
    kind: AssetKind
    slug: str
    enabled: bool | None = None
    description: str | None = None


@router.get("/assets/config-view")
async def config_view(slug: str, kind: AssetKind = "character", action: str | None = None) -> dict:
    """Read-only config for one asset (or action): effective config + raw sidecar.

    Pass `action` for a sprite action (kind is then treated as character).
    """
    try:
        if kind == "video":
            return videos.config_view(slug)
        return asset_admin.get_config_view(kind=kind, slug=slug, action=action)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.put("/assets/config")
async def update_asset_config(body: AssetConfigUpdate) -> dict:
    fields = body.model_dump(exclude={"kind", "slug"}, exclude_none=True)
    try:
        return asset_admin.set_asset_config(kind=body.kind, slug=body.slug, fields=fields)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.get("/assets/characters/{slug}/actions")
async def list_character_actions(slug: str) -> dict:
    """All actions of a character (incl. disabled) with config, for the editor."""
    entry = catalog.get_character(slug)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"no character {slug!r}")
    actions = []
    for action in sorted(entry.get("animations", [])):
        value = (entry.get("animation_urls") or {}).get(action)
        cfg = overrides.action_config(slug, action)
        actions.append(
            {
                "name": action,
                "spritesheet": _spritesheet_url(value),
                "enabled": overrides.is_action_enabled(slug, action),
                "fps": overrides.action_fps(slug, action),
                "frame_count": overrides.action_frame_count(slug, action),
                "description": cfg.get("description", ""),
                "rev": overrides.action_rev(slug, action),
            }
        )
    return {
        "slug": slug,
        "enabled": overrides.is_enabled("character", slug),
        "description": overrides.asset_config("character", slug).get("description", ""),
        "actions": actions,
    }


@router.post("/assets/characters/{slug}/actions", status_code=201)
async def add_character_action(
    slug: str,
    action: str = Form(...),
    spritesheet: UploadFile = File(...),
    atlas: UploadFile = File(...),
) -> dict:
    try:
        return asset_admin.add_action(
            slug=slug,
            action=action,
            spritesheet=await spritesheet.read(),
            atlas=await atlas.read(),
        )
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.delete("/assets/characters/{slug}/actions/{action}")
async def delete_character_action(slug: str, action: str) -> dict:
    """Delete one action (with its files); refuses to delete the last one."""
    try:
        return asset_admin.delete_action(slug=slug, action=action)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class ActionRename(BaseModel):
    slug: str
    old: str
    new: str


@router.post("/assets/actions/rename")
async def rename_character_action(body: ActionRename) -> dict:
    try:
        return asset_admin.rename_action(slug=body.slug, old=body.old, new=body.new)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class ActionMirror(BaseModel):
    slug: str
    source: str
    new: str | None = None  # default: toggle _left/_right (else append _left)


@router.post("/assets/actions/mirror", status_code=201)
async def mirror_character_action(body: ActionMirror) -> dict:
    try:
        return asset_admin.mirror_action(slug=body.slug, source=body.source, new=body.new)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class AssetTransform(BaseModel):
    kind: AssetKind
    slug: str
    flip_h: bool = False
    flip_v: bool = False
    rotate: float = 0.0  # clockwise degrees, baked into the file


class ActionTransform(BaseModel):
    slug: str
    action: str
    flip_h: bool = False
    flip_v: bool = False
    rotate: float = 0.0


@router.post("/assets/transform")
async def transform_asset(body: AssetTransform) -> dict:
    """Flip/rotate an object/background (whole image) or a character (all actions)
    in place, overwriting the file(s). Returns the new cache-bust `rev`."""
    try:
        return asset_admin.transform_asset(
            kind=body.kind, slug=body.slug,
            flip_h=body.flip_h, flip_v=body.flip_v, rotate=body.rotate,
        )
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.post("/assets/actions/transform")
async def transform_action(body: ActionTransform) -> dict:
    """Flip/rotate one sprite action in place, per-frame, overwriting its spritesheet."""
    try:
        return asset_admin.transform_action(
            slug=body.slug, action=body.action,
            flip_h=body.flip_h, flip_v=body.flip_v, rotate=body.rotate,
        )
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class ActionConfigUpdate(BaseModel):
    slug: str
    action: str
    enabled: bool | None = None
    description: str | None = None
    fps: int | None = None
    frame_count: int | None = None


@router.put("/assets/actions/config")
async def update_action_config(body: ActionConfigUpdate) -> dict:
    fields = body.model_dump(exclude={"slug", "action"}, exclude_none=True)
    try:
        return asset_admin.set_action_config(slug=body.slug, action=body.action, fields=fields)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)
