// Dev harness for the scene module (no timer, no UI, no Director).
// ?pose=idle|focus|shortBreak|longBreak  ?quality=high|medium|low  ?layout=desktop|mobile  ?paused=1
// overrides: ?open= ?progress= ?twist= ?glow= ?hue= ?tilt= ?reveal= ?shock= ?spread= ?rtwist= ?door= ?keel= ?hub=
//            ?yaw= ?pitch= ?dolly= ?fov= ?exposure= ?bloom= ?px= ?py= ?dyaw= ?dpitch=  ?still=1 (timeScale 0)  ?t=<sceneTime seconds>
// keys: 1-4 pose, g flat grey debug material, w wireframe, space freeze/unfreeze time, p pause overlay
import { QUALITY, type QualityName } from '../config';
import { Stage } from '../scene/Stage';
import {
  CAMERA_POSES,
  DEFAULT_PARAMS,
  FORM_POSES,
  PAUSE_OVERLAY,
  clonePose,
  type PoseKey,
  type RuntimeInput,
  type SceneParams,
} from '../shared/params';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;

const layoutParam = q.get('layout');
const layout: 'desktop' | 'mobile' = layoutParam === 'mobile' ? 'mobile' : layoutParam === 'desktop' ? 'desktop' : innerWidth < 720 ? 'mobile' : 'desktop';
const explicitQuality = q.get('quality');
let qualityName: QualityName = explicitQuality === 'high' || explicitQuality === 'medium' || explicitQuality === 'low' ? explicitQuality : 'high';

const poseParam = q.get('pose');
let pose: PoseKey = poseParam === 'focus' || poseParam === 'shortBreak' || poseParam === 'longBreak' ? poseParam : 'idle';
let pausedOverlay = q.get('paused') === '1';

const num = (key: string): number | null => {
  const v = q.get(key);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const OVERRIDES: Record<string, keyof SceneParams | (keyof SceneParams)[]> = {
  open: 'shellOpen',
  progress: 'progress',
  twist: 'shellTwist',
  glow: 'coreGlow',
  hue: 'accentHue',
  tilt: 'orbitTilt',
  reveal: ['orbitReveal', 'ribbonReveal'],
  shock: 'shockwave',
  spread: 'ribbonSpread',
  rtwist: 'ribbonTwist',
  door: 'doorSwing',
  keel: 'keelSplay',
  hub: 'hubLift',
  yaw: 'camYaw',
  pitch: 'camPitch',
  dolly: 'camDolly',
  fov: 'camFov',
  exposure: 'exposure',
  bloom: 'bloomStrength',
  breath: 'shellBreath',
  liquid: 'liquidAmp',
  rim: 'rimIntensity',
  attract: 'attract',
  envrot: 'envRotation',
  slide: 'lightSlide',
  scale: 'coreScale',
  rootx: 'rootX',
  rooty: 'rootY',
  floor: 'floorPresence',
};

function buildParams(p: PoseKey): SceneParams {
  const out = clonePose(DEFAULT_PARAMS, FORM_POSES[p], CAMERA_POSES[layout][p]);
  if (pausedOverlay) Object.assign(out, PAUSE_OVERLAY);
  for (const key of Object.keys(OVERRIDES)) {
    const v = num(key);
    if (v === null) continue;
    const targets = OVERRIDES[key];
    for (const t of Array.isArray(targets) ? targets : [targets]) (out as unknown as Record<string, number>)[t] = v;
  }
  if (q.get('still') === '1') out.timeScale = 0;
  return out;
}

let params = buildParams(pose);
const input: RuntimeInput = {
  pointerX: num('px') ?? 0,
  pointerY: num('py') ?? 0,
  dragYaw: num('dyaw') ?? 0,
  dragPitch: num('dpitch') ?? 0,
  pressPulse: 0,
  layout,
};

const log = (...a: unknown[]): void => console.log('[scene-dev]', ...a);
log('webgl supported:', Stage.isSupported());

const stage = new Stage(canvas, {
  quality: QUALITY[qualityName],
  layout,
  onContextLost: () => log('context lost'),
  onContextRestored: () => log('context restored'),
});

function resize(): void {
  stage.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, QUALITY[qualityName].maxPixelRatio));
}
addEventListener('resize', resize);
resize();

