import { useEffect, useRef, useState } from 'react';
import { apiV4, type BgTransition } from '../api';

/**
 * "O'tishlar" tab of the zone editor: mark WHERE on this background each
 * transition to a related bg happens (the camera / character heads there).
 *
 * - the right panel lists every related bg (from the world graph) with a
 *   thumbnail; click one to make it active;
 * - click anywhere on the frame (or drag the dot) to place its point;
 * - each change saves immediately to the world sidecar (center_pct +
 *   derived screen_zone) — no separate save button.
 */

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

function shortName(slug: string): string {
  return slug.replace(/_live$/, '').replace(/^[a-z]+_/, '').replace(/_/g, ' ');
}

export default function TransitionPointEditor({ slug, videoUrl }: { slug: string; videoUrl: string | null }) {
  const [worldId, setWorldId] = useState<string | null>(null);
  const [items, setItems] = useState<BgTransition[]>([]);
  const [notInGraph, setNotInGraph] = useState(false);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const [savedTick, setSavedTick] = useState<string | null>(null); // route_id just saved
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragIdx = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotInGraph(false);
    setItems([]);
    setActive(null);
    apiV4.getNodeTransitions(slug)
      .then((d) => {
        if (!alive) return;
        setWorldId(d.world_id);
        setItems(d.transitions);
        if (d.transitions.length) setActive(0);
      })
      .catch((e) => {
        if (!alive) return;
        if (e?.response?.status === 404) setNotInGraph(true);
        else setError(String(e?.response?.data?.detail ?? e));
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [slug]);

  const pctFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100),
    };
  };

  const persist = async (idx: number, x: number, y: number) => {
    const it = items[idx];
    if (!worldId || !it) return;
    setError(null);
    try {
      await apiV4.setTransitionPoint(worldId, {
        route_id: it.route_id, side: it.side, center_pct: [x, y],
      });
      setSavedTick(it.route_id);
      window.setTimeout(() => setSavedTick((t) => (t === it.route_id ? null : t)), 1500);
    } catch (e) {
      setError(String((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? e));
    }
  };

  const placeAt = (idx: number, x: number, y: number, save: boolean) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, center_pct: [x, y] } : it)));
    if (save) void persist(idx, x, y);
  };

  // window-level drag for the point dots
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const idx = dragIdx.current;
      if (idx == null || !containerRef.current) return;
      const { x, y } = pctFromEvent(ev);
      placeAt(idx, x, y, false);
    };
    const onUp = (ev: PointerEvent) => {
      const idx = dragIdx.current;
      if (idx == null || !containerRef.current) return;
      dragIdx.current = null;
      const { x, y } = pctFromEvent(ev);
      placeAt(idx, x, y, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, worldId]);

  if (loading) return <div className="py-8 text-sm text-gray-500">O'tishlar yuklanmoqda…</div>;
  if (notInGraph) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500">
        Bu fon hech qaysi relation grafiga kirmagan — o'tish nuqtalari faqat "Live BG v3 (relation)"
        bo'limidagi fonlarda belgilanadi.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      {/* canvas */}
      <div
        ref={containerRef}
        onPointerDown={(e) => {
          if (active == null || dragIdx.current != null) return;
          const { x, y } = pctFromEvent(e);
          placeAt(active, x, y, true);
        }}
        className="relative w-full select-none overflow-hidden rounded-lg border border-gray-300 bg-gray-100"
        style={{ aspectRatio: '16 / 9', touchAction: 'none', cursor: active != null ? 'crosshair' : 'default' }}
      >
        {videoUrl && (
          <video src={videoUrl} autoPlay loop muted playsInline
                 className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
        )}
        {items.map((it, i) => {
          const isActive = active === i;
          const color = it.far ? '#9ca3af' : '#475569';
          return (
            <div key={it.route_id + it.side}
                 className="absolute -translate-x-1/2 -translate-y-1/2"
                 style={{ left: `${it.center_pct[0]}%`, top: `${it.center_pct[1]}%`, zIndex: isActive ? 30 : 20 }}>
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setActive(i);
                  dragIdx.current = i;
                }}
                title={`${shortName(it.other)} — sudrab joyini o'zgartiring`}
                className={['mx-auto cursor-grab rounded-full border-2 border-white shadow',
                            isActive ? 'h-5 w-5 ring-2 ring-blue-400' : 'h-3.5 w-3.5'].join(' ')}
                style={{ background: color }}
              />
              <div className="pointer-events-none mt-0.5 max-w-[130px] truncate rounded bg-black/65 px-1 text-center text-[10px] leading-tight text-white">
                {savedTick === it.route_id ? '✓ saqlandi' : shortName(it.other)}
              </div>
            </div>
          );
        })}
      </div>

      {/* panel */}
      <div className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            O'tishlar ({items.length})
          </span>
          {error && <span className="max-w-[220px] truncate text-[11px] text-red-600" title={error}>{error}</span>}
        </div>
        <p className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
          Ro'yxatdan bg'ni tanlang, keyin kadr ustiga <b>bosing</b> yoki nuqtani <b>sudrang</b> —
          o'sha yer o'tish nuqtasi bo'ladi (kamera/personaj o'sha tomonga boradi). Har o'zgarish darhol saqlanadi.
        </p>
        {items.map((it, i) => {
          const isActive = active === i;
          return (
            <button key={it.route_id + it.side} type="button" onClick={() => setActive(i)}
                    className={['flex w-full items-center gap-2 rounded border p-2 text-left',
                                isActive ? 'border-blue-400 bg-blue-50/40' : 'border-gray-200 hover:bg-gray-50'].join(' ')}>
              <div className="h-[45px] w-20 shrink-0 overflow-hidden rounded bg-gray-200">
                {it.other_url && (
                  <video src={`${it.other_url}#t=0.04`} muted playsInline preload="metadata"
                         className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-gray-800">→ {shortName(it.other)}</div>
                <div className="text-[10px] text-gray-500">
                  {it.far ? '🌫 uzoq' : '🔗 yaqin'} · nuqta: [{it.center_pct[0]}, {it.center_pct[1]}]
                  {savedTick === it.route_id && <span className="ml-1 text-green-600">✓</span>}
                </div>
              </div>
              {isActive && <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">belgilanmoqda</span>}
            </button>
          );
        })}
        {items.length === 0 && (
          <p className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-400">
            Bu fondan chiqadigan o'tishlar yo'q — avval relation editorda strelka torting.
          </p>
        )}
      </div>
    </div>
  );
}
