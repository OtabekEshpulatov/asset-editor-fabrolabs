"""Background manifest helpers for engine v4.

The manifest is generated from the background image library and describes each
background's scene type, short visual description, zones, and safe placement
rectangles. V4 keeps this as code-visible context so LLM agents do not have to
guess what a slug such as ``nature_forest_day`` actually looks like.
"""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

from app import config, stage
from app.schemas import AssetKind
from app.catalog import catalog, overrides
from app.storage import json_store

log = logging.getLogger(__name__)

MANIFEST_PATH = config.MANIFEST_LOCAL_PATH
# Canonical copy lives in MinIO; MANIFEST_PATH is the seed + offline fallback.
MANIFEST_OBJECT_KEY = "manifests/backgrounds_manifest.json"
BACKGROUND_STORAGE_PREFIX = "/storage/fairytale-assets/backgrounds/"


def _dump_manifest(doc: Any) -> bytes:
    # Match the on-disk format: indent=2, ensure_ascii=True, no trailing newline.
    return json.dumps(doc, indent=2).encode("utf-8")

_SCREEN_ZONE_FRACTIONS = {
    "left_edge": 0.08,
    "left_third": 0.28,
    "center": 0.50,
    "right_third": 0.72,
    "right_edge": 0.92,
}
_DEPTH_FRACTIONS = {
    "background": 0.15,
    "midground": 0.50,
    "foreground": 0.85,
}
_PLACEMENT_MARGIN_X_PCT = 5.0
_GROUND_ZONE_NAMES = {"ground"}

# Zone names the renderer/validator understand (mirrors schemas.shot.PlacementZone).
# These are offered as quick-pick PRESETS in the editor, but zone names are now
# free-form so the artist can name regions meaningfully (e.g. "river", "left_shelf").
ALLOWED_ZONE_NAMES = {
    "ground",
    "sky",
    "water",
    "surface",
    "walls",
    "ceiling",
    "mid",
    "foreground",
    "buildings",
    "space",
}

# Placement surface a zone offers — same vocabulary as object `rest_surface`, so
# the renderer can drop a rest_surface=tabletop prop into a zone tagged tabletop.
ALLOWED_SURFACES = ["floor", "water", "wall", "sky", "tabletop", "decor", "none"]

# Sensible default surface inferred from a preset zone name (for migration).
_SURFACE_BY_ZONE = {
    "ground": "floor",
    "water": "water",
    "surface": "water",
    "sky": "sky",
    "space": "sky",
    "walls": "wall",
    "ceiling": "none",
    "mid": "decor",
    "foreground": "decor",
    "buildings": "decor",
}


def _default_surface(name: str) -> str:
    return _SURFACE_BY_ZONE.get(name, "none")


def _clampf(value: Any) -> float:
    return min(100.0, max(0.0, _num(value, 0.0)))


def _clamp_to_stage(x: float, y: float) -> tuple[float, float]:
    """Pin (x, y) inside the renderer's stage envelope (see `config`).

    Some manifest entries reach y=100 (ground extends to the bottom of the
    frame) which combined with the foreground depth fraction produces y > 96
    — beyond `STAGE_MAX_Y` — and crashes the renderer's pre-flight check.
    Clamping here means engine_v4 never emits a coordinate the renderer
    will reject.
    """
    cx = min(stage.STAGE_MAX_X, max(stage.STAGE_MIN_X, x))
    cy = min(stage.STAGE_MAX_Y, max(stage.STAGE_MIN_Y, y))
    return round(cx, 2), round(cy, 2)


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, dict[str, Any]]:
    config.seed_if_missing(MANIFEST_PATH, "backgrounds_manifest.json")
    raw = json_store.read_json(key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_PATH)
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in raw.items() if isinstance(value, dict)}


def _read_manifest_doc() -> dict[str, Any]:
    """Fresh canonical read (uncached) for read-modify-write operations."""
    config.seed_if_missing(MANIFEST_PATH, "backgrounds_manifest.json")
    raw = json_store.read_json(key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_PATH)
    return raw if isinstance(raw, dict) else {}


