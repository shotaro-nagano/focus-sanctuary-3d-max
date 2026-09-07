// Pomodoro state machine. Pure TypeScript: no DOM, no three.js, no Date.now().
//
// Principles (ARCHITECTURE.md §6, spec §10):
//  - Time is derived from `endAt` (epoch ms from the injected Clock), never from counting ticks,
//    so tab sleep, reloads and accelerated test clocks all reconcile correctly.
//  - Completion happens exactly once per sessionId (`lastCompletedSessionId` guard) even when the
//    end time passed hours ago and many ticks / reloads follow.
//  - A focus completion is recorded to the LOCAL DATE OF `endAt`, then the day rolls over if needed.
//  - Every state change is persisted as ONE atomic PersistedState (record + next state together).
//  - Persistence failure degrades gracefully: one `storageError` event, engine keeps running in memory.
import { DURATIONS, LONG_BREAK_EVERY } from '../config';
import { Emitter } from '../shared/events';
import { clamp01 } from '../shared/math';
import { compareDateKeys, localDateKey } from './dates';
import type {
  Clock,
  Mode,
  PersistedState,
  StorageAdapter,
  TimerEngine,
  TimerEvent,
  TimerSnapshot,
  TodayRecord,
} from './types';

export interface EngineOptions {
  clock: Clock;
  storage: StorageAdapter;
  /** ms per mode; defaults to the production 25 / 5 / 15 minutes */
  durations?: { focus: number; short: number; long: number };
  /** every Nth completed focus is followed by a long break (default 4) */
  longBreakEvery?: number;
  /** session id source; defaults to crypto.randomUUID with a time+random fallback */
  idFactory?: () => string;
}

const MODES: readonly Mode[] = ['focus', 'short', 'long'];

const STORAGE_MESSAGE = 'Saving is unavailable in this browser. The timer keeps running in memory only.';

