// ---------------------------------------------------------------------------
// MotionDirector - the single writer of SceneParams.
//
// Owns every GSAP timeline (intro M01, mode morphs M06/M07, pause M08/M09,
// completion M10, press accents M11) plus the per-frame springs (pointer
// parallax, drag orbit, press pulse, progress smoothing, env-rotation drift).
// The Stage only reads `params` / `input`; the timer engine is never touched.
// ---------------------------------------------------------------------------

import { gsap } from 'gsap';
import type { SceneParams, RuntimeInput, PoseKey, CameraPose } from '../shared/params';
import { DEFAULT_PARAMS, FORM_POSES, CAMERA_POSES, PAUSE_OVERLAY, clonePose } from '../shared/params';
import { clamp, clamp01, lerp, damp, DEG, TAU } from '../shared/math';
import type { UI } from '../ui/types';
import { revealWord, hideWord, swapWord, assembleDigits, bandWipe, setWordText } from '../ui/typography';

export interface DirectorOptions {
  ui: UI;
  layout: () => 'desktop' | 'mobile';
  reducedMotion: boolean;
  /** 'high' etc. - director may lower bloom on 'low' */
  quality: () => 'high' | 'medium' | 'low';
}

type ParamKey = keyof SceneParams;

/** the big back-layer word per pose (M12 swaps) */
const WORDS: Record<PoseKey, string> = { idle: 'FOCUS', focus: 'FOCUS', shortBreak: 'BREATHE', longBreak: 'RELEASE' };
/** M06 morph durations (s) */
const POSE_DURATION: Record<PoseKey, number> = { idle: 1.2, focus: 1.2, shortBreak: 1.4, longBreak: 1.6 };
/** env-map sweep per pose change (deg) so the strip reflections travel with the morph */
const POSE_ENV_SWEEP: Record<PoseKey, number> = { idle: 20, focus: 32, shortBreak: -26, longBreak: -40 };

const PAUSE_KEYS = Object.keys(PAUSE_OVERLAY) as ParamKey[];

// drag orbit
const DRAG_DEG_PER_PX = 0.25;
const DRAG_YAW_MAX = 40;
const DRAG_PITCH_MAX = 15;
/** release spring: omega / zeta tuned for ~1.6 s settle with a ~20% overshoot */
const SPRING_OMEGA = 5.5;
const SPRING_ZETA = 0.45;
const SPRING_MAX_STEP = 1 / 60;

// smoothing
const POINTER_LAMBDA = 6;
const DRAG_FOLLOW_LAMBDA = 20;
const PRESS_LAMBDA = 8;
const PROGRESS_LAMBDA = 1 / 0.5;
/** env-map drift (deg/s of sceneTime) + pointer nudge (deg at pointerX = +-1) */
const ENV_DRIFT_DEG_PER_S = 0.5;
const ENV_POINTER_DEG = 6;

const MACRO_DOLLY = 2.6;
const PAUSE_DOLLY_MUL = 0.94;
const PAUSE_PITCH_ADD = 3;
const PAUSE_GLOW_MUL = 0.6;
const LOW_QUALITY_BLOOM_MUL = 0.75;

export class MotionDirector {
  readonly params: SceneParams;
  readonly input: RuntimeInput;

  private readonly opts: DirectorOptions;
  private readonly ui: UI;
  private disposed = false;

  private _pose: PoseKey = 'idle';
  private _locked = false;

  // env rotation = tweened base + sceneTime drift + pointer nudge
  private readonly env = { base: 0 };
  private envDrift = 0;

  // pointer
  private pointerTargetX = 0;
  private pointerTargetY = 0;

  // drag orbit (raw accumulation while dragging, spring on release)
  private dragging = false;
  private dragRawYaw = 0;
  private dragRawPitch = 0;
  private dragVelYaw = 0;
  private dragVelPitch = 0;

  // progress
  private progressTarget = 0;

  // mode morph
  private poseTween: gsap.core.Tween | null = null;
  private currentWord = 'FOCUS';
  /** M07 ignition accents (killed when a new start / lock arrives) */
  private ignition: gsap.core.Timeline | null = null;
  /** env-map base sweep (tracked so the base can be wrapped between sweeps) */
  private envTween: gsap.core.Tween | null = null;

  // set-pieces (intro / complete) - exclusive lock + FIFO of pending set-pieces
  private setPiece: gsap.core.Timeline | null = null;
  private setPieceResolve: (() => void) | null = null;
  private readonly pendingSetPieces: { build: () => gsap.core.Timeline; resolve: () => void }[] = [];
  private queuedPose: PoseKey | null = null;
  private relayoutPending = false;

  // pause overlay
  private pauseActive = false;
  private pauseTweens: gsap.core.Tween[] = [];

  // mobile long-press macro
  private macroActive = false;

  /** accent tweens + lazily created DOM timelines, killed on lock / dispose */
  private readonly live = new Set<gsap.core.Animation>();

  constructor(opts: DirectorOptions) {
    this.opts = opts;
    this.ui = opts.ui;
    this.params = clonePose(DEFAULT_PARAMS);
    this.input = { pointerX: 0, pointerY: 0, dragYaw: 0, dragPitch: 0, pressPulse: 0, layout: opts.layout() };
    // boot in the idle pose for the current layout (intro / ?pose overrides follow)
    Object.assign(this.params, this.poseTarget('idle'));
    if (opts.reducedMotion) this.params.timeScale = 0.15;
  }

  get pose(): PoseKey {
    return this._pose;
  }

  get locked(): boolean {
    return this._locked;
  }

  /** true while the M06 morph tween is running (a fully overwritten tween never completes, so ask GSAP) */
  private get poseTweenActive(): boolean {
    return this.poseTween !== null && this.poseTween.isActive();
  }

  // =========================================================================
  // per-frame
  // =========================================================================

