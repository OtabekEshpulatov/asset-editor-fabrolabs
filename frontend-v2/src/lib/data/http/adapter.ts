/**
 * The real backend, behind the same DataAdapter contract as the mock.
 *
 * This talks to the EXISTING /api/v4 — the API the current editor uses — so the
 * new UI runs against the real library today, without touching the backend. The
 * plan's /api/v5 read layer replaces the compatibility shims marked below; when
 * it lands, only this file changes.
 *
 * WHAT v4 CANNOT DO YET, and how this copes:
 *
 *  - No pagination. `/assets/catalog` returns every item of a kind grouped by
 *    category (501 KB for sprites). The catalog is fetched once, cached, and
 *    paged CLIENT-side so the virtualized grid still holds a bounded DOM. The
 *    network cost is unchanged — that is a server fix, not a client one.
 *  - No facet endpoint. Category counts are derived from the same cached
 *    catalog rather than a second round trip.
 *  - No thumbnails. Cards fall back to the full-resolution asset, so the grid
 *    downloads real sheets again. This is the single biggest reason phase 2
 *    exists; see THUMBNAIL NOTE below.
 */

import type {
  ActionDetail,
  AssetDetail,
  AssetItem,
  AssetKind,
  AssetQuery,
  BackgroundDoc,
  BgTransition,
  BgZone,
  DataAdapter,
  Facet,
  ImageTransform,
  Page,
  PaletteAsset,
  RelationRoute,
  RenderJob,
  SaveMoversBody,
  VideoMovers,
  WorldGraph,
} from '../types';
import { ASSET_KINDS } from '../types';
import { V4, api } from './client';

const DEFAULT_LIMIT = 60;

// --- v4 wire shapes ----------------------------------------------------------

interface V4Item {
  slug: string;
  url: string | null;
  description?: string;
  enabled?: boolean;
  rev?: number;
  animation_urls?: Record<string, string>;
  action_fps?: Record<string, number>;
  action_rev?: Record<string, number>;
  progress?: { done: number; total: number; status: string };
}

interface V4Catalog {
  kind: AssetKind;
  total: number;
  categories: { name: string; count: number; items: V4Item[] }[];
}

interface V4Action {
  name: string;
  spritesheet: string | null;
  enabled: boolean;
  fps: number;
  frame_count: number;
  description: string;
  is_3q?: boolean;
  rev: number;
}

/**
 * THUMBNAIL NOTE: v4 ships no derived thumbnails, so a grid card has nothing
 * small to render and falls back to the full asset. For sprites that is a sheet
 * of up to 4.4 MB. The card still only decodes what the browser must, and the
 * grid is virtualized so the count is bounded — but this is the cost phase 2's
 * thumbnail service removes, and it is visible today. Left explicit rather than
 * hidden behind a shrug.
 */
const SHEET_KINDS = new Set<AssetKind>(['character', 'animation', 'animation_v3']);

