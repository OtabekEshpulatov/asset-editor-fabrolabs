"""Cache invalidation hook.

In story-gen-exps this dropped the search-embedding cache after every asset
mutation. The standalone editor has no semantic search, so the only live cache
that depends on catalog contents is the background manifest. Adds/renames never
touch the manifest, but keeping a single invalidation seam means the
asset-admin call sites stay identical to the source.
"""

from __future__ import annotations


def invalidate() -> None:
    # No-op today (no embedding cache). Background-manifest edits clear their own
    # lru_cache inside backgrounds.py. Kept as the seam asset_admin calls.
    return