  update(dt: number): void {
    if (this.disposed) return;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    const p = this.params;
    const input = this.input;
    input.layout = this.opts.layout();

    // pointer parallax (smoothed toward the raw pointer, or back to centre when it left)
    input.pointerX = damp(input.pointerX, this.pointerTargetX, POINTER_LAMBDA, dt);
    input.pointerY = damp(input.pointerY, this.pointerTargetY, POINTER_LAMBDA, dt);

    this.stepDrag(dt);

    // M11 press pulse decay
    input.pressPulse = damp(input.pressPulse, 0, PRESS_LAMBDA, dt);
    if (input.pressPulse < 1e-3) input.pressPulse = 0;

    // progress smoothing (the completion timeline owns `progress` while locked)
    if (!this._locked) p.progress = damp(p.progress, this.progressTarget, PROGRESS_LAMBDA, dt);

    // focus: the stored twist winds and the core swells with progress
    if (this._pose === 'focus' && !this._locked && !this.poseTweenActive) {
      p.shellTwist = lerp(0.35, 0.95, p.progress);
      p.coreScale = lerp(0.8, 1.15, p.progress);
    }

    // env-map rotation: tweened base + slow drift (follows sceneTime so pause freezes it) + pointer nudge
    this.envDrift = (this.envDrift + dt * p.timeScale * ENV_DRIFT_DEG_PER_S * DEG) % TAU;
    if (this.envTween === null && !this._locked && Math.abs(this.env.base) > TAU) this.env.base %= TAU;
    p.envRotation = this.env.base + this.envDrift + ENV_POINTER_DEG * DEG * input.pointerX * p.pointerWeight;
  }

  private stepDrag(dt: number): void {
    const input = this.input;
    if (this.dragging) {
      const ny = damp(input.dragYaw, this.dragRawYaw, DRAG_FOLLOW_LAMBDA, dt);
      const np = damp(input.dragPitch, this.dragRawPitch, DRAG_FOLLOW_LAMBDA, dt);
      this.dragVelYaw = (ny - input.dragYaw) / dt;
      this.dragVelPitch = (np - input.dragPitch) / dt;
      input.dragYaw = ny;
      input.dragPitch = np;
      return;
    }
    if (input.dragYaw === 0 && input.dragPitch === 0 && this.dragVelYaw === 0 && this.dragVelPitch === 0) return;

    // damped spring back to 0 with momentum carried from the drag (semi-implicit Euler, sub-stepped)
    let remaining = dt;
    let y = input.dragYaw;
    let vy = this.dragVelYaw;
    let pt = input.dragPitch;
    let vp = this.dragVelPitch;
    const w2 = SPRING_OMEGA * SPRING_OMEGA;
    const c = 2 * SPRING_ZETA * SPRING_OMEGA;
    while (remaining > 0) {
      const h = Math.min(remaining, SPRING_MAX_STEP);
      remaining -= h;
      vy += (-w2 * y - c * vy) * h;
      y += vy * h;
      vp += (-w2 * pt - c * vp) * h;
      pt += vp * h;
    }
    if (Math.abs(y) < 0.02 && Math.abs(vy) < 0.05 && Math.abs(pt) < 0.02 && Math.abs(vp) < 0.05) {
      y = 0; vy = 0; pt = 0; vp = 0;
    }
    input.dragYaw = clamp(y, -DRAG_YAW_MAX * 1.3, DRAG_YAW_MAX * 1.3);
    input.dragPitch = clamp(pt, -DRAG_PITCH_MAX * 1.3, DRAG_PITCH_MAX * 1.3);
    this.dragVelYaw = vy;
    this.dragVelPitch = vp;
  }

  // =========================================================================
  // inputs
  // =========================================================================

  setPointer(x: number | null, y: number | null): void {
    if (x === null || y === null) {
      this.pointerTargetX = 0;
      this.pointerTargetY = 0;
      return;
    }
    this.pointerTargetX = clamp(x, -1, 1);
    this.pointerTargetY = clamp(y, -1, 1);
  }

  dragBy(dxPx: number, dyPx: number): void {
    if (!this.dragging) {
      this.dragging = true;
      // continue from wherever the spring left the sculpture
      this.dragRawYaw = this.input.dragYaw;
      this.dragRawPitch = this.input.dragPitch;
    }
    this.dragRawYaw = clamp(this.dragRawYaw + dxPx * DRAG_DEG_PER_PX, -DRAG_YAW_MAX, DRAG_YAW_MAX);
    this.dragRawPitch = clamp(this.dragRawPitch + dyPx * DRAG_DEG_PER_PX, -DRAG_PITCH_MAX, DRAG_PITCH_MAX);
  }

  endDrag(): void {
    this.dragging = false;
    this.dragRawYaw = 0;
    this.dragRawPitch = 0;
  }

  setProgress(p: number): void {
    this.progressTarget = Number.isFinite(p) ? clamp01(p) : 0;
  }

  // =========================================================================
  // pose targets
  // =========================================================================

  private cameraTarget(pose: PoseKey): CameraPose {
    return CAMERA_POSES[this.opts.layout()][pose];
  }

  /** bloom strength for the current quality preset (the 'low' preset runs bloom at quarter res: keep it tame) */
  private bloom(v: number): number {
    return this.opts.quality() === 'low' ? v * LOW_QUALITY_BLOOM_MUL : v;
  }

  /** form + camera target for a pose (progress-derived fields, reduced-motion and quality applied) */
  private poseTarget(pose: PoseKey): Partial<SceneParams> {
    const t: Partial<SceneParams> = { ...FORM_POSES[pose], ...this.cameraTarget(pose) };
    if (pose === 'focus') {
      t.shellTwist = lerp(0.35, 0.95, this.progressTarget);
      t.coreScale = lerp(0.8, 1.15, this.progressTarget);
    }
    if (this.opts.reducedMotion) t.timeScale = 0.15;
    if (t.bloomStrength !== undefined) t.bloomStrength = this.bloom(t.bloomStrength);
    return t;
  }

  /** PAUSE_OVERLAY + dimmed core + camera creep for the given pose */
  private pauseTarget(pose: PoseKey): Partial<SceneParams> {
    const cam = this.cameraTarget(pose);
    const t: Partial<SceneParams> = {
      ...PAUSE_OVERLAY,
      coreGlow: (FORM_POSES[pose].coreGlow ?? DEFAULT_PARAMS.coreGlow) * PAUSE_GLOW_MUL,
      camDolly: cam.camDolly * PAUSE_DOLLY_MUL,
      camPitch: cam.camPitch + PAUSE_PITCH_ADD,
    };
    if (t.bloomStrength !== undefined) t.bloomStrength = this.bloom(t.bloomStrength);
    return t;
  }

