import { describe, expect, it } from 'vitest';
import { FRAME, frameOrigin, gridOf, withRev } from './sprite-sheet';

/**
 * These lock the grid contract shared with backend/app/image_transforms.py.
 * If a change here makes a test fail, the backend cutter must change too —
 * otherwise saving a frame reorder corrupts the sheet.
 */
describe('gridOf', () => {
  it('reads a square multi-row grid', () => {
    // The real fixture sheet: fox/idle, 2560x2560 = 5x5 = 25 frames.
    expect(gridOf(2560, 2560)).toEqual({ frameSize: 512, cols: 5, rows: 5, total: 25 });
  });

  it('reads a single-row strip', () => {
    expect(gridOf(41472, 512)).toEqual({ frameSize: 512, cols: 81, rows: 1, total: 81 });
  });

  it('falls back to the smaller side when the width is not a multiple of 512', () => {
    expect(gridOf(300, 300)).toEqual({ frameSize: 300, cols: 1, rows: 1, total: 1 });
  });

  it('never reports a zero-sized grid', () => {
    expect(gridOf(0, 0)).toEqual({ frameSize: FRAME, cols: 1, rows: 1, total: 1 });
  });
});

describe('frameOrigin', () => {
  const grid = gridOf(2560, 2560);

  it('walks left-to-right, then top-to-bottom', () => {
    expect(frameOrigin(0, grid)).toEqual({ sx: 0, sy: 0 });
    expect(frameOrigin(4, grid)).toEqual({ sx: 2048, sy: 0 });
    expect(frameOrigin(5, grid)).toEqual({ sx: 0, sy: 512 });
    expect(frameOrigin(24, grid)).toEqual({ sx: 2048, sy: 2048 });
  });
});

describe('withRev', () => {
  it('leaves a url alone when there is no revision yet', () => {
    expect(withRev('/a.png', 0)).toBe('/a.png');
    expect(withRev('/a.png')).toBe('/a.png');
  });

  it('appends with the right separator', () => {
    expect(withRev('/a.png', 3)).toBe('/a.png?rev=3');
    expect(withRev('/a.png?x=1', 3)).toBe('/a.png?x=1&rev=3');
  });

  it('passes through nullish urls', () => {
    expect(withRev(null, 2)).toBeUndefined();
    expect(withRev(undefined, 2)).toBeUndefined();
  });
});
