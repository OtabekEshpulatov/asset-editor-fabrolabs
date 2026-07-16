import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV4, type RelationNode, type RelationRoute } from '../api';

/**
 * Live BG v3 — relation map for one world.
 *
 * LAYERED FLOW layout (the "subway map" style used by flowchart tools like
 * dagre / React Flow — the most readable form for small DAG-ish graphs):
 * - connected components stack as separate bands (day chain, night chain…);
 * - inside a band, nodes sit in LEFT→RIGHT columns by walk order;
 * - every route is an ARROW in its authored direction (all routes are
 *   two-way for stories; the arrow shows the natural direction — downstream,
 *   inward — so "what comes after what" reads at a glance).
 *
 * Click a node → right panel shows the frame with EXIT DOTS at the exact
 * `center_pct` where each route leaves the picture.
 */

const COL_W = 250;  // column pitch
const ROW_H = 158;  // row pitch
const PAD_X = 100;  // canvas padding (room for half a card)
const PAD_Y = 88;
const CARD_W = 132; // node card width (thumb 120x68 + padding)

const TOD_ICON: Record<string, string> = { day: '☀️', dusk: '🌆', night: '🌙' };

function edgeStyle(r: RelationRoute): { stroke: string; dash?: string; icon?: string; marker: string } {
  if (r.relation === 'enter') return { stroke: '#d97706', icon: '🚪', marker: 'url(#arrow-amber)' };
  if (r.portal === 'vista') return { stroke: '#0d9488', dash: '7 5', icon: '👁', marker: 'url(#arrow-teal)' };
  if (r.portal === 'vehicle') return { stroke: '#7c3aed', dash: '2 4', icon: '🚀', marker: 'url(#arrow-violet)' };
  return { stroke: '#9ca3af', marker: 'url(#arrow-gray)' };
}

function shortName(slug: string, worldPrefixes: string[]): string {
  let s = slug.replace(/_live$/, '');
  for (const p of worldPrefixes) if (s.startsWith(p)) s = s.slice(p.length);
  return s.replace(/_/g, ' ');
}

