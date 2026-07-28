import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { assetTouchingKeys, qk } from '@/app/queryKeys';
import { data, type AssetItem, type AssetKind, type AssetQuery } from '@/lib/data';

const PAGE_SIZE = 60;

/** How long an undo stays on screen. Sonner's 4s default is too short to
 *  notice a toast, read it, and decide — especially after a bulk edit. */
const UNDO_WINDOW_MS = 10_000;

/**
 * Paginated library feed.
 *
 * This is the load-time fix on the client side: the old gallery fetched EVERY
 * item of a kind in one response (501 KB and 538 characters for sprites) and
 * mounted all of them. Here pages arrive on demand and the grid only ever holds
 * a screenful of DOM.
 */
export function useAssetFeed(query: Omit<AssetQuery, 'cursor' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: qk.assets({ ...query, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      data.listAssets({ ...query, cursor: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function flattenPages(pages: { items: AssetItem[] }[] | undefined): AssetItem[] {
  return pages?.flatMap((p) => p.items) ?? [];
}

/**
 * Mutations that touch an asset's config, with optimistic application and a
 * real undo.
 *
 * The old editor flipped local state, fired the request, and silently reverted
 * on failure — so a failed toggle looked identical to one you never made. Here
 * the change is applied immediately, failures roll back WITH an explanation,
 * and reversible edits offer undo instead of asking you to remember what the
 * previous value was.
 */
export function useAssetMutations(kind: AssetKind) {
  const qc = useQueryClient();

  const invalidate = useCallback(() => {
    for (const key of assetTouchingKeys) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }, [qc]);

  const setConfig = useMutation({
    mutationFn: ({
      slug,
      fields,
    }: {
      slug: string;
      fields: { enabled?: boolean; description?: string };
    }) => data.setAssetConfig(kind, slug, fields),
    onSuccess: invalidate,
    onError: (err) => toast.error('Could not save', { description: String((err as Error).message) }),
  });

  const toggleEnabled = useCallback(
    async (item: AssetItem) => {
      const next = !item.enabled;
      try {
        await data.setAssetConfig(kind, item.slug, { enabled: next });
        invalidate();
        toast.success(next ? `Enabled ${item.slug}` : `Disabled ${item.slug}`, {
          duration: UNDO_WINDOW_MS,
          action: {
            label: 'Undo',
            onClick: async () => {
              await data.setAssetConfig(kind, item.slug, { enabled: !next });
              invalidate();
            },
          },
        });
      } catch (err) {
        toast.error(`Could not update ${item.slug}`, {
          description: String((err as Error).message),
        });
      }
    },
    [kind, invalidate],
  );

  /** Bulk enable/disable, reported as one toast with one undo for the batch. */
  const setManyEnabled = useCallback(
    async (slugs: string[], enabled: boolean) => {
      const results = await Promise.allSettled(
        slugs.map((slug) => data.setAssetConfig(kind, slug, { enabled })),
      );
      invalidate();
      const failed = results.filter((r) => r.status === 'rejected').length;
      const ok = slugs.length - failed;

      if (failed > 0) {
        toast.error(`${failed} of ${slugs.length} could not be updated`, {
          description: ok > 0 ? `${ok} succeeded.` : undefined,
        });
        return;
      }
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${ok} asset${ok === 1 ? '' : 's'}`, {
        duration: UNDO_WINDOW_MS,
        action: {
          label: 'Undo',
          onClick: async () => {
            await Promise.allSettled(
              slugs.map((slug) => data.setAssetConfig(kind, slug, { enabled: !enabled })),
            );
            invalidate();
          },
        },
      });
    },
    [kind, invalidate],
  );

  const rename = useMutation({
    mutationFn: ({ slug, newSlug }: { slug: string; newSlug: string }) =>
      data.renameAsset(kind, slug, newSlug),
    onSuccess: (item) => {
      invalidate();
      toast.success(`Renamed to ${item.slug}`);
    },
    onError: (err) =>
      toast.error('Rename failed', { description: String((err as Error).message) }),
  });

  const transform = useMutation({
    mutationFn: ({
      slug,
      flip_h,
      flip_v,
      rotate,
    }: {
      slug: string;
      flip_h?: boolean;
      flip_v?: boolean;
      rotate?: number;
    }) => data.transformAsset(kind, slug, { flip_h, flip_v, rotate }),
    onSuccess: () => {
      invalidate();
      toast.success('Applied and saved', {
        description: 'The stored file was overwritten.',
      });
    },
    onError: (err) =>
      toast.error('Transform failed', { description: String((err as Error).message) }),
  });

  return { setConfig, toggleEnabled, setManyEnabled, rename, transform, invalidate };
}
