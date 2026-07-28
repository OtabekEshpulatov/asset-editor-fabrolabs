import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Map } from 'lucide-react';
import { data } from '@/lib/data';
import { prettyCategory } from '@/lib/kinds';
import { qk } from '@/app/queryKeys';
import { auditWorld } from '@/features/world/worldGraph';
import { Button } from '@/components/ui/button';
import { Badge, Skeleton } from '@/components/ui/feedback';

/**
 * Front door to the world canvas.
 *
 * For relation backgrounds the map IS the view — that is how the old editor
 * worked, and burying it behind a card's inspector (as an earlier revision of
 * this app did) hides the only screen where relations can actually be seen or
 * edited. This strip sits above the grid so the canvas is one click from the
 * kind, and it carries the connectivity audit so a broken world is visible
 * before you open anything.
 */
export function WorldStrip({ category }: { category: string }) {
  const { data: worlds, isLoading } = useQuery({
    queryKey: qk.worlds(),
    queryFn: () => data.listWorlds(),
    staleTime: 5 * 60_000,
  });

  const shown = worlds?.filter((w) => category === 'all' || w === category) ?? [];

  const graphs = useQueries({
    queries: shown.map((world) => ({
      queryKey: qk.worldGraph(world),
      queryFn: () => data.getWorldGraph(world),
      staleTime: 5 * 60_000,
    })),
  });

  if (isLoading) {
    return (
      <div className="flex gap-2 border-b border-border px-4 py-2.5">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[58px] w-64" />
        ))}
      </div>
    );
  }

  if (!shown.length) return null;

  return (
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 py-2.5">
      {shown.map((world, i) => {
        const graph = graphs[i]?.data;
        const audit = graph ? auditWorld(graph.nodes, graph.routes) : null;
        return (
          <div
            key={world}
            className="flex min-w-[248px] flex-1 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
          >
            <Map className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{prettyCategory(world)}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {!graph ? (
                  <Skeleton className="h-3 w-28" />
                ) : (
                  <>
                    <span className="text-2xs text-muted-foreground">
                      {graph.nodes.length} scenes · {graph.routes.length} relations
                    </span>
                    {audit && audit.problemCount === 0 ? (
                      <Badge variant="success">
                        <CheckCircle2 className="size-3" />
                        connected
                      </Badge>
                    ) : (
                      audit && (
                        <Badge variant="warning">
                          <AlertTriangle className="size-3" />
                          {audit.problemCount} issue{audit.problemCount === 1 ? '' : 's'}
                        </Badge>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
            <Button asChild size="sm" className="shrink-0">
              <Link to={`/worlds/${encodeURIComponent(world)}`}>Open map</Link>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