/** Default session id factory. Uses crypto.randomUUID when the runtime offers it. */
export function defaultIdFactory(): string {
  const c: unknown = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: unknown }).crypto : undefined;
  if (c && typeof (c as { randomUUID?: unknown }).randomUUID === 'function') {
    try {
      return (c as { randomUUID: () => string }).randomUUID();
    } catch {
      // fall through to the manual id
    }
  }
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${time}-${rand}`;
}

/** Seconds shown on the display for a remaining amount (25:00 at start, 00:00 at the end). */
export function displaySeconds(remainingMs: number): number {
  return Math.ceil(Math.max(0, remainingMs) / 1000);
}

interface MutableState {
  mode: Mode;
  status: 'idle' | 'running' | 'paused';
  endAt: number | null;
  /** remaining ms while paused; full duration while idle; ignored while running */
  remainingMs: number;
  sessionId: string | null;
  completedFocusCount: number;
  today: TodayRecord;
  task: string;
  lastCompletedSessionId: string | null;
}

/**
 * Create the timer engine. State is restored from `opts.storage` synchronously.
 *
 * Boot events: construction raises `restore` (always), then — when a session ended while the
 * page was away — exactly one `focusComplete` / `breakComplete` (and `restore.completedWhileAway`
 * is true if and only if such an event follows), then any `storageError`. They are buffered and
 * delivered, in that order, on the first of: the microtask after the first `on()` subscription,
 * or the first API call (`tick()`, `start()`, ...) made while a listener exists. Nothing is
 * dropped for a listener that subscribes late: the buffer is held until someone subscribes.
 */
export function createTimerEngine(opts: EngineOptions): TimerEngine {
  const clock = opts.clock;
  const storage = opts.storage;
  const durations = { ...DURATIONS, ...(opts.durations ?? {}) };
  const longBreakEvery =
    opts.longBreakEvery && Number.isFinite(opts.longBreakEvery) && opts.longBreakEvery >= 1
      ? Math.floor(opts.longBreakEvery)
      : LONG_BREAK_EVERY;
  const nextId = opts.idFactory ?? defaultIdFactory;

  const emitter = new Emitter<TimerEvent>();
  let subscribers = 0;
  let disposed = false;
  let storageOk = storage.available;
  /** true while a storage failure has been reported and no save has succeeded since */
  let storageErrorReported = false;

  /** key of the last snapshot delivered to listeners (see keyOf) */
  let lastDeliveredKey: string | null = null;

  /**
   * Events raised during construction (restore, completion-while-away, boot storage error) are
   * buffered so listeners registered after createTimerEngine() still receive them.
   */
  let pendingBoot: TimerEvent[] = [];
  let booting = true;
  let flushScheduled = false;

  const duration = (mode: Mode): number => durations[mode];

  // ---------------------------------------------------------------- state
  const bootNow = clock.now();
  const st: MutableState = {
    mode: 'focus',
    status: 'idle',
    endAt: null,
    remainingMs: duration('focus'),
    sessionId: null,
    completedFocusCount: 0,
    today: { dateKey: localDateKey(bootNow), count: 0, minutes: 0 },
    task: '',
    lastCompletedSessionId: null,
  };

  // ---------------------------------------------------------------- snapshot
  function snapshot(now: number = clock.now()): TimerSnapshot {
    const durationMs = duration(st.mode);
    let remainingMs: number;
    let progress: number;
    if (st.status === 'running' && st.endAt !== null) {
      remainingMs = Math.max(0, st.endAt - now);
      progress = durationMs > 0 ? clamp01(1 - remainingMs / durationMs) : 1;
    } else if (st.status === 'paused') {
      remainingMs = Math.max(0, st.remainingMs);
      progress = durationMs > 0 ? clamp01(1 - remainingMs / durationMs) : 1;
    } else {
      remainingMs = durationMs;
      progress = 0;
    }
    return {
      mode: st.mode,
      status: st.status,
      durationMs,
      remainingMs,
      progress,
      endAt: st.status === 'running' ? st.endAt : null,
      sessionId: st.status === 'idle' ? null : st.sessionId,
      completedFocusCount: st.completedFocusCount,
      today: { ...st.today },
      task: st.task,
      storageOk,
      testClock: clock.isTest,
    };
  }

  /**
   * What a listener can observe change without an event of its own: mode, status, the displayed
   * second and the calendar day (`today` resets at midnight even while idle / paused — rule 6).
   */
  const keyOf = (snap: TimerSnapshot): string =>
    `${snap.mode}|${snap.status}|${displaySeconds(snap.remainingMs)}|${snap.today.dateKey}`;

  function deliver(event: TimerEvent): void {
    if (disposed) return;
    if (booting) {
      pendingBoot.push(event);
      return;
    }
    lastDeliveredKey = keyOf(event.snap);
    emitter.emit(event);
  }

  /** Deliver the buffered boot events — only once someone is listening (never dropped otherwise). */
  function flushBoot(): void {
    if (booting || disposed || pendingBoot.length === 0 || subscribers === 0) return;
    const events = pendingBoot;
    pendingBoot = [];
    for (const e of events) deliver(e);
    // A late subscriber may have missed state changes made while nobody listened: follow the
    // (boot-time) restore snapshot with a current one when they differ.
    notifyIfChanged(clock.now());
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    const run = (): void => {
      flushScheduled = false;
      flushBoot();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else void Promise.resolve().then(run);
  }

  /** Emit a `tick` when the observable key moved since the last delivered event (rule 9). */
  function notifyIfChanged(now: number): void {
    const snap = snapshot(now);
    if (keyOf(snap) !== lastDeliveredKey) deliver({ type: 'tick', snap });
  }

  // ---------------------------------------------------------------- persistence
  function toPersisted(): PersistedState {
    return {
      version: 1,
      mode: st.mode,
      status: st.status,
      endAt: st.status === 'running' ? st.endAt : null,
      remainingMs: st.status === 'running' ? 0 : st.remainingMs,
      sessionId: st.status === 'idle' ? null : st.sessionId,
      completedFocusCount: st.completedFocusCount,
      today: { ...st.today },
      task: st.task,
      lastCompletedSessionId: st.lastCompletedSessionId,
    };
  }

  /**
   * One atomic write of record + next state. Returns true when persisted.
   * On failure: `storageOk` false and a single `storageError` (re-armed after a later success).
   */
  function save(): boolean {
    let ok = false;
    try {
      ok = storage.save(toPersisted());
    } catch {
      ok = false;
    }
    if (ok) {
      storageOk = true;
      storageErrorReported = false;
      return true;
    }
    storageOk = false;
    if (!storageErrorReported) {
      storageErrorReported = true;
      deliver({ type: 'storageError', snap: snapshot(), message: STORAGE_MESSAGE });
    }
    return false;
  }

  // ---------------------------------------------------------------- day / record bookkeeping
  /** Rule 6: `today` follows the local calendar day; lifetime count is untouched. */
  function rolloverIfNeeded(now: number): boolean {
    const key = localDateKey(now);
    if (st.today.dateKey === key) return false;
    st.today = { dateKey: key, count: 0, minutes: 0 };
    return true;
  }

  /** Rule 4: credit one focus to the day that contains `endAt`. */
  function recordFocus(endAt: number): string {
    const dateKey = localDateKey(endAt);
    const cmp = compareDateKeys(dateKey, st.today.dateKey);
    if (cmp > 0) {
      // The record belongs to a day newer than the stored "today" (e.g. session crossed midnight
      // and finished on the new day): today becomes that day.
      st.today = { dateKey, count: 0, minutes: 0 };
    } else if (cmp < 0) {
      // Belongs to a day older than the stored "today" (only possible if the wall clock went
      // backwards). Keep today's totals; only the lifetime count is credited.
      st.completedFocusCount += 1;
      return dateKey;
    }
    st.today = {
      dateKey: st.today.dateKey,
      count: st.today.count + 1,
      minutes: st.today.minutes + duration('focus') / 60_000,
    };
    st.completedFocusCount += 1;
    return dateKey;
  }

  // ---------------------------------------------------------------- completion
  /**
   * Finish the current session at `endAt`. Exactly one record per sessionId.
   * Emits focusComplete / breakComplete and saves atomically. Never auto-starts.
   * Returns true when the session was recorded (and its completion event delivered); false when
   * the double-count guard hit — the state still moves to idle, silently.
   */
  function completeSession(endAt: number, now: number): boolean {
    const sid = st.sessionId;
    const alreadyRecorded = sid === null || sid === st.lastCompletedSessionId;
    const finishedMode = st.mode;

    let nextMode: Mode = 'focus';
    let recordedDateKey = localDateKey(endAt);

    if (!alreadyRecorded) {
      if (finishedMode === 'focus') {
        recordedDateKey = recordFocus(endAt);
        nextMode = st.completedFocusCount % longBreakEvery === 0 ? 'long' : 'short';
      }
      st.lastCompletedSessionId = sid;
    } else if (finishedMode === 'focus') {
      // Guard hit (should not happen with atomic saves): do not count, but still leave focus.
      nextMode = st.completedFocusCount % longBreakEvery === 0 && st.completedFocusCount > 0 ? 'long' : 'short';
    }

    st.mode = nextMode;
    st.status = 'idle';
    st.endAt = null;
    st.sessionId = null;
    st.remainingMs = duration(nextMode);

    rolloverIfNeeded(now);
    save();

    if (alreadyRecorded) return false;
    const snap = snapshot(now);
    if (finishedMode === 'focus') {
      deliver({ type: 'focusComplete', snap, nextMode, recordedDateKey, sessionId: sid });
    } else {
      deliver({ type: 'breakComplete', snap });
    }
    return true;
  }

  /**
   * Bring the state in line with `now`: complete an overdue session (once), then roll the day.
   * Returns true when a session was recorded (a completion event was delivered) in this call.
   */
  function reconcile(now: number): boolean {
    let recorded = false;
    if (st.status === 'running') {
      if (st.endAt === null) {
        // Inconsistent persisted state: running without an end time. Treat as discarded.
        st.status = 'idle';
        st.sessionId = null;
        st.remainingMs = duration(st.mode);
        save();
      } else if (now >= st.endAt) {
        recorded = completeSession(st.endAt, now);
      }
    } else if (st.status === 'paused' && st.remainingMs <= 0) {
      // Paused with nothing left (clamped / legacy state): finish it now.
      recorded = completeSession(now, now);
    }
    if (rolloverIfNeeded(now)) save();
    return recorded;
  }

  // ---------------------------------------------------------------- boot / restore
  const persisted = storage.load();
  let restoredNeedsSave = false;
  if (persisted) {
    st.mode = persisted.mode;
    st.status = persisted.status;
    st.completedFocusCount = persisted.completedFocusCount;
    st.today = { ...persisted.today };
    st.task = persisted.task;
    st.lastCompletedSessionId = persisted.lastCompletedSessionId;
    st.sessionId = persisted.sessionId;
    if (persisted.status === 'running') {
      // Sanity clamp: an end time further away than a full session (tampered data, clock skew)
      // cannot be genuine; it is shortened to one full duration from now.
      const latest = bootNow + duration(st.mode);
      const endAt = persisted.endAt === null ? null : Math.min(persisted.endAt, latest);
      restoredNeedsSave = endAt !== persisted.endAt;
      st.endAt = endAt;
      st.remainingMs = 0;
      if (st.sessionId === null) st.sessionId = nextId();
    } else if (persisted.status === 'paused') {
      st.endAt = null;
      st.remainingMs = Math.min(Math.max(0, persisted.remainingMs), duration(st.mode));
      if (st.sessionId === null) st.sessionId = nextId();
    } else {
      st.endAt = null;
      st.sessionId = null;
      st.remainingMs = duration(st.mode);
    }
  }

  {
    // reconcile() may complete an overdue session; its focusComplete/breakComplete and any
    // storageError raised by save() land in pendingBoot. A still-valid state is re-saved only
    // when it changed (clamp / rollover / completion).
    const completedWhileAway = reconcile(bootNow);
    if (restoredNeedsSave && st.status === 'running') save();
    const raised = pendingBoot;
    pendingBoot = [];
    // Guaranteed order for listeners: restore, then completion event(s), then storage error(s).
    const isCompletion = (e: TimerEvent): boolean => e.type === 'focusComplete' || e.type === 'breakComplete';
    const isError = (e: TimerEvent): boolean => e.type === 'storageError';
    const completions: TimerEvent[] = raised.filter(isCompletion);
    const errors: TimerEvent[] = raised.filter(isError);
    const others: TimerEvent[] = raised.filter((e) => !isCompletion(e) && !isError(e));
    if (!storage.available && !storageErrorReported) {
      storageErrorReported = true;
      storageOk = false;
      errors.push({ type: 'storageError', snap: snapshot(bootNow), message: STORAGE_MESSAGE });
    }
    pendingBoot = [
      { type: 'restore', snap: snapshot(bootNow), completedWhileAway },
      ...completions,
      ...others,
      ...errors,
    ];
    booting = false;
    // Listeners normally subscribe right after createTimerEngine() returns; deliver on the next
    // microtask (or on the first API call, whichever comes first). If nobody has subscribed by
    // then, the buffer is kept and flushed after the first on().
    scheduleFlush();
  }

  // ---------------------------------------------------------------- public API
  const engine: TimerEngine = {
    getSnapshot(): TimerSnapshot {
      return snapshot();
    },

    start(): void {
      if (disposed) return;
      flushBoot();
      const now = clock.now();
      if (reconcile(now)) return; // an overdue session just completed; user sees the result first
      if (st.status === 'paused') {
        engine.resume();
        return;
      }
      if (st.status !== 'idle') return;
      st.status = 'running';
      st.sessionId = nextId();
      st.endAt = now + duration(st.mode);
      st.remainingMs = 0;
      save();
      deliver({ type: 'start', snap: snapshot(now) });
    },

    pause(): void {
      if (disposed) return;
      flushBoot();
      const now = clock.now();
      if (reconcile(now)) return;
      if (st.status !== 'running' || st.endAt === null) return;
      st.remainingMs = Math.max(0, st.endAt - now);
      st.endAt = null;
      st.status = 'paused';
      save();
      deliver({ type: 'pause', snap: snapshot(now) });
    },

    resume(): void {
      if (disposed) return;
      flushBoot();
      const now = clock.now();
      if (reconcile(now)) return;
      if (st.status !== 'paused') return;
      st.endAt = now + st.remainingMs;
      st.remainingMs = 0;
      st.status = 'running';
      if (st.sessionId === null) st.sessionId = nextId();
      save();
      deliver({ type: 'resume', snap: snapshot(now) });
    },

    reset(): void {
      if (disposed) return;
      flushBoot();
      const now = clock.now();
      // An elapsed session is completed (recorded exactly once), never discarded (rule 3).
      if (reconcile(now)) return;
      if (st.status === 'idle') {
        notifyIfChanged(now); // nothing to discard; still report a day rollover if one happened
        return;
      }
      st.status = 'idle';
      st.endAt = null;
      st.sessionId = null;
      st.remainingMs = duration(st.mode);
      save();
      deliver({ type: 'reset', snap: snapshot(now) });
    },

    setMode(mode: Mode): void {
      if (disposed) return;
      if (!MODES.includes(mode)) return;
      flushBoot();
      const now = clock.now();
      // An elapsed session is completed (recorded exactly once) before the requested switch.
      reconcile(now);
      if (mode === st.mode && st.status === 'idle') {
        notifyIfChanged(now); // rule 5: no-op (a completion above already delivered its event)
        return;
      }
      const from = st.mode;
      st.mode = mode;
      st.status = 'idle';
      st.endAt = null;
      st.sessionId = null;
      st.remainingMs = duration(mode);
      save();
      deliver({ type: 'modeChange', snap: snapshot(now), from });
    },

    setTask(text: string): void {
      if (disposed) return;
      flushBoot();
      const value = typeof text === 'string' ? text : String(text ?? '');
      if (value === st.task) return;
      st.task = value; // stored raw; the UI renders it with textContent/value only
      save();
      deliver({ type: 'task', snap: snapshot() });
    },

    tick(): void {
      if (disposed) return;
      flushBoot();
      const now = clock.now();
      reconcile(now);
      notifyIfChanged(now);
    },

    on(listener: (e: TimerEvent) => void): () => void {
      const off = emitter.on(listener);
      subscribers += 1;
      let active = true;
      // A late subscriber still receives the buffered boot events (asynchronously, like an
      // on-time one), so a top-level await before on() cannot lose restore/completion.
      if (pendingBoot.length > 0) scheduleFlush();
      return () => {
        if (!active) return;
        active = false;
        subscribers -= 1;
        off();
      };
    },

    dispose(): void {
      disposed = true;
      pendingBoot = [];
      subscribers = 0;
      emitter.clear();
    },
  };

  return engine;
}
