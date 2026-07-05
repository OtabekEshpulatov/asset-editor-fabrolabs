import { useEffect, useRef, useState } from 'react';
import { apiV4 } from '../api';
import { FRAME } from './SpriteCanvas';

// Same grid heuristic as the backend (image_transforms.py) and SpriteCanvas —
// the source frame indices computed here must line up 1:1 with what the server
// cuts when it rebuilds the sheet from our `order`.
function frameGrid(w: number, h: number) {
  const fs = w >= FRAME && w % FRAME === 0 ? FRAME : Math.min(w, h) || FRAME;
  const cols = Math.max(1, Math.floor(w / fs));
  const rows = Math.max(1, Math.floor(h / fs));
  return { fs, cols, rows };
}

// One slot in the working sequence: `src` is the source frame index (into the
// current sheet); `uid` is a stable id so duplicates (same src) still get their
// own React key and drag identity.
interface Slot {
  uid: number;
  src: number;
}

function FrameCard({
  img,
  slot,
  pos,
  grid,
  canDelete,
  dragging,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDuplicate,
  onDelete,
}: {
  img: HTMLImageElement;
  slot: Slot;
  pos: number;
  grid: { fs: number; cols: number };
  canDelete: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 56;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cx = (slot.src % grid.cols) * grid.fs;
    const cy = Math.floor(slot.src / grid.cols) * grid.fs;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, cx, cy, grid.fs, grid.fs, 0, 0, size, size);
  }, [img, slot.src, grid]);

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition ${
        dragging ? 'border-blue-400 opacity-40' : 'border-gray-200'
      }`}
    >
      <div
        draggable
        onDragStart={onDragStart}
        title={`source frame ${slot.src} — drag to reorder`}
        className="relative cursor-grab overflow-hidden rounded-md ring-1 ring-gray-200 active:cursor-grabbing"
        style={{ width: size, height: size }}
      >
        <canvas ref={canvasRef} width={size} height={size} className="bg-gray-100" />
        <span className="absolute left-0 top-0 rounded-br bg-black/55 px-1 text-[9px] leading-tight text-white">
          {pos}
        </span>
        <span className="absolute bottom-0 right-0 rounded-tl bg-blue-600/80 px-1 text-[9px] leading-tight text-white">
          #{slot.src}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onDuplicate}
          title="Duplicate this frame (copy lands right after — drag it anywhere)"
          className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-800"
        >
          ⧉
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={canDelete ? 'Delete this frame from the sequence' : 'Cannot delete the last frame'}
          className="rounded px-1.5 py-0.5 text-[11px] text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default function FrameEditorModal({
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
  const [total, setTotal] = useState(0); // number of source frames
  const [seq, setSeq] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const uidRef = useRef(0);
  const dragUid = useRef<number | null>(null);
  const [dragActive, setDragActive] = useState<number | null>(null);

  const nextUid = () => ++uidRef.current;

  useEffect(() => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      const g = frameGrid(el.naturalWidth, el.naturalHeight);
      const n = Math.min(frameCount, g.cols * g.rows);
      setGrid(g);
      setTotal(n);
      setSeq(Array.from({ length: n }, (_, i) => ({ uid: nextUid(), src: i })));
      setImg(el);
    };
    el.src = spritesheetUrl;
  }, [spritesheetUrl, frameCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Drag-to-reorder: reorder live as the dragged slot enters another card.
  const onDragEnterPos = (overPos: number) => {
    const from = seq.findIndex((s) => s.uid === dragUid.current);
    if (from === -1 || from === overPos) return;
    setSeq((s) => {
      const n = s.slice();
      const [moved] = n.splice(from, 1);
      n.splice(overPos, 0, moved);
      return n;
    });
  };

  const duplicate = (pos: number) =>
    setSeq((s) => {
      const n = s.slice();
      n.splice(pos + 1, 0, { uid: nextUid(), src: s[pos].src });
      return n;
    });

  const remove = (pos: number) =>
    setSeq((s) => (s.length <= 1 ? s : s.filter((_, i) => i !== pos)));

  const reset = () => setSeq(Array.from({ length: total }, (_, i) => ({ uid: nextUid(), src: i })));

  // Changed vs. the untouched identity sequence [0,1,…,total-1].
  const changed = seq.length !== total || seq.some((s, i) => s.src !== i);

  // Live preview: loop the working sequence, in order, at the action's fps.
  const srcKey = seq.map((s) => s.src).join(',');
  useEffect(() => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext('2d');
    if (!img || !canvas || !ctx || seq.length === 0) return;
    const order = seq.map((s) => s.src);
    let raf = 0;
    let idx = 0;
    let last = 0;
    let stopped = false;
    const size = canvas.width;
    const tick = (ts: number) => {
      if (stopped) return;
      if (ts - last > 1000 / fps) {
        last = ts;
        const f = order[idx % order.length];
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
  }, [img, grid, fps, srcKey]);

  const save = async () => {
    if (!changed || seq.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiV4.reorderActionFrames(slug, action, seq.map((s) => s.src));
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
            <h3 className="text-base font-semibold text-gray-900">Edit frames</h3>
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
                    <span className="font-medium text-gray-900">Live preview</span> — plays the
                    sequence below, in order, at {fps} fps.
                  </div>
                  <div>
                    {total} source frame{total === 1 ? '' : 's'} →{' '}
                    <span className={changed ? 'font-medium text-blue-600' : ''}>
                      {seq.length} in sequence
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    Drag a frame to reorder · <span className="font-mono">⧉</span> duplicate ·{' '}
                    <span className="font-mono">✕</span> delete. The small{' '}
                    <span className="font-mono">#</span> is the original frame; nothing is saved
                    until you press Save.
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {seq.map((slot, pos) => (
                  <FrameCard
                    key={slot.uid}
                    img={img}
                    slot={slot}
                    pos={pos}
                    grid={grid}
                    canDelete={seq.length > 1}
                    dragging={dragActive === slot.uid}
                    onDragStart={() => {
                      dragUid.current = slot.uid;
                      setDragActive(slot.uid);
                    }}
                    onDragEnter={() => onDragEnterPos(pos)}
                    onDragEnd={() => {
                      dragUid.current = null;
                      setDragActive(null);
                    }}
                    onDuplicate={() => duplicate(pos)}
                    onDelete={() => remove(pos)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-5 py-3.5">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <div className="ml-auto flex items-center gap-2">
            {changed && (
              <button
                onClick={reset}
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
              disabled={!changed || seq.length === 0 || busy}
              className="rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              title="Overwrites the spritesheet in storage"
            >
              {busy ? 'Saving…' : `Save (${seq.length} frame${seq.length === 1 ? '' : 's'})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
