"""Resolve an asset slug + kind to a preview URL (for the gallery + lightbox)."""

from __future__ import annotations

from typing import Optional

from app.catalog.static_asset_catalog import (
    BACKGROUND_CATALOG,
    CHARACTER_CATALOG,
    OBJECT_CATALOG,
)
from app.schemas import AssetKind


def resolve_asset_url(slug: str, kind: AssetKind) -> Optional[str]:
    """Return a `/storage/...` URL for the asset preview, or None if unknown.

    - object/background: direct URL string from catalog.
    - character: prefer the `idle` animation's spritesheet; fall back to any.
    """
    if kind == "object":
        return OBJECT_CATALOG.get(slug)
    if kind == "background":
        return BACKGROUND_CATALOG.get(slug)
    if kind == "character":
        entry = CHARACTER_CATALOG.get(slug)
        if not entry:
            return None
        anims = entry.get("animation_urls", {})
        for preferred in ("idle", "happy", "move"):
            url = _spritesheet_url(anims.get(preferred))
            if url:
                return url
        for v in anims.values():
            url = _spritesheet_url(v)
            if url:
                return url
        return None
    return None


def _spritesheet_url(v) -> Optional[str]:
    if isinstance(v, dict):
        return v.get("spritesheet")
    if isinstance(v, str):
        return v
    return None
