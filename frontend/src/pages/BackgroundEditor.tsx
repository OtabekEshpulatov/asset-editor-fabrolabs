import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiV4, type BackgroundEditable, type BgZone } from '../api';

// Preset colours for the well-known zone names; everything else falls back to a
// hex palette (hex so it's valid for <input type="color"> and SVG fill-opacity).
const ZONE_COLORS: Record<string, string> = {
  sky: '#3b82f6',
  mid: '#06b6d4',
  foreground: '#f59e0b',
  ground: '#22c55e',
  ceiling: '#a855f7',
  walls: '#ec4899',
  water: '#0ea5e9',
  surface: '#84cc16',
  buildings: '#ef4444',
  space: '#6366f1',
};
const PALETTE = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#0ea5e9', '#a855f7',
  '#ef4444', '#84cc16', '#06b6d4', '#6366f1', '#f97316', '#14b8a6',
];
const hashIndex = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % PALETTE.length;
  return h;
};
const defaultColor = (name: string) => ZONE_COLORS[name] ?? PALETTE[hashIndex(name)];
// A zone's effective colour: its own custom colour, else a stable default.
const zoneColor = (z: BgZone) => z.color || defaultColor(z.name);

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 100) / 100));
const TRACE_MIN_DIST = 1.5; // % — min spacing between freehand-sampled points

const centroid = (pts: number[][]): [number, number] => {
  if (!pts.length) return [50, 50];
  const x = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const y = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return [x, y];
};
// Project p onto each polygon edge; return the index to splice a new vertex at.
const nearestEdge = (pts: number[][], p: [number, number]) => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
};

type Drag = { kind: 'vertex'; zone: number; vertex: number };

