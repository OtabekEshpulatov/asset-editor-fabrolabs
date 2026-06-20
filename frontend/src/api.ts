import axios from 'axios';

export type AssetKind = 'character' | 'object' | 'background' | 'video';

// --- asset types (subset of story-gen-exps api_v4 used by the editor) --------

export interface V4BackgroundPlacement {
  x_pct?: Array<number | null>;
  y_pct?: Array<number | null>;
  note?: string | null;
}

export interface V4AssetMetadata {
  slug: string;
  kind: AssetKind;
  url: string | null;
  scene_type?: string | null;
  description?: string | null;
  character_placement?: V4BackgroundPlacement | null;
  object_placement?: V4BackgroundPlacement | null;
  zones?: Record<string, { y_pct?: Array<number | null>; description?: string | null }>;
  character_kind?: 'people' | 'animal' | 'bird' | string;
  subcategory?: string | null;
  sprite_base_path?: string | null;
  animations?: string[];
  animation_urls?: Record<string, string>;
}

export interface AssetCatalogItem {
  slug: string;
  url: string | null;
  description?: string;
  enabled?: boolean;
  rev?: number;
  animation_urls?: Record<string, string>;
  action_fps?: Record<string, number>;
  action_rev?: Record<string, number>;
}

export interface CharacterAction {
  name: string;
  spritesheet: string | null;
  enabled: boolean;
  fps: number;
  frame_count: number;
  description: string;
  rev: number;
}

export interface ImageTransform {
  flip_h?: boolean;
  flip_v?: boolean;
  rotate?: number; // clockwise degrees, baked into the saved file
}

export interface CharacterActions {
  slug: string;
  enabled: boolean;
  description: string;
  actions: CharacterAction[];
}

export interface AssetCatalogCategory {
  name: string;
  count: number;
  items: AssetCatalogItem[];
}

export interface AssetCatalog {
  kind: AssetKind;
  total: number;
  categories: AssetCatalogCategory[];
}

export interface BgZone {
  name: string;
  // Normalized polygon [x_pct, y_pct] points (0-100). The authoritative shape.
  polygon?: number[][];
  // Placement surface this zone offers (object rest_surface vocabulary).
  surface?: string;
  description: string;
  // Custom overlay colour (hex, e.g. "#22c55e"). Editor-only display aid.
  color?: string;
  // Client-only stable id for per-zone undo + React keys (backend ignores it).
  _uid?: number;
}

export interface BackgroundEditable {
  slug: string;
  manifest_key: string | null;
  url: string | null;
  description: string;
  resolution: { width: number; height: number };
  allowed_zone_names: string[];
  allowed_surfaces: string[];
  enabled: boolean;
  zones: BgZone[];
  // Set for live (mp4) backgrounds so the editor renders a <video> backdrop.
  is_video?: boolean;
}

export interface BackgroundUpdate {
  description: string;
  zones: BgZone[];
}

// Live (mp4) background config — any subset; omit `zones` to save config only.
export interface VideoUpdate {
  description?: string;
  enabled?: boolean;
  zones?: BgZone[];
}

// --- live-bg OBJECT editor (drag the moving objects, then re-render) ---------
// Mirrors story-gen-exps backend _mover_view. x/y/x0/x1 are % of the frame; `w` is
// px at a 1280-px render baseline (the backend keys the cutout on it) and `w_pct`
// is its on-canvas display width (= w / 1280 * 100).
export interface Mover {
  index: number;
  id: string;
  kind: string;                 // float | pulse | peek | patrol | swim | fall | bubbles
  x: number | null;
  y: number | null;
  w: number;
  w_pct: number;
  flip: boolean;
  to_left: boolean;
  x0: number | null;            // swim flight band start % (null = full off-screen cross)
  x1: number | null;
  positionable: boolean;        // float/pulse/peek/patrol — draggable x,y
  has_y: boolean;               // positionable OR swim
  cutout_url: string | null;    // null for fall/bubbles (full-frame) or if no preview shipped
}

export interface MoverEdit {
  index: number;
  x?: number;
  y?: number;
  w?: number;
  flip?: boolean;
  x0?: number;
  x1?: number;
}

export interface VideoMovers {
  slug: string;
  video_url: string;
  loop_s: number;
  water: string | null;
  movers: Mover[];
}

// --- asset API (prefix matches the backend router: /api/v4) ------------------

const client = axios.create({ baseURL: '/api/v4' });

