import { describe, expect, it, vi } from 'vitest';
import { DURATIONS, LONG_BREAK_EVERY } from '../config';
import { createClock, createManualClock } from './clock';
import { localDateKey } from './dates';
import { createTimerEngine, displaySeconds } from './engine';
import { createStorage, parsePersistedState, type StorageLike } from './storage';
import type { PersistedState, TimerEvent } from './types';

const MIN = 60_000;
const FOCUS = DURATIONS.focus;
const SHORT = DURATIONS.short;
const LONG = DURATIONS.long;
const KEY = 'test:focus-sanctuary';

/** A local-time instant (the engine aggregates by LOCAL date, so tests must build local dates). */
const local = (y: number, m1: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, m1 - 1, d, h, mi, s).getTime();

const T0 = local(2026, 9, 6, 10, 0, 0); // 2026-09-06 10:00 local

/** Storage backend that records every write and can be told to fail / return garbage. */
function fakeBackend(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
  failWrites: boolean;
  writes: number;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const b = {
    data,
    failWrites: false,
    writes: 0,
    getItem(key: string): string | null {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      b.writes += 1;
      if (b.failWrites) throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, value);
    },
  };
  return b;
}

function idSequence(prefix = 'sid'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function boot(startMs = T0, backend = fakeBackend(), idFactory = idSequence()) {
  const clock = createManualClock(startMs);
  const storage = createStorage('local', KEY, backend);
  const events: TimerEvent[] = [];
  const engine = createTimerEngine({ clock, storage, idFactory });
  engine.on((e) => events.push(e));
  return { clock, storage, backend, engine, events, idFactory };
}

const types = (events: TimerEvent[]): string[] => events.map((e) => e.type);
const stored = (backend: { data: Map<string, string> }): PersistedState =>
  JSON.parse(backend.data.get(KEY) as string) as PersistedState;

/** drive a fresh focus session to completion; returns the number of focus completions emitted */
function runFocus(ctx: ReturnType<typeof boot>): number {
  const before = ctx.events.filter((e) => e.type === 'focusComplete').length;
  ctx.engine.start();
  ctx.clock.advance(FOCUS);
  ctx.engine.tick();
  return ctx.events.filter((e) => e.type === 'focusComplete').length - before;
}

// ---------------------------------------------------------------------------------------------
describe('clock & dates', () => {
  it('createClock(1) is real time and not a test clock', () => {
    const c = createClock();
    const a = Date.now();
    const n = c.now();
    expect(c.isTest).toBe(false);
    expect(Math.abs(n - a)).toBeLessThan(1000);
  });

  it('createClock(speed) accelerates elapsed time from the origin', () => {
    const origin = Date.now() - 1000;
    const c = createClock(60, origin);
    expect(c.isTest).toBe(true);
    const real = Date.now() - origin;
    const fast = c.now() - origin;
    expect(fast).toBeGreaterThanOrEqual(real * 60 - 60);
    expect(fast).toBeLessThan((real + 200) * 60);
  });

  it('localDateKey formats the local calendar day with zero padding', () => {
    expect(localDateKey(local(2026, 9, 6, 0, 0, 0))).toBe('2026-09-06');
    expect(localDateKey(local(2026, 1, 1, 23, 59, 59))).toBe('2026-01-01');
    expect(localDateKey(local(2026, 12, 31, 23, 59, 59))).toBe('2026-12-31');
    // the last millisecond of the day still belongs to it
    expect(localDateKey(local(2026, 9, 7, 0, 0, 0) - 1)).toBe('2026-09-06');
  });

  it('displaySeconds rounds up so 25:00 shows at start and 00:00 only at the end', () => {
    expect(displaySeconds(FOCUS)).toBe(1500);
    expect(displaySeconds(FOCUS - 1)).toBe(1500);
    expect(displaySeconds(FOCUS - 1000)).toBe(1499);
    expect(displaySeconds(1)).toBe(1);
    expect(displaySeconds(0)).toBe(0);
    expect(displaySeconds(-50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('rule 1 - fresh boot', () => {
  it('starts focus / idle / 25:00 with empty task and 0 / 0 today', async () => {
    const { engine, events, storage } = boot();
    const s = engine.getSnapshot();
    expect(s.mode).toBe('focus');
    expect(s.status).toBe('idle');
    expect(s.durationMs).toBe(FOCUS);
    expect(s.remainingMs).toBe(FOCUS);
    expect(s.progress).toBe(0);
    expect(s.endAt).toBeNull();
    expect(s.sessionId).toBeNull();
    expect(s.task).toBe('');
    expect(s.today).toEqual({ dateKey: '2026-09-06', count: 0, minutes: 0 });
    expect(s.completedFocusCount).toBe(0);
    expect(s.storageOk).toBe(true);
    expect(s.testClock).toBe(false);
    expect(storage.available).toBe(true);

    // restore event reaches listeners registered right after construction
    await Promise.resolve();
    expect(types(events)).toEqual(['restore']);
    const r = events[0];
    if (r.type === 'restore') expect(r.completedWhileAway).toBe(false);
  });

  it('flushes the boot events on the first tick even before the microtask runs', () => {
    const { engine, events } = boot();
    engine.tick();
    expect(types(events)[0]).toBe('restore');
  });
});

// ---------------------------------------------------------------------------------------------
describe('F01 - start / pause / resume are computed from endAt', () => {
  it('start sets endAt = now + duration and a session id', () => {
    const { engine, clock, backend } = boot();
    engine.start();
    const s = engine.getSnapshot();
    expect(s.status).toBe('running');
    expect(s.endAt).toBe(clock.now() + FOCUS);
    expect(s.sessionId).toBe('sid-1');
    expect(s.remainingMs).toBe(FOCUS);
    expect(stored(backend).status).toBe('running');
    expect(stored(backend).endAt).toBe(clock.now() + FOCUS);
  });

  it('remaining time follows the clock, not the number of ticks', () => {
    const { engine, clock } = boot();
    engine.start();
    clock.advance(10 * MIN);
    // no ticks in between (tab was asleep)
    expect(engine.getSnapshot().remainingMs).toBe(15 * MIN);
    expect(engine.getSnapshot().progress).toBeCloseTo(10 / 25, 6);
    for (let i = 0; i < 50; i++) engine.tick(); // many ticks do not move time
    expect(engine.getSnapshot().remainingMs).toBe(15 * MIN);
  });

  it('pause keeps remainingMs while time passes; resume computes a new endAt', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(5 * MIN + 250);
    engine.pause();
    let s = engine.getSnapshot();
    expect(s.status).toBe('paused');
    expect(s.endAt).toBeNull();
    expect(s.remainingMs).toBe(FOCUS - 5 * MIN - 250);
    expect(s.sessionId).toBe('sid-1');

    clock.advance(3 * 60 * MIN); // three hours paused
    engine.tick();
    s = engine.getSnapshot();
    expect(s.status).toBe('paused');
    expect(s.remainingMs).toBe(FOCUS - 5 * MIN - 250);

    engine.resume();
    s = engine.getSnapshot();
    expect(s.status).toBe('running');
    expect(s.endAt).toBe(clock.now() + FOCUS - 5 * MIN - 250);
    expect(s.sessionId).toBe('sid-1'); // same session continues

    clock.advance(FOCUS - 5 * MIN - 250);
    engine.tick();
    expect(engine.getSnapshot().status).toBe('idle');
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    expect(types(events)).toContain('start');
    expect(types(events)).toContain('pause');
    expect(types(events)).toContain('resume');
  });

  it('start while paused resumes; pause while idle / resume while running are no-ops', () => {
    const { engine, clock, events } = boot();
    engine.pause();
    engine.resume();
    expect(engine.getSnapshot().status).toBe('idle');
    engine.start();
    clock.advance(1000);
    engine.pause();
    engine.start(); // acts as resume
    expect(engine.getSnapshot().status).toBe('running');
    expect(engine.getSnapshot().sessionId).toBe('sid-1');
    engine.resume(); // no-op while running
    engine.start(); // no-op while running
    expect(types(events).filter((t) => t === 'start')).toHaveLength(1);
    expect(types(events).filter((t) => t === 'resume')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F02 - reset / mode change discard without recording', () => {
  it('reset discards a running session: idle, full duration, no record', () => {
    const { engine, clock, backend, events } = boot();
    engine.start();
    clock.advance(24 * MIN + 59_000);
    engine.reset();
    const s = engine.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.mode).toBe('focus');
    expect(s.remainingMs).toBe(FOCUS);
    expect(s.sessionId).toBeNull();
    expect(s.today.count).toBe(0);
    expect(s.completedFocusCount).toBe(0);
    expect(stored(backend).status).toBe('idle');
    expect(stored(backend).sessionId).toBeNull();
    clock.advance(10 * MIN); // well past the discarded endAt
    engine.tick();
    expect(types(events)).not.toContain('focusComplete');
    expect(engine.getSnapshot().today.count).toBe(0);
  });

  it('reset while idle is a no-op (nothing emitted)', () => {
    const { engine, events } = boot();
    engine.tick();
    const n = events.length;
    engine.reset();
    expect(events.length).toBe(n);
  });

  it('setMode discards the running session, only one timer ever runs', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(3 * MIN);
    engine.setMode('short');
    const s = engine.getSnapshot();
    expect(s.mode).toBe('short');
    expect(s.status).toBe('idle');
    expect(s.remainingMs).toBe(SHORT);
    expect(s.endAt).toBeNull();
    const mc = events.find((e) => e.type === 'modeChange');
    expect(mc && mc.type === 'modeChange' ? mc.from : null).toBe('focus');
    clock.advance(FOCUS); // the old focus endAt is long gone
    engine.tick();
    expect(types(events)).not.toContain('focusComplete');
    expect(engine.getSnapshot().completedFocusCount).toBe(0);
  });

  it('setMode to the same mode while idle is a no-op; invalid mode ignored', () => {
    const { engine, events, backend } = boot();
    engine.tick();
    const n = events.length;
    const w = backend.writes;
    engine.setMode('focus');
    engine.setMode('nope' as never);
    expect(events.length).toBe(n);
    expect(backend.writes).toBe(w);
  });

  it('setMode to the same mode while running restarts it as idle (discard)', () => {
    const { engine, clock } = boot();
    engine.start();
    clock.advance(MIN);
    engine.setMode('focus');
    const s = engine.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.remainingMs).toBe(FOCUS);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F03 - completion, 4th-cycle long break, double-count guard, no auto-start', () => {
  it('focus completion records once and moves to short break idle', () => {
    const ctx = boot();
    const { engine, events, backend } = ctx;
    expect(runFocus(ctx)).toBe(1);
    const s = engine.getSnapshot();
    expect(s.mode).toBe('short');
    expect(s.status).toBe('idle');
    expect(s.remainingMs).toBe(SHORT);
    expect(s.endAt).toBeNull();
    expect(s.today).toEqual({ dateKey: '2026-09-06', count: 1, minutes: 25 });
    expect(s.completedFocusCount).toBe(1);
    const fc = events.find((e) => e.type === 'focusComplete');
    expect(fc).toBeDefined();
    if (fc && fc.type === 'focusComplete') {
      expect(fc.nextMode).toBe('short');
      expect(fc.recordedDateKey).toBe('2026-09-06');
      expect(fc.sessionId).toBe('sid-1');
      expect(fc.snap.mode).toBe('short');
      expect(fc.snap.status).toBe('idle');
    }
    // atomic save: record and next state in the same stored object
    const p = stored(backend);
    expect(p.today.count).toBe(1);
    expect(p.mode).toBe('short');
    expect(p.status).toBe('idle');
    expect(p.lastCompletedSessionId).toBe('sid-1');
  });

  it('many ticks after the end time never double count', () => {
    const ctx = boot();
    const { engine, clock, events } = ctx;
    engine.start();
    clock.advance(FOCUS + 5 * 60 * MIN); // 5 hours late
    for (let i = 0; i < 200; i++) {
      engine.tick();
      clock.advance(250);
    }
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    expect(engine.getSnapshot().today.count).toBe(1);
    expect(engine.getSnapshot().completedFocusCount).toBe(1);
  });

  it('next mode stays idle: no auto-start after focus or break', () => {
    const ctx = boot();
    const { engine, clock, events } = ctx;
    runFocus(ctx);
    clock.advance(60 * MIN);
    engine.tick();
    expect(engine.getSnapshot().status).toBe('idle');
    expect(engine.getSnapshot().mode).toBe('short');
    engine.start();
    clock.advance(SHORT);
    engine.tick();
    expect(types(events).filter((t) => t === 'breakComplete')).toHaveLength(1);
    expect(engine.getSnapshot().mode).toBe('focus');
    expect(engine.getSnapshot().status).toBe('idle');
    expect(engine.getSnapshot().remainingMs).toBe(FOCUS);
    clock.advance(60 * MIN);
    engine.tick();
    expect(engine.getSnapshot().status).toBe('idle');
    // breaks are never recorded
    expect(engine.getSnapshot().today).toEqual({ dateKey: '2026-09-06', count: 1, minutes: 25 });
    expect(engine.getSnapshot().completedFocusCount).toBe(1);
  });

  it('every 4th completed focus leads to a long break; breaks return to focus', () => {
    const ctx = boot();
    const { engine, clock } = ctx;
    const nextModes: string[] = [];
    for (let i = 1; i <= 9; i++) {
      engine.setMode('focus');
      expect(runFocus(ctx)).toBe(1);
      const s = engine.getSnapshot();
      nextModes.push(s.mode);
      expect(s.completedFocusCount).toBe(i);
      expect(s.status).toBe('idle');
      // take the break
      engine.start();
      clock.advance(s.mode === 'long' ? LONG : SHORT);
      engine.tick();
      expect(engine.getSnapshot().mode).toBe('focus');
      expect(engine.getSnapshot().status).toBe('idle');
    }
    expect(nextModes).toEqual(['short', 'short', 'short', 'long', 'short', 'short', 'short', 'long', 'short']);
    expect(LONG_BREAK_EVERY).toBe(4);
    expect(engine.getSnapshot().today).toEqual({ dateKey: '2026-09-06', count: 9, minutes: 225 });
  });

  it('a break that completes does not need a restart of focus and emits breakComplete once', () => {
    const { engine, clock, events } = boot();
    engine.setMode('long');
    engine.start();
    clock.advance(LONG + 10 * MIN);
    engine.tick();
    engine.tick();
    engine.tick();
    expect(types(events).filter((t) => t === 'breakComplete')).toHaveLength(1);
    expect(engine.getSnapshot().mode).toBe('focus');
    expect(engine.getSnapshot().today.count).toBe(0);
  });

  it('pause() / resume() / start() at or after the end time complete the session instead', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(FOCUS);
    engine.pause(); // overdue -> completes, does not pause
    expect(engine.getSnapshot().status).toBe('idle');
    expect(engine.getSnapshot().mode).toBe('short');
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    expect(types(events)).not.toContain('pause');
  });
});

// ---------------------------------------------------------------------------------------------
describe('F04 - restore after reload, date rollover, midnight crossing', () => {
  it('restores a running session with remaining time computed from endAt', async () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.clock.advance(7 * MIN);
    a.engine.dispose();

    // reload 3 minutes later
    const b = boot(T0 + 10 * MIN, backend, idSequence('b'));
    const s = b.engine.getSnapshot();
    expect(s.status).toBe('running');
    expect(s.mode).toBe('focus');
    expect(s.sessionId).toBe('sid-1'); // the original id survives the reload
    expect(s.remainingMs).toBe(FOCUS - 10 * MIN);
    expect(s.endAt).toBe(T0 + FOCUS);
    await Promise.resolve();
    expect(types(b.events)).toEqual(['restore']);
  });

  it('restores a paused session with its remaining time intact', () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.clock.advance(4 * MIN);
    a.engine.pause();
    a.engine.setTask('write the report');
    a.engine.dispose();

    const b = boot(T0 + 48 * 60 * MIN, backend); // two days later
    const s = b.engine.getSnapshot();
    expect(s.status).toBe('paused');
    expect(s.remainingMs).toBe(FOCUS - 4 * MIN);
    expect(s.task).toBe('write the report');
    expect(s.today).toEqual({ dateKey: '2026-09-08', count: 0, minutes: 0 }); // day rolled
    b.engine.resume();
    expect(b.engine.getSnapshot().endAt).toBe(b.clock.now() + FOCUS - 4 * MIN);
  });

  it('a session whose endAt passed while away completes exactly once on boot, and never again', async () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.engine.dispose();

    // come back 6 hours later
    const b = boot(T0 + 6 * 60 * MIN, backend, idSequence('b'));
    await Promise.resolve();
    expect(types(b.events)).toEqual(['restore', 'focusComplete']);
    const r = b.events[0];
    if (r.type === 'restore') {
      expect(r.completedWhileAway).toBe(true);
      expect(r.snap.mode).toBe('short');
      expect(r.snap.status).toBe('idle');
    }
    const fc = b.events[1];
    if (fc.type === 'focusComplete') {
      expect(fc.sessionId).toBe('sid-1');
      expect(fc.recordedDateKey).toBe('2026-09-06');
    }
    let s = b.engine.getSnapshot();
    expect(s.today).toEqual({ dateKey: '2026-09-06', count: 1, minutes: 25 });
    expect(s.completedFocusCount).toBe(1);
    for (let i = 0; i < 20; i++) b.engine.tick();
    expect(types(b.events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    b.engine.dispose();

    // reload again without touching anything: the stored state is already idle/short -> nothing recorded
    const c = boot(T0 + 7 * 60 * MIN, backend, idSequence('c'));
    await Promise.resolve();
    expect(types(c.events)).toEqual(['restore']);
    s = c.engine.getSnapshot();
    expect(s.today.count).toBe(1);
    expect(s.completedFocusCount).toBe(1);
    expect(s.mode).toBe('short');
    expect(stored(backend).lastCompletedSessionId).toBe('sid-1');
  });

  it('the double-count guard holds even when the stored state still says running for a recorded id', async () => {
    // Simulate a crash between "recorded" and "next state" in a hypothetical non-atomic writer:
    // stored says running with the id that lastCompletedSessionId already names.
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.engine.dispose();
    const p = stored(backend);
    p.lastCompletedSessionId = p.sessionId;
    p.today = { dateKey: '2026-09-06', count: 1, minutes: 25 };
    p.completedFocusCount = 1;
    backend.data.set(KEY, JSON.stringify(p));

    const b = boot(T0 + 2 * 60 * MIN, backend);
    await Promise.resolve();
    expect(types(b.events)).toEqual(['restore']); // no focusComplete
    // completedWhileAway is true only when a completion event actually follows
    const r = b.events[0];
    if (r.type === 'restore') expect(r.completedWhileAway).toBe(false);
    const s = b.engine.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.mode).toBe('short');
    expect(s.today.count).toBe(1);
    expect(s.completedFocusCount).toBe(1);
  });

  it('day rollover on tick resets today only; completedFocusCount persists', () => {
    const ctx = boot(local(2026, 9, 6, 22, 0));
    const { engine, clock } = ctx;
    expect(runFocus(ctx)).toBe(1);
    engine.setMode('focus');
    expect(runFocus(ctx)).toBe(1);
    engine.setMode('focus');
    expect(runFocus(ctx)).toBe(1);
    expect(engine.getSnapshot().today.count).toBe(3);
    const lifetime = engine.getSnapshot().completedFocusCount;
    clock.set(local(2026, 9, 7, 0, 0, 1));
    engine.tick();
    const s = engine.getSnapshot();
    expect(s.today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
    expect(s.completedFocusCount).toBe(lifetime);
    expect(s.mode).toBe(lifetime % 4 === 0 ? 'long' : 'short');
    expect(s.status).toBe('idle');
  });

  it('day rollover on boot resets today only', () => {
    const backend = fakeBackend();
    const a = boot(local(2026, 9, 6, 9, 0), backend);
    runFocus(a);
    a.engine.dispose();
    const b = boot(local(2026, 9, 8, 9, 0), backend);
    const s = b.engine.getSnapshot();
    expect(s.today).toEqual({ dateKey: '2026-09-08', count: 0, minutes: 0 });
    expect(s.completedFocusCount).toBe(1);
    expect(stored(backend).today.dateKey).toBe('2026-09-08');
  });

  it('a focus that ended at 23:59 but is observed at 00:01 counts to the previous day, then today rolls to 0', () => {
    const { engine, clock, events } = boot(local(2026, 9, 6, 23, 34));
    engine.start(); // endAt 23:59
    expect(engine.getSnapshot().endAt).toBe(local(2026, 9, 6, 23, 59));
    clock.set(local(2026, 9, 7, 0, 1));
    engine.tick();
    const fc = events.find((e) => e.type === 'focusComplete');
    expect(fc).toBeDefined();
    if (fc && fc.type === 'focusComplete') {
      expect(fc.recordedDateKey).toBe('2026-09-06');
      // the snapshot delivered with the event is already rolled over to the new day
      expect(fc.snap.today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
      expect(fc.snap.completedFocusCount).toBe(1);
    }
    const s = engine.getSnapshot();
    expect(s.today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
    expect(s.completedFocusCount).toBe(1);
    expect(s.mode).toBe('short');
  });

  it('a focus that crosses midnight and ends at 00:15 counts to the new day', () => {
    const { engine, clock, events } = boot(local(2026, 9, 6, 23, 50));
    engine.start(); // endAt 00:15 next day
    clock.set(local(2026, 9, 7, 0, 10));
    engine.tick(); // still running, but the day rolled
    expect(engine.getSnapshot().status).toBe('running');
    expect(engine.getSnapshot().today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
    clock.set(local(2026, 9, 7, 0, 16));
    engine.tick();
    const fc = events.find((e) => e.type === 'focusComplete');
    if (fc && fc.type === 'focusComplete') expect(fc.recordedDateKey).toBe('2026-09-07');
    expect(engine.getSnapshot().today).toEqual({ dateKey: '2026-09-07', count: 1, minutes: 25 });
  });

  it('a midnight-crossing focus observed only after reload credits endAt\'s day (23:59 -> reload at 00:30)', async () => {
    const backend = fakeBackend();
    const a = boot(local(2026, 9, 6, 23, 34), backend);
    a.engine.start();
    a.engine.dispose();
    const b = boot(local(2026, 9, 7, 0, 30), backend);
    await Promise.resolve();
    const fc = b.events.find((e) => e.type === 'focusComplete');
    expect(fc).toBeDefined();
    if (fc && fc.type === 'focusComplete') expect(fc.recordedDateKey).toBe('2026-09-06');
    const s = b.engine.getSnapshot();
    expect(s.today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
    expect(s.completedFocusCount).toBe(1);
    // the stored state carries both the record and the rolled-over day in one object
    const p = stored(backend);
    expect(p.completedFocusCount).toBe(1);
    expect(p.today.dateKey).toBe('2026-09-07');
    expect(p.lastCompletedSessionId).toBe('sid-1');
  });
});

// ---------------------------------------------------------------------------------------------
describe('F05 - storage failure and corrupt data', () => {
  it('a failing save emits storageError once, the engine keeps working, storageOk=false', () => {
    const backend = fakeBackend();
    const ctx = boot(T0, backend);
    const { engine, clock, events } = ctx;
    backend.failWrites = true;
    engine.start();
    clock.advance(MIN);
    engine.pause();
    engine.resume();
    engine.setTask('still typing');
    for (let i = 0; i < 100; i++) {
      clock.advance(1000);
      engine.tick();
    }
    clock.advance(FOCUS);
    engine.tick(); // completion also tries to save
    expect(types(events).filter((t) => t === 'storageError')).toHaveLength(1);
    const s = engine.getSnapshot();
    expect(s.storageOk).toBe(false);
    expect(s.mode).toBe('short');
    expect(s.status).toBe('idle');
    expect(s.today.count).toBe(1);
    expect(s.task).toBe('still typing');
    expect(types(events)).toContain('focusComplete');
    expect(backend.data.has(KEY)).toBe(false); // nothing was written
  });

  it('when saving works again storageOk returns to true (and a later failure reports once more)', () => {
    const backend = fakeBackend();
    const { engine, events } = boot(T0, backend);
    backend.failWrites = true;
    engine.setTask('a');
    expect(engine.getSnapshot().storageOk).toBe(false);
    backend.failWrites = false;
    engine.setTask('ab');
    expect(engine.getSnapshot().storageOk).toBe(true);
    expect(stored(backend).task).toBe('ab');
    backend.failWrites = true;
    engine.setTask('abc');
    engine.setTask('abcd');
    expect(types(events).filter((t) => t === 'storageError')).toHaveLength(2);
  });

  it('a Storage that throws on access is reported as unavailable; the timer still runs', async () => {
    const throwing: StorageLike = {
      getItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    const storage = createStorage('local', KEY, throwing);
    expect(storage.available).toBe(false);
    expect(storage.load()).toBeNull();
    const clock = createManualClock(T0);
    const events: TimerEvent[] = [];
    const engine = createTimerEngine({ clock, storage, idFactory: idSequence() });
    engine.on((e) => events.push(e));
    await Promise.resolve();
    expect(types(events)).toEqual(['restore', 'storageError']);
    expect(engine.getSnapshot().storageOk).toBe(false);
    engine.start();
    clock.advance(FOCUS);
    engine.tick();
    expect(engine.getSnapshot().today.count).toBe(1);
    expect(types(events).filter((t) => t === 'storageError')).toHaveLength(1);
  });

  it('corrupt JSON is ignored: fresh start, other keys untouched, nothing written until a change', () => {
    const backend = fakeBackend({ [KEY]: '{not json', 'other-app:key': 'keep me' });
    const { engine, backend: b } = boot(T0, backend);
    const s = engine.getSnapshot();
    expect(s.mode).toBe('focus');
    expect(s.status).toBe('idle');
    expect(s.today).toEqual({ dateKey: '2026-09-06', count: 0, minutes: 0 });
    expect(b.data.get('other-app:key')).toBe('keep me');
    expect(b.data.get(KEY)).toBe('{not json'); // not "repaired" behind the user's back
    engine.setTask('x');
    expect(stored(b).task).toBe('x');
    expect(b.data.get('other-app:key')).toBe('keep me');
  });

  it('valid JSON with an unknown shape / version / enum is ignored', () => {
    const cases: unknown[] = [
      null,
      42,
      'string',
      [],
      { version: 2 },
      { version: 1, mode: 'nap', status: 'idle' },
      {
        version: 1,
        mode: 'focus',
        status: 'running',
        endAt: 'soon',
        remainingMs: 0,
        sessionId: 'x',
        completedFocusCount: 0,
        today: { dateKey: '2026-09-06', count: 0, minutes: 0 },
        task: '',
        lastCompletedSessionId: null,
      },
      {
        version: 1,
        mode: 'focus',
        status: 'idle',
        endAt: null,
        remainingMs: 0,
        sessionId: null,
        completedFocusCount: -1,
        today: { dateKey: '2026-09-06', count: 0, minutes: 0 },
        task: '',
        lastCompletedSessionId: null,
      },
      {
        version: 1,
        mode: 'focus',
        status: 'idle',
        endAt: null,
        remainingMs: 0,
        sessionId: null,
        completedFocusCount: 3,
        today: { dateKey: 'yesterday', count: 0, minutes: 0 },
        task: '',
        lastCompletedSessionId: null,
      },
    ];
    for (const c of cases) expect(parsePersistedState(c)).toBeNull();
    for (const c of cases) {
      const backend = fakeBackend({ [KEY]: JSON.stringify(c) });
      const { engine } = boot(T0, backend);
      expect(engine.getSnapshot().completedFocusCount).toBe(0);
      expect(engine.getSnapshot().status).toBe('idle');
    }
  });

  it('a valid stored state round-trips through parsePersistedState', () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.setTask('t');
    const p = stored(backend);
    expect(parsePersistedState(p)).toEqual(p);
  });

  it('memory storage works and is isolated per adapter', () => {
    const s1 = createStorage('memory', KEY);
    const s2 = createStorage('memory', KEY);
    expect(s1.available).toBe(true);
    const e1 = createTimerEngine({ clock: createManualClock(T0), storage: s1 });
    e1.setTask('hello');
    expect(s1.load()?.task).toBe('hello');
    expect(s2.load()).toBeNull();
  });

  it("'local' storage in a runtime without window is unavailable but harmless", () => {
    const s = createStorage('local', KEY);
    expect(typeof window).toBe('undefined');
    expect(s.available).toBe(false);
    expect(s.load()).toBeNull();
    expect(
      s.save({
        version: 1,
        mode: 'focus',
        status: 'idle',
        endAt: null,
        remainingMs: FOCUS,
        sessionId: null,
        completedFocusCount: 0,
        today: { dateKey: '2026-09-06', count: 0, minutes: 0 },
        task: '',
        lastCompletedSessionId: null,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F05/F06 - task text and persistence of every change', () => {
  it('task text is stored raw (never interpreted) and persisted', () => {
    const backend = fakeBackend();
    const { engine, events } = boot(T0, backend);
    const evil = '<img src=x onerror="alert(1)"> & "quotes" é 日本語';
    engine.setTask(evil);
    expect(engine.getSnapshot().task).toBe(evil);
    expect(stored(backend).task).toBe(evil);
    expect(types(events)).toContain('task');
    // same text again: no event, no write
    const n = events.length;
    const w = backend.writes;
    engine.setTask(evil);
    expect(events.length).toBe(n);
    expect(backend.writes).toBe(w);
    engine.setTask('');
    expect(engine.getSnapshot().task).toBe('');
  });

  it('every state change writes exactly one atomic save', () => {
    const backend = fakeBackend();
    const { engine, clock } = boot(T0, backend);
    expect(backend.writes).toBe(0); // fresh boot with nothing to reconcile writes nothing
    engine.start();
    expect(backend.writes).toBe(1);
    clock.advance(1000);
    engine.tick();
    engine.tick();
    expect(backend.writes).toBe(1); // ticks do not write
    engine.pause();
    expect(backend.writes).toBe(2);
    engine.resume();
    expect(backend.writes).toBe(3);
    engine.setTask('t');
    expect(backend.writes).toBe(4);
    engine.reset();
    expect(backend.writes).toBe(5);
    engine.setMode('short');
    expect(backend.writes).toBe(6);
    engine.start();
    clock.advance(SHORT);
    engine.tick();
    expect(backend.writes).toBe(8); // start + completion
    const p = stored(backend);
    expect(p.version).toBe(1);
    expect(p.mode).toBe('focus');
    expect(p.status).toBe('idle');
    expect(p.task).toBe('t');
  });

  it('engine state is unaffected by anything other than its own API (REPLAY / preview never touch it)', () => {
    // The engine has no hooks for animation; this asserts that time simply passing without API
    // calls changes nothing but the derived remaining time.
    const { engine, clock } = boot();
    engine.start();
    const before = engine.getSnapshot();
    clock.advance(4000);
    const after = engine.getSnapshot();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.endAt).toBe(before.endAt);
    expect(after.today).toEqual(before.today);
    expect(after.completedFocusCount).toBe(before.completedFocusCount);
    expect(before.remainingMs - after.remainingMs).toBe(4000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('rule 9 - tick emits only when the displayed second or status changes', () => {
  it('no tick events within the same displayed second; one per second boundary', () => {
    const { engine, clock, events } = boot();
    engine.start();
    const base = events.length;
    for (let i = 0; i < 9; i++) {
      clock.advance(100); // 0.9 s total: still 25:00
      engine.tick();
    }
    expect(events.length - base).toBe(0);
    clock.advance(100); // exactly 1 s elapsed -> 24:59
    engine.tick();
    expect(events.length - base).toBe(1);
    expect(events[events.length - 1].type).toBe('tick');
    clock.advance(10_000);
    engine.tick();
    engine.tick();
    engine.tick();
    expect(events.length - base).toBe(2); // one more, not three
  });

  it('a status change is reported by its own event, and a subsequent tick does not repeat it', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(500);
    engine.pause();
    const n = events.length;
    engine.tick();
    engine.tick();
    expect(events.length).toBe(n);
    expect(events[n - 1].type).toBe('pause');
  });

  it('completion delivers focusComplete (not an extra tick) with the idle snapshot', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(FOCUS);
    engine.tick();
    const tail = types(events).slice(-1);
    expect(tail).toEqual(['focusComplete']);
    engine.tick();
    expect(types(events).slice(-1)).toEqual(['focusComplete']);
  });

  it('snapshot progress and remainingMs are clamped', () => {
    const { engine, clock } = boot();
    engine.start();
    clock.advance(FOCUS - 1);
    let s = engine.getSnapshot();
    expect(s.remainingMs).toBe(1);
    expect(s.progress).toBeLessThan(1);
    expect(s.progress).toBeGreaterThan(0.999);
    clock.advance(10 * MIN); // no tick yet: the snapshot itself must still be sane
    s = engine.getSnapshot();
    expect(s.remainingMs).toBe(0);
    expect(s.progress).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('options and lifecycle', () => {
  it('custom durations and longBreakEvery are honoured; test clock flag surfaces', () => {
    const clock = createManualClock(T0, true);
    const engine = createTimerEngine({
      clock,
      storage: createStorage('memory', KEY),
      durations: { focus: 2000, short: 500, long: 1000 },
      longBreakEvery: 2,
      idFactory: idSequence(),
    });
    expect(engine.getSnapshot().testClock).toBe(true);
    expect(engine.getSnapshot().remainingMs).toBe(2000);
    engine.start();
    clock.advance(2000);
    engine.tick();
    expect(engine.getSnapshot().mode).toBe('short');
    expect(engine.getSnapshot().remainingMs).toBe(500);
    engine.setMode('focus');
    engine.start();
    clock.advance(2000);
    engine.tick();
    expect(engine.getSnapshot().mode).toBe('long');
    expect(engine.getSnapshot().remainingMs).toBe(1000);
    // minutes recorded follow the configured focus duration
    expect(engine.getSnapshot().today.minutes).toBeCloseTo((2 * 2000) / 60_000, 9);
  });

  it('default id factory yields unique non-empty ids', () => {
    const engine = createTimerEngine({ clock: createManualClock(T0), storage: createStorage('memory', KEY) });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      engine.start();
      const id = engine.getSnapshot().sessionId;
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(8);
      ids.add(id as string);
      engine.reset();
    }
    expect(ids.size).toBe(20);
  });

  it('listeners can unsubscribe; dispose stops all events and API calls', async () => {
    const { engine, clock, events } = boot();
    const got: string[] = [];
    const off = engine.on((e) => got.push(e.type));
    engine.start();
    off();
    clock.advance(2000);
    engine.tick();
    expect(got).toEqual(['restore', 'start']);
    engine.dispose();
    const n = events.length;
    engine.pause();
    engine.tick();
    engine.setTask('after dispose');
    await Promise.resolve();
    expect(events.length).toBe(n);
  });

  it('a listener that throws does not break the engine or other listeners', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { engine, events } = boot();
      engine.on(() => {
        throw new Error('boom');
      });
      engine.start();
      expect(types(events)).toContain('start');
      expect(engine.getSnapshot().status).toBe('running');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('review fixes - rollover notification, boot ordering, overdue discard, clamps, late listeners', () => {
  it('a day rollover while idle emits exactly one tick carrying the fresh today record', () => {
    const ctx = boot(local(2026, 9, 6, 22, 0));
    const { engine, clock, events } = ctx;
    expect(runFocus(ctx)).toBe(1);
    engine.tick();
    const n = events.length;
    clock.set(local(2026, 9, 7, 0, 0, 0));
    engine.tick();
    engine.tick();
    expect(events.length).toBe(n + 1);
    const last = events[events.length - 1];
    expect(last.type).toBe('tick');
    expect(last.snap.today).toEqual({ dateKey: '2026-09-07', count: 0, minutes: 0 });
    expect(last.snap.completedFocusCount).toBe(1);
    expect(last.snap.status).toBe('idle');
  });

  it('a day rollover while paused emits one tick and keeps the paused remaining time', () => {
    const { engine, clock, events } = boot(local(2026, 9, 6, 23, 50));
    engine.start();
    clock.advance(2 * MIN);
    engine.pause();
    engine.tick();
    const n = events.length;
    clock.set(local(2026, 9, 7, 0, 5));
    engine.tick();
    engine.tick();
    expect(events.length).toBe(n + 1);
    const last = events[events.length - 1];
    expect(last.type).toBe('tick');
    expect(last.snap.status).toBe('paused');
    expect(last.snap.remainingMs).toBe(FOCUS - 2 * MIN);
    expect(last.snap.today.dateKey).toBe('2026-09-07');
  });

  it('reset() / setMode() while idle after a rollover report the new day once', () => {
    const { engine, clock, events } = boot(local(2026, 9, 6, 23, 0));
    engine.tick();
    const n = events.length;
    clock.set(local(2026, 9, 7, 1, 0));
    engine.reset();
    expect(events.length).toBe(n + 1);
    expect(events[n].type).toBe('tick');
    expect(events[n].snap.today.dateKey).toBe('2026-09-07');
    engine.setMode('focus');
    expect(events.length).toBe(n + 1);
  });

  it('boot events arrive as restore, completion, then storageError even when the completion save fails', async () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.engine.dispose();
    backend.failWrites = true;
    const b = boot(T0 + FOCUS + MIN, backend, idSequence('b'));
    await Promise.resolve();
    expect(types(b.events)).toEqual(['restore', 'focusComplete', 'storageError']);
    const r = b.events[0];
    if (r.type === 'restore') expect(r.completedWhileAway).toBe(true);
    expect(b.engine.getSnapshot().storageOk).toBe(false);
    expect(b.engine.getSnapshot().today.count).toBe(1);
  });

  it('reset() on an overdue un-ticked session completes it once instead of discarding', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(FOCUS + MIN);
    engine.reset();
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    expect(types(events)).not.toContain('reset');
    const s = engine.getSnapshot();
    expect(s.status).toBe('idle');
    expect(s.mode).toBe('short');
    expect(s.today.count).toBe(1);
    expect(s.completedFocusCount).toBe(1);
    engine.tick();
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
  });

  it('setMode() on an overdue un-ticked session completes it once, then applies the requested mode', () => {
    const { engine, clock, events } = boot();
    engine.start();
    clock.advance(FOCUS + MIN);
    engine.setMode('long');
    expect(types(events).filter((t) => t === 'focusComplete')).toHaveLength(1);
    const i = types(events).indexOf('focusComplete');
    expect(types(events).indexOf('modeChange')).toBeGreaterThan(i);
    const s = engine.getSnapshot();
    expect(s.mode).toBe('long');
    expect(s.status).toBe('idle');
    expect(s.remainingMs).toBe(LONG);
    expect(s.today.count).toBe(1);
    expect(s.completedFocusCount).toBe(1);
    // requesting the mode the completion already produced is a plain no-op after the record
    const { engine: e2, clock: c2, events: ev2 } = boot();
    e2.start();
    c2.advance(FOCUS + MIN);
    e2.setMode('short');
    expect(types(ev2).filter((t) => t === 'focusComplete')).toHaveLength(1);
    expect(types(ev2)).not.toContain('modeChange');
    expect(e2.getSnapshot().mode).toBe('short');
  });

  it('a restored endAt further away than one full session is clamped (tampered data / clock skew)', async () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.engine.dispose();
    const p = stored(backend);
    p.endAt = T0 + 10 * 24 * 60 * MIN; // ten days
    backend.data.set(KEY, JSON.stringify(p));
    const b = boot(T0 + MIN, backend);
    const s = b.engine.getSnapshot();
    expect(s.status).toBe('running');
    expect(s.remainingMs).toBe(FOCUS);
    expect(s.endAt).toBe(T0 + MIN + FOCUS);
    expect(s.progress).toBe(0);
    expect(stored(backend).endAt).toBe(T0 + MIN + FOCUS); // the clamp is persisted
    await Promise.resolve();
    expect(types(b.events)).toEqual(['restore']);
    b.clock.advance(FOCUS);
    b.engine.tick();
    expect(types(b.events).filter((t) => t === 'focusComplete')).toHaveLength(1);
  });

  it('a listener attached after the boot microtask still receives the boot events', async () => {
    const backend = fakeBackend();
    const a = boot(T0, backend);
    a.engine.start();
    a.engine.dispose();
    const clock = createManualClock(T0 + 6 * 60 * MIN);
    const engine = createTimerEngine({
      clock,
      storage: createStorage('local', KEY, backend),
      idFactory: idSequence('b'),
    });
    await Promise.resolve();
    await Promise.resolve();
    const events: TimerEvent[] = [];
    engine.on((e) => events.push(e));
    expect(events).toEqual([]); // still asynchronous, never re-entrant
    await Promise.resolve();
    expect(types(events)).toEqual(['restore', 'focusComplete']);
    const r = events[0];
    if (r.type === 'restore') expect(r.completedWhileAway).toBe(true);
    // delivered once only
    await Promise.resolve();
    engine.tick();
    expect(types(events)).toEqual(['restore', 'focusComplete']);
  });

  it('a late listener gets the boot events followed by a fresh tick when the state moved meanwhile', async () => {
    const clock = createManualClock(T0);
    const engine = createTimerEngine({ clock, storage: createStorage('memory', KEY), idFactory: idSequence() });
    await Promise.resolve();
    engine.start(); // nobody listening yet
    clock.advance(5000);
    engine.tick();
    const events: TimerEvent[] = [];
    engine.on((e) => events.push(e));
    await Promise.resolve();
    expect(types(events)).toEqual(['restore', 'tick']);
    expect(events[0].snap.status).toBe('idle');
    expect(events[1].snap.status).toBe('running');
    expect(events[1].snap.remainingMs).toBe(FOCUS - 5000);
  });
});
