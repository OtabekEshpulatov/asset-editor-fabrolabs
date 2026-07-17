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

from app import asset_admin, backgrounds, connection, end_intros, intro_music, intros, live_bgs_v2, live_bgs_v3, sprites_v2, sprites_v3, videos
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


async def _sync_overrides() -> None:
    """Before any asset request, pick up catalog/config changes another worker
    persisted (delete/copy/rename/enable/…), so this worker never serves a stale
    actions list. Cheap: a single stat() unless the sidecar actually moved.

    MUST be async so the (rare) re-layer runs on the event loop, NOT a threadpool
    thread. It clears+rebuilds the shared catalog dicts in place; the read handlers
    iterate those same dicts. On the event loop the rebuild is atomic w.r.t. those
    handlers (no ``await`` inside it, and the reload reads the LOCAL sidecar so it
    never blocks on network). A sync def here would run in a worker thread and race
    concurrent readers → ``dictionary changed size during iteration``. Best-effort:
    a sync failure just leaves this worker as fresh as it already was."""
    try:
        overrides.sync_from_disk_if_changed()
    except Exception as exc:  # noqa: BLE001 — coherence is best-effort, never fatal
        log.warning("overrides auto-sync failed: %r", exc)


router = APIRouter(
    prefix="/api/v4", dependencies=[Depends(_require_storage), Depends(_sync_overrides)]
)


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
    if kind == "intro":
        # World intro packs live under intros/{world}/ — discovered in MinIO.
        return intros.catalog(include_disabled=include_disabled)
    if kind == "video_v2":
        # Re-animated live backgrounds under review (live_backgrounds_v2/).
        return live_bgs_v2.catalog(include_disabled=include_disabled)
    if kind == "video_v3":
        # Relation backgrounds: a VIEW of live_backgrounds/ grouped by world graph.
        return live_bgs_v3.catalog(include_disabled=include_disabled)
    if kind == "intro_end":
        # One goodnight END card per world (intros/{world}/end_bg.mp4).
        return end_intros.catalog(include_disabled=include_disabled)
    if kind == "intro_music":
        # The ~10-song theme pool under intro_music/ — discovered in MinIO.
        return intro_music.catalog(include_disabled=include_disabled)
    if kind == "animation":
        # Animations v2 sprite libraries live under sprites-v2/ — discovered in MinIO.
        return sprites_v2.catalog(include_disabled=include_disabled)
    if kind == "animation_v3":
        # Animations v3: a curated subset of v1 characters (manifests/v3_curated.json), no duplication.
        return sprites_v3.catalog(include_disabled=include_disabled)
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
    flip: bool | None = None        # facing for float / patrol / pulse / peek
    to_left: bool | None = None     # facing for swim (separate spec key)
    speed: float | None = None      # animation-rate multiplier (>1 faster)
    x0: float | None = None
    x1: float | None = None
    bush_x: float | None = None     # peek: foreground bush position / size
    bush_y: float | None = None
    bush_w: int | None = None
    tiles_per_loop: int | None = None  # strip: parallax scroll speed (integer >=1)


class AddedMoverIn(BaseModel):
    id: str
    kind: str
    x: float | None = None
    y: float | None = None
    w: int | None = None
    flip: bool | None = None
    still: bool | None = None       # "stays put" → zero-drift float
    breathe: bool | None = None     # "stay but gently pulse size" → animated float scale
    speed: float | None = None      # animation-rate multiplier (>1 faster)
    x0: float | None = None
    x1: float | None = None


class MoversUpdate(BaseModel):
    movers: list[MoverEditIn] = []
    removed: list[int] = []         # original indices to drop
    added: list[AddedMoverIn] = []  # creatures to append


@router.get("/videos/{slug}/movers/palette")
async def get_video_object_palette(slug: str) -> list[dict]:
    """Creatures that can be dropped into a scene (the union shipped across all bundles)."""
    return await asyncio.to_thread(livebg_service.list_palette)


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
    """Apply object edits + removals + additions, re-render the mp4 (no LLM) and upload it back."""
    edits = [e.model_dump(exclude_unset=True) for e in body.movers]
    added = [a.model_dump(exclude_unset=True) for a in body.added]
    try:
        return await livebg_service.save_movers(slug, edits, removed=body.removed, added=added)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no video {slug!r}")
    except livebg_service.NotEditable:
        raise HTTPException(status_code=409, detail=f"video {slug!r} has no editable source bundle")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=f"incomplete source bundle: {exc}")
    except Exception as exc:  # noqa: BLE001 — surface render/ffmpeg failures
        log.exception("livebg re-render failed for %s", slug)
        raise HTTPException(status_code=500, detail=f"re-render failed: {exc}")


# --- relation backgrounds (Live BG v3): world location graphs ----------------

@router.get("/live-bgs-v3/{world_id}/graph")
async def get_world_graph(world_id: str) -> dict:
    """One world's location graph (nodes with resolved URLs + routes with both
    endpoints) — the data the relation-map UI draws."""
    try:
        return await asyncio.to_thread(live_bgs_v3.graph_view, world_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no world graph {world_id!r}")


class GraphSaveIn(BaseModel):
    routes: list[dict] = []
    ui: dict[str, dict] = {}  # slug -> {x, y} editor positions


@router.put("/live-bgs-v3/{world_id}/graph")
async def save_world_graph(world_id: str, body: GraphSaveIn) -> dict:
    """Persist relation-editor edits (rewired/new/deleted routes + card
    positions) back to the world's sidecar. Nodes are never added or removed."""
    try:
        return await asyncio.to_thread(live_bgs_v3.save_graph, world_id, body.routes, body.ui)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no world graph {world_id!r}")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/live-bgs-v3/{world_id}/sync-engine")