  private omit(target: Partial<SceneParams>, keys: readonly ParamKey[]): Partial<SceneParams> {
    const out: Partial<SceneParams> = { ...target };
    for (const k of keys) delete out[k];
    return out;
  }

  // =========================================================================
  // M06 / M07 - poses
  // =========================================================================

  toPose(pose: PoseKey, opts?: { duration?: number; immediate?: boolean }): void {
    this.toPoseInternal(pose, opts ?? {});
  }

  private toPoseInternal(
    pose: PoseKey,
    opts: { duration?: number; immediate?: boolean; exclude?: readonly ParamKey[] },
  ): void {
    if (this.disposed) return;
    if (this._locked) {
      this.queuedPose = pose;
      return;
    }
    const samePose = pose === this._pose;
    // A pause survives only an immediate same-pose re-apply (relayout); any real pose change ends it.
    const keepPause = this.pauseActive && samePose && opts.immediate === true;
    if (!keepPause) this.clearPause();
    this._pose = pose;

    let target = this.poseTarget(pose);
    if (keepPause) target = { ...target, ...this.pauseTarget(pose) };
    if (this.macroActive) target.camDolly = MACRO_DOLLY;
    if (opts.exclude) target = this.omit(target, opts.exclude);

    const duration = opts.immediate ? 0 : opts.duration ?? (this.opts.reducedMotion ? 0.4 : POSE_DURATION[pose]);

    if (duration <= 0) {
      this.killPoseTween();
      this.killIgnition();
      gsap.killTweensOf(this.params);
      Object.assign(this.params, target);
      // the strip light is only ever moved by accents (M07 sweep / M11 nudge) that were just killed: park it
      this.params.lightSlide = 0;
      this.setWordNow(WORDS[pose]);
      return;
    }

    this.killPoseTween();
    const tween = gsap.to(this.params, {
      ...target,
      duration,
      ease: 'power3.inOut',
      overwrite: 'auto',
      onComplete: () => {
        if (this.poseTween === tween) this.poseTween = null;
      },
    });
    this.poseTween = tween;
    this.sweepEnv(POSE_ENV_SWEEP[pose], duration, 'power2.inOut');
    this.swapWordTo(WORDS[pose], Math.min(0.6, duration * 0.5));
  }

  private killPoseTween(): void {
    this.poseTween?.kill();
    this.poseTween = null;
  }

  private killIgnition(): void {
    if (!this.ignition) return;
    this.ignition.kill();
    this.ignition = null;
    // a sweep cut off mid-flight must not strand the strip light off-centre; callers that snap the
    // params right after (immediate pose, set-piece start states) kill this tween again and park it themselves
    gsap.to(this.params, { lightSlide: 0, duration: 0.3, ease: 'power2.out', overwrite: 'auto' });
  }

  /** M07 - focus start: toPose('focus') plus the ignition accents */
  onStart(): void {
    if (this.disposed) return;
    if (this._locked) {
      this.queuedPose = 'focus';
      return;
    }
    const ignited: ParamKey[] = ['coreGlow', 'shellBreath', 'seamLight', 'orbitTilt'];
    this.toPoseInternal('focus', { exclude: this.opts.reducedMotion ? undefined : ignited });
    if (this.opts.reducedMotion) return;

    this.killIgnition();
    const p = this.params;
    const t = this.poseTarget('focus');
    const tl = gsap.timeline({
      defaults: { overwrite: 'auto' },
      onComplete: () => {
        if (this.ignition === tl) this.ignition = null;
      },
    });
    // core ignition: spike then settle on the focus glow
    tl.to(p, { coreGlow: 3.0, duration: 0.1, ease: 'power2.in' }, 0);
    tl.to(p, { coreGlow: t.coreGlow ?? 2.4, duration: 0.25, ease: 'power2.out' }, 0.1);
    // strip light sweeps across the body once
    tl.fromTo(p, { lightSlide: -1 }, { lightSlide: 1, duration: 1.0, ease: 'sine.inOut' }, 0);
    tl.to(p, { lightSlide: 0, duration: 0.6, ease: 'power2.out' }, 1.0);
    // chrome breath pulse
    tl.to(p, { shellBreath: 1.1, duration: 0.15, ease: 'power2.out' }, 0.05);
    tl.to(p, { shellBreath: t.shellBreath ?? 0.5, duration: 0.6, ease: 'power2.inOut' }, 0.2);
    // seam light draws on, arcs snap into the gyroscope with a mechanical overshoot
    tl.set(p, { seamLight: 0 }, 0);
    tl.to(p, { seamLight: t.seamLight ?? 1, duration: 0.9, ease: 'power2.out' }, 0.15);
    tl.to(p, { orbitTilt: t.orbitTilt ?? 1, duration: 1.2, ease: 'back.out(1.6)' }, 0.1);
    this.ignition = tl;
  }

  private sweepEnv(deg: number, duration: number, ease: string): void {
    this.envTween?.kill();
    const tween = gsap.to(this.env, {
      base: this.env.base + deg * DEG,
      duration,
      ease,
      overwrite: 'auto',
      onComplete: () => {
        if (this.envTween === tween) this.envTween = null;
      },
    });
    this.envTween = tween;
  }

  // =========================================================================
  // M08 / M09 - pause / resume
  // =========================================================================

  onPause(): void {
    if (this.disposed) return;
    this.pauseActive = true;
    if (this._locked) return; // applied when the set-piece releases
    this.applyPauseOverlay(this.opts.reducedMotion ? 0.4 : 1.4);
  }

