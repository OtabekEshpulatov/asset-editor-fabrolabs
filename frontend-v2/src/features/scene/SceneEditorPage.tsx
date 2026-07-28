import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, FileQuestion, Map, Shapes } from 'lucide-react';
import { data, type BackgroundDoc } from '@/lib/data';
import { assetTouchingKeys, qk } from '@/app/queryKeys';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/controls';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/layout/PageHeader';
import { ZoneEditor } from './ZoneEditor';
import { ObjectLayerEditor } from './ObjectLayerEditor';
import { TransitionEditor } from './TransitionEditor';

type Tab = 'zones' | 'objects' | 'transitions';

/**
 * One editor for both still backgrounds and live scenes.
 *
 * Which tabs appear is driven by the document (`is_video`), not by which route
 * you came in on. The active tab lives in the URL so a link can point straight
 * at, say, the transitions of a specific scene.
 */
export default function SceneEditorPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();

  const tab = ((): Tab => {
    const t = params.get('tab');
    return t === 'objects' || t === 'transitions' ? t : 'zones';
  })();

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'zones') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const { data: doc, isLoading, error, refetch } = useQuery({
    queryKey: qk.backgroundDoc(slug),
    queryFn: () => data.getBackgroundDoc(slug),
  });

  const [local, setLocal] = useState<BackgroundDoc | null>(null);
  const current = local ?? doc ?? null;

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      data.setAssetConfig(current?.is_video ? 'video' : 'background', slug, { enabled }),
    onSuccess: () => {
      for (const key of assetTouchingKeys) qc.invalidateQueries({ queryKey: [key] });
    },
  });

  if (error) {
    return (
      <div className="p-6">
        <ErrorState error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const isLive = !!current?.is_video;
  const backKind = isLive ? 'video' : 'background';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        backTo={`/library?kind=${backKind}`}
        title={
          <>
            Scene — <span className="font-mono font-normal">{slug}</span>
          </>
        }
        subtitle={
          isLoading
            ? 'Loading…'
            : current
              ? `${current.resolution.width}×${current.resolution.height} · ${current.manifest_key ?? ''}`
              : 'Not found'
        }
      >
        {isLive && <Badge variant="primary">Live scene</Badge>}
        {current && (
          <label className="flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Enabled</span>
            <Switch
              checked={current.enabled}
              onCheckedChange={(v) => {
                setLocal({ ...current, enabled: v });
                toggleEnabled.mutate(v);
              }}
              aria-label="Scene enabled"
            />
          </label>
        )}
      </PageHeader>

      {isLive && (
        <div className="shrink-0 border-b border-border px-4 py-1.5">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="zones">
                <Shapes className="size-3.5" />
                Zones
              </TabsTrigger>
              <TabsTrigger value="objects">
                <Boxes className="size-3.5" />
                Objects
              </TabsTrigger>
              <TabsTrigger value="transitions">
                <Map className="size-3.5" />
                Transitions
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      {isLoading ? (
        <div className="p-4">
          <Skeleton className="aspect-video w-full max-w-3xl" />
        </div>
      ) : !current ? (
        <div className="p-6">
          <EmptyState
            icon={FileQuestion}
            title={`No scene named "${slug}"`}
            description="It may have been renamed or removed. Pick another from the library."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/library?kind=${backKind}`}>Back to the library</Link>
              </Button>
            }
          />
        </div>
      ) : tab === 'objects' && isLive ? (
        <ObjectLayerEditor slug={slug} posterUrl={current.url} />
      ) : tab === 'transitions' && isLive ? (
        <TransitionEditor slug={slug} posterUrl={current.url} />
      ) : (
        <ZoneEditor doc={current} onSaved={(next) => setLocal(next)} />
      )}
    </div>
  );
}
