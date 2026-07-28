import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Viewport gating. Every heavy card (sprite canvas, poster, video) uses this so
 * a long grid only does work for what is actually on screen — the old editor
 * re-implemented this observer in three components.
 */
export function useInView<T extends HTMLElement>(rootMargin = '200px') {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => setInView(e.isIntersecting)),
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}

export type Theme = 'dark' | 'light';

/**
 * Dark is the default; `.light` on <html> is the override. index.html applies
 * the stored choice before first paint, so this hook only has to keep up.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark',
  );

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.classList.toggle('light', t === 'light');
    try {
      localStorage.setItem('theme', t);
    } catch {
      /* private mode — the choice just won't persist */
    }
    setThemeState(t);
  }, []);

  return [theme, setTheme];
}

/**
 * View state in the URL.
 *
 * Carried over from the old gallery, which got this right: the tab, search,
 * category and selection live in the query string, so a reload or a round-trip
 * into an editor and back restores exactly what you were looking at.
 */
export function useUrlState() {
  const [params, setParams] = useSearchParams();

  const patch = useCallback(
    (updates: Record<string, string | null | undefined>, opts?: { push?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        // Filter tweaks shouldn't stack up in history; navigation should.
        { replace: !opts?.push },
      );
    },
    [setParams],
  );

  return { params, patch };
}

/** Debounce a fast-changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Global hotkey. `combo` looks like "mod+k" or "escape". */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void) {
  const saved = useRef(handler);
  useLayoutEffect(() => {
    saved.current = handler;
  });

  useEffect(() => {
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needsMod = parts.includes('mod');
    const needsShift = parts.includes('shift');

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (needsMod !== mod) return;
      if (needsShift !== e.shiftKey) return;
      if (e.key.toLowerCase() !== key) return;
      saved.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo]);
}

/**
 * Element width, for virtualization math that needs a live column count.
 *
 * Uses a CALLBACK ref, not a ref object, on purpose: the measured node is often
 * behind a conditional return (a loading skeleton renders instead of the grid),
 * so an effect keyed on `[]` would run while the ref is still null and never
 * re-run once the real node mounted — leaving the width pinned at 0 and the
 * grid stuck in a single column.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [node]);

  return { ref: setNode, width };
}