/** Layered left-to-right layout; connected components become stacked bands. */
function useLayout(nodes: RelationNode[], routes: RelationRoute[]) {
  return useMemo(() => {
    const slugs = nodes.map((n) => n.slug);
    const known = new Set(slugs);
    const edges = routes.filter((r) => known.has(r.from) && known.has(r.to));

    // undirected components
    const comp = new Map<string, number>();
    let nComp = 0;
    for (const s of slugs) {
      if (comp.has(s)) continue;
      const stack = [s];
      comp.set(s, nComp);
      while (stack.length) {
        const u = stack.pop()!;
        for (const r of edges) {
          const v = r.from === u ? r.to : r.to === u ? r.from : null;
          if (v && !comp.has(v)) {
            comp.set(v, nComp);
            stack.push(v);
          }
        }
      }
      nComp++;
    }

    // column = longest authored-direction path from any root (relaxation)
    const depth = new Map<string, number>(slugs.map((s) => [s, 0]));
    for (let i = 0; i < slugs.length; i++) {
      let changed = false;
      for (const r of edges) {
        const d = depth.get(r.from)! + 1;
        if (d > depth.get(r.to)!) {
          depth.set(r.to, d);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const pos = new Map<string, { x: number; y: number }>();
    let yOffset = 0;
    let width = 0;
    const bands: { y: number; height: number }[] = [];
    for (let ci = 0; ci < nComp; ci++) {
      const members = slugs.filter((s) => comp.get(s) === ci);
      const maxD = Math.max(...members.map((s) => depth.get(s)!));
      const cols: string[][] = Array.from({ length: maxD + 1 }, () => []);
      for (const s of members) cols[depth.get(s)!].push(s);
      const maxRows = Math.max(...cols.map((c) => c.length));

      // order rows by the average row of already-placed neighbors (barycenter)
      const rowOf = new Map<string, number>();
      cols.forEach((col, di) => {
        if (di > 0) {
          const bary = (s: string) => {
            const ps = edges
              .filter((r) => (r.to === s && rowOf.has(r.from)) || (r.from === s && rowOf.has(r.to)))
              .map((r) => rowOf.get(r.to === s ? r.from : r.to)!);
            return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : col.indexOf(s);
          };
          col.sort((a, b) => bary(a) - bary(b));
        }
        col.forEach((s, i) => rowOf.set(s, i));
      });

      const bandH = PAD_Y * 2 + (maxRows - 1) * ROW_H;
      cols.forEach((col, di) => {
        col.forEach((s, i) => {
          const y = yOffset + PAD_Y + (i + (maxRows - col.length) / 2) * ROW_H;
          pos.set(s, { x: PAD_X + di * COL_W, y });
        });
      });
      width = Math.max(width, PAD_X * 2 + maxD * COL_W);
      bands.push({ y: yOffset, height: bandH });
      yOffset += bandH;
    }
    return { pos, width: Math.max(width, 640), height: Math.max(yOffset, 300), bands };
  }, [nodes, routes]);
}

/** Static FIRST FRAME of the mp4; plays only while hovered. */
function Thumb({ url, w, h }: { url: string | null; w: number; h: number }) {
  if (!url) {
    return (
      <div className="grid place-items-center bg-gray-200 text-[9px] text-gray-500" style={{ width: w, height: h }}>
        no mp4
      </div>
    );
  }
  return (
    <video
      src={`${url}#t=0.04`}
      muted
      loop
      playsInline
      preload="metadata"
      onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
      onMouseLeave={(e) => e.currentTarget.pause()}
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
  const { pos, width, height } = useLayout(nodes, routes);
  const [selected, setSelected] = useState<string | null>(null);
  const sel = nodes.find((x) => x.slug === selected) ?? null;

  const prefixes = useMemo(() => {
    const first = nodes[0]?.slug ?? '';
    const p = first.includes('_') ? first.split('_')[0] + '_' : '';
    return p ? [p] : [];
  }, [nodes]);

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
            <span>→ arrows show the natural walk order (all routes work BOTH ways)</span>
            <span><span className="mr-1 inline-block h-0.5 w-6 bg-gray-400 align-middle" />path</span>
            <span>
              <svg className="mr-1 inline align-middle" width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke="#0d9488" strokeWidth="2" strokeDasharray="7 5" /></svg>
              vista
            </span>
            <span><span className="mr-1 inline-block h-0.5 w-6 bg-amber-600 align-middle" />🚪 enter</span>
            <span>☀️/🌆/🌙 time of day · click a bg to see WHERE each exit sits</span>
          </div>

          {isLoading && <div className="py-8 text-sm text-gray-500">Loading graph…</div>}
          {error != null && <div className="py-4 text-sm text-red-600">Failed to load graph: {String(error)}</div>}

          {data && (
            <div className="flex flex-wrap items-start gap-4">
              {/* ── the flow map (scrolls horizontally if needed) ─────────── */}
              <div className="min-w-[640px] flex-1 overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <div className="relative" style={{ width, height }}>
                  <svg className="absolute inset-0" width={width} height={height}>
                    <defs>
                      {[['gray', '#9ca3af'], ['teal', '#0d9488'], ['amber', '#d97706'], ['violet', '#7c3aed']].map(([id, color]) => (
                        <marker key={id} id={`arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5"
                                markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
                        </marker>
                      ))}
                    </defs>
                    {routes.map((r) => {
                      const a = pos.get(r.from);
                      const b = pos.get(r.to);
                      if (!a || !b) return null;
                      const st = edgeStyle(r);
                      const dim = neighborSet && !(neighborSet.has(r.from) && neighborSet.has(r.to));
                      const active = selected != null && (r.from === selected || r.to === selected);
                      // anchor at card edges, curve gently left→right
                      const x1 = a.x + CARD_W / 2;
                      const x2 = b.x - CARD_W / 2 - 8;
                      const midX = (x1 + x2) / 2;
                      const d = `M ${x1} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${x2} ${b.y}`;
                      return (
                        <g key={r.id} opacity={dim ? 0.15 : 1}>
                          <path d={d} fill="none" stroke={st.stroke}
                                strokeWidth={active ? 3.5 : 2.5}
                                strokeDasharray={st.dash} markerEnd={st.marker}>
                            <title>{`${r.from} ↔ ${r.to} (${r.relation === 'enter' ? 'enter' : r.portal})`}</title>
                          </path>
                          {st.icon && (
                            <text x={midX} y={(a.y + b.y) / 2 - 7} textAnchor="middle" fontSize="13"
                                  style={{ pointerEvents: 'none' }}>
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
                          'absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-white p-1 shadow-sm transition',
                          isSel ? 'z-10 border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 hover:border-blue-300',
                        ].join(' ')}
                        style={{ left: p.x, top: p.y, width: CARD_W, opacity: dim ? 0.3 : 1 }}
                      >
                        <div className="relative overflow-hidden rounded">
                          <Thumb url={n.url} w={120} h={68} />
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
              </div>

              {/* ── selected background: exits marked on the frame ───────── */}
              <div className="w-[400px] shrink-0 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                {!sel ? (
                  <div className="grid h-full min-h-[220px] place-items-center px-6 text-center text-sm text-gray-400">
                    Click a background on the map — its exits (paths, doors, vistas)
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
