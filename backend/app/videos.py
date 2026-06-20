"""Live animated backgrounds (mp4): discover ``live_backgrounds/*.mp4`` in the
bucket and manage per-video placement zones — the SAME zone model as static
backgrounds, but keyed by slug (these videos aren't in the static catalog).

Per-video config (description, enabled, zones) lives in an aggregate manifest
``manifests/live_backgrounds_manifest.json`` plus a co-located sidecar
``live_backgrounds/{world}/{slug}.json``. The zone-doc shape is shared with
``app.backgrounds`` so the existing zone editor works unchanged.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from app import config
from app.backgrounds import (
    ALLOWED_SURFACES,
    ALLOWED_ZONE_NAMES,
    _build_zones,
    _clampf,
    _default_surface,
    _num,
)
from app.storage import json_store, minio

log = logging.getLogger(__name__)

LIVE_PREFIX = "live_backgrounds/"
MANIFEST_OBJECT_KEY = "manifests/live_backgrounds_manifest.json"
MANIFEST_LOCAL_PATH = config.DATA_DIR / "live_backgrounds_manifest.json"
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".m4v")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_DEFAULT_RESOLUTION = {"width": 1920, "height": 1080}

# A sensible starting split so a brand-new video opens with editable zones.
_DEFAULT_ZONES = {
    "sky": {"y_start_pct": 0, "y_end_pct": 55, "description": "Sky / upper area."},
    "ground": {"y_start_pct": 55, "y_end_pct": 100, "description": "Ground where characters stand."},
}


# --- discovery --------------------------------------------------------------

def _video_keys() -> dict[str, str]:
    """Map slug -> object key by scanning the ``live_backgrounds/`` prefix.

    Slug is the filename stem (folder-independent), so organizing videos into
    world subfolders (``live_backgrounds/{world}/{slug}.mp4``) does NOT change a
    video's slug — its manifest zones + config survive the move.
    """
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(LIVE_PREFIX)
    except Exception as exc:
        log.warning("videos: listing %s failed: %r", LIVE_PREFIX, exc)
        return {}
    for key in keys:
        if key.lower().endswith(VIDEO_EXTS):
            out[Path(key).stem] = key
    return out


def _world_of_key(key: str) -> str:
    """The world folder a video lives in: the path segment between the
    live_backgrounds/ prefix and the filename (``uncategorized`` if flat)."""
    rel = key[len(LIVE_PREFIX):]
    return rel.split("/", 1)[0] if "/" in rel else "uncategorized"


def video_key(slug: str) -> str | None:
    return _video_keys().get(slug)


def video_url(slug: str) -> str | None:
    key = video_key(slug)
    return minio.public_url_for_key(key) if key else None


# --- manifest ---------------------------------------------------------------

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


def _write_sidecar(slug: str, entry: dict[str, Any]) -> None:
    """Co-locate the per-video config next to its mp4 (best-effort)."""
    key = video_key(slug)
    sidecar_key = (key.rsplit(".", 1)[0] + ".json") if key else f"{LIVE_PREFIX}{slug}.json"
    try:
        minio.upload_bytes(
            json.dumps(entry, indent=2).encode("utf-8"),
            key=sidecar_key,
            content_type="application/json",
        )
    except Exception as exc:
        log.warning("videos: sidecar upload failed for %s: %r", slug, exc)


# --- gallery catalog --------------------------------------------------------

def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """Same {kind,total,categories} shape the gallery expects — grouped by world
    (the live_backgrounds/{world}/ subfolder), like the other asset kinds."""
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
    return {"kind": "video", "total": total, "categories": categories}


# --- zone editor (read / write) ---------------------------------------------

def editable_entry_for_slug(slug: str) -> dict[str, Any] | None:
    """Round-trippable view for the zone editor; defaults to a sky/ground split."""
    key = video_key(slug)
    if key is None:
        return None
    entry = _read_manifest().get(slug)
    entry = entry if isinstance(entry, dict) else {}
    res = entry.get("resolution") if isinstance(entry.get("resolution"), dict) else {}
    zones_src = entry.get("zones") if isinstance(entry.get("zones"), dict) else dict(_DEFAULT_ZONES)

    zones: list[dict[str, Any]] = []
    for name, zone in zones_src.items():
        if not isinstance(zone, dict):
            continue
        ys = _num(zone.get("y_start_pct"), 0)
        ye = _num(zone.get("y_end_pct"), 0)
        poly = zone.get("polygon")
        if not (isinstance(poly, list) and len(poly) >= 3):
            poly = [[0.0, ys], [100.0, ys], [100.0, ye], [0.0, ye]]
        polygon = [[_clampf(p[0]), _clampf(p[1])] for p in poly
                   if isinstance(p, (list, tuple)) and len(p) >= 2]
        zones.append({
            "name": str(name),
            "description": str(zone.get("description") or ""),
            "polygon": polygon,
            "surface": str(zone.get("surface") or _default_surface(str(name))),
            "color": zone.get("color"),
        })
    zones.sort(key=lambda z: min((p[1] for p in z["polygon"]), default=0))
    return {
        "slug": slug,
        "manifest_key": key,
        "url": video_url(slug),
        "is_video": True,
        "description": str(entry.get("description") or ""),
        "resolution": {
            "width": int(res.get("width") or _DEFAULT_RESOLUTION["width"]),
            "height": int(res.get("height") or _DEFAULT_RESOLUTION["height"]),
        },
        "allowed_zone_names": sorted(ALLOWED_ZONE_NAMES),
        "allowed_surfaces": ALLOWED_SURFACES,
        "enabled": bool(entry.get("enabled", True)),
        "zones": zones,
    }


def save_entry_for_slug(slug: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist editor changes for one video. Only the keys present in `payload`
    are touched, so a config-only save ({"enabled": ...}) keeps existing zones."""
    key = video_key(slug)
    if key is None:
        raise KeyError(slug)

    doc = _read_manifest()
    entry = doc.get(slug)
    entry = dict(entry) if isinstance(entry, dict) else {}
    res = entry.get("resolution") if isinstance(entry.get("resolution"), dict) else {}
    entry.setdefault("resolution", {
        "width": int(res.get("width") or _DEFAULT_RESOLUTION["width"]),
        "height": int(res.get("height") or _DEFAULT_RESOLUTION["height"]),
    })

    if payload.get("description") is not None:
        entry["description"] = str(payload["description"])
    if payload.get("enabled") is not None:
        entry["enabled"] = bool(payload["enabled"])

    zones_in = payload.get("zones")
    if isinstance(zones_in, list):
        entry["zones"] = _build_zones(zones_in)
    entry.pop("scene_type", None)  # converge on the lean schema

    doc[slug] = entry
    _write_manifest(doc)
    _write_sidecar(slug, entry)
    return editable_entry_for_slug(slug)  # type: ignore[return-value]