export default function BackgroundEditorPage() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<BackgroundEditable | null>(null);
  const [original, setOriginal] = useState<BackgroundEditable | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  const [selected, setSelected] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<number[][]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const penDownRef = useRef(false);

  // Per-zone undo/redo: each zone (by stable _uid) keeps its OWN past/future
  // stacks, so ⌘Z only reverts the zone currently being edited. histTick
  // re-renders the toolbar so the buttons enable/disable.
  const dataRef = useRef<BackgroundEditable | null>(null);
  const uidRef = useRef(1);
  const zoneHistRef = useRef<Map<number, { past: BgZone[]; future: BgZone[] }>>(new Map());
  const lastTagRef = useRef<string | null>(null);
  const [histTick, setHistTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setSelected(null);
    setDrawing(false);
    setDraft([]);
    apiV4
      .getBackground(slug)
      .then((d) => {
        if (!alive) return;
        const dd = withUids(d);
        setData(dd);
        setOriginal(dd);
        setDirty(false);
        resetHistory();
      })
      .catch((e) => alive && setError(String(e?.response?.data?.detail ?? e)));
    return () => {
      alive = false;
    };
  }, [slug]);

  const pctFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100),
    };
  };

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const nextUid = () => uidRef.current++;
  // Assign a stable client-side id to each zone (used only for per-zone history
  // and React keys; the backend ignores the field and never persists it).
  const withUids = (d: BackgroundEditable): BackgroundEditable => ({
    ...d,
    zones: d.zones.map((z) => (z._uid != null ? z : { ...z, _uid: nextUid() })),
  });

  const resetHistory = () => {
    zoneHistRef.current = new Map();
    lastTagRef.current = null;
    setHistTick((t) => t + 1);
  };

  const histFor = (uid: number) => {
    let h = zoneHistRef.current.get(uid);
    if (!h) {
      h = { past: [], future: [] };
      zoneHistRef.current.set(uid, h);
    }
    return h;
  };

  // Snapshot ONE zone before it changes. `tag` coalesces a run of the same edit
  // (e.g. typing / a single drag) into one undo step.
  const snapshotZone = (uid: number | undefined, tag?: string) => {
    if (uid == null) return;
    const z = dataRef.current?.zones.find((q) => q._uid === uid);
    if (!z) return;
    if (tag && lastTagRef.current === tag) return;
    const h = histFor(uid);
    h.past.push(z);
    if (h.past.length > 200) h.past.shift();
    h.future = [];
    lastTagRef.current = tag ?? null;
    setHistTick((t) => t + 1);
  };

  const selectedUid = () =>
    selected != null ? dataRef.current?.zones[selected]?._uid ?? undefined : undefined;

  const undo = () => {
    if (drawing) {
      // while drawing, ⌘Z drops the last point placed
      setDraft((d) => d.slice(0, -1));
      return;
    }
    const uid = selectedUid();
    if (uid == null) return;
    const cur = dataRef.current?.zones.find((q) => q._uid === uid);
    const h = zoneHistRef.current.get(uid);
    if (!cur || !h || !h.past.length) return;
    h.future.push(cur);
    const prev = h.past.pop()!;
    setData((d) => (d ? { ...d, zones: d.zones.map((q) => (q._uid === uid ? prev : q)) } : d));
    lastTagRef.current = null;
    setDirty(true);
    setSavedAt(false);
    setHistTick((t) => t + 1);
  };

  const redo = () => {
    if (drawing) return;
    const uid = selectedUid();
    if (uid == null) return;
    const cur = dataRef.current?.zones.find((q) => q._uid === uid);
    const h = zoneHistRef.current.get(uid);
    if (!cur || !h || !h.future.length) return;
    h.past.push(cur);
    const next = h.future.pop()!;
    setData((d) => (d ? { ...d, zones: d.zones.map((q) => (q._uid === uid ? next : q)) } : d));
    lastTagRef.current = null;
    setDirty(true);
    setSavedAt(false);
    setHistTick((t) => t + 1);
  };

  // Window-level vertex drag handler; reads the active target from dragRef.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!d || !rect) return;
      const x = clamp(((ev.clientX - rect.left) / rect.width) * 100);
      const y = clamp(((ev.clientY - rect.top) / rect.height) * 100);
      setData((prev) => {
        if (!prev) return prev;
        const zones = prev.zones.map((z, i) => {
          if (i !== d.zone || !z.polygon) return z;
          return { ...z, polygon: z.polygon.map((pt, vi) => (vi === d.vertex ? [x, y] : pt)) };
        });
        return { ...prev, zones };
      });
      setDirty(true);
      setSavedAt(false);
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
  }, []);

  // Esc cancels / Enter finishes an in-progress draw.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape' && drawing) cancelDraw();
      if (e.key === 'Enter' && drawing) finishDraw();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const patch = (next: Partial<BackgroundEditable>) => {
    setData((prev) => (prev ? { ...prev, ...next } : prev));
    setDirty(true);
    setSavedAt(false);
  };

  const updateZone = (i: number, next: Partial<BgZone>) => {
    if (!data) return;
    patch({ zones: data.zones.map((z, idx) => (idx === i ? { ...z, ...next } : z)) });
  };

  const uniqueName = (base: string) => {
    const used = new Set((data?.zones ?? []).map((z) => z.name));
    if (!used.has(base)) return base;
    let n = 1;
    while (used.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  };

  const startDraw = () => {
    setDrawing(true);
    setDraft([]);
    setSelected(null);
  };
  const cancelDraw = () => {
    setDrawing(false);
    setDraft([]);
    penDownRef.current = false;
  };
  const finishDraw = () => {
    if (!data || draft.length < 3) {
      cancelDraw();
      return;
    }
    const name = uniqueName('zone');
    const newZone: BgZone = {
      _uid: nextUid(),
      name,
      y_start_pct: Math.min(...draft.map((p) => p[1])),
      y_end_pct: Math.max(...draft.map((p) => p[1])),
      description: '',
      polygon: draft,
      surface: 'none',
    };
    patch({ zones: [...data.zones, newZone] });
    setSelected(data.zones.length);
    setDrawing(false);
    setDraft([]);
    penDownRef.current = false;
  };

  // Append a point while drawing — click adds a corner, drag samples a trail.
  const addDraftPoint = (x: number, y: number, force = false) => {
    setDraft((d) => {
      if (!force && d.length) {
        const last = d[d.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < TRACE_MIN_DIST) return d;
      }
      return [...d, [x, y]];
    });
  };

  const removeZone = (i: number) => {
    if (!data) return;
    patch({ zones: data.zones.filter((_, idx) => idx !== i) });
    setSelected(null);
  };

  const insertVertex = (zoneIdx: number) => (e: React.MouseEvent) => {
    if (!data) return;
    const z = data.zones[zoneIdx];
    if (!z.polygon) return;
    e.preventDefault();
    e.stopPropagation();
    snapshotZone(z._uid);
    const { x, y } = pctFromEvent(e);
    const at = nearestEdge(z.polygon, [x, y]);
    updateZone(zoneIdx, { polygon: [...z.polygon.slice(0, at), [x, y], ...z.polygon.slice(at)] });
    setSelected(zoneIdx);
  };

  const deleteVertex = (zoneIdx: number, vi: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!data) return;
    const z = data.zones[zoneIdx];
    if (!z.polygon || z.polygon.length <= 3) return;
    snapshotZone(z._uid);
    updateZone(zoneIdx, { polygon: z.polygon.filter((_, idx) => idx !== vi) });
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await apiV4.saveBackground(data.slug, {
        scene_type: data.scene_type,
        description: data.description,
        zones: data.zones,
      });
      const dd = withUids(updated);
      setData(dd);
      setOriginal(dd);
      setDirty(false);
      setSavedAt(true);
      setSelected(null);
      resetHistory();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (original) {
      setData(original);
      setDirty(false);
      setSavedAt(false);
      setSelected(null);
      cancelDraw();
      resetHistory();
    }
  };

  if (error && !data) {
    return (
      <div className="space-y-3">
        <Link to="/assets" className="text-sm text-blue-600 hover:underline">
          ← back to assets
        </Link>
        <div className="text-red-600">Failed to load: {error}</div>
      </div>
    );
  }
  if (!data) return <div className="text-gray-500">Loading background…</div>;

  // histTick is read so these recompute whenever the undo history changes.
  void histTick;
  const selUid = selected != null ? data.zones[selected]?._uid : undefined;
  const selHist = selUid != null ? zoneHistRef.current.get(selUid) : undefined;
  const canUndo = drawing ? draft.length > 0 : !!selHist?.past.length;
  const canRedo = drawing ? false : !!selHist?.future.length;
  const surfaces = data.allowed_surfaces ?? ['floor', 'water', 'wall', 'sky', 'tabletop', 'decor', 'none'];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/assets" className="text-sm text-blue-600 hover:underline">
            ← assets
          </Link>
          <h2 className="text-xl font-semibold">
            Zone editor — <span className="font-mono text-base">{data.slug}</span>
          </h2>
          <p className="text-xs text-gray-500">
            {data.scene_type} · {data.resolution.width}×{data.resolution.height} ·{' '}
            <span className="font-mono">{data.manifest_key}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-gray-600" title="Disabled backgrounds are hidden everywhere">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={async (e) => {
                const enabled = e.target.checked;
                setData((prev) => (prev ? { ...prev, enabled } : prev));
                try {
                  await apiV4.setAssetConfig('background', data.slug, { enabled });
                } catch {
                  setData((prev) => (prev ? { ...prev, enabled: !enabled } : prev));
                }
              }}
            />
            enabled
          </label>
          {savedAt && <span className="text-sm text-green-600">Saved ✓</span>}
          {dirty && <span className="text-sm text-amber-600">Unsaved changes</span>}
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo edits to the selected zone (⌘/Ctrl+Z)"
            className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-600 disabled:opacity-40 hover:bg-gray-50"
          >
            ⤺
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (⌘/Ctrl+Shift+Z)"
            className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-600 disabled:opacity-40 hover:bg-gray-50"
          >
            ⤻
          </button>
          <button
            onClick={reset}
            disabled={!dirty || saving}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 disabled:opacity-40 hover:bg-gray-50"
          >
            Reset
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:bg-blue-700"
          >
            {saving ? 'Saving…' : 'Save to manifest'}
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        {/* Canvas with overlays */}
        <div
          ref={containerRef}
          className="relative w-full select-none overflow-hidden rounded-lg border border-gray-300 bg-gray-100"
          style={{ aspectRatio: '16 / 9', touchAction: 'none', cursor: drawing ? 'crosshair' : 'default' }}
        >
          {data.url && (
            <img
              src={data.url}
              alt={data.slug}
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}

          {/* polygon zones */}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            style={{ zIndex: 10, pointerEvents: drawing ? 'none' : 'auto' }}
          >
            {data.zones.map((z, i) => {
              const c = zoneColor(z);
              const pts = (z.polygon ?? []).map((p) => `${p[0]},${p[1]}`).join(' ');
              const isSel = selected === i;
              return (
                <polygon
                  key={`${z.name}-${i}`}
                  points={pts}
                  fill={c}
                  fillOpacity={isSel ? 0.32 : 0.18}
                  stroke={c}
                  strokeWidth={isSel ? 2.5 : 1.5}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: 'pointer' }}
                  onPointerDown={() => setSelected(i)}
                  onDoubleClick={insertVertex(i)}
                />
              );
            })}
            {drawing && draft.length > 0 && (
              <polyline
                points={draft.map((p) => `${p[0]},${p[1]}`).join(' ')}
                fill="rgba(59,130,246,0.15)"
                stroke="#3b82f6"
                strokeWidth={2}
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* zone labels (HTML so text stays crisp under the non-uniform SVG) */}
          {data.zones.map((z, i) => {
            const [cx, cy] = centroid(z.polygon ?? []);
            return (
              <span
                key={`lbl-${i}`}
                onPointerDown={() => setSelected(i)}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/65 px-1 text-[10px] font-medium text-white"
                style={{ left: `${cx}%`, top: `${cy}%`, zIndex: 13, cursor: 'pointer' }}
              >
                {z.name}
                {z.surface && z.surface !== 'none' ? ` · ${z.surface}` : ''}
              </span>
            );
          })}

          {/* vertex handles for the selected zone */}
          {selected != null &&
            data.zones[selected]?.polygon?.map((p, vi) => (
              <div
                key={`v-${vi}`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  snapshotZone(data.zones[selected]?._uid);
                  dragRef.current = { kind: 'vertex', zone: selected, vertex: vi };
                }}
                onContextMenu={deleteVertex(selected, vi)}
                title="drag to move · right-click to delete"
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-blue-600 shadow"
                style={{ left: `${p[0]}%`, top: `${p[1]}%`, zIndex: 30 }}
              />
            ))}

          {/* draft vertex dots (non-interactive so clicks reach the capture layer) */}
          {drawing &&
            draft.map((p, vi) => (
              <div
                key={`d-${vi}`}
                className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-blue-500"
                style={{ left: `${p[0]}%`, top: `${p[1]}%`, zIndex: 31, pointerEvents: 'none' }}
              />
            ))}

          {/* click / freehand capture layer while drawing */}
          {drawing && (
            <div
              className="absolute inset-0"
              style={{ zIndex: 25, touchAction: 'none' }}
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                penDownRef.current = true;
                const { x, y } = pctFromEvent(e);
                addDraftPoint(x, y, true);
              }}
              onPointerMove={(e) => {
                if (!penDownRef.current) return;
                const { x, y } = pctFromEvent(e);
                addDraftPoint(x, y);
              }}
              onPointerUp={() => {
                penDownRef.current = false;
              }}
            />
          )}
        </div>

        {/* Control panel */}
        <div className="space-y-4 text-sm">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Scene type
            </span>
            <input
              value={data.scene_type}
              onChange={(e) => patch({ scene_type: e.target.value })}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Description
            </span>
            <textarea
              value={data.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Zones ({data.zones.length})
              </span>
              {drawing ? (
                <div className="flex items-center gap-1">
                  <button
                    onClick={finishDraw}
                    disabled={draft.length < 3}
                    className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Finish ({draft.length})
                  </button>
                  <button
                    onClick={cancelDraw}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={startDraw}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                >
                  ✏️ draw zone
                </button>
              )}
            </div>
            {drawing && (
              <p className="mb-2 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                <b>Click</b> to drop corners, or <b>press &amp; drag</b> to trace a freehand outline
                (any number of edges). <b>Finish</b>/Enter to close · Esc to cancel.
              </p>
            )}
            <div className="space-y-2">
              {data.zones.map((z, i) => {
                const isSel = selected === i;
                return (
                  <div
                    key={i}
                    className={`rounded border p-2 ${isSel ? 'border-blue-400 bg-blue-50/40' : 'border-gray-200'}`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <input
                        type="color"
                        value={zoneColor(z)}
                        onChange={(e) => {
                          snapshotZone(z._uid, 'color:' + z._uid);
                          updateZone(i, { color: e.target.value });
                        }}
                        title="zone colour"
                        className="h-5 w-6 shrink-0 cursor-pointer rounded border border-gray-300 bg-white p-0"
                      />
                      <input
                        value={z.name}
                        onChange={(e) => {
                          snapshotZone(z._uid, 'name:' + z._uid);
                          updateZone(i, { name: e.target.value });
                        }}
                        placeholder="zone name"
                        className="w-24 rounded border border-gray-300 px-1 py-0.5 font-mono text-xs"
                      />
                      <select
                        value={z.surface ?? 'none'}
                        onChange={(e) => {
                          snapshotZone(z._uid);
                          updateZone(i, { surface: e.target.value });
                        }}
                        title="placement surface (matches object rest_surface)"
                        className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                      >
                        {surfaces.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setSelected(isSel ? null : i)}
                        className={`ml-auto rounded px-1.5 py-0.5 text-xs ${isSel ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                        title="edit polygon vertices on the canvas"
                      >
                        {isSel ? 'editing' : 'edit shape'}
                      </button>
                      <button
                        onClick={() => removeZone(i)}
                        className="rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        title="delete zone"
                      >
                        ✕
                      </button>
                    </div>
                    <input
                      value={z.description}
                      onChange={(e) => {
                        snapshotZone(z._uid, 'desc:' + z._uid);
                        updateZone(i, { description: e.target.value });
                      }}
                      placeholder="description (what the LLM places here)…"
                      className="w-full rounded border border-gray-200 px-1 py-0.5 text-xs text-gray-600"
                    />
                    {isSel && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        {z.polygon?.length ?? 0} points · drag dots to move · double-click an edge to
                        add · right-click a dot to delete
                      </p>
                    )}
                  </div>
                );
              })}
              {data.zones.length === 0 && !drawing && (
                <p className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-400">
                  No zones. Click <b>draw zone</b> to add as many named regions as you like — the
                  agent reads each zone’s name + description to choose where to place things.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
