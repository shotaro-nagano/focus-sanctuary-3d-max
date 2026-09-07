// Focus Sanctuary 3D MAX EDITION - global configuration (shared contract).
// Production durations are fixed. Test clocks never change these values.
import type { PoseKey } from './shared/params';

export const APP_NAME = 'Focus Sanctuary';
export const CONCEPT_NAME = 'CHRONO CHRYSALIS';
export const STORAGE_KEY = 'focus-sanctuary-3d-max:v1';

export const DURATIONS = {
  focus: 25 * 60_000,
  short: 5 * 60_000,
  long: 15 * 60_000,
} as const;

export const LONG_BREAK_EVERY = 4; // every 4th completed focus -> long break

export const PALETTE = {
  space: '#050608',
  spaceLift: '#101116',
  metal: '#DCE0E6',
  metalDark: '#C9CDD4',
  citron: '#D9FF62',
  ice: '#BFE9FF',
  warm: '#FFD2A8',
  violet: '#C9B8FF',
  pink: '#FFB8D9',
  chalk: '#F0F2F5',
} as const;

export type QualityName = 'ultra' | 'high' | 'medium' | 'low';

export interface QualityPreset {
  name: QualityName;
  maxPixelRatio: number;
  /** true = MeshPhysicalMaterial transmission; false = cheaper fake-glass fallback */
  transmission: boolean;
  transmissionScale: number;
  bloom: boolean;
  /** bloom render scale relative to viewport (0.5 = half res) */
  bloomScale: number;
  particles: { near: number; mid: number; far: number };
  /** planar Reflector floor (extra scene render) */
  reflector: boolean;
  /** shell surface grid density multiplier (1 = spec density) */
  geometryDetail: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  /** everything on (planar reflector, full-res transmission, DPR up to 2) — for strong GPUs / captures */
  ultra: {
    name: 'ultra',
    maxPixelRatio: 2,
    transmission: true,
    transmissionScale: 1,
    bloom: true,
    bloomScale: 0.5,
    particles: { near: 160, mid: 1400, far: 3200 },
    reflector: true,
    geometryDetail: 1,
  },
  /** desktop default: real transmission + bloom, DPR capped at 1.5, no second scene render for the floor */
  high: {
    name: 'high',
    maxPixelRatio: 1.5,
    transmission: true,
    transmissionScale: 0.5,
    bloom: true,
    bloomScale: 0.4,
    particles: { near: 160, mid: 1400, far: 3200 },
    reflector: false,
    geometryDetail: 1,
  },
  medium: {
    name: 'medium',
    maxPixelRatio: 1.5,
    transmission: true,
    transmissionScale: 0.5,
    bloom: true,
    bloomScale: 0.25,
    particles: { near: 200, mid: 1000, far: 2400 },
    reflector: false,
    geometryDetail: 0.7,
  },
  low: {
    name: 'low',
    maxPixelRatio: 1,
    transmission: false,
    transmissionScale: 0.5,
    bloom: true,
    bloomScale: 0.25,
    particles: { near: 120, mid: 600, far: 1200 },
    reflector: false,
    geometryDetail: 0.5,
  },
};

export type Layout = 'desktop' | 'mobile';

/** Mobile = portrait-ish narrow viewport. Re-composed as a vertical poster, not a shrink. */
export function detectLayout(width = window.innerWidth, height = window.innerHeight): Layout {
  return width < 720 || (width < 900 && height > width * 1.2) ? 'mobile' : 'desktop';
}

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function defaultQuality(layout: Layout): QualityName {
  return layout === 'mobile' ? 'medium' : 'high';
}

/**
 * Dev / comparison URL options (documented in README). None of them alter production durations
 * or write fake records.
 *   ?preview=complete  play the M10 completion set-piece on load (no record write)
 *   ?preview=intro     (default behaviour is intro anyway; kept for symmetry)
 *   ?speed=60          test clock: elapsed real time is multiplied (1 real s = 60 timer s). Marked in UI.
 *   ?quality=high|medium|low
 *   ?pose=idle|focus|shortBreak|longBreak|paused   jump the VISUAL pose (timer state untouched)
 *   ?nointro=1         skip the intro (for static screenshots)
 *   ?reduce=1          force reduced-motion behaviour
 *   ?storage=session   use an in-memory store (never persists) - for QA runs
 *   ?fps=1             show an fps meter
 */
export interface UrlOptions {
  preview?: 'complete' | 'intro';
  speed?: number;
  quality?: QualityName;
  pose?: PoseKey | 'paused';
  nointro?: boolean;
  reduce?: boolean;
  storage?: 'local' | 'session' | 'memory';
  fps?: boolean;
}

export function parseUrlOptions(search: string = typeof location !== 'undefined' ? location.search : ''): UrlOptions {
  const q = new URLSearchParams(search);
  const o: UrlOptions = {};
  const preview = q.get('preview');
  if (preview === 'complete' || preview === 'intro') o.preview = preview;
  const speed = Number(q.get('speed'));
  if (Number.isFinite(speed) && speed > 0 && speed <= 3600) o.speed = speed;
  const quality = q.get('quality');
  if (quality === 'ultra' || quality === 'high' || quality === 'medium' || quality === 'low') o.quality = quality;
  const pose = q.get('pose');
  if (pose === 'idle' || pose === 'focus' || pose === 'shortBreak' || pose === 'longBreak' || pose === 'paused') o.pose = pose;
  if (q.get('nointro') === '1') o.nointro = true;
  if (q.get('reduce') === '1') o.reduce = true;
  const storage = q.get('storage');
  if (storage === 'local' || storage === 'session' || storage === 'memory') o.storage = storage;
  if (q.get('fps') === '1') o.fps = true;
  return o;
}
