// Focus Sanctuary — 3D MAX EDITION · bootstrap / integration.
// Wires: timer engine (state) -> MotionDirector (SceneParams + GSAP) -> Stage (three.js) + UI (DOM).
import './styles/fonts.css';
import './styles/main.css';

import { DURATIONS, LONG_BREAK_EVERY, QUALITY, STORAGE_KEY, defaultQuality, detectLayout, parseUrlOptions, type Layout, type QualityName } from './config';
import { createClock } from './timer/clock';
import { createStorage } from './timer/storage';
import { createTimerEngine } from './timer/engine';
import type { Mode, TimerEvent, TimerSnapshot } from './timer/types';
import type { PoseKey } from './shared/params';
import { createUI } from './ui/App';
import { MotionDirector } from './motion/Director';
import { PointerController } from './motion/pointer';
import { Stage } from './scene/Stage';

const opts = parseUrlOptions();

// ---------------------------------------------------------------------------
// Timer (state) — production durations are constants; ?speed only accelerates the clock for testing.
// ---------------------------------------------------------------------------
const clock = createClock(opts.speed ?? 1);
// A test clock (?speed=N) never writes real records unless storage is chosen explicitly.
const storage = createStorage(opts.storage ?? (opts.speed && opts.speed !== 1 ? 'memory' : 'local'), STORAGE_KEY);
const engine = createTimerEngine({ clock, storage, durations: DURATIONS, longBreakEvery: LONG_BREAK_EVERY });

// ---------------------------------------------------------------------------
// Layout / quality
// ---------------------------------------------------------------------------
let layout: Layout = detectLayout();
let qualityName: QualityName = opts.quality ?? defaultQuality(layout);
const reducedMotion = opts.reduce === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function poseFor(snap: TimerSnapshot): PoseKey {
  if (snap.mode === 'short') return 'shortBreak';
  if (snap.mode === 'long') return 'longBreak';
  return snap.status === 'idle' ? 'idle' : 'focus';
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
let director: MotionDirector;
let stage: Stage | null = null;

const ui = createUI({
  onStart: () => {
    const snap = engine.getSnapshot();
    if (snap.status !== 'idle') return;
    engine.start();
  },
  onPause: () => engine.pause(),
  onResume: () => engine.resume(),
  onReset: async () => {
    const snap = engine.getSnapshot();
    if (snap.status === 'idle') {
      engine.reset();
      return;
    }
    const ok = await ui.confirm('Discard the running session? Nothing will be recorded.');
    if (ok) engine.reset();
  },
  onMode: async (mode: Mode) => {
    const snap = engine.getSnapshot();
    if (snap.mode === mode && snap.status === 'idle') return;
    if (snap.status !== 'idle') {
      const ok = await ui.confirm('Switch mode and discard the running session?');
      if (!ok) return;
    }
    engine.setMode(mode);
  },
  onReplay: () => {
    if (director.locked) return;
    const snap = engine.getSnapshot();
    void director.replay(poseFor(snap));
  },
  onTask: (text: string) => engine.setTask(text),
});
ui.setLayout(layout);
// the stylesheet is applied once this module runs: lift the critical-CSS curtain (index.html keeps the page black until then)
ui.el.root.classList.add('is-ready');

// ---------------------------------------------------------------------------
// Motion director (owns SceneParams + all GSAP timelines)
// ---------------------------------------------------------------------------
director = new MotionDirector({
  ui,
  layout: () => layout,
  reducedMotion,
  quality: () => (qualityName === 'ultra' ? 'high' : qualityName),
});

// ---------------------------------------------------------------------------
// Stage (three.js). If WebGL is unavailable the timer keeps working with the static fallback.
// ---------------------------------------------------------------------------
const canvas = ui.el.canvas;
let webglOk = Stage.isSupported();
if (webglOk) {
  try {
    stage = new Stage(canvas, {
      quality: QUALITY[qualityName],
      layout,
      onContextLost: () => {
        ui.showFallback('contextlost', 'The graphics context was lost. Waiting for the browser to restore it… the timer keeps running.');
      },
      onContextRestored: () => {
        ui.showFallback(null);
      },
    });
  } catch (err) {
    console.error('[stage] failed to start WebGL', err);
    stage = null;
    webglOk = false;
  }
}
if (!webglOk) {
  ui.showFallback('nowebgl', 'WebGL could not start in this browser, so the sculpture cannot be rendered. The timer works normally.');
} else if (reducedMotion) {
  ui.showFallback('reduced', 'Reduced motion is on: the sculpture holds a still composition with short transitions.');
  window.setTimeout(() => ui.showFallback(null), 2400);
}

// ---------------------------------------------------------------------------
// Pointer / drag (M04 / M05) — never starts on [data-ui] elements
// ---------------------------------------------------------------------------
const pointer = new PointerController({
  element: ui.el.stage,
  ignoreSelector: '[data-ui]',
  onPointer: (x, y) => director.setPointer(x, y),
  onDrag: (dx, dy) => director.dragBy(dx, dy),
  onDragEnd: () => director.endDrag(),
  onTap: () => director.onPress(),
  onLongPress: () => {
    /* handled visually via drag/press; long-press macro is optional */
  },
});

// UI presses answer in the scene (M11)
ui.el.root.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('button')) director.onPress();
  },
  { passive: true },
);

