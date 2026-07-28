/**
 * The data contract every screen talks to.
 *
 * Features import from `@/lib/data`, never from `fetch`/axios directly. Phase 1
 * ships the `mock` adapter; phase 3 adds `http` against /api/v5 and the UI code
 * does not change. That is the whole reason this file exists — keep it free of
 * anything React or transport specific.
 */

export type AssetKind =
  | 'character'
  | 'object'
  | 'background'
  | 'video'
  | 'video_v2'
  | 'video_v3'
  | 'intro'
  | 'intro_end'
  | 'intro_music'
  | 'animation'
  | 'animation_v3';

export const ASSET_KINDS: AssetKind[] = [
  'character',
  'background',
  'object',
  'video',
  'video_v2',
  'video_v3',
  'intro',
  'intro_end',
  'intro_music',
  'animation',
  'animation_v3',
];

/** Batch-generation progress, present while a character is still rendering. */
export interface AssetProgress {
  done: number;
  total: number;
  status: string;
}

export interface AssetItem {
  slug: string;
  kind: AssetKind;
  category: string;
  /** small still (~5 KB) — what grid cards render */
  thumb: string | null;
  /** horizontal frame strip (~16 KB) for hover-to-animate; sprites only */
  strip?: string | null;
  /**
   * The actual asset: an mp4 for video kinds, an mp3 for music, the
   * full-resolution image for stills. Grid cards never load this — it is what
   * the inspector plays or shows full size, and what "Open original" points at.
   */
  media?: string | null;
  enabled: boolean;
  /** cache-bust revision, bumped by every destructive edit */
  rev: number;
  description: string;
  /** action names, for sprite-like kinds */
  actions?: string[];
  progress?: AssetProgress | null;
  duration_s?: number;
  /** pixel dimensions, for stills and scenes */
  resolution?: { width: number; height: number } | null;
  /** how many placement zones are authored on this scene */
  zone_count?: number | null;
  /** where the file lives in the bucket */
  storage_key?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** total matching the filter, not the page length */
  total: number;
}

export type EnabledFilter = 'all' | 'enabled' | 'disabled';

export interface AssetQuery {
  kind: AssetKind;
  /** omit or 'all' for every category */
  category?: string;
  q?: string;
  enabled?: EnabledFilter;
  cursor?: string | null;
  limit?: number;
}

export interface Facet {
  name: string;
  count: number;
}

// --- sprite actions ----------------------------------------------------------

export interface ActionDetail {
  name: string;
  /** full-resolution sheet — only loaded by the frame editor / large preview */
  spritesheet: string | null;
  /** small animated strip for list rows */
  strip: string | null;
  enabled: boolean;
  fps: number;
  frameCount: number;
  description: string;
  rev: number;
  is3q: boolean;
}

export interface AssetDetail extends AssetItem {
  actionDetails: ActionDetail[];
}

export interface ImageTransform {
  flip_h?: boolean;
  flip_v?: boolean;
  /** clockwise degrees, baked into the stored file */
  rotate?: number;
}

// --- background / live-bg zones ---------------------------------------------

export interface BgZone {
  name: string;
  /** normalized polygon [x_pct, y_pct] points, 0-100 — the authoritative shape */
  polygon: number[][];
  /** placement surface, matching the object rest_surface vocabulary */
  surface: string;
  description: string;
  /** custom overlay colour (hex); editor-only display aid */
  color?: string | null;
  /** client-only stable id for per-zone undo + React keys */
  _uid?: number;
}

export interface BackgroundDoc {
  slug: string;
  manifest_key: string | null;
  url: string | null;
  description: string;
  resolution: { width: number; height: number };
  allowed_zone_names: string[];
  allowed_surfaces: string[];
  enabled: boolean;
  zones: BgZone[];
  /** true for live (mp4) backgrounds — the canvas shows a poster still */
  is_video?: boolean;
}

// --- live-bg moving objects --------------------------------------------------

export interface Mover {
  index: number;
  id: string;
  /** float | pulse | peek | patrol | swim | fall | bubbles | strip */
  kind: string;
  x: number | null;
  y: number | null;
  /** px at a 1280-px render baseline */
  w: number;
  /** on-canvas display width, = w / 1280 * 100 */
  w_pct: number;
  flip: boolean;
  to_left: boolean;
  /** swim flight band, null = full off-screen cross */
  x0: number | null;
  x1: number | null;
  /** animation-rate multiplier (>1 faster) */
  speed: number;
  /** float/pulse/peek/patrol — draggable x,y */
  positionable: boolean;
  /** positionable OR swim */
  has_y: boolean;
  cutout_url: string | null;
  bush?: string | null;
  bush_x?: number | null;
  bush_y?: number | null;
  bush_w?: number | null;
  bush_w_pct?: number | null;
  bush_cutout_url?: string | null;
  /** strip (parallax band) scroll speed, integer >= 1 */
  tiles_per_loop?: number | null;
  /** client-only: added this session, not yet in the spec */
  isNew?: boolean;
  still?: boolean;
  breathe?: boolean;
}

