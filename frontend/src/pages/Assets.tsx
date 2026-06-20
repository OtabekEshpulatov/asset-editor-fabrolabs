import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiV4, type AssetCatalogItem, type AssetKind } from '../api';
import AddAssetModal from '../components/AddAssetModal';
import SpriteActionsModal from '../components/SpriteActionsModal';
import ConfigViewer from '../components/ConfigViewer';
import SpriteCanvas, { FPS } from '../components/SpriteCanvas';
import { TransformBar, cssTransform, IDENTITY, type Transform } from '../components/TransformControls';

/** Append the asset's edit revision so an overwritten file isn't served stale. */
function withRev(url: string | undefined, rev?: number): string | undefined {
  if (!url || !rev) return url;
  return url + (url.includes('?') ? '&' : '?') + 'rev=' + rev;
}

const KIND_TABS: { key: AssetKind; label: string }[] = [
  { key: 'character', label: 'Sprites' },
  { key: 'background', label: 'Backgrounds' },
  { key: 'object', label: 'Objects' },
  { key: 'video', label: 'Live BGs' },
];

const ANIM_PREFERENCE = ['idle', 'happy', 'move'];

function animLabel(name: string): string {
  return name === 'idle_3q' ? 'idle ¾' : name;
}

function SpriteCard({
  item,
  onOpen,
  selected,
  onToggleSelect,
  forcedAnim,
}: {
  item: AssetCatalogItem;
  onOpen: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  forcedAnim?: string;
}) {
  const anims = item.animation_urls ?? {};
  const names = Object.keys(anims).sort();
  const [anim, setAnim] = useState(
    () => ANIM_PREFERENCE.find((p) => names.includes(p)) ?? names[0],
  );
  // A section-level "show this action on the whole row" override switches the card.
  useEffect(() => {
    if (forcedAnim && names.includes(forcedAnim)) setAnim(forcedAnim);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedAnim]);
  return (
    <div
      className={`relative flex w-[136px] flex-col items-center gap-1 rounded-lg border bg-white p-2 ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-300'
          : item.enabled === false
            ? 'border-red-200 opacity-50'
            : 'border-gray-200'
      }`}
    >
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggleSelect}
          title="select"
          className="absolute left-1.5 top-1.5 z-10 h-4 w-4 accent-blue-600"
        />
      )}
      <button
        type="button"
        onClick={onOpen}
        className="cursor-zoom-in rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
        title="Click to view full size"
      >
        <SpriteCanvas
          url={withRev(anims[anim], item.action_rev?.[anim])}
          fps={item.action_fps?.[anim] ?? FPS}
        />
      </button>
      {item.enabled === false && <span className="text-[10px] text-red-500">disabled</span>}
      <div className="break-all text-center text-[11px] leading-tight text-gray-700">
        {item.slug}
      </div>
      {names.length > 1 && (
        <select
          value={anim}
          onChange={(e) => setAnim(e.target.value)}
          className="w-full rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-600"
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {animLabel(n)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ImageCard({ item, onOpen }: { item: AssetCatalogItem; onOpen: () => void }) {
  return (
    <div
      className={`flex w-[136px] flex-col items-center gap-1 rounded-lg border bg-white p-2 ${
        item.enabled === false ? 'border-red-200 opacity-50' : 'border-gray-200'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="grid cursor-zoom-in place-items-center overflow-hidden rounded bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
        style={{ width: 120, height: 120 }}
        title="Click to view full size"
      >
        {item.url && (
          <img
            loading="lazy"
            src={withRev(item.url, item.rev)}
            alt={item.slug}
            className="max-h-[120px] max-w-[120px]"
          />
        )}
      </button>
      {item.enabled === false && <span className="text-[10px] text-red-500">disabled</span>}
      <div className="break-all text-center text-[11px] leading-tight text-gray-700">
        {item.slug}
      </div>
    </div>
  );
}

// In-view autoplaying, muted, looping <video> — only plays while scrolled into
// view so a grid of 3-min clips stays light.
function VideoThumb({ url, size = 120 }: { url?: string; size?: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) el.play().catch(() => {});
        else el.pause();
      },
      { rootMargin: '100px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <video
      ref={ref}
      src={url}
      muted
      loop
      playsInline
      preload="metadata"
      className="bg-gray-100 object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function VideoCard({ item, onOpen }: { item: AssetCatalogItem; onOpen: () => void }) {
  return (
    <div
      className={`flex w-[136px] flex-col items-center gap-1 rounded-lg border bg-white p-2 ${
        item.enabled === false ? 'border-red-200 opacity-50' : 'border-gray-200'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative grid cursor-zoom-in place-items-center overflow-hidden rounded focus:outline-none focus:ring-2 focus:ring-blue-400"
        title="Click to view + edit zones"
      >
        {item.url && <VideoThumb url={item.url} />}
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] text-white">
          ▶ mp4
        </span>
      </button>
      {item.enabled === false && <span className="text-[10px] text-red-500">disabled</span>}
      <div className="break-all text-center text-[11px] leading-tight text-gray-700">{item.slug}</div>
    </div>
  );
}

function Lightbox({
  kind,
  item,
  onClose,
  onRenamed,
  onManageActions,
  onChanged,
}: {
  kind: AssetKind;
  item: AssetCatalogItem;
  onClose: () => void;
  onRenamed: () => void;
  onManageActions: () => void;
  onChanged: () => void;
}) {
  const isSprite = kind === 'character';
  const isVideo = kind === 'video';
  const anims = item.animation_urls ?? {};
  const names = Object.keys(anims).sort();
  const [anim, setAnim] = useState(
    () => ANIM_PREFERENCE.find((p) => names.includes(p)) ?? names[0],
  );
  const [showSheet, setShowSheet] = useState(false);
  const rawUrl = isSprite ? anims[anim] : item.url ?? undefined;

  const [renaming, setRenaming] = useState(false);
  const [newSlug, setNewSlug] = useState(item.slug);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const doRename = async () => {
    setRenameBusy(true);
    setRenameError(null);
    try {
      await apiV4.renameAsset(kind, item.slug, newSlug.trim());
      onRenamed();
    } catch (e: any) {
      setRenameError(String(e?.response?.data?.detail ?? e));
    } finally {
      setRenameBusy(false);
    }
  };

  const [enabled, setEnabled] = useState(item.enabled !== false);
  const [desc, setDesc] = useState(item.description ?? '');
  const [cfgError, setCfgError] = useState<string | null>(null);

  // --- flip / rotate (baked into the file) ---
  const [pending, setPending] = useState<Transform>(IDENTITY);
  const [tBusy, setTBusy] = useState(false);
  const [tError, setTError] = useState<string | null>(null);
  const [localRev, setLocalRev] = useState(0); // bumped after each saved transform
  const baseRev = isSprite ? item.action_rev?.[anim] ?? 0 : item.rev ?? 0;
  const effRev = baseRev + localRev;

  useEffect(() => setPending(IDENTITY), [anim, showSheet]);

  const applyTransform = async (t: Transform) => {
    setTBusy(true);
    setTError(null);
    try {
      if (isSprite) await apiV4.transformAction(item.slug, anim, t);
      else await apiV4.transformAsset(kind, item.slug, t);
      setPending(IDENTITY);
      setLocalRev((r) => r + 1);
      onChanged();
    } catch (e: any) {
      setTError(String(e?.response?.data?.detail ?? e));
    } finally {
      setTBusy(false);
    }
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    setCfgError(null);
    try {
      if (isVideo) await apiV4.saveVideo(item.slug, { enabled: next });
      else await apiV4.setAssetConfig(kind, item.slug, { enabled: next });
      onChanged();
    } catch (e: any) {
      setEnabled(!next);
      setCfgError(String(e?.response?.data?.detail ?? e));
    }
  };

  const saveDesc = async () => {
    setCfgError(null);
    try {
      if (isVideo) await apiV4.saveVideo(item.slug, { description: desc });
      else await apiV4.setAssetConfig(kind, item.slug, { description: desc });
      onChanged();
    } catch (e: any) {
      setCfgError(String(e?.response?.data?.detail ?? e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] min-h-0 max-w-[92vw] flex-col gap-3 overflow-auto rounded-lg bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                autoFocus
              />
              <button
                onClick={doRename}
                disabled={renameBusy || !newSlug.trim() || newSlug.trim() === item.slug}
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
              >
                {renameBusy ? '…' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setRenaming(false);
                  setNewSlug(item.slug);
                  setRenameError(null);
                }}
                className="text-xs text-gray-500 hover:underline"
              >
                cancel
              </button>
              {renameError && <span className="text-xs text-red-600">{renameError}</span>}
            </div>
          ) : (
            <button
              onClick={() => setRenaming(true)}
              className="group flex items-center gap-1 font-mono text-sm text-gray-800"
              title="Rename"
            >
              {item.slug}
              <span className="text-gray-400 group-hover:text-blue-600">✎</span>
            </button>
          )}
          <div className="flex items-center gap-3 text-sm">
            {isSprite && (
              <button onClick={onManageActions} className="text-blue-600 hover:underline">
                Manage actions →
              </button>
            )}
            {(kind === 'background' || isVideo) && (
              <Link
                to={`/${isVideo ? 'videos' : 'backgrounds'}/${encodeURIComponent(item.slug)}`}
                className="text-blue-600 hover:underline"
              >
                {isVideo ? 'Edit zones & objects →' : 'Edit zones →'}
              </Link>
            )}
            {rawUrl && (
              <a
                href={rawUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                Open original ↗
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 text-gray-500 hover:bg-gray-100"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        <div
          className="grid flex-1 place-items-center overflow-auto rounded bg-gray-100 p-2"
          style={{ minWidth: 320, minHeight: 320 }}
        >
          <div style={{ transform: cssTransform(pending), transition: 'transform .15s ease' }}>
            {isVideo ? (
              rawUrl && (
                <video
                  src={rawUrl}
                  controls
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="max-h-[78vh] max-w-[86vw] object-contain"
                />
              )
            ) : isSprite && !showSheet ? (
              <SpriteCanvas
                key={`${anim}-${effRev}`}
                url={withRev(anims[anim], effRev)}
                size={420}
                fps={item.action_fps?.[anim] ?? FPS}
              />
            ) : (
              rawUrl && (
                <img
                  src={withRev(rawUrl, effRev)}
                  alt={item.slug}
                  className="max-h-[78vh] max-w-[86vw] object-contain"
                />
              )
            )}
          </div>
        </div>

        {isSprite && (
          <div className="flex flex-wrap items-center gap-3">
            {names.length > 1 && (
              <select
                value={anim}
                onChange={(e) => setAnim(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
              >
                {names.map((n) => (
                  <option key={n} value={n}>
                    {animLabel(n)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setShowSheet((s) => !s)}
              className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-600 hover:bg-gray-50"
            >
              {showSheet ? 'Show animated' : 'Show sprite sheet'}
            </button>
          </div>
        )}

        {!isVideo && (
          <TransformBar
            value={pending}
            onChange={setPending}
            onApply={applyTransform}
            busy={tBusy}
            error={tError}
          />
        )}
        {isSprite && pending.rotate % 360 !== 0 && (
          <p className="-mt-1 text-[11px] text-gray-400">
            Rotation is baked into each frame, so the animation grid stays intact.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
          <label
            className="flex items-center gap-1 text-gray-700"
            title="Disabled assets are hidden everywhere"
          >
            <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
            enabled
          </label>
          {(kind === 'object' || isVideo) && (
            <>
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="description…"
                className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                onClick={saveDesc}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
              >
                Save
              </button>
            </>
          )}
          {kind === 'background' && (
            <span className="text-xs text-gray-400">edit description in the zone editor</span>
          )}
          {cfgError && <span className="text-xs text-red-600">{cfgError}</span>}
          <ConfigViewer kind={kind} slug={item.slug} />
        </div>
      </div>
    </div>
  );
}

// A category "row" of sprites with a select-all + an action dropdown that
// switches the displayed animation for the whole row (or just the selected
// cards) at once — e.g. flip every dinosaur from idle to move_left.
function SpriteSection({
  category,
  items,
  onOpen,
}: {
  category: string;
  items: AssetCatalogItem[];
  onOpen: (item: AssetCatalogItem) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [forced, setForced] = useState<Record<string, string>>({});

  const actionOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((it) => Object.keys(it.animation_urls ?? {}).forEach((n) => s.add(n)));
    return Array.from(s).sort();
  }, [items]);

  const [chosen, setChosen] = useState(
    () =>
      ['move_left', 'move_right', 'walk_left', 'idle_left'].find((a) =>
        actionOptions.includes(a),
      ) ?? actionOptions[0] ?? '',
  );

  const allSlugs = items.map((i) => i.slug);
  const allSelected = allSlugs.length > 0 && allSlugs.every((s) => selected.has(s));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allSlugs));
  const toggle = (slug: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(slug)) n.delete(slug);
      else n.add(slug);
      return n;
    });

  const apply = () => {
    if (!chosen) return;
    const targets = selected.size ? items.filter((i) => selected.has(i.slug)) : items;
    setForced((f) => {
      const next = { ...f };
      targets.forEach((it) => {
        if ((it.animation_urls ?? {})[chosen]) next[it.slug] = chosen;
      });
      return next;
    });
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {category} <span className="font-normal text-gray-400">({items.length})</span>
        </h3>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          select all
        </label>
        {selected.size > 0 && (
          <span className="text-xs text-gray-500">{selected.size} selected</span>
        )}
        {actionOptions.length > 1 && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-gray-500">show</span>
            <select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="rounded border border-gray-300 px-1 py-0.5 text-xs text-gray-700"
            >
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {animLabel(a)}
                </option>
              ))}
            </select>
            <button
              onClick={apply}
              className="rounded border border-blue-600 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800 hover:bg-blue-100"
              title="Switch the displayed animation for these sprites"
            >
              {selected.size ? `on ${selected.size}` : 'on all'}
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <SpriteCard
            key={item.slug}
            item={item}
            onOpen={() => onOpen(item)}
            selected={selected.has(item.slug)}
            onToggleSelect={() => toggle(item.slug)}
            forcedAnim={forced[item.slug]}
          />
        ))}
      </div>
    </section>
  );
}

export default function AssetsPage() {
  const [kind, setKind] = useState<AssetKind>('character');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<AssetCatalogItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [managingActions, setManagingActions] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['asset-catalog', kind, showDisabled],
    queryFn: () => apiV4.getAssetCatalog(kind, showDisabled),
    staleTime: 5 * 60 * 1000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['asset-catalog'] });

  // Category list is per-kind, so reset the filter whenever the kind changes.
  useEffect(() => {
    setCategory('all');
  }, [kind]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.categories
      .filter((c) => category === 'all' || c.name === category)
      .map((c) => ({
        ...c,
        items: q ? c.items.filter((i) => i.slug.toLowerCase().includes(q)) : c.items,
      }))
      .filter((c) => c.items.length > 0);
  }, [data, query, category]);

  const shown = filtered.reduce((n, c) => n + c.items.length, 0);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Asset library</h2>
        <p className="text-sm text-gray-500">
          Every sprite, background, and object from MinIO. Sprites animate live.
        </p>
      </header>

      <div className="sticky top-0 z-10 -mx-6 space-y-3 border-b bg-gray-50/90 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {KIND_TABS.map((t) => {
            const active = t.key === kind;
            return (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className={[
                  'rounded-full border px-3 py-1 text-sm',
                  active
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
                ].join(' ')}
              >
                {t.label}
                {data && active ? ` (${data.total})` : ''}
              </button>
            );
          })}
          {kind !== 'video' && (
            <button
              onClick={() => setAdding(true)}
              disabled={!data}
              className="ml-auto rounded-full border border-green-600 bg-green-50 px-3 py-1 text-sm font-medium text-green-800 disabled:opacity-40 hover:bg-green-100"
            >
              + Add {KIND_TABS.find((t) => t.key === kind)?.label.replace(/s$/, '')}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by slug name…"
            className="w-full max-w-sm rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          {data && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-700"
            >
              <option value="all">All categories ({data.categories.length})</option>
              {data.categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
            />
            show disabled
          </label>
          <span className="text-xs text-gray-500">
            {isLoading ? 'Loading…' : `${shown} shown`}
          </span>
        </div>
      </div>

      {error && (
        <div className="text-red-600">Failed to load assets: {String(error)}</div>
      )}

      {filtered.map((c) =>
        kind === 'character' ? (
          <SpriteSection key={c.name} category={c.name} items={c.items} onOpen={setSelected} />
        ) : (
          <section key={c.name} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {c.name} <span className="font-normal text-gray-400">({c.items.length})</span>
            </h3>
            <div className="flex flex-wrap gap-2">
              {c.items.map((item) =>
                kind === 'video' ? (
                  <VideoCard key={item.slug} item={item} onOpen={() => setSelected(item)} />
                ) : (
                  <ImageCard key={item.slug} item={item} onOpen={() => setSelected(item)} />
                ),
              )}
            </div>
          </section>
        ),
      )}

      {!isLoading && !error && shown === 0 && (
        <div className="py-10 text-center text-sm text-gray-500">
          No assets match that filter.
        </div>
      )}

      {selected && (
        <Lightbox
          kind={kind}
          item={selected}
          onClose={() => setSelected(null)}
          onRenamed={() => {
            setSelected(null);
            refresh();
          }}
          onManageActions={() => setManagingActions(selected.slug)}
          onChanged={refresh}
        />
      )}

      {adding && data && (
        <AddAssetModal
          kind={kind}
          categories={data.categories.map((c) => c.name)}
          onClose={() => setAdding(false)}
          onDone={refresh}
        />
      )}

      {managingActions && (
        <SpriteActionsModal
          slug={managingActions}
          onClose={() => setManagingActions(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
