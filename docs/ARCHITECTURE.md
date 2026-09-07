# Focus Sanctuary — 3D MAX EDITION · Architecture & Module Contract

Concept: **CHRONO CHRYSALIS — CLEFT VAULT**. A Pomodoro timer (25 / 5 / 15) whose only visual is a floating sculpture:
a five‑petal vault of liquid chrome with helical seams, a diagonal cleft torn out of one petal, an equatorial slit, three brushed
keel ribs inside, three prism‑glass sashes coiling around a six‑sided glass crystal core with an emissive filament, and a broken halo
of three blade arcs. Obsidian black space. Citron `#D9FF62` accent (ice `#BFE9FF` on short break, warm `#FFD2A8` on long break).

Stack: **Vite 6.4 + TypeScript 5.9 + three 0.185.1 + GSAP 3.15**. Node 18. No React. `npm run dev | build | typecheck | test`.

This document is the contract between parallel implementers. **Do not change exported names/signatures listed here.**
Shared source files that already exist and must be used as-is (extend only by adding, never renaming):

- `src/config.ts` — durations, palette, quality presets, layout detection, URL options.
- `src/shared/params.ts` — `SceneParams`, `DEFAULT_PARAMS`, `FORM_POSES`, `PAUSE_OVERLAY`, `CAMERA_POSES`, `ACCENT_STOPS`, `RuntimeInput`, `PoseKey`.
- `src/shared/math.ts`, `src/shared/events.ts` — helpers.
- `src/timer/types.ts` — timer domain types + `TimerEngine` interface.
- `src/ui/types.ts` — `UI`, `UIElements`, `UIHandlers`.
- `index.html` — the DOM (ids/classes below). UI module may add child elements but must keep every id.

## 1. Module map & owners

| Module | Files | Owner agent |
| --- | --- | --- |
| timer | `src/timer/{clock,storage,dates,engine}.ts`, `src/timer/engine.test.ts` | **timer** |
| scene | `src/scene/Stage.ts`, `src/scene/environment.ts`, `src/scene/materials.ts`, `src/scene/post.ts`, `src/scene/particles.ts`, `src/scene/floor.ts`, `src/scene/sculpture/*.ts`, `src/scene/shaders/*.ts`, dev harness `dev/scene.html` + `src/dev/scene-dev.ts` | **scene** |
| motion | `src/motion/Director.ts`, `src/motion/pointer.ts` | **motion** |
| ui | `src/styles/main.css`, `src/ui/App.ts`, `src/ui/typography.ts`, `src/ui/magnetic.ts`, `src/ui/cursor.ts`, `src/ui/confirm.ts` | **ui** |
| tools | `tools/capture.py`, `tools/README.md` | **tools** |
| integration | `src/main.ts` | integrator (after the above) |

Every agent runs `npx tsc --noEmit -p .` before finishing; the whole tree must type-check (other modules may be missing —
that is fine as long as *your* files compile against the contract types; never import a sibling module that is not yours except
through the interfaces in this document).

## 2. Layering & composition rules (who writes what, every frame)

```
timer engine  ──events──▶  main.ts  ──▶  MotionDirector (owns SceneParams + all GSAP timelines)
                                  └──▶  UI.setSnapshot (text only)
rAF loop (main.ts):
   engine.tick()                         // completion detection (also on visibilitychange)
   director.update(dt)                   // springs (pointer/drag), progress smoothing, pause overlay, queued poses
   stage.render(director.params, director.input, dt)   // scene reads params; accumulates sceneTime += dt * params.timeScale
   ui.setTimerAnchor(...stage.project('cleft'))       // DOM follows 3D
```

- **Single writer**: only `MotionDirector` mutates `SceneParams`. Scene never tweens anything itself; all cyclic motion in the scene
  reads `sceneTime` (accumulated with `params.timeScale`) so pause freezes phase and resume continues seamlessly (M08/M09).
- **Camera** = pose (camDolly/camYaw/camPitch/camFov/camTarget) → then pointer parallax (`input.pointerX/Y * params.pointerWeight`: yaw ±3°, pitch ±1.5°, target ±0.08) applied **inside Stage**. Drag (`input.dragYaw/dragPitch`) rotates the **sculpture root**, not the camera.
- **Timelines** (intro / complete) take an exclusive lock in the Director. A pose change requested while locked is queued and applied when the lock releases (never dropped, never fights). Mode tweens use `overwrite: 'auto'` on the params object.
- Progress: `director.setProgress(p)` sets a target; `update()` damps `params.progress` toward it (τ ≈ 0.5 s). While the pose is `focus`, the Director also derives `shellTwist = lerp(0.35, 0.95, progress)` and `coreScale = lerp(0.8, 1.15, progress)` (unless a timeline is running).
- Pause overlay: on pause the Director tweens the `PAUSE_OVERLAY` fields (1.4 s power3.out); on resume it tweens them back to the current pose values (0.9 s). Form fields untouched.
- Reduced motion (`prefers-reduced-motion` or `?reduce=1`): Director skips intro/complete choreography (jump-cuts with 0.3 s fades), sets `timeScale` 0.15, keeps a static beautiful pose. Scene still renders real 3D.

