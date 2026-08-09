/**
 * Mock implementation of the DataAdapter contract.
 *
 * Everything it returns is shaped exactly like the phase-2 /api/v5 responses,
 * including real cursor pagination — so the grid's paging behaviour is being
 * exercised for real, not faked with a slice of a preloaded array.
 */

import type {
  ActionDetail,
  AddedMover,
  AssetDetail,
  AssetItem,
  AssetKind,
  AssetQuery,
  BgTransition,
  BgZone,
  DataAdapter,
  Facet,
  ImageTransform,
  Mover,
  Page,
  PaletteAsset,
  RenderJob,
  SaveMoversBody,
  VideoMovers,
} from '../types';
import { ASSET_KINDS } from '../types';
import { settle } from './latency';
import {
  assets,
  dropActionState,
  findItem,
  getActionState,
  media,
  moveActionState,
  movers,
  setActionState,
  worldGraphs,
  zones,
} from './store';

const DEFAULT_LIMIT = 60;

/**
 * Deep copy on the way out.
 *
 * This adapter MUST NOT hand out references into its own store. A real HTTP
 * adapter deserializes a fresh object on every response, and code upstream
 * quietly depends on that: React Query's structural sharing compares cached
 * data against newly fetched data, so if a mutation edits a stored object in
 * place and the next read returns that same object, the comparison finds them
 * identical and skips the re-render — the edit lands in the store but never
 * reaches the screen.
 *
 * Emulating the serialization boundary is what keeps the prototype's behaviour
 * honest, rather than subtly better or worse than the real thing.
 */
const snapshot = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

/** Opaque cursor. The real backend will use a keyset; an offset is honest
 *  enough here because the mock list is stable and fully ordered. */
