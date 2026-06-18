"""Live animated backgrounds (mp4): discover ``live_backgrounds/*.mp4`` in the
bucket and manage per-video placement zones — the SAME zone model as static
backgrounds, but keyed by slug (these videos aren't in the static catalog).

Per-video config (scene_type, description, enabled, zones) lives in an aggregate
manifest ``manifests/live_backgrounds_manifest.json`` plus a co-located sidecar
``live_backgrounds/{slug}.json``. The zone-doc shape is shared with
``app.backgrounds`` so the existing zone editor works unchanged.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app import config
from app.backgrounds import (
    ALLOWED_SURFACES,
    ALLOWED_ZONE_NAMES,
    _clamp_pct,
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
_DEFAULT_RESOLUTION = {"width": 1920, "height": 1080}

# A sensible starting split so a brand-new video opens with editable zones.
_DEFAULT_ZONES = {
    "sky": {"y_start_pct": 0, "y_end_pct": 55, "description": "Sky / upper area."},
    "ground": {"y_start_pct": 55, "y_end_pct": 100, "description": "Ground where characters stand."},
}


# --- discovery --------------------------------------------------------------

def _video_keys() -> dict[str, str]:
    """Map slug -> object key by scanning the ``live_backgrounds/`` prefix."""
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(LIVE_PREFIX)
    except Exception as exc:
        log.warning("videos: listing %s failed: %r", LIVE_PREFIX, exc)
        return {}
    for key in keys:
        if not key.lower().endswith(VIDEO_EXTS):
            continue
        rel = key[len(LIVE_PREFIX):]
        slug = rel.rsplit(".", 1)[0].replace("/", "__")  # flatten any nesting
        out[slug] = key
    return out


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
    try:
        minio.upload_bytes(
            json.dumps(entry, indent=2).encode("utf-8"),
            key=f"{LIVE_PREFIX}{slug}.json",
            content_type="application/json",
        )
    except Exception as exc:
        log.warning("videos: sidecar upload failed for %s: %r", slug, exc)


# --- gallery catalog --------------------------------------------------------

def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """Same {kind,total,categories} shape the gallery expects, for videos."""
    doc = _read_manifest()
    items: list[dict[str, Any]] = []
    for slug, key in sorted(_video_keys().items()):
        entry = doc.get(slug) if isinstance(doc.get(slug), dict) else {}
        enabled = bool(entry.get("enabled", True))
        if not enabled and not include_disabled:
            continue
        items.append({
            "slug": slug,
            "url": minio.public_url_for_key(key),
            "description": str(entry.get("description") or ""),
            "enabled": enabled,
        })
    categories = [{"name": "live_backgrounds", "count": len(items), "items": items}] if items else []
    return {"kind": "video", "total": len(items), "categories": categories}


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
            "y_start_pct": ys,
            "y_end_pct": ye,
            "description": str(zone.get("description") or ""),
            "polygon": polygon,
            "surface": str(zone.get("surface") or _default_surface(str(name))),
            "color": zone.get("color"),
        })
    zones.sort(key=lambda z: z["y_start_pct"])
    return {
        "slug": slug,
        "manifest_key": key,
        "url": video_url(slug),
        "is_video": True,
        "scene_type": str(entry.get("scene_type") or ""),
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
    width = int(res.get("width") or _DEFAULT_RESOLUTION["width"])
    height = int(res.get("height") or _DEFAULT_RESOLUTION["height"])
    entry.setdefault("resolution", {"width": width, "height": height})

    if payload.get("scene_type") is not None:
        entry["scene_type"] = str(payload["scene_type"])
    if payload.get("description") is not None:
        entry["description"] = str(payload["description"])
    if payload.get("enabled") is not None:
        entry["enabled"] = bool(payload["enabled"])

    zones_in = payload.get("zones")
    if isinstance(zones_in, list):
        new_zones: dict[str, dict[str, Any]] = {}
        for z in zones_in:
            if not isinstance(z, dict):
                continue
            name = str(z.get("name") or "").strip()
            if not name:
                raise ValueError("zone name must not be empty")
            if name in new_zones:
                raise ValueError(f"duplicate zone {name!r}")

            poly_in = z.get("polygon")
            polygon: list[list[float]] | None = None
            if isinstance(poly_in, list):
                pts = [[round(_clampf(p[0]), 2), round(_clampf(p[1]), 2)]
                       for p in poly_in if isinstance(p, (list, tuple)) and len(p) >= 2]
                if len(pts) >= 3:
                    polygon = pts
            if polygon:
                ys = int(round(min(p[1] for p in polygon)))
                ye = int(round(max(p[1] for p in polygon)))
            else:
                ys = _clamp_pct(z.get("y_start_pct"))
                ye = _clamp_pct(z.get("y_end_pct"))
                if ye < ys:
                    ys, ye = ye, ys

            surface = str(z.get("surface") or _default_surface(name))
            if surface not in ALLOWED_SURFACES:
                surface = "none"

            zone_doc: dict[str, Any] = {
                "y_start_pct": ys,
                "y_end_pct": ye,
                "y_start_px": round(ys / 100 * height),
                "y_end_px": round(ye / 100 * height),
                "height_pct": ye - ys,
                "surface": surface,
                "description": str(z.get("description") or ""),
            }
            if polygon:
                zone_doc["polygon"] = polygon
            if z.get("color"):
                zone_doc["color"] = str(z.get("color"))
            new_zones[name] = zone_doc
        entry["zones"] = new_zones

    doc[slug] = entry
    _write_manifest(doc)
    _write_sidecar(slug, entry)
    return editable_entry_for_slug(slug)  # type: ignore[return-value]


def set_config(slug: str, *, enabled: bool | None = None, description: str | None = None) -> dict[str, Any]:
    fields = {k: v for k, v in {"enabled": enabled, "description": description}.items() if v is not None}
    return save_entry_for_slug(slug, fields)