## 3. Scene contract (`src/scene/Stage.ts`)

```ts
import type { SceneParams, RuntimeInput } from '../shared/params';
import type { QualityPreset } from '../config';

export type WorldAnchor = 'core' | 'cleft' | 'topHub' | 'bottomHub' | 'arcC';

export interface StageOptions {
  quality: QualityPreset;
  layout: 'desktop' | 'mobile';
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export class Stage {
  static isSupported(): boolean;                          // WebGL2 (or WebGL1) available
  constructor(canvas: HTMLCanvasElement, opts: StageOptions);
  readonly sceneTime: number;                             // seconds, accumulated with params.timeScale
  setQuality(q: QualityPreset): void;                     // rebuilds particles/post targets, never the sculpture
  setLayout(layout: 'desktop' | 'mobile'): void;
  resize(width: number, height: number, pixelRatio: number): void;
  render(params: SceneParams, input: RuntimeInput, dt: number): void;
  project(anchor: WorldAnchor): { x: number; y: number; visible: boolean; depth: number }; // CSS px in the canvas
  setPaused(paused: boolean): void;                       // stop rendering when the tab is hidden (main.ts calls it)
  getStats(): { drawCalls: number; triangles: number; fps: number };
  dispose(): void;
}
```

Scene internals (see `docs/ART_PLAN.md` for the full geometry/material plan): sculpture root at `(params.rootX, params.rootY, 0)`
scaled by `rootScale`, tilted by `rootTilt` about X, slow idle yaw (period 90 s) + float bob (7 s / 11 s), drag yaw/pitch added.
Camera orbit around `(camTargetX, camTargetY, camTargetZ)` with spherical `(camDolly, camYaw°, camPitch°)`, `fov = camFov`.

## 4. Motion contract (`src/motion/Director.ts`, `src/motion/pointer.ts`)

```ts
import type { SceneParams, RuntimeInput, PoseKey } from '../shared/params';
import type { UI } from '../ui/types';

export interface DirectorOptions {
  ui: UI;
  layout: () => 'desktop' | 'mobile';
  reducedMotion: boolean;
  /** 'high' etc. — director may lower bloom on 'low' */
  quality: () => 'high' | 'medium' | 'low';
}

export class MotionDirector {
  readonly params: SceneParams;      // live object read by Stage each frame
  readonly input: RuntimeInput;      // smoothed pointer/drag/pressPulse
  constructor(opts: DirectorOptions);
  update(dt: number): void;
  /** raw pointer -1..1 from PointerController (x right, y up); null = pointer left */
  setPointer(x: number | null, y: number | null): void;
  /** raw drag delta in px while dragging; call endDrag() on release */
  dragBy(dxPx: number, dyPx: number): void;
  endDrag(): void;
  setProgress(p: number): void;
  /** M01 — from macro shot to the given pose. Resolves when idle pose reached. Also used by REPLAY. */
  playIntro(pose: PoseKey): Promise<void>;
  /** REPLAY: re-run intro from the current pose and return to the *current* pose/progress. Never touches timer. */
  replay(pose: PoseKey): Promise<void>;
  /** M06 — morph to pose (1.2–1.6 s). Queued if a set-piece is running. */
  toPose(pose: PoseKey, opts?: { duration?: number; immediate?: boolean }): void;
  /** M07 — focus start (calls toPose('focus') with the ignition beats) */
  onStart(): void;
  /** M08 / M09 */
  onPause(): void;
  onResume(): void;
  /** M10 — completion set-piece; ends in `nextPose`. `preview` = no record write happened (purely visual). */
  playComplete(nextPose: PoseKey, opts?: { preview?: boolean }): Promise<void>;
  /** M11 — scene answers a UI press (shellBreath pulse, light nudge) */
  onPress(): void;
  /** current pose key */
  readonly pose: PoseKey;
  readonly locked: boolean;
  dispose(): void;
}

// src/motion/pointer.ts
export interface PointerControllerOptions {
  element: HTMLElement;                       // the stage element (canvas parent)
  onPointer(x: number | null, y: number | null): void;   // normalized -1..1
  onDrag(dx: number, dy: number): void;
  onDragEnd(): void;
  onTap?(x: number, y: number): void;         // touch tap on the sculpture (mobile flare)
  onLongPress?(active: boolean): void;        // 500 ms hold (mobile macro dolly)
  /** elements/ancestors with this attribute never start a drag */
  ignoreSelector: string;                     // '[data-ui]'
}
export class PointerController { constructor(opts: PointerControllerOptions); dispose(): void; }
```

