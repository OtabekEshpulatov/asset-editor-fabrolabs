import { describe, expect, it } from 'vitest';
import type { RelationNode, RelationRoute } from '@/lib/data';
import {
  auditWorld,
  autoLayout,
  directedAdj,
  districtBox,
  hasCrossDistrictOverlap,
  shortestPath,
  undirectedAdj,
  CARD_W,
} from './worldGraph';

/**
 * The graph math was ported verbatim from the old editor and had no tests
 * there. These lock its behaviour before it starts being relied on again —
 * particularly the audit, which is what tells an author their world is broken.
 */

const node = (slug: string, cluster = 'a', tod = 'day'): RelationNode => ({
  slug,
  url: null,
  description: '',
  indoor: false,
  tod,
  parent: null,
  status: 'ready',
  cluster,
  ui: null,
});

const route = (
  id: string,
  from: string,
  to: string,
  extra: Partial<RelationRoute> = {},
): RelationRoute => ({
  id,
  from,
  to,
  bidirectional: true,
  relation: 'path',
  portal: 'path',
  exit: {},
  entry: {},
  ...extra,
});

describe('adjacency', () => {
  const routes = [route('r1', 'a', 'b'), route('r2', 'b', 'c')];

  it('undirected walks both ways', () => {
    const adj = undirectedAdj(routes);
    expect([...(adj.get('b') ?? [])].sort()).toEqual(['a', 'c']);
  });

  it('directed walks both ways for a BIDIRECTIONAL route', () => {
    const adj = directedAdj(routes);
    expect([...(adj.get('c') ?? [])]).toEqual(['b']);
  });

  it('directed walks one way only for a ONE-WAY route', () => {
    const adj = directedAdj([route('r1', 'a', 'b', { bidirectional: false })]);
    expect([...(adj.get('a') ?? [])]).toEqual(['b']);
    expect([...(adj.get('b') ?? [])]).toEqual([]);
  });

  it('undirected ignores direction even for a one-way route', () => {
    const adj = undirectedAdj([route('r1', 'a', 'b', { bidirectional: false })]);
    expect([...(adj.get('b') ?? [])]).toEqual(['a']);
  });
});

describe('shortestPath', () => {
  const adj = undirectedAdj([route('r1', 'a', 'b'), route('r2', 'b', 'c'), route('r3', 'c', 'd')]);

  it('finds the hop sequence', () => {
    expect(shortestPath('a', 'd', adj)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns null when unreachable', () => {
    expect(shortestPath('a', 'zzz', adj)).toBeNull();
  });
});

describe('auditWorld', () => {
  it('reports a fully connected world as clean', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const routes = [route('r1', 'a', 'b'), route('r2', 'b', 'c')];
    const audit = auditWorld(nodes, routes);
    expect(audit.components).toHaveLength(1);
    expect(audit.orphans).toEqual([]);
    expect(audit.problemCount).toBe(0);
  });

  it('finds an orphan with no relations at all', () => {
    const nodes = [node('a'), node('b'), node('lonely')];
    const audit = auditWorld(nodes, [route('r1', 'a', 'b')]);
    expect(audit.orphans).toEqual(['lonely']);
    // An orphan is also its own component, so it counts twice — once as a
    // split world, once as an orphan. That is intended: both are real problems.
    expect(audit.components).toHaveLength(2);
  });

  it('finds a dead end you can enter but never leave', () => {
    const nodes = [node('a'), node('trap')];
    const audit = auditWorld(nodes, [route('r1', 'a', 'trap', { bidirectional: false })]);
    expect(audit.deadEnds).toEqual(['trap']);
  });

  it('flags a time-of-day mismatch between touching scenes', () => {
    const nodes = [node('day_room', 'a', 'day'), node('night_room', 'a', 'night')];
    const audit = auditWorld(nodes, [route('r1', 'day_room', 'night_room')]);
    expect(audit.todMismatch).toHaveLength(1);
    expect(audit.todMismatch[0].fromTod).toBe('day');
  });

  it('does not flag time-of-day across a far "edge" portal', () => {
    const nodes = [node('day_room', 'a', 'day'), node('night_room', 'a', 'night')];
    const audit = auditWorld(nodes, [route('r1', 'day_room', 'night_room', { portal: 'edge' })]);
    expect(audit.todMismatch).toEqual([]);
  });

  it('splits a disconnected world into components, largest first', () => {
    const nodes = [node('a'), node('b'), node('c'), node('x'), node('y')];
    const routes = [route('r1', 'a', 'b'), route('r2', 'b', 'c'), route('r3', 'x', 'y')];
    const audit = auditWorld(nodes, routes);
    expect(audit.components.map((c) => c.length)).toEqual([3, 2]);
    expect(audit.problemCount).toBeGreaterThan(0);
  });
});

describe('autoLayout', () => {
  it('gives every node a position and keeps districts apart', () => {
    const nodes = [node('a1', 'canopy'), node('a2', 'canopy'), node('b1', 'roots')];
    const routes = [route('r1', 'a1', 'a2')];
    const pos = autoLayout(nodes, routes, ['canopy', 'roots']);
    expect(pos.size).toBe(3);
    expect(hasCrossDistrictOverlap(nodes, pos)).toBe(false);
  });
});

describe('districtBox', () => {
  it('encloses its members with padding', () => {
    const pos = new Map([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 300, y: 100 }],
    ]);
    const box = districtBox(['a', 'b'], pos)!;
    expect(box.x).toBeLessThan(100);
    expect(box.width).toBeGreaterThan(200 + CARD_W);
  });

  it('returns null when nothing is placed', () => {
    expect(districtBox(['a'], new Map())).toBeNull();
  });
});
