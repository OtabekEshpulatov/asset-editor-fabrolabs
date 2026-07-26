import type { RelationNode, RelationRoute } from '../api';

/**
 * Live BG v3 — pure graph math behind the one-canvas world map.
 *
 * No React in here on purpose: layout, packing and the connectivity audit are
 * plain functions over the sidecar's nodes/routes, so they stay easy to reason
 * about (and to check against the real sidecar) while the canvas stays a view.
 */

export const CARD_W = 190;
/** card footprint incl. the name line — used for collision/packing math */
export const CARD_H = 148;
export const COL_W = 320;
export const ROW_H = 210;
/** breathing room a district backdrop leaves around its member cards */
export const PAD = 46;
/** the district's title bar sits in this strip above the topmost card */
export const HEAD_H = 34;

// --- adjacency ---------------------------------------------------------------

/** ignores direction — "are these two places connected at all" */
export function undirectedAdj(routes: RelationRoute[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  for (const r of routes) {
    add(r.from, r.to);
    add(r.to, r.from);
  }
  return m;
}

/** honours direction: a one-way route only walks from → to */
export function directedAdj(routes: RelationRoute[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  for (const r of routes) {
    add(r.from, r.to);
    if (r.bidirectional) add(r.to, r.from);
  }
  return m;
}

/** shortest hop path from → to, or null when unreachable. Direction-aware. */
export function shortestPath(from: string, to: string, adj: Map<string, Set<string>>): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, cur);
        if (nb === to) {
          const path = [to];
          let p = to;
          while (prev.has(p)) { p = prev.get(p)!; path.unshift(p); }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

// --- audit -------------------------------------------------------------------

export interface WorldAudit {
  /** connected chunks, largest first. More than one = the world is split. */
  components: string[][];
  /** no relation whatsoever — the engine can never place a scene here */
  orphans: string[];
  /** you can walk in but never out (every touching route is one-way inbound) */
  deadEnds: string[];
  /** "near" (touching) relations whose two backgrounds disagree on time of day */
  todMismatch: { route: RelationRoute; fromTod: string; toTod: string }[];
  problemCount: number;
}

export function auditWorld(nodes: RelationNode[], routes: RelationRoute[]): WorldAudit {
  const meta = new Map(nodes.map((n) => [n.slug, n]));
  const und = undirectedAdj(routes);
  const dir = directedAdj(routes);

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.slug)) continue;
    const stack = [n.slug];
    const comp: string[] = [];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      comp.push(x);
      for (const nb of und.get(x) ?? []) stack.push(nb);
    }
    components.push(comp.sort());
  }
  components.sort((a, b) => b.length - a.length);

  const orphans = nodes.filter((n) => !(und.get(n.slug)?.size)).map((n) => n.slug);
  const deadEnds = nodes
    .filter((n) => (und.get(n.slug)?.size ?? 0) > 0 && !(dir.get(n.slug)?.size))
    .map((n) => n.slug);

  const todMismatch: WorldAudit['todMismatch'] = [];
  for (const r of routes) {
    if (r.portal === 'edge') continue; // "far" — a long gap, tod may legitimately change
    const a = meta.get(r.from);
    const b = meta.get(r.to);
    if (a && b && a.tod !== b.tod) todMismatch.push({ route: r, fromTod: a.tod, toTod: b.tod });
  }

  return {
    components,
    orphans,
    deadEnds,
    todMismatch,
    problemCount:
      Math.max(0, components.length - 1) + orphans.length + deadEnds.length + todMismatch.length,
  };
}

// --- layout ------------------------------------------------------------------

export type Pos = { x: number; y: number };