async def get_engine_sync(world_id: str) -> dict:
    """Last release of this world's graph to the engine channel (if any)."""
    return await asyncio.to_thread(live_bgs_v3.engine_sync_status, world_id)


@router.post("/live-bgs-v3/{world_id}/sync-engine")
async def sync_engine(world_id: str) -> dict:
    """Release the current sidecar to the engine channel
    (manifests/world_graphs_engine/) — story-gen pulls it before story runs."""
    try:
        return await asyncio.to_thread(live_bgs_v3.sync_engine, world_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no world graph {world_id!r}")


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
        if kind == "intro":
            return intros.config_view(slug)
        if kind == "video_v2":
            return live_bgs_v2.config_view(slug)
        if kind == "intro_end":
            return end_intros.config_view(slug)
        if kind == "intro_music":
            return intro_music.config_view(slug)
        # The animation galleries (Animations / Animations v3) re-present existing
        # character sprites, so an asset-level config request there is really a
        # request for the underlying character's config.
        if action is None and kind in ("animation", "animation_v3"):
            kind = "character"
        return asset_admin.get_config_view(kind=kind, slug=slug, action=action)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.put("/assets/config")
async def update_asset_config(body: AssetConfigUpdate) -> dict:
    fields = body.model_dump(exclude={"kind", "slug"}, exclude_none=True)
    try:
        if body.kind == "intro":
            return intros.set_config(body.slug, **fields)
        if body.kind == "video_v2":
            return live_bgs_v2.set_config(body.slug, **fields)
        if body.kind == "intro_end":
            return end_intros.set_config(body.slug, **fields)
        if body.kind == "intro_music":
            return intro_music.set_config(body.slug, **fields)
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
                "is_3q": bool(cfg.get("is_3q", False)),
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


class ReconcileFolders(BaseModel):
    execute: bool = False
    category: str | None = None   # scope: category prefix, e.g. "animals/birds"
    only: str | None = None       # scope: one character slug
    limit: int | None = None      # max moves per call (chunked migration)


@router.post("/assets/actions/reconcile-folders")
async def reconcile_action_folders(body: ReconcileFolders) -> dict:
    """Sweep for actions whose storage folder != action name. Dry-run by default
    (returns the move plan); `execute` materializes the moves (folder==name)."""
    try:
        return asset_admin.reconcile_action_folders(
            execute=body.execute, category=body.category,
            only=body.only, limit=body.limit,
        )
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


@router.post("/assets/actions/replace")
async def replace_action_sheet(
    slug: str = Form(...),
    action: str = Form(...),
    spritesheet: UploadFile = File(...),
    atlas: UploadFile = File(...),
) -> dict:
    """Overwrite an existing action's spritesheet+atlas in place (regenerated-animation
    drop-in). Bumps the cache-bust rev and frame_count; no rename/tombstone churn."""
    try:
        return asset_admin.replace_action_sheet(
            slug=slug, action=action,
            spritesheet=await spritesheet.read(), atlas=await atlas.read(),
        )
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


class ActionFramesRemove(BaseModel):
    slug: str
    action: str
    remove: list[int]


@router.post("/assets/actions/frames/remove")
async def remove_action_frames(body: ActionFramesRemove) -> dict:
    """Delete specific frames from an action's spritesheet, repacking the rest
    into a clean grid. Destructive (overwrites the stored files) — the editor
    only calls this from an explicit Save, after a client-side preview."""
    try:
        return asset_admin.remove_action_frames(slug=body.slug, action=body.action, remove=body.remove)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class ActionFramesReorder(BaseModel):
    slug: str
    action: str
    # New sequence of source frame indices: omit to delete, repeat to copy, list
    # in any order to reorder. The general form of frames/remove.
    order: list[int]


@router.post("/assets/actions/frames/reorder")
async def reorder_action_frames(body: ActionFramesReorder) -> dict:
    """Rebuild an action's spritesheet as an arbitrary sequence of its own frames
    (reorder / duplicate / delete). Destructive (overwrites the stored files) —
    the editor only calls this from an explicit Save, after a client-side preview."""
    try:
        return asset_admin.reorder_action_frames(slug=body.slug, action=body.action, order=body.order)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)


class ActionConfigUpdate(BaseModel):
    slug: str
    action: str
    enabled: bool | None = None
    description: str | None = None
    fps: int | None = None
    frame_count: int | None = None
    is_3q: bool | None = None  # marks a 3/4-view action (the "3q" the name used to encode)


@router.put("/assets/actions/config")
async def update_action_config(body: ActionConfigUpdate) -> dict:
    fields = body.model_dump(exclude={"slug", "action"}, exclude_none=True)
    try:
        return asset_admin.set_action_config(slug=body.slug, action=body.action, fields=fields)
    except (KeyError, ValueError) as exc:
        raise _admin_error(exc)
