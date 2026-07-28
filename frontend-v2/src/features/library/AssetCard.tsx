import { memo } from 'react';
import { EyeOff, Music, Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AssetItem } from '@/lib/data';
import { KINDS } from '@/lib/kinds';
import { withRev } from '@/lib/sprite-sheet';
import { Checkbox } from '@/components/ui/controls';
import { ImageThumb, SpriteThumb } from '@/components/media/SpriteThumb';

export const CARD_W = 148;
export const CARD_H = 186;
export const CARD_GAP = 12;

/**
 * One asset in the grid. Shape (sprite / image / video / audio) comes from the
 * kind registry rather than a chain of `kind === ...` checks in the page body.
 *
 * Memoized because the grid re-renders on every selection change and there can
 * be a few hundred mounted rows.
 */
export const AssetCard = memo(function AssetCard({
  item,
  selected,
  selectionActive,
  onOpen,
  onToggleSelect,
}: {
  item: AssetItem;
  selected: boolean;
  /** once anything is selected, every card shows its checkbox */
  selectionActive: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  const meta = KINDS[item.kind];
  const thumb = withRev(item.thumb, item.rev);
  const busy = item.progress && item.progress.status !== 'done';

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-1.5 rounded-lg border bg-card p-2 transition-colors',
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-border/80',
        !item.enabled && 'opacity-55',
      )}
      style={{ width: CARD_W }}
    >
      <div
        className={cn(
          'absolute left-1.5 top-1.5 z-10 transition-opacity',
          selectionActive || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select ${item.slug}`}
          className="bg-card/90 backdrop-blur"
        />
      </div>

      {!item.enabled && (
        <span
          className="absolute right-1.5 top-1.5 z-10 rounded bg-background/85 p-1 text-muted-foreground backdrop-blur"
          title="Disabled — hidden everywhere downstream"
        >
          <EyeOff className="size-3" />
        </span>
      )}

      <button
        type="button"
        onClick={onOpen}
        title={`${item.slug} — open details`}
        className="rounded focus-ring"
      >
        {meta.shape === 'sprite' ? (
          <SpriteThumb
            thumb={thumb}
            strip={item.strip}
            alt={item.slug}
            size={CARD_W - 16}
            className="w-full"
          />
        ) : meta.shape === 'audio' ? (
          <div className="checkerboard grid aspect-square w-full place-items-center rounded">
            <Music className="size-7 text-muted-foreground/70" strokeWidth={1.5} />
          </div>
        ) : (
          <div className="relative">
            <ImageThumb src={thumb} alt={item.slug} checker={item.kind === 'object'} />
            {meta.shape === 'video' && (
              <span className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/65 px-1 py-0.5 text-[9px] text-white">
                <Play className="size-2.5 fill-current" />
                mp4
              </span>
            )}
          </div>
        )}
      </button>

      <div className="min-w-0 space-y-1">
        {/* The name opens details too. Only the thumbnail used to be clickable,
            which made clicking the label feel like the card was dead. */}
        <button
          type="button"
          onClick={onOpen}
          title={`${item.slug} — open details`}
          className="block w-full break-all rounded text-center font-mono text-[11px] leading-tight text-foreground/90 hover:text-foreground focus-ring"
        >
          {item.slug}
        </button>

        {busy && item.progress && (
          <div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  item.progress.status === 'failed' ? 'bg-destructive' : 'bg-primary',
                )}
                style={{
                  width: `${Math.round((item.progress.done / Math.max(1, item.progress.total)) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-0.5 text-center text-[9px] text-muted-foreground">
              {item.progress.done}/{item.progress.total} · {item.progress.status}
            </p>
          </div>
        )}

        {item.kind === 'intro_music' && item.duration_s && (
          <p className="text-center text-[9px] text-muted-foreground">
            {Math.floor(item.duration_s / 60)}:{String(item.duration_s % 60).padStart(2, '0')}
          </p>
        )}
      </div>
    </div>
  );
});
