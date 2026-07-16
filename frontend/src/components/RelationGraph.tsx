import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV4, type RelationNode, type RelationRoute } from '../api';

/**
 * Live BG v3 — relation map for one world.
 *
 * Left: the world graph — every background as a live thumbnail, every relation
 * as a line (gray = path, dashed teal = vista "seen in the distance",
 * amber + door = enter). Click a node to inspect it.
 *
 * Right: the selected background with EXIT DOTS overlaid at the exact
 * `center_pct` where each route leaves the frame — you see precisely where on
 * the picture every neighbor connects.
 */

const CANVAS_W = 1000;
const CANVAS_H = 560;
const TOD_ICON: Record<string, string> = { day: '☀️', dusk: '🌆', night: '🌙' };

function edgeStyle(r: RelationRoute): { stroke: string; dash?: string; icon?: string } {
  if (r.relation === 'enter') return { stroke: '#d97706', icon: '🚪' };
  if (r.portal === 'vista') return { stroke: '#0d9488', dash: '6 5', icon: '👁' };
  if (r.portal === 'vehicle') return { stroke: '#7c3aed', dash: '2 4', icon: '🚀' };
  return { stroke: '#9ca3af' };
}

function shortName(slug: string, worldPrefixes: string[]): string {
  let s = slug.replace(/_live$/, '');
  for (const p of worldPrefixes) if (s.startsWith(p)) s = s.slice(p.length);
  return s.replace(/_/g, ' ');
}

/** Deterministic force layout in a fixed CANVAS_W x CANVAS_H space. */
function useLayout(nodes: RelationNode[], routes: RelationRoute[]) {
  return useMemo(() => {
    const n = nodes.length;
    const pos = new Map<string, { x: number; y: number }>();
    if (!n) return pos;
    const R = Math.min(CANVAS_W, CANVAS_H) * 0.38;
    nodes.forEach((node, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      pos.set(node.slug, {
        x: CANVAS_W / 2 + R * Math.cos(a),
        y: CANVAS_H / 2 + R * Math.sin(a),
      });
    });
    const edges = routes
      .filter((r) => pos.has(r.from) && pos.has(r.to))
      .map((r) => [r.from, r.to] as const);
    const SPRING = 190; // desired edge length
    for (let iter = 0; iter < 320; iter++) {
      const t = 1 - iter / 320; // cooling
      // pairwise repulsion
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = pos.get(nodes[i].slug)!;
          const b = pos.get(nodes[j].slug)!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 1);
          const d = Math.sqrt(d2);
          const f = (14000 / d2) * t;
          dx = (dx / d) * f;
          dy = (dy / d) * f;
          a.x += dx; a.y += dy;
          b.x -= dx; b.y -= dy;
        }
      }
      // spring attraction along edges
      for (const [fa, fb] of edges) {
        const a = pos.get(fa)!;
        const b = pos.get(fb)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = ((d - SPRING) / d) * 0.05 * t;
        a.x += dx * f; a.y += dy * f;
        b.x -= dx * f; b.y -= dy * f;
      }
      // keep inside the canvas (leave room for the card itself)
      for (const p of pos.values()) {
        p.x = Math.min(Math.max(p.x, 90), CANVAS_W - 90);
        p.y = Math.min(Math.max(p.y, 70), CANVAS_H - 78);
      }
    }
    return pos;
  }, [nodes, routes]);
}

/** In-view autoplaying muted looping thumb (same discipline as the v1 grid). */
function Thumb({ url, w, h }: { url: string | null; w: number; h: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShow(true);
          el.play().catch(() => {});
        } else el.pause();
      },
      { rootMargin: '100px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  if (!url) {
    return (
      <div className="grid place-items-center bg-gray-200 text-[9px] text-gray-500" style={{ width: w, height: h }}>
        no mp4
      </div>
    );
  }
  return (
    <video
      ref={ref}
      src={show ? url : undefined}
      muted
      loop
      playsInline
      preload="none"
      onLoadedData={(e) => e.currentTarget.play().catch(() => {})}
      className="bg-gray-100 object-cover"
      style={{ width: w, height: h }}
    />
  );
}

