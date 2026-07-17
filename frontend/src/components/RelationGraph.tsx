import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiV4, type RelationNode, type RelationRoute } from '../api';

/**
 * Live BG v3 — relation map for one world, organized as THEMED DISTRICTS.
 *
 * Interaction model (all IN PLACE — nothing opens elsewhere):
 * - idle: only the district bgs are visible; route lines sit faint; the
 *   neighbor-district GUEST cards are hidden.
 * - hover a bg: its routes light up, unrelated bgs dim, and its guest
 *   neighbors fade in inside the lane on the right of the card.
 * - select (click) a bg: everything unrelated disappears completely — only
 *   the bg + its relations remain, right where they stand; distant relations
 *   appear as guest cards beside it. Districts with nothing relevant collapse.
 *   Esc / clicking again brings the whole map back.
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

  const prefixes = useMemo(() => {
    const first = nodes[0]?.slug ?? '';
    const p = first.includes('_') ? first.split('_')[0] + '_' : '';
    return p ? [p] : [];
  }, [nodes]);

  const neighborsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set([a]));
      m.get(a)!.add(b);
    };
    for (const r of routes) {
      add(r.from, r.to);
      add(r.to, r.from);
    }
    return m;
  }, [routes]);
  const focusSet = focus ? neighborsOf.get(focus) ?? new Set([focus]) : null;
  const selSet = selected ? neighborsOf.get(selected) ?? new Set([selected]) : null;

  /** Edge visibility: faint at idle; lit when touching the focus; when a bg is
   *  SELECTED, unrelated edges vanish completely. */
  const edgeEmphasis = (a: string, b: string) => {
    const touches = focus != null && (a === focus || b === focus);
    if (selected) {
      const touchesSel = a === selected || b === selected;
      if (touchesSel) return { opacity: 1, width: 3.5, showIcon: true };
      return { opacity: 0, width: 2, showIcon: false };
    }
    if (!focus) return { opacity: 0.14, width: 2, showIcon: false };
    if (touches) return { opacity: 1, width: 3.5, showIcon: true };
    return { opacity: 0.04, width: 2, showIcon: false };
  };

  /** Card visibility: hover dims unrelated; select HIDES unrelated in place. */
  const cardFx = (slug: string): React.CSSProperties | undefined => {
    if (selected) {
      return selSet!.has(slug)
        ? undefined
        : { opacity: 0, pointerEvents: 'none' };
    }
    if (focusSet && !focusSet.has(slug)) return { opacity: 0.35, filter: 'saturate(0.4)' };
    return undefined;
  };

  /** Guest cards stay hidden until their inner partner (or they themselves)
   *  are hovered/selected. */
  const ghostVisible = (inner: string, outer: string) =>
    focus != null && (inner === focus || outer === focus);

  const [pulsed, setPulsed] = useState<string | null>(null);
  const pulse = (slug: string) => {
    setPulsed(slug);
    window.setTimeout(() => setPulsed((p) => (p === slug ? null : p)), 2000);
  };
  const jumpTo = (slug: string) => {
    setSelected(slug);
    pulse(slug);
    const key = clusterOf.get(slug) || 'all';
    window.setTimeout(() => {
      document.getElementById(`cluster-${world}-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 120);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── district grouping ─────────────────────────────────────────────────────
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

  const gateways = useMemo(
    () => routes.filter((r) => clusterOf.get(r.from) !== clusterOf.get(r.to)),
    [routes, clusterOf],
  );

  const layouts = useMemo(() => {
    const bySlug = new Map(nodes.map((n) => [n.slug, n]));
    const m = new Map<string, ReturnType<typeof layoutCluster> & {
      members: RelationNode[];
      ghosts: { node: RelationNode; x: number; y: number }[];
      ghostEdges: { from: string; toGhost: string; route: RelationRoute }[];
      fullWidth: number;
      fullHeight: number;
    }>();
    for (const key of clusterKeys) {
      const members = nodes.filter((n) => (n.cluster || 'all') === key);
      const L = layoutCluster(members, routes);
      const gws = gateways.filter(
        (g) => clusterOf.get(g.from) === key || clusterOf.get(g.to) === key,
      );
      const ghostSlugs = [...new Set(gws.map((g) => (clusterOf.get(g.from) === key ? g.to : g.from)))];
      const ghostX = L.width - PAD_X + COL_W + 30;
      const fullHeight = Math.max(L.height, PAD_Y * 2 + (ghostSlugs.length - 1) * ROW_H);
      const ghosts = ghostSlugs
        .map((slug, i) => {
          const node = bySlug.get(slug);
          if (!node) return null;
          const y = fullHeight / 2 + (i - (ghostSlugs.length - 1) / 2) * ROW_H;
          return { node, x: ghostX, y };
        })
        .filter(Boolean) as { node: RelationNode; x: number; y: number }[];
      const ghostEdges = gws.map((g) => {
        const inner = clusterOf.get(g.from) === key ? g.from : g.to;
        const outer = clusterOf.get(g.from) === key ? g.to : g.from;
        return { from: inner, toGhost: outer, route: g };
      });
      m.set(key, {
        ...L, members, ghosts, ghostEdges,
        fullWidth: ghosts.length ? ghostX + PAD_X : L.width,
        fullHeight,
      });
    }
    return m;
  }, [clusterKeys, nodes, routes, gateways, clusterOf]);

  /** When something is selected, districts that hold nothing related collapse. */
  const clusterRelevant = (key: string) => {
    if (!selected) return true;
    const L = layouts.get(key)!;
    return (
      L.members.some((mm) => selSet!.has(mm.slug)) ||
      L.ghostEdges.some((ge) => ge.from === selected || ge.toGhost === selected)
    );
  };

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
        @media (prefers-reduced-motion: reduce) {
          .rg-dash-anim, .rg-pulse { animation: none; }
        }
      `}</style>
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700"
      >
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
                {/* ── overview strip ────────────────────────────────────── */}
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-2 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    {clusterKeys.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          document.getElementById(`cluster-${world}-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                        }
                        className="rounded-full border border-gray-300 bg-gray-50 px-3 py-1 font-medium text-gray-700 hover:bg-gray-100"
                      >
                        {clusterTitle(key)}
                        <span className="ml-1 text-gray-400">{layouts.get(key)?.members.length}</span>
                      </button>
                    ))}
                    <span className="text-[11px] text-gray-400">
                      hover — yo'llarini ko'rsatadi · click — faqat o'zi va bog'liqlari qoladi (Esc — qaytish)
                    </span>
                  </div>
                  {selected && (
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      className="shrink-0 rounded border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
                    >
                      ✕ hammasini ko'rsatish
                    </button>
                  )}
                </div>

                {/* ── one compact card per district ─────────────────────── */}
                {clusterKeys.filter(clusterRelevant).map((key) => {
                  const L = layouts.get(key)!;
                  return (
                    <div key={key} id={`cluster-${world}-${key}`}
                         className="rounded-lg border border-gray-200 bg-white">
                      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                        <span className="text-sm font-semibold text-gray-700">{clusterTitle(key)}</span>
                        <span className="text-[11px] text-gray-400">{L.members.length} bg</span>
                      </div>
                      <div className="overflow-x-auto">
                        <div
                          className="relative"
                          style={{
                            width: L.fullWidth,
                            height: L.fullHeight,
                            backgroundImage: 'radial-gradient(circle, #d8dbe0 1px, transparent 1px)',
                            backgroundSize: '22px 22px',
                          }}
                        >
                          <svg className="absolute inset-0" width={L.fullWidth} height={L.fullHeight}>
                            {ARROW_DEFS}
                            {L.ghostEdges.map((ge) => {
                              const a = L.pos.get(ge.from);
                              const g = L.ghosts.find((x) => x.node.slug === ge.toGhost);
                              if (!a || !g) return null;
                              const on = ghostVisible(ge.from, ge.toGhost);
                              const x1 = a.x + CARD_W / 2;
                              const x2 = g.x - CARD_W / 2 - 8;
                              const midX = (x1 + x2) / 2;
                              return (
                                <g key={`ghost-${ge.route.id}-${ge.from}`}
                                   style={{ opacity: on ? 1 : 0, transition: 'opacity .4s ease' }}>
                                  <path d={`M ${x1} ${a.y} C ${midX} ${a.y}, ${midX} ${g.y}, ${x2} ${g.y}`}
                                        fill="none" stroke="#f59e0b"
                                        className={on ? 'rg-dash-anim' : undefined}
                                        strokeWidth={3}
                                        strokeDasharray="8 5" markerEnd="url(#arrow-amber)">
                                    <title>{`${ge.from} ⇄ ${ge.toGhost} (boshqa bo'limga o'tish)`}</title>
                                  </path>
                                  <circle cx={x1} cy={a.y} r="3.5" fill="#f59e0b" />
                                  <circle cx={g.x - CARD_W / 2 - 2} cy={g.y} r="3.5" fill="#f59e0b" />
                                </g>
                              );
                            })}
                            {L.edges.map((r) => {
                              const a = L.pos.get(r.from);
                              const b = L.pos.get(r.to);
                              if (!a || !b) return null;
                              const st = edgeStyle(r);
                              const em = edgeEmphasis(r.from, r.to);
                              const x1 = a.x + CARD_W / 2;
                              const x2 = b.x - CARD_W / 2 - 8;
                              const midX = (x1 + x2) / 2;
                              return (
                                <g key={r.id} style={{ opacity: em.opacity, transition: 'opacity .4s ease' }}>
                                  <path d={`M ${x1} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${x2} ${b.y}`}
                                        fill="none" stroke={st.stroke}
                                        className={st.dash && em.showIcon ? 'rg-dash-anim' : undefined}
                                        strokeWidth={em.width}
                                        strokeDasharray={st.dash} markerEnd={st.marker}>
                                    <title>{`${r.from} ↔ ${r.to} (${r.relation === 'enter' ? 'enter' : r.portal})`}</title>
                                  </path>
                                  {st.icon && em.showIcon && (
                                    <text x={midX} y={(a.y + b.y) / 2 - 7} textAnchor="middle" fontSize="13"
                                          style={{ pointerEvents: 'none' }}>
                                      {st.icon}
                                    </text>
                                  )}
                                  <circle cx={x1} cy={a.y} r="3.5" fill={st.stroke} />
                                  <circle cx={b.x - CARD_W / 2 - 2} cy={b.y} r="3.5" fill={st.stroke} />
                                </g>
                              );
                            })}
                          </svg>

                          {L.members.map((n) => {
                            const p = L.pos.get(n.slug);
                            if (!p) return null;
                            const isSel = selected === n.slug;
                            return (
                              <button
                                key={n.slug}
                                id={`rgnode-${world}-${n.slug}`}
                                type="button"
                                onClick={() => setSelected(isSel ? null : n.slug)}
                                onMouseEnter={() => setHovered(n.slug)}
                                onMouseLeave={() => setHovered(null)}
                                className={[
                                  'absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border bg-white p-1 shadow-sm transition-all duration-300 ease-out motion-reduce:transition-none',
                                  isSel ? 'z-10 scale-[1.06] border-blue-500 shadow-md ring-2 ring-blue-300'
                                        : 'border-gray-200 hover:z-10 hover:scale-[1.04] hover:border-blue-300 hover:shadow-md',
                                  pulsed === n.slug ? 'rg-pulse' : '',
                                ].join(' ')}
                                style={{ left: p.x, top: p.y, width: CARD_W, ...cardFx(n.slug) }}
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

                          {/* GUEST cards — hidden until their partner is
                              hovered/selected; visually distinct (amber) */}
                          {L.ghosts.map((g) => {
                            const on = L.ghostEdges.some(
                              (ge) => ge.toGhost === g.node.slug && ghostVisible(ge.from, ge.toGhost),
                            );
                            return (
                              <button
                                key={`ghost-${g.node.slug}`}
                                type="button"
                                onClick={() => jumpTo(g.node.slug)}
                                onMouseEnter={() => setHovered(g.node.slug)}
                                onMouseLeave={() => setHovered(null)}
                                title={`${g.node.slug} — ${clusterTitle(clusterOf.get(g.node.slug)!)} bo'limiga o'tish`}
                                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 p-1 shadow-sm transition-all duration-300 ease-out hover:z-10 hover:scale-[1.04] hover:bg-amber-100 hover:shadow-md motion-reduce:transition-none"
                                style={{
                                  left: g.x, top: g.y, width: CARD_W,
                                  opacity: on ? 1 : 0,
                                  pointerEvents: on ? undefined : 'none',
                                }}
                              >
                                <div className="relative overflow-hidden rounded">
                                  <Thumb url={g.node.url} w={120} h={68} />
                                  <span className="absolute left-0.5 top-0.5 rounded bg-black/55 px-1 text-[9px] text-white">
                                    {TOD_ICON[g.node.tod] ?? ''}{g.node.indoor ? ' ■' : ''}
                                  </span>
                                  <span className="absolute right-0.5 top-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-bold text-white">↗</span>
                                </div>
                                <span className="w-full truncate text-center text-[10px] font-medium leading-tight text-amber-900">
                                  {shortName(g.node.slug, prefixes)}
                                </span>
                                <span className="w-full truncate text-center text-[9px] leading-tight text-amber-600">
                                  {clusterTitle(clusterOf.get(g.node.slug)!)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── selected background: exits marked on the frame ───────── */}
              <div className="w-[400px] shrink-0 space-y-2 self-start rounded-lg border border-gray-200 bg-white p-3 lg:sticky lg:top-28">
                {!sel ? (
                  <div className="grid h-full min-h-[220px] place-items-center px-6 text-center text-sm text-gray-400">
                    Click a background — its exits (paths, doors, vistas) will be
                    marked right on the frame.
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
                            <div className="mx-auto h-3.5 w-3.5 animate-pulse rounded-full border-2 border-white shadow"
                                 style={{ background: st.stroke }} />
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
                        const crossCluster = clusterOf.get(e.other) !== clusterOf.get(sel.slug);
                        return (
                          <li key={`${e.route.id}-li-${i}`}>
                            <button
                              type="button"
                              onClick={() => jumpTo(e.other)}
                              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                            >
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: st.stroke }} />
                              <span className="truncate">
                                {e.route.relation === 'enter' ? '🚪 enter' : e.route.portal === 'vista' ? '👁 vista' : '→ path'}
                                {' · '}
                                <b>{shortName(e.other, prefixes)}</b>
                                {crossCluster && (
                                  <span className="ml-1 text-amber-700">({clusterTitle(clusterOf.get(e.other)!)})</span>
                                )}
                                {' · '}
                                [{e.pct[0]}, {e.pct[1]}]
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
