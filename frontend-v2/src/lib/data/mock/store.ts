/**
 * In-memory store behind the mock adapter.
 *
 * Fixtures are cloned once on load, then MUTATED in place, so edits made in the
 * prototype persist for the life of the tab. That matters: an editor where Save
 * silently does nothing can't be evaluated honestly.
 */

import type {
  AssetItem,
  AssetKind,
  BackgroundDoc,
  VideoMovers,
  WorldGraph,
} from '../types';

import assetsFixture from './fixtures/assets.json';
import zonesFixture from './fixtures/zones.json';
import moversFixture from './fixtures/movers.json';
import worldGraphsFixture from './fixtures/worldGraphs.json';
import mediaFixture from './fixtures/media.json';

export interface MediaFixture {
  spritesheet?: {
    url: string;
    width: number;
    height: number;
    frames: number;
    source: string;
  };
  backgrounds?: { slug: string; url: string }[];
  posters?: { slug: string; url: string }[];
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const media = mediaFixture as MediaFixture;

/** kind -> items, mutated in place by the adapter's write methods */
export const assets: Record<AssetKind, AssetItem[]> = clone(
  assetsFixture as unknown as Record<AssetKind, AssetItem[]>,
);

export const zones: Record<string, BackgroundDoc> = clone(
  zonesFixture as unknown as Record<string, BackgroundDoc>,
);

export const movers: Record<string, VideoMovers> = clone(
  moversFixture as unknown as Record<string, VideoMovers>,
);

export const worldGraphs: Record<string, WorldGraph> = clone(
  worldGraphsFixture as unknown as Record<string, WorldGraph>,
);

/**
 * Per-action state for sprite kinds. The fixture only carries action NAMES
 * (which are real); fps / frame counts / descriptions are seeded here so the
 * actions screen and frame editor have something to edit.
 */
export interface ActionState {
  enabled: boolean;
  fps: number;
  frameCount: number;
  description: string;
  rev: number;
  is3q: boolean;
}

const actionStates = new Map<string, ActionState>();

const actionKey = (slug: string, action: string) => `${slug}::${action}`;

/** Deterministic seed so a given action looks the same across reloads. */
function seedAction(slug: string, action: string): ActionState {
  let h = 0;
  for (const ch of actionKey(slug, action)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    enabled: true,
    fps: [8, 12, 12, 16, 24][h % 5],
    // The one real sheet we ship is 5x5; keep counts in that neighbourhood.
    frameCount: 12 + (h % 14),
    description: '',
    rev: 0,
    is3q: action.includes('3q'),
  };
}

export function getActionState(slug: string, action: string): ActionState {
  const key = actionKey(slug, action);
  let s = actionStates.get(key);
  if (!s) {
    s = seedAction(slug, action);
    actionStates.set(key, s);
  }
  return s;
}

export function setActionState(slug: string, action: string, patch: Partial<ActionState>): ActionState {
  const next = { ...getActionState(slug, action), ...patch };
  actionStates.set(actionKey(slug, action), next);
  return next;
}

export function moveActionState(slug: string, from: string, to: string): void {
  const s = getActionState(slug, from);
  actionStates.delete(actionKey(slug, from));
  actionStates.set(actionKey(slug, to), s);
}

export function dropActionState(slug: string, action: string): void {
  actionStates.delete(actionKey(slug, action));
}

/** Find an item across every kind (rename/config writes need this). */
export function findItem(kind: AssetKind, slug: string): AssetItem | undefined {
  return assets[kind]?.find((i) => i.slug === slug);
}
