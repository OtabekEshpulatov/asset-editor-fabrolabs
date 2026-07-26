import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  ConnectionMode,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  reconnectEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { apiV4, type RelationRoute, type RelationWorldGraph } from '../api';
import QueuedThumb, { posterUrl } from './QueuedThumb';
import {
  CARD_W, autoLayout, auditWorld, directedAdj, districtBox,
  hasCrossDistrictOverlap, repackExisting, shortestPath,
  type Pos, type WorldAudit,
} from '../lib/worldGraph';

/**
 * Live BG v3 — THE world canvas. One board per world holding every background
 * and every relation, replacing the old per-district boards and per-district
 * editors (where the same bg had a different position in each editor, and a
 * whole district could sit disconnected without anyone noticing).
 *
 * UI rules that keep it calm:
 * - ONE top bar. Never a second row.
 * - ONE contextual right panel: nothing selected → world audit; arrow selected
 *   → arrow settings; card selected → background details. Never two at once.
 * - Two modes so a click never means two things: ✏️ edit (arrange/draw) and
 *   🧭 path (click A then B to trace the route between them).
 * - Districts are tinted backdrops computed from card positions, not separate
 *   boards and not React Flow parent nodes — so positions stay absolute and
 *   the old saved layouts carry over untouched.
 */

const NO_VIDEO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('novideo');

const THUMB_W = 176;
const THUMB_H = 99;

type EditorKind = 'near' | 'far';

const KIND_META: Record<EditorKind, { label: string; desc: string; stroke: string; dash?: string }> = {
  near: { label: '🔗 near', desc: 'places adjoin — the transition is visible in frame', stroke: '#475569' },
  far: { label: '🌫 far', desc: 'a long path between — leaves the frame, then arrives later', stroke: '#9ca3af', dash: '6 6' },
};

const TOD_META: Record<string, { icon: string; ring: string }> = {
  day: { icon: '☀️', ring: '#fbbf24' },
  dusk: { icon: '🌆', ring: '#fb923c' },
  night: { icon: '🌙', ring: '#818cf8' },
};

/** district backdrop tints — index-assigned, stable per world ordering */
const DISTRICT_TINTS = [
  { fill: 'rgba(16,185,129,.07)', line: '#10b981' },
  { fill: 'rgba(59,130,246,.07)', line: '#3b82f6' },
  { fill: 'rgba(168,85,247,.07)', line: '#a855f7' },
  { fill: 'rgba(244,114,182,.07)', line: '#ec4899' },
  { fill: 'rgba(20,184,166,.07)', line: '#14b8a6' },
  { fill: 'rgba(234,179,8,.07)', line: '#eab308' },
];

const kindOfRoute = (r: RelationRoute): EditorKind => (r.portal === 'edge' ? 'far' : 'near');

function applyKind(r: RelationRoute, kind: EditorKind): RelationRoute {
  if (kind === 'far') return { ...r, relation: 'path', portal: 'edge' };
  return r.portal === 'edge' ? { ...r, relation: 'path', portal: 'walkway' } : { ...r };
}

const DEFAULT_ENDPOINT = () => ({
  zone: 'mid', screen_zone: 'mid_center', center_pct: [50, 60] as [number, number], landmark_ids: [] as string[],
});

const shortName = (slug: string) => slug.replace(/_live$/, '').replace(/^[a-z]+_/, '').replace(/_/g, ' ');

// --- nodes -------------------------------------------------------------------

type BgNodeData = {
  slug: string; url: string | null; tod: string; indoor: boolean;
  cluster: string; island: boolean; onPath: boolean; dimmed: boolean;
  probe: 'from' | 'to' | null;
};

