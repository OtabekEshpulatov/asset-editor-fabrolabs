import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useInView } from '@/lib/hooks';
import { DEFAULT_FPS, frameOrigin, gridOfImage, loadSheet } from '@/lib/sprite-sheet';

/**
 * Grid thumbnail for a sprite. THIS is the load-time fix.
 *
 * The old editor put a full sprite sheet in every card: up to 4.4 MB over the
 * wire and 26-85 MB of decoded RGBA each, for 538 cards. It fought that with a
 * byte-budgeted decode cache, hover-gated animation loops, and a hack that
 * refused to open the "All categories" view at all.
 *
 * Here a card renders a ~5 KB still, and hover swaps to a ~16 KB frame strip
 * animated by `steps()` — pure compositor work, no canvas, no decode of
 * anything large. Same visual affordance, ~500x less data.
 *
 * The strip's frame count is read from its natural width rather than assumed,
 * because short actions ship fewer frames than the cap.
 */
export function SpriteThumb({
  thumb,
  strip,
  alt,
  size = 116,
  fps = 12,
  className,
}: {
  thumb: string | null | undefined;
  strip?: string | null;
  alt: string;
  size?: number;
  fps?: number;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [hovered, setHovered] = useState(false);
  const [frames, setFrames] = useState(0);
  const [failed, setFailed] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // Measure the strip once, and only when it is actually going to be used.
  useEffect(() => {
    if (!strip || !hovered || frames > 0) return;
    const img = new Image();
    img.onload = () => setFrames(Math.max(1, Math.round(img.naturalWidth / img.naturalHeight)));
    img.onerror = () => setFrames(0);
    img.src = strip;
  }, [strip, hovered, frames]);

  const animating = hovered && !!strip && frames > 1;

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn('checkerboard relative grid place-items-center overflow-hidden rounded', className)}
      style={{ width: size, height: size }}
    >
      {!inView ? null : failed || !thumb ? (
        <span className="px-1 text-center text-[9px] leading-tight text-muted-foreground">
          no preview
        </span>
      ) : (
        <>
          <img
            src={thumb}
            alt={alt}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className={cn(
              'size-full object-contain transition-opacity duration-100',
              animating && 'opacity-0',
            )}
          />
          {animating && (
            <div
              ref={stripRef}
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${strip})`,
                backgroundRepeat: 'no-repeat',
                // The strip is N square frames side by side.
                backgroundSize: `${frames * 100}% 100%`,
                animation: `sprite-strip ${frames / fps}s steps(${frames}) infinite`,
                // steps() walks background-position across the whole strip.
                ['--sprite-frames' as string]: String(frames),
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Still image thumbnail (backgrounds, objects, posters). Checkerboard backing
 * matters for objects, which are transparent cutouts.
 */
export function ImageThumb({
  src,
  alt,
  className,
  aspect = 'square',
  checker = true,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  aspect?: 'square' | 'video';
  checker?: boolean;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [failed, setFailed] = useState(false);

  return (
    <div
      ref={ref}
      className={cn(
        'relative grid place-items-center overflow-hidden rounded',
        checker ? 'checkerboard' : 'bg-muted',
        aspect === 'square' ? 'aspect-square' : 'aspect-video',
        className,
      )}
    >
      {inView && src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : inView ? (
        <span className="text-[9px] text-muted-foreground">no preview</span>
      ) : null}
    </div>
  );
}


/**
 * Grid thumbnail cropped from a FULL spritesheet.
 *
 * Used when the backend has no derived thumbnails (v4 today): a sprite's only
 * image is its sheet, and putting that in an <img> renders the whole grid of
 * frames shrunk into the card — a mosaic, not a character. Here one frame is
 * drawn to canvas, which is what the old editor did and what makes the grid
 * legible at all.
 *
 * The decode goes through the shared byte-budgeted cache in lib/sprite-sheet,
 * so a long list cannot pin gigabytes of RGBA. It is still far more expensive
 * than a 5 KB thumbnail — that cost is what phase 2 removes.
 */
export function SheetThumb({
  url,
  alt,
  size = 116,
  fps = DEFAULT_FPS,
  className,
}: {
  url: string | null | undefined;
  alt: string;
  size?: number;
  fps?: number;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!inView || !url) return;
    let cancelled = false;
    loadSheet(url)
      .then((img) => !cancelled && setSheet(img))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [inView, url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !sheet) return;
    const grid = gridOfImage(sheet);

    const draw = (f: number) => {
      const { sx, sy } = frameOrigin(((f % grid.total) + grid.total) % grid.total, grid);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(sheet, sx, sy, grid.frameSize, grid.frameSize, 0, 0, size, size);
    };

    // Static mid-frame until hovered — animating every card at once would burn
    // CPU for a screenful of sprites with nothing gained.
    if (!hovered) {
      draw(Math.floor(grid.total / 2));
      return;
    }
    let raf = 0;
    let frame = 0;
    let last = 0;
    let stopped = false;
    const tick = (ts: number) => {
      if (stopped) return;
      if (ts - last > 1000 / fps) {
        last = ts;
        draw(frame);
        frame = (frame + 1) % grid.total;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [sheet, hovered, size, fps]);

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="img"
      aria-label={alt}
      className={cn('checkerboard grid place-items-center overflow-hidden rounded', className)}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span className="px-1 text-center text-[9px] text-muted-foreground">no preview</span>
      ) : (
        <canvas ref={canvasRef} width={size} height={size} className="size-full" />
      )}
    </div>
  );
}
