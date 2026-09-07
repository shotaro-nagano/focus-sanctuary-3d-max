// UI module entry: binds the DOM in index.html, owns buttons / cursor / confirm /
// fallback, and applies text-only snapshot updates. No DOM rebuilds, no innerHTML
// with user data (task text goes through `value` only).
import '@fontsource-variable/unbounded';
import '@fontsource-variable/jetbrains-mono';
import '../styles/main.css';

import type { Mode, Status, TimerSnapshot } from '../timer/types';
import type { UI, UIElements, UIHandlers } from './types';
import { parseUrlOptions } from '../config';
import { attachMagnetic } from './magnetic';
import { createCursor } from './cursor';
import { createConfirm } from './confirm';
import { setWordText } from './typography';

type FallbackKind = 'nowebgl' | 'contextlost' | 'reduced';

const MODE_LABEL: Record<Mode, string> = { focus: 'FOCUS', short: 'SHORT BREAK', long: 'LONG BREAK' };
const STATUS_LABEL: Record<Status, string> = { idle: 'READY', running: 'RUNNING', paused: 'PAUSED' };
const START_LABEL: Record<Status, string> = { idle: 'START', running: 'PAUSE', paused: 'RESUME' };
const FALLBACK_KICKER: Record<FallbackKind, string> = {
  nowebgl: '3D UNAVAILABLE',
  contextlost: 'GRAPHICS CONTEXT LOST',
  reduced: 'REDUCED MOTION',
};
const FALLBACK_DEFAULT_TEXT: Record<FallbackKind, string> = {
  nowebgl: 'WebGL could not start in this browser. The timer below is fully functional.',
  contextlost: 'The GPU dropped the rendering context. Reload to rebuild the sculpture; the timer keeps counting.',
  reduced: 'Motion is reduced per your system setting. The sculpture holds a still pose.',
};

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`[ui] missing element ${selector}`);
  return el;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isMode(v: string | undefined): v is Mode {
  return v === 'focus' || v === 'short' || v === 'long';
}

/** Builds the static CSS composition inside #fallback once (no user data). */
function buildFallbackArt(fallback: HTMLElement): void {
  if (fallback.querySelector('.fb-art')) return;
  const art = document.createElement('div');
  art.className = 'fb-art';
  art.setAttribute('aria-hidden', 'true');
  const parts: Array<[string, string?]> = [
    ['fb-halo fb-halo-a'],
    ['fb-halo fb-halo-b'],
    ['fb-vault'],
    ['fb-cleft'],
    ['fb-slit'],
    ['fb-core'],
    ['fb-halo fb-halo-c'],
    ['fb-word fb-word-focus', 'FOCUS'],
    ['fb-word fb-word-sanctuary', 'SANCTUARY'],
  ];
  for (const [cls, text] of parts) {
    const d = document.createElement('div');
    d.className = cls;
    if (text) d.textContent = text;
    art.appendChild(d);
  }
  fallback.insertBefore(art, fallback.firstChild);
}