function BgNode({ data, selected }: NodeProps) {
  const d = data as BgNodeData;
  const tod = TOD_META[d.tod] ?? TOD_META.day;
  // wide edge strips instead of 3px dots — a far easier drag target, while the
  // card body stays free so dragging the card still moves it
  const strip = 'wg-port !rounded-none !border-0 !bg-blue-500/0 hover:!bg-blue-500/40';
  return (
    <div
      className={[
        'wg-node relative flex flex-col items-center gap-1 rounded-lg bg-white p-1.5 shadow-md transition-all',
        selected ? 'ring-2 ring-blue-500' : '',
        d.island ? 'ring-2 ring-red-400' : '',
        d.probe ? 'ring-2 ring-amber-500' : '',
      ].join(' ')}
      style={{
        width: CARD_W,
        border: `2px solid ${d.onPath ? '#f59e0b' : tod.ring}`,
        opacity: d.dimmed ? 0.25 : 1,
      }}
    >
      <div className="pointer-events-none relative overflow-hidden rounded">
        <QueuedThumb slug={d.slug} url={d.url} w={THUMB_W} h={THUMB_H} />
        <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[10px] text-white">
          {tod.icon}{d.indoor ? ' ■' : ''}
        </span>
        {d.probe && (
          <span className="absolute right-1 top-1 rounded bg-amber-500 px-1 text-[10px] font-bold text-white">
            {d.probe === 'from' ? 'A' : 'B'}
          </span>
        )}
        {d.island && (
          <span className="absolute bottom-1 right-1 rounded bg-red-500 px-1 text-[9px] font-bold text-white">
            cut off
          </span>
        )}
      </div>
      <span className="w-full truncate text-center text-[11px] leading-tight text-gray-700">
        {shortName(d.slug)}
      </span>
      <Handle id="t" type="source" position={Position.Top} className={strip}
              style={{ width: '100%', height: 14, top: -1, borderRadius: 0, transform: 'none', left: 0 }} />
      <Handle id="b" type="source" position={Position.Bottom} className={strip}
              style={{ width: '100%', height: 14, bottom: -1, borderRadius: 0, transform: 'none', left: 0 }} />
      <Handle id="l" type="source" position={Position.Left} className={strip}
              style={{ height: '100%', width: 14, left: -1, borderRadius: 0, transform: 'none', top: 0 }} />
      <Handle id="r" type="source" position={Position.Right} className={strip}
              style={{ height: '100%', width: 14, right: -1, borderRadius: 0, transform: 'none', top: 0 }} />
    </div>
  );
}

type DistrictNodeData = { title: string; count: number; tint: typeof DISTRICT_TINTS[number]; island: boolean };

function DistrictNode({ data }: NodeProps) {
  const d = data as DistrictNodeData;
  return (
    <div className="pointer-events-none h-full w-full rounded-2xl"
         style={{ background: d.tint.fill, border: `2px dashed ${d.island ? '#f87171' : d.tint.line}` }}>
      <div className="absolute left-3 top-2 flex items-center gap-2 whitespace-nowrap text-[13px] font-semibold"
           style={{ color: d.island ? '#dc2626' : d.tint.line }}>
        {d.title}
        <span className="font-normal opacity-60">{d.count} bg</span>
        {d.island && <span className="rounded bg-red-100 px-1.5 text-[11px] text-red-700">cut off from world</span>}
      </div>
    </div>
  );
}

const NODE_TYPES = { bg: BgNode, district: DistrictNode };

function anchorSides(a: Pos, b: Pos) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { s: 'r', t: 'l' } : { s: 'l', t: 'r' };
  return dy >= 0 ? { s: 'b', t: 't' } : { s: 't', t: 'b' };
}

// --- exit/entry point picker -------------------------------------------------

/**
 * Shown right after an arrow is drawn (and reopenable from the arrow panel):
 * click the frame where the character leaves, then where they arrive. Without
 * this the route silently keeps [50,60] placeholders and you would have to go
 * card → popup → transitions tab to fix them.
 */
