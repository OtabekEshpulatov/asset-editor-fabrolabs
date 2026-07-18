import { useEffect, useRef } from 'react';

/**
 * Video thumbnail that loads through a GLOBAL one-at-a-time queue.
 *
 * The mp4s stream cold from remote MinIO through an uncached proxy; mounting
 * dozens of <video preload=metadata> at once saturates the link and every
 * page open feels stuck. Instead each thumb mounts with NO src and asks the
 * queue for its turn: one metadata fetch at a time, in mount order. Unmounted
 * thumbs leave the queue, so whatever is on screen loads first. Hover-to-play
 * still works the moment a thumb has loaded (play() also force-starts a fetch
 * for an impatient user). The big "main" editing videos stay OUTSIDE this
 * queue — they load immediately.
 */

/** ?novideo=1 — debug/slow-link mode: placeholders instead of mp4s */
const NO_VIDEO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('novideo');

const waiting: HTMLVideoElement[] = [];
const srcOf = new WeakMap<HTMLVideoElement, string>();
let current: HTMLVideoElement | null = null;

function startNext() {
  if (current) return;
  const el = waiting.shift();
  if (!el) return;
  current = el;
  let watchdog = 0;
  const done = () => {
    el.removeEventListener('loadedmetadata', done);
    el.removeEventListener('error', done);
    window.clearTimeout(watchdog);
    if (current === el) {
      current = null;
      startNext();
    }
  };
  el.addEventListener('loadedmetadata', done);
  el.addEventListener('error', done);
  watchdog = window.setTimeout(done, 12000); // a wedged fetch must not block the queue
  el.preload = 'metadata';
  el.src = srcOf.get(el) ?? '';
}

function enqueue(el: HTMLVideoElement, src: string) {
  srcOf.set(el, src);
  waiting.push(el);
  startNext();
}

function dequeue(el: HTMLVideoElement) {
  const i = waiting.indexOf(el);
  if (i >= 0) waiting.splice(i, 1);
  if (current === el) {
    current = null;
    startNext();
  }
}

export default function QueuedThumb({
  url,
  w,
  h,
  className,
  playOnHover = true,
}: {
  url: string | null;
  w?: number;
  h?: number;
  className?: string;
  playOnHover?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !url || NO_VIDEO) return;
    enqueue(el, `${url}#t=0.04`);
    return () => dequeue(el);
  }, [url]);

  const style = w != null || h != null ? { width: w, height: h } : undefined;
  if (NO_VIDEO && url) {
    return (
      <div className={`grid place-items-center bg-emerald-100 text-[10px] text-emerald-700 ${className ?? ''}`}
           style={style}>
        🎞
      </div>
    );
  }
  if (!url) {
    return (
      <div className={`grid place-items-center bg-gray-200 text-[9px] text-gray-500 ${className ?? ''}`}
           style={style}>
        no mp4
      </div>
    );
  }
  return (
    <video
      ref={ref}
      muted loop playsInline preload="none"
      onMouseEnter={playOnHover ? (e) => e.currentTarget.play().catch(() => {}) : undefined}
      onMouseLeave={playOnHover ? (e) => e.currentTarget.pause() : undefined}
      className={`bg-gray-100 object-cover ${className ?? ''}`}
      style={style}
    />
  );
}