def manifest_key_for_slug(slug: str) -> str | None:
    """Resolve a V4 background slug to the manifest key.

    V4 uses slugs such as ``nature_forest_day``. The manifest is keyed by the
    storage suffix, for example ``nature/nature_forest_day.png``.
    """
    manifest = load_manifest()
    if not manifest:
        return None

    url = catalog.get_background_url(slug) or ""
    if url:
        clean = url.split("?", 1)[0]
        if BACKGROUND_STORAGE_PREFIX in clean:
            key = clean.split(BACKGROUND_STORAGE_PREFIX, 1)[1].lstrip("/")
            if key in manifest:
                return key

    filename = f"{slug}.png"
    matches = [key for key in manifest if key.endswith(f"/{filename}") or key == filename]
    if matches:
        return sorted(matches)[0]
    return None


def entry_for_slug(slug: str) -> dict[str, Any] | None:
    key = manifest_key_for_slug(slug)
    if key is None:
        return None
    return load_manifest().get(key)


def compact_context_for_slug(slug: str) -> dict[str, Any] | None:
    """Return compact, prompt-safe background context for a locked setting."""
    key = manifest_key_for_slug(slug)
    entry = load_manifest().get(key or "")
    if not entry:
        return None
    return {
        "slug": slug,
        "manifest_key": key,
        "scene_type": entry.get("scene_type"),
        "description": entry.get("description"),
        "zones": _compact_zones(entry.get("zones")),
        "placement_zones": _compact_placement_zones(entry.get("zones")),
        "character_placement": _compact_placement(entry.get("character_placement")),
        "object_placement": _compact_placement(entry.get("object_placement")),
    }


def search_context_for_slug(slug: str) -> dict[str, Any] | None:
    """Short metadata suitable for asset-search results."""
    entry = entry_for_slug(slug)
    if not entry:
        return None
    return {
        "scene_type": entry.get("scene_type"),
        "description": entry.get("description"),
        "placement_zones": sorted((entry.get("zones") or {}).keys()),
        "placement_note": _trim_text(
            str((entry.get("character_placement") or {}).get("note") or ""),
            160,
        ),
    }


