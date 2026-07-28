import { useQuery } from '@tanstack/react-query';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { ChevronRight, Layers } from 'lucide-react';
import { cn } from '@/lib/cn';
import { data, type AssetKind } from '@/lib/data';
import { KIND_GROUPS, KINDS, kindsInGroup, prettyCategory } from '@/lib/kinds';
import { qk } from '@/app/queryKeys';
import { ScrollArea, Skeleton } from '@/components/ui/feedback';

/**
 * Primary navigation.
 *
 * This is the structural answer to "put the categories somewhere other than the
 * top". The old editor stacked 11 pill tabs plus a 27-option category <select>
 * above the grid, which ate vertical space and hid the shape of the library.
 * Here kinds are a grouped list and the active kind's categories expand beneath
 * it as a tree, with counts — so you can see the whole library at a glance and
 * jump two levels in one click.
 *
 * Category counts come from a facets call that returns names + counts ONLY. In
 * the old app the only way to know how many birds existed was to download every
 * bird.
 */
export function Sidebar({ className }: { className?: string }) {
  const [params] = useSearchParams();
  const location = useLocation();

  const activeKind = (params.get('kind') as AssetKind | null) ?? 'character';
  const activeCategory = params.get('cat') ?? 'all';
  const onLibrary = location.pathname === '/library';

  const { data: counts } = useQuery({
    queryKey: qk.kindCounts(),
    queryFn: () => data.kindCounts(),
    staleTime: 5 * 60_000,
  });

  const { data: facets, isLoading: facetsLoading } = useQuery({
    queryKey: qk.facets(activeKind),
    queryFn: () => data.facets(activeKind),
    staleTime: 5 * 60_000,
  });

  return (
    <nav className={cn('flex h-full flex-col border-r border-border bg-card', className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Layers className="size-4 text-primary" />
        <span className="text-[13px] font-semibold tracking-tight">Asset Studio</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-2">
          {KIND_GROUPS.map((group) => (
            <div key={group}>
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </p>
              <ul className="space-y-0.5">
                {kindsInGroup(group).map((meta) => {
                  const isActive = onLibrary && meta.key === activeKind;
                  const Icon = meta.icon;
                  return (
                    <li key={meta.key}>
                      <NavLink
                        to={`/library?kind=${meta.key}`}
                        className={cn(
                          'group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                          isActive
                            ? 'bg-primary/12 font-medium text-primary'
                            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-4 shrink-0',
                            isActive ? 'text-primary' : 'text-muted-foreground',
                          )}
                        />
                        <span className="truncate">{meta.label}</span>
                        <span
                          className={cn(
                            'ml-auto shrink-0 text-2xs tabular-nums',
                            isActive ? 'text-primary/70' : 'text-muted-foreground',
                          )}
                        >
                          {counts?.[meta.key] ?? ''}
                        </span>
                      </NavLink>

                      {/* Categories of the active kind, inline. */}
                      {isActive && (
                        <ul className="ml-[19px] mt-0.5 space-y-px border-l border-border pl-2">
                          <CategoryRow
                            kind={meta.key}
                            name="all"
                            label="All categories"
                            count={counts?.[meta.key] ?? 0}
                            active={activeCategory === 'all'}
                          />
                          {facetsLoading &&
                            Array.from({ length: 5 }).map((_, i) => (
                              <li key={i} className="px-2 py-1">
                                <Skeleton className="h-3.5 w-full" />
                              </li>
                            ))}
                          {facets?.map((f) => (
                            <CategoryRow
                              key={f.name}
                              kind={meta.key}
                              name={f.name}
                              label={prettyCategory(f.name)}
                              count={f.count}
                              active={activeCategory === f.name}
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

function CategoryRow({
  kind,
  name,
  label,
  count,
  active,
}: {
  kind: AssetKind;
  name: string;
  label: string;
  count: number;
  active: boolean;
}) {
  const meta = KINDS[kind];
  return (
    <li>
      <NavLink
        to={`/library?kind=${kind}${name === 'all' ? '' : `&cat=${encodeURIComponent(name)}`}`}
        title={`${label} · ${count} ${meta.label.toLowerCase()}`}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          active
            ? 'bg-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-opacity', active ? 'opacity-70' : 'opacity-0')}
        />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums opacity-60">{count}</span>
      </NavLink>
    </li>
  );
}
