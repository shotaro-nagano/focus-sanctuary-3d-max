// ---------------------------------------------------------------------------
// SceneParams: THE single tweenable parameter set that drives the 3D scene.
// Owned by motion/Director (GSAP tweens write here). Read by scene/Stage every
// frame. Never tween scene objects directly; tween these numbers.
// ---------------------------------------------------------------------------

export type PoseKey = 'idle' | 'focus' | 'shortBreak' | 'longBreak';

export interface SceneParams {
  // ---- form (sculpture) ----
  /** 0 = sealed cocoon, 1 = petals fully spread (long break), up to 1.35 during M10 burst */
  shellOpen: number;
  /** vertex-shader twist about Y (rad at the poles). Focus progress winds it 0.35 -> 0.95; M10 unwinds to -0.4 */
  shellTwist: number;
  /** amplitude of the slow "liquid" ripple on chrome (0..1). 0 when paused */
  shellBreath: number;
  /** door petal extra vertical hinge 0..1 (0 = closed, 1 = 90deg) */
  doorSwing: number;
  /** keel ribs splay outward 0..1 (M10) */
  keelSplay: number;
  /** polar hubs lift apart 0..1 (M10) */
  hubLift: number;
  /** extra helix turns of the glass sashes (0.2 .. 2.0) */
  ribbonTwist: number;
  /** helix radius multiplier (0.45 .. 2.2). > ~1.2 = sashes pass out through the seams */
  ribbonSpread: number;
  /** draw-on reveal of the ribbons along their length 0..1 (intro) */
  ribbonReveal: number;
  /** emissive intensity of the core filament / rings / point light (0..3) */
  coreGlow: number;
  /** uniform scale of the crystal core group (0.5 .. 1.6) */
  coreScale: number;
  /** accent colour ramp: 0 citron -> 1 ice -> 2 warm */
  accentHue: number;
  /** 0 = arcs scattered at native tilts, 1 = aligned gyroscope (focus) */
  orbitTilt: number;
  /** arcs fly-in 0..1 (intro); 0 = parked outside the frame */
  orbitReveal: number;
  /** smoothed focus progress 0..1 (seam light height, progress arc clip, core swell) */
  progress: number;
  /** multiplier for the seam light intensity (0..2) */
  seamLight: number;
  /** expanding shockwave ring 0..1 (M10) */
  shockwave: number;

  // ---- world ----
  /** master multiplier for sceneTime accumulation; 0 = frozen with phase kept */
  timeScale: number;
  /** particle radial field: +1 pulls to core, -1 blows out, 0 free flow */
  attract: number;
  /** speed of light bands along ribbon edges & mid particle stream (0..6) */
  flowSpeed: number;
  /** amplitude of the large-scale chrome surface noise (0..1.6); 1.6 in the macro shot */
  liquidAmp: number;
  /** fresnel rim strength on chrome (0..2) */
  rimIntensity: number;
  /** extra env-map rotation (rad) - slides reflections across the chrome */
  envRotation: number;
  /** slide of the RectAreaLight strip along x (-1..1) */
  lightSlide: number;
  /** particle overall opacity 0..1 (intro fade-in) */
  particleAlpha: number;
  /** floor reflection / contact shadow presence 0..1 */
  floorPresence: number;

  // ---- post ----
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  desaturate: number;
  vignette: number;
  aberration: number;
  grain: number;
  exposure: number;

  // ---- camera rig (orbit around camTarget) ----
  camDolly: number;
  /** yaw in degrees */
  camYaw: number;
  /** pitch in degrees */
  camPitch: number;
  camFov: number;
  camTargetX: number;
  camTargetY: number;
  camTargetZ: number;
  /** 0..1 how much pointer parallax / drag is applied (timelines ramp this) */
  pointerWeight: number;

  // ---- sculpture placement ----
  rootX: number;
  rootY: number;
  /** extra tilt (deg) of the sculpture toward the camera (mobile poster) */
  rootTilt: number;
  /** uniform scale of the whole sculpture */
  rootScale: number;
}