export interface MoverEdit {
  index: number;
  x?: number;
  y?: number;
  w?: number;
  flip?: boolean;
  to_left?: boolean;
  speed?: number;
  x0?: number;
  x1?: number;
  tiles_per_loop?: number;
}

export interface AddedMover {
  id: string;
  kind: string;
  x?: number;
  y?: number;
  w?: number;
  flip?: boolean;
  still?: boolean;
  breathe?: boolean;
  speed?: number;
}

export interface SaveMoversBody {
  movers: MoverEdit[];
  removed?: number[];
  added?: AddedMover[];
}

export interface VideoMovers {
  slug: string;
  video_url: string;
  loop_s: number;
  water: string | null;
  movers: Mover[];
}

export interface PaletteAsset {
  id: string;
  preview_url: string | null;
}

// --- world graph (Live BG v3) ------------------------------------------------

export interface RelationEndpoint {
  zone?: string;
  screen_zone?: string;
  /** [x, y] in 0-100, top-left origin */
  center_pct?: number[];
  landmark_ids?: string[];
}

export interface RelationRoute {
  id: string;
  from: string;
  to: string;
  bidirectional: boolean;
  relation: 'path' | 'enter' | string;
  /** door | arch | gate | stair | walkway | edge | vista | vehicle */
  portal: string;
  exit: RelationEndpoint;
  entry: RelationEndpoint;
}

export interface RelationNode {
  slug: string;
  url: string | null;
  description: string;
  indoor: boolean;
  tod: 'day' | 'dusk' | 'night' | string;
  parent: string | null;
  status: string;
  /** themed district; cross-cluster routes are gateways */
  cluster?: string | null;
  ui?: { x: number; y: number } | null;
}

export interface WorldGraph {
  world_id: string;
  version?: number;
  clusters?: Record<string, { title?: string; emoji?: string }>;
  nodes: RelationNode[];
  routes: RelationRoute[];
  editor_ui?: Record<string, { x: number; y: number }>;
}

/** One background's transition toward a related background. */
export interface BgTransition {
  route_id: string;
  /** which endpoint of the route sits ON this background */
  side: 'exit' | 'entry';
  other: string;
  other_url: string | null;
  far: boolean;
  center_pct: [number, number];
  zone: string;
}

// --- the adapter -------------------------------------------------------------

export interface RenderJob {
  /** 0-100 */
  progress: number;
  status: 'queued' | 'rendering' | 'done' | 'failed';
  message: string;
}

export interface DataAdapter {
  readonly name: 'mock' | 'http';

  // library
  listAssets(query: AssetQuery): Promise<Page<AssetItem>>;
  facets(kind: AssetKind): Promise<Facet[]>;
  kindCounts(): Promise<Record<AssetKind, number>>;
  /** cross-kind search for the command palette */
  searchAll(q: string, limit?: number): Promise<AssetItem[]>;

  // asset
  getAsset(kind: AssetKind, slug: string): Promise<AssetDetail>;
  setAssetConfig(
    kind: AssetKind,
    slug: string,
    fields: { enabled?: boolean; description?: string },
  ): Promise<AssetItem>;
  renameAsset(kind: AssetKind, oldSlug: string, newSlug: string): Promise<AssetItem>;
  transformAsset(kind: AssetKind, slug: string, t: ImageTransform): Promise<{ rev: number }>;

  // sprite actions
  setActionConfig(
    slug: string,
    action: string,
    fields: { enabled?: boolean; description?: string; fps?: number; is3q?: boolean },
  ): Promise<ActionDetail>;
  renameAction(slug: string, oldName: string, newName: string): Promise<ActionDetail>;
  mirrorAction(slug: string, source: string): Promise<ActionDetail>;
  deleteAction(slug: string, action: string): Promise<void>;
  transformAction(slug: string, action: string, t: ImageTransform): Promise<{ rev: number }>;
  /** new sequence of SOURCE frame indices: omit to delete, repeat to copy */
  reorderFrames(
    slug: string,
    action: string,
    order: number[],
  ): Promise<{ rev: number; frameCount: number }>;

  // zones
  getBackgroundDoc(slug: string): Promise<BackgroundDoc>;
  saveBackgroundDoc(
    slug: string,
    body: { description: string; zones: BgZone[] },
  ): Promise<BackgroundDoc>;

  // live-bg movers
  getMovers(slug: string): Promise<VideoMovers>;
  listMoverPalette(): Promise<PaletteAsset[]>;
  saveMovers(
    slug: string,
    body: SaveMoversBody,
    onProgress?: (job: RenderJob) => void,
  ): Promise<{ ok: boolean; video_url: string }>;

  // transitions
  getTransitions(slug: string): Promise<{ world_id: string; transitions: BgTransition[] }>;
  setTransitionPoint(
    worldId: string,
    body: { route_id: string; side: 'exit' | 'entry'; center_pct: [number, number] },
  ): Promise<void>;

  // world graph
  listWorlds(): Promise<string[]>;
  getWorldGraph(worldId: string): Promise<WorldGraph>;
  saveWorldGraph(
    worldId: string,
    body: { routes: RelationRoute[]; ui: Record<string, { x: number; y: number }> },
  ): Promise<WorldGraph>;
}
