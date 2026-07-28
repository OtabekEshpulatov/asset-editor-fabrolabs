import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  ExternalLink,
  FlipHorizontal,
  FlipVertical,
  Layers,
  Map,
  Pencil,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AssetItem, AssetKind, ImageTransform } from '@/lib/data';
import { KINDS, prettyAction, prettyCategory } from '@/lib/kinds';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Separator, Switch, Tooltip } from '@/components/ui/controls';
import { Badge } from '@/components/ui/feedback';
import { Sheet, SheetContent } from '@/components/ui/overlay';
import { AssetPreview, OpenOriginal } from '@/components/media/AssetPreview';

/**
 * Asset inspector.
 *
 * Replaces the old Lightbox, which was a modal that opened another modal that
 * opened a third. Inspection and light edits live here in a side drawer you can
 * leave open while browsing; anything that deserves sustained attention (action
 * management, zone editing, the world map) is a link to a real route.
 */
export function DetailDrawer({
  item,
  kind,
  open,
  onClose,
  onToggleEnabled,
  onRename,
  onTransform,
  renaming,
  transforming,
  onChanged,
}: {
  item: AssetItem | null;
  kind: AssetKind;
  open: boolean;
  onClose: () => void;
  onToggleEnabled: (item: AssetItem) => void | Promise<void>;
  onRename: (slug: string, newSlug: string) => Promise<unknown>;
  onTransform: (slug: string, t: ImageTransform) => Promise<unknown>;
  renaming: boolean;
  transforming: boolean;
  onChanged: () => void;
}) {
  const meta = KINDS[kind];
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!item) return;
    setDraftName(item.slug);
    setDescription(item.description ?? '');
    setEditingName(false);
  }, [item?.slug, item?.description, item]);

  if (!item) return null;

  const isLiveScene = meta.isLiveScene;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[400px]">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="shrink-0 border-b border-border p-4 pr-10">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">{meta.label}</Badge>
              {!item.enabled && <Badge variant="danger">Disabled</Badge>}
              {item.rev > 0 && <Badge variant="outline">rev {item.rev}</Badge>}
            </div>

            {editingName ? (
              <div className="mt-2 flex items-center gap-1.5">
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="font-mono text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingName(false);
                    if (e.key === 'Enter' && draftName.trim() && draftName !== item.slug) {
                      onRename(item.slug, draftName.trim()).then(() => setEditingName(false));
                    }
                  }}
                />
                <Button
                  size="icon-sm"
                  loading={renaming}
                  disabled={!draftName.trim() || draftName === item.slug}
                  onClick={() =>
                    onRename(item.slug, draftName.trim()).then(() => setEditingName(false))
                  }
                  aria-label="Save name"
                >
                  <Check />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="group mt-2 flex items-start gap-1.5 text-left focus-ring"
                title="Rename"
              >
                <span className="break-all font-mono text-sm text-foreground">{item.slug}</span>
                <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {prettyCategory(item.category)}
            </p>
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* The real asset — plays, zooms, opens. Not a thumbnail. */}
            <div className="grid place-items-center border-b border-border bg-background/40 p-4">
              <AssetPreview item={item} />
            </div>

            <div className="space-y-4 p-4">
              {/* State */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium">Enabled</p>
                  <p className="text-2xs text-muted-foreground">
                    Disabled assets are hidden everywhere downstream.
                  </p>
                </div>
                <Switch
                  checked={item.enabled}
                  onCheckedChange={() => onToggleEnabled(item)}
                  aria-label="Enabled"
                />
              </div>

              <Separator />

              {/* Details — what the asset actually IS. Without this the
                  inspector was just a picture and two form controls. */}
              <div className="space-y-1.5">
                <Label>Details</Label>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
                  <Detail label="Kind" value={meta.label} />
                  <Detail label="Category" value={prettyCategory(item.category)} />
                  {item.resolution && (
                    <Detail
                      label="Resolution"
                      value={`${item.resolution.width}×${item.resolution.height}`}
                    />
                  )}
                  {item.zone_count ? (
                    <Detail label="Zones" value={`${item.zone_count} authored`} />
                  ) : null}
                  {item.actions?.length ? (
                    <Detail label="Actions" value={String(item.actions.length)} />
                  ) : null}
                  {item.duration_s ? (
                    <Detail
                      label="Duration"
                      value={`${Math.floor(item.duration_s / 60)}:${String(item.duration_s % 60).padStart(2, '0')}`}
                    />
                  ) : null}
                  <Detail label="Revision" value={String(item.rev)} />
                  {item.storage_key && <Detail label="Storage" value={item.storage_key} mono />}
                </dl>
              </div>

              <Separator />

              {/* Description */}
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this asset is, for the story engine…"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={description === (item.description ?? '')}
                    onClick={onChanged}
                  >
                    Save description
                  </Button>
                </div>
              </div>

              {/* Actions list preview */}
              {meta.hasActions && item.actions && item.actions.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-1.5">
                    <Label>Actions ({item.actions.length})</Label>
                    <div className="flex flex-wrap gap-1">
                      {item.actions.slice(0, 12).map((a) => (
                        <Badge key={a} variant="outline" className="font-mono">
                          {prettyAction(a)}
                        </Badge>
                      ))}
                      {item.actions.length > 12 && (
                        <Badge variant="outline">+{item.actions.length - 12} more</Badge>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* Destructive image transforms */}
              {meta.shape !== 'audio' && meta.shape !== 'video' && (
                <>
                  <Separator />
                  <div className="space-y-1.5">
                    <Label>Transform</Label>
                    <p className="text-2xs text-muted-foreground">
                      Applied in place — this overwrites the stored file and bumps its revision.
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <TransformButton
                        label="Flip horizontally"
                        icon={FlipHorizontal}
                        busy={transforming}
                        onClick={() => onTransform(item.slug, { flip_h: true })}
                      />
                      <TransformButton
                        label="Flip vertically"
                        icon={FlipVertical}
                        busy={transforming}
                        onClick={() => onTransform(item.slug, { flip_v: true })}
                      />
                      <TransformButton
                        label="Rotate 90° counter-clockwise"
                        icon={RotateCcw}
                        busy={transforming}
                        onClick={() => onTransform(item.slug, { rotate: -90 })}
                      />
                      <TransformButton
                        label="Rotate 90° clockwise"
                        icon={RotateCw}
                        busy={transforming}
                        onClick={() => onTransform(item.slug, { rotate: 90 })}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Footer: real routes, not more modals */}
          <div className="shrink-0 space-y-1.5 border-t border-border p-3">
            <OpenOriginal item={item} />
            {meta.hasActions && (
              <Button asChild variant="secondary" className="w-full justify-start">
                <Link to={`/sprites/${encodeURIComponent(item.slug)}/actions`}>
                  <SlidersHorizontal />
                  Manage actions
                  <ExternalLink className="ml-auto size-3 opacity-60" />
                </Link>
              </Button>
            )}
            {meta.hasZones && (
              <Button asChild variant="secondary" className="w-full justify-start">
                <Link to={`/scenes/${encodeURIComponent(item.slug)}`}>
                  <Layers />
                  {isLiveScene ? 'Edit zones, objects & transitions' : 'Edit zones'}
                  <ExternalLink className="ml-auto size-3 opacity-60" />
                </Link>
              </Button>
            )}
            {kind === 'video_v3' && (
              <Button asChild variant="secondary" className="w-full justify-start">
                <Link to={`/worlds/${encodeURIComponent(item.category)}`}>
                  <Map />
                  Open world map
                  <ExternalLink className="ml-auto size-3 opacity-60" />
                </Link>
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('break-all text-foreground/90', mono && 'font-mono')}>{value}</dd>
    </>
  );
}

function TransformButton({
  label,
  icon: Icon,
  busy,
  onClick,
}: {
  label: string;
  icon: typeof FlipHorizontal;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="outline"
        size="icon"
        disabled={busy}
        onClick={onClick}
        aria-label={label}
        className={cn(busy && 'opacity-50')}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}