function toItem(kind: AssetKind, category: string, raw: V4Item): AssetItem {
  const actions = raw.animation_urls ? Object.keys(raw.animation_urls).sort() : undefined;
  return {
    slug: raw.slug,
    kind,
    category,
    thumb: raw.url,
    strip: null,
    thumbIsSheet: SHEET_KINDS.has(kind),
    media: raw.url,
    enabled: raw.enabled ?? true,
    rev: raw.rev ?? 0,
    description: raw.description ?? '',
    actions,
    progress: raw.progress ?? null,
    storage_key: raw.url ? raw.url.replace(/^\/storage\/[^/]+\//, '') : null,
  };
}

/**
 * One in-flight fetch per kind, cached.
 *
 * Without this, the sidebar's facet call and the grid's first page would each
 * pull the whole 501 KB catalog, and every category switch would pull it again.
 * React Query caches per query key; this dedupes BELOW that, across the
 * different query keys that all need the same underlying response.
 */
const catalogCache = new Map<string, Promise<V4Catalog>>();

function fetchCatalog(kind: AssetKind, includeDisabled: boolean): Promise<V4Catalog> {
  const key = `${kind}:${includeDisabled}`;
  let hit = catalogCache.get(key);
  if (!hit) {
    hit = api
      .get<V4Catalog>(
        `${V4}/assets/catalog?kind=${kind}${includeDisabled ? '&include_disabled=true' : ''}`,
      )
      .catch((err) => {
        catalogCache.delete(key); // never cache a failure
        throw err;
      });
    catalogCache.set(key, hit);
  }
  return hit;
}

/** Called after any mutation — the next read must see the change. */
function invalidateCatalogs(): void {
  catalogCache.clear();
}

async function flatItems(kind: AssetKind, includeDisabled: boolean): Promise<AssetItem[]> {
  const cat = await fetchCatalog(kind, includeDisabled);
  return cat.categories.flatMap((c) => c.items.map((i) => toItem(kind, c.name, i)));
}

function matches(item: AssetItem, query: AssetQuery): boolean {
  if (query.category && query.category !== 'all' && item.category !== query.category) return false;
  if (query.enabled === 'enabled' && !item.enabled) return false;
  if (query.enabled === 'disabled' && item.enabled) return false;
  const q = query.q?.trim().toLowerCase();
  if (q && !item.slug.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) {
    return false;
  }
  return true;
}

const encodeCursor = (offset: number) => btoa(String(offset));
const decodeCursor = (cursor?: string | null) => {
  if (!cursor) return 0;
  const n = Number(atob(cursor));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * For a live scene v4 returns the mp4 itself as `url`, but every still view —
 * zones, transitions, the object layer — draws that backdrop into an <img>,
 * where an mp4 renders as nothing. The backend already extracts and caches a
 * first-frame JPEG for exactly this; point stills at it.
 *
 * (The current editor does the same thing, for the same reason: streaming the
 * whole multi-megabyte mp4 just to show frame 1 made those pages take 20+s.)
 */
function toBackgroundDoc(raw: BackgroundDoc): BackgroundDoc {
  const url = raw.is_video ? `${V4}/videos/${encodeURIComponent(raw.slug)}/poster` : raw.url;
  return { ...raw, url, zones: (raw.zones ?? []).map((z) => ({ ...z })) };
}

export const httpAdapter: DataAdapter = {
  name: 'http',

  async listAssets(query) {
    // include_disabled must be on whenever disabled items could be shown,
    // otherwise the backend filters them out before we ever see them.
    const includeDisabled = query.enabled !== 'enabled';
    const all = (await flatItems(query.kind, includeDisabled)).filter((i) => matches(i, query));
    const offset = decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const slice = all.slice(offset, offset + limit);
    const next = offset + slice.length;
    const page: Page<AssetItem> = {
      items: slice,
      nextCursor: next < all.length ? encodeCursor(next) : null,
      total: all.length,
    };
    return page;
  },

  async facets(kind) {
    const cat = await fetchCatalog(kind, true);
    const out: Facet[] = cat.categories
      .map((c) => ({ name: c.name, count: c.items.length }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return out;
  },

  async kindCounts() {
    const out = {} as Record<AssetKind, number>;
    // Sequential on purpose: several of these hit uncached bucket listings on
    // the backend, and firing eleven at once starves its two workers.
    for (const kind of ASSET_KINDS) {
      try {
        const cat = await fetchCatalog(kind, true);
        out[kind] = cat.total ?? cat.categories.reduce((n, c) => n + c.items.length, 0);
      } catch {
        out[kind] = 0; // a kind whose bucket prefix is empty or failing
      }
    }
    return out;
  },

  async searchAll(q, limit = 30) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out: AssetItem[] = [];
    for (const kind of ASSET_KINDS) {
      let items: AssetItem[];
      try {
        items = await flatItems(kind, true);
      } catch {
        continue;
      }
      for (const item of items) {
        if (item.slug.toLowerCase().includes(needle)) {
          out.push(item);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  },

  async getAsset(kind, slug) {
    const items = await flatItems(kind, true);
    const item = items.find((i) => i.slug === slug);
    if (!item) throw new Error(`no ${kind} ${slug}`);

    // Only character-like kinds have a per-action endpoint.
    if (kind !== 'character' && kind !== 'animation' && kind !== 'animation_v3') {
      return { ...item, actionDetails: [] } as AssetDetail;
    }
    const payload = await api.get<{ actions: V4Action[]; description: string; enabled: boolean }>(
      `${V4}/assets/characters/${encodeURIComponent(slug)}/actions`,
    );
    const actionDetails: ActionDetail[] = payload.actions.map((a) => ({
      name: a.name,
      spritesheet: a.spritesheet,
      strip: null,
      enabled: a.enabled,
      fps: a.fps,
      frameCount: a.frame_count,
      description: a.description,
      rev: a.rev,
      is3q: !!a.is_3q,
    }));
    return {
      ...item,
      description: payload.description ?? item.description,
      enabled: payload.enabled ?? item.enabled,
      actions: actionDetails.map((a) => a.name),
      actionDetails,
    };
  },

  async setAssetConfig(kind, slug, fields) {
    await api.put(`${V4}/assets/config`, { kind, slug, ...fields });
    invalidateCatalogs();
    const items = await flatItems(kind, true);
    const item = items.find((i) => i.slug === slug);
    if (!item) throw new Error(`no ${kind} ${slug}`);
    return item;
  },

  async renameAsset(kind, oldSlug, newSlug) {
    await api.post(`${V4}/assets/rename`, { kind, old_slug: oldSlug, new_slug: newSlug });
    invalidateCatalogs();
    const items = await flatItems(kind, true);
    const item = items.find((i) => i.slug === newSlug);
    if (!item) throw new Error(`renamed, but ${newSlug} did not come back from the catalog`);
    return item;
  },

  async transformAsset(kind, slug, t: ImageTransform) {
    const res = await api.post<{ rev?: number }>(`${V4}/assets/transform`, { kind, slug, ...t });
    invalidateCatalogs();
    return { rev: res.rev ?? 0 };
  },

  async setActionConfig(slug, action, fields) {
    await api.put(`${V4}/assets/actions/config`, {
      slug,
      action,
      enabled: fields.enabled,
      description: fields.description,
      fps: fields.fps,
      is_3q: fields.is3q,
    });
    invalidateCatalogs();
    return readAction(slug, action);
  },

  async renameAction(slug, oldName, newName) {
    await api.post(`${V4}/assets/actions/rename`, { slug, old: oldName, new: newName });
    invalidateCatalogs();
    return readAction(slug, newName);
  },

  async mirrorAction(slug, source) {
    const res = await api.post<{ action?: string; name?: string }>(`${V4}/assets/actions/mirror`, {
      slug,
      source,
    });
    invalidateCatalogs();
    return readAction(slug, res.action ?? res.name ?? source);
  },

  async deleteAction(slug, action) {
    await api.del(
      `${V4}/assets/characters/${encodeURIComponent(slug)}/actions/${encodeURIComponent(action)}`,
    );
    invalidateCatalogs();
  },

  async transformAction(slug, action, t: ImageTransform) {
    const res = await api.post<{ rev: number }>(`${V4}/assets/actions/transform`, {
      slug,
      action,
      ...t,
    });
    invalidateCatalogs();
    return { rev: res.rev };
  },

  async reorderFrames(slug, action, order) {
    const res = await api.post<{ rev: number; frame_count: number }>(
      `${V4}/assets/actions/frames/reorder`,
      { slug, action, order },
    );
    invalidateCatalogs();
    return { rev: res.rev, frameCount: res.frame_count };
  },

  async getBackgroundDoc(slug) {
    // A slug is either a still background or a live scene; the routes differ and
    // nothing up front says which, so try the video route and fall back.
    try {
      return toBackgroundDoc(await api.get<BackgroundDoc>(`${V4}/videos/${encodeURIComponent(slug)}`));
    } catch {
      return toBackgroundDoc(
        await api.get<BackgroundDoc>(`${V4}/backgrounds/${encodeURIComponent(slug)}`),
      );
    }
  },

  async saveBackgroundDoc(slug, body) {
    const zones = body.zones.map(({ _uid: _drop, ...z }) => z as BgZone);
    try {
      const saved = await api.put<BackgroundDoc>(`${V4}/videos/${encodeURIComponent(slug)}`, {
        description: body.description,
        zones,
      });
      invalidateCatalogs();
      return toBackgroundDoc(saved);
    } catch {
      const saved = await api.put<BackgroundDoc>(`${V4}/backgrounds/${encodeURIComponent(slug)}`, {
        description: body.description,
        zones,
      });
      invalidateCatalogs();
      return toBackgroundDoc(saved);
    }
  },

  async getMovers(slug) {
    return api.get<VideoMovers>(`${V4}/videos/${encodeURIComponent(slug)}/movers`);
  },

  async listMoverPalette() {
    // The endpoint is scoped to a slug server-side but returns the cross-bundle
    // union, so any slug answers; use a harmless placeholder.
    return api.get<PaletteAsset[]>(`${V4}/videos/_/movers/palette`);
  },

  async saveMovers(slug, body: SaveMoversBody, onProgress) {
    // The real endpoint re-renders an mp4 with ffmpeg and only answers when it
    // is done — there is no progress channel. Report the phases we can actually
    // know rather than animating a fake percentage.
    const say = (job: RenderJob) => onProgress?.(job);
    say({ progress: 5, status: 'queued', message: 'Sending edits' });
    const pending = api.post<{ ok: boolean; video_url: string }>(
      `${V4}/videos/${encodeURIComponent(slug)}/movers`,
      body,
    );
    say({ progress: 40, status: 'rendering', message: 'Re-rendering on the server (this takes a while)' });
    const res = await pending;
    say({ progress: 100, status: 'done', message: 'Render complete' });
    invalidateCatalogs();
    return res;
  },

  async getTransitions(slug) {
    const res = await api.get<{ world_id: string; slug: string; transitions: BgTransition[] }>(
      `${V4}/live-bgs-v3/transitions/${encodeURIComponent(slug)}`,
    );
    return { world_id: res.world_id, transitions: res.transitions };
  },

  async setTransitionPoint(worldId, body) {
    await api.put(`${V4}/live-bgs-v3/${encodeURIComponent(worldId)}/transition-point`, body);
  },

  async listWorlds() {
    // v4 has no "list worlds" route; the relation catalog is grouped BY world,
    // so its category names are the world ids.
    const cat = await fetchCatalog('video_v3', true);
    return cat.categories.map((c) => c.name);
  },

  async getWorldGraph(worldId) {
    return api.get<WorldGraph>(`${V4}/live-bgs-v3/${encodeURIComponent(worldId)}/graph`);
  },

  async saveWorldGraph(worldId, body) {
    return api.put<WorldGraph>(`${V4}/live-bgs-v3/${encodeURIComponent(worldId)}/graph`, {
      routes: body.routes as RelationRoute[],
      ui: body.ui,
    });
  },
};

async function readAction(slug: string, action: string): Promise<ActionDetail> {
  const payload = await api.get<{ actions: V4Action[] }>(
    `${V4}/assets/characters/${encodeURIComponent(slug)}/actions`,
  );
  const a = payload.actions.find((x) => x.name === action);
  if (!a) throw new Error(`no action ${action} on ${slug}`);
  return {
    name: a.name,
    spritesheet: a.spritesheet,
    strip: null,
    enabled: a.enabled,
    fps: a.fps,
    frameCount: a.frame_count,
    description: a.description,
    rev: a.rev,
    is3q: !!a.is_3q,
  };
}