// optional time seek so screenshots can show a specific phase (one big dt step, ignores ?still)
const seek = num('t');
if (seek !== null && seek > 0) stage.render({ ...params, timeScale: 1 }, input, seek);
if (q.get('hud') === '0') {
  hud.hidden = true;
  const help = document.getElementById('help');
  if (help) help.hidden = true;
}

const frozenScale = params.timeScale;
let frozen = q.get('still') === '1';

addEventListener('keydown', (e) => {
  const map: Record<string, PoseKey> = { '1': 'idle', '2': 'focus', '3': 'shortBreak', '4': 'longBreak' };
  if (map[e.key]) {
    pose = map[e.key];
    params = buildParams(pose);
    if (frozen) params.timeScale = 0;
    log('pose', pose);
  } else if (e.key === 'g') {
    stage.setDebugMaterial(stage.debugMaterial === 'grey' ? 'none' : 'grey');
  } else if (e.key === 'w') {
    stage.setDebugMaterial(stage.debugMaterial === 'wire' ? 'none' : 'wire');
  } else if (e.key === ' ') {
    frozen = !frozen;
    params.timeScale = frozen ? 0 : frozenScale || 1;
  } else if (e.key === 'p') {
    pausedOverlay = !pausedOverlay;
    params = buildParams(pose);
  }
});

// pointer parallax / drag for interactive checks
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    input.dragYaw += (e.clientX - lastX) * 0.25;
    input.dragPitch += (e.clientY - lastY) * 0.12;
    lastX = e.clientX;
    lastY = e.clientY;
    return;
  }
  input.pointerX = (e.clientX / innerWidth) * 2 - 1;
  input.pointerY = -((e.clientY / innerHeight) * 2 - 1);
});
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
addEventListener('pointerup', () => {
  dragging = false;
});

const dbg = q.get('debug');
if (dbg === 'grey') stage.setDebugMaterial('grey');
if (dbg === 'wire') stage.setDebugMaterial('wire');

declare global {
  interface Window {
    __stage?: Stage;
    __params?: SceneParams;
    __input?: RuntimeInput;
    __frames?: number;
  }
}
window.__stage = stage;
window.__params = params;
window.__input = input;
window.__frames = 0;

let last = performance.now();
let elapsed = 0;
let frames = 0;
let hudAccum = 0;
let autoChecked = explicitQuality !== null;
// ?frames=N renders N frames then stops the loop (software-GL screenshot capture)
const maxFrames = num('frames');

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  elapsed += dt;
  frames++;
  window.__frames = frames;
  window.__params = params;
  if (maxFrames !== null && frames > maxFrames) {
    log('stopped after', maxFrames, 'frames');
    return;
  }
  if (!dragging) {
    input.dragYaw *= 0.94;
    input.dragPitch *= 0.94;
  }
  stage.render(params, input, dt);
  hudAccum += dt;
  if (hudAccum > 0.4) {
    hudAccum = 0;
    const s = stage.getStats();
    hud.innerHTML = `<b>${pose}</b> · ${qualityName} · ${Math.round(s.fps)} fps · ${s.drawCalls} calls · ${Math.round(s.triangles / 1000)}k tris · ${Math.round(stage.vertexCount / 1000)}k verts · t ${stage.sceneTime.toFixed(1)}s${frozen ? ' · FROZEN' : ''}${pausedOverlay ? ' · PAUSED' : ''}`;
  }
  // fallback to medium if high is clearly too slow on this machine (only when quality was not forced)
  if (!autoChecked && elapsed > 3) {
    autoChecked = true;
    const avg = frames / elapsed;
    if (avg < 12 && qualityName === 'high') {
      qualityName = 'medium';
      stage.setQuality(QUALITY.medium);
      resize();
      log('slow (', avg.toFixed(1), 'fps ) -> medium preset');
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
