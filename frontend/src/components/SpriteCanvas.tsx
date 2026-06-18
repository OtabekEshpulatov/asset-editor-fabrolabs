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
}: {
  url?: string;
  size?: number;
  fps?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  // Only animate sprites scrolled into view — keeps a 500+ list smooth.
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
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      fs = w >= FRAME && w % FRAME === 0 ? FRAME : Math.min(w, h) || FRAME;
      cols = Math.max(1, Math.floor(w / fs));
      const rows = Math.max(1, Math.floor(h / fs));
      total = cols * rows;
      const tick = (ts: number) => {
        if (stopped) return;
        if (ts - last > 1000 / fps) {
          last = ts;
          const cx = (frame % cols) * fs;
          const cy = Math.floor(frame / cols) * fs;
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, cx, cy, fs, fs, 0, 0, size, size);
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
  }, [visible, url, size, fps]);

  return (
    <div
      ref={wrapRef}
      className="grid place-items-center rounded bg-gray-100"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} width={size} height={size} />
    </div>
  );
}
