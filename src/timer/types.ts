// Timer domain contract. Pure data; no DOM, no three.js.
export type Mode = 'focus' | 'short' | 'long';
export type Status = 'idle' | 'running' | 'paused';

export interface TodayRecord {
  /** local date key YYYY-MM-DD of the day the record belongs to */
  dateKey: string;
  /** completed focus sessions counted on that day */
  count: number;
  /** total focused minutes on that day (25 per completed focus) */
  minutes: number;
}

export interface TimerSnapshot {
  mode: Mode;
  status: Status;
  durationMs: number;
  remainingMs: number;
  /** elapsed fraction 0..1 of the current session (0 when idle) */
  progress: number;
  /** epoch ms when the running session is scheduled to end; null unless running */
  endAt: number | null;
  /** unique id of the in-progress session; null when idle */
  sessionId: string | null;
  /** lifetime completed focus count (never reset by date change); drives the 4th-cycle long break */
  completedFocusCount: number;
  today: TodayRecord;
  task: string;
  /** false when persistence is unavailable (still fully functional in memory) */
  storageOk: boolean;
  /** true when a test clock (?speed=N) is active */
  testClock: boolean;
}

export interface PersistedState {
  version: 1;
  mode: Mode;
  status: Status;
  endAt: number | null;
  /** remaining ms when paused (or idle: full duration) */
  remainingMs: number;
  sessionId: string | null;
  completedFocusCount: number;
  today: TodayRecord;
  task: string;
  /** id of the last session that was recorded as complete (double-count guard) */
  lastCompletedSessionId: string | null;
}

export type TimerEvent =
  | { type: 'tick'; snap: TimerSnapshot }
  | { type: 'start'; snap: TimerSnapshot }
  | { type: 'pause'; snap: TimerSnapshot }
  | { type: 'resume'; snap: TimerSnapshot }
  | { type: 'reset'; snap: TimerSnapshot }
  | { type: 'modeChange'; snap: TimerSnapshot; from: Mode }
  /** a focus session finished: recorded exactly once; snap.mode is already the next break mode in idle */
  | { type: 'focusComplete'; snap: TimerSnapshot; nextMode: Mode; recordedDateKey: string; sessionId: string }
  /** a break finished: snap.mode is 'focus' in idle */
  | { type: 'breakComplete'; snap: TimerSnapshot }
  /** state restored from storage on boot */
  | { type: 'restore'; snap: TimerSnapshot; completedWhileAway: boolean }
  | { type: 'storageError'; snap: TimerSnapshot; message: string }
  | { type: 'task'; snap: TimerSnapshot };

export interface Clock {
  /** epoch milliseconds (possibly accelerated for tests) */
  now(): number;
  readonly isTest: boolean;
}

export interface StorageAdapter {
  load(): PersistedState | null;
  /** returns false when the write failed (quota, disabled...) */
  save(state: PersistedState): boolean;
  readonly available: boolean;
}

export interface TimerEngine {
  getSnapshot(): TimerSnapshot;
  start(): void;
  pause(): void;
  resume(): void;
  /** discard the current session, back to idle with full duration of the current mode */
  reset(): void;
  /** switch mode; discards the current session (the UI asks for confirmation first) */
  setMode(mode: Mode): void;
  setTask(text: string): void;
  /** call ~4x/sec (or every rAF); detects completion, reconciles after tab sleep */
  tick(): void;
  on(listener: (e: TimerEvent) => void): () => void;
  dispose(): void;
}
