import { useEffect, useRef, useState } from 'react';

// Sprite sheets are grids of 512px frames laid out left-to-right, top-to-bottom.
// We infer the grid from the image's natural size (same heuristic the backend
// compositor uses) and step through frames on a canvas at FPS.
export const FRAME = 512;
export const FPS = 12;

export default function SpriteCanvas({
  url,
  size = 120,
  fps = FPS,
  hoverToPlay = false,
}: {
  url?: string;
  size?: number;
  fps?: number;
  // When true, the sheet stays on a single static frame and only animates while
  // the mouse is over it — so a big grid isn't dozens of loops running at once.
  hoverToPlay?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Only touch sprites scrolled into view — keeps a 500+ list smooth.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Animate when in view AND (not hover-gated, or currently hovered); otherwise
  // just paint one representative frame so the card still shows the pose.
  const playing = visible && !!url && (!hoverToPlay || hovered);

  useEffect(() => {
    if (!visible || !url) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let raf = 0;
    let frame = 0;
    let last = 0;
    let total = 1;
    let cols = 1;
    let fs = FRAME;
    let stopped = false;

    const img = new Image();
    const draw = (f: number) => {
      const cx = (f % cols) * fs;
      const cy = Math.floor(f / cols) * fs;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, cx, cy, fs, fs, 0, 0, size, size);
    };
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      fs = w >= FRAME && w % FRAME === 0 ? FRAME : Math.min(w, h) || FRAME;
      cols = Math.max(1, Math.floor(w / fs));
      const rows = Math.max(1, Math.floor(h / fs));
      total = cols * rows;
      if (!playing) {
        draw(Math.floor(total / 2)); // static mid frame — hover to animate
        return;
      }
      const tick = (ts: number) => {
        if (stopped) return;
        if (ts - last > 1000 / fps) {
          last = ts;
          draw(frame);
          frame = (frame + 1) % total;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    img.src = url;

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [visible, url, size, fps, playing]);

  return (
    <div
      ref={wrapRef}
      onMouseEnter={hoverToPlay ? () => setHovered(true) : undefined}
      onMouseLeave={hoverToPlay ? () => setHovered(false) : undefined}
      className="grid place-items-center rounded bg-gray-100"
      style={{ width: size, height: size }}
      title={hoverToPlay ? 'Hover to play' : undefined}
    >
      <canvas ref={canvasRef} width={size} height={size} />
    </div>
  );
}
