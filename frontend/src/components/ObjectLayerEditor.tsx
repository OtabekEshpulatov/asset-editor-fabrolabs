import { useEffect, useRef, useState } from 'react';
import { apiV4, type Mover, type MoverEdit } from '../api';

// Ported from story-gen-exps frontend/src/pages/LivebgEditor.tsx (LivebgEditorPage),
// adapted for the asset-editor: the backdrop is the live-bg VIDEO (not a static plate),
// movers load from /api/v4/videos/{slug}/movers, and Save re-renders the mp4 server-side.

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

type Drag =
  | { index: number; mode: 'move' }
  | { index: number; mode: 'resize'; startX: number; origW: number }
  | { index: number; mode: 'rangeL' | 'rangeR' }
  | null;

interface Props {
  slug: string;
  videoUrl: string | null;   // absolute MinIO mp4 (backdrop + initial preview)
  onDirty?: () => void;      // optional: notify the parent on any object move
  onSaved?: () => void;      // optional: notify the parent the scene was saved
}

export default function ObjectLayerEditor({ slug, videoUrl, onDirty, onSaved }: Props) {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState(videoUrl ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEditable, setNotEditable] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setNotEditable(false);
    apiV4
      .getVideoMovers(slug)
      .then((res) => {
        if (!alive) return;
        setMovers(res.movers);
        if (res.video_url) setPreviewUrl(res.video_url);
        setSel(null);
      })
      .catch((e: any) => {
        if (!alive) return;
        if (e?.response?.status === 409) setNotEditable(true); // no source bundle yet
        else setError(String(e?.response?.data?.detail ?? e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug]);

  // One window-level drag handler; reads the active mover from dragRef.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!d || !rect) return;
      const px = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
      const py = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
      setMovers((prev) =>
        prev.map((m, i) => {
          if (i !== d.index) return m;
          if (d.mode === 'resize') {
            // Keep the 1280-px width baseline: the backend keys the cutout on `w`.
            const dir = m.to_left ? -1 : 1; // right-placed cutouts grow when dragged left
            const wpct = Math.max(1.5, Math.min(60, d.origW + (px - d.startX) * 2 * dir));
            const w = Math.max(8, Math.round((wpct / 100) * 1280));
            return { ...m, w, w_pct: (w / 1280) * 100 };
          }
          if (d.mode === 'rangeL') return { ...m, x0: Math.min(Math.round(px), (m.x1 ?? 100) - 4) };
          if (d.mode === 'rangeR') return { ...m, x1: Math.max(Math.round(px), (m.x0 ?? 0) + 4) };
          return { ...m, x: m.positionable ? Math.round(px) : m.x, y: Math.round(py) };
        }),
      );
      setDirty(true);
      onDirty?.();
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginDrag =
    (index: number, mode: 'move' | 'resize' | 'rangeL' | 'rangeR') => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSel(index);
      if (mode === 'resize') {
        const rect = canvasRef.current!.getBoundingClientRect();
        const startX = ((e.clientX - rect.left) / rect.width) * 100;
        dragRef.current = { index, mode, startX, origW: movers[index].w_pct };
      } else {
        dragRef.current = { index, mode };
      }
    };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: MoverEdit[] = movers
        .filter((m) => m.positionable || m.kind === 'swim')
        .map((m) => {
          const e: MoverEdit = { index: m.index, w: m.w };
          if (m.x != null) e.x = Math.round(m.x);
          if (m.y != null) e.y = Math.round(m.y);
          if (m.kind === 'swim') {
            e.x0 = Math.round(m.x0 ?? 0);
            e.x1 = Math.round(m.x1 ?? 100);
          }
          return e;
        });
      const res = await apiV4.saveVideoMovers(slug, payload);
      setPreviewUrl(res.video_url);
      setDirty(false);
      onSaved?.();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-gray-500">Loading objects…</div>;
  if (notEditable)
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">Bu jonli fon hali obyekt-tahrirlash uchun tayyor emas.</p>
          <p className="mt-1 text-amber-700">
            Manba to‘plami (spec + plate + cutout) bucketda yo‘q. Pozitsion zonalarni tahrirlash uchun{' '}
            <b>Zones</b> rejimiga o‘ting, yoki story-gen-exps’dan{' '}
            <code className="rounded bg-amber-100 px-1">v5_publish_livebg_categorized --bundle-only</code>{' '}
            bilan bundle’ni publish qiling.
          </p>
        </div>
        {videoUrl && (
          <video
            src={videoUrl}
            autoPlay
            loop
            muted
            playsInline
            className="w-full max-w-3xl rounded-lg border border-gray-300 bg-black"
            style={{ aspectRatio: '16 / 9' }}
          />
        )}
      </div>
    );
  if (error && !movers.length)
    return <div className="text-red-600">Failed to load objects: {error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-sm text-red-600">{error}</span>}
        {dirty && <span className="text-sm text-amber-600">Unsaved</span>}
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? 'Rendering…' : 'Save & Re-render'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* drag canvas (the looping video is the backdrop) */}
        <div>
          <p className="mb-1 text-xs text-gray-500">
            Drag an object to move it · drag the ● corner to resize · for flying objects, drag the
            dashed lane up/down and drag its ● ends to set where it flies.
          </p>
          <div
            ref={canvasRef}
            className="relative w-full select-none overflow-hidden rounded-lg border border-gray-300 bg-gray-100"
            style={{ aspectRatio: '16 / 9', touchAction: 'none' }}
          >
            {previewUrl && (
              <video
                key={`bg-${previewUrl}`}
                src={previewUrl}
                autoPlay
                loop
                muted
                playsInline
                className="pointer-events-none absolute inset-0 h-full w-full object-cover"
              />
            )}

            {movers.map((m, i) => {
              if (!m.positionable && m.kind !== 'swim') return null; // fall/bubbles: full-frame
              const selected = sel === i;
              const mirror = m.to_left || m.flip ? 'scaleX(-1)' : '';

              if (m.kind === 'swim') {
                const y = m.y ?? 15;
                const x0 = m.x0 ?? 0;
                const x1 = m.x1 ?? 100;
                const entry = m.to_left ? x1 : x0; // where the object appears
                return (
                  <div key={i} className="absolute left-0 right-0" style={{ top: `${y}%` }}>
                    <div
                      onPointerDown={beginDrag(i, 'move')}
                      className="absolute h-0 cursor-ns-resize border-t-2 border-dashed"
                      style={{ left: `${x0}%`, width: `${x1 - x0}%`, top: 0, borderColor: selected ? '#2563eb' : '#94a3b8' }}
                    />
                    {m.cutout_url ? (
                      <img
                        src={m.cutout_url}
                        alt={m.id}
                        draggable={false}
                        onPointerDown={beginDrag(i, 'move')}
                        style={{ position: 'absolute', top: 0, left: `${entry}%`, transform: `translate(-50%,-50%) ${mirror}`, width: `${m.w_pct}%`, cursor: 'ns-resize', opacity: 0.92 }}
                      />
                    ) : (
                      <div
                        onPointerDown={beginDrag(i, 'move')}
                        className="absolute rounded border border-blue-500 bg-blue-500/20"
                        style={{ top: 0, left: `${entry}%`, transform: 'translate(-50%,-50%)', width: `${m.w_pct}%`, aspectRatio: '1 / 1', cursor: 'ns-resize' }}
                      />
                    )}
                    <span
                      className="absolute -top-4 whitespace-nowrap rounded bg-black/60 px-1 text-[10px] text-white"
                      style={{ left: `${(x0 + x1) / 2}%`, transform: 'translateX(-50%)' }}
                    >
                      {m.id} {m.to_left ? '←' : '→'} · flies {Math.round(x0)}–{Math.round(x1)}%
                    </span>
                    {selected && (
                      <>
                        <div
                          onPointerDown={beginDrag(i, 'rangeL')}
                          title="flight start"
                          className="absolute h-3.5 w-3.5 cursor-ew-resize rounded-full border border-white bg-blue-600"
                          style={{ left: `${x0}%`, top: 0, transform: 'translate(-50%,-50%)' }}
                        />
                        <div
                          onPointerDown={beginDrag(i, 'rangeR')}
                          title="flight end"
                          className="absolute h-3.5 w-3.5 cursor-ew-resize rounded-full border border-white bg-blue-600"
                          style={{ left: `${x1}%`, top: 0, transform: 'translate(-50%,-50%)' }}
                        />
                      </>
                    )}
                  </div>
                );
              }

              // positionable: float / pulse / peek / patrol — centered at x%,y%
              const x = m.x ?? 50;
              const y = m.y ?? 50;
              return (
                <div
                  key={i}
                  className="absolute"
                  style={{ left: `${x}%`, top: `${y}%`, width: `${m.w_pct}%`, transform: 'translate(-50%,-50%)' }}
                >
                  {m.cutout_url ? (
                    <img
                      src={m.cutout_url}
                      alt={m.id}
                      draggable={false}
                      onPointerDown={beginDrag(i, 'move')}
                      style={{ width: '100%', display: 'block', cursor: 'move', transform: mirror, outline: selected ? '2px solid #2563eb' : 'none' }}
                    />
                  ) : (
                    <div
                      onPointerDown={beginDrag(i, 'move')}
                      title={m.id}
                      className="flex items-center justify-center rounded border border-blue-500 bg-blue-500/20 text-[10px] text-blue-700"
                      style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'move', outline: selected ? '2px solid #2563eb' : 'none' }}
                    >
                      {m.id}
                    </div>
                  )}
                  {selected && (
                    <div
                      onPointerDown={beginDrag(i, 'resize')}
                      title="resize"
                      className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border border-white bg-blue-600"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* live preview + object list */}
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-gray-500">Live preview (the moving result — reloads after Save)</p>
            {previewUrl && (
              <video
                key={previewUrl}
                src={previewUrl}
                autoPlay
                loop
                muted
                playsInline
                className="w-full rounded-lg border border-gray-300 bg-black"
                style={{ aspectRatio: '16 / 9' }}
              />
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-gray-600">Objects</p>
            <div className="flex flex-wrap gap-1.5">
              {movers.map((m, i) => (
                <button
                  key={i}
                  onClick={() => setSel(i === sel ? null : i)}
                  className={`rounded border px-2 py-1 text-xs ${
                    i === sel ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-600'
                  }`}
                >
                  {m.id} <span className="text-gray-400">· {m.kind}</span>
                  {m.x != null && (
                    <span className="ml-1 font-mono text-[10px] text-gray-400">
                      {Math.round(m.x)},{Math.round(m.y ?? 0)}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              Snow / bubbles fill the whole frame (no position). “Save &amp; Re-render” writes the new
              positions and rebuilds the looping video (may take a moment).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
