import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlipHorizontal, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import {
  data,
  type AddedMover,
  type Mover,
  type MoverEdit,
  type RenderJob,
  type VideoMovers,
} from '@/lib/data';
import { qk } from '@/app/queryKeys';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Slider, Tooltip } from '@/components/ui/controls';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/overlay';

/** Motion presets offered when adding a creature; each maps to a spec kind. */
const MOTIONS = [
  { key: 'wave', label: 'Fly across', kind: 'swim', still: false, breathe: false },
  { key: 'breathe', label: 'Stay & pulse', kind: 'float', still: true, breathe: true },
  { key: 'drift', label: 'Drift gently', kind: 'float', still: false, breathe: false },
  { key: 'patrol', label: 'Pace side to side', kind: 'patrol', still: false, breathe: false },
  { key: 'twinkle', label: 'Twinkle', kind: 'pulse', still: false, breathe: false },
] as const;

const FLIPPABLE = new Set(['float', 'patrol', 'pulse', 'peek', 'swim']);
const SPEEDABLE = new Set(['float', 'swim', 'patrol', 'pulse']);
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

type Drag =
  | { index: number; mode: 'move' }
  | { index: number; mode: 'resize'; startX: number; origW: number }
  | null;

/**
 * Moving-object editor for a live background.
 *
 * Drag creatures where you want them, then save — which on the real backend
 * re-renders the mp4 with ffmpeg. That takes seconds, not milliseconds, so the
 * save path is modelled as a JOB with visible progress rather than a spinner
 * that looks hung. The prototype ticks the same job states the real render
 * reports.
 */
