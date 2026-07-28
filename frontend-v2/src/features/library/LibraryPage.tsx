import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckSquare, Eye, EyeOff, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { type AssetItem, type AssetKind, type EnabledFilter } from '@/lib/data';
import { KINDS, prettyCategory } from '@/lib/kinds';
import { useDebounced, useUrlState } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@/components/ui/controls';
import { Badge } from '@/components/ui/feedback';
import { AssetGrid } from './AssetGrid';
import { DetailDrawer } from './DetailDrawer';
import { WorldStrip } from './WorldStrip';
import { flattenPages, useAssetFeed, useAssetMutations } from './useAssets';

/**
 * The library screen.
 *
 * View state lives in the URL — kind, category, search, filter and the open
 * asset. That is carried over from the old gallery, which got it right: a
 * reload, a shared link, or a round trip into an editor and back all restore
 * exactly what you were looking at.
 */
export default function LibraryPage() {
  const [params] = useSearchParams();
  const { patch } = useUrlState();

  const kind = (params.get('kind') as AssetKind | null) ?? 'character';
  const category = params.get('cat') ?? 'all';
  const enabledFilter = (params.get('show') as EnabledFilter | null) ?? 'all';
  const selectedSlug = params.get('sel');

  const [searchInput, setSearchInput] = useState(params.get('q') ?? '');
  const search = useDebounced(searchInput, 220);

  // Keep the box in sync when the URL changes underneath us (palette jumps,
  // back/forward), without fighting the user's typing.
  const urlQuery = params.get('q') ?? '';
  useEffect(() => {
    setSearchInput((cur) => (cur === urlQuery ? cur : urlQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  useEffect(() => {
    if (search !== urlQuery) patch({ q: search || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const meta = KINDS[kind];

  const feed = useAssetFeed({
    kind,
    category,
    q: search,
    enabled: enabledFilter,
  });
  const items = useMemo(() => flattenPages(feed.data?.pages), [feed.data]);
  const total = feed.data?.pages[0]?.total ?? 0;

  const { toggleEnabled, setManyEnabled, rename, transform, invalidate } = useAssetMutations(kind);

  /**
   * Selection survives scrolling, filtering and pagination. In the old gallery
   * it was per-section state that reset the moment you collapsed a section or
   * switched category, which made bulk edits across a large category painful.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [kind]);

  const toggleSelect = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const selectAllLoaded = () => setSelected(new Set(items.map((i) => i.slug)));
  const clearSelection = () => setSelected(new Set());

  const openItem = useCallback(
    (item: AssetItem) => patch({ sel: item.slug }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const closeItem = useCallback(
    () => patch({ sel: null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openItemData = useMemo(
    () => items.find((i) => i.slug === selectedSlug) ?? null,
    [items, selectedSlug],
  );

  const hasFilters = search.length > 0 || category !== 'all' || enabledFilter !== 'all';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-semibold">
            {meta.label}
            {category !== 'all' && (
              <span className="font-normal text-muted-foreground">
                {' '}
                / {prettyCategory(category)}
              </span>
            )}
          </h1>
          <p className="truncate text-2xs text-muted-foreground">
            {feed.isLoading ? 'Loading…' : `${total} item${total === 1 ? '' : 's'} · ${meta.hint}`}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Filter by name…"
              className="h-8 w-48 pl-7"
              type="search"
            />
          </div>

          <Select
            value={enabledFilter}
            onValueChange={(v) => patch({ show: v === 'all' ? null : v })}
          >
            <SelectTrigger className="w-[132px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="enabled">Enabled only</SelectItem>
              <SelectItem value="disabled">Disabled only</SelectItem>
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchInput('');
                patch({ q: null, cat: null, show: null });
              }}
            >
              <X />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Selection bar — appears in place, never covers the grid */}
      {selected.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-primary/10 px-4 py-1.5">
          <Badge variant="primary">{selected.size} selected</Badge>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setManyEnabled([...selected], true).then(clearSelection)}
          >
            <Eye />
            Enable
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setManyEnabled([...selected], false).then(clearSelection)}
          >
            <EyeOff />
            Disable
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button variant="ghost" size="sm" onClick={selectAllLoaded}>
            <CheckSquare />
            Select all loaded ({items.length})
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clearSelection}>
            <X />
            Clear selection
          </Button>
        </div>
      )}

      {/* Relation backgrounds: the world canvas is the primary view, so its
          front door sits above the grid rather than inside a card's drawer. */}
      {kind === 'video_v3' && <WorldStrip category={category} />}

      {/* Grid */}
      <div className={cn('min-h-0 flex-1')}>
        <AssetGrid
          items={items}
          total={total}
          selected={selected}
          onOpen={openItem}
          onToggleSelect={toggleSelect}
          isLoading={feed.isLoading}
          isFetchingNextPage={feed.isFetchingNextPage}
          hasNextPage={!!feed.hasNextPage}
          fetchNextPage={feed.fetchNextPage}
          error={feed.error}
          onRetry={() => feed.refetch()}
          emptyAction={
            hasFilters ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchInput('');
                  patch({ q: null, cat: null, show: null });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      </div>

      <DetailDrawer
        item={openItemData}
        kind={kind}
        open={!!selectedSlug && !!openItemData}
        onClose={closeItem}
        onToggleEnabled={toggleEnabled}
        onRename={(slug, newSlug) => rename.mutateAsync({ slug, newSlug }).then(() => patch({ sel: newSlug }))}
        onTransform={(slug, t) => transform.mutateAsync({ slug, ...t })}
        renaming={rename.isPending}
        transforming={transform.isPending}
        onChanged={invalidate}
      />
    </div>
  );
}
