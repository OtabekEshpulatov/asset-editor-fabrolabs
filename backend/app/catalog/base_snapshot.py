"""Pristine snapshot of the generated base catalog, for reset-on-bucket-switch.

The catalog dicts in `static_asset_catalog` are mutated in place by
`overrides.apply()` (user adds, renames, action additions). When the user
switches to a different bucket we must drop the previous bucket's overrides
before layering the new ones. This module deep-copies the dicts at import — i.e.
before any `apply()` runs — and `restore()` repopulates the live dicts in place
(every other module holds references to these same dict objects).
"""

from __future__ import annotations

from copy import deepcopy

from app.catalog.static_asset_catalog import (
    BACKGROUND_CATALOG,
    BACKGROUND_CATEGORIES,
    CHARACTER_CATALOG,
    CHARACTER_CATEGORIES,
    OBJECT_CATALOG,
    OBJECT_CATEGORIES,
)

# Live dict -> pristine deep copy. Captured once, at import (pre-apply).
_LIVE = (
    CHARACTER_CATALOG,
    OBJECT_CATALOG,
    BACKGROUND_CATALOG,
    CHARACTER_CATEGORIES,
    OBJECT_CATEGORIES,
    BACKGROUND_CATEGORIES,
)
_PRISTINE = tuple(deepcopy(d) for d in _LIVE)


def restore() -> None:
    """Reset every live catalog dict to its pristine base contents, in place."""
    for live, pristine in zip(_LIVE, _PRISTINE):
        live.clear()
        live.update(deepcopy(pristine))
