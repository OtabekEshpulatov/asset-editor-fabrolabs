import { useEffect, useRef, useState } from 'react';
import { apiV4, type AddedMover, type Mover, type MoverEdit, type PaletteAsset } from '../api';

// Ported from story-gen-exps frontend/src/pages/LivebgEditor.tsx (LivebgEditorPage),
// adapted for the asset-editor: the backdrop is the live-bg VIDEO (not a static plate),
// movers load from /api/v4/videos/{slug}/movers, and Save re-renders the mp4 server-side.

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** Motion presets offered when adding an object — map to a spec `kind` (+ "still"). */
const MOTIONS = [
  { key: 'still', label: 'Stays put', kind: 'float', still: true },
  { key: 'float', label: 'Drifts', kind: 'float', still: false },
  { key: 'swim', label: 'Flies across', kind: 'swim', still: false },
  { key: 'patrol', label: 'Paces side-to-side', kind: 'patrol', still: false },
  { key: 'pulse', label: 'Twinkles', kind: 'pulse', still: false },
] as const;
type Motion = (typeof MOTIONS)[number];
const ADD_W: Record<string, number> = { float: 80, swim: 80, patrol: 90, pulse: 40 };
const FLIPPABLE = new Set(['float', 'patrol', 'pulse', 'peek', 'swim']);   // kinds that can be re-faced

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
  const [removed, setRemoved] = useState<number[]>([]);   // original indices dropped this session
  const [sel, setSel] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState(videoUrl ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEditable, setNotEditable] = useState(false);
  // add-object picker
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState<PaletteAsset[] | null>(null);
  const [motion, setMotion] = useState<Motion>(MOTIONS[0]);
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
        setRemoved([]);
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

  // load the palette lazily the first time the add panel opens
  useEffect(() => {
    if (adding && palette === null) apiV4.listVideoObjectPalette(slug).then(setPalette).catch(() => setPalette([]));
  }, [adding, palette, slug]);

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
            // Keep the 1280-px width baseline: the backend keys the cutout on `w`. The handle
            // sits at the box's bottom-right for every kind, so dragging right always grows.
            const wpct = Math.max(1.5, Math.min(60, d.origW + (px - d.startX) * 2));
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

  const addMover = (asset: PaletteAsset) => {
    const kind = motion.kind;
    const isSwim = kind === 'swim';
    const w = ADD_W[kind] ?? 80;
    const nm: Mover = {
      index: -1,
      id: asset.id,
      kind,
      x: isSwim ? null : 50,
      y: isSwim ? 16 : 50,
      w,
      w_pct: (w / 1280) * 100,
      flip: false,
      to_left: false,
      x0: null,
      x1: null,
      positionable: kind === 'float' || kind === 'patrol' || kind === 'pulse',
      has_y: true,
      cutout_url: asset.preview_url,
      isNew: true,
      still: motion.still,
    };
    setMovers((prev) => {
      const next = [...prev, nm];
      setSel(next.length - 1);
      return next;
    });
    setDirty(true);
    onDirty?.();
    setAdding(false);
  };

  const removeMover = (i: number) => {
    setMovers((prev) => {
      const m = prev[i];
      if (m && !m.isNew && m.index >= 0) setRemoved((r) => [...r, m.index]);
      return prev.filter((_, j) => j !== i);
    });
    setSel(null);
    setDirty(true);
    onDirty?.();
  };

  // Re-face the selected creature. Swim facing lives in `to_left`, everything else in `flip`.
  const toggleFlip = (i: number) => {
    setMovers((prev) =>
      prev.map((m, j) =>
        j !== i ? m : m.kind === 'swim' ? { ...m, to_left: !m.to_left } : { ...m, flip: !m.flip },
      ),
    );
    setDirty(true);
    onDirty?.();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const edits: MoverEdit[] = movers
        .filter((m) => !m.isNew && (m.positionable || m.kind === 'swim'))
        .map((m) => {
          const e: MoverEdit = { index: m.index, w: m.w };
          if (m.x != null) e.x = Math.round(m.x);
          if (m.y != null) e.y = Math.round(m.y);
          if (m.kind === 'swim') {
            e.to_left = m.to_left;          // swim facing key
            e.x0 = Math.round(m.x0 ?? 0);
            e.x1 = Math.round(m.x1 ?? 100);
          } else {
            e.flip = m.flip;                // float / patrol / pulse / peek facing key
          }
          return e;
        });
      const added: AddedMover[] = movers
        .filter((m) => m.isNew)
        .map((m) => {
          const a: AddedMover = { id: m.id, kind: m.kind, w: m.w, still: m.still };
          if (m.kind === 'swim') {
            a.y = Math.round(m.y ?? 16);
            a.flip = m.to_left;
            if (m.x0 != null) a.x0 = Math.round(m.x0);
            if (m.x1 != null) a.x1 = Math.round(m.x1);
          } else {
            a.x = Math.round(m.x ?? 50);
            a.y = Math.round(m.y ?? 50);
            a.flip = m.flip;
          }
          return a;
        });
      const res = await apiV4.saveVideoMovers(slug, { movers: edits, removed, added });
      setPreviewUrl(res.video_url);
      setDirty(false);
      setRemoved([]);
      onSaved?.();
      // re-sync mover indices + cutout urls with the freshly-written spec
      const fresh = await apiV4.getVideoMovers(slug);
      setMovers(fresh.movers);
      setSel(null);
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
                    <div
                      className="absolute"
                      style={{ top: 0, left: `${entry}%`, width: `${m.w_pct}%`, transform: 'translate(-50%,-50%)' }}
                    >
                      {m.cutout_url ? (
                        <img
                          src={m.cutout_url}
                          alt={m.id}
                          draggable={false}
                          onPointerDown={beginDrag(i, 'move')}
                          style={{ width: '100%', display: 'block', cursor: 'ns-resize', opacity: 0.92, transform: mirror, outline: selected ? '2px solid #2563eb' : 'none' }}
                        />
                      ) : (
                        <div
                          onPointerDown={beginDrag(i, 'move')}
                          title={m.id}
                          className="flex items-center justify-center rounded border border-blue-500 bg-blue-500/20 text-[9px] text-blue-700"
                          style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'ns-resize', outline: selected ? '2px solid #2563eb' : 'none' }}
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
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-600">Objects</p>
              <button
                onClick={() => setAdding((v) => !v)}
                className="rounded border border-blue-300 bg-white px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
              >
                {adding ? 'close' : '+ Add object'}
              </button>
            </div>

            {adding && (
              <div className="mb-2 space-y-2 rounded border border-blue-200 bg-blue-50/40 p-2">
                <div className="flex flex-wrap gap-1">
                  {MOTIONS.map((mo) => (
                    <button
                      key={mo.key}
                      onClick={() => setMotion(mo)}
                      className={`rounded border px-2 py-0.5 text-[11px] ${
                        motion.key === mo.key
                          ? 'border-blue-500 bg-blue-100 text-blue-700'
                          : 'border-gray-300 bg-white text-gray-600'
                      }`}
                    >
                      {mo.label}
                    </button>
                  ))}
                </div>
                {palette === null ? (
                  <p className="text-[11px] text-gray-400">Loading creatures…</p>
                ) : palette.length === 0 ? (
                  <p className="text-[11px] text-gray-400">No creatures available to add.</p>
                ) : (
                  <div className="grid max-h-52 grid-cols-4 gap-1.5 overflow-auto">
                    {palette.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => addMover(a)}
                        title={`add ${a.id} (${motion.label.toLowerCase()})`}
                        className="flex flex-col items-center rounded border border-gray-200 bg-white p-1 hover:border-blue-400 hover:bg-blue-50"
                      >
                        {a.preview_url ? (
                          <img src={a.preview_url} alt={a.id} draggable={false} className="h-10 w-full object-contain" />
                        ) : (
                          <div className="flex h-10 w-full items-center justify-center text-[10px] text-gray-300">—</div>
                        )}
                        <span className="mt-0.5 w-full truncate text-center text-[9px] text-gray-500">{a.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {sel != null && movers[sel] && FLIPPABLE.has(movers[sel].kind) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
                <span>
                  Selected <b>{movers[sel].id}</b>
                </span>
                <button
                  onClick={() => toggleFlip(sel)}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-50"
                >
                  Flip ↔
                </button>
                <button
                  onClick={() => removeMover(sel)}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 text-red-600 hover:bg-red-50"
                >
                  Remove ✕
                </button>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {movers.map((m, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                    i === sel ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-600'
                  }`}
                >
                  <button onClick={() => setSel(i === sel ? null : i)} className="inline-flex items-center gap-1">
                    {m.id} <span className="text-gray-400">· {m.kind}</span>
                    {m.isNew && <span className="text-emerald-600">· new</span>}
                    {m.x != null && (
                      <span className="ml-1 font-mono text-[10px] text-gray-400">
                        {Math.round(m.x)},{Math.round(m.y ?? 0)}
                      </span>
                    )}
                  </button>
                  <button onClick={() => removeMover(i)} title="remove from scene" className="text-gray-400 hover:text-red-600">
                    ✕
                  </button>
                </span>
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