export default function RelationWorldSection({
  world,
  collapsed,
  onToggleCollapse,
}: {
  world: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['relation-graph', world],
    queryFn: () => apiV4.getRelationGraph(world),
    staleTime: 5 * 60 * 1000,
  });
  const nodes = data?.nodes ?? [];
  const routes = data?.routes ?? [];
  const pos = useLayout(nodes, routes);
  const [selected, setSelected] = useState<string | null>(null);
  const sel = nodes.find((x) => x.slug === selected) ?? null;

  // every world uses a shared slug prefix (forest_, fk_, …) — strip for labels
  const prefixes = useMemo(() => {
    const first = nodes[0]?.slug ?? '';
    const p = first.includes('_') ? first.split('_')[0] + '_' : '';
    return p ? [p] : [];
  }, [nodes]);

  // the selected node's "doors": for each incident route, the endpoint ON this node
  const exits = useMemo(() => {
    if (!sel) return [];
    return routes
      .filter((r) => r.from === sel.slug || (r.bidirectional && r.to === sel.slug))
      .map((r) => {
        const outgoing = r.from === sel.slug;
        const ep = outgoing ? r.exit : r.entry;
        const other = outgoing ? r.to : r.from;
        return { route: r, other, pct: ep.center_pct ?? [50, 60], landmarks: ep.landmark_ids ?? [] };
      });
  }, [sel, routes]);

  const neighborSet = useMemo(() => {
    if (!selected) return null;
    const s = new Set<string>([selected]);
    for (const r of routes) {
      if (r.from === selected) s.add(r.to);
      if (r.to === selected && r.bidirectional) s.add(r.from);
    }
    return s;
  }, [selected, routes]);

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700"
      >
        <span>{collapsed ? '▸' : '▾'}</span>
        <span className="capitalize">{world.replace(/_/g, ' ')}</span>
        <span className="font-normal text-gray-400">
          {nodes.length} bg · {routes.length} relations
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
            <span><span className="mr-1 inline-block h-0.5 w-6 bg-gray-400 align-middle" />path (walk)</span>
            <span>
              <svg className="mr-1 inline align-middle" width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke="#0d9488" strokeWidth="2" strokeDasharray="6 5" /></svg>
              vista — seen in the distance
            </span>
            <span><span className="mr-1 inline-block h-0.5 w-6 bg-amber-600 align-middle" />🚪 enter — goes inside</span>
            <span>■ = indoors · ☀️/🌆/🌙 = time of day</span>
            <span className="text-gray-400">click a background to see WHERE each relation leaves the frame</span>
          </div>

          {isLoading && <div className="py-8 text-sm text-gray-500">Loading graph…</div>}
          {error != null && <div className="py-4 text-sm text-red-600">Failed to load graph: {String(error)}</div>}

          {data && (
            <div className="flex flex-wrap gap-4">
              {/* ── the map ─────────────────────────────────────────────── */}
              <div
                className="relative min-w-[640px] flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white"
                style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
              >
                <svg
                  className="absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                  preserveAspectRatio="none"
                >
                  {routes.map((r) => {
                    const a = pos.get(r.from);
                    const b = pos.get(r.to);
                    if (!a || !b) return null;
                    const st = edgeStyle(r);
                    const dim = neighborSet && !(neighborSet.has(r.from) && neighborSet.has(r.to));
                    const active =
                      selected != null && (r.from === selected || r.to === selected);
                    return (
                      <g key={r.id} opacity={dim ? 0.18 : 1}>
                        <line
                          x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                          stroke={st.stroke}
                          strokeWidth={active ? 3.5 : 2}
                          strokeDasharray={st.dash}
                        >
                          <title>{`${r.from} ↔ ${r.to} (${r.relation === 'enter' ? 'enter' : r.portal})`}</title>
                        </line>
                        {st.icon && (
                          <text
                            x={(a.x + b.x) / 2}
                            y={(a.y + b.y) / 2 + 4}
                            textAnchor="middle"
                            fontSize="13"
                            style={{ pointerEvents: 'none' }}
                          >
                            {st.icon}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>

                {nodes.map((n) => {
                  const p = pos.get(n.slug);
                  if (!p) return null;
                  const isSel = selected === n.slug;
                  const dim = neighborSet && !neighborSet.has(n.slug);
                  return (
                    <button
                      key={n.slug}
                      type="button"
                      onClick={() => setSelected(isSel ? null : n.slug)}
                      className={[
                        'absolute flex w-[124px] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-white p-1 shadow-sm transition',
                        isSel ? 'z-10 border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 hover:border-blue-300',
                      ].join(' ')}
                      style={{
                        left: `${(p.x / CANVAS_W) * 100}%`,
                        top: `${(p.y / CANVAS_H) * 100}%`,
                        opacity: dim ? 0.35 : 1,
                      }}
                    >
                      <div className="relative overflow-hidden rounded">
                        <Thumb url={n.url} w={112} h={63} />
                        <span className="absolute left-0.5 top-0.5 rounded bg-black/55 px-1 text-[9px] text-white">
                          {TOD_ICON[n.tod] ?? ''}{n.indoor ? ' ■' : ''}
                        </span>
                      </div>
                      <span className="w-full truncate text-center text-[10px] leading-tight text-gray-700">
                        {shortName(n.slug, prefixes)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* ── selected background: exits marked on the frame ───────── */}
              <div className="w-[400px] shrink-0 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                {!sel ? (
                  <div className="grid h-full min-h-[220px] place-items-center px-6 text-center text-sm text-gray-400">
                    Click a background on the map — its exits (doors, paths, vistas)
                    will be marked right on the frame.
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="truncate text-sm font-semibold text-gray-800">{sel.slug}</div>
                      <span className="shrink-0 text-[11px] text-gray-500">
                        {TOD_ICON[sel.tod] ?? ''} {sel.indoor ? 'indoors' : 'outdoors'}
                      </span>
                    </div>
                    <div className="relative overflow-hidden rounded" style={{ aspectRatio: '16 / 9' }}>
                      {sel.url && (
                        <video src={sel.url} muted loop autoPlay playsInline className="h-full w-full object-cover" />
                      )}
                      {exits.map((e, i) => {
                        const st = edgeStyle(e.route);
                        return (
                          <div
                            key={`${e.route.id}-${i}`}
                            className="absolute -translate-x-1/2 -translate-y-1/2"
                            style={{ left: `${e.pct[0]}%`, top: `${e.pct[1]}%` }}
                            title={`${e.route.relation === 'enter' ? 'enter' : e.route.portal} → ${e.other}${e.landmarks.length ? ` (${e.landmarks.join(', ')})` : ''}`}
                          >
                            <div
                              className="mx-auto h-3.5 w-3.5 animate-pulse rounded-full border-2 border-white shadow"
                              style={{ background: st.stroke }}
                            />
                            <div className="mt-0.5 max-w-[110px] truncate rounded bg-black/65 px-1 text-center text-[9px] leading-tight text-white">
                              {shortName(e.other, prefixes)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {sel.description && (
                      <p className="text-[11px] leading-snug text-gray-500">{sel.description}</p>
                    )}
                    <ul className="space-y-1">
                      {exits.map((e, i) => {
                        const st = edgeStyle(e.route);
                        return (
                          <li key={`${e.route.id}-li-${i}`}>
                            <button
                              type="button"
                              onClick={() => setSelected(e.other)}
                              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                            >
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: st.stroke }} />
                              <span className="truncate">
                                {e.route.relation === 'enter' ? '🚪 enter' : e.route.portal === 'vista' ? '👁 vista' : '→ path'}
                                {' · '}
                                <b>{shortName(e.other, prefixes)}</b>
                                {' · '}
                                exit at [{e.pct[0]}, {e.pct[1]}]
                              </span>
                            </button>
                          </li>
                        );
                      })}
                      {exits.length === 0 && (
                        <li className="text-[11px] text-gray-400">no relations from this background</li>
                      )}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
