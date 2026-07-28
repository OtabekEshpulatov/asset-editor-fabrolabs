import type { AssetKind, AssetQuery } from '@/lib/data';

/**
 * One place that names every cache entry, so invalidation after a mutation is
 * a lookup rather than a guess. The old app invalidated `['asset-catalog']` by
 * hand from three different components.
 */
export const qk = {
  kindCounts: () => ['kind-counts'] as const,
  facets: (kind: AssetKind) => ['facets', kind] as const,
  assets: (q: Omit<AssetQuery, 'cursor'>) =>
    ['assets', q.kind, q.category ?? 'all', q.q ?? '', q.enabled ?? 'all', q.limit ?? 0] as const,
  asset: (kind: AssetKind, slug: string) => ['asset', kind, slug] as const,
  search: (q: string) => ['search', q] as const,
  backgroundDoc: (slug: string) => ['background-doc', slug] as const,
  movers: (slug: string) => ['movers', slug] as const,
  moverPalette: () => ['mover-palette'] as const,
  transitions: (slug: string) => ['transitions', slug] as const,
  worlds: () => ['worlds'] as const,
  worldGraph: (worldId: string) => ['world-graph', worldId] as const,
};

/** Every cache entry that can show an asset's name/enabled/rev. */
export const assetTouchingKeys = ['assets', 'asset', 'search', 'kind-counts', 'facets'];