Director DOM duties (uses `ui.el.*` and functions from `src/ui/typography.ts`): word reveals in the intro (M12), word swaps on
mode change (`FOCUS` → `BREATHE` → `FOCUS` …), the completion banner (`SESSION` / `COMPLETE`), `FOCUS` band wipe, timer digit
assembly, console magnetic settle, `pointerWeight` ramps. Everything else (buttons, cursor, confirm) is UI's.

Beat sheets to implement are in `docs/ART_PLAN.md` §Intro (M01), §Modes (M06/M07), §Pause (M08/M09), §Complete (M10).

## 5. UI contract (`src/ui/*`)

`createUI(handlers: UIHandlers): UI` in `src/ui/App.ts` (uses the DOM already in `index.html`). It must:

- Import fonts (bundled, OFL): `@fontsource-variable/unbounded` (display, `'Unbounded Variable'` 200–900),
  `@fontsource/instrument-serif/400-italic.css` (`'Instrument Serif'` italic), `@fontsource-variable/jetbrains-mono` (`'JetBrains Mono Variable'`).
  Fallback stacks required. Timer digits use tabular figures (`font-variant-numeric: tabular-nums`) and must not jitter.
- Bind buttons: `#btn-start` toggles START / PAUSE / RESUME by status; `#btn-reset`; `#btn-replay`; `[data-mode]` buttons.
  Task input → `onTask` (debounced, `value` only — never `innerHTML`).
