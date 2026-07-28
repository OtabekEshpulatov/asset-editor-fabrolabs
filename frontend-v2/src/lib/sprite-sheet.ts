/**
 * Sprite sheet geometry + a byte-budgeted decode cache.
 *
 * Carried over from the old editor's SpriteCanvas, which learned this the hard
 * way. Two things here are load-bearing:
 *
 * 1. THE GRID HEURISTIC IS A CONTRACT. The frame indices computed here must line
 *    up 1:1 with what the backend cuts when it rebuilds a sheet from an `order`
 *    array. The same heuristic lives in backend/app/image_transforms.py. If they
 *    ever disagree, frame edits silently corrupt spritesheets. Change both or
 *    neither. In the old frontend this logic was duplicated in SpriteCanvas AND
 *    FrameEditorModal; here there is exactly one copy.
 *
 * 2. THE CACHE BUDGET IS IN BYTES, NOT ENTRIES. Decoded sheets are wildly
 *    uneven: a 2560x2560 grid is ~26 MB of RGBA, while a single-row 41472x512
 *    sheet is ~85 MB. Capping by entry count would pin anywhere from 1 to 3+ GB
 *    for the same nominal limit.
 *
 * NOTE: in v2 the GRID cards never touch this — they render ~5 KB server
 * thumbnails instead of decoding megabyte sheets. This path is only for
 * full-size playback and the frame editor, which genuinely need real pixels.
 */

/** Sprite sheets are grids of 512px cells, left-to-right, top-to-bottom. */
export const FRAME = 512;
export const DEFAULT_FPS = 12;

const MAX_CACHED_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, HTMLImageElement>();

/** Decoded RGBA cost; 0 until the image has actually decoded. */
function bitmapBytes(img: HTMLImageElement): number {
  return img.naturalWidth * img.naturalHeight * 4;
}

function evictToBudget(): void {
  let total = 0;
  for (const img of cache.values()) total += bitmapBytes(img);
  // Map iterates in insertion order, so the front is least-recently-used.
  for (const key of [...cache.keys()]) {
    if (total <= MAX_CACHED_BYTES) break;
    const img = cache.get(key);
    if (!img) continue;
    total -= bitmapBytes(img);
    cache.delete(key);
  }
}

export function loadSheet(url: string): Promise<HTMLImageElement> {
  const hit = cache.get(url);
  if (hit) {
    // Refresh LRU position.
    cache.delete(url);
    cache.set(url, hit);
    if (hit.complete && hit.naturalWidth > 0) return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const img = hit ?? new Image();
    const done = () => {
      evictToBudget(); // size is only known post-decode
      resolve(img);
    };
    if (img.complete && img.naturalWidth > 0) return done();
    img.onload = done;
    img.onerror = reject;
    if (!hit) {
      img.src = url;
      cache.set(url, img);
    }
  });
}

export interface SheetGrid {
  frameSize: number;
  cols: number;
  rows: number;
  total: number;
}

/** Infer the frame grid from a sheet's natural size. See the contract note above. */
export function gridOf(width: number, height: number): SheetGrid {
  const frameSize = width >= FRAME && width % FRAME === 0 ? FRAME : Math.min(width, height) || FRAME;
  const cols = Math.max(1, Math.floor(width / frameSize));
  const rows = Math.max(1, Math.floor(height / frameSize));
  return { frameSize, cols, rows, total: cols * rows };
}

export function gridOfImage(img: HTMLImageElement): SheetGrid {
  return gridOf(img.naturalWidth, img.naturalHeight);
}

/** Top-left source pixel of frame `index` within the sheet. */
export function frameOrigin(index: number, grid: SheetGrid): { sx: number; sy: number } {
  return {
    sx: (index % grid.cols) * grid.frameSize,
    sy: Math.floor(index / grid.cols) * grid.frameSize,
  };
}

/** Append the asset's edit revision so an overwritten file isn't served stale. */
export function withRev(url: string | null | undefined, rev?: number): string | undefined {
  if (!url) return undefined;
  if (!rev) return url;
  return url + (url.includes('?') ? '&' : '?') + 'rev=' + rev;
}

/** Test seam — the decode cache is module-global and would leak across tests. */
export function __clearSheetCache(): void {
  cache.clear();
}