function PortalPointModal({
  route, urlOf, onApply, onClose,
}: {
  route: RelationRoute;
  urlOf: (slug: string) => string | null;
  onApply: (exit: [number, number], entry: [number, number]) => void;
  onClose: () => void;
}) {
  const asPct = (v: number[] | undefined): [number, number] =>
    (v && v.length === 2 ? [v[0], v[1]] : [50, 60]) as [number, number];
  const [exit, setExit] = useState<[number, number]>(asPct(route.exit.center_pct));
  const [entry, setEntry] = useState<[number, number]>(asPct(route.entry.center_pct));

  const Frame = ({ slug, pct, set, label, hint, color }: {
    slug: string; pct: [number, number]; set: (p: [number, number]) => void;
    label: string; hint: string; color: string;
  }) => (
    <div className="flex-1 space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-gray-800">{label}</span>
        <span className="truncate text-[11px] text-gray-500">{shortName(slug)}</span>
      </div>
      <button type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                set([
                  Math.round(((e.clientX - r.left) / r.width) * 1000) / 10,
                  Math.round(((e.clientY - r.top) / r.height) * 1000) / 10,
                ]);
              }}
              className="relative block w-full cursor-crosshair overflow-hidden rounded border border-gray-300"
              style={{ aspectRatio: '16 / 9' }}>
        {urlOf(slug)
          ? <img src={posterUrl(slug)} alt={slug} className="h-full w-full object-cover" draggable={false} />
          : <span className="grid h-full w-full place-items-center bg-gray-200 text-[11px] text-gray-500">no mp4</span>}
        <span className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${pct[0]}%`, top: `${pct[1]}%`, background: color }} />
      </button>
      <div className="text-[10px] text-gray-500">{hint} · [{pct[0]}, {pct[1]}]</div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[300] grid place-items-center bg-black/50 p-6" onClick={onClose}>
      <div className="w-full max-w-3xl space-y-3 rounded-xl bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-sm font-semibold text-gray-800">📍 Transition points</div>
          <div className="text-[11px] text-gray-500">
            Click the frames: where the character exits and where they enter.
          </div>
        </div>
        <div className="flex gap-4">
          <Frame slug={route.from} pct={exit} set={setExit} label="① Exit" color="#ef4444"
                 hint="leaves the frame at this point" />
          <Frame slug={route.to} pct={entry} set={setEntry} label="② Entry" color="#22c55e"
                 hint="enters the frame at this point" />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
                  className="rounded border border-gray-300 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-100">
            later
          </button>
          <button type="button" onClick={() => onApply(exit, entry)}
                  className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700">
            done
          </button>
        </div>
      </div>
    </div>
  );
}

// --- canvas ------------------------------------------------------------------

function Inner({
  world, graph, clusterTitle, onClose, onSaved,
}: {
  world: string;
  graph: RelationWorldGraph;
  clusterTitle: (key: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const rf = useReactFlow();
  const clusterOf = useMemo(
    () => new Map(graph.nodes.map((n) => [n.slug, n.cluster || 'all'])),
    [graph.nodes],
  );
  const clusterKeys = useMemo(() => {
    const declared = Object.keys(graph.clusters ?? {});
    const used = [...new Set(graph.nodes.map((n) => n.cluster || 'all'))];
    return [...declared.filter((k) => used.includes(k)), ...used.filter((k) => !declared.includes(k))];
  }, [graph]);

  /** saved absolute positions; districts that were laid out separately get
   *  translated into their own lane the first time this canvas opens */
  const initial = useMemo(() => {
    const saved = new Map<string, Pos>();
    for (const n of graph.nodes) if (n.ui) saved.set(n.slug, n.ui);
    const fallback = autoLayout(graph.nodes, graph.routes, clusterKeys);
    let pos: Map<string, Pos>;
    let didMigrate = false;
    if (saved.size < graph.nodes.length / 2) {
      pos = fallback;
    } else if (hasCrossDistrictOverlap(graph.nodes, saved)) {
      // every old per-district editor laid its cards out from the same origin,
      // so on one board they would pile up — spread the blocks apart instead
      pos = repackExisting(graph.nodes, saved, clusterKeys);
      didMigrate = true;
    } else {
      pos = saved;
    }
    const nodes: Node[] = graph.nodes.map((n) => ({
      id: n.slug,
      type: 'bg',
      position: pos.get(n.slug) ?? fallback.get(n.slug) ?? { x: 0, y: 0 },
      data: {
        slug: n.slug, url: n.url, tod: n.tod, indoor: n.indoor,
        cluster: n.cluster || 'all', island: false, onPath: false, dimmed: false, probe: null,
      } satisfies BgNodeData,
    }));
    return { nodes, didMigrate };
  }, [graph, clusterKeys]);

  const initialNodes = initial.nodes;
  /** the "we just merged your district boards" notice, until it's acted on */
  const [bannerOff, setBannerOff] = useState(false);
  const migrated = initial.didMigrate && !bannerOff;

  const initialEdges = useMemo<Edge[]>(() => {
    const posOf = new Map(initialNodes.map((n) => [n.id, n.position]));
    return graph.routes.map((r) => {
      const s = anchorSides(posOf.get(r.from) ?? { x: 0, y: 0 }, posOf.get(r.to) ?? { x: 0, y: 0 });
      return {
        id: r.id, source: r.from, target: r.to,
        sourceHandle: s.s, targetHandle: s.t,
        reconnectable: true, data: { route: { ...r } },
      } as Edge;
    });
  }, [graph.routes, initialNodes]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const baseRoutes = useRef<RelationRoute[]>(graph.routes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [mode, setMode] = useState<'edit' | 'path'>('edit');
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const [pointEdgeId, setPointEdgeId] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });

  // live audit — recomputed from the routes actually on the canvas, so fixing
  // an island updates the banner before you even save
  const liveRoutes = useMemo(
    () => edges.map((e) => (e.data as { route: RelationRoute }).route),
    [edges],
  );
  const audit: WorldAudit = useMemo(
    () => auditWorld(graph.nodes, liveRoutes),
    [graph.nodes, liveRoutes],
  );
  const islandSlugs = useMemo(
    () => new Set(audit.components.slice(1).flat()),
    [audit],
  );

  const pathResult = useMemo(() => {
    if (!probe.from || !probe.to) return null;
    return shortestPath(probe.from, probe.to, directedAdj(liveRoutes));
  }, [probe, liveRoutes]);
  const pathNodeSet = useMemo(() => new Set(pathResult ?? []), [pathResult]);
  const pathEdgeSet = useMemo(() => {
    const s = new Set<string>();
    if (!pathResult) return s;
    for (let i = 0; i < pathResult.length - 1; i++) {
      const a = pathResult[i], b = pathResult[i + 1];
      const hit = liveRoutes.find(
        (r) => (r.from === a && r.to === b) || (r.bidirectional && r.from === b && r.to === a),
      );
      if (hit) s.add(hit.id);
    }
    return s;
  }, [pathResult, liveRoutes]);

  // --- derived display (positions live in state; looks are computed) ---------

  const districtNodes = useMemo<Node[]>(() => {
    const posOf = new Map(nodes.map((n) => [n.id, n.position]));
    const out: Node[] = [];
    clusterKeys.forEach((key, i) => {
      const members = graph.nodes.filter((n) => (n.cluster || 'all') === key).map((n) => n.slug);
      const box = districtBox(members, posOf);
      if (!box) return;
      out.push({
        id: `district-${key}`,
        type: 'district',
        position: { x: box.x, y: box.y },
        style: { width: box.width, height: box.height },
        draggable: false, selectable: false, focusable: false, zIndex: -1,
        data: {
          title: clusterTitle(key), count: members.length,
          tint: DISTRICT_TINTS[i % DISTRICT_TINTS.length],
          island: members.length > 0 && members.every((m) => islandSlugs.has(m)),
        } satisfies DistrictNodeData,
      });
    });
    return out;
  }, [nodes, graph.nodes, clusterKeys, clusterTitle, islandSlugs]);

  const displayNodes = useMemo<Node[]>(() => [
    ...districtNodes,
    ...nodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as BgNodeData),
        island: islandSlugs.has(n.id),
        onPath: pathNodeSet.has(n.id),
        dimmed: pathResult != null && !pathNodeSet.has(n.id),
        probe: probe.from === n.id ? 'from' : probe.to === n.id ? 'to' : null,
      } satisfies BgNodeData,
    })),
  ], [districtNodes, nodes, islandSlugs, pathNodeSet, pathResult, probe]);

  const displayEdges = useMemo<Edge[]>(() => edges.map((e) => {
    const route = (e.data as { route: RelationRoute }).route;
    const m = KIND_META[kindOfRoute(route)];
    const onPath = pathEdgeSet.has(e.id);
    const sel = e.id === selEdgeId;
    const stroke = onPath ? '#f59e0b' : m.stroke;
    return {
      ...e,
      animated: onPath,
      style: {
        stroke,
        strokeWidth: onPath ? 4 : sel ? 4 : 2.5,
        strokeDasharray: m.dash,
        opacity: pathResult != null && !onPath ? 0.12 : 1,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
    };
  }), [edges, selEdgeId, pathEdgeSet, pathResult]);

  // --- interactions ---------------------------------------------------------

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const id = `edit_${conn.source.replace(/_live$/, '')}__${conn.target.replace(/_live$/, '')}_${Math.random().toString(36).slice(2, 6)}`;
    const route: RelationRoute = {
      id, from: conn.source, to: conn.target, bidirectional: true,
      relation: 'path', portal: 'walkway', exit: DEFAULT_ENDPOINT(), entry: DEFAULT_ENDPOINT(),
    };
    setEdges((es) => addEdge({ ...conn, id, reconnectable: true, data: { route } } as Edge, es));
    setSelEdgeId(id);
    setSelNode(null);
    setPointEdgeId(id); // straight into the point picker — that IS the path
    setDirty(true);
  }, [setEdges]);

  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    setEdges((es) => reconnectEdge(oldEdge, conn, es, { shouldReplaceId: false }).map((e) => {
      if (e.id !== oldEdge.id) return e;
      const old = (e.data as { route: RelationRoute }).route;
      return { ...e, data: { route: {
        ...old, from: conn.source!, to: conn.target!,
        // an endpoint moved to a DIFFERENT bg keeps nothing: its zones /
        // center_pct / landmarks described the old background's frame
        exit: conn.source === old.from ? old.exit : DEFAULT_ENDPOINT(),
        entry: conn.target === old.to ? old.entry : DEFAULT_ENDPOINT(),
      } } };
    }));
    setDirty(true);
  }, [setEdges]);

  const patchRoute = (id: string, patch: (r: RelationRoute) => RelationRoute) => {
    setEdges((es) => es.map((e) =>
      e.id === id ? { ...e, data: { route: patch((e.data as { route: RelationRoute }).route) } } : e));
    setDirty(true);
  };

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    if (n.type !== 'bg') return;
    if (mode === 'path') {
      setProbe((p) => (!p.from || (p.from && p.to) ? { from: n.id, to: null } : { from: p.from, to: n.id }));
      return;
    }
    setSelNode(n.id);
    setSelEdgeId(null);
  }, [mode]);

  const runAutoLayout = () => {
    if (!window.confirm('Re-arrange the whole world? The layout you dragged by hand will be lost.')) return;
    const pos = autoLayout(graph.nodes, liveRoutes, clusterKeys);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    setDirty(true);
    setBannerOff(true);
    setTimeout(() => rf.fitView({ padding: 0.12, duration: 400 }), 30);
  };

  const zoomTo = (slugs: string[]) => {
    if (!slugs.length) return;
    rf.fitView({ nodes: slugs.map((id) => ({ id })), padding: 0.35, duration: 500 });
  };

  // --- persistence ----------------------------------------------------------

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const ui: Record<string, Pos> = {};
      for (const n of nodes) ui[n.id] = { x: n.position.x, y: n.position.y };
      const saved = await apiV4.saveRelationGraph(world, { routes: liveRoutes, ui });
      baseRoutes.current = saved.routes;
      setDirty(false);
      setBannerOff(true);
      setInSync(false); // live sidecar just changed — engine channel is now behind
      onSaved();
    } catch (e) {
      setSaveErr(String((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? e));
    } finally {
      setSaving(false);
    }
  };

  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [inSync, setInSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiV4.getEngineSync(world)
      .then((s) => { if (alive) { setSyncedAt(s.synced_at); setInSync(s.in_sync); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [world]);

  const syncToEngine = async () => {
    if (!window.confirm('Publish the graph to the engine channel? Later story generations will use this version.')) return;
    setSyncing(true);
    setSyncErr(null);
    try {
      const r = await apiV4.syncEngine(world);
      setSyncedAt(r.synced_at);
      setInSync(true);
    } catch (e) {
      setSyncErr(String((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? e));
    } finally {
      setSyncing(false);
    }
  };

  const close = useCallback(() => {
    if (dirty && !window.confirm('There are unsaved changes — close anyway?')) return;
    onClose();
  }, [dirty, onClose]);

  /** the bg popup's transitions tab writes endpoints straight to the sidecar —
   *  pull them back so a later canvas save can't clobber those edits */
  const closeEditPopup = useCallback(() => {
    setEditSlug(null);
    apiV4.getRelationGraph(world).then((fresh) => {
      baseRoutes.current = fresh.routes;
      const byId = new Map(fresh.routes.map((r) => [r.id, r]));
      setEdges((es) => es.map((e) => {
        const route = (e.data as { route: RelationRoute }).route;
        const f = byId.get(route.id);
        if (!f || f.from !== route.from || f.to !== route.to) return e;
        return { ...e, data: { route: { ...route, exit: f.exit, entry: f.entry } } };
      }));
      onSaved();
    }).catch(() => {});
  }, [world, setEdges, onSaved]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (editSlug) closeEditPopup();
      else if (pointEdgeId) setPointEdgeId(null);
      else if (selEdgeId || selNode) { setSelEdgeId(null); setSelNode(null); }
      else if (probe.from) setProbe({ from: null, to: null });
      else close();
    };
    window.addEventListener('keydown', h, { capture: true });
    return () => window.removeEventListener('keydown', h, { capture: true });
  }, [editSlug, pointEdgeId, selEdgeId, selNode, probe, close, closeEditPopup]);

  const selRoute = (edges.find((e) => e.id === selEdgeId)?.data as { route?: RelationRoute } | undefined)?.route ?? null;
  const pointRoute = (edges.find((e) => e.id === pointEdgeId)?.data as { route?: RelationRoute } | undefined)?.route ?? null;
  const selNodeMeta = graph.nodes.find((n) => n.slug === selNode) ?? null;
  const urlOf = (slug: string) => graph.nodes.find((n) => n.slug === slug)?.url ?? null;

  const Chip = ({ tone, children, onClick, title }: {
    tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode; onClick?: () => void; title?: string;
  }) => (
    <button type="button" onClick={onClick} title={title} disabled={!onClick}
            className={['rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
              tone === 'ok' ? 'bg-emerald-50 text-emerald-700'
                : tone === 'warn' ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                  : 'bg-red-50 text-red-700 hover:bg-red-100',
              onClick ? 'cursor-pointer' : 'cursor-default'].join(' ')}>
      {children}
    </button>
  );

  // Portalled to <body>: this is a fullscreen surface, so it must not inherit
  // layout from wherever it happens to be mounted. Rendered in place, the
  // parent <section className="space-y-2"> handed it a margin-top of 8px —
  // enough to leave a dead strip along the top edge and shrink the board.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-gray-50">
      <style>{`
        .wg-node .wg-port { opacity: 0; transition: opacity .15s ease; }
        .wg-node:hover .wg-port { opacity: 1; }
        .react-flow__edge { cursor: pointer; }
        .react-flow__handle { border: none; }
      `}</style>

      {/* ── ONE top bar ── */}
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <span className="shrink-0 text-sm font-semibold text-gray-800">
          🗺 {world.replace(/_/g, ' ')}
          <span className="ml-2 font-normal text-gray-400">
            {graph.nodes.length} bg · {edges.length} relation · {clusterKeys.length} district
          </span>
        </span>

        <div className="flex shrink-0 overflow-hidden rounded border border-gray-300 text-[12px]">
          {([['edit', '✏️ edit'], ['path', '🧭 path']] as const).map(([m, label]) => (
            <button key={m} type="button"
                    onClick={() => { setMode(m); setProbe({ from: null, to: null }); }}
                    className={mode === m ? 'bg-blue-600 px-3 py-1 font-medium text-white' : 'px-3 py-1 text-gray-600 hover:bg-gray-100'}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {audit.problemCount === 0
            ? <Chip tone="ok">🟢 graph intact</Chip>
            : <>
                {audit.components.length > 1 && (
                  <Chip tone="bad" onClick={() => zoomTo([...islandSlugs])}
                        title="piece cut off from the world — the engine can't find a path there">
                    🏝 {audit.components.length - 1} disconnected pieces ({islandSlugs.size} bg)
                  </Chip>
                )}
                {audit.orphans.length > 0 && (
                  <Chip tone="bad" onClick={() => zoomTo(audit.orphans)} title="no relations at all">
                    ⛔ {audit.orphans.length} orphans
                  </Chip>
                )}
                {audit.deadEnds.length > 0 && (
                  <Chip tone="warn" onClick={() => zoomTo(audit.deadEnds)} title="has an entry, no exit">
                    🚪 {audit.deadEnds.length} dead ends
                  </Chip>
                )}
                {audit.todMismatch.length > 0 && (
                  <Chip tone="warn"
                        onClick={() => zoomTo(audit.todMismatch.flatMap((t) => [t.route.from, t.route.to]))}
                        title="adjoining places, but different times">
                    🕑 {audit.todMismatch.length} time mismatches
                  </Chip>
                )}
              </>}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {saveErr && <span className="max-w-[240px] truncate text-[11px] text-red-600" title={saveErr}>{saveErr}</span>}
          {syncErr && <span className="max-w-[240px] truncate text-[11px] text-red-600" title={syncErr}>{syncErr}</span>}
          {dirty && !saveErr && <span className="text-[11px] text-amber-600">unsaved</span>}
          <span className="text-[11px] text-gray-400" title="last version published to the engine channel">
            {inSync ? '🟢 in sync' : syncedAt ? `🟡 ${new Date(syncedAt).toLocaleDateString()}` : '⚪ no sync'}
          </span>
          <button type="button" onClick={runAutoLayout} title="re-arrange the whole world"
                  className="rounded border border-gray-300 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-100">
            ⌗ arrange
          </button>
          <button type="button" onClick={save} disabled={saving || !dirty}
                  className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {saving ? 'saving…' : '💾 save'}
          </button>
          <button type="button" onClick={syncToEngine} disabled={syncing || dirty || inSync}
                  title={dirty ? 'save first' : inSync ? 'already on this version' : 'publish to the engine channel'}
                  className="rounded bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            {syncing ? 'sync…' : "⚙️ sync"}
          </button>
          <button type="button" onClick={close}
                  className="rounded border border-gray-300 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-100">
            ✕
          </button>
        </div>
      </div>

      {migrated && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800">
          ℹ️ Districts were placed on one map for the first time — inner layout kept, only the blocks were split apart.
          <b>Save</b> or re-arrange them with <b>⌗ arrange</b>.
        </div>
      )}

      <div className="relative flex-1">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(ch) => {
            onNodesChange(ch.filter((c) => !('id' in c) || !String(c.id).startsWith('district-')));
            if (ch.some((c) => c.type === 'position')) setDirty(true);
          }}
          onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === 'remove')) setDirty(true); }}
          onConnect={onConnect}
          onReconnect={onReconnect}
          connectionMode={ConnectionMode.Loose}
          connectionLineStyle={{ stroke: '#f59e0b', strokeWidth: 3, strokeDasharray: '8 5' }}
          onEdgeClick={(_, e) => { if (mode === 'edit') { setSelEdgeId(e.id); setSelNode(null); } }}
          onPaneClick={() => { setSelEdgeId(null); setSelNode(null); }}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_, n) => { if (n.type === 'bg' && (n.data as BgNodeData).url) setEditSlug(n.id); }}
          onBeforeDelete={async ({ edges: delEdges }) =>
            // deleting a NODE must not silently wipe its arrows
            ({ nodes: [], edges: delEdges.filter((e) => e.selected) })}
          deleteKeyCode={['Delete', 'Backspace']}
          nodesConnectable={mode === 'edit'}
          elementsSelectable={mode === 'edit'}
          onError={(code, msg) => console.error('[rf]', code, msg)}
          snapToGrid snapGrid={[16, 16]}
          fitView fitViewOptions={{ padding: 0.12 }}
          minZoom={0.08}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#d8dbe0" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable
                   nodeColor={(n) => n.type === 'district' ? 'transparent'
                     : islandSlugs.has(n.id) ? '#f87171'
                       : pathNodeSet.has(n.id) ? '#f59e0b' : '#93c5fd'} />
        </ReactFlow>

        {/* ── ONE contextual panel ── */}
        <div className="absolute right-4 top-4 z-10 w-[290px] space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
          {mode === 'path' ? (
            <>
              <div className="text-[12px] font-semibold text-gray-700">🧭 Path check</div>
              <div className="text-[11px] leading-snug text-gray-500">
                {!probe.from ? 'Click the starting background (A).'
                  : !probe.to ? 'Now click the destination background (B).'
                    : pathResult ? `${pathResult.length - 1} step${pathResult.length === 2 ? '' : 's'}` : 'No path — these two aren\'t connected.'}
              </div>
              {probe.from && (
                <div className="space-y-1">
                  {pathResult
                    ? pathResult.map((s, i) => (
                        <div key={s} className="flex items-center gap-2 text-[11px] text-gray-700">
                          <span className="w-4 shrink-0 text-right text-gray-400">{i + 1}</span>
                          <span className="truncate">{shortName(s)}</span>
                        </div>
                      ))
                    : probe.to && (
                        <div className="rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                          ⛔ no route from <b>{shortName(probe.from)}</b> to <b>{shortName(probe.to)}</b>.
                        </div>
                      )}
                  <button type="button" onClick={() => setProbe({ from: null, to: null })}
                          className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
                    clear
                  </button>
                </div>
              )}
            </>
          ) : selRoute ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-gray-700">Arrow</span>
                <button type="button" className="text-[11px] text-gray-400 hover:text-gray-600"
                        onClick={() => setSelEdgeId(null)}>✕</button>
              </div>
              <div className="truncate text-[11px] text-gray-500">
                <b>{shortName(selRoute.from)}</b> → <b>{shortName(selRoute.to)}</b>
              </div>
              <div className="space-y-1">
                {(Object.keys(KIND_META) as EditorKind[]).map((k) => {
                  const m = KIND_META[k];
                  const on = kindOfRoute(selRoute) === k;
                  return (
                    <button key={k} type="button"
                            onClick={() => { if (!on) patchRoute(selRoute.id, (r) => applyKind(r, k)); }}
                            className={['flex w-full items-baseline gap-2 rounded border px-2 py-1.5 text-left',
                              on ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'].join(' ')}>
                      <span className="shrink-0 text-[12px] font-medium">{m.label}</span>
                      <span className="text-[10px] leading-tight text-gray-500">{m.desc}</span>
                    </button>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-gray-600">
                <input type="checkbox" checked={selRoute.bidirectional}
                       onChange={(ev) => patchRoute(selRoute.id, (r) => ({ ...r, bidirectional: ev.target.checked }))} />
                bidirectional (⇄)
              </label>
              <button type="button" onClick={() => setPointEdgeId(selRoute.id)}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50">
                📍 transition points — [{selRoute.exit.center_pct?.[0] ?? 50}, {selRoute.exit.center_pct?.[1] ?? 60}]
                → [{selRoute.entry.center_pct?.[0] ?? 50}, {selRoute.entry.center_pct?.[1] ?? 60}]
              </button>
              <button type="button"
                      onClick={() => { setEdges((es) => es.filter((e) => e.id !== selRoute.id)); setSelEdgeId(null); setDirty(true); }}
                      className="w-full rounded border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">
                🗑 delete arrow
              </button>
            </>
          ) : selNodeMeta ? (
            <>
              <div className="flex items-center justify-between">
                <span className="truncate text-[12px] font-semibold text-gray-700">{shortName(selNodeMeta.slug)}</span>
                <button type="button" className="text-[11px] text-gray-400 hover:text-gray-600"
                        onClick={() => setSelNode(null)}>✕</button>
              </div>
              <div className="overflow-hidden rounded" style={{ aspectRatio: '16 / 9' }}>
                {selNodeMeta.url
                  ? <img src={posterUrl(selNodeMeta.slug)} alt={selNodeMeta.slug} className="h-full w-full object-cover" />
                  : <div className="grid h-full place-items-center bg-gray-200 text-[11px] text-gray-500">no mp4</div>}
              </div>
              <div className="text-[11px] text-gray-500">
                {TOD_META[selNodeMeta.tod]?.icon} {selNodeMeta.tod} · {selNodeMeta.indoor ? 'indoors' : 'outdoors'} ·{' '}
                {clusterTitle(clusterOf.get(selNodeMeta.slug) ?? 'all')}
              </div>
              {islandSlugs.has(selNodeMeta.slug) && (
                <div className="rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                  🏝 This background is cut off from the rest of the world — draw a path to it.
                </div>
              )}
              <div className="space-y-0.5">
                {liveRoutes.filter((r) => r.from === selNodeMeta.slug || r.to === selNodeMeta.slug).map((r) => (
                  <button key={r.id} type="button" onClick={() => { setSelEdgeId(r.id); setSelNode(null); }}
                          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-gray-700 hover:bg-gray-50">
                    <span className="shrink-0">{r.portal === 'edge' ? '🌫' : '🔗'}</span>
                    <span className="shrink-0 text-gray-400">{r.from === selNodeMeta.slug ? '→' : '←'}</span>
                    <span className="truncate">{shortName(r.from === selNodeMeta.slug ? r.to : r.from)}</span>
                  </button>
                ))}
                {!liveRoutes.some((r) => r.from === selNodeMeta.slug || r.to === selNodeMeta.slug) && (
                  <div className="text-[11px] text-gray-400">no relation</div>
                )}
              </div>
              <button type="button" onClick={() => selNodeMeta.url && setEditSlug(selNodeMeta.slug)}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50">
                ✏️ edit background
              </button>
            </>
          ) : (
            <>
              <div className="text-[12px] font-semibold text-gray-700">World status</div>
              {audit.problemCount === 0 ? (
                <div className="rounded bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700">
                  🟢 Every background is connected — the engine can find a path anywhere.
                </div>
              ) : (
                <div className="space-y-1.5 text-[11px]">
                  {audit.components.length > 1 && (
                    <div className="rounded bg-red-50 px-2 py-1.5 text-red-700">
                      <b>🏝 {audit.components.length - 1} disconnected piece.</b> The engine can't find a path to these backgrounds.
                      {audit.components.slice(1).map((c, i) => (
                        <button key={i} type="button" onClick={() => zoomTo(c)}
                                className="mt-1 block w-full truncate rounded bg-white/70 px-1.5 py-1 text-left hover:bg-white">
                          {c.length} bg: {c.map(shortName).join(', ')}
                        </button>
                      ))}
                    </div>
                  )}
                  {audit.deadEnds.length > 0 && (
                    <div className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
                      <b>🚪 dead end:</b> {audit.deadEnds.map(shortName).join(', ')}
                    </div>
                  )}
                  {audit.todMismatch.length > 0 && (
                    <div className="rounded bg-amber-50 px-2 py-1.5 text-amber-800">
                      <b>🕑 time mismatch</b> (adjoining, but different time of day):
                      {audit.todMismatch.map((t) => (
                        <button key={t.route.id} type="button" onClick={() => { setSelEdgeId(t.route.id); }}
                                className="mt-1 block w-full truncate rounded bg-white/70 px-1.5 py-1 text-left hover:bg-white">
                          {shortName(t.route.from)} ({t.fromTod}) → {shortName(t.route.to)} ({t.toTod})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="border-t pt-2 text-[10px] leading-relaxed text-gray-400">
                drag the card · drag from its edge = new arrow · drag an arrow tip = reconnect<br />
                single click = details · double click = edit background
              </div>
            </>
          )}
        </div>
      </div>

      {pointRoute && (
        <PortalPointModal
          route={pointRoute}
          urlOf={urlOf}
          onClose={() => setPointEdgeId(null)}
          onApply={(exit, entry) => {
            patchRoute(pointRoute.id, (r) => ({
              ...r,
              exit: { ...r.exit, center_pct: exit },
              entry: { ...r.entry, center_pct: entry },
            }));
            setPointEdgeId(null);
          }}
        />
      )}

      {editSlug && (
        <div className="fixed inset-0 z-[200] bg-black/60 p-4 md:p-8">
          <div className="relative h-full w-full overflow-hidden rounded-lg bg-white shadow-2xl">
            <button type="button" onClick={closeEditPopup}
                    className="absolute right-3 top-3 z-10 rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 shadow hover:bg-gray-100">
              ✕ close (Esc)
            </button>
            <iframe src={`/videos/${encodeURIComponent(editSlug)}?embed=1${NO_VIDEO ? '&novideo=1' : ''}`}
                    title={`edit ${editSlug}`}
                    className="h-full w-full"
                    onLoad={(e) => {
                      try {
                        e.currentTarget.contentWindow?.addEventListener('keydown', (ke) => {
                          if (ke.key === 'Escape') closeEditPopup();
                        });
                      } catch { /* cross-origin guard — never expected here */ }
                    }} />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

export default function WorldGraphCanvas(props: {
  world: string;
  graph: RelationWorldGraph;
  clusterTitle: (key: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