- `setSnapshot(snap)` updates: `#timer-exact`, `#timer-float-digits` (mm:ss), `#status-line` (e.g. `FOCUS · RUNNING`, `SHORT BREAK · READY`,
  `PAUSED`, `TEST CLOCK ×60` suffix when `snap.testClock`), `#session-label` (`SESSION 0n / 04` where n = completedFocusCount % 4 + 1),
  `#today-count`, `#today-minutes`, mode button `is-active`, `#btn-start` label & `disabled` states (mode buttons enabled always; confirmation is main.ts's job).
  Only text/class changes — no DOM rebuild.
- `confirm(text)` shows `#confirm` (styled as a small chrome plate; ESC/KEEP = false).
- `showStorageNote(msg)` toggles `#storage-note`.
- `showFallback(kind, msg)` shows `#fallback` with a **static but beautiful CSS composition** (gradient vault silhouette, type) — this is the WebGL‑unavailable / context‑lost alternative and must be honest ("3D unavailable").
- Magnetic buttons (M11): `src/ui/magnetic.ts` `attachMagnetic(el: HTMLElement, opts?: { radius?: number; strength?: number; onPress?: () => void }): () => void` — pull toward pointer within 24 px, spring back, press = scale 0.96 + gradient shift. Not on touch.
- Custom cursor (`#cursor`): only when `(pointer: fine)`; dot + ring; ring stretches toward velocity; label shows `DRAG` over the stage, `PRESS` over buttons; hidden on touch.
- Layout: `setLayout` toggles `layout-desktop` / `layout-mobile` on `<html>` and sets micro label 3 to `${innerWidth} × ${innerHeight}`.

`src/ui/typography.ts` (used by the Director — exact signatures):

```ts
import type gsap from 'gsap';
export function splitWord(el: HTMLElement): HTMLElement[];      // wraps each char: <span class="ch"><span class="ch-in">X</span></span>; idempotent; returns .ch-in spans
export function revealWord(el: HTMLElement, opts?: { stagger?: number; skew?: number; from?: 'bottom' | 'top'; duration?: number }): gsap.core.Timeline;
export function hideWord(el: HTMLElement, opts?: { stagger?: number; to?: 'bottom' | 'top'; duration?: number }): gsap.core.Timeline;
export function swapWord(el: HTMLElement, next: string, opts?: { stagger?: number; duration?: number }): gsap.core.Timeline; // per-letter mask out/in; pads/removes spans as needed
export function assembleDigits(el: HTMLElement, opts?: { stagger?: number }): gsap.core.Timeline;  // digits rise from 120% with blur → 0
export function bandWipe(el: HTMLElement, opts?: { bands?: number; direction?: 'out' | 'in' }): gsap.core.Timeline; // M10: split into horizontal bands sliding alternately
export function setWordText(el: HTMLElement, text: string): void;   // instant, keeps split structure
```

CSS layers (z‑index): `.type-back` (0) < `.stage` canvas (1) < `.type-front` (2) < `.timer-float` (3) < `.complete-banner` (4) < `.console` (5) < `.confirm` (8) < `.fallback` (9) < `.cursor` (10).
Body background is the obsidian gradient; the canvas is transparent (`alpha: true`) so `.type-back` shows through around the sculpture.

Desktop composition (1440×900): `FOCUS` 22 vw wide-display, bottom-left, in `.type-back` so the vault occludes its right part;
`SANCTUARY` hairline italic serif ~9 vw crossing the lower right of the vault in `.type-front`, `mix-blend-mode: screen`;
tagline vertical (writing-mode) at the right edge; micro labels at the four corners; console bottom-left as a small glass plate.
Mobile (390×844): `FOCUS` vertical along the left edge (`writing-mode: vertical-rl`, ~34 vw), `SANCTUARY` small tracked across the top,
sculpture in the upper 55%, the 84 px timer below it, console as a compact bottom sheet; content may scroll vertically.

## 6. Timer contract (`src/timer/*`)

```ts
// clock.ts
export function createClock(speed?: number, originMs?: number): Clock;   // speed 1 = real. speed>1: now = origin + (Date.now()-origin)*speed
// dates.ts
export function localDateKey(ms: number): string;                        // 'YYYY-MM-DD' in local time
// storage.ts
export function createStorage(kind: 'local' | 'session' | 'memory', key: string): StorageAdapter;  // try/catch everything; available=false when blocked
// engine.ts
export interface EngineOptions { clock: Clock; storage: StorageAdapter; durations?: { focus: number; short: number; long: number }; longBreakEvery?: number; idFactory?: () => string; }
export function createTimerEngine(opts: EngineOptions): TimerEngine;
```

Rules (all tested in `engine.test.ts` with an injected fake clock):
1. Fresh boot: `focus / idle / 25:00`, task empty, today 0/0.
2. `start()` from idle → `running`, `endAt = now + duration`, new `sessionId`. `pause()` stores `remainingMs = endAt - now`, `endAt = null`. `resume()` → `endAt = now + remainingMs`.
3. `tick()` (and boot restore) completes a running session when `now >= endAt` — **exactly once** (`lastCompletedSessionId` guard) even if many ticks or a reload happen after the end time; a session that ended hours ago completes once, never multiple.
4. Focus completion records to the **local date of `endAt`** (not of now): `today.count += 1`, `today.minutes += 25`, `completedFocusCount += 1`; next mode = `long` when `completedFocusCount % 4 === 0`, else `short`; status → `idle`. Break completion → `focus / idle`. **No auto-start.**
5. `reset()` / `setMode()` discard the running session (no record). `setMode` to the same mode while idle is a no-op.
6. Date rollover: when `today.dateKey !== localDateKey(now)` on tick/boot, `today` becomes `{ dateKey, 0, 0 }`; `completedFocusCount` is never reset. A focus recorded to a past date (finished at 23:59, observed at 00:01) counts to that past date and then today rolls over to 0.
7. Persist on every state change (start/pause/resume/reset/mode/task/completion) as ONE atomic `save()` containing record + next state. If `save()` returns false → `storageError` event once (not every tick), engine keeps working in memory, `storageOk=false`.
8. Corrupt/unknown stored JSON → ignore, start fresh, do not overwrite other keys.
9. `tick()` emits `tick` only when the displayed second or status changed (cheap), and `focusComplete` / `breakComplete` after the completion.
10. Task text is stored as-is (string); UI renders with `textContent`/`value` only.

## 7. DOM ids (index.html)

`#app #type-back #word-focus #stage #gl #type-front #word-sanctuary #tagline #micro-tl #micro-tr #micro-bl #micro-br #timer-float #timer-float-digits
#complete-banner #complete-line-1 #complete-line-2 #console #status-line #timer-exact #session-label [data-mode] #btn-start #btn-reset #btn-replay
#task-input #record #today-count #today-minutes #storage-note #confirm #confirm-text #confirm-yes #confirm-no #fallback #fallback-kicker #fallback-text #cursor`

Elements with `data-ui` never start a sculpture drag.

## 8. URL options (dev / comparison; see `config.ts`)

`?preview=complete` (M10 without any record write), `?speed=60` (test clock; UI shows `TEST CLOCK ×60`), `?quality=high|medium|low`,
`?pose=idle|focus|shortBreak|longBreak|paused` (visual pose only), `?nointro=1`, `?reduce=1`, `?storage=memory|session|local`, `?fps=1`.

## 9. Performance rules

Geometry built once. No per-frame allocations in `render()` (reuse Vector3/Quaternion scratch). Instanced/Points particles.
One `WebGLRenderer`. Pixel ratio capped by preset. Transmission render scale per preset. Bloom at half/quarter res. Stop rendering when
`document.hidden`. Resize debounced; composer + transmission targets resized; no leaks on repeated REPLAY / mode spam (kill tweens with
`overwrite:'auto'`, timelines reused or killed). Handle `webglcontextlost` (preventDefault, notify) / `webglcontextrestored` (rebuild).