def set_config(slug: str, *, enabled: bool | None = None, description: str | None = None) -> dict[str, Any]:
    fields = {k: v for k, v in {"enabled": enabled, "description": description}.items() if v is not None}
    return save_entry_for_slug(slug, fields)


# --- config view ------------------------------------------------------------

def config_view(slug: str) -> dict[str, Any]:
    """Flat, read-only config for one live background — the same shape
    `asset_admin.get_config_view` returns for static assets, so the gallery's
    ConfigViewer can render it. The zone-bearing manifest entry is `manifest`."""
    key = video_key(slug)
    if key is None:
        raise KeyError(slug)
    entry = _read_manifest().get(slug)
    entry = entry if isinstance(entry, dict) else {}
    return {
        "kind": "video",
        "slug": slug,
        "action": None,
        "world": _world_of_key(key),
        "manifest_key": key,
        "sidecar_key": key.rsplit(".", 1)[0] + ".json",
        "url": minio.public_url_for_key(key),
        "enabled": bool(entry.get("enabled", True)),
        "description": str(entry.get("description") or ""),
        "manifest": entry,
    }


# --- rename -----------------------------------------------------------------

def rename(old_slug: str, new_slug: str) -> dict[str, Any]:
    """Rename a live background: its slug IS the mp4's filename stem, so this
    renames the mp4 (and its co-located ``.json`` sidecar) in place within the
    same world folder, and re-keys the manifest entry. Zones are preserved."""
    new_slug = (new_slug or "").strip()
    if not _SLUG_RE.match(new_slug):
        raise ValueError("name must be lowercase letters, digits, '-' or '_'")
    old_key = video_key(old_slug)
    if old_key is None:
        raise KeyError(old_slug)
    if new_slug == old_slug:
        return config_view(old_slug)
    if video_key(new_slug) is not None:
        raise ValueError(f"a live background named {new_slug!r} already exists")

    parent, _, fname = old_key.rpartition("/")
    ext = fname.rsplit(".", 1)[1]
    new_key = f"{parent}/{new_slug}.{ext}" if parent else f"{new_slug}.{ext}"
    if minio.object_exists(new_key):
        raise ValueError(f"a file already exists at {new_key}")

    # mp4: server-side copy then drop the original.
    minio.copy_object(old_key, new_key)
    minio.delete_object(old_key)

    # sidecar (best-effort — not every video has one).
    old_sidecar = old_key.rsplit(".", 1)[0] + ".json"
    new_sidecar = new_key.rsplit(".", 1)[0] + ".json"
    if minio.object_exists(old_sidecar):
        try:
            minio.copy_object(old_sidecar, new_sidecar)
            minio.delete_object(old_sidecar)
        except Exception as exc:
            log.warning("videos: sidecar rename failed for %s: %r", old_slug, exc)

    # manifest: re-key the entry so zones follow the new slug.
    doc = _read_manifest()
    if old_slug in doc:
        doc[new_slug] = doc.pop(old_slug)
        _write_manifest(doc)

    return config_view(new_slug)
