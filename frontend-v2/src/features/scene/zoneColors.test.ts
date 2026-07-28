import { describe, expect, it } from 'vitest';
import { centroid, clampPct, defaultZoneColor, nearestEdge } from './zoneColors';

describe('clampPct', () => {
  it('keeps values inside 0-100 and rounds to 2dp', () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(33.33333)).toBe(33.33);
  });
});

describe('defaultZoneColor', () => {
  it('uses the preset for well-known zones', () => {
    expect(defaultZoneColor('sky')).toBe('#3b82f6');
    expect(defaultZoneColor('ground')).toBe('#22c55e');
  });

  it('is stable for unknown names', () => {
    expect(defaultZoneColor('lagoon')).toBe(defaultZoneColor('lagoon'));
  });
});

describe('centroid', () => {
  it('averages the points', () => {
    expect(centroid([[0, 0], [10, 0], [10, 10], [0, 10]])).toEqual([5, 5]);
  });

  it('falls back to the middle for an empty polygon', () => {
    expect(centroid([])).toEqual([50, 50]);
  });
});

describe('nearestEdge', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('splices into the edge closest to the click', () => {
    // just below the top edge (index 0 -> 1) inserts at 1
    expect(nearestEdge(square, [5, 0.5])).toBe(1);
    // just inside the right edge (index 1 -> 2) inserts at 2
    expect(nearestEdge(square, [9.5, 5])).toBe(2);
    // just inside the bottom edge inserts at 3
    expect(nearestEdge(square, [5, 9.5])).toBe(3);
  });
});
