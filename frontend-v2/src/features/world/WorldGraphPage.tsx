import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  CheckCircle2,
  LayoutGrid,
  Link2Off,
  Route as RouteIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { data, type RelationRoute, type WorldGraph } from '@/lib/data';
import { qk } from '@/app/queryKeys';
import { Button } from '@/components/ui/button';
import { Separator, Tooltip } from '@/components/ui/controls';
import { Badge, ErrorState, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  auditWorld,
  autoLayout,
  districtBox,
  hasCrossDistrictOverlap,
  repackExisting,
  type Pos,
} from './worldGraph';

/**
 * The world map: every scene of a world and every relation between them on ONE
 * canvas.
 *
 * Layout, packing and the connectivity audit all come from ./worldGraph, ported
 * verbatim from the old editor — this file is only the view. Keeping that split
 * is what makes the interesting logic testable (worldGraph.test.ts) while React
 * Flow handles panning, dragging and edge rendering.
 */
export default function WorldGraphPage() {
  const { worldId = '' } = useParams();
  const {
    data: graph,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: qk.worldGraph(worldId),
    queryFn: () => data.getWorldGraph(worldId),
  });

  if (error) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        backTo="/library?kind=video_v3"
        title={
          <>
            World map — <span className="font-mono font-normal">{worldId}</span>
          </>
        }
        subtitle={
          isLoading
            ? 'Loading…'
            : `${graph?.nodes.length ?? 0} scenes · ${graph?.routes.length ?? 0} relations`
        }
      />
      {isLoading || !graph ? (
        <div className="p-4">
          <Skeleton className="h-[60vh] w-full" />
        </div>
      ) : (
        <ReactFlowProvider>
          <Canvas worldId={worldId} graph={graph} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

interface SceneNodeData extends Record<string, unknown> {
  slug: string;
  url: string | null;
  tod: string;
  cluster: string;
}

function SceneNode({ data: d, selected }: NodeProps) {
  const n = d as SceneNodeData;
  return (
    <div
      className={cn(
        'w-[190px] overflow-hidden rounded-lg border-2 bg-card shadow-lg transition-colors',
        selected ? 'border-primary' : 'border-border',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-primary" />
      <div className="checkerboard aspect-video w-full">
        {n.url && (
          <img src={n.url} alt={n.slug} className="size-full object-cover" draggable={false} />
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="truncate font-mono text-[10px] text-foreground">{n.slug}</span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{n.tod}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-primary" />
    </div>
  );
}

const nodeTypes = { scene: SceneNode };

function Canvas({ worldId, graph }: { worldId: string; graph: WorldGraph }) {
  const clusterKeys = useMemo(() => {
    const declared = Object.keys(graph.clusters ?? {});
    const used = [...new Set(graph.nodes.map((n) => n.cluster || 'all'))];
    return [
      ...declared.filter((k) => used.includes(k)),
      ...used.filter((k) => !declared.includes(k)),
    ];
  }, [graph]);

  /** Saved positions, migrated when they came from the old per-district editors
   *  (where each district started at its own origin and would now overlap). */
  const initialPos = useMemo(() => {
    const saved = new Map<string, Pos>();
    for (const n of graph.nodes) {
      const ui = n.ui ?? graph.editor_ui?.[n.slug];
      if (ui) saved.set(n.slug, ui);
    }
    if (saved.size < graph.nodes.length) return autoLayout(graph.nodes, graph.routes, clusterKeys);
    if (hasCrossDistrictOverlap(graph.nodes, saved)) {
      return repackExisting(graph.nodes, saved, clusterKeys);
    }
    return saved;
  }, [graph, clusterKeys]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [routes, setRoutes] = useState<RelationRoute[]>(graph.routes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const buildNodes = useCallback(
    (pos: Map<string, Pos>): Node[] =>
      graph.nodes.map((n) => ({
        id: n.slug,
        type: 'scene',
        position: pos.get(n.slug) ?? { x: 0, y: 0 },
        data: {
          slug: n.slug,
          url: n.url,
          tod: n.tod,
          cluster: n.cluster || 'all',
        } as SceneNodeData,
      })),
    [graph.nodes],
  );

  const buildEdges = useCallback(
    (rs: RelationRoute[]): Edge[] =>
      rs.map((r) => ({
        id: r.id,
        source: r.from,
        target: r.to,
        animated: r.relation === 'enter',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: r.bidirectional ? '#64748b' : '#3b82f6', strokeWidth: 1.5 },
        label: r.portal,
        labelStyle: { fontSize: 9, fill: '#94a3b8' },
        labelBgStyle: { fill: 'transparent' },
      })),
    [],
  );

  useEffect(() => {
    setNodes(buildNodes(initialPos));
    setEdges(buildEdges(graph.routes));
    setRoutes(graph.routes);
    setDirty(false);
  }, [initialPos, graph.routes, buildNodes, buildEdges, setNodes, setEdges]);

  const audit = useMemo(() => auditWorld(graph.nodes, routes), [graph.nodes, routes]);

  /** District backdrops, drawn behind the cards in flow coordinates. */
  const districts = useMemo(() => {
    const pos = new Map(nodes.map((n) => [n.id, n.position as Pos]));
    return clusterKeys
      .map((key) => {
        const members = graph.nodes.filter((n) => (n.cluster || 'all') === key).map((n) => n.slug);
        const box = districtBox(members, pos);
        return box ? { key, box, meta: graph.clusters?.[key] } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [nodes, clusterKeys, graph]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const id = `r-new-${c.source}-${c.target}`;
      if (routes.some((r) => r.id === id)) {
        toast.info('That relation already exists');
        return;
      }
      const next: RelationRoute = {
        id,
        from: c.source,
        to: c.target,
        bidirectional: true,
        relation: 'path',
        portal: 'path',
        exit: { zone: 'ground', center_pct: [70, 62] },
        entry: { zone: 'ground', center_pct: [30, 62] },
      };
      setRoutes((prev) => [...prev, next]);
      setEdges((eds) =>
        addEdge({ ...c, id, markerEnd: { type: MarkerType.ArrowClosed }, label: 'path' }, eds),
      );
      setDirty(true);
    },
    [routes, setEdges],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      setRoutes((prev) =>
        prev.map((r) => (r.id === oldEdge.id ? { ...r, from: conn.source!, to: conn.target! } : r)),
      );
      setEdges((eds) => reconnectEdge(oldEdge, conn, eds));
      setDirty(true);
    },
    [setEdges],
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    const ids = new Set(deleted.map((e) => e.id));
    setRoutes((prev) => prev.filter((r) => !ids.has(r.id)));
    setDirty(true);
  }, []);

  const arrange = () => {
    setNodes(buildNodes(autoLayout(graph.nodes, routes, clusterKeys)));
    setDirty(true);
    toast.success('Re-arranged', { description: 'Districts laid out, then packed.' });
  };

  const save = async () => {
    setSaving(true);
    try {
      const ui: Record<string, Pos> = {};
      for (const n of nodes) ui[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      await data.saveWorldGraph(worldId, { routes, ui });
      setDirty(false);
      toast.success('World saved', {
        description: `${routes.length} relations and ${nodes.length} positions.`,
      });
    } catch (err) {
      toast.error('Could not save the world', { description: String((err as Error).message) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One toolbar — health on the left, actions on the right. Never a second row. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
        {audit.problemCount === 0 ? (
          <Badge variant="success">
            <CheckCircle2 className="size-3" />
            All scenes connected
          </Badge>
        ) : (
          <Badge variant="warning">
            <AlertTriangle className="size-3" />
            {audit.problemCount} issue{audit.problemCount === 1 ? '' : 's'}
          </Badge>
        )}

        {audit.components.length > 1 && (
          <Tooltip label="The world is split — the engine cannot walk between these pieces.">
            <Badge variant="danger">
              <Link2Off className="size-3" />
              {audit.components.length} disconnected pieces
            </Badge>
          </Tooltip>
        )}
        {audit.orphans.length > 0 && (
          <Tooltip label={`No relations at all: ${audit.orphans.join(', ')}`}>
            <Badge variant="danger">
              {audit.orphans.length} orphan{audit.orphans.length === 1 ? '' : 's'}
            </Badge>
          </Tooltip>
        )}
        {audit.deadEnds.length > 0 && (
          <Tooltip label={`Enter but never leave: ${audit.deadEnds.join(', ')}`}>
            <Badge variant="warning">
              <RouteIcon className="size-3" />
              {audit.deadEnds.length} dead end{audit.deadEnds.length === 1 ? '' : 's'}
            </Badge>
          </Tooltip>
        )}
        {audit.todMismatch.length > 0 && (
          <Tooltip label="Adjoining scenes disagree on time of day.">
            <Badge variant="warning">
              {audit.todMismatch.length} time mismatch{audit.todMismatch.length === 1 ? '' : 'es'}
            </Badge>
          </Tooltip>
        )}

        <Separator orientation="vertical" className="h-4" />
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip label="Lay out each district internally, then pack the districts">
            <Button variant="outline" size="sm" onClick={arrange}>
              <LayoutGrid />
              Arrange
            </Button>
          </Tooltip>
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
            Save world
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);
          }}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgesDelete={onEdgesDelete}
          connectionMode={ConnectionMode.Loose}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="hsl(var(--border))" />
          <Controls className="!border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button]:!fill-foreground [&_button:hover]:!bg-accent" />
          <MiniMap
            pannable
            zoomable
            className="!border-border !bg-card"
            nodeColor="hsl(var(--primary))"
            maskColor="hsl(var(--background) / 0.7)"
          />
        </ReactFlow>
      </div>

      <p className="shrink-0 border-t border-border px-4 py-1.5 text-2xs text-muted-foreground">
        Drag a card to move it · drag from a card&apos;s side handle onto another card to create a
        relation · select an arrow and press Delete to remove it. Districts:{' '}
        {districts.map((d) => d.meta?.title ?? d.key).join(' · ')}
      </p>
    </div>
  );
}