  onResume(): void {
    if (this.disposed) return;
    this.pauseActive = false;
    if (this._locked) return;
    this.killPauseTweens();
    const p = this.params;
    const t = this.poseTarget(this._pose);
    const cam = this.cameraTarget(this._pose);
    const restore: Partial<SceneParams> = {};
    for (const k of PAUSE_KEYS) if (k !== 'timeScale' && t[k] !== undefined) restore[k] = t[k];
    restore.coreGlow = t.coreGlow;
    const d = this.opts.reducedMotion ? 0.3 : 0.9;
    this.pauseTweens = [
      gsap.to(p, { ...restore, duration: d, ease: 'power2.out', overwrite: 'auto' }),
      // time re-accelerates from the frozen phase (sceneTime accumulates with timeScale)
      gsap.to(p, { timeScale: t.timeScale ?? 1, duration: d, ease: 'power2.in', overwrite: 'auto' }),
      gsap.to(p, {
        camDolly: this.macroActive ? MACRO_DOLLY : cam.camDolly,
        camPitch: cam.camPitch,
        duration: d,
        ease: 'power2.inOut',
        overwrite: 'auto',
      }),
    ];
  }

  private applyPauseOverlay(duration: number): void {
    this.killPauseTweens();
    const p = this.params;
    const t = this.pauseTarget(this._pose);
    const { camDolly, camPitch, ...overlay } = t;
    this.pauseTweens = [
      gsap.to(p, { ...overlay, duration, ease: 'power3.out', overwrite: 'auto' }),
      // slow creep: the camera settles closer and slightly higher while time is frozen
      gsap.to(p, {
        camDolly: this.macroActive ? MACRO_DOLLY : camDolly,
        camPitch,
        duration: this.opts.reducedMotion ? 0.4 : 6,
        ease: 'power1.out',
        overwrite: 'auto',
      }),
    ];
  }

  private killPauseTweens(): void {
    for (const t of this.pauseTweens) t.kill();
    this.pauseTweens = [];
  }

  private clearPause(): void {
    this.pauseActive = false;
    this.killPauseTweens();
  }

  // =========================================================================
  // set-piece plumbing (exclusive lock, queue, promise chain)
  // =========================================================================