export function ObjectLayerEditor({ slug, posterUrl }: { slug: string; posterUrl: string | null }) {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [removed, setRemoved] = useState<number[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [adding, setAdding] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag>(null);

  const { data: scene, isLoading, error, refetch } = useQuery<VideoMovers>({
    queryKey: qk.movers(slug),
    queryFn: () => data.getMovers(slug),
    retry: false,
  });

  useEffect(() => {
    if (!scene) return;
    setMovers(scene.movers);
    setRemoved([]);
    setDirty(false);
    setSel(null);
  }, [scene]);

  // Window-level drag so the pointer can leave the canvas mid-gesture.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!d || !rect) return;

      if (d.mode === 'move') {
        const x = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
        const y = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
        setMovers((prev) =>
          prev.map((m, i) =>
            i !== d.index ? m : { ...m, x: Number(x.toFixed(1)), y: m.has_y ? Number(y.toFixed(1)) : m.y },
          ),
        );
      } else {
        const deltaPx = ev.clientX - d.startX;
        // Widths are px at a 1280 render baseline; convert canvas px to that.
        const scale = 1280 / rect.width;
        const w = Math.max(16, Math.round(d.origW + deltaPx * scale));
        setMovers((prev) =>
          prev.map((m, i) =>
            i !== d.index ? m : { ...m, w, w_pct: Number(((w / 1280) * 100).toFixed(2)) },
          ),
        );
      }
      setDirty(true);
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

  const patchMover = (index: number, patch: Partial<Mover>) => {
    setMovers((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
    setDirty(true);
  };

  const dropMover = (index: number) => {
    const m = movers[index];
    if (!m.isNew) setRemoved((r) => [...r, m.index]);
    setMovers((prev) => prev.filter((_, i) => i !== index));
    setSel(null);
    setDirty(true);
  };

  const save = async () => {
    setJob({ progress: 0, status: 'queued', message: 'Starting' });
    const edits: MoverEdit[] = movers
      .filter((m) => !m.isNew)
      .map((m) => ({
        index: m.index,
        x: m.x ?? undefined,
        y: m.y ?? undefined,
        w: m.w,
        flip: m.flip,
        to_left: m.to_left,
        speed: m.speed,
      }));
    const added: AddedMover[] = movers
      .filter((m) => m.isNew)
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        x: m.x ?? undefined,
        y: m.y ?? undefined,
        w: m.w,
        flip: m.flip,
        still: m.still,
        breathe: m.breathe,
        speed: m.speed,
      }));

    try {
      await data.saveMovers(slug, { movers: edits, removed, added }, setJob);
      setDirty(false);
      setRemoved([]);
      await refetch();
      toast.success('Scene re-rendered', { description: 'The mp4 was rebuilt and uploaded.' });
    } catch (err) {
      toast.error('Render failed', { description: String((err as Error).message) });
    } finally {
      setJob(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }

  if (error) {
    const msg = String((error as Error).message);
    return (
      <div className="p-4">
        {msg.includes('source bundle') ? (
          <EmptyState
            title="This scene has no editable source bundle"
            description="Moving objects can only be edited when the original spec, plate and cutouts are still in storage. Zones and transitions still work."
          />
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const selected = sel != null ? movers[sel] : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}
        <span className="text-2xs text-muted-foreground">
          {movers.length} object{movers.length === 1 ? '' : 's'}
          {removed.length > 0 && ` · ${removed.length} removed`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add creature
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty} loading={!!job}>
            Save &amp; re-render
          </Button>
        </div>
      </div>

      {job && (
        <div className="shrink-0 border-b border-border bg-primary/5 px-4 py-2">
          <div className="mb-1 flex items-center justify-between text-2xs">
            <span className="text-primary">{job.message}</span>
            <span className="tabular-nums text-muted-foreground">{job.progress}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_280px]">
        <div
          ref={canvasRef}
          className="relative w-full select-none overflow-hidden rounded-lg border border-border bg-muted"
          style={{ aspectRatio: '16 / 9', touchAction: 'none' }}
          onPointerDown={() => setSel(null)}
        >
          {posterUrl && (
            <img
              src={posterUrl}
              alt={slug}
              draggable={false}
              className="absolute inset-0 size-full object-cover"
            />
          )}

          {movers.map((m, i) => {
            const isSel = sel === i;
            return (
              <div
                key={`${m.id}-${i}`}
                className={cn(
                  'absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded',
                  isSel && 'ring-2 ring-primary',
                )}
                style={{
                  left: `${m.x ?? 50}%`,
                  top: `${m.y ?? 50}%`,
                  width: `${m.w_pct}%`,
                  zIndex: isSel ? 20 : 10,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSel(i);
                  dragRef.current = { index: i, mode: 'move' };
                }}
              >
                {m.cutout_url ? (
                  <img
                    src={m.cutout_url}
                    alt={m.id}
                    draggable={false}
                    className="size-full object-contain drop-shadow"
                    style={{ transform: m.flip ? 'scaleX(-1)' : undefined }}
                  />
                ) : (
                  <div className="grid aspect-square place-items-center rounded bg-primary/30 text-[9px] text-white">
                    {m.kind}
                  </div>
                )}

                {isSel && (
                  <>
                    <span className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1 text-[9px] text-white">
                      {m.id} · {m.kind}
                    </span>
                    <div
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        dragRef.current = { index: i, mode: 'resize', startX: e.clientX, origW: m.w };
                      }}
                      title="Drag to resize"
                      className="absolute -bottom-1 -right-1 size-3 cursor-nwse-resize rounded-full border-2 border-white bg-primary"
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Inspector */}
        <div className="space-y-3">
          {!selected ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              Click an object on the frame to move, resize, face or remove it. Drag it anywhere;
              saving re-renders the video.
            </p>
          ) : (
            <div className="space-y-3 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-[13px]">{selected.id}</p>
                  <p className="text-2xs text-muted-foreground">{selected.kind}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => dropMover(sel!)}
                  aria-label="Remove object"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>

              <Separator />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Size</Label>
                  <span className="text-2xs tabular-nums text-muted-foreground">
                    {selected.w}px
                  </span>
                </div>
                <Slider
                  min={16}
                  max={400}
                  step={2}
                  value={[selected.w]}
                  onValueChange={([w]) =>
                    patchMover(sel!, { w, w_pct: Number(((w / 1280) * 100).toFixed(2)) })
                  }
                />
              </div>

              {SPEEDABLE.has(selected.kind) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Speed</Label>
                    <span className="text-2xs tabular-nums text-muted-foreground">
                      {selected.speed.toFixed(2)}×
                    </span>
                  </div>
                  <Slider
                    min={0.25}
                    max={3}
                    step={0.05}
                    value={[selected.speed]}
                    onValueChange={([speed]) => patchMover(sel!, { speed })}
                  />
                </div>
              )}

              {FLIPPABLE.has(selected.kind) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() =>
                    selected.kind === 'swim'
                      ? patchMover(sel!, { to_left: !selected.to_left })
                      : patchMover(sel!, { flip: !selected.flip })
                  }
                >
                  <FlipHorizontal />
                  Face the other way
                </Button>
              )}

              <p className="text-2xs text-muted-foreground">
                x {selected.x?.toFixed(1) ?? '—'} · y{' '}
                {selected.has_y ? (selected.y?.toFixed(1) ?? '—') : 'n/a'}
              </p>
            </div>
          )}
        </div>
      </div>

      <AddCreatureDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={(id, motion, preview) => {
          const m: Mover = {
            index: -1,
            id,
            kind: motion.kind,
            x: 50,
            y: 50,
            w: 80,
            w_pct: Number(((80 / 1280) * 100).toFixed(2)),
            flip: false,
            to_left: false,
            x0: motion.kind === 'swim' ? 5 : null,
            x1: motion.kind === 'swim' ? 95 : null,
            speed: 1,
            positionable: ['float', 'pulse', 'peek', 'patrol'].includes(motion.kind),
            has_y: true,
            cutout_url: preview,
            still: motion.still,
            breathe: motion.breathe,
            isNew: true,
          };
          setMovers((prev) => [...prev, m]);
          setSel(movers.length);
          setDirty(true);
          setAdding(false);
        }}
      />
    </div>
  );
}

function AddCreatureDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (id: string, motion: (typeof MOTIONS)[number], preview: string | null) => void;
}) {
  const [motion, setMotion] = useState<(typeof MOTIONS)[number]>(MOTIONS[0]);
  const { data: palette, isLoading } = useQuery({
    queryKey: qk.moverPalette(),
    queryFn: () => data.listMoverPalette(),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a creature</DialogTitle>
          <DialogDescription>
            Pick how it should move, then choose one. It drops into the middle of the frame — drag
            it from there.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Label>Motion</Label>
          <Select
            value={motion.key}
            onValueChange={(v) => setMotion(MOTIONS.find((m) => m.key === v) ?? MOTIONS[0])}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOTIONS.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid max-h-[45vh] grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2 overflow-y-auto rounded-md border border-border p-2">
          {isLoading &&
            Array.from({ length: 18 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}
          {palette?.map((p) => (
            <Tooltip key={p.id} label={p.id}>
              <button
                type="button"
                onClick={() => onAdd(p.id, motion, p.preview_url)}
                className="checkerboard grid aspect-square place-items-center overflow-hidden rounded border border-border transition-colors hover:border-primary focus-ring"
              >
                {p.preview_url && (
                  <img src={p.preview_url} alt={p.id} className="size-full object-contain" />
                )}
              </button>
            </Tooltip>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
