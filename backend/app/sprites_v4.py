"""Animations v4: the Moonykids cast — every character the story engine's products put on stage.

Like v3 this duplicates NOTHING: each cast member is a v1 character re-presented with its live
animations (see ``sprites_v3.character_item``), so an action added or disabled in the Sprites tab
shows up here too. What v4 adds is the cast itself, grouped by the product that uses it.

The cast is copied from story-engine-v2 (checked 2026-09-18), not read from it — the editor can't
see that repo. Re-check it there when a product gains a character:

    What Happened Today  what_happened_today/avatars.json -> slots[].avatar_ids (the pools every
                         WHT story casts from: hero/sibling, mum, dad, granny, grandpa, pet)
    Bedtime Stories      bedtime/stories/*/template.json -> cast[].avatar_ids
    Grow and Learn       learn/stories/*.json -> authored.cast

Slugs are the LIBRARY's. WHT calls two of them something else — its ``grandma_senior`` is
``woman_senior`` here and its ``grandpa_senior`` is ``man_senior`` (``ALIASES`` in
what_happened_today/animation_setup.py). Characters with no library sprite are left out: bedtime's
dragon is drawn for its one story, and learn's farm animals are SVG objects, not sprites.
"""

from __future__ import annotations

from typing import Any

from app.sprites_v3 import character_item

# Product -> cast, in the order the products are named in the tab's tooltip. A character used by
# more than one product appears under each, so a section is that product's whole cast.
CAST: dict[str, list[str]] = {
    "What Happened Today": [
        # hero + sibling/friend
        "boy_kid", "boy_kid_asian", "boy_kid_black",
        "girl_kid", "girl_kid_asian", "girl_kid_black", "girl_kid_muslim",
        # mum
        "woman_middle_age", "woman_middle_age_asian", "woman_middle_age_black",
        # dad
        "man_adult", "man_adult_asian", "man_adult_black",
        # granny, grandpa
        "woman_senior", "man_senior",
        # pet
        "cat", "dog", "rabbit", "robin",
    ],
    "Bedtime Stories": ["boy_kid"],
    "Grow and Learn": ["squirrel", "clownfish"],
}


def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """Same ``{kind, total, categories}`` shape the gallery expects: one category per product, cast in
    the order above. A cast member with nothing to show (disabled, or no sheets) is left out."""
    categories = []
    for product, slugs in CAST.items():
        items = [
            item for slug in slugs
            if (item := character_item(slug, include_disabled=include_disabled)) is not None
        ]
        if items:
            categories.append({"name": product, "count": len(items), "items": items})
    total = sum(len(c["items"]) for c in categories)
    return {"kind": "animation_v4", "total": total, "categories": categories}
