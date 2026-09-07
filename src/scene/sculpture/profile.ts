// Lathe profile shared by the shell, keel, glass band and crystal core (ART_PLAN §Geometry 1, 6).
// Units: sculpture height 3.2 centred on the origin, y up. v in [0,1] runs bottom -> top.
import { Vector3 } from 'three';
import { clamp01, DEG } from '../../shared/math';

export const SHELL_HEIGHT = 3.2;
export const SHELL_HALF = SHELL_HEIGHT / 2;
/** helical seam shear (radians over the full height) */
export const SEAM_SHEAR = 0.45;

/** y of the profile at v */
export const shellY = (v: number): number => -SHELL_HALF + SHELL_HEIGHT * v;

/** outer radius r(v): bulge at v = 0.443 (bottom-heavy), broad shoulder instead of an egg */
export function shellR(v: number): number {
  const s = Math.sin(Math.PI * Math.pow(clamp01(v), 0.85));
  return 1.1 * Math.pow(Math.max(s, 0), 0.7);
}

/** wall thickness t(v) (+ per-petal delta): thick at the equator, thin at the poles */
export function shellT(v: number, delta = 0): number {
  return 0.07 + 0.09 * Math.pow(1 - Math.abs(2 * clamp01(v) - 1), 1.4) + delta;
}

/** seam-sheared angle: the seams are helices, not meridians */
export const shearedTheta = (theta: number, v: number): number => theta + SEAM_SHEAR * (v - 0.5);

/**
 * Point on the thick shell. w = 0 outer surface, w = 1 inner surface.
 * theta in radians (un-sheared petal angle), v in [0,1].
 */
export function shellPoint(theta: number, v: number, w: number, delta: number, out: Vector3): Vector3 {
  const rr = shellR(v) - w * shellT(v, delta);
  const th = shearedTheta(theta, v);
  return out.set(rr * Math.cos(th), shellY(v), rr * Math.sin(th));
}

/** six-sided crystal core profile rc(v) over height 0.9 */
export function coreR(v: number): number {
  const a = Math.abs(2 * clamp01(v) - 1);
  return 0.19 * Math.pow(Math.max(1 - Math.pow(a, 2.2), 0), 0.6);
}
export const CORE_HEIGHT = 0.9;

/** petal spans in degrees (4-degree seam gaps) and their thickness delta / opening weight */
export interface PetalDef {
  th0: number;
  th1: number;
  delta: number;
  openWeight: number;
}
export const PETALS: readonly PetalDef[] = [
  { th0: 0, th1: 96, delta: 0.02, openWeight: 1.0 },
  { th0: 100, th1: 178, delta: -0.01, openWeight: 0.55 },
  { th0: 182, th1: 242, delta: 0.03, openWeight: 0.8 },
  { th0: 246, th1: 330, delta: 0, openWeight: 0.35 },
  { th0: 334, th1: 376, delta: -0.02, openWeight: 0.7 },
];
export const DOOR_PETAL = 4;
export const CLEFT_PETAL = 2;

/** top edge of the cleft petal: a diagonal bite from v 0.52 (at 182deg) to 0.82 (at 242deg) */
export function cleftTop(thetaDeg: number): number {
  return 0.52 + 0.3 * clamp01((thetaDeg - 182) / 60);
}

/** equatorial slit */
export const SLIT_V0 = 0.56;
export const SLIT_V1 = 0.63;
/** shell v extent */
export const SHELL_V0 = 0.03;
export const SHELL_V1 = 0.97;

export const petalMidAngle = (p: PetalDef): number => ((p.th0 + p.th1) * 0.5) * DEG;