// ---------------------------------------------------------------------------
// Timer events -> UI + motion
// ---------------------------------------------------------------------------
let lastSnap: TimerSnapshot = engine.getSnapshot();
// A session that completed while the tab was away is delivered as `restore{completedWhileAway}` followed by a
// completion event. The record is already written; we do not replay the M10 set-piece on boot for it.
let suppressBootCompletion = false;

function applySnapshot(snap: TimerSnapshot): void {
  lastSnap = snap;
  ui.setSnapshot(snap);
  director.setProgress(snap.status === 'idle' ? 0 : snap.progress);
  ui.setMicro(2, `ORBIT C — ${Math.round(snap.progress * 100)}%`);
}

engine.on((e: TimerEvent) => {
  switch (e.type) {
    case 'tick':
      applySnapshot(e.snap);
      break;
    case 'start':
      applySnapshot(e.snap);
      director.onStart();
      break;
    case 'pause':
      applySnapshot(e.snap);
      director.onPause();
      break;
    case 'resume':
      applySnapshot(e.snap);
      director.onResume();
      break;
    case 'reset':
      applySnapshot(e.snap);
      director.toPose(poseFor(e.snap));
      break;
    case 'modeChange':
      applySnapshot(e.snap);
      director.toPose(poseFor(e.snap));
      break;
    case 'focusComplete':
      // Record already written by the engine (exactly once). Play the set-piece; end in the break pose.
      applySnapshot(e.snap);
      if (suppressBootCompletion) {
        suppressBootCompletion = false;
        director.toPose(poseFor(e.snap), { immediate: true });
      } else {
        void director.playComplete(poseFor(e.snap), { preview: false });
      }
      break;
    case 'breakComplete':
      applySnapshot(e.snap);
      if (suppressBootCompletion) {
        suppressBootCompletion = false;
        director.toPose(poseFor(e.snap), { immediate: true });
      } else {
        director.toPose(poseFor(e.snap));
      }
      break;
    case 'restore':
      applySnapshot(e.snap);
      if (e.completedWhileAway) suppressBootCompletion = true;
      break;
    case 'storageError':
      applySnapshot(e.snap);
      ui.showStorageNote('Storage unavailable — this session is kept in memory only.');
      break;
    case 'task':
      applySnapshot(e.snap);
      break;
  }
});

applySnapshot(lastSnap);
if (!lastSnap.storageOk) ui.showStorageNote('Storage unavailable — this session is kept in memory only.');

