"""Facade over static_asset_catalog. Exposes typed accessors used by the routes.

Note: unlike the story-gen-exps original, overrides are NOT applied at import
here. `connection.reload_all()` controls when the connected bucket's overrides
are layered on (so `base_snapshot` can capture a pristine pre-apply copy).
"""

from typing import Literal, TypedDict

from app.catalog.static_asset_catalog import (
    BACKGROUND_CATALOG,
    BACKGROUND_CATEGORIES,
    CHARACTER_CATALOG,
    OBJECT_CATALOG,
)


class CharacterEntry(TypedDict):
    kind: Literal["people", "animal", "bird"]
    subcategory: str
    sprite_base_path: str
    animations: list[str]
    animation_urls: dict


def all_character_slugs() -> list[str]:
    return list(CHARACTER_CATALOG.keys())


def all_object_slugs() -> list[str]:
    return list(OBJECT_CATALOG.keys())


def all_background_slugs() -> list[str]:
    return list(BACKGROUND_CATALOG.keys())


def get_character(slug: str) -> CharacterEntry | None:
    return CHARACTER_CATALOG.get(slug)


def get_object_url(slug: str) -> str | None:
    return OBJECT_CATALOG.get(slug)


def get_background_url(slug: str) -> str | None:
    return BACKGROUND_CATALOG.get(slug)


def background_category_of(slug: str) -> str | None:
    """Reverse lookup: background slug → category name."""
    for cat, slugs in BACKGROUND_CATEGORIES.items():
        if slug in slugs:
            return cat
    return None


def object_category_of(slug: str) -> str | None:
    url = OBJECT_CATALOG.get(slug)
    if url is None or "/objects/" not in url:
        return None
    rel = url.split("/objects/", 1)[1]
    parts = rel.split("/")
    if len(parts) < 2:
        return None
    return parts[0]


def character_subcategory_of(slug: str) -> str | None:
    entry = CHARACTER_CATALOG.get(slug)
    if entry is None:
        return None
    return entry.get("subcategory")


def character_kind_of(slug: str) -> str | None:
    entry = CHARACTER_CATALOG.get(slug)
    if entry is None:
        return None
    return entry.get("kind")


def character_animations(slug: str) -> list[str]:
    entry = CHARACTER_CATALOG.get(slug)
    if entry is None:
        return []
    return list(entry.get("animations", []))
