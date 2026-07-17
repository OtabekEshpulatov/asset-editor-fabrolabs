import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  addEdge,
  reconnectEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { apiV4, type RelationRoute, type RelationWorldGraph } from '../api';

/** ?novideo=1 — debug/slow-link mode (kept local to avoid a circular import) */
const NO_VIDEO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('novideo');

/**
 * Live BG v3 — fullscreen GRAPH EDITOR for one district (Lucidchart-style):
 * - drag cards anywhere; positions are saved per background (node.ui).
 * - drag from a port dot on a card's edge to another card = new arrow;
 *   drag an existing arrow's endpoint onto a different card = rewire it.
 * - click an arrow → small panel: type (yo'l/eshik/vista/transport),
 *   direction, delete.
 * - click a card → popup with the ORIGINAL live-bg editor (/videos/:slug).
 * - cross-district neighbors appear as amber "ghost" cards so gateway
 *   arrows can be rewired here too; their positions are not persisted.
 */

const CARD = 190;
const THUMB_W = 176;
const THUMB_H = 99;

type EditorKind = 'path' | 'enter' | 'vista' | 'vehicle';

const KIND_META: Record<EditorKind, { label: string; stroke: string; dash?: string; icon?: string }> = {
  path: { label: "🚶 yo'l (path)", stroke: '#9ca3af' },
  enter: { label: '🚪 eshik (enter)', stroke: '#d97706', icon: '🚪' },
  vista: { label: '👁 vista', stroke: '#0d9488', dash: '7 5', icon: '👁' },
  vehicle: { label: '🚀 transport', stroke: '#7c3aed', dash: '2 4', icon: '🚀' },
};

function kindOfRoute(r: RelationRoute): EditorKind {
  if (r.relation === 'enter') return 'enter';
  if (r.portal === 'vista') return 'vista';
  if (r.portal === 'vehicle') return 'vehicle';
  return 'path';
}

function applyKind(r: RelationRoute, kind: EditorKind): RelationRoute {
  // keep a compatible existing portal kind (arch/gate/stair/edge…) instead of clobbering it
  if (kind === 'enter')
    return { ...r, relation: 'enter', portal: ['door', 'arch', 'gate', 'stair'].includes(r.portal) ? r.portal : 'door' };
  if (kind === 'vista') return { ...r, relation: 'path', portal: 'vista' };
  if (kind === 'vehicle') return { ...r, relation: 'path', portal: 'vehicle' };
  return { ...r, relation: 'path', portal: ['walkway', 'edge'].includes(r.portal) ? r.portal : 'walkway' };
}

const DEFAULT_ENDPOINT = () => ({
  zone: 'mid', screen_zone: 'mid_center', center_pct: [50, 60] as [number, number], landmark_ids: [] as string[],
});

function edgeVisual(r: RelationRoute, selected: boolean): Partial<Edge> {
  const m = KIND_META[kindOfRoute(r)];
  return {
    style: { stroke: m.stroke, strokeWidth: selected ? 4 : 2.5, strokeDasharray: m.dash },
    markerEnd: { type: MarkerType.ArrowClosed, color: m.stroke, width: 18, height: 18 },
    markerStart: r.bidirectional
      ? { type: MarkerType.ArrowClosed, color: m.stroke, width: 18, height: 18 }
      : undefined,
    label: m.icon,
    labelStyle: { fontSize: 14 },
    labelBgStyle: { fillOpacity: 0 },
  };
}

function shortName(slug: string): string {
  return slug.replace(/_live$/, '').replace(/^[a-z]+_/, '').replace(/_/g, ' ');
}

type BgNodeData = {
  slug: string;
  url: string | null;
  tod: string;
  indoor: boolean;
  ghost: boolean;
  districtLabel?: string;
};