export const DEFAULT_PARAMS: SceneParams = {
  shellOpen: 0.22,
  shellTwist: 0.15,
  shellBreath: 0.6,
  doorSwing: 0,
  keelSplay: 0,
  hubLift: 0,
  ribbonTwist: 1.0,
  ribbonSpread: 0.9,
  ribbonReveal: 1,
  coreGlow: 0.8,
  coreScale: 0.9,
  accentHue: 0.3,
  orbitTilt: 0,
  orbitReveal: 1,
  progress: 0,
  seamLight: 1,
  shockwave: 0,

  timeScale: 1,
  attract: 0,
  flowSpeed: 1,
  liquidAmp: 1.0,
  rimIntensity: 0.35,
  envRotation: 0,
  lightSlide: 0,
  particleAlpha: 1,
  floorPresence: 1,

  bloomStrength: 0.38,
  bloomThreshold: 1.25,
  bloomRadius: 0.42,
  desaturate: 0,
  vignette: 0.35,
  aberration: 0.0025,
  grain: 0.03,
  exposure: 1.0,

  camDolly: 5.2,
  camYaw: -18,
  camPitch: 8,
  camFov: 32,
  camTargetX: 0.35,
  camTargetY: 0.05,
  camTargetZ: 0,
  pointerWeight: 1,

  rootX: 0.9,
  rootY: 0,
  rootTilt: 0,
  rootScale: 1,
};

/** Form + light pose per timer state (layout independent). Camera lives in CAMERA_POSES. */
export const FORM_POSES: Record<PoseKey, Partial<SceneParams>> = {
  idle: {
    shellOpen: 0.22, shellTwist: 0.15, shellBreath: 0.6, doorSwing: 0, keelSplay: 0, hubLift: 0,
    ribbonTwist: 1.0, ribbonSpread: 0.9, coreGlow: 0.8, coreScale: 0.9, accentHue: 0.3,
    orbitTilt: 0, seamLight: 1, timeScale: 1, attract: 0, flowSpeed: 1, liquidAmp: 1.0,
    rimIntensity: 0.35, bloomStrength: 0.38, bloomThreshold: 1.25, desaturate: 0, vignette: 0.35,
  },
  focus: {
    shellOpen: 0.06, shellTwist: 0.35, shellBreath: 0.5, doorSwing: 0, keelSplay: 0, hubLift: 0,
    ribbonTwist: 1.6, ribbonSpread: 0.7, coreGlow: 1.5, coreScale: 0.8, accentHue: 0,
    orbitTilt: 1, seamLight: 1, timeScale: 1, attract: 0, flowSpeed: 1.6, liquidAmp: 0.8,
    rimIntensity: 0.35, bloomStrength: 0.38, bloomThreshold: 1.25, desaturate: 0, vignette: 0.35,
  },
  shortBreak: {
    shellOpen: 0.55, shellTwist: 0, shellBreath: 0.7, doorSwing: 0.25, keelSplay: 0, hubLift: 0,
    ribbonTwist: 0.6, ribbonSpread: 1.25, coreGlow: 0.9, coreScale: 1.0, accentHue: 1,
    orbitTilt: 0.4, seamLight: 0.6, timeScale: 0.8, attract: 0, flowSpeed: 0.7, liquidAmp: 1.0,
    rimIntensity: 0.4, bloomStrength: 0.34, bloomThreshold: 1.25, desaturate: 0, vignette: 0.32,
  },
  longBreak: {
    shellOpen: 1.0, shellTwist: -0.2, shellBreath: 0.8, doorSwing: 0.66, keelSplay: 0, hubLift: 0,
    ribbonTwist: 0.3, ribbonSpread: 1.6, coreGlow: 0.8, coreScale: 1.15, accentHue: 2,
    orbitTilt: 0.2, seamLight: 0.5, timeScale: 0.6, attract: 0, flowSpeed: 0.5, liquidAmp: 0.7,
    rimIntensity: 0.4, bloomStrength: 0.34, bloomThreshold: 1.25, desaturate: 0, vignette: 0.3,
  },
};

