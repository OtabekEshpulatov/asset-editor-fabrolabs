import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV4, type RelationNode, type RelationRoute } from '../api';

/**
 * Live BG v3 — relation map for one world, organized as THEMED DISTRICTS.
 *
 * Interaction (everything happens IN PLACE — no separate panel opens):
 * - idle: only the district bgs show; route lines faint; neighbor bgs hidden.
 * - hover a bg: its routes light up, unrelated bgs dim, and its related bgs —
 *   INCLUDING ones from other districts — appear as small cards right beside
 *   it (brought close, not off in a far lane).
 * - select (click) a bg: the map collapses to a single focused board — the
 *   selected bg on the left and EVERY related bg lined up close to its right,
 *   no scrolling. Cross-district relations keep the amber "guest" styling with
 *   their district label; clicking one re-focuses onto it. Esc / ✕ / clicking
 *   the selected bg returns to the full map.
 */

const COL_W = 235;
const ROW_H = 152;
const PAD_X = 95;
const PAD_Y = 84;
const CARD_W = 132;

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

/** Layered left→right layout for ONE district's nodes + internal routes. */
function layoutCluster(nodes: RelationNode[], routes: RelationRoute[]) {
  const slugs = nodes.map((n) => n.slug);
  const known = new Set(slugs);
  const edges = routes.filter((r) => known.has(r.from) && known.has(r.to));
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
  const maxD = Math.max(0, ...slugs.map((s) => depth.get(s)!));
  const cols: string[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const s of slugs) cols[depth.get(s)!].push(s);
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
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
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, di) => {
    col.forEach((s, i) => {
      pos.set(s, {
        x: PAD_X + di * COL_W,
        y: PAD_Y + (i + (maxRows - col.length) / 2) * ROW_H,
      });
    });
  });
  return {
    pos,
    width: PAD_X * 2 + maxD * COL_W,
    height: PAD_Y * 2 + (maxRows - 1) * ROW_H,
    edges,
  };
}

/** Static first frame; plays on hover. */
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