def locked_background_context(locks: dict[str, str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item_id, slug in locks.items():
        if catalog.get_background_url(slug) is None:
            continue
        context = compact_context_for_slug(slug)
        if context:
            out[item_id] = context
    return out


def inventory_scene_type_lines(max_examples: int = 3) -> list[str]:
    manifest = load_manifest()
    if not manifest:
        return []
    counts = Counter(str(entry.get("scene_type") or "unknown") for entry in manifest.values())
    examples_by_type: dict[str, list[str]] = defaultdict(list)
    for key, entry in manifest.items():
        scene_type = str(entry.get("scene_type") or "unknown")
        if len(examples_by_type[scene_type]) >= max_examples:
            continue
        slug = Path(key).stem
        description = _trim_text(str(entry.get("description") or ""), 80)
        examples_by_type[scene_type].append(f"{slug} ({description})")

    lines = ["background_scene_types:"]
    for scene_type, count in sorted(counts.items()):
        examples = "; ".join(examples_by_type.get(scene_type, []))
        lines.append(f"  {scene_type}: {count} examples: {examples}")
    return lines


def position_for_slug(
    slug: str,
    *,
    screen_zone: str,
    depth: str,
    asset_kind: AssetKind,
    fallback: tuple[float, float],
    placement_zone: str | None = None,
) -> tuple[float, float]:
    """Map V4 screen zone/depth into the manifest's safe placement area."""
    entry = entry_for_slug(slug)
    if not entry:
        return _clamp_to_stage(*fallback)
    if placement_zone and placement_zone not in _GROUND_ZONE_NAMES:
        zone_position = _position_in_manifest_zone(entry, placement_zone, screen_zone, depth)
        if zone_position is not None:
            return zone_position

    placement_name = "object_placement" if asset_kind == "object" else "character_placement"
    placement = entry.get(placement_name)
    if not isinstance(placement, dict):
        return _clamp_to_stage(*fallback)

    try:
        x_min = float(placement.get("x_min_pct"))
        x_max = float(placement.get("x_max_pct"))
        y_min = float(placement.get("y_min_pct"))
        y_max = float(placement.get("y_max_pct"))
    except (TypeError, ValueError):
        return _clamp_to_stage(*fallback)

    x_fraction = _SCREEN_ZONE_FRACTIONS.get(screen_zone)
    y_fraction = _DEPTH_FRACTIONS.get(depth)
    if x_fraction is None or y_fraction is None:
        return _clamp_to_stage(*fallback)
    x = x_min + (x_max - x_min) * x_fraction
    y = y_min + (y_max - y_min) * y_fraction
    return _clamp_to_stage(x, y)


def zone_names_for_slug(slug: str) -> set[str]:
    entry = entry_for_slug(slug)
    zones = entry.get("zones") if entry else None
    if not isinstance(zones, dict):
        return set()
    return {str(name) for name in zones}


def _position_in_manifest_zone(
    entry: dict[str, Any],
    placement_zone: str,
    screen_zone: str,
    depth: str,
) -> tuple[float, float] | None:
    zones = entry.get("zones")
    if not isinstance(zones, dict):
        return None
    zone = zones.get(placement_zone)
    if not isinstance(zone, dict):
        return None
    x_fraction = _SCREEN_ZONE_FRACTIONS.get(screen_zone)
    y_fraction = _DEPTH_FRACTIONS.get(depth)
    if x_fraction is None or y_fraction is None:
        return None
    try:
        y_min = float(zone.get("y_start_pct"))
        y_max = float(zone.get("y_end_pct"))
    except (TypeError, ValueError):
        return None
    x_min = _PLACEMENT_MARGIN_X_PCT
    x_max = 100.0 - _PLACEMENT_MARGIN_X_PCT
    x = x_min + (x_max - x_min) * x_fraction
    y = y_min + (y_max - y_min) * y_fraction
    return _clamp_to_stage(x, y)


def _compact_zones(zones: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(zones, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, zone in zones.items():
        if not isinstance(zone, dict):
            continue
        out[str(name)] = {
            "y_pct": [zone.get("y_start_pct"), zone.get("y_end_pct")],
            "description": _trim_text(str(zone.get("description") or ""), 180),
        }
    return out


def _compact_placement_zones(zones: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(zones, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, zone in zones.items():
        if not isinstance(zone, dict):
            continue
        out[str(name)] = {
            "x_pct": [_PLACEMENT_MARGIN_X_PCT, 100.0 - _PLACEMENT_MARGIN_X_PCT],
            "y_pct": [zone.get("y_start_pct"), zone.get("y_end_pct")],
            "note": _trim_text(str(zone.get("description") or ""), 180),
        }
    return out


def _compact_placement(placement: Any) -> dict[str, Any]:
    if not isinstance(placement, dict):
        return {}
    return {
        "x_pct": [placement.get("x_min_pct"), placement.get("x_max_pct")],
        "y_pct": [placement.get("y_min_pct"), placement.get("y_max_pct")],
        "note": _trim_text(str(placement.get("note") or ""), 180),
    }


def _trim_text(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "..."


# ---------------------------------------------------------------------------
# Zone editor: read a fully-editable view of an entry and write edits back to
# the manifest JSON (the renderer's source of truth). Zones are full-width
# horizontal bands (y-only); character/object placements are rectangles.
# ---------------------------------------------------------------------------

_DEFAULT_RESOLUTION = {"width": 1920, "height": 1080}


def editable_entry_for_slug(slug: str) -> dict[str, Any] | None:
    """Full, round-trippable view of a background entry for the zone editor."""
    key = manifest_key_for_slug(slug)
    entry = load_manifest().get(key or "")
    if not entry:
        return None
    res = entry.get("resolution") if isinstance(entry.get("resolution"), dict) else {}
    zones = []
    for name, zone in (entry.get("zones") or {}).items():
        if not isinstance(zone, dict):
            continue
        ys = _num(zone.get("y_start_pct"), 0)
        ye = _num(zone.get("y_end_pct"), 0)
        poly = zone.get("polygon")
        if not (isinstance(poly, list) and len(poly) >= 3):
            # migrate a legacy band into a full-width rectangle polygon
            poly = [[0.0, ys], [100.0, ys], [100.0, ye], [0.0, ye]]
        polygon = [[_clampf(p[0]), _clampf(p[1])] for p in poly
                   if isinstance(p, (list, tuple)) and len(p) >= 2]
        zones.append(
            {
                "name": str(name),
                "y_start_pct": ys,
                "y_end_pct": ye,
                "description": str(zone.get("description") or ""),
                "polygon": polygon,
                "surface": str(zone.get("surface") or _default_surface(str(name))),
                "color": zone.get("color"),
            }
        )
    # Fold the legacy fixed placement rectangles into ordinary (deletable) zones,
    # so the editor has a single uniform model: N named polygon zones, nothing pinned.
    taken = {z["name"] for z in zones}
    for box_key, base, surf, default_desc in (
        ("character_placement", "walkable", "floor", "where characters stand / walk"),
        ("object_placement", "object_area", "floor", "where props can be placed"),
    ):
        box = entry.get(box_key)
        if not isinstance(box, dict):
            continue
        name = base
        n = 1
        while name in taken:
            name = f"{base}_{n}"
            n += 1
        taken.add(name)
        x0, x1 = _clampf(box.get("x_min_pct")), _clampf(box.get("x_max_pct"))
        y0, y1 = _clampf(box.get("y_min_pct")), _clampf(box.get("y_max_pct"))
        zones.append(
            {
                "name": name,
                "y_start_pct": y0,
                "y_end_pct": y1,
                "description": str(box.get("note") or default_desc),
                "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "surface": surf,
            }
        )
    zones.sort(key=lambda z: z["y_start_pct"])
    return {
        "slug": slug,
        "manifest_key": key,
        "url": catalog.get_background_url(slug),
        "scene_type": str(entry.get("scene_type") or ""),
        "description": str(entry.get("description") or ""),
        "resolution": {
            "width": int(res.get("width") or _DEFAULT_RESOLUTION["width"]),
            "height": int(res.get("height") or _DEFAULT_RESOLUTION["height"]),
        },
        "allowed_zone_names": sorted(ALLOWED_ZONE_NAMES),
        "allowed_surfaces": ALLOWED_SURFACES,
        "enabled": overrides.is_enabled("background", slug),
        "zones": zones,
    }


def _editable_placement(placement: Any) -> dict[str, Any]:
    p = placement if isinstance(placement, dict) else {}
    return {
        "x_min_pct": _num(p.get("x_min_pct"), 0),
        "x_max_pct": _num(p.get("x_max_pct"), 100),
        "y_min_pct": _num(p.get("y_min_pct"), 0),
        "y_max_pct": _num(p.get("y_max_pct"), 100),
        "note": str(p.get("note") or ""),
    }


def save_entry_for_slug(slug: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Apply editor changes to one entry and write the manifest back to disk.

    Raises KeyError if the slug has no manifest entry, ValueError on invalid
    zone names / duplicates. Derived pixel fields and `height_pct` are
    recomputed from the percentages so the file stays internally consistent.
    """
    key = manifest_key_for_slug(slug)
    if key is None:
        raise KeyError(slug)

    raw = _read_manifest_doc()
    entry = raw.get(key)
    if not isinstance(entry, dict):
        raise KeyError(slug)

    res = entry.get("resolution") if isinstance(entry.get("resolution"), dict) else {}
    width = int(res.get("width") or _DEFAULT_RESOLUTION["width"])
    height = int(res.get("height") or _DEFAULT_RESOLUTION["height"])

    if payload.get("scene_type") is not None:
        entry["scene_type"] = str(payload["scene_type"])
    if payload.get("description") is not None:
        entry["description"] = str(payload["description"])

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

            # Polygon (if present) is authoritative; derive the y-band from it so
            # band-based consumers keep working. Else fall back to the y fields.
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
            color = z.get("color")
            if color:
                zone_doc["color"] = str(color)
            new_zones[name] = zone_doc
        entry["zones"] = new_zones

    # Placement boxes are deprecated — they now live as ordinary zones. Update
    # them only if a legacy client still sends a dict; otherwise drop them so the
    # manifest converges on the uniform zones-only model.
    for box_key in ("character_placement", "object_placement"):
        val = payload.get(box_key)
        if isinstance(val, dict):
            entry[box_key] = _placement_to_manifest(val, entry.get(box_key), width, height)
        else:
            entry.pop(box_key, None)

    raw[key] = entry
    json_store.write_json(raw, key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_PATH, dumps=_dump_manifest)
    _write_background_sidecar(key, entry)
    load_manifest.cache_clear()
    return editable_entry_for_slug(slug)  # type: ignore[return-value]


def sidecar_key_for_manifest_key(manifest_key: str) -> str:
    """`{cat}/{slug}.png` -> `backgrounds/{cat}/{slug}.json` (co-located config)."""
    return "backgrounds/" + manifest_key.rsplit(".", 1)[0] + ".json"


def backfill_sidecars() -> int:
    """Write a per-background config sidecar for every entry in the current index.

    One-time migration so each background's config is co-located in MinIO. Safe
    to re-run (idempotent overwrite).
    """
    manifest = load_manifest()
    count = 0
    for key, entry in manifest.items():
        _write_background_sidecar(key, entry)
        count += 1
    return count


def rebuild_index_from_sidecars() -> int:
    """Regenerate the aggregate index by scanning the per-background sidecars.

    Makes the per-file sidecars the true source: the index can always be
    rebuilt from them, so the monolithic manifest is no longer hand-maintained.
    """
    from app.storage import minio

    index: dict[str, Any] = {}
    for sk in minio.list_objects("backgrounds/"):
        if not sk.endswith(".json"):
            continue
        data = minio.download_bytes(sk)
        if not data:
            continue
        try:
            entry = json.loads(data)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        rel = sk[len("backgrounds/"):]  # {cat}/{slug}.json
        manifest_key = rel.rsplit(".", 1)[0] + ".png"
        index[manifest_key] = entry
    if index:
        json_store.write_json(
            index, key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_PATH, dumps=_dump_manifest
        )
        load_manifest.cache_clear()
    return len(index)


def _write_background_sidecar(manifest_key: str, entry: dict[str, Any]) -> None:
    """Write the per-background config sidecar (the co-located source of truth).

    Best-effort: the aggregate index already holds the data, so a sidecar upload
    failure must not fail the edit.
    """
    from app.storage import minio

    try:
        minio.upload_bytes(
            json.dumps(entry, indent=2).encode("utf-8"),
            key=sidecar_key_for_manifest_key(manifest_key),
            content_type="application/json",
        )
    except Exception as exc:
        log.warning("background sidecar upload failed for %s: %r", manifest_key, exc)


def create_manifest_entry(
    *,
    category: str,
    slug: str,
    scene_type: str = "",
    description: str = "",
    width: int = 1920,
    height: int = 1080,
) -> str:
    """Seed a default manifest entry for a newly-added background.

    Returns the manifest key. Default zones are a generic sky/ground split the
    user can refine in the zone editor. No-op-safe: if the key already exists it
    is left untouched.
    """
    key = f"{category}/{slug}.png"
    raw = _read_manifest_doc()
    if key in raw:
        return key

    def _band(y0: int, y1: int, desc: str) -> dict[str, Any]:
        return {
            "y_start_pct": y0,
            "y_end_pct": y1,
            "y_start_px": round(y0 / 100 * height),
            "y_end_px": round(y1 / 100 * height),
            "height_pct": y1 - y0,
            "description": desc,
        }

    raw[key] = {
        "scene_type": scene_type or "custom",
        "description": description,
        "resolution": {"width": width, "height": height},
        "zones": {
            "sky": _band(0, 55, "Sky / upper area."),
            "ground": _band(55, 100, "Ground surface where characters stand."),
        },
        "character_placement": _placement_to_manifest(
            {"x_min_pct": 5, "x_max_pct": 95, "y_min_pct": 60, "y_max_pct": 95, "note": ""},
            None,
            width,
            height,
        ),
        "object_placement": _placement_to_manifest(
            {"x_min_pct": 0, "x_max_pct": 100, "y_min_pct": 60, "y_max_pct": 95, "note": ""},
            None,
            width,
            height,
        ),
    }
    json_store.write_json(raw, key=MANIFEST_OBJECT_KEY, local_path=MANIFEST_PATH, dumps=_dump_manifest)
    _write_background_sidecar(key, raw[key])
    load_manifest.cache_clear()
    return key


def _placement_to_manifest(
    placement: dict[str, Any], existing: Any, width: int, height: int
) -> dict[str, Any]:
    prev = existing if isinstance(existing, dict) else {}
    x_min = _clamp_pct(placement.get("x_min_pct"))
    x_max = _clamp_pct(placement.get("x_max_pct"))
    y_min = _clamp_pct(placement.get("y_min_pct"))
    y_max = _clamp_pct(placement.get("y_max_pct"))
    if x_max < x_min:
        x_min, x_max = x_max, x_min
    if y_max < y_min:
        y_min, y_max = y_max, y_min
    note = placement.get("note")
    return {
        "x_min_pct": x_min,
        "x_max_pct": x_max,
        "y_min_pct": y_min,
        "y_max_pct": y_max,
        "x_min_px": round(x_min / 100 * width),
        "x_max_px": round(x_max / 100 * width),
        "y_min_px": round(y_min / 100 * height),
        "y_max_px": round(y_max / 100 * height),
        "note": str(note if note is not None else prev.get("note") or ""),
    }


def _num(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _clamp_pct(value: Any) -> int:
    n = _num(value, 0)
    return int(round(min(100.0, max(0.0, n))))
