import { useState } from 'react';

/**
 * Still-image thumbnail for a live background: the backend's cached
 * first-frame JPEG (~100 KB) instead of the multi-MB mp4. Real video playback
 * lives only in the Objects tab — everywhere else a poster is enough, which
 * is what makes the zone/transitions/map views open fast.
 */

/** ?novideo=1 — debug/slow-link mode: placeholders instead of any media */
const NO_VIDEO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('novideo');

export function posterUrl(slug: string): string {
  return `/api/v4/videos/${encodeURIComponent(slug)}/poster`;
}

export default function QueuedThumb({
  slug,
  url,
  w,
  h,
  className,
}: {
  slug: string;
  /** the mp4 url — used only as an "asset exists" check */
  url: string | null;
  w?: number;
  h?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = w != null || h != null ? { width: w, height: h } : undefined;
  if (NO_VIDEO && url) {
    return (
      <div className={`grid place-items-center bg-emerald-100 text-[10px] text-emerald-700 ${className ?? ''}`}
           style={style}>
        🎞
      </div>
    );
  }
  if (!url || failed) {
    return (
      <div className={`grid place-items-center bg-gray-200 text-[9px] text-gray-500 ${className ?? ''}`}
           style={style}>
        no mp4
      </div>
    );
  }
  return (
    <img
      src={posterUrl(slug)}
      alt={slug}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`bg-gray-100 object-cover ${className ?? ''}`}
      style={style}
    />
  );
}