export function createUI(handlers: UIHandlers): UI {
  const doc = document;
  const root = must<HTMLElement>(doc, '#app');
  const el: UIElements = {
    root,
    stage: must<HTMLElement>(root, '#stage'),
    canvas: must<HTMLCanvasElement>(root, '#gl'),
    typeBack: must<HTMLElement>(root, '#type-back'),
    typeFront: must<HTMLElement>(root, '#type-front'),
    wordFocus: must<HTMLElement>(root, '#word-focus'),
    wordSanctuary: must<HTMLElement>(root, '#word-sanctuary'),
    tagline: must<HTMLElement>(root, '#tagline'),
    timerFloat: must<HTMLElement>(root, '#timer-float'),
    timerFloatDigits: must<HTMLElement>(root, '#timer-float-digits'),
    timerExact: must<HTMLElement>(root, '#timer-exact'),
    consoleEl: must<HTMLElement>(root, '#console'),
    btnStart: must<HTMLButtonElement>(root, '#btn-start'),
    btnReset: must<HTMLButtonElement>(root, '#btn-reset'),
    btnReplay: must<HTMLButtonElement>(root, '#btn-replay'),
    modeButtons: Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-mode]')),
    taskInput: must<HTMLInputElement>(root, '#task-input'),
    todayCount: must<HTMLElement>(root, '#today-count'),
    todayMinutes: must<HTMLElement>(root, '#today-minutes'),
    sessionLabel: must<HTMLElement>(root, '#session-label'),
    statusLine: must<HTMLElement>(root, '#status-line'),
    storageNote: must<HTMLElement>(root, '#storage-note'),
    completeBanner: must<HTMLElement>(root, '#complete-banner'),
    completeLines: [must<HTMLElement>(root, '#complete-line-1'), must<HTMLElement>(root, '#complete-line-2')],
    fallback: must<HTMLElement>(root, '#fallback'),
    cursor: must<HTMLElement>(root, '#cursor'),
    micro: [
      must<HTMLElement>(root, '#micro-tl'),
      must<HTMLElement>(root, '#micro-tr'),
      must<HTMLElement>(root, '#micro-bl'),
      must<HTMLElement>(root, '#micro-br'),
    ],
  };
  const recordEl = must<HTMLElement>(root, '#record');
  const fallbackKicker = must<HTMLElement>(root, '#fallback-kicker');
  const fallbackText = must<HTMLElement>(root, '#fallback-text');
  const html = doc.documentElement;
  const testSpeed = parseUrlOptions().speed;

  // interaction-lock shade over the console contents (CSS-driven; the Director may
  // tween it with the other children, which is harmless because the class wins back
  // after clearProps)
  if (!el.consoleEl.querySelector(':scope > .console-shade')) {
    const shade = doc.createElement('span');
    shade.className = 'console-shade';
    shade.setAttribute('aria-hidden', 'true');
    el.consoleEl.appendChild(shade);
  }

  // ---- state ---------------------------------------------------------------
  let snap: TimerSnapshot | null = null;
  let locked = false;
  let disposed = false;
  let anchorX = Number.NaN;
  let anchorY = Number.NaN;
  let anchorVisible: boolean | null = null;
  let recordPulseTimer = 0;
  let taskDebounce = 0;
  let lastSentTask: string | null = null;
  let fallbackRaf = 0;
  let fallbackHideTimer = 0;
  const detachers: Array<() => void> = [];

  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };

  // ---- buttons -------------------------------------------------------------
  const applyButtonState = (): void => {
    const status: Status = snap?.status ?? 'idle';
    setText(el.btnStart, START_LABEL[status]);
    el.btnStart.dataset.action = status === 'idle' ? 'start' : status === 'running' ? 'pause' : 'resume';
    el.btnStart.disabled = locked;
    el.btnReset.disabled = locked || status === 'idle';
    el.btnReplay.disabled = locked;
    for (const b of el.modeButtons) b.disabled = locked;
    el.taskInput.disabled = locked;
    el.consoleEl.classList.toggle('is-locked', locked);
    el.consoleEl.setAttribute('aria-busy', locked ? 'true' : 'false');
  };

  const onStartClick = (): void => {
    if (locked) return;
    const status: Status = snap?.status ?? 'idle';
    if (status === 'idle') handlers.onStart();
    else if (status === 'running') handlers.onPause();
    else handlers.onResume();
  };
  const onResetClick = (): void => {
    if (!locked) handlers.onReset();
  };
  const onReplayClick = (): void => {
    if (!locked) handlers.onReplay();
  };
  const onModeClick = (ev: Event): void => {
    if (locked) return;
    const btn = (ev.currentTarget as HTMLButtonElement | null) ?? null;
    const mode = btn?.dataset.mode;
    if (isMode(mode)) handlers.onMode(mode);
  };

  el.btnStart.addEventListener('click', onStartClick);
  el.btnReset.addEventListener('click', onResetClick);
  el.btnReplay.addEventListener('click', onReplayClick);
  for (const b of el.modeButtons) b.addEventListener('click', onModeClick);
  detachers.push(() => {
    el.btnStart.removeEventListener('click', onStartClick);
    el.btnReset.removeEventListener('click', onResetClick);
    el.btnReplay.removeEventListener('click', onReplayClick);
    for (const b of el.modeButtons) b.removeEventListener('click', onModeClick);
  });

  // ---- magnetic (M11) --------------------------------------------------------
  const pressPulse = (): void => {
    el.consoleEl.classList.remove('is-press');
    // restart the plate flash
    void el.consoleEl.offsetWidth;
    el.consoleEl.classList.add('is-press');
  };
  const allButtons: HTMLElement[] = [el.btnStart, el.btnReset, el.btnReplay, ...el.modeButtons];
  for (const b of allButtons) detachers.push(attachMagnetic(b, { radius: 24, strength: 0.35, onPress: pressPulse }));
  const confirmButtons = Array.from(root.querySelectorAll<HTMLElement>('#confirm .btn'));
  for (const b of confirmButtons) detachers.push(attachMagnetic(b, { radius: 20, strength: 0.3 }));

  // ---- task input (value only, debounced) -----------------------------------
  const flushTask = (): void => {
    window.clearTimeout(taskDebounce);
    taskDebounce = 0;
    const value = el.taskInput.value;
    if (value === lastSentTask) return;
    lastSentTask = value;
    handlers.onTask(value);
  };
  const onTaskInput = (): void => {
    window.clearTimeout(taskDebounce);
    taskDebounce = window.setTimeout(flushTask, 250);
  };
  const onTaskKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') {
      flushTask();
      el.taskInput.blur();
    } else if (ev.key === 'Escape') {
      el.taskInput.blur();
    }
  };
  el.taskInput.addEventListener('input', onTaskInput);
  el.taskInput.addEventListener('change', flushTask);
  el.taskInput.addEventListener('blur', flushTask);
  el.taskInput.addEventListener('keydown', onTaskKey);
  detachers.push(() => {
    el.taskInput.removeEventListener('input', onTaskInput);
    el.taskInput.removeEventListener('change', flushTask);
    el.taskInput.removeEventListener('blur', flushTask);
    el.taskInput.removeEventListener('keydown', onTaskKey);
    window.clearTimeout(taskDebounce);
  });

  // ---- cursor / confirm ----------------------------------------------------
  const cursor = createCursor(el.cursor, { stage: el.stage });
  const confirmCtl = createConfirm(must<HTMLElement>(root, '#confirm'));

  // keyboard: space toggles start/pause when focus is not in a control
  const onGlobalKey = (ev: KeyboardEvent): void => {
    if (confirmCtl.open || locked) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA')) return;
    if (ev.key === ' ' && !ev.repeat) {
      ev.preventDefault();
      onStartClick();
    }
  };
  doc.addEventListener('keydown', onGlobalKey);
  detachers.push(() => doc.removeEventListener('keydown', onGlobalKey));

  // ---- layout ----------------------------------------------------------------
  const setLayout = (layout: 'desktop' | 'mobile'): void => {
    html.classList.toggle('layout-desktop', layout === 'desktop');
    html.classList.toggle('layout-mobile', layout === 'mobile');
    setText(el.micro[3], `${window.innerWidth} × ${window.innerHeight}`);
  };
  setLayout(html.classList.contains('layout-mobile') ? 'mobile' : 'desktop');

  // ---- snapshot --------------------------------------------------------------
  const setSnapshot = (next: TimerSnapshot): void => {
    if (disposed) return;
    snap = next;
    const clock = formatClock(next.remainingMs);
    // both readouts may be split into .ch spans by the Director (assembleDigits):
    // setWordText keeps that structure instead of wiping it mid-animation
    setWordText(el.timerExact, clock);
    setWordText(el.timerFloatDigits, clock);

    let status = `${MODE_LABEL[next.mode]} · ${STATUS_LABEL[next.status]}`;
    if (next.testClock) status += testSpeed ? ` · TEST CLOCK ×${testSpeed}` : ' · TEST CLOCK';
    setText(el.statusLine, status);

    const n = (next.completedFocusCount % 4) + 1;
    setText(el.sessionLabel, `SESSION ${String(n).padStart(2, '0')} / 04`);
    setText(el.todayCount, String(next.today.count));
    setText(el.todayMinutes, String(next.today.minutes));

    for (const b of el.modeButtons) {
      const active = b.dataset.mode === next.mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (html.dataset.mode !== next.mode) html.dataset.mode = next.mode;
    if (html.dataset.status !== next.status) html.dataset.status = next.status;

    if (doc.activeElement !== el.taskInput && el.taskInput.value !== next.task) {
      el.taskInput.value = next.task;
      lastSentTask = next.task;
    }
    applyButtonState();
  };

  const showStorageNote = (message: string | null): void => {
    if (message) {
      setText(el.storageNote, message);
      el.storageNote.hidden = false;
    } else {
      el.storageNote.hidden = true;
    }
  };

  const showFallback = (kind: FallbackKind | null, message?: string): void => {
    cancelAnimationFrame(fallbackRaf);
    fallbackRaf = 0;
    window.clearTimeout(fallbackHideTimer);
    fallbackHideTimer = 0;
    if (!kind) {
      // fade out (0.5 s in the stylesheet), then take the plate out of the tree
      el.fallback.classList.remove('is-open');
      html.classList.remove('has-fallback');
      if (el.fallback.hidden) return;
      fallbackHideTimer = window.setTimeout(() => {
        fallbackHideTimer = 0;
        el.fallback.hidden = true;
        el.fallback.classList.remove('is-reduced', 'is-nowebgl', 'is-contextlost');
      }, 520);
      return;
    }
    buildFallbackArt(el.fallback);
    setText(fallbackKicker, FALLBACK_KICKER[kind]);
    setText(fallbackText, message ?? FALLBACK_DEFAULT_TEXT[kind]);
    el.fallback.classList.remove('is-reduced', 'is-nowebgl', 'is-contextlost');
    el.fallback.classList.add(`is-${kind}`);
    // 'reduced' is a notice only — the real 3D keeps rendering behind it
    html.classList.toggle('has-fallback', kind !== 'reduced');
    if (el.fallback.hidden) {
      el.fallback.hidden = false;
      // next frame so the opacity transition runs from the hidden state
      fallbackRaf = requestAnimationFrame(() => {
        fallbackRaf = 0;
        el.fallback.classList.add('is-open');
      });
    } else {
      el.fallback.classList.add('is-open');
    }
  };

  const setInteractionLock = (value: boolean): void => {
    locked = value;
    applyButtonState();
  };

  const setTimerAnchor = (x: number, y: number, visible: boolean): void => {
    if (visible !== anchorVisible) {
      anchorVisible = visible;
      el.timerFloat.classList.toggle('is-hidden', !visible);
    }
    if (!visible) return;
    const dpr = window.devicePixelRatio || 1;
    const rx = Math.round(x * dpr) / dpr;
    const ry = Math.round(y * dpr) / dpr;
    if (rx === anchorX && ry === anchorY) return;
    anchorX = rx;
    anchorY = ry;
    el.timerFloat.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
  };

  const pulseRecord = (): void => {
    recordEl.classList.remove('is-pulse');
    void recordEl.offsetWidth;
    recordEl.classList.add('is-pulse');
    window.clearTimeout(recordPulseTimer);
    recordPulseTimer = window.setTimeout(() => recordEl.classList.remove('is-pulse'), 1400);
  };

  const setMicro = (index: number, text: string): void => {
    const node = el.micro[index];
    if (node) setText(node, text);
  };

  applyButtonState();

  return {
    el,
    setSnapshot,
    confirm: (text: string) => confirmCtl.confirm(text),
    showStorageNote,
    showFallback,
    setInteractionLock,
    setTimerAnchor,
    pulseRecord,
    setLayout,
    setMicro,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const d of detachers.splice(0)) d();
      cursor.dispose();
      confirmCtl.dispose();
      window.clearTimeout(recordPulseTimer);
      window.clearTimeout(fallbackHideTimer);
      cancelAnimationFrame(fallbackRaf);
    },
  };
}