// ---------------------------------------------------------------------------
// Boot choreography
// ---------------------------------------------------------------------------
const initialPose: PoseKey = opts.pose && opts.pose !== 'paused' ? opts.pose : poseFor(lastSnap);

async function boot(): Promise<void> {
  if (opts.nointro || reducedMotion) {
    director.toPose(initialPose, { immediate: true });
  } else {
    await director.playIntro(initialPose);
  }
  // A session restored in the paused state (or ?pose=paused) needs the frozen overlay.
  if (opts.pose === 'paused' || engine.getSnapshot().status === 'paused') director.onPause();
  if (opts.preview === 'complete') {
    // Visual preview only: no timer state or record is touched.
    const next: PoseKey = lastSnap.completedFocusCount % LONG_BREAK_EVERY === LONG_BREAK_EVERY - 1 ? 'longBreak' : 'shortBreak';
    if (!opts.nointro) await new Promise((r) => window.setTimeout(r, 600));
    await director.playComplete(next, { preview: true });
  }
}
void boot();

// ---------------------------------------------------------------------------
// Resize / layout
// ---------------------------------------------------------------------------
let resizeTimer = 0;
function doResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const nextLayout = detectLayout(w, h);
  if (nextLayout !== layout) {
    layout = nextLayout;
    ui.setLayout(layout);
    if (!opts.quality) {
      qualityName = defaultQuality(layout);
      stage?.setQuality(QUALITY[qualityName]);
    }
    stage?.setLayout(layout);
    director.relayout();
  }
  ui.setMicro(3, `${w} × ${h}`);
  stage?.resize(w, h, Math.min(window.devicePixelRatio || 1, QUALITY[qualityName].maxPixelRatio));
}
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(doResize, 120);
});
doResize();

// ---------------------------------------------------------------------------
// Visibility: stop rendering when hidden; reconcile time + pose when back
// ---------------------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  const hidden = document.hidden;
  stage?.setPaused(hidden);
  if (!hidden) {
    engine.tick();
    lastFrame = performance.now();
  }
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let lastFrame = performance.now();
let tickAccumulator = 0;
let fpsAccum = 0;
let fpsFrames = 0;
declare global {
  interface Window {
    __fps?: number;
    __fs?: { engine: typeof engine; director: MotionDirector; stage: Stage | null };
  }
}
window.__fs = { engine, director, stage };

let fpsEl: HTMLElement | null = null;
if (opts.fps) {
  fpsEl = document.createElement('div');
  fpsEl.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);font:11px monospace;color:#D9FF62;z-index:99;pointer-events:none;letter-spacing:.1em';
  document.body.appendChild(fpsEl);
}

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  tickAccumulator += dt;
  if (tickAccumulator >= 0.2) {
    tickAccumulator = 0;
    engine.tick();
  }

  director.update(dt);

  if (stage && !document.hidden) {
    stage.render(director.params, director.input, dt);
    if (layout === 'mobile') {
      // vertical poster: the big digits sit in the clear band between the sculpture zone and the console sheet
      const consoleTop = ui.el.consoleEl.getBoundingClientRect().top;
      ui.setTimerAnchor(window.innerWidth * 0.5, Math.min(window.innerHeight * 0.66, consoleTop - 70), true);
    } else {
      const anchor = stage.project('cleft');
      ui.setTimerAnchor(anchor.x, anchor.y, anchor.visible);
    }
  }

  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.5) {
    const fps = fpsFrames / fpsAccum;
    window.__fps = Math.round(fps);
    if (fpsEl) {
      const s = stage?.getStats();
      fpsEl.textContent = `${Math.round(fps)} FPS · ${s ? `${s.drawCalls} calls · ${Math.round(s.triangles / 1000)}k tris` : 'no gl'} · ${qualityName}`;
    }
    fpsAccum = 0;
    fpsFrames = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
