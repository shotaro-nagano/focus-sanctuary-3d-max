// The sculpture: assembles shell, keel, glass sashes, crystal core and orbit fragments under one root.
// Root placement (rootX/Y, tilt, idle sway, drag) is applied by Stage; this class owns the internal mechanism.
import { Group, type Material, type Object3D } from 'three';
import type { QualityPreset } from '../../config';
import type { SceneParams } from '../../shared/params';
import { clamp01, lerp, smoothstep } from '../../shared/math';
import type { MaterialSet } from '../materials';
import { buildCore, type Core } from './core';
import { buildKeel, type Keel } from './keel';
import { buildOrbits, type Orbits } from './orbits';
import { buildRibbons, type Ribbons } from './ribbons';
import { buildShell, type Shell } from './shell';

export interface SculptureAnchors {
  core: Object3D;
  cleft: Object3D;
  topHub: Object3D;
  bottomHub: Object3D;
  arcC: Object3D;
}

/** base yaw so the cleft faces front-left in idle and stays in frame in focus (camera yaw +24) */
export const ROOT_BASE_YAW = 2.05;
/**
 * The geometry is built at the plan's 3.2-unit height; the contract camera poses (dolly 5.2, fov 32) see 2.98 units,
 * so the whole sculpture is fitted by this constant to occupy ~92% of the frame height in idle (per the camera plan).
 */
export const SCULPTURE_FIT = 0.86;
export const IDLE_SWAY_AMPLITUDE = 0.42;
export const IDLE_SWAY_PERIOD = 90;
const KEEL_SWAY_PERIOD = 140;

export class Sculpture {
  readonly root = new Group();
  readonly shell: Shell;
  readonly keel: Keel;
  readonly ribbons: Ribbons;
  readonly core: Core;
  readonly orbits: Orbits;
  readonly anchors: SculptureAnchors;
  readonly vertexCount: number;
  /** 0..1 pulse phase accumulated with timeScale so the core visibly keeps time */
  pulsePhase = 0;

  constructor(materials: MaterialSet, preset: QualityPreset) {
    const detail = preset.geometryDetail;
    this.shell = buildShell(materials, detail);
    this.keel = buildKeel(materials, detail);
    this.ribbons = buildRibbons(materials, detail, preset.transmission);
    this.core = buildCore(materials, preset.transmission);
    this.orbits = buildOrbits(materials, detail);
    this.root.name = 'sculpture';
    this.root.scale.setScalar(SCULPTURE_FIT);
    this.root.add(this.shell.group, this.keel.group, this.ribbons.group, this.core.group, this.orbits.group);
    this.anchors = {
      core: this.core.group,
      cleft: this.shell.cleftAnchor,
      topHub: this.shell.hubTop,
      bottomHub: this.shell.hubBottom,
      arcC: this.orbits.arcCTip,
    };
    this.vertexCount = this.shell.vertexCount + this.keel.vertexCount + this.ribbons.vertexCount + this.core.vertexCount + this.orbits.vertexCount;
  }

  /** idle sway (rad) of the whole sculpture about Y, period 90 s */
  static sway(sceneTime: number): number {
    return IDLE_SWAY_AMPLITUDE * Math.sin((Math.PI * 2 * sceneTime) / IDLE_SWAY_PERIOD);
  }

  update(params: SceneParams, sceneTime: number, dt: number): void {
    this.shell.update(params.shellOpen, params.doorSwing, params.hubLift);
    this.keel.update(params.keelSplay);
    this.keel.group.rotation.y = -0.22 * Math.sin((Math.PI * 2 * sceneTime) / KEEL_SWAY_PERIOD);
    this.ribbons.update(params.ribbonTwist, params.ribbonSpread);
    this.ribbons.group.rotation.y = 0.12 * Math.sin(sceneTime * 0.09);
    this.core.update(sceneTime, params.coreScale);
    this.orbits.update(sceneTime, params.orbitTilt, params.orbitReveal, params.progress, params.shockwave);
    // core pulse: 6 s idle -> 1.6..1.0 s in focus (tightening with progress)
    const focusAmount = smoothstep(0.8, 2.0, params.coreGlow);
    const period = lerp(6, lerp(1.6, 1.0, clamp01(params.progress)), focusAmount);
    this.pulsePhase = (this.pulsePhase + (dt * params.timeScale) / period) % 1;
  }

  setGlass(transmission: boolean): void {
    this.ribbons.setGlass(transmission);
    this.core.setGlass(transmission);
  }

  setDebug(material: Material | null): void {
    this.shell.setDebug(material);
    this.keel.setDebug(material);
    this.ribbons.setDebug(material);
    this.core.setDebug(material);
    this.orbits.setDebug(material);
  }

  dispose(): void {
    this.shell.dispose();
    this.keel.dispose();
    this.ribbons.dispose();
    this.core.dispose();
    this.orbits.dispose();
  }
}