/** Overlay applied while paused (M08). Restored on resume (M09). Form fields are untouched. */
export const PAUSE_OVERLAY: Partial<SceneParams> = {
  timeScale: 0, shellBreath: 0, flowSpeed: 0, liquidAmp: 0.15, rimIntensity: 0.55,
  bloomStrength: 0.24, desaturate: 0.25, vignette: 0.45,
};

export type CameraPose = Pick<
  SceneParams,
  'camDolly' | 'camYaw' | 'camPitch' | 'camFov' | 'camTargetX' | 'camTargetY' | 'camTargetZ' | 'rootX' | 'rootY' | 'rootTilt' | 'rootScale'
>;

export const CAMERA_POSES: Record<'desktop' | 'mobile', Record<PoseKey, CameraPose>> = {
  desktop: {
    idle:       { camDolly: 5.2, camYaw: -18, camPitch: 8,  camFov: 32, camTargetX: 0.35, camTargetY: 0.05, camTargetZ: 0, rootX: 0.9, rootY: 0, rootTilt: 0, rootScale: 1 },
    focus:      { camDolly: 4.4, camYaw: 24,  camPitch: -4, camFov: 32, camTargetX: 0.35, camTargetY: 0.15, camTargetZ: 0, rootX: 0.9, rootY: 0, rootTilt: 0, rootScale: 1 },
    shortBreak: { camDolly: 5.6, camYaw: -40, camPitch: 14, camFov: 32, camTargetX: 0.35, camTargetY: 0.05, camTargetZ: 0, rootX: 0.9, rootY: 0, rootTilt: 0, rootScale: 1 },
    longBreak:  { camDolly: 7.0, camYaw: -65, camPitch: 18, camFov: 32, camTargetX: 0.35, camTargetY: 0.0,  camTargetZ: 0, rootX: 0.9, rootY: 0, rootTilt: 0, rootScale: 1 },
  },
  mobile: {
    idle:       { camDolly: 6.4, camYaw: -28, camPitch: 12, camFov: 46, camTargetX: 0, camTargetY: 0.35, camTargetZ: 0, rootX: 0, rootY: 0.2, rootTilt: 6, rootScale: 1 },
    focus:      { camDolly: 5.6, camYaw: 20,  camPitch: 4,  camFov: 46, camTargetX: 0, camTargetY: 0.35, camTargetZ: 0, rootX: 0, rootY: 0.2, rootTilt: 6, rootScale: 1 },
    shortBreak: { camDolly: 6.8, camYaw: -45, camPitch: 14, camFov: 46, camTargetX: 0, camTargetY: 0.35, camTargetZ: 0, rootX: 0, rootY: 0.2, rootTilt: 6, rootScale: 1 },
    longBreak:  { camDolly: 8.2, camYaw: -65, camPitch: 16, camFov: 46, camTargetX: 0, camTargetY: 0.3,  camTargetZ: 0, rootX: 0, rootY: 0.2, rootTilt: 6, rootScale: 1 },
  },
};

/** Accent colour ramp used by scene + UI. accentHue 0..2. */
export const ACCENT_STOPS = ['#D9FF62', '#BFE9FF', '#FFD2A8'] as const;

export function clonePose(base: SceneParams, ...layers: Partial<SceneParams>[]): SceneParams {
  return Object.assign({}, base, ...layers);
}

/** Runtime (non-tweened) inputs passed to the scene each frame. Smoothed by the Director. */
export interface RuntimeInput {
  /** smoothed pointer -1..1 (x right, y up); 0,0 when no pointer */
  pointerX: number;
  pointerY: number;
  /** drag orbit offsets applied to the sculpture root (degrees), spring-returned by the Director */
  dragYaw: number;
  dragPitch: number;
  /** 0..1 decaying pulse from a UI press (M11 scene response) */
  pressPulse: number;
  /** current layout */
  layout: 'desktop' | 'mobile';
}
