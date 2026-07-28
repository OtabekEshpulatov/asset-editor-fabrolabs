import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftToLine, ArrowRightFromLine, Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { data, type BgTransition } from '@/lib/data';
import { qk } from '@/app/queryKeys';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';

/**
 * Transition-point editor.
 *
 * Marks WHERE on this frame each connection to a neighbouring scene happens.
 * Two flavours, deliberately given distinct colours and words:
 *   EXIT  (blue)  — you LEAVE this scene here, heading somewhere else.
 *   ENTRY (green) — you ARRIVE here from somewhere else.
 *
 * Every change saves immediately; there is no separate save step because each
 * edit is a single coordinate and batching them only creates a way to lose them.
 */

const SIDE_META = {
  exit: {
    color: '#2563eb',
    chip: 'EXIT',
    Icon: ArrowRightFromLine,
    title: 'Exit — leaving from here',
  },
  entry: {
    color: '#16a34a',
    chip: 'ENTRY',
    Icon: ArrowLeftToLine,
    title: 'Entry — arriving here',
  },
} as const;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const shortName = (slug: string) => slug.split('_').slice(-2).join('_');
const keyOf = (t: BgTransition) => `${t.route_id}:${t.side}`;

export function TransitionEditor({ slug, posterUrl }: { slug: string; posterUrl: string | null }) {
  const [items, setItems] = useState<BgTransition[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [savedTick, setSavedTick] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragIdx = useRef<number | null>(null);

  const { data: payload, isLoading, error, refetch } = useQuery({
    queryKey: qk.transitions(slug),
    queryFn: () => data.getTransitions(slug),
    retry: false,
  });

  useEffect(() => {
    if (!payload) return;
    // Departures first, then arrivals — matches the order of the side panel.
    const sorted = [...payload.transitions].sort((a, b) =>
      a.side === b.side ? a.other.localeCompare(b.other) : a.side === 'exit' ? -1 : 1,
    );
    setItems(sorted);
    setActive(sorted.length ? 0 : null);
  }, [payload]);

  const persist = async (index: number, center: [number, number]) => {
    const it = items[index];
    if (!payload) return;
    try {
      await data.setTransitionPoint(payload.world_id, {
        route_id: it.route_id,
        side: it.side,
        center_pct: center,
      });
      setSavedTick(keyOf(it));
      setTimeout(() => setSavedTick((cur) => (cur === keyOf(it) ? null : cur)), 1400);
    } catch (err) {
      toast.error('Could not save the point', { description: String((err as Error).message) });
    }
  };

  const pointFromEvent = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [clamp(((e.clientX - rect.left) / rect.width) * 100), clamp(((e.clientY - rect.top) / rect.height) * 100)];
  };

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const i = dragIdx.current;
      if (i == null || !canvasRef.current) return;
      const center = pointFromEvent(ev);
      setItems((prev) => prev.map((t, idx) => (idx === i ? { ...t, center_pct: center } : t)));
    };
    const onUp = () => {
      const i = dragIdx.current;
      dragIdx.current = null;
      if (i != null) persist(i, items[i]?.center_pct);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  if (isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }

  if (error) {
    const msg = String((error as Error).message);
    return (
      <div className="p-4">
        {msg.includes('world graph') ? (
          <EmptyState
            title="This scene is not part of a world graph"
            description="Transition points are only marked on scenes wired into a relation world."
          />
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const exits = items.map((t, i) => ({ t, i })).filter((x) => x.t.side === 'exit');
  const entries = items.map((t, i) => ({ t, i })).filter((x) => x.t.side === 'entry');

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_300px]">
      <div>
        <div
          ref={canvasRef}
          className="relative w-full select-none overflow-hidden rounded-lg border border-border bg-muted"
          style={{ aspectRatio: '16 / 9', touchAction: 'none', cursor: active != null ? 'crosshair' : 'default' }}
          onPointerDown={(e) => {
            if (active == null) return;
            const center = pointFromEvent(e);
            setItems((prev) => prev.map((t, idx) => (idx === active ? { ...t, center_pct: center } : t)));
            persist(active, center);
          }}
        >
          {posterUrl && (
            <img src={posterUrl} alt={slug} draggable={false} className="absolute inset-0 size-full object-cover" />
          )}

          {items.map((t, i) => {
            const m = SIDE_META[t.side];
            const isActive = active === i;
            return (
              <div
                key={keyOf(t)}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${t.center_pct[0]}%`, top: `${t.center_pct[1]}%`, zIndex: isActive ? 20 : 10 }}
              >
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActive(i);
                    dragIdx.current = i;
                  }}
                  title={`${m.title}: ${shortName(t.other)} — drag to move`}
                  className={cn(
                    'mx-auto block cursor-grab rounded-full border-2 border-white shadow',
                    isActive ? 'size-5 ring-2 ring-white/50' : 'size-3.5',
                  )}
                  style={{ background: m.color }}
                />
                <span
                  className="pointer-events-none mt-0.5 block max-w-[130px] truncate rounded px-1 text-center text-[10px] leading-tight text-white"
                  style={{ background: `${m.color}dd` }}
                >
                  {savedTick === keyOf(t) ? '✓ saved' : shortName(t.other)}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
          Pick one from the list, then <b>click</b> the frame or <b>drag</b> its dot. Every change
          saves immediately.
        </p>
      </div>

      <div className="space-y-4">
        <TransitionGroup
          title="Exit — leaving from here"
          side="exit"
          rows={exits}
          active={active}
          savedTick={savedTick}
          onPick={setActive}
          empty="No transitions leave this scene."
        />
        <TransitionGroup
          title="Entry — arriving here"
          side="entry"
          rows={entries}
          active={active}
          savedTick={savedTick}
          onPick={setActive}
          empty="No transitions arrive at this scene."
        />
      </div>
    </div>
  );
}

function TransitionGroup({
  title,
  side,
  rows,
  active,
  savedTick,
  onPick,
  empty,
}: {
  title: string;
  side: 'exit' | 'entry';
  rows: { t: BgTransition; i: number }[];
  active: number | null;
  savedTick: string | null;
  onPick: (i: number) => void;
  empty: string;
}) {
  const m = SIDE_META[side];
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="size-2.5 rounded-full" style={{ background: m.color }} />
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title} ({rows.length})
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map(({ t, i }) => {
          const isActive = active === i;
          return (
            <button
              key={keyOf(t)}
              type="button"
              onClick={() => onPick(i)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors',
                isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
              )}
            >
              <m.Icon className="size-3.5 shrink-0" style={{ color: m.color }} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs">{shortName(t.other)}</p>
                <p className="text-2xs text-muted-foreground">
                  {t.far ? 'far' : 'near'} · [{t.center_pct[0]}, {t.center_pct[1]}]
                </p>
              </div>
              {savedTick === keyOf(t) && <Check className="size-3.5 shrink-0 text-success" />}
              {isActive && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-white"
                  style={{ background: m.color }}
                >
                  marking
                </span>
              )}
            </button>
          );
        })}
        {rows.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-2 text-xs text-muted-foreground">
            {empty}
          </p>
        )}
      </div>
    </div>
  );
}