function BgNode({ data }: NodeProps) {
  const d = data as BgNodeData;
  const handleCls = 'rge-port !h-3 !w-3 !border-2 !border-white !bg-blue-500';
  return (
    <div
      className={[
        'rge-node flex flex-col items-center gap-1 rounded-lg p-1.5 shadow-md',
        d.ghost
          ? 'border-2 border-dashed border-amber-400 bg-amber-50'
          : 'border border-gray-300 bg-white',
      ].join(' ')}
      style={{ width: CARD }}
      onMouseEnter={(e) => e.currentTarget.querySelector('video')?.play().catch(() => {})}
      onMouseLeave={(e) => e.currentTarget.querySelector('video')?.pause()}
    >
      <div className="pointer-events-none relative overflow-hidden rounded">
        {NO_VIDEO && d.url ? (
          <div className="grid place-items-center bg-emerald-100 text-emerald-700"
               style={{ width: THUMB_W, height: THUMB_H }}>🎞</div>
        ) : d.url ? (
          <video src={`${d.url}#t=0.04`} muted loop playsInline preload="metadata"
                 className="bg-gray-100 object-cover" style={{ width: THUMB_W, height: THUMB_H }} />
        ) : (
          <div className="grid place-items-center bg-gray-200 text-[10px] text-gray-500"
               style={{ width: THUMB_W, height: THUMB_H }}>no mp4</div>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[10px] text-white">
          {d.tod === 'night' ? '🌙' : d.tod === 'dusk' ? '🌆' : '☀️'}{d.indoor ? ' ■' : ''}
        </span>
      </div>
      <span className={`w-full truncate text-center text-[11px] leading-tight ${d.ghost ? 'font-medium text-amber-900' : 'text-gray-700'}`}>
        {shortName(d.slug)}
      </span>
      {d.ghost && (
        <span className="w-full truncate text-center text-[10px] leading-tight text-amber-600">
          {d.districtLabel}
        </span>
      )}
      <Handle id="t" type="source" position={Position.Top} className={handleCls} />
      <Handle id="r" type="source" position={Position.Right} className={handleCls} />
      <Handle id="b" type="source" position={Position.Bottom} className={handleCls} />
      <Handle id="l" type="source" position={Position.Left} className={handleCls} />
    </div>
  );
}

const NODE_TYPES = { bg: BgNode };

/** pick sensible anchor sides for an initial edge from relative positions */
function anchorSides(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { s: 'r', t: 'l' } : { s: 'l', t: 'r' };
  }
  return dy >= 0 ? { s: 'b', t: 't' } : { s: 't', t: 'b' };
}

export default function RelationGraphEditor({
  world,
  district,
  graph,
  clusterTitle,
  onClose,
  onSaved,
}: {
  world: string;
  district: string;
  graph: RelationWorldGraph;
  clusterTitle: (key: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const members = useMemo(
    () => graph.nodes.filter((n) => (n.cluster || 'all') === district),
    [graph, district],
  );
  const memberSet = useMemo(() => new Set(members.map((m) => m.slug)), [members]);

  const ghostSlugs = useMemo(() => {
    const out = new Set<string>();
    for (const r of graph.routes) {
      if (memberSet.has(r.from) && !memberSet.has(r.to)) out.add(r.to);
      if (memberSet.has(r.to) && !memberSet.has(r.from)) out.add(r.from);
    }
    return out;
  }, [graph, memberSet]);

  // every route among the VISIBLE cards (members + ghosts) — including
  // ghost↔ghost ones, so existing relations are never invisible here
  const shownRoutes = useMemo(() => {
    const vis = new Set([...memberSet, ...ghostSlugs]);
    return graph.routes.filter((r) => vis.has(r.from) && vis.has(r.to));
  }, [graph, memberSet, ghostSlugs]);

  // simple layered fallback for cards never positioned before
  const fallbackPos = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const depth = new Map<string, number>(members.map((m) => [m.slug, 0]));
    const inner = graph.routes.filter((r) => memberSet.has(r.from) && memberSet.has(r.to));
    for (let i = 0; i < members.length; i++) {
      let changed = false;
      for (const r of inner) {
        const d = (depth.get(r.from) ?? 0) + 1;
        if (d > (depth.get(r.to) ?? 0)) { depth.set(r.to, d); changed = true; }
      }
      if (!changed) break;
    }
    const cols = new Map<number, number>();
    for (const m of members) {
      const d = depth.get(m.slug) ?? 0;
      const row = cols.get(d) ?? 0;
      cols.set(d, row + 1);
      pos.set(m.slug, { x: 80 + d * 320, y: 60 + row * 210 });
    }
    return pos;
  }, [members, graph, memberSet]);

  const initialNodes: Node[] = useMemo(() => {
    const out: Node[] = members.map((m) => ({
      id: m.slug,
      type: 'bg',
      position: m.ui ?? fallbackPos.get(m.slug) ?? { x: 80, y: 60 },
      data: { slug: m.slug, url: m.url, tod: m.tod, indoor: m.indoor, ghost: false } satisfies BgNodeData,
    }));
    const maxX = Math.max(80, ...out.map((n) => n.position.x));
    [...ghostSlugs].forEach((slug, i) => {
      const n = graph.nodes.find((x) => x.slug === slug);
      if (!n) return;
      out.push({
        id: slug,
        type: 'bg',
        position: { x: maxX + 380, y: 60 + i * 210 },
        data: {
          slug, url: n.url, tod: n.tod, indoor: n.indoor, ghost: true,
          districtLabel: clusterTitle(n.cluster || 'all'),
        } satisfies BgNodeData,
      });
    });
    return out;
  }, [members, ghostSlugs, graph, fallbackPos, clusterTitle]);

  const initialEdges: Edge[] = useMemo(() => {
    const posOf = new Map(initialNodes.map((n) => [n.id, n.position]));
    return shownRoutes.map((r) => {
      const sides = anchorSides(posOf.get(r.from) ?? { x: 0, y: 0 }, posOf.get(r.to) ?? { x: 0, y: 0 });
      return {
        id: r.id,
        source: r.from,
        target: r.to,
        sourceHandle: sides.s,
        targetHandle: sides.t,
        reconnectable: true,
        data: { route: { ...r } },
        ...edgeVisual(r, false),
      } as Edge;
    });
  }, [shownRoutes, initialNodes]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  // merge bookkeeping for save(): base = last KNOWN server route list (refreshed
  // from each save response); owned = every route id this editor ever held —
  // absent-from-canvas owned ids mean the user deleted them.
  const baseRoutes = useRef<RelationRoute[]>(graph.routes);
  const ownedIds = useRef<Set<string>>(new Set(shownRoutes.map((r) => r.id)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState<string | null>(null);

  const selEdge = edges.find((e) => e.id === selEdgeId) ?? null;
  const selRoute = (selEdge?.data as { route?: RelationRoute } | undefined)?.route ?? null;

  const restyle = (es: Edge[], selId: string | null) =>
    es.map((e) => ({
      ...e,
      ...edgeVisual((e.data as { route: RelationRoute }).route, e.id === selId),
    }));

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const id = `edit_${conn.source.replace(/_live$/, '')}__${conn.target.replace(/_live$/, '')}_${Math.random().toString(36).slice(2, 6)}`;
    const route: RelationRoute = {
      id,
      from: conn.source,
      to: conn.target,
      bidirectional: true,
      relation: 'path',
      portal: 'walkway',
      exit: DEFAULT_ENDPOINT(),
      entry: DEFAULT_ENDPOINT(),
    };
    ownedIds.current.add(id);
    setEdges((es) => restyle(addEdge({
      ...conn, id, reconnectable: true, data: { route },
    } as Edge, es), id));
    setSelEdgeId(id);
    setDirty(true);
  }, [setEdges]);

  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    setEdges((es) =>
      restyle(
        // shouldReplaceId:false — with the default id swap, the patch below
        // would never match and the rewire would be silently lost on save
        reconnectEdge(oldEdge, conn, es, { shouldReplaceId: false }).map((e) => {
          if (e.id !== oldEdge.id) return e;
          const old = (e.data as { route: RelationRoute }).route;
          return { ...e, data: { route: {
            ...old,
            from: conn.source!,
            to: conn.target!,
            // an endpoint moved to a DIFFERENT bg keeps nothing: its zones /
            // center_pct / landmarks described the old background's frame
            exit: conn.source === old.from ? old.exit : DEFAULT_ENDPOINT(),
            entry: conn.target === old.to ? old.entry : DEFAULT_ENDPOINT(),
          } } };
        }),
        selEdgeId,
      ),
    );
    setDirty(true);
  }, [setEdges, selEdgeId]);

  const updateSelRoute = (patch: (r: RelationRoute) => RelationRoute) => {
    if (!selEdgeId) return;
    setEdges((es) =>
      restyle(
        es.map((e) =>
          e.id === selEdgeId
            ? { ...e, data: { route: patch((e.data as { route: RelationRoute }).route) } }
            : e,
        ),
        selEdgeId,
      ),
    );
    setDirty(true);
  };

  const deleteSelEdge = () => {
    if (!selEdgeId) return;
    setEdges((es) => es.filter((e) => e.id !== selEdgeId));
    setSelEdgeId(null);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      // editor-held routes win; every other route from the last-known server
      // state is passed through untouched. Owned-but-absent ids = deletions.
      const edited = edges.map((e) => (e.data as { route: RelationRoute }).route);
      const untouched = baseRoutes.current.filter((r) => !ownedIds.current.has(r.id));
      const ui: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (!(n.data as BgNodeData).ghost) ui[n.id] = { x: n.position.x, y: n.position.y };
      }
      const saved = await apiV4.saveRelationGraph(world, { routes: [...untouched, ...edited], ui });
      baseRoutes.current = saved.routes; // re-sync so the next save merges against fresh state
      setDirty(false);
      onSaved();
    } catch (e) {
      setSaveErr(String((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? e));
    } finally {
      setSaving(false);
    }
  };

  const close = useCallback(() => {
    if (dirty && !window.confirm("Saqlanmagan o'zgarishlar bor — baribir yopilsinmi?")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (editSlug) setEditSlug(null);
      else close();
    };
    window.addEventListener('keydown', h, { capture: true });
    return () => window.removeEventListener('keydown', h, { capture: true });
  }, [editSlug, close]);

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-gray-50">
      <style>{`
        .rge-node .rge-port { opacity: 0.25; transition: opacity .15s ease, transform .15s ease; }
        .rge-node:hover .rge-port { opacity: 1; transform: scale(1.25); }
        .react-flow__edge { cursor: pointer; }
      `}</style>

      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <span className="text-sm font-semibold text-gray-800">
          🛠 {clusterTitle(district)} <span className="font-normal text-gray-400">— relation editor · {world.replace(/_/g, ' ')}</span>
        </span>
        <span className="text-[11px] text-gray-400">
          kartani sur · chetidagi nuqtadan torting = yangi strelka · strelka uchini sur = qayta ulash · strelkaga bos = turi · kartaga bos = bg tahriri
        </span>
        <div className="ml-auto flex items-center gap-2">
          {saveErr && <span className="max-w-[300px] truncate text-[11px] text-red-600" title={saveErr}>{saveErr}</span>}
          {dirty && !saveErr && <span className="text-[11px] text-amber-600">saqlanmagan o'zgarishlar</span>}
          <button type="button" onClick={save} disabled={saving || !dirty}
                  className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">
            {saving ? 'saqlanmoqda…' : '💾 saqlash'}
          </button>
          <button type="button" onClick={close}
                  className="rounded border border-gray-300 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-100">
            ✕ yopish
          </button>
        </div>
      </div>

      <div className="relative flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={(ch) => { onNodesChange(ch); if (ch.some((c) => c.type === 'position')) setDirty(true); }}
            onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === 'remove')) setDirty(true); }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: '#f59e0b', strokeWidth: 2.5, strokeDasharray: '8 5' }}
            onEdgeClick={(_, e) => { setSelEdgeId(e.id); setEdges((es) => restyle(es, e.id)); }}
            onPaneClick={() => { setSelEdgeId(null); setEdges((es) => restyle(es, null)); }}
            onNodeClick={(_, n) => { if ((n.data as BgNodeData).url) setEditSlug(n.id); }}
            onBeforeDelete={async ({ edges: delEdges }) =>
              // deleting a NODE must not silently wipe its arrows — only
              // explicitly selected edges may be deleted; nodes never
              ({ nodes: [], edges: delEdges.filter((e) => e.selected) })}
            deleteKeyCode={['Delete', 'Backspace']}
            onError={(code, msg) => console.error('[rf]', code, msg)}
            snapToGrid snapGrid={[16, 16]}
            fitView fitViewOptions={{ padding: 0.25 }}
            minZoom={0.3}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#d8dbe0" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ((n.data as BgNodeData).ghost ? '#fbbf24' : '#93c5fd')} />
          </ReactFlow>
        </ReactFlowProvider>

        {selRoute && (
          <div className="absolute right-4 top-4 z-10 w-[260px] space-y-2 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-gray-700">Strelka</span>
              <button type="button" className="text-[11px] text-gray-400 hover:text-gray-600"
                      onClick={() => { setSelEdgeId(null); setEdges((es) => restyle(es, null)); }}>✕</button>
            </div>
            <div className="truncate text-[11px] text-gray-500">
              <b>{shortName(selRoute.from)}</b> → <b>{shortName(selRoute.to)}</b>
            </div>
            <label className="block text-[11px] text-gray-600">
              turi
              <select
                value={kindOfRoute(selRoute)}
                onChange={(ev) => updateSelRoute((r) => applyKind(r, ev.target.value as EditorKind))}
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-[12px]">
                {(Object.keys(KIND_META) as EditorKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_META[k].label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-gray-600">
              <input type="checkbox" checked={selRoute.bidirectional}
                     onChange={(ev) => updateSelRoute((r) => ({ ...r, bidirectional: ev.target.checked }))} />
              ikki tomonlama (⇄)
            </label>
            <button type="button" onClick={deleteSelEdge}
                    className="w-full rounded border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">
              🗑 strelkani o'chirish
            </button>
          </div>
        )}
      </div>

      {editSlug && (
        <div className="fixed inset-0 z-[200] bg-black/60 p-4 md:p-8">
          <div className="relative h-full w-full overflow-hidden rounded-lg bg-white shadow-2xl">
            <button type="button" onClick={() => setEditSlug(null)}
                    className="absolute right-3 top-3 z-10 rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 shadow hover:bg-gray-100">
              ✕ yopish (Esc)
            </button>
            <iframe src={`/videos/${encodeURIComponent(editSlug)}?embed=1${NO_VIDEO ? '&novideo=1' : ''}`}
                    title={`edit ${editSlug}`}
                    className="h-full w-full"
                    onLoad={(e) => {
                      // same-origin: let Esc work even when focus is inside the iframe
                      try {
                        e.currentTarget.contentWindow?.addEventListener('keydown', (ke) => {
                          if (ke.key === 'Escape') setEditSlug(null);
                        });
                      } catch { /* cross-origin guard — never expected here */ }
                    }} />
          </div>
        </div>
      )}
    </div>
  );
}
