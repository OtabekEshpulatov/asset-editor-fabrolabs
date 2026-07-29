import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlipHorizontal, Film, Grid3x3, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/cn';
import { data, type ActionDetail } from '@/lib/data';
import { prettyAction } from '@/lib/kinds';
import { withRev } from '@/lib/sprite-sheet';
import { assetTouchingKeys, qk } from '@/app/queryKeys';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Tooltip,
} from '@/components/ui/controls';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/layout/PageHeader';
import { SheetThumb, SpriteThumb } from '@/components/media/SpriteThumb';
import { FrameEditor } from './FrameEditor';

const FPS_OPTIONS = [6, 8, 10, 12, 16, 20, 24, 30];

/**
 * Per-action management for one sprite.
 *
 * This is a ROUTE, not the third modal in a stack. It is where you spend real
 * time — renaming actions, tuning fps, mirroring, trimming frames — so it gets a
 * URL you can link, reload and go back from.
 */
export default function SpriteActionsPage() {
  const { slug = '' } = useParams();
  const qc = useQueryClient();
  const [editingFrames, setEditingFrames] = useState<ActionDetail | null>(null);

  const {
    data: asset,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: qk.asset('character', slug),
    queryFn: () => data.getAsset('character', slug),
  });

  const invalidate = () => {
    for (const key of assetTouchingKeys) qc.invalidateQueries({ queryKey: [key] });
  };

  const toggleAsset = useMutation({
    mutationFn: (enabled: boolean) => data.setAssetConfig('character', slug, { enabled }),
    onSuccess: invalidate,
  });

  if (error) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        backTo="/library?kind=character"
        title={
          <>
            Actions — <span className="font-mono font-normal">{slug}</span>
          </>
        }
        subtitle={
          isLoading
            ? 'Loading…'
            : `${asset?.actionDetails.length ?? 0} actions · ${asset?.category ?? ''}`
        }
      >
        {asset && (
          <label className="flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Character enabled</span>
            <Switch
              checked={asset.enabled}
              onCheckedChange={(v) => toggleAsset.mutate(v)}
              aria-label="Character enabled"
            />
          </label>
        )}
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-2 p-4">
          {isLoading &&
            Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[86px] w-full" />
            ))}

          {asset && asset.actionDetails.length === 0 && (
            <EmptyState
              icon={Film}
              title="This character has no actions"
              description="Actions are uploaded as a spritesheet plus an atlas."
            />
          )}

          {asset?.actionDetails.map((action) => (
            <ActionRow
              key={action.name}
              slug={slug}
              action={action}
              strip={asset.strip}
              thumb={asset.thumb}
              canDelete={asset.actionDetails.length > 1}
              onChanged={invalidate}
              onEditFrames={() => setEditingFrames(action)}
            />
          ))}
        </div>
      </div>

      {editingFrames && (
        <FrameEditor
          slug={slug}
          action={editingFrames.name}
          sheetUrl={editingFrames.spritesheet}
          open={!!editingFrames}
          onOpenChange={(v) => !v && setEditingFrames(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

function ActionRow({
  slug,
  action,
  strip,
  thumb,
  canDelete,
  onChanged,
  onEditFrames,
}: {
  slug: string;
  action: ActionDetail;
  strip: string | null | undefined;
  thumb: string | null | undefined;
  canDelete: boolean;
  onChanged: () => void;
  onEditFrames: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(action.name);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast.success(success);
      onChanged();
    } catch (err) {
      toast.error('That did not work', { description: String((err as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-2',
        !action.enabled && 'opacity-60',
      )}
    >
      {/* Prefer the action's own sheet: a row for "fly left" should show flying,
          not whatever the character's default image happens to be. Falls back to
          the derived thumbnail when the backend provides one. */}
      {action.spritesheet ? (
        <SheetThumb url={withRev(action.spritesheet, action.rev)} alt={action.name} size={64} fps={action.fps} />
      ) : (
        <SpriteThumb thumb={thumb} strip={strip} alt={action.name} size={64} />
      )}

      <div className="min-w-[140px] flex-1">
        {renaming ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="h-7 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setRenaming(false);
                  setDraft(action.name);
                }
                if (e.key === 'Enter' && draft.trim() && draft !== action.name) {
                  run(() => data.renameAction(slug, action.name, draft.trim()), 'Renamed').then(
                    () => setRenaming(false),
                  );
                }
              }}
            />
            <Button
              size="sm"
              disabled={!draft.trim() || draft === action.name}
              loading={busy}
              onClick={() =>
                run(() => data.renameAction(slug, action.name, draft.trim()), 'Renamed').then(() =>
                  setRenaming(false),
                )
              }
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="group flex items-center gap-1.5 focus-ring"
            title="Rename action"
          >
            <span className="font-mono text-[13px]">{prettyAction(action.name)}</span>
            <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="outline">{action.frameCount} frames</Badge>
          {action.is3q && <Badge variant="outline">¾ view</Badge>}
          {action.rev > 0 && <Badge variant="outline">rev {action.rev}</Badge>}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Label className="whitespace-nowrap">FPS</Label>
        <Select
          value={String(action.fps)}
          onValueChange={(v) =>
            run(() => data.setActionConfig(slug, action.name, { fps: Number(v) }))
          }
        >
          <SelectTrigger className="h-7 w-[72px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FPS_OPTIONS.map((f) => (
              <SelectItem key={f} value={String(f)}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator orientation="vertical" className="h-8" />

      <div className="flex items-center gap-1">
        <Tooltip label="Edit the frame sequence">
          <Button variant="outline" size="icon" onClick={onEditFrames} aria-label="Edit frames">
            <Grid3x3 />
          </Button>
        </Tooltip>

        <Tooltip label="Create a mirrored copy (toggles _left / _right)">
          <Button
            variant="outline"
            size="icon"
            disabled={busy}
            onClick={() => run(() => data.mirrorAction(slug, action.name), 'Mirrored copy created')}
            aria-label="Mirror action"
          >
            <FlipHorizontal />
          </Button>
        </Tooltip>

        <Tooltip
          label={canDelete ? 'Delete this action' : 'A character must keep at least one action'}
        >
          <Button
            variant="ghost"
            size="icon"
            disabled={!canDelete || busy}
            onClick={() => {
              if (!confirm(`Delete "${action.name}"? Its files move to trash in storage.`)) return;
              run(() => data.deleteAction(slug, action.name), `Deleted ${action.name}`);
            }}
            aria-label="Delete action"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </Tooltip>

        <Tooltip label={action.enabled ? 'Enabled' : 'Disabled'}>
          <span className="pl-1">
            <Switch
              checked={action.enabled}
              disabled={busy}
              onCheckedChange={(v) =>
                run(() => data.setActionConfig(slug, action.name, { enabled: v }))
              }
              aria-label={`${action.name} enabled`}
            />
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
