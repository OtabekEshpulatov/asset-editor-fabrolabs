import { useEffect, useRef, useState } from 'react';
import { apiV4 } from '../api';
import { FRAME } from './SpriteCanvas';

// Same grid heuristic as the backend (image_transforms.py) and SpriteCanvas —
// frame indices computed here must line up 1:1 with what the server will cut.
function frameGrid(w: number, h: number) {
  const fs = w >= FRAME && w % FRAME === 0 ? FRAME : Math.min(w, h) || FRAME;
  const cols = Math.max(1, Math.floor(w / fs));
  const rows = Math.max(1, Math.floor(h / fs));
  return { fs, cols, rows };
}

function FrameThumb({
  img,
  index,
  grid,
  removed,
  onToggle,
}: {
  img: HTMLImageElement;
  index: number;
  grid: { fs: number; cols: number };
  removed: boolean;
  onToggle: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 56;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cx = (index % grid.cols) * grid.fs;
    const cy = Math.floor(index / grid.cols) * grid.fs;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, cx, cy, grid.fs, grid.fs, 0, 0, size, size);
  }, [img, index, grid]);

  return (
    <button
      type="button"
      onClick={onToggle}
      title={removed ? `frame ${index} — marked for removal (click to keep)` : `frame ${index} — click to remove`}
      className={`relative overflow-hidden rounded-md ring-2 transition ${
        removed ? 'opacity-35 ring-red-400' : 'ring-transparent hover:ring-blue-300'
      }`}
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} width={size} height={size} className="bg-gray-100" />
      <span className="absolute bottom-0 left-0 rounded-tr bg-black/50 px-1 text-[9px] leading-tight text-white">
        {index}
      </span>
      {removed && (
        <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-red-500">
          ✕
        </span>
      )}
    </button>
  );
}

export default function FrameTrimModal({
  slug,
  action,
  spritesheetUrl,
  fps,
  frameCount,
  onClose,
  onSaved,
}: {
  slug: string;
  action: string;
  spritesheetUrl: string;
  fps: number;
  frameCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [grid, setGrid] = useState({ fs: FRAME, cols: 1, rows: 1 });
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      setGrid(frameGrid(el.naturalWidth, el.naturalHeight));
      setImg(el);
    };
    el.src = spritesheetUrl;
  }, [spritesheetUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = Math.min(frameCount, grid.cols * grid.rows);
  const kept = Array.from({ length: total }, (_, i) => i).filter((i) => !removed.has(i));

  const toggle = (i: number) =>
    setRemoved((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  // Live preview: loop only the kept frames, in order, at the action's fps.
  useEffect(() => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext('2d');
    if (!img || !canvas || !ctx || kept.length === 0) return;
    let raf = 0;
    let idx = 0;
    let last = 0;
    let stopped = false;
    const size = canvas.width;
    const tick = (ts: number) => {
      if (stopped) return;
      if (ts - last > 1000 / fps) {
        last = ts;
        const f = kept[idx % kept.length];
        const cx = (f % grid.cols) * grid.fs;
        const cy = Math.floor(f / grid.cols) * grid.fs;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, cx, cy, grid.fs, grid.fs, 0, 0, size, size);
        idx++;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, grid, fps, kept.join(',')]);

  const save = async () => {
    if (removed.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiV4.removeActionFrames(slug, action, Array.from(removed));
      onSaved();
      onClose();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-base font-semibold text-gray-900">Trim frames</h3>
            <span className="font-mono text-sm text-gray-500">
              {slug} / {action}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title="Close without saving (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          {!img ? (
            <div className="py-10 text-center text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              <div className="flex items-start gap-4">
                <div className="shrink-0 overflow-hidden rounded-lg ring-1 ring-gray-200">
                  <canvas ref={previewRef} width={140} height={140} className="bg-gray-100" />
                </div>
                <div className="space-y-1.5 text-sm text-gray-600">
                  <div>
                    <span className="font-medium text-gray-900">Live preview</span> — plays only the
                    kept frames, in order, at {fps} fps.
                  </div>
                  <div>
                    {total} frame{total === 1 ? '' : 's'} total,{' '}
                    <span className={removed.size ? 'font-medium text-red-600' : ''}>
                      {removed.size} marked for removal
                    </span>
                    , {kept.length} will remain.
                  </div>
                  <div className="text-xs text-gray-400">
                    Click a frame below to mark/unmark it. Nothing is saved until you press Save.
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {Array.from({ length: total }, (_, i) => i).map((i) => (
                  <FrameThumb
                    key={i}
                    img={img}
                    index={i}
                    grid={grid}
                    removed={removed.has(i)}
                    onToggle={() => toggle(i)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-5 py-3.5">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <div className="ml-auto flex items-center gap-2">
            {removed.size > 0 && (
              <button
                onClick={() => setRemoved(new Set())}
                className="rounded-md px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
              >
                reset
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={removed.size === 0 || busy}
              className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              title="Overwrites the spritesheet in storage"
            >
              {busy ? 'Saving…' : `Save (remove ${removed.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
