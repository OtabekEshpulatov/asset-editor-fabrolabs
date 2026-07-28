import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { DEFAULT_FPS, frameOrigin, gridOfImage, loadSheet } from '@/lib/sprite-sheet';
import { useInView } from '@/lib/hooks';
import { Skeleton } from '@/components/ui/feedback';

/**
 * Full-size sprite playback from a real sheet.
 *
 * Unlike the old editor, this is NOT what grid cards use — they render server
 * thumbnails (see SpriteThumb). This path exists only where genuine pixels are
 * required: the large preview and the frame editor. That is what makes it safe
 * to decode a multi-megabyte sheet here.
 */
export function SpriteCanvas({
  url,
  size = 360,
  fps = DEFAULT_FPS,
  playing = true,
  frameIndex,
  className,
}: {
  url: string | null | undefined;
  size?: number;
  fps?: number;
  playing?: boolean;
  /** pin a specific frame (frame editor scrubbing); overrides `playing` */
  frameIndex?: number;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>('300px');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetch + decode once per url. Deliberately independent of play state — in
  // the old editor this depended on hover, so every hover tore it down and
  // re-decoded the whole sheet.
  useEffect(() => {
    if (!inView || !url) return;
    let cancelled = false;
    setFailed(false);
    loadSheet(url)
      .then((img) => !cancelled && setSheet(img))
      .catch(() => {
        if (cancelled) return;
        setSheet(null);
        setFailed(true);
      });
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

    if (frameIndex !== undefined) {
      draw(frameIndex);
      return;
    }
    if (!playing) {
      draw(Math.floor(grid.total / 2)); // a representative mid pose
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
  }, [sheet, playing, frameIndex, size, fps]);

  return (
    <div
      ref={ref}
      className={cn('checkerboard grid place-items-center overflow-hidden rounded-md', className)}
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span className="px-2 text-center text-xs text-destructive">Sheet missing in storage</span>
      ) : !sheet ? (
        <Skeleton className="size-full rounded-md" />
      ) : (
        <canvas ref={canvasRef} width={size} height={size} className="size-full" />
      )}
    </div>
  );
}
