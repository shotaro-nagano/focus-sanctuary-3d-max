// UI contract consumed by main.ts and motion/Director.
import type { Mode, TimerSnapshot } from '../timer/types';

export interface UIHandlers {
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onReset(): void;
  onMode(mode: Mode): void;
  onReplay(): void;
  onTask(text: string): void;
}

export interface UIElements {
  root: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  typeBack: HTMLElement;
  typeFront: HTMLElement;
  wordFocus: HTMLElement;
  wordSanctuary: HTMLElement;
  tagline: HTMLElement;
  timerFloat: HTMLElement;
  timerFloatDigits: HTMLElement;
  timerExact: HTMLElement;
  consoleEl: HTMLElement;
  btnStart: HTMLButtonElement;
  btnReset: HTMLButtonElement;
  btnReplay: HTMLButtonElement;
  modeButtons: HTMLButtonElement[];
  taskInput: HTMLInputElement;
  todayCount: HTMLElement;
  todayMinutes: HTMLElement;
  sessionLabel: HTMLElement;
  statusLine: HTMLElement;
  storageNote: HTMLElement;
  completeBanner: HTMLElement;
  completeLines: HTMLElement[];
  fallback: HTMLElement;
  cursor: HTMLElement;
  /** micro coordinate labels: [tl, tr, bl, br] */
  micro: HTMLElement[];
}

export interface UI {
  readonly el: UIElements;
  /** cheap incremental update: text nodes + button states only; never rebuilds DOM */
  setSnapshot(snap: TimerSnapshot): void;
  /** modal confirmation styled as part of the work (resolves false on cancel/escape) */
  confirm(text: string): Promise<boolean>;
  showStorageNote(message: string | null): void;
  /** 'nowebgl' | 'contextlost' | 'reduced' -> show the alternative display; null hides it */
  showFallback(kind: 'nowebgl' | 'contextlost' | 'reduced' | null, message?: string): void;
  /** disable/enable console interaction while a set-piece (intro / complete) owns the stage */
  setInteractionLock(locked: boolean): void;
  /** position the floating timer over a projected world anchor (CSS px); visible=false hides it */
  setTimerAnchor(x: number, y: number, visible: boolean): void;
  /** short flash of the record counter after a completion */
  pulseRecord(): void;
  /** applies 'layout-desktop' | 'layout-mobile' on <html> and updates the size micro label */
  setLayout(layout: 'desktop' | 'mobile'): void;
  /** update a micro label by index (0 tl, 1 tr, 2 bl, 3 br) */
  setMicro(index: number, text: string): void;
  dispose(): void;
}
