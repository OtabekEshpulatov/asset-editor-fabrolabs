/**
 * Per-kind presentation and capabilities, in ONE place.
 *
 * The old editor spread this across a KIND_TABS array, a KIND_LABEL map, and a
 * scatter of inline `kind === 'video' || kind === 'video_v2' || ...` checks in
 * the page body. Adding a kind meant finding all of them. Here a kind is one
 * row, and screens ask about capabilities rather than testing kind names.
 */

import {
  Boxes,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Music,
  PersonStanding,
  Sparkles,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import type { AssetKind } from './data/types';

export type CardShape = 'sprite' | 'image' | 'video' | 'audio';

export interface KindMeta {
  key: AssetKind;
  label: string;
  /** shown under the label in the sidebar */
  hint: string;
  icon: LucideIcon;
  shape: CardShape;
  group: 'Library' | 'Live scenes' | 'Openings' | 'Generated';
  /** sprite sheets that animate client-side */
  animates: boolean;
  /** has per-action management (the actions screen) */
  hasActions: boolean;
  /** opens the polygon zone editor */
  hasZones: boolean;
  /** live scenes: moving objects + transitions + world graph */
  isLiveScene: boolean;
  /** can be uploaded from the UI (others are published by pipelines) */
  canAdd: boolean;
}

export const KINDS: Record<AssetKind, KindMeta> = {
  character: {
    key: 'character',
    label: 'Sprites',
    hint: 'Animated characters',
    icon: PersonStanding,
    shape: 'sprite',
    group: 'Library',
    animates: true,
    hasActions: true,
    hasZones: false,
    isLiveScene: false,
    canAdd: true,
  },
  background: {
    key: 'background',
    label: 'Backgrounds',
    hint: 'Still scenes with zones',
    icon: ImageIcon,
    shape: 'image',
    group: 'Library',
    animates: false,
    hasActions: false,
    hasZones: true,
    isLiveScene: false,
    canAdd: true,
  },
  object: {
    key: 'object',
    label: 'Objects',
    hint: 'Props and cutouts',
    icon: Boxes,
    shape: 'image',
    group: 'Library',
    animates: false,
    hasActions: false,
    hasZones: false,
    isLiveScene: false,
    canAdd: true,
  },
  video: {
    key: 'video',
    label: 'Live BGs',
    hint: 'Animated mp4 scenes',
    icon: Film,
    shape: 'video',
    group: 'Live scenes',
    animates: false,
    hasActions: false,
    hasZones: true,
    isLiveScene: true,
    canAdd: false,
  },
  video_v2: {
    key: 'video_v2',
    label: 'Live BG v2',
    hint: 'Re-animated, under review',
    icon: Film,
    shape: 'video',
    group: 'Live scenes',
    animates: false,
    hasActions: false,
    hasZones: true,
    isLiveScene: true,
    canAdd: false,
  },
  video_v3: {
    key: 'video_v3',
    label: 'Relation worlds',
    hint: 'Scenes wired into a world map',
    icon: Waves,
    shape: 'video',
    group: 'Live scenes',
    animates: false,
    hasActions: false,
    hasZones: true,
    isLiveScene: true,
    canAdd: false,
  },
  intro: {
    key: 'intro',
    label: 'Intros',
    hint: 'World opening cards',
    icon: Clapperboard,
    shape: 'video',
    group: 'Openings',
    animates: false,
    hasActions: false,
    hasZones: false,
    isLiveScene: false,
    canAdd: false,
  },
  intro_end: {
    key: 'intro_end',
    label: 'End cards',
    hint: 'Goodnight closers',
    icon: Clapperboard,
    shape: 'video',
    group: 'Openings',
    animates: false,
    hasActions: false,
    hasZones: false,
    isLiveScene: false,
    canAdd: false,
  },
  intro_music: {
    key: 'intro_music',
    label: 'Intro music',
    hint: 'Theme song pool',
    icon: Music,
    shape: 'audio',
    group: 'Openings',
    animates: false,
    hasActions: false,
    hasZones: false,
    isLiveScene: false,
    canAdd: false,
  },
  animation: {
    key: 'animation',
    label: 'Animations v2',
    hint: 'Regenerated sprite libraries',
    icon: Sparkles,
    shape: 'sprite',
    group: 'Generated',
    animates: true,
    hasActions: true,
    hasZones: false,
    isLiveScene: false,
    canAdd: false,
  },
  animation_v3: {
    key: 'animation_v3',
    label: 'Animations v3',
    hint: 'Curated subset',
    icon: Sparkles,
    shape: 'sprite',
    group: 'Generated',
    animates: true,
    hasActions: true,
    hasZones: false,
    isLiveScene: false,
    canAdd: false,
  },
};

export const KIND_GROUPS: KindMeta['group'][] = [
  'Library',
  'Live scenes',
  'Openings',
  'Generated',
];

export function kindsInGroup(group: KindMeta['group']): KindMeta[] {
  return Object.values(KINDS).filter((k) => k.group === group);
}

/** Human label for a category path like `animals/birds` -> `Animals / Birds`. */
export function prettyCategory(name: string): string {
  return name
    .split('/')
    .map((part) => part.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' / ');
}

/** `idle_3q` reads badly in a list; everything else is fine as-is. */
export function prettyAction(name: string): string {
  return name === 'idle_3q' ? 'idle ¾' : name.replace(/_/g, ' ');
}
