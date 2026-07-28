import { useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ImageOff } from 'lucide-react';
import type { AssetItem } from '@/lib/data';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { AssetCard, CARD_GAP, CARD_H, CARD_W } from './AssetCard';

/**
 * Virtualized, infinitely paged asset grid.
 *
 * Two things the old gallery could not do:
 *  - DOM stays bounded. It mounted every card of a category at once, which is
 *    why opening "All categories" locked the browser and why the code shipped a
 *    DEFAULT_CATEGORY hack to avoid it. Here only visible rows exist.
 *  - Pages load as you scroll, instead of one giant response up front.
 *
 * STRUCTURAL NOTE: the scroll container and the measured inner element are
 * ALWAYS mounted — loading, empty and error states render inside them rather
 * than short-circuiting with an early return. Both the virtualizer's scroll
 * element and the width measurement are captured by ref, and a ref behind a
 * conditional return is null on first render and silently never re-attaches:
 * the grid then collapses to one column, or renders no rows at all.
 */
export function AssetGrid({
  items,
  total,
  selected,
  onOpen,
  onToggleSelect,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  error,
  onRetry,
  emptyAction,
}: {
  items: AssetItem[];
  total: number;
  selected: Set<string>;
  onOpen: (item: AssetItem) => void;
  onToggleSelect: (slug: string) => void;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  error: unknown;
  onRetry: () => void;
  emptyAction?: React.ReactNode;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(node);
  }, []);

  const columns = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_W + CARD_GAP)));
  const rowCount = width > 0 ? Math.ceil(items.length / columns) : 0;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    estimateSize: () => CARD_H + CARD_GAP,
    overscan: 3,
  });

  const virtualRows = virtualizer.getVirtualItems();

  // Fetch the next page as the last row comes into range. Driven off the
  // virtualizer rather than a sentinel element so it keeps working while rows
  // are being recycled.
  const lastRowIndex = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;
  useEffect(() => {
    if (lastRowIndex < 0) return;
    if (lastRowIndex >= rowCount - 2 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastRowIndex, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const selectionActive = selected.size > 0;
  const showEmpty = !isLoading && !error && items.length === 0;

  return (
    <div ref={setScrollEl} className="h-full overflow-y-auto">
      <div ref={measureRef} className="px-4 py-4">
        {/* `error` is typed unknown, so branch explicitly rather than relying
            on && — an unknown left operand is not a valid ReactNode. */}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : null}

        {isLoading && !error && (
          <div className="flex flex-wrap" style={{ gap: CARD_GAP }}>
            {Array.from({ length: 24 }).map((_, i) => (
              <Skeleton key={i} style={{ width: CARD_W, height: CARD_H }} className="rounded-lg" />
            ))}
          </div>
        )}

        {showEmpty && (
          <EmptyState
            icon={ImageOff}
            title="Nothing matches these filters"
            description="Try a different category, clear the search, or include disabled assets."
            action={emptyAction}
          />
        )}

        {!isLoading && !error && items.length > 0 && (
          <>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualRows.map((row) => {
                const start = row.index * columns;
                const rowItems = items.slice(start, start + columns);
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    className="absolute left-0 top-0 flex w-full"
                    style={{ transform: `translateY(${row.start}px)`, gap: CARD_GAP }}
                  >
                    {rowItems.map((item) => (
                      <AssetCard
                        key={`${item.kind}:${item.slug}`}
                        item={item}
                        selected={selected.has(item.slug)}
                        selectionActive={selectionActive}
                        onOpen={() => onOpen(item)}
                        onToggleSelect={() => onToggleSelect(item.slug)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-center py-6">
              {isFetchingNextPage ? (
                <p className="text-xs text-muted-foreground">Loading more…</p>
              ) : hasNextPage ? (
                <Button variant="outline" size="sm" onClick={() => fetchNextPage()}>
                  Load more
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {items.length} of {total} shown — end of list
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
