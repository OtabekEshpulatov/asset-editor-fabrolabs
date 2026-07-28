import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, GripVertical, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { data } from '@/lib/data';
import { frameOrigin, gridOfImage, loadSheet, type SheetGrid } from '@/lib/sprite-sheet';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlay';
import { Skeleton } from '@/components/ui/feedback';

/**
 * Frame sequence editor.
 *
 * The working sequence is a list of SOURCE frame indices, which is exactly what
 * the backend's reorder endpoint takes: omit an index to delete it, repeat it to
 * duplicate, reorder freely. Because it is the same representation end to end,
 * one destructive save covers delete + duplicate + reorder.
 *
 * The grid math comes from @/lib/sprite-sheet, which is shared with the sprite
 * canvas AND documented as a contract with backend/app/image_transforms.py — if
 * the client and server disagree about the grid, a save silently corrupts the
 * sheet.
 */

interface Slot {
  /** stable id so duplicates of the same source frame keep their own identity */
  uid: number;
  src: number;
}

export function FrameEditor({
  slug,
  action,
  sheetUrl,
  open,
  onOpenChange,
  onSaved,
}: {
  slug: string;
  action: string;
  sheetUrl: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [sheet, setSheet] = useState<HTMLImageElement | null>(null);
  const [grid, setGrid] = useState<SheetGrid | null>(null);
  const [seq, setSeq] = useState<Slot[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const uidRef = useRef(1);

  useEffect(() => {
    if (!open || !sheetUrl) return;
    let cancelled = false;
    setSheet(null);
    loadSheet(sheetUrl)
      .then((img) => {
        if (cancelled) return;
        const g = gridOfImage(img);
        setSheet(img);
        setGrid(g);
        uidRef.current = 1;
        setSeq(Array.from({ length: g.total }, (_, i) => ({ uid: uidRef.current++, src: i })));
      })
      .catch(() => !cancelled && toast.error('Could not load the sprite sheet'));
    return () => {
      cancelled = true;
    };
  }, [open, sheetUrl]);

  const original = useMemo(
    () => (grid ? Array.from({ length: grid.total }, (_, i) => i) : []),
    [grid],
  );
  const dirty = useMemo(
    () => seq.length !== original.length || seq.some((s, i) => s.src !== original[i]),
    [seq, original],
  );

  const move = useCallback((from: number, to: number) => {
    setSeq((prev) => {
      if (from === to || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const duplicate = (i: number) =>
    setSeq((prev) => {
      const next = [...prev];
      next.splice(i + 1, 0, { uid: uidRef.current++, src: prev[i].src });
      return next;
    });

  const remove = (i: number) =>
    setSeq((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const reset = () =>
    setSeq(original.map((src) => ({ uid: uidRef.current++, src })));

  const save = async () => {
    setSaving(true);
    try {
      const result = await data.reorderFrames(slug, action, seq.map((s) => s.src));
      toast.success(`Saved ${action}`, {
        description: `${result.frameCount} frames · revision ${result.rev}`,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not save frames', { description: String((err as Error).message) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            Frames — <span className="font-mono font-normal">{slug} / {action}</span>
          </DialogTitle>
          <DialogDescription>
            Drag to reorder, duplicate to hold a pose, delete to trim. Saving rebuilds the sheet
            and overwrites it in storage.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[280px] overflow-y-auto rounded-md border border-border bg-background/50 p-3">
          {!sheet || !grid ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="size-[84px]" />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {seq.map((slot, i) => (
                <FrameCard
                  key={slot.uid}
                  sheet={sheet}
                  grid={grid}
                  slot={slot}
                  position={i}
                  isDragging={dragIndex === i}
                  canDelete={seq.length > 1}
                  onDragStart={() => setDragIndex(i)}
                  onDragEnter={() => {
                    if (dragIndex !== null && dragIndex !== i) {
                      move(dragIndex, i);
                      setDragIndex(i);
                    }
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  onDuplicate={() => duplicate(i)}
                  onDelete={() => remove(i)}
                />
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <p className="mr-auto text-2xs text-muted-foreground">
            {seq.length} frame{seq.length === 1 ? '' : 's'}
            {grid && seq.length !== grid.total && ` (was ${grid.total})`}
            {dirty && <span className="ml-2 text-warning">Unsaved changes</span>}
          </p>
          <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty || saving}>
            <RotateCcw />
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
            Save frames
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FrameCard({
  sheet,
  grid,
  slot,
  position,
  isDragging,
  canDelete,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDuplicate,
  onDelete,
}: {
  sheet: HTMLImageElement;
  grid: SheetGrid;
  slot: Slot;
  position: number;
  isDragging: boolean;
  canDelete: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const SIZE = 84;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { sx, sy } = frameOrigin(slot.src, grid);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(sheet, sx, sy, grid.frameSize, grid.frameSize, 0, 0, SIZE, SIZE);
  }, [sheet, grid, slot.src]);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      className={cn(
        'group relative cursor-grab rounded-md border border-border bg-card p-1 active:cursor-grabbing',
        isDragging && 'opacity-40 ring-2 ring-primary',
      )}
    >
      <div className="checkerboard overflow-hidden rounded-sm">
        <canvas ref={canvasRef} width={SIZE} height={SIZE} className="block" />
      </div>

      <div className="mt-1 flex items-center gap-1 px-0.5">
        <GripVertical className="size-3 text-muted-foreground" />
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {position + 1}
          <span className="opacity-60"> · src {slot.src}</span>
        </span>
      </div>

      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onDuplicate}
          title="Duplicate this frame"
          className="rounded bg-background/90 p-1 text-muted-foreground backdrop-blur hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={canDelete ? 'Delete this frame' : 'An action needs at least one frame'}
          className="rounded bg-background/90 p-1 text-muted-foreground backdrop-blur hover:text-destructive disabled:opacity-40"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}