/** longest-path layering over a district's internal routes → left-to-right columns */
function layeredLocal(members: string[], routes: RelationRoute[]): { pos: Map<string, Pos>; w: number; h: number } {
  const known = new Set(members);
  const inner = routes.filter((r) => known.has(r.from) && known.has(r.to));
  const depth = new Map(members.map((s) => [s, 0]));
  for (let i = 0; i < members.length; i++) {
    let changed = false;
    for (const r of inner) {
      const d = depth.get(r.from)! + 1;
      if (d > depth.get(r.to)!) { depth.set(r.to, d); changed = true; }
    }
    if (!changed) break;
  }
  const maxD = Math.max(0, ...members.map((s) => depth.get(s)!));
  const cols: string[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const s of members) cols[depth.get(s)!].push(s);

  // barycentre ordering so arrows inside a district cross as little as possible
  const rowOf = new Map<string, number>();
  cols.forEach((col, di) => {
    if (di > 0) {
      const bary = (s: string) => {
        const ps = inner
          .filter((r) => (r.to === s && rowOf.has(r.from)) || (r.from === s && rowOf.has(r.to)))
          .map((r) => rowOf.get(r.to === s ? r.from : r.to)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : col.indexOf(s);
      };
      col.sort((a, b) => bary(a) - bary(b));
    }
    col.forEach((s, i) => rowOf.set(s, i));
  });

  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const pos = new Map<string, Pos>();
  cols.forEach((col, di) => {
    col.forEach((s, i) => {
      pos.set(s, { x: di * COL_W, y: (i + (maxRows - col.length) / 2) * ROW_H });
    });
  });
  return { pos, w: maxD * COL_W + CARD_W, h: (maxRows - 1) * ROW_H + CARD_H };
}

/** shelf-pack district blocks left→right, wrapping so the world stays roughly square */
function packBlocks(blocks: { key: string; w: number; h: number }[]): Map<string, Pos> {
  const total = blocks.reduce((a, b) => a + b.w * b.h, 0);
  const target = Math.max(1400, Math.sqrt(total) * 1.7);
  const GAP = 130;
  const origin = new Map<string, Pos>();
  let x = 0, y = 0, shelfH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > target) { x = 0; y += shelfH + GAP; shelfH = 0; }
    origin.set(b.key, { x, y });
    x += b.w + GAP;
    shelfH = Math.max(shelfH, b.h);
  }
  return origin;
}

/** Full auto-arrange: lay out each district internally, then pack the districts. */
export function autoLayout(
  nodes: RelationNode[],
  routes: RelationRoute[],
  clusterKeys: string[],
): Map<string, Pos> {
  const blocks = clusterKeys.map((key) => {
    const members = nodes.filter((n) => (n.cluster || 'all') === key).map((n) => n.slug);
    return { key, members, ...layeredLocal(members, routes) };
  });
  const origin = packBlocks(blocks);
  const out = new Map<string, Pos>();
  for (const b of blocks) {
    const o = origin.get(b.key)!;
    for (const [slug, p] of b.pos) out.set(slug, { x: o.x + p.x, y: o.y + p.y });
  }
  return out;
}

/**
 * Migration for graphs laid out by the OLD per-district editors: every district
 * started at its own origin, so on one canvas they all pile up. Keep each
 * district's hand-made internal arrangement (that was real work) and translate
 * it as a rigid block into a free lane.
 */
export function repackExisting(
  nodes: RelationNode[],
  saved: Map<string, Pos>,
  clusterKeys: string[],
): Map<string, Pos> {
  const blocks = clusterKeys.map((key) => {
    const members = nodes.filter((n) => (n.cluster || 'all') === key && saved.has(n.slug));
    const xs = members.map((m) => saved.get(m.slug)!.x);
    const ys = members.map((m) => saved.get(m.slug)!.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return {
      key, members,
      minX: Number.isFinite(minX) ? minX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      w: (Number.isFinite(minX) ? Math.max(...xs) - minX : 0) + CARD_W,
      h: (Number.isFinite(minY) ? Math.max(...ys) - minY : 0) + CARD_H,
    };
  });
  const origin = packBlocks(blocks);
  const out = new Map<string, Pos>();
  for (const b of blocks) {
    const o = origin.get(b.key)!;
    for (const m of b.members) {
      const p = saved.get(m.slug)!;
      out.set(m.slug, { x: o.x + (p.x - b.minX), y: o.y + (p.y - b.minY) });
    }
  }
  return out;
}

/** do any two cards from DIFFERENT districts overlap? → the saved layout predates one-canvas */
export function hasCrossDistrictOverlap(nodes: RelationNode[], pos: Map<string, Pos>): boolean {
  const items = nodes
    .filter((n) => pos.has(n.slug))
    .map((n) => ({ c: n.cluster || 'all', ...pos.get(n.slug)! }));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.c === b.c) continue;
      if (Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H) return true;
    }
  }
  return false;
}

/** backdrop rectangle enclosing a district's cards (null when it has none placed) */
export function districtBox(members: string[], pos: Map<string, Pos>) {
  const ps = members.map((s) => pos.get(s)).filter(Boolean) as Pos[];
  if (!ps.length) return null;
  const minX = Math.min(...ps.map((p) => p.x));
  const minY = Math.min(...ps.map((p) => p.y));
  const maxX = Math.max(...ps.map((p) => p.x)) + CARD_W;
  const maxY = Math.max(...ps.map((p) => p.y)) + CARD_H;
  return {
    x: minX - PAD,
    y: minY - PAD - HEAD_H,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2 + HEAD_H,
  };
}