const ARROW_DEFS = (
  <defs>
    {[['gray', '#9ca3af'], ['teal', '#0d9488'], ['amber', '#d97706'], ['violet', '#7c3aed']].map(([id, color]) => (
      <marker key={id} id={`arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill={color} />
      </marker>
    ))}
  </defs>
);

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
  const clusterMeta = data?.clusters ?? {};
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const sel = nodes.find((x) => x.slug === selected) ?? null;
  const focus = hovered ?? selected;

  const bySlug = useMemo(() => new Map(nodes.map((n) => [n.slug, n])), [nodes]);

  const prefixes = useMemo(() => {
    const first = nodes[0]?.slug ?? '';
    const p = first.includes('_') ? first.split('_')[0] + '_' : '';
    return p ? [p] : [];
  }, [nodes]);

  const clusterOf = useMemo(
    () => new Map(nodes.map((n) => [n.slug, n.cluster || 'all'])),
    [nodes],
  );
  const clusterKeys = useMemo(() => {
    const declared = Object.keys(clusterMeta);
    const used = [...new Set(nodes.map((n) => n.cluster || 'all'))];
    return [...declared.filter((k) => used.includes(k)), ...used.filter((k) => !declared.includes(k))];
  }, [clusterMeta, nodes]);
  const clusterTitle = (key: string) => {
    const m = clusterMeta[key];
    return `${m?.emoji ? m.emoji + ' ' : ''}${m?.title || key.replace(/_/g, ' ')}`;
  };

  /** Directed relation view from a node: which bg it exits to + endpoint. */
  const relationsOf = (slug: string) =>
    routes
      .filter((r) => r.from === slug || (r.bidirectional && r.to === slug))
      .map((r) => {
        const outgoing = r.from === slug;
        const ep = outgoing ? r.exit : r.entry;
        return { route: r, other: outgoing ? r.to : r.from, pct: ep.center_pct ?? [50, 60], landmarks: ep.landmark_ids ?? [] };
      });

  const neighborSet = (slug: string) => {
    const s = new Set<string>([slug]);
    for (const r of routes) {
      if (r.from === slug) s.add(r.to);
      if (r.to === slug) s.add(r.from);
    }
    return s;
  };

  const [pulsed, setPulsed] = useState<string | null>(null);
  const jumpTo = (slug: string) => {
    setSelected(slug);
    setPulsed(slug);
    window.setTimeout(() => setPulsed((p) => (p === slug ? null : p)), 1600);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const layouts = useMemo(() => {
    const m = new Map<string, ReturnType<typeof layoutCluster> & { members: RelationNode[] }>();
    for (const key of clusterKeys) {
      const members = nodes.filter((n) => (n.cluster || 'all') === key);
      m.set(key, { ...layoutCluster(members, routes), members });
    }
    return m;
  }, [clusterKeys, nodes, routes]);

  return (
    <section className="space-y-2">
      <style>{`
        @keyframes rg-dash { to { stroke-dashoffset: -26; } }
        .rg-dash-anim { animation: rg-dash 1.1s linear infinite; }
        @keyframes rg-pulse {
          0% { box-shadow: 0 0 0 0 rgba(59,130,246,.55); }
          100% { box-shadow: 0 0 0 16px rgba(59,130,246,0); }
        }
        .rg-pulse { animation: rg-pulse .9s ease-out 2; }
        @keyframes rg-in { from { transform: translateX(-14px) scale(.97); } to { transform: none; } }
        .rg-in { animation: rg-in .28s ease-out; }
        @media (prefers-reduced-motion: reduce) { .rg-dash-anim, .rg-pulse, .rg-in { animation: none; } }
      `}</style>
      <button type="button" onClick={onToggleCollapse}
              className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <span>{collapsed ? '▸' : '▾'}</span>
        <span className="capitalize">{world.replace(/_/g, ' ')}</span>
        <span className="font-normal text-gray-400">
          {nodes.length} bg · {routes.length} relations · {clusterKeys.length} districts
        </span>
      </button>

      {!collapsed && (
        <>
          {isLoading && <div className="py-8 text-sm text-gray-500">Loading graph…</div>}
          {error != null && <div className="py-4 text-sm text-red-600">Failed to load graph: {String(error)}</div>}

          {data && (
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-[660px] flex-1 space-y-4">
                {/* overview strip */}
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-2 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    {clusterKeys.map((key) => (
                      <span key={key} className="rounded-full border border-gray-300 bg-gray-50 px-3 py-1 font-medium text-gray-700">
                        {clusterTitle(key)}<span className="ml-1 text-gray-400">{layouts.get(key)?.members.length}</span>
                      </span>
                    ))}
                    <span className="text-[11px] text-gray-400">
                      hover — bog'liq fonlar yonida chiqadi · click — faqat o'zi va bog'liqlari qoladi (Esc)
                    </span>
                  </div>
                </div>

                {sel ? (
                  /* ─────────── FOCUS BOARD: selected + relations, close ─────────── */
                  (() => {
                    const rels = relationsOf(sel.slug);
                    const n = rels.length;
                    const H = Math.max(PAD_Y * 2 + (n - 1) * ROW_H, 320);
                    const selX = 150, relX = 560, W = relX + CARD_W / 2 + PAD_X;
                    return (
                      <div className="rg-in rounded-lg border border-blue-200 bg-white">
                        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                          <span className="text-sm font-semibold text-gray-700">
                            🔍 {shortName(sel.slug, prefixes)}
                            <span className="ml-2 font-normal text-gray-400">
                              {n} ta bog'lanish · {clusterTitle(clusterOf.get(sel.slug)!)}
                            </span>
                          </span>
                          <button type="button" onClick={() => setSelected(null)}
                                  className="rounded border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
                            ✕ xaritaga qaytish <span className="text-gray-400">(Esc)</span>
                          </button>
                        </div>
                        <div className="overflow-x-auto">
                          <div className="relative" style={{ width: W, height: H,
                               backgroundImage: 'radial-gradient(circle, #d8dbe0 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
                            <svg className="absolute inset-0" width={W} height={H}>
                              {ARROW_DEFS}
                              {rels.map((e, i) => {
                                const st = edgeStyle(e.route);
                                const y = H / 2 + (i - (n - 1) / 2) * ROW_H;
                                const x1 = selX + 94, x2 = relX - CARD_W / 2 - 8, midX = (x1 + x2) / 2;
                                return (
                                  <g key={`fe-${e.route.id}-${i}`}>
                                    <path d={`M ${x1} ${H / 2} C ${midX} ${H / 2}, ${midX} ${y}, ${x2} ${y}`}
                                          fill="none" stroke={st.stroke} strokeWidth={3}
                                          className={st.dash ? 'rg-dash-anim' : undefined}
                                          strokeDasharray={st.dash} markerEnd={st.marker} />
                                    {st.icon && (
                                      <text x={midX} y={(H / 2 + y) / 2 - 7} textAnchor="middle" fontSize="13"
                                            style={{ pointerEvents: 'none' }}>{st.icon}</text>
                                    )}
                                    <circle cx={x1} cy={H / 2} r="3.5" fill={st.stroke} />
                                    <circle cx={relX - CARD_W / 2 - 2} cy={y} r="3.5" fill={st.stroke} />
                                  </g>
                                );
                              })}
                            </svg>
                            {/* selected, big, center-left */}
                            <button type="button" onClick={() => setSelected(null)} title="Yopish (Esc)"
                                    className={['absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-xl border-2 border-blue-500 bg-white p-1.5 shadow-md ring-2 ring-blue-200',
                                                pulsed === sel.slug ? 'rg-pulse' : ''].join(' ')}
                                    style={{ left: selX, top: H / 2, width: 188 }}>
                              <div className="relative overflow-hidden rounded-lg">
                                <Thumb url={sel.url} w={172} h={97} />
                                <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[10px] text-white">
                                  {TOD_ICON[sel.tod] ?? ''}{sel.indoor ? ' ■' : ''}
                                </span>
                              </div>
                              <span className="w-full truncate text-center text-[11px] font-semibold leading-tight text-gray-800">
                                {shortName(sel.slug, prefixes)}
                              </span>
                            </button>
                            {/* every relation, brought close */}
                            {rels.map((e, i) => {
                              const nb = bySlug.get(e.other);
                              if (!nb) return null;
                              const y = H / 2 + (i - (n - 1) / 2) * ROW_H;
                              const cross = clusterOf.get(nb.slug) !== clusterOf.get(sel.slug);
                              return (
                                <button key={`fn-${nb.slug}-${i}`} type="button" onClick={() => jumpTo(nb.slug)}
                                        title={`${nb.slug} — fokusni shu fonga o'tkazish`}
                                        className={['rg-in absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg p-1 shadow-sm transition-transform duration-200 hover:z-10 hover:scale-[1.05] hover:shadow-md',
                                                    cross ? 'border-2 border-dashed border-amber-400 bg-amber-50 hover:bg-amber-100'
                                                          : 'border border-gray-200 bg-white hover:border-blue-300'].join(' ')}
                                        style={{ left: relX, top: y, width: CARD_W, animationDelay: `${i * 55}ms` }}>
                                  <div className="relative overflow-hidden rounded">
                                    <Thumb url={nb.url} w={120} h={68} />
                                    <span className="absolute left-0.5 top-0.5 rounded bg-black/55 px-1 text-[9px] text-white">
                                      {TOD_ICON[nb.tod] ?? ''}{nb.indoor ? ' ■' : ''}
                                    </span>
                                    <span className="absolute right-0.5 top-0.5 rounded bg-black/45 px-1 text-[8px] text-white">
                                      {e.route.relation === 'enter' ? '🚪' : e.route.portal === 'vista' ? '👁' : '→'}
                                    </span>
                                  </div>
                                  <span className="w-full truncate text-center text-[10px] leading-tight text-gray-700">
                                    {shortName(nb.slug, prefixes)}
                                  </span>
                                  {cross && (
                                    <span className="w-full truncate text-center text-[9px] leading-tight text-amber-600">
                                      {clusterTitle(clusterOf.get(nb.slug)!)}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  /* ─────────── FULL MAP (idle / hover) ─────────── */
                  clusterKeys.map((key) => {
                    const L = layouts.get(key)!;
                    // guest cards to show near the hovered node (cross-district)
                    const hoverGuests = focus && L.members.some((mm) => mm.slug === focus)
                      ? relationsOf(focus).filter((e) => clusterOf.get(e.other) !== key)
                      : [];
                    const focusPos = focus ? L.pos.get(focus) : undefined;
                    const nSet = focus ? neighborSet(focus) : null;
                    // extend width if guests would overflow to the right
                    const guestX = focusPos ? Math.min(focusPos.x + COL_W, L.width + COL_W - PAD_X) : 0;
                    const boardW = hoverGuests.length ? Math.max(L.width, guestX + CARD_W / 2 + PAD_X) : L.width;
                    const boardH = hoverGuests.length
                      ? Math.max(L.height, (focusPos?.y ?? L.height / 2) + (hoverGuests.length) * (ROW_H * 0.62))
                      : L.height;
                    return (
                      <div key={key} id={`cluster-${world}-${key}`}
                           className="rounded-lg border border-gray-200 bg-white">
                        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                          <span className="text-sm font-semibold text-gray-700">{clusterTitle(key)}</span>
                          <span className="text-[11px] text-gray-400">{L.members.length} bg</span>
                        </div>
                        <div className="overflow-x-auto">
                          <div className="relative" style={{ width: boardW, height: boardH,
                               backgroundImage: 'radial-gradient(circle, #d8dbe0 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
                            <svg className="absolute inset-0" width={boardW} height={boardH}>
                              {ARROW_DEFS}
                              {L.edges.map((r) => {
                                const a = L.pos.get(r.from); const b = L.pos.get(r.to);
                                if (!a || !b) return null;
                                const st = edgeStyle(r);
                                const on = focus != null && (r.from === focus || r.to === focus);
                                const op = !focus ? 0.14 : on ? 1 : 0.05;
                                const x1 = a.x + CARD_W / 2, x2 = b.x - CARD_W / 2 - 8, midX = (x1 + x2) / 2;
                                return (
                                  <g key={r.id} style={{ opacity: op, transition: 'opacity .35s ease' }}>
                                    <path d={`M ${x1} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${x2} ${b.y}`}
                                          fill="none" stroke={st.stroke}
                                          className={st.dash && on ? 'rg-dash-anim' : undefined}
                                          strokeWidth={on ? 3.5 : 2} strokeDasharray={st.dash} markerEnd={st.marker}>
                                      <title>{`${r.from} ↔ ${r.to}`}</title>
                                    </path>
                                    <circle cx={x1} cy={a.y} r="3.5" fill={st.stroke} />
                                    <circle cx={b.x - CARD_W / 2 - 2} cy={b.y} r="3.5" fill={st.stroke} />
                                    {st.icon && on && (
                                      <text x={midX} y={(a.y + b.y) / 2 - 7} textAnchor="middle" fontSize="13"
                                            style={{ pointerEvents: 'none' }}>{st.icon}</text>
                                    )}
                                  </g>
                                );
                              })}
                              {/* hover-guest connectors */}
                              {focusPos && hoverGuests.map((e, i) => {
                                const gy = focusPos.y + (i - (hoverGuests.length - 1) / 2) * (ROW_H * 0.62);
                                const x1 = focusPos.x + CARD_W / 2, x2 = guestX - CARD_W / 2 - 6, midX = (x1 + x2) / 2;
                                return (
                                  <g key={`hg-${e.route.id}-${i}`}>
                                    <path d={`M ${x1} ${focusPos.y} C ${midX} ${focusPos.y}, ${midX} ${gy}, ${x2} ${gy}`}
                                          fill="none" stroke="#f59e0b" strokeWidth={3} className="rg-dash-anim"
                                          strokeDasharray="8 5" markerEnd="url(#arrow-amber)" />
                                    <circle cx={x1} cy={focusPos.y} r="3.5" fill="#f59e0b" />
                                  </g>
                                );
                              })}
                            </svg>

                            {L.members.map((mn) => {
                              const p = L.pos.get(mn.slug);
                              if (!p) return null;
                              const dim = nSet && !nSet.has(mn.slug);
                              return (
                                <button key={mn.slug} id={`rgnode-${world}-${mn.slug}`} type="button"
                                        onClick={() => setSelected(mn.slug)}
                                        onMouseEnter={() => setHovered(mn.slug)}
                                        onMouseLeave={() => setHovered(null)}
                                        className={['absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-white p-1 shadow-sm transition-all duration-300 ease-out motion-reduce:transition-none border-gray-200 hover:z-10 hover:scale-[1.04] hover:border-blue-300 hover:shadow-md'].join(' ')}
                                        style={{ left: p.x, top: p.y, width: CARD_W,
                                                 ...(dim ? { opacity: 0.28, filter: 'saturate(0.35)' } : undefined) }}>
                                  <div className="relative overflow-hidden rounded">
                                    <Thumb url={mn.url} w={120} h={68} />
                                    <span className="absolute left-0.5 top-0.5 rounded bg-black/55 px-1 text-[9px] text-white">
                                      {TOD_ICON[mn.tod] ?? ''}{mn.indoor ? ' ■' : ''}
                                    </span>
                                  </div>
                                  <span className="w-full truncate text-center text-[10px] leading-tight text-gray-700">
                                    {shortName(mn.slug, prefixes)}
                                  </span>
                                </button>
                              );
                            })}

                            {/* hover guests — brought close, right beside the node */}
                            {focusPos && hoverGuests.map((e, i) => {
                              const nb = bySlug.get(e.other);
                              if (!nb) return null;
                              const gy = focusPos.y + (i - (hoverGuests.length - 1) / 2) * (ROW_H * 0.62);
                              return (
                                <button key={`hgc-${nb.slug}-${i}`} type="button"
                                        onMouseEnter={() => setHovered(focus)}
                                        onClick={() => jumpTo(nb.slug)}
                                        title={`${nb.slug} — ${clusterTitle(clusterOf.get(nb.slug)!)} bo'limiga o'tish`}
                                        className="rg-in absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 p-1 shadow-md hover:scale-[1.05] hover:bg-amber-100"
                                        style={{ left: guestX, top: gy, width: CARD_W }}>
                                  <div className="relative overflow-hidden rounded">
                                    <Thumb url={nb.url} w={120} h={68} />
                                    <span className="absolute right-0.5 top-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-bold text-white">↗</span>
                                  </div>
                                  <span className="w-full truncate text-center text-[10px] font-medium leading-tight text-amber-900">
                                    {shortName(nb.slug, prefixes)}
                                  </span>
                                  <span className="w-full truncate text-center text-[9px] leading-tight text-amber-600">
                                    {clusterTitle(clusterOf.get(nb.slug)!)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* detail panel */}
              <div className="w-[400px] shrink-0 space-y-2 self-start rounded-lg border border-gray-200 bg-white p-3 lg:sticky lg:top-28">
                {!sel ? (
                  <div className="grid h-full min-h-[220px] place-items-center px-6 text-center text-sm text-gray-400">
                    Bir fonni bosing — chiqishlari (yo'l, eshik, vista) kadrning ustida belgilanadi.
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
                      {sel.url && <video src={sel.url} muted loop autoPlay playsInline className="h-full w-full object-cover" />}
                      {relationsOf(sel.slug).map((e, i) => {
                        const st = edgeStyle(e.route);
                        return (
                          <div key={`${e.route.id}-${i}`} className="absolute -translate-x-1/2 -translate-y-1/2"
                               style={{ left: `${e.pct[0]}%`, top: `${e.pct[1]}%` }}
                               title={`${e.route.relation === 'enter' ? 'enter' : e.route.portal} → ${e.other}`}>
                            <div className="mx-auto h-3.5 w-3.5 animate-pulse rounded-full border-2 border-white shadow"
                                 style={{ background: st.stroke }} />
                            <div className="mt-0.5 max-w-[110px] truncate rounded bg-black/65 px-1 text-center text-[9px] leading-tight text-white">
                              {shortName(e.other, prefixes)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {sel.description && <p className="text-[11px] leading-snug text-gray-500">{sel.description}</p>}
                    <ul className="space-y-1">
                      {relationsOf(sel.slug).map((e, i) => {
                        const st = edgeStyle(e.route);
                        const crossCluster = clusterOf.get(e.other) !== clusterOf.get(sel.slug);
                        return (
                          <li key={`${e.route.id}-li-${i}`}>
                            <button type="button" onClick={() => jumpTo(e.other)}
                                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-gray-700 hover:bg-gray-50">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: st.stroke }} />
                              <span className="truncate">
                                {e.route.relation === 'enter' ? '🚪 enter' : e.route.portal === 'vista' ? '👁 vista' : '→ path'}
                                {' · '}<b>{shortName(e.other, prefixes)}</b>
                                {crossCluster && <span className="ml-1 text-amber-700">({clusterTitle(clusterOf.get(e.other)!)})</span>}
                                {' · '}[{e.pct[0]}, {e.pct[1]}]
                              </span>
                            </button>
                          </li>
                        );
                      })}
                      {relationsOf(sel.slug).length === 0 && (
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
