/** Preset colours for well-known zone names; anything else gets a stable hue
 *  from a hashed palette, so a zone keeps its colour across sessions. */
const ZONE_COLORS: Record<string, string> = {
  sky: '#3b82f6',
  mid: '#06b6d4',
  foreground: '#f59e0b',
  ground: '#22c55e',
  ceiling: '#a855f7',
  walls: '#ec4899',
  water: '#0ea5e9',
  surface: '#84cc16',
  buildings: '#ef4444',
  space: '#6366f1',
};

const PALETTE = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#0ea5e9', '#a855f7',
  '#ef4444', '#84cc16', '#06b6d4', '#6366f1', '#f97316', '#14b8a6',
];

function hashIndex(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % PALETTE.length;
  return h;
}

export function defaultZoneColor(name: string): string {
  return ZONE_COLORS[name] ?? PALETTE[hashIndex(name)];
}

export function zoneColor(zone: { name: string; color?: string | null }): string {
  return zone.color || defaultZoneColor(zone.name);
}

export const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 100) / 100));

export function centroid(points: number[][]): [number, number] {
  if (!points.length) return [50, 50];
  const x = points.reduce((a, p) => a + p[0], 0) / points.length;
  const y = points.reduce((a, p) => a + p[1], 0) / points.length;
  return [x, y];
}

/** Project a point onto every polygon edge; return the splice index for a new vertex. */
export function nearestEdge(points: number[][], p: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
}
