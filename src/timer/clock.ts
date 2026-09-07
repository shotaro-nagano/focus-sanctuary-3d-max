// Clock sources for the timer engine. The engine never reads Date.now() itself;
// it only asks the injected Clock, which makes every rule testable with a fake.
import type { Clock } from './types';

/**
 * Create a wall clock.
 *  - speed 1 (default): real epoch milliseconds.
 *  - speed > 1 (test clock, `?speed=60`): elapsed real time since `originMs` is multiplied,
 *    so `now = origin + (Date.now() - origin) * speed`. Marked `isTest` so the UI can label it.
 * Production durations are never changed by a test clock; only the perceived passage of time is.
 */
export function createClock(speed = 1, originMs: number = Date.now()): Clock {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (s === 1) {
    return Object.freeze({
      now: () => Date.now(),
      isTest: false,
    });
  }
  const origin = Number.isFinite(originMs) ? originMs : Date.now();
  return Object.freeze({
    now: () => origin + (Date.now() - origin) * s,
    isTest: true,
  });
}

/** A clock that only moves when told to. Used by the tests (and handy for dev harnesses). */
export interface ManualClock extends Clock {
  /** jump to an absolute epoch ms */
  set(ms: number): void;
  /** move forward (or backward) by ms */
  advance(ms: number): void;
}

export function createManualClock(startMs: number, isTest = false): ManualClock {
  let t = startMs;
  return {
    now: () => t,
    isTest,
    set(ms: number) {
      t = ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}
