import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, PenLine, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { data, type BackgroundDoc, type BgZone } from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import { Badge } from '@/components/ui/feedback';
import { centroid, clampPct, nearestEdge, zoneColor } from './zoneColors';

const TRACE_MIN_DIST = 1.5; // % — minimum spacing between freehand-sampled points

type Drag = { zone: number; vertex: number } | null;

/**
 * Polygon zone editor.
 *
 * Zones tell the story engine where things may be placed, so the shapes matter.
 * Two behaviours carried over from the old editor because they were right:
 *
 *  - Freehand OR click-to-place. Press and drag traces an outline; clicking
 *    drops individual corners. Tracing a shoreline with 40 points is much faster
 *    than placing them one at a time.
 *  - PER-ZONE undo. Each zone keeps its own past/future stack, so ⌘Z reverts the
 *    zone you are editing rather than some unrelated earlier edit.
 */
export function ZoneEditor({
  doc,
  onSaved,
}: {
  doc: BackgroundDoc;
  onSaved: (next: BackgroundDoc) => void;
}) {
  // Refs first: the `zones` initializer calls withUids(), which reads uidRef.
  // Declaring the ref after the useState would leave it in the temporal dead
  // zone at that moment and throw on mount.
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag>(null);
  const penDownRef = useRef(false);
  const uidRef = useRef(1000);

  const [zones, setZones] = useState<BgZone[]>(() => withUids(doc.zones));
  const [description, setDescription] = useState(doc.description);
  const [selected, setSelected] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<number[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  // Per-zone history, keyed by the client-only _uid.
  const histRef = useRef(new Map<number, { past: BgZone[]; future: BgZone[] }>());
  const lastTagRef = useRef<string | null>(null);
  const [histTick, setHistTick] = useState(0);

  function withUids(list: BgZone[]): BgZone[] {
    return list.map((z) => (z._uid != null ? z : { ...z, _uid: uidRef.current++ }));
  }

  useEffect(() => {
    setZones(withUids(doc.zones));
    setDescription(doc.description);
    setSelected(null);
    setDirty(false);
    histRef.current = new Map();
    setHistTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.slug]);

  const markDirty = () => setDirty(true);

  const histFor = (uid: number) => {
    let h = histRef.current.get(uid);
    if (!h) {
      h = { past: [], future: [] };
      histRef.current.set(uid, h);
    }
    return h;
  };

  /** Snapshot ONE zone before it changes. `tag` coalesces a run of the same
   *  edit (a drag, a burst of typing) into a single undo step. */
  const snapshot = useCallback((uid: number | undefined, tag?: string) => {
    if (uid == null) return;
    const z = zonesRef.current.find((q) => q._uid === uid);
    if (!z) return;
    if (tag && lastTagRef.current === tag) return;
    const h = histFor(uid);
    h.past.push(z);
    if (h.past.length > 200) h.past.shift();
    h.future = [];
    lastTagRef.current = tag ?? null;
    setHistTick((t) => t + 1);
  }, []);

  const selectedUid = () => (selected != null ? zonesRef.current[selected]?._uid : undefined);

  const undo = useCallback(() => {
    if (drawing) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    const uid = selectedUid();
    if (uid == null) return;
    const cur = zonesRef.current.find((q) => q._uid === uid);
    const h = histRef.current.get(uid);
    if (!cur || !h?.past.length) return;
    h.future.push(cur);
    const prev = h.past.pop()!;
    setZones((zs) => zs.map((q) => (q._uid === uid ? prev : q)));
    lastTagRef.current = null;
    markDirty();
    setHistTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, selected]);

  const redo = useCallback(() => {
    if (drawing) return;
    const uid = selectedUid();
    if (uid == null) return;
    const cur = zonesRef.current.find((q) => q._uid === uid);
    const h = histRef.current.get(uid);
    if (!cur || !h?.future.length) return;
    h.past.push(cur);
    const next = h.future.pop()!;
    setZones((zs) => zs.map((q) => (q._uid === uid ? next : q)));
    lastTagRef.current = null;
    markDirty();
    setHistTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, selected]);

  const pctFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clampPct(((e.clientX - rect.left) / rect.width) * 100),
      y: clampPct(((e.clientY - rect.top) / rect.height) * 100),
    };
  };

  // Window-level vertex drag: pointer can leave the canvas mid-drag.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!d || !rect) return;
      const x = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
      const y = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
      setZones((prev) =>
        prev.map((z, i) =>
          i !== d.zone
            ? z
            : { ...z, polygon: z.polygon.map((pt, vi) => (vi === d.vertex ? [x, y] : pt)) },
        ),
      );
      markDirty();
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

  // Keyboard: undo/redo, and Enter/Escape while drawing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === 'Escape' && drawing) cancelDraw();
      if (e.key === 'Enter' && drawing) finishDraw();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const updateZone = (i: number, patch: Partial<BgZone>) => {
    setZones((prev) => prev.map((z, idx) => (idx === i ? { ...z, ...patch } : z)));
    markDirty();
  };

  const uniqueName = (base: string) => {
    const used = new Set(zones.map((z) => z.name));
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
    if (draft.length < 3) {
      cancelDraw();
      return;
    }
    const zone: BgZone = {
      _uid: uidRef.current++,
      name: uniqueName('zone'),
      description: '',
      polygon: draft,
      surface: 'none',
      color: null,
    };
    setZones((prev) => [...prev, zone]);
    setSelected(zones.length);
    setDrawing(false);
    setDraft([]);
    penDownRef.current = false;
    markDirty();
  };

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
    setZones((prev) => prev.filter((_, idx) => idx !== i));
    setSelected(null);
    markDirty();
  };

  const insertVertex = (zoneIdx: number) => (e: React.MouseEvent) => {
    const z = zones[zoneIdx];
    if (!z.polygon.length) return;
    e.preventDefault();
    e.stopPropagation();
    snapshot(z._uid);
    const { x, y } = pctFromEvent(e);
    const at = nearestEdge(z.polygon, [x, y]);
    updateZone(zoneIdx, {
      polygon: [...z.polygon.slice(0, at), [x, y], ...z.polygon.slice(at)],
    });
    setSelected(zoneIdx);
  };

  const deleteVertex = (zoneIdx: number, vi: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const z = zones[zoneIdx];
    if (z.polygon.length <= 3) return;
    snapshot(z._uid);
    updateZone(zoneIdx, { polygon: z.polygon.filter((_, idx) => idx !== vi) });
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await data.saveBackgroundDoc(doc.slug, { description, zones });
      setZones(withUids(next.zones));
      setDirty(false);
      setSelected(null);
      histRef.current = new Map();
      onSaved(next);
      toast.success('Zones saved', { description: `${next.zones.length} zones written.` });
    } catch (err) {
      toast.error('Could not save zones', { description: String((err as Error).message) });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setZones(withUids(doc.zones));
    setDescription(doc.description);
    setDirty(false);
    setSelected(null);
    cancelDraw();
    histRef.current = new Map();
    setHistTick((t) => t + 1);
  };

  void histTick; // read so undo/redo availability recomputes
  const selUid = selected != null ? zones[selected]?._uid : undefined;
  const selHist = selUid != null ? histRef.current.get(selUid) : undefined;
  const canUndo = drawing ? draft.length > 0 : !!selHist?.past.length;
  const canRedo = !drawing && !!selHist?.future.length;
  const surfaces = doc.allowed_surfaces?.length
    ? doc.allowed_surfaces
    : ['floor', 'water', 'wall', 'sky', 'tabletop', 'decor', 'none'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={undo} disabled={!canUndo} aria-label="Undo">
            <Undo2 />
          </Button>
          <Button variant="outline" size="icon" onClick={redo} disabled={!canRedo} aria-label="Redo">
            <Redo2 />
          </Button>
          <Button variant="outline" size="sm" onClick={reset} disabled={!dirty || saving}>
            Reset
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
            Save zones
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_320px]">
        {/* Canvas */}
        <div>
          <div
            ref={containerRef}
            className="relative w-full select-none overflow-hidden rounded-lg border border-border bg-muted"
            style={{
              aspectRatio: '16 / 9',
              touchAction: 'none',
              cursor: drawing ? 'crosshair' : 'default',
            }}
          >
            {doc.url && (
              <img
                src={doc.url}
                alt={doc.slug}
                draggable={false}
                className="absolute inset-0 size-full object-cover"
              />
            )}

            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 size-full"
              style={{ zIndex: 10, pointerEvents: drawing ? 'none' : 'auto' }}
            >
              {zones.map((z, i) => {
                const c = zoneColor(z);
                const isSel = selected === i;
                return (
                  <polygon
                    key={z._uid ?? i}
                    points={z.polygon.map((p) => `${p[0]},${p[1]}`).join(' ')}
                    fill={c}
                    fillOpacity={isSel ? 0.34 : 0.18}
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

            {/* Labels in HTML so text stays crisp under the non-uniform SVG scale */}
            {zones.map((z, i) => {
              const [cx, cy] = centroid(z.polygon);
              return (
                <button
                  key={`lbl-${z._uid ?? i}`}
                  type="button"
                  onPointerDown={() => setSelected(i)}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1 py-px text-[10px] font-medium text-white"
                  style={{ left: `${cx}%`, top: `${cy}%`, zIndex: 13 }}
                >
                  {z.name}
                  {z.surface && z.surface !== 'none' ? ` · ${z.surface}` : ''}
                </button>
              );
            })}

            {/* Vertex handles for the selected zone */}
            {selected != null &&
              zones[selected]?.polygon.map((p, vi) => (
                <div
                  key={`v-${vi}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    snapshot(zones[selected]?._uid, `drag:${selected}:${vi}`);
                    dragRef.current = { zone: selected, vertex: vi };
                  }}
                  onContextMenu={deleteVertex(selected, vi)}
                  title="Drag to move · right-click to delete"
                  className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-primary shadow"
                  style={{ left: `${p[0]}%`, top: `${p[1]}%`, zIndex: 30 }}
                />
              ))}

            {drawing &&
              draft.map((p, vi) => (
                <div
                  key={`d-${vi}`}
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary"
                  style={{ left: `${p[0]}%`, top: `${p[1]}%`, zIndex: 31 }}
                />
              ))}

            {/* Capture layer while drawing */}
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

          {drawing && (
            <p className="mt-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
              <b>Click</b> to drop corners, or <b>press and drag</b> to trace a freehand outline.
              <b> Enter</b> to close · <b>Esc</b> to cancel.
            </p>
          )}
        </div>

        {/* Panel */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Scene description</Label>
            <Input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                markDirty();
              }}
              placeholder="What this scene shows…"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Zones ({zones.length})</Label>
              {drawing ? (
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={finishDraw} disabled={draft.length < 3}>
                    <Check />
                    Finish ({draft.length})
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelDraw}>
                    <X />
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={startDraw}>
                  <PenLine />
                  Draw zone
                </Button>
              )}
            </div>

            <div className="space-y-2">
              {zones.map((z, i) => {
                const isSel = selected === i;
                return (
                  <div
                    key={z._uid ?? i}
                    className={cn(
                      'rounded-lg border p-2 transition-colors',
                      isSel ? 'border-primary bg-primary/5' : 'border-border',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        type="color"
                        value={zoneColor(z)}
                        onChange={(e) => {
                          snapshot(z._uid, `color:${z._uid}`);
                          updateZone(i, { color: e.target.value });
                        }}
                        title="Zone colour"
                        className="size-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                      />
                      <Input
                        value={z.name}
                        onChange={(e) => {
                          snapshot(z._uid, `name:${z._uid}`);
                          updateZone(i, { name: e.target.value });
                        }}
                        className="h-7 w-24 font-mono text-xs"
                        placeholder="name"
                      />
                      <Select
                        value={z.surface ?? 'none'}
                        onValueChange={(v) => {
                          snapshot(z._uid);
                          updateZone(i, { surface: v });
                        }}
                      >
                        <SelectTrigger className="h-7 flex-1 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {surfaces.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeZone(i)}
                        aria-label={`Delete ${z.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>

                    <Input
                      value={z.description}
                      onChange={(e) => {
                        snapshot(z._uid, `desc:${z._uid}`);
                        updateZone(i, { description: e.target.value });
                      }}
                      placeholder="What the engine may place here…"
                      className="mt-1.5 h-7 text-xs"
                    />

                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="text-2xs text-muted-foreground">
                        {z.polygon.length} points
                      </span>
                      <Button
                        variant={isSel ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setSelected(isSel ? null : i)}
                      >
                        {isSel ? 'Editing shape' : 'Edit shape'}
                      </Button>
                    </div>

                    {isSel && (
                      <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                        Drag a dot to move it · double-click an edge to add one · right-click a dot
                        to delete it · ⌘Z undoes just this zone.
                      </p>
                    )}
                  </div>
                );
              })}

              {zones.length === 0 && !drawing && (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  No zones yet. <b>Draw zone</b> adds as many named regions as you like — the engine
                  reads each zone&apos;s name and description to decide what goes where.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
