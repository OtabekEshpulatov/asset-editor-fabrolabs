import { useEffect, useRef, useState } from 'react';
import { Maximize2, Volume2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AssetItem } from '@/lib/data';
import { KINDS } from '@/lib/kinds';
import { withRev } from '@/lib/sprite-sheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/overlay';
import { SpriteCanvas } from './SpriteCanvas';

/**
 * The real asset, playable.
 *
 * The old editor let you actually inspect an asset — an <audio controls> on
 * every music card, real <video> playback for intros and live scenes, the
 * full-size image in a lightbox. An earlier revision of this app replaced all
 * of that with thumbnails and a drawn waveform, which made the library
 * un-reviewable: you could see that an asset existed but not what it was.
 *
 * Grid cards still render ~5 KB thumbnails. This component is only mounted in
 * the inspector, where loading the real file is the entire point.
 */
export function AssetPreview({ item, className }: { item: AssetItem; className?: string }) {
  const meta = KINDS[item.kind];
  const media = withRev(item.media, item.rev);
  const thumb = withRev(item.thumb, item.rev);
  const [zoomed, setZoomed] = useState(false);

  if (meta.shape === 'audio') {
    return <AudioPreview item={item} src={media} className={className} />;
  }

  if (meta.shape === 'video') {
    return media ? (
      <video
        key={media}
        src={media}
        poster={thumb ?? undefined}
        controls
        autoPlay
        loop
        muted
        playsInline
        className={cn('w-full rounded-md bg-black', className)}
      />
    ) : (
      <MissingMedia label="No video shipped for this asset" thumb={thumb} className={className} />
    );
  }

  if (meta.shape === 'sprite') {
    return (
      <div className={cn('flex flex-col items-center gap-2', className)}>
        <SpriteCanvas url={media ?? thumb} size={220} />
        <p className="text-2xs text-muted-foreground">Playing the full sheet at its own frame rate</p>
      </div>
    );
  }

  // still image — click to view at full size
  return (
    <>
      <button
        type="button"
        onClick={() => media && setZoomed(true)}
        disabled={!media}
        title={media ? 'View full size' : undefined}
        className={cn(
          'checkerboard group relative w-full overflow-hidden rounded-md focus-ring',
          media && 'cursor-zoom-in',
          className,
        )}
      >
        {thumb ? (
          <img src={thumb} alt={item.slug} className="w-full object-contain" />
        ) : (
          <div className="grid aspect-video place-items-center text-xs text-muted-foreground">
            no preview
          </div>
        )}
        {media && (
          <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            <Maximize2 className="size-3" />
            Full size
          </span>
        )}
      </button>

      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent className="max-w-[92vw] p-2" aria-describedby={undefined}>
          <div className="checkerboard grid max-h-[86vh] place-items-center overflow-auto rounded">
            {media && (
              <img src={media} alt={item.slug} className="max-h-[84vh] w-auto object-contain" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Audio with a live level meter drawn from the actual signal.
 *
 * The meter is driven by a WebAudio analyser on the element itself, so it moves
 * with what you are hearing — unlike the static bars this replaced, which were
 * decoration pretending to be data.
 */
function AudioPreview({
  item,
  src,
  className,
}: {
  item: AssetItem;
  src?: string;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas || !playing) return;

    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;

    let ctx: AudioContext;
    let raf = 0;
    try {
      ctx = new AC();
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const g = canvas.getContext('2d')!;

      const draw = () => {
        analyser.getByteFrequencyData(bins);
        const w = canvas.width;
        const h = canvas.height;
        g.clearRect(0, 0, w, h);
        const barW = w / bins.length;
        g.fillStyle = getComputedStyle(canvas).color;
        for (let i = 0; i < bins.length; i++) {
          const bh = Math.max(2, (bins[i] / 255) * h);
          g.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
        }
        raf = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      return; // a source node can only be created once per element
    }
    return () => {
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
    };
  }, [playing]);

  if (!src) {
    return <MissingMedia label="No audio shipped for this track" className={className} />;
  }

  return (
    <div className={cn('w-full space-y-2', className)}>
      <canvas
        ref={canvasRef}
        width={320}
        height={56}
        className="h-14 w-full text-primary/70"
        aria-hidden
      />
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="w-full"
      />
      <p className="flex items-center gap-1 text-2xs text-muted-foreground">
        <Volume2 className="size-3" />
        {item.duration_s ? `${Math.floor(item.duration_s / 60)}:${String(item.duration_s % 60).padStart(2, '0')} · ` : ''}
        the real file, streamed
      </p>
    </div>
  );
}

function MissingMedia({
  label,
  thumb,
  className,
}: {
  label: string;
  thumb?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'checkerboard relative grid aspect-video w-full place-items-center overflow-hidden rounded-md',
        className,
      )}
    >
      {thumb && <img src={thumb} alt="" className="absolute inset-0 size-full object-cover opacity-40" />}
      <span className="relative rounded bg-background/80 px-2 py-1 text-2xs text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** "Open original" — every kind should be reachable in a plain browser tab. */
export function OpenOriginal({ item }: { item: AssetItem }) {
  const href = withRev(item.media ?? item.thumb, item.rev);
  if (!href) return null;
  return (
    <Button asChild variant="outline" size="sm" className="w-full justify-start">
      <a href={href} target="_blank" rel="noreferrer">
        <Maximize2 />
        Open original
      </a>
    </Button>
  );
}