const encodeCursor = (offset: number) => btoa(String(offset));
const decodeCursor = (cursor?: string | null) => {
  if (!cursor) return 0;
  const n = Number(atob(cursor));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function actionDetail(slug: string, name: string): ActionDetail {
  const s = getActionState(slug, name);
  const item = findItem('character', slug) ?? findItem('animation', slug);
  return {
    name,
    // Only ONE real sheet ships with the prototype; every action points at it so
    // the frame editor operates on genuine pixels and a real 5x5 grid.
    spritesheet: media.spritesheet?.url ?? null,
    strip: item?.strip ?? null,
    enabled: s.enabled,
    fps: s.fps,
    frameCount: s.frameCount,
    description: s.description,
    rev: s.rev,
    is3q: s.is3q,
  };
}

function bumpRev(kind: AssetKind, slug: string): number {
  const item = findItem(kind, slug);
  if (!item) return 0;
  item.rev += 1;
  return item.rev;
}

export const mockAdapter: DataAdapter = {
  name: 'mock',

  async listAssets(query) {
    const all = (assets[query.kind] ?? []).filter((i) => matches(i, query));
    const offset = decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const slice = all.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const page: Page<AssetItem> = {
      items: snapshot(slice),
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
      total: all.length,
    };
    return settle(page, 'read');
  },

  async facets(kind) {
    const counts = new Map<string, number>();
    for (const item of assets[kind] ?? []) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    const out: Facet[] = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return settle(out, 'read');
  },

  async kindCounts() {
    const out = {} as Record<AssetKind, number>;
    for (const kind of ASSET_KINDS) out[kind] = (assets[kind] ?? []).length;
    return settle(out, 'read');
  },

  async searchAll(q, limit = 30) {
    const needle = q.trim().toLowerCase();
    if (!needle) return settle([], 'read');
    const out: AssetItem[] = [];
    for (const kind of ASSET_KINDS) {
      for (const item of assets[kind] ?? []) {
        if (item.slug.toLowerCase().includes(needle)) {
          out.push(snapshot(item));
          if (out.length >= limit) return settle(out, 'read');
        }
      }
    }
    return settle(out, 'read');
  },

  async getAsset(kind, slug) {
    const item = findItem(kind, slug);
    if (!item) throw new Error(`no ${kind} ${slug}`);
    const detail: AssetDetail = {
      ...snapshot(item),
      actionDetails: (item.actions ?? []).map((a) => actionDetail(slug, a)),
    };
    return settle(detail, 'read');
  },

  async setAssetConfig(kind, slug, fields) {
    const item = findItem(kind, slug);
    if (!item) throw new Error(`no ${kind} ${slug}`);
    if (fields.enabled !== undefined) item.enabled = fields.enabled;
    if (fields.description !== undefined) item.description = fields.description;
    return settle(snapshot(item), 'write');
  },

  async renameAsset(kind, oldSlug, newSlug) {
    const item = findItem(kind, oldSlug);
    if (!item) throw new Error(`no ${kind} ${oldSlug}`);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(newSlug)) {
      throw new Error("Name must be lowercase letters, digits, '-' or '_'");
    }
    if (findItem(kind, newSlug)) throw new Error(`${newSlug} already exists`);
    item.slug = newSlug;
    return settle(snapshot(item), 'write');
  },

  async transformAsset(kind, slug, _t: ImageTransform) {
    return settle({ rev: bumpRev(kind, slug) }, 'heavy');
  },

  async setActionConfig(slug, action, fields) {
    const patch: Record<string, unknown> = {};
    if (fields.enabled !== undefined) patch.enabled = fields.enabled;
    if (fields.description !== undefined) patch.description = fields.description;
    if (fields.fps !== undefined) patch.fps = fields.fps;
    if (fields.is3q !== undefined) patch.is3q = fields.is3q;
    setActionState(slug, action, patch);
    return settle(actionDetail(slug, action), 'write');
  },

  async renameAction(slug, oldName, newName) {
    const item = findItem('character', slug) ?? findItem('animation', slug);
    if (!item?.actions) throw new Error(`no actions for ${slug}`);
    if (item.actions.includes(newName)) throw new Error(`${newName} already exists`);
    item.actions = item.actions.map((a) => (a === oldName ? newName : a)).sort();
    moveActionState(slug, oldName, newName);
    return settle(actionDetail(slug, newName), 'write');
  },

  async mirrorAction(slug, source) {
    const item = findItem('character', slug) ?? findItem('animation', slug);
    if (!item?.actions) throw new Error(`no actions for ${slug}`);
    // Same naming rule as the backend: toggle _left/_right, else append _left.
    const name = source.endsWith('_left')
      ? source.replace(/_left$/, '_right')
      : source.endsWith('_right')
        ? source.replace(/_right$/, '_left')
        : `${source}_left`;
    if (item.actions.includes(name)) throw new Error(`${name} already exists`);
    item.actions = [...item.actions, name].sort();
    setActionState(slug, name, { ...getActionState(slug, source) });
    return settle(actionDetail(slug, name), 'write');
  },

  async deleteAction(slug, action) {
    const item = findItem('character', slug) ?? findItem('animation', slug);
    if (!item?.actions) throw new Error(`no actions for ${slug}`);
    if (item.actions.length <= 1) throw new Error('Cannot delete the last action');
    item.actions = item.actions.filter((a) => a !== action);
    dropActionState(slug, action);
    return settle(undefined, 'write');
  },

  async transformAction(slug, action, _t: ImageTransform) {
    const s = setActionState(slug, action, { rev: getActionState(slug, action).rev + 1 });
    return settle({ rev: s.rev }, 'heavy');
  },

  async reorderFrames(slug, action, order) {
    const s = setActionState(slug, action, {
      frameCount: order.length,
      rev: getActionState(slug, action).rev + 1,
    });
    return settle({ rev: s.rev, frameCount: s.frameCount }, 'heavy');
  },

  async getBackgroundDoc(slug) {
    const doc = zones[slug];
    if (!doc) throw new Error(`no background ${slug}`);
    return settle(snapshot(doc), 'read');
  },

  async saveBackgroundDoc(slug, body) {
    const doc = zones[slug];
    if (!doc) throw new Error(`no background ${slug}`);
    doc.description = body.description;
    // Drop the client-only _uid before persisting, exactly as the backend does —
    // and drop a scale with no depth, which the backend answers 422 for. Mock
    // mode has no bands in its fixtures, but it must not accept a shape the
    // real API rejects.
    doc.zones = body.zones.map(({ _uid: _drop, ...z }) =>
      (z.depth == null ? { ...z, scale: null } : z) as BgZone,
    );
    return settle(snapshot(doc), 'write');
  },

  async getMovers(slug) {
    const doc = movers[slug];
    if (!doc) throw new Error(`no editable source bundle for ${slug}`);
    return settle(snapshot(doc), 'read');
  },

  async listMoverPalette() {
    const pool = (assets.character ?? []).filter((c) => c.thumb).slice(0, 36);
    const out: PaletteAsset[] = pool.map((c) => ({ id: c.slug, preview_url: c.thumb }));
    // (plain new objects — no store references escape here)
    return settle(out, 'read');
  },

  async saveMovers(slug, body: SaveMoversBody, onProgress) {
    const doc = movers[slug];
    if (!doc) throw new Error(`no editable source bundle for ${slug}`);

    // Apply edits to the stored spec first, so a reload shows the new positions.
    for (const edit of body.movers) {
      const m = doc.movers.find((x) => x.index === edit.index);
      if (!m) continue;
      Object.assign(m, edit);
      if (edit.w !== undefined) m.w_pct = Number(((edit.w / 1280) * 100).toFixed(2));
    }
    if (body.removed?.length) {
      const drop = new Set(body.removed);
      doc.movers = doc.movers.filter((m) => !drop.has(m.index));
    }
    for (const add of body.added ?? []) {
      doc.movers.push(newMover(doc, add));
    }
    doc.movers.forEach((m, i) => (m.index = i));

    // The real endpoint re-renders an mp4 with ffmpeg — seconds, not millis.
    // Tick a job so the UI's progress affordance is exercised honestly.
    const steps: RenderJob[] = [
      { progress: 5, status: 'queued', message: 'Queued for render' },
      { progress: 35, status: 'rendering', message: 'Compositing layers' },
      { progress: 70, status: 'rendering', message: 'Encoding video' },
      { progress: 95, status: 'rendering', message: 'Uploading' },
      { progress: 100, status: 'done', message: 'Render complete' },
    ];
    for (const step of steps) {
      await new Promise((r) => setTimeout(r, 420));
      onProgress?.(step);
    }
    return { ok: true, video_url: doc.video_url };
  },

  async getTransitions(slug) {
    const world = Object.values(worldGraphs).find((g) => g.nodes.some((n) => n.slug === slug));
    if (!world) throw new Error(`${slug} is not in any world graph`);
    const transitions: BgTransition[] = [];
    for (const r of world.routes) {
      const side = r.from === slug ? 'exit' : r.to === slug ? 'entry' : null;
      if (!side) continue;
      const otherSlug = side === 'exit' ? r.to : r.from;
      const endpoint = side === 'exit' ? r.exit : r.entry;
      const other = world.nodes.find((n) => n.slug === otherSlug);
      transitions.push({
        route_id: r.id,
        side,
        other: otherSlug,
        other_url: other?.url ?? null,
        far: r.relation !== 'path',
        center_pct: [endpoint.center_pct?.[0] ?? 50, endpoint.center_pct?.[1] ?? 60],
        zone: endpoint.zone ?? 'ground',
      });
    }
    return settle({ world_id: world.world_id, transitions }, 'read');
  },

  async setTransitionPoint(worldId, body) {
    const world = worldGraphs[worldId];
    if (!world) throw new Error(`no world graph ${worldId}`);
    const route = world.routes.find((r) => r.id === body.route_id);
    if (!route) throw new Error(`no route ${body.route_id}`);
    const endpoint = body.side === 'exit' ? route.exit : route.entry;
    endpoint.center_pct = [...body.center_pct];
    return settle(undefined, 'write');
  },

  async listWorlds() {
    return settle(Object.keys(worldGraphs), 'read');
  },

  async getWorldGraph(worldId) {
    const g = worldGraphs[worldId];
    if (!g) throw new Error(`no world graph ${worldId}`);
    return settle(snapshot(g), 'read');
  },

  async saveWorldGraph(worldId, body) {
    const g = worldGraphs[worldId];
    if (!g) throw new Error(`no world graph ${worldId}`);
    g.routes = snapshot(body.routes);
    g.editor_ui = { ...g.editor_ui, ...body.ui };
    for (const node of g.nodes) {
      const pos = body.ui[node.slug];
      if (pos) node.ui = { ...pos };
    }
    return settle(snapshot(g), 'write');
  },
};

/** Fill in the engine params the backend would derive for a dropped creature. */
function newMover(doc: VideoMovers, add: AddedMover): Mover {
  const w = add.w ?? ({ float: 80, swim: 80, patrol: 90, pulse: 40 } as Record<string, number>)[add.kind] ?? 80;
  const positionable = ['float', 'pulse', 'peek', 'patrol'].includes(add.kind);
  const preview = (assets.character ?? []).find((c) => c.slug === add.id)?.thumb ?? null;
  return {
    index: doc.movers.length,
    id: add.id,
    kind: add.kind,
    x: add.x ?? 50,
    y: add.y ?? 50,
    w,
    w_pct: Number(((w / 1280) * 100).toFixed(2)),
    flip: add.flip ?? false,
    to_left: false,
    x0: add.kind === 'swim' ? 5 : null,
    x1: add.kind === 'swim' ? 95 : null,
    speed: add.speed ?? 1,
    positionable,
    has_y: positionable || add.kind === 'swim',
    cutout_url: preview,
    still: add.still,
    breathe: add.breathe,
    isNew: true,
    tiles_per_loop: null,
  };
}