  /**
   * Starts a set-piece synchronously when the stage is free (so `locked` is true the moment
   * playIntro / playComplete return and a pose requested right after is queued, never fought).
   * A set-piece requested while one is running starts right after it, with the lock held across.
   */
  private runSetPiece(build: () => gsap.core.Timeline): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      this.pendingSetPieces.push({ build, resolve });
      if (!this._locked) this.startNextSetPiece();
    });
  }

  private startNextSetPiece(): void {
    const next = this.pendingSetPieces.shift();
    if (!next) return;
    this.beginLock();
    this.setPieceResolve = next.resolve;
    try {
      this.setPiece = next.build();
    } catch (err) {
      // a DOM exception inside a builder must never leave the stage locked and the promise pending
      console.error('[director] set-piece failed to build', err);
      this.setPiece = null;
      this.finishSetPiece();
    }
  }

  private beginLock(): void {
    if (!this._locked) {
      this._locked = true;
      this.ui.setInteractionLock(true);
    }
    this.killPoseTween();
    this.killIgnition();
    this.killPauseTweens();
    this.killLive();
    this.envTween?.kill();
    this.envTween = null;
    gsap.killTweensOf(this.params);
    gsap.killTweensOf(this.env);
  }

  private finishSetPiece(): void {
    this.setPiece = null;
    const resolve = this.setPieceResolve;
    this.setPieceResolve = null;
    if (!this.disposed && this.pendingSetPieces.length > 0) {
      // another set-piece is waiting: keep the lock (and the queued pose) and roll straight into it
      resolve?.();
      this.startNextSetPiece();
      return;
    }
    this._locked = false;
    if (!this.disposed) {
      this.ui.setInteractionLock(false);
      if (this.relayoutPending) {
        this.relayoutPending = false;
        Object.assign(this.params, this.cameraTarget(this._pose));
      }
      if (this.queuedPose !== null) {
        const q = this.queuedPose;
        this.queuedPose = null;
        this.toPoseInternal(q, {});
      } else if (this.pauseActive) {
        this.applyPauseOverlay(this.opts.reducedMotion ? 0.4 : 1.4);
      }
    }
    resolve?.();
  }

  // =========================================================================
  // M01 - intro / replay
  // =========================================================================

  playIntro(pose: PoseKey): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.queuedPose = null; // the request carries newer truth than anything queued before it
    return this.runSetPiece(() => (this.opts.reducedMotion ? this.buildReducedIntro(pose) : this.buildIntro(pose, false)));
  }

  replay(pose: PoseKey): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.queuedPose = null;
    return this.runSetPiece(() => (this.opts.reducedMotion ? this.buildReducedIntro(pose) : this.buildIntro(pose, true)));
  }

  private buildIntro(pose: PoseKey, reapply: boolean): gsap.core.Timeline {
    const p = this.params;
    const el = this.ui.el;
    this._pose = pose;
    const target = this.poseTarget(pose);
    const rootX = target.rootX ?? 0;
    const rootY = target.rootY ?? 0;

    // ---- t = 0: MACRO. Camera 2 units outside the shell, framing the polished seam lip between petals 2 and 3
    // (world angle ~128deg for ROOT_BASE_YAW): ~1 unit of chrome fills the frame, the seam leaks a little citron.
    Object.assign(p, target);
    Object.assign(p, {
      camDolly: 1.15, camYaw: -38, camPitch: 4, camFov: 28,
      camTargetX: rootX - 0.68, camTargetY: rootY + 0.05, camTargetZ: 0.86,
      shellOpen: 0.08, coreGlow: 0.3, orbitReveal: 0, ribbonReveal: 0, ribbonSpread: 0.6,
      liquidAmp: 1.6, rimIntensity: 0.5, particleAlpha: 0, floorPresence: 0, pointerWeight: 0,
      bloomStrength: this.bloom(0.15),
      timeScale: 0, shockwave: 0, attract: 0, lightSlide: 0, seamLight: target.seamLight ?? 1,
    } satisfies Partial<SceneParams>);
    this.env.base = 0;
    this.envDrift = 0;

    // DOM start state: words / digits / console hidden until their beats.
    // The console's lock shade (UI-owned, driven by `.is-locked`) is never touched, and on a
    // REPLAY the exact readout stays visible: a session may be running and its time must stay verifiable.
    this.setWordNow(WORDS[pose]);
    this.hideNow(el.wordFocus);
    this.hideNow(el.wordSanctuary);
    this.hideNow(el.timerFloat);
    this.hideBanner();
    const consoleChildren = this.consoleBlocks(reapply);
    gsap.set(consoleChildren, { opacity: 0, y: 6 });

    const tl = gsap.timeline({ defaults: { overwrite: 'auto' }, onComplete: () => this.finishSetPiece() });

    // ---- 0.00-0.50 MACRO: a white bar slides across the cap lip
    tl.addLabel('macro', 0);
    tl.to(this.env, { base: `+=${12 * DEG}`, duration: 0.5, ease: 'sine.inOut' }, 0);
    tl.to(this.env, { base: `+=${30 * DEG}`, duration: 2.0, ease: 'power2.out' }, 0.5);

    // ---- 0.50-2.20 REVEAL: dolly out along an eased pseudo-curve (each axis on its own ease/duration)
    tl.addLabel('reveal', 0.5);
    tl.to(p, { camDolly: target.camDolly, duration: 1.5, ease: 'power3.inOut' }, 0.5);
    tl.to(p, { camYaw: target.camYaw, duration: 1.7, ease: 'power2.inOut' }, 0.5);
    tl.to(p, { camPitch: target.camPitch, duration: 1.4, ease: 'sine.inOut' }, 0.6);
    tl.to(p, { camFov: target.camFov, duration: 1.5, ease: 'power2.inOut' }, 0.5);
    tl.to(p, {
      camTargetX: target.camTargetX, camTargetY: target.camTargetY, camTargetZ: target.camTargetZ,
      duration: 1.5, ease: 'power3.inOut',
    }, 0.5);
    tl.to(p, { shellOpen: target.shellOpen, duration: 1.1, ease: 'back.out(1.4)' }, 0.5);
    tl.to(p, { coreGlow: target.coreGlow, duration: 0.8, ease: 'power2.out' }, 0.9);
    tl.to(p, { bloomStrength: target.bloomStrength ?? this.bloom(0.38), duration: 1.0, ease: 'power2.inOut' }, 0.9);
    tl.to(p, { ribbonReveal: 1, duration: 1.2, ease: 'power2.inOut' }, 0.6);
    tl.to(p, { ribbonSpread: target.ribbonSpread, duration: 1.2, ease: 'power2.inOut' }, 0.6);
    tl.to(p, { liquidAmp: target.liquidAmp, duration: 1.3, ease: 'power2.inOut' }, 0.5);
    tl.to(p, { rimIntensity: target.rimIntensity, duration: 1.5, ease: 'power2.inOut' }, 0.5);
    tl.to(p, { timeScale: target.timeScale, duration: 1.0, ease: 'power1.inOut' }, 0.5);
    tl.to(p, { floorPresence: 1, duration: 1.2, ease: 'power2.inOut' }, 1.0);
    tl.to(p, { particleAlpha: 1, duration: 1.2, ease: 'power2.inOut' }, 1.2);

    // ---- 1.00-2.10 TYPE: FOCUS rises behind the canvas, SANCTUARY slides in across the lower body
    tl.addLabel('type', 1.0);
    tl.call(() => {
      this.showNow(el.wordFocus);
      this.track(revealWord(el.wordFocus, { stagger: 0.045, skew: 6, from: 'bottom', duration: 0.9 }));
    }, [], 1.0);
    tl.call(() => {
      this.showNow(el.wordSanctuary);
      // mobile centres the word with `translateX(-50%)` in the stylesheet: state the percent explicitly so
      // GSAP never has to guess it from a fractional width (it would otherwise drop it for the slide)
      const xPercent = this.opts.layout() === 'mobile' ? -50 : 0;
      this.track(gsap.fromTo(el.wordSanctuary, { x: 48, xPercent }, {
        x: 0, xPercent, duration: 1.1, ease: 'power3.out', clearProps: 'transform',
      }));
      this.track(revealWord(el.wordSanctuary, { stagger: 0.03, skew: 0, from: 'bottom', duration: 0.8 }));
    }, [], 1.4);

    // ---- 1.80-3.00 MECHANISM: arcs fly in, digits assemble, console settles, pointer weight returns
    tl.addLabel('mechanism', 1.8);
    tl.to(p, { orbitReveal: 1, duration: 0.45, ease: 'expo.out' }, 1.8);
    tl.call(() => {
      this.showNow(el.timerFloat);
      this.track(assembleDigits(el.timerFloatDigits, { stagger: 0.03 }));
      this.track(assembleDigits(el.timerExact, { stagger: 0.03 }));
    }, [], 1.8);
    tl.call(() => {
      this.track(gsap.fromTo(consoleChildren, { y: 6, opacity: 0 }, {
        y: 0, opacity: 1, duration: 0.6, stagger: 0.06, ease: 'power3.out', clearProps: 'transform,opacity',
      }));
    }, [], 1.9);
    tl.to(p, { pointerWeight: 1, duration: 0.5, ease: 'power2.inOut' }, 2.5);
    tl.addLabel('settled', 3.0);

    if (reapply) {
      // REPLAY: return to the live pose / progress (values may have drifted while the intro ran)
      tl.call(() => {
        const live = this.poseTarget(this._pose);
        if (this.macroActive) live.camDolly = MACRO_DOLLY;
        this.track(gsap.to(p, { ...live, duration: 0.6, ease: 'power2.inOut', overwrite: 'auto' }));
      }, [], 3.0);
      tl.to({}, { duration: 0.6 }, 3.0); // hold the lock until the re-apply has landed
    }
    return tl;
  }

  private buildReducedIntro(pose: PoseKey): gsap.core.Timeline {
    const p = this.params;
    const el = this.ui.el;
    this._pose = pose;
    Object.assign(p, this.poseTarget(pose));
    Object.assign(p, {
      orbitReveal: 1, ribbonReveal: 1, particleAlpha: 1, floorPresence: 1, pointerWeight: 1, shockwave: 0, attract: 0, lightSlide: 0,
    } satisfies Partial<SceneParams>);
    this.setWordNow(WORDS[pose]);
    this.showNow(el.wordFocus);
    this.showNow(el.wordSanctuary);
    this.showNow(el.timerFloat);
    this.hideBanner();
    const tl = gsap.timeline({ onComplete: () => this.finishSetPiece() });
    tl.fromTo([el.wordFocus, el.wordSanctuary, el.timerFloat, el.consoleEl], { opacity: 0 }, {
      opacity: 1, duration: 0.3, ease: 'power1.out', clearProps: 'opacity',
    }, 0);
    return tl;
  }

  // =========================================================================
  // M10 - completion
  // =========================================================================

  playComplete(nextPose: PoseKey, opts?: { preview?: boolean }): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const preview = opts?.preview === true;
    this.queuedPose = null;
    return this.runSetPiece(() => (this.opts.reducedMotion ? this.buildReducedComplete(nextPose, preview) : this.buildComplete(nextPose, preview)));
  }

  private buildComplete(nextPose: PoseKey, preview: boolean): gsap.core.Timeline {
    const p = this.params;
    const el = this.ui.el;
    this.clearPause();
    const next = this.poseTarget(nextPose);
    const nextCam = this.cameraTarget(nextPose);
    const startDolly = p.camDolly;
    const lines = el.completeLines;
    this.hideBanner(); // park both lines (a boot without the intro never parked them)

    const tl = gsap.timeline({ defaults: { overwrite: 'auto' }, onComplete: () => this.finishSetPiece() });

    // ---- 0.00-0.60 CONVERGE: everything inhales toward the core; the vault seals for the first time
    tl.addLabel('converge', 0);
    tl.to(p, { pointerWeight: 0, duration: 0.3, ease: 'power2.out' }, 0);
    tl.to(p, { attract: 1, duration: 0.6, ease: 'power2.in' }, 0);
    tl.to(p, { flowSpeed: 6, duration: 0.5, ease: 'power2.in' }, 0);
    tl.to(p, { shellOpen: 0, duration: 0.55, ease: 'power3.inOut' }, 0);
    tl.to(p, { ribbonSpread: 0.45, duration: 0.6, ease: 'power2.inOut' }, 0);
    tl.to(p, { coreGlow: 0.3, duration: 0.5, ease: 'power2.out' }, 0);
    tl.to(p, { coreScale: 0.5, duration: 0.6, ease: 'power2.inOut' }, 0);
    tl.to(p, { timeScale: 0.35, duration: 0.6, ease: 'power2.out' }, 0);
    tl.to(p, { camDolly: startDolly * 0.82, duration: 0.58, ease: 'power2.inOut' }, 0);
    tl.to(p, { bloomStrength: this.bloom(0.3), duration: 0.5, ease: 'power2.out' }, 0);
    tl.to(p, { lightSlide: 0, duration: 0.3, ease: 'power2.out' }, 0); // an interrupted M07 sweep parks the strip
    tl.to(p, { progress: 0, duration: 0.35, ease: 'power3.in' }, 0.25); // the progress arc clips back to a point
    // the big digits collapse to 00:00 (what the user just watched land) and re-form at the TYPE beat
    tl.call(() => setWordText(el.timerFloatDigits, '00:00'), [], 0);

    // ---- 0.60-1.80 RELEASE: the stored twist unwinds first, then the shell bursts (per-petal stagger is in the scene)
    tl.addLabel('release', 0.6);
    tl.to(p, { shellTwist: -0.4, duration: 1.0, ease: 'expo.out' }, 0.5);
    tl.to(p, { shellOpen: 1.35, duration: 0.9, ease: 'back.out(1.7)' }, 0.6);
    tl.to(p, { doorSwing: 1, duration: 0.7, ease: 'back.out(1.4)' }, 0.62);
    tl.to(p, { hubLift: 1, duration: 0.8, ease: 'power3.out' }, 0.65);
    tl.to(p, { keelSplay: 1, duration: 0.8, ease: 'power3.out' }, 0.68);
    tl.to(p, { ribbonSpread: 2.2, duration: 1.0, ease: 'power3.out' }, 0.7);
    tl.to(p, { ribbonTwist: 0.2, duration: 1.0, ease: 'power2.out' }, 0.7);
    tl.to(p, { coreScale: 1.6, duration: 1.0, ease: 'elastic.out(1, 0.5)' }, 0.7);
    tl.to(p, { coreGlow: 3.0, duration: 0.4, ease: 'expo.out' }, 0.85);
    tl.fromTo(p, { shockwave: 0 }, { shockwave: 1, duration: 0.6, ease: 'power2.out' }, 0.9);
    tl.to(p, { attract: -0.6, duration: 0.4, ease: 'power2.out' }, 0.9);
    tl.to(p, { camDolly: startDolly + 3.4, duration: 1.2, ease: 'power2.inOut' }, 0.6);
    tl.to(p, { camYaw: '+=50', duration: 1.2, ease: 'power2.inOut' }, 0.6);
    tl.to(p, { camPitch: '+=6', duration: 1.2, ease: 'sine.inOut' }, 0.6);
    tl.to(p, { bloomStrength: this.bloom(0.62), duration: 0.2, ease: 'power2.out' }, 0.85);
    tl.to(this.env, { base: `+=${40 * DEG}`, duration: 1.4, ease: 'power2.inOut' }, 0.6);

    // ---- 1.20-2.60 TYPE: FOCUS band-wipes out, SESSION / COMPLETE reveal, digits re-form
    tl.addLabel('type', 1.2);
    tl.call(() => this.track(bandWipe(el.wordFocus, { bands: 3, direction: 'out' })), [], 1.2);
    // the floating digits step aside while the banner owns the centre; they re-form at the 1.9 s beat
    tl.call(() => this.hideNow(el.timerFloat), [], 1.15);
    tl.call(() => {
      this.showBanner();
      if (lines[0]) this.track(revealWord(lines[0], { stagger: 0.03, skew: 4, from: 'bottom', duration: 0.6 }));
    }, [], 1.4);
    tl.call(() => {
      if (lines[1]) this.track(revealWord(lines[1], { stagger: 0.03, skew: 4, from: 'bottom', duration: 0.6 }));
    }, [], 1.55);
    if (!preview) tl.call(() => this.ui.pulseRecord(), [], 1.6);
    tl.call(() => {
      // main.ts already wrote the next mode's duration to the exact readout on focusComplete (the UI keeps
      // both readouts split-safe via setWordText); copy it into the float digits and re-form them
      const nextClock = this.readoutText();
      if (nextClock) setWordText(el.timerFloatDigits, nextClock);
      this.showNow(el.timerFloat);
      this.track(assembleDigits(el.timerFloatDigits, { stagger: 0.03 }));
      this.track(assembleDigits(el.timerExact, { stagger: 0.03 }));
    }, [], 1.9);

    // ---- 2.20-4.00 RE-CONSTITUTE: elastic settle into the break pose and its camera
    tl.addLabel('reconstitute', 2.2);
    tl.to(p, { shockwave: 0, duration: 0.3, ease: 'power2.out' }, 2.2);
    tl.to(p, { attract: 0, duration: 0.8, ease: 'power2.out' }, 2.2);
    tl.to(p, { bloomStrength: next.bloomStrength ?? 0.5, duration: 0.7, ease: 'power2.out' }, 2.2);
    tl.to(p, {
      shellOpen: next.shellOpen, shellTwist: next.shellTwist, doorSwing: next.doorSwing, hubLift: next.hubLift,
      keelSplay: next.keelSplay, ribbonSpread: next.ribbonSpread, ribbonTwist: next.ribbonTwist,
      coreScale: next.coreScale, coreGlow: next.coreGlow,
      duration: 1.6, ease: 'elastic.out(1, 0.6)',
    }, 2.2);
    tl.to(p, {
      shellBreath: next.shellBreath, accentHue: next.accentHue, orbitTilt: next.orbitTilt, seamLight: next.seamLight,
      timeScale: next.timeScale, flowSpeed: next.flowSpeed, liquidAmp: next.liquidAmp, rimIntensity: next.rimIntensity,
      bloomThreshold: next.bloomThreshold, desaturate: next.desaturate, vignette: next.vignette,
      duration: 1.2, ease: 'power2.inOut',
    }, 2.2);
    tl.to(p, {
      camDolly: nextCam.camDolly, camYaw: nextCam.camYaw, camPitch: nextCam.camPitch, camFov: nextCam.camFov,
      camTargetX: nextCam.camTargetX, camTargetY: nextCam.camTargetY, camTargetZ: nextCam.camTargetZ,
      rootX: nextCam.rootX, rootY: nextCam.rootY, rootTilt: nextCam.rootTilt, rootScale: nextCam.rootScale,
      duration: 1.6, ease: 'power3.inOut',
    }, 2.2);
    tl.to(this.env, { base: `+=${-12 * DEG}`, duration: 1.6, ease: 'power2.inOut' }, 2.2);
    tl.call(() => {
      this.currentWord = WORDS[nextPose];
      setWordText(el.wordFocus, this.currentWord);
    }, [], 2.3);
    tl.call(() => this.track(bandWipe(el.wordFocus, { bands: 3, direction: 'in' })), [], 2.45);
    tl.call(() => {
      if (lines[0]) this.track(hideWord(lines[0], { stagger: 0.02, to: 'top', duration: 0.4 }));
      if (lines[1]) this.track(hideWord(lines[1], { stagger: 0.02, to: 'top', duration: 0.4 }));
    }, [], 3.0);
    tl.call(() => this.hideBanner(), [], 3.6);
    tl.to(p, { pointerWeight: 1, duration: 0.5, ease: 'power2.inOut' }, 3.5);
    tl.call(() => {
      this._pose = nextPose;
      p.progress = this.progressTarget;
    }, [], 4.0);
    return tl;
  }

  private buildReducedComplete(nextPose: PoseKey, preview: boolean): gsap.core.Timeline {
    const p = this.params;
    const el = this.ui.el;
    this.clearPause();
    this._pose = nextPose;
    Object.assign(p, this.poseTarget(nextPose));
    Object.assign(p, { shockwave: 0, attract: 0, pointerWeight: 1, lightSlide: 0 } satisfies Partial<SceneParams>);
    p.progress = this.progressTarget;
    this.currentWord = WORDS[nextPose];
    setWordText(el.wordFocus, this.currentWord);
    this.showBanner(0);
    for (const line of el.completeLines) line.classList.remove('is-word-hidden');

    const tl = gsap.timeline({ onComplete: () => this.finishSetPiece() });
    tl.to(el.completeBanner, { opacity: 1, duration: 0.3, ease: 'power1.out' }, 0);
    if (!preview) tl.call(() => this.ui.pulseRecord(), [], 0.3);
    tl.to(el.completeBanner, { opacity: 0, duration: 0.3, ease: 'power1.in' }, 1.8);
    tl.call(() => this.hideBanner(), [], 2.1);
    return tl;
  }

  // =========================================================================
  // M11 - press / tap / macro
  // =========================================================================

  onPress(): void {
    if (this.disposed) return;
    this.input.pressPulse = 1;
    if (this.opts.reducedMotion || this._locked || this.poseTweenActive || this.pauseActive) return;
    const p = this.params;
    const t = this.poseTarget(this._pose);
    // overwrite:'auto' so a rapid second press takes over the pulse instead of fighting it
    const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
    tl.to(p, { shellBreath: (t.shellBreath ?? p.shellBreath) + 0.3, duration: 0.1, ease: 'power2.out' }, 0);
    tl.to(p, { shellBreath: t.shellBreath ?? p.shellBreath, duration: 0.15, ease: 'power2.inOut' }, 0.1);
    tl.to(p, { lightSlide: 0.2, duration: 0.12, ease: 'power2.out' }, 0);
    tl.to(p, { lightSlide: 0, duration: 0.45, ease: 'power2.inOut' }, 0.12);
    this.track(tl);
  }

  /** mobile tap on the sculpture: 0.4 s breath burst + core flash (extension, wired by main.ts to PointerController.onTap) */
  onTap(): void {
    if (this.disposed) return;
    this.input.pressPulse = 1;
    if (this.opts.reducedMotion || this._locked || this.poseTweenActive || this.pauseActive) return;
    const p = this.params;
    const t = this.poseTarget(this._pose);
    const glow = t.coreGlow ?? p.coreGlow;
    const breath = t.shellBreath ?? p.shellBreath;
    const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
    tl.to(p, { coreGlow: Math.min(3, glow * 1.6 + 0.5), duration: 0.12, ease: 'power2.out' }, 0);
    tl.to(p, { coreGlow: glow, duration: 0.28, ease: 'power2.inOut' }, 0.12);
    tl.to(p, { shellBreath: breath + 0.4, duration: 0.14, ease: 'power2.out' }, 0);
    tl.to(p, { shellBreath: breath, duration: 0.26, ease: 'power2.inOut' }, 0.14);
    this.track(tl);
  }

  /** mobile long-press: camera dollies into the cleft (macro) while held, springs back on release (extension) */
  setMacro(active: boolean): void {
    if (this.disposed || this.macroActive === active) return;
    this.macroActive = active;
    if (this._locked) return;
    const p = this.params;
    if (active) {
      this.track(gsap.to(p, { camDolly: MACRO_DOLLY, duration: 0.8, ease: 'power3.inOut', overwrite: 'auto' }));
    } else {
      const cam = this.cameraTarget(this._pose);
      const dolly = this.pauseActive ? cam.camDolly * PAUSE_DOLLY_MUL : cam.camDolly;
      this.track(gsap.to(p, { camDolly: dolly, duration: 1.2, ease: 'back.out(1.2)', overwrite: 'auto' }));
    }
  }

  // =========================================================================
  // layout
  // =========================================================================

  /** re-apply the camera pose for the (new) layout smoothly; main.ts calls this (or toPose immediate) after resize */
  relayout(): void {
    if (this.disposed) return;
    if (this._locked) {
      this.relayoutPending = true;
      return;
    }
    const cam: Partial<SceneParams> = { ...this.cameraTarget(this._pose) };
    if (this.pauseActive) {
      cam.camDolly = (cam.camDolly ?? DEFAULT_PARAMS.camDolly) * PAUSE_DOLLY_MUL;
      cam.camPitch = (cam.camPitch ?? DEFAULT_PARAMS.camPitch) + PAUSE_PITCH_ADD;
    }
    if (this.macroActive) cam.camDolly = MACRO_DOLLY;
    this.track(gsap.to(this.params, { ...cam, duration: this.opts.reducedMotion ? 0.3 : 0.6, ease: 'power2.inOut', overwrite: 'auto' }));
  }

  // =========================================================================
  // DOM helpers (typography)
  // =========================================================================

  private swapWordTo(next: string, duration: number): void {
    if (next === this.currentWord) return;
    this.currentWord = next;
    if (this.opts.reducedMotion) {
      setWordText(this.ui.el.wordFocus, next);
      return;
    }
    this.track(swapWord(this.ui.el.wordFocus, next, { stagger: 0.03, duration }));
  }

  private setWordNow(next: string): void {
    this.currentWord = next;
    setWordText(this.ui.el.wordFocus, next);
  }

  /** the exact readout's current text (UI-owned truth), split structure and nbsp tolerated */
  private readoutText(): string {
    return (this.ui.el.timerExact.textContent ?? '').replace(/ /g, ' ').trim();
  }

  /**
   * Console blocks the intro fades in. Skips the UI's lock shade (`.is-locked` drives it) and,
   * on a REPLAY, the readout block so the exact time stays verifiable while a session may be running.
   */
  private consoleBlocks(keepReadout: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const c of Array.from(this.ui.el.consoleEl.children)) {
      if (!(c instanceof HTMLElement)) continue;
      if (c.classList.contains('console-shade')) continue;
      if (keepReadout && c.classList.contains('console-readout')) continue;
      out.push(c);
    }
    return out;
  }

  private hideNow(el: HTMLElement): void {
    gsap.set(el, { visibility: 'hidden' });
  }

  private showNow(el: HTMLElement): void {
    gsap.set(el, { clearProps: 'visibility' });
  }

  /** the M10 banner is gated by `.complete-banner.is-open` (visibility) + opacity in the stylesheet */
  private showBanner(opacity = 1): void {
    const banner = this.ui.el.completeBanner;
    banner.classList.add('is-open');
    gsap.set(banner, { opacity });
  }

  private hideBanner(): void {
    const banner = this.ui.el.completeBanner;
    gsap.killTweensOf(banner);
    gsap.set(banner, { clearProps: 'opacity' });
    banner.classList.remove('is-open');
    // leave the lines parked below their masks so the next reveal starts clean
    for (const line of this.ui.el.completeLines) line.classList.add('is-word-hidden');
  }

  // =========================================================================
  // bookkeeping
  // =========================================================================

  private track<T extends gsap.core.Animation>(anim: T): T {
    // prune finished animations and ones GSAP already killed / auto-removed (parent === null)
    for (const a of this.live) {
      if (!a.isActive() && (a.progress() >= 1 || a.parent === null)) this.live.delete(a);
    }
    this.live.add(anim);
    return anim;
  }

  private killLive(): void {
    for (const a of this.live) a.kill();
    this.live.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setPiece?.kill();
    this.setPiece = null;
    this.killPoseTween();
    this.killIgnition();
    this.killPauseTweens();
    this.killLive();
    this.envTween?.kill();
    this.envTween = null;
    gsap.killTweensOf(this.params);
    gsap.killTweensOf(this.env);
    this._locked = false;
    this.queuedPose = null;
    const resolve = this.setPieceResolve;
    this.setPieceResolve = null;
    resolve?.();
    // never leave a caller awaiting a set-piece that will not run
    const pending = this.pendingSetPieces.splice(0, this.pendingSetPieces.length);
    for (const item of pending) item.resolve();
  }
}