export const apiV4 = {
  getAssetUrl: (slug: string, kind: AssetKind) =>
    client
      .get<{ slug: string; kind: AssetKind; url: string }>(
        `/assets/preview?slug=${encodeURIComponent(slug)}&kind=${kind}`,
      )
      .then((r) => r.data),

  getAssetMetadata: (slug: string, kind: AssetKind) =>
    client
      .get<V4AssetMetadata>(`/assets/metadata?slug=${encodeURIComponent(slug)}&kind=${kind}`)
      .then((r) => r.data),

  getAssetCatalog: (kind: AssetKind, includeDisabled = false) =>
    client
      .get<AssetCatalog>(
        `/assets/catalog?kind=${kind}${includeDisabled ? '&include_disabled=true' : ''}`,
      )
      .then((r) => r.data),

  getBackground: (slug: string) =>
    client
      .get<BackgroundEditable>(`/backgrounds/${encodeURIComponent(slug)}`)
      .then((r) => r.data),

  saveBackground: (slug: string, body: BackgroundUpdate) =>
    client
      .put<BackgroundEditable>(`/backgrounds/${encodeURIComponent(slug)}`, body)
      .then((r) => r.data),

  // Live (mp4) backgrounds — same editable shape as backgrounds (is_video=true).
  getVideo: (slug: string) =>
    client.get<BackgroundEditable>(`/videos/${encodeURIComponent(slug)}`).then((r) => r.data),

  saveVideo: (slug: string, body: VideoUpdate) =>
    client.put<BackgroundEditable>(`/videos/${encodeURIComponent(slug)}`, body).then((r) => r.data),

  // Live-bg moving objects: load draggable positions, save -> backend re-renders the mp4.
  getVideoMovers: (slug: string) =>
    client.get<VideoMovers>(`/videos/${encodeURIComponent(slug)}/movers`).then((r) => r.data),

  saveVideoMovers: (slug: string, movers: MoverEdit[]) =>
    client
      .post<{ ok: boolean; video_url: string }>(`/videos/${encodeURIComponent(slug)}/movers`, { movers })
      .then((r) => r.data),

  addObject: (form: FormData) => client.post('/assets/objects', form).then((r) => r.data),
  addBackground: (form: FormData) => client.post('/assets/backgrounds', form).then((r) => r.data),
  addCharacter: (form: FormData) => client.post('/assets/characters', form).then((r) => r.data),

  renameAsset: (kind: AssetKind, oldSlug: string, newSlug: string) =>
    client
      .post('/assets/rename', { kind, old_slug: oldSlug, new_slug: newSlug })
      .then((r) => r.data),

  setAssetConfig: (
    kind: AssetKind,
    slug: string,
    fields: { enabled?: boolean; description?: string },
  ) => client.put('/assets/config', { kind, slug, ...fields }).then((r) => r.data),

  getCharacterActions: (slug: string) =>
    client
      .get<CharacterActions>(`/assets/characters/${encodeURIComponent(slug)}/actions`)
      .then((r) => r.data),

  addCharacterAction: (slug: string, form: FormData) =>
    client
      .post(`/assets/characters/${encodeURIComponent(slug)}/actions`, form)
      .then((r) => r.data),

  renameAction: (slug: string, oldName: string, newName: string) =>
    client.post('/assets/actions/rename', { slug, old: oldName, new: newName }).then((r) => r.data),

  mirrorAction: (slug: string, source: string, newName?: string) =>
    client.post('/assets/actions/mirror', { slug, source, new: newName }).then((r) => r.data),

  deleteAction: (slug: string, action: string) =>
    client
      .delete(
        `/assets/characters/${encodeURIComponent(slug)}/actions/${encodeURIComponent(action)}`,
      )
      .then((r) => r.data),

  getConfigView: (kind: AssetKind, slug: string, action?: string) =>
    client
      .get(
        `/assets/config-view?kind=${kind}&slug=${encodeURIComponent(slug)}` +
          (action ? `&action=${encodeURIComponent(action)}` : ''),
      )
      .then((r) => r.data),

  setActionConfig: (
    slug: string,
    action: string,
    fields: { enabled?: boolean; description?: string; fps?: number; frame_count?: number },
  ) => client.put('/assets/actions/config', { slug, action, ...fields }).then((r) => r.data),

  // Destructive in-place flip/rotate — overwrites the file in storage. Returns new `rev`.
  transformAsset: (kind: AssetKind, slug: string, t: ImageTransform) =>
    client
      .post<{ kind: AssetKind; slug: string; rev?: number; action_rev?: Record<string, number> }>(
        '/assets/transform',
        { kind, slug, ...t },
      )
      .then((r) => r.data),

  transformAction: (slug: string, action: string, t: ImageTransform) =>
    client
      .post<{ slug: string; action: string; rev: number }>('/assets/actions/transform', {
        slug,
        action,
        ...t,
      })
      .then((r) => r.data),
};

// --- storage info (read-only; storage is auto-connected from env) -------------

export interface StorageInfo {
  configured: boolean;
  endpoint_url?: string;
  bucket?: string;
  public_url?: string;
  access_key?: string;
}

const rootClient = axios.create({ baseURL: '/api' });

export const storageApi = {
  info: () => rootClient.get<StorageInfo>('/storage-info').then((r) => r.data),
  reload: () => rootClient.post<StorageInfo>('/storage-reload').then((r) => r.data),
};
