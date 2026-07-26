import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiV4 } from '../api';
import WorldGraphCanvas from './WorldGraphCanvas';
import QueuedThumb from './QueuedThumb';
import { auditWorld } from '../lib/worldGraph';

/**
 * Live BG v3 — the world's row on the assets page.
 *
 * The map itself no longer lives here. Every background of a world and every
 * relation between them now share ONE canvas (WorldGraphCanvas); this row is
 * just its front door plus a health read-out, so the assets page stays light
 * (no grid of streaming thumbnails) and problems are visible before you open
 * anything.
 */

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
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const clusterKeys = useMemo(() => {
    if (!data) return [];
    const declared = Object.keys(data.clusters ?? {});
    const used = [...new Set(data.nodes.map((n) => n.cluster || 'all'))];
    return [...declared.filter((k) => used.includes(k)), ...used.filter((k) => !declared.includes(k))];
  }, [data]);

  const clusterTitle = (key: string) => {
    const m = data?.clusters?.[key];
    return `${m?.emoji ? m.emoji + ' ' : ''}${m?.title || key.replace(/_/g, ' ')}`;
  };

  const audit = useMemo(
    () => (data ? auditWorld(data.nodes, data.routes) : null),
    [data],
  );
  const islandSlugs = useMemo(
    () => new Set(audit ? audit.components.slice(1).flat() : []),
    [audit],
  );

  return (
    <section className="space-y-2">
      <button type="button" onClick={onToggleCollapse}
              className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <span>{collapsed ? '▸' : '▾'}</span>
        <span className="capitalize">{world.replace(/_/g, ' ')}</span>
        <span className="font-normal text-gray-400">
          {data ? `${data.nodes.length} bg · ${data.routes.length} relation · ${clusterKeys.length} district` : ''}
        </span>
        {audit && audit.problemCount > 0 && (
          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
            ⚠ {audit.problemCount}
          </span>
        )}
      </button>

      {!collapsed && (
        <>
          {isLoading && <div className="py-6 text-sm text-gray-500">Loading graph…</div>}
          {error != null && <div className="py-4 text-sm text-red-600">Failed to load graph: {String(error)}</div>}

          {data && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-[260px] flex-1 space-y-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {clusterKeys.map((key) => {
                      const members = data.nodes.filter((n) => (n.cluster || 'all') === key);
                      const isIsland = members.length > 0 && members.every((m) => islandSlugs.has(m.slug));
                      return (
                        <span key={key}
                              className={['rounded-full border px-2.5 py-1 text-[11px] font-medium',
                                isIsland ? 'border-red-300 bg-red-50 text-red-700'
                                  : 'border-gray-300 bg-gray-50 text-gray-700'].join(' ')}>
                          {clusterTitle(key)}
                          <span className="ml-1 opacity-60">{members.length}</span>
                          {isIsland && <span className="ml-1">🏝</span>}
                        </span>
                      );
                    })}
                  </div>

                  {audit && (audit.problemCount === 0 ? (
                    <div className="text-[12px] text-emerald-700">
                      🟢 All backgrounds are connected.
                    </div>
                  ) : (
                    <ul className="space-y-1 text-[12px]">
                      {audit.components.length > 1 && (
                        <li className="text-red-700">
                          🏝 <b>{audit.components.length - 1} disconnected piece{audit.components.length - 1 === 1 ? '' : 's'}</b> ({islandSlugs.size} bg) — the engine
                          can't find a path there:{' '}
                          <span className="text-red-500">
                            {audit.components.slice(1).flat().map((s) => s.replace(/_live$/, '')).join(', ')}
                          </span>
                        </li>
                      )}
                      {audit.orphans.length > 0 && (
                        <li className="text-red-700">⛔ <b>{audit.orphans.length} orphan background{audit.orphans.length === 1 ? '' : 's'}</b> — no relations at all</li>
                      )}
                      {audit.deadEnds.length > 0 && (
                        <li className="text-amber-700">🚪 <b>{audit.deadEnds.length} dead end{audit.deadEnds.length === 1 ? '' : 's'}</b> — entry but no exit</li>
                      )}
                      {audit.todMismatch.length > 0 && (
                        <li className="text-amber-700">
                          🕑 <b>{audit.todMismatch.length} time mismatch{audit.todMismatch.length === 1 ? '' : 'es'}</b> — adjoining places, but different time of day
                        </li>
                      )}
                    </ul>
                  ))}

                  <button type="button" onClick={() => setOpen(true)}
                          className="rounded bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-blue-700">
                    🗺 open world map
                  </button>
                </div>

                {/* a few frames so the row reads as a place, not a table row */}
                <div className="flex shrink-0 flex-wrap gap-1">
                  {data.nodes.slice(0, 6).map((n) => (
                    <div key={n.slug} className="overflow-hidden rounded border border-gray-200">
                      <QueuedThumb slug={n.slug} url={n.url} w={96} h={54} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {data && open && (
            <WorldGraphCanvas
              world={world}
              graph={data}
              clusterTitle={clusterTitle}
              onClose={() => setOpen(false)}
              onSaved={() => qc.invalidateQueries({ queryKey: ['relation-graph', world] })}
            />
          )}
        </>
      )}
    </section>
  );
}
