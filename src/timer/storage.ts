// Persistence adapter. Every browser storage access is wrapped in try/catch:
// Storage may throw on *access* (privacy modes, sandboxed iframes, disabled cookies),
// on read (SecurityError) and on write (QuotaExceededError). The engine keeps working in
// memory whenever this adapter reports failure. Unknown / corrupt JSON is ignored, never
// "repaired" in place, and other keys are never touched.
import type { Mode, PersistedState, Status, StorageAdapter, TodayRecord } from './types';

export type StorageKind = 'local' | 'session' | 'memory';

/** The subset of the Web Storage API we rely on (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MODES: ReadonlySet<string> = new Set<Mode>(['focus', 'short', 'long']);
const STATUSES: ReadonlySet<string> = new Set<Status>(['idle', 'running', 'paused']);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => isFiniteNumber(v) && v >= 0 && Math.floor(v) === v;
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseToday(v: unknown): TodayRecord | null {
  if (!isRecord(v)) return null;
  const { dateKey, count, minutes } = v;
  if (typeof dateKey !== 'string' || !DATE_KEY_RE.test(dateKey)) return null;
  if (!isNonNegInt(count) || !isFiniteNumber(minutes) || minutes < 0) return null;
  return { dateKey, count, minutes };
}

/**
 * Validate an arbitrary decoded JSON value against the PersistedState shape.
 * Returns a fresh, sanitized object or null when anything is off (wrong version, unknown
 * enum values, non-finite numbers, ...). Strict on purpose: a half-valid record could
 * otherwise double-count a session or start a timer with NaN.
 */
export function parsePersistedState(raw: unknown): PersistedState | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const { mode, status, endAt, remainingMs, sessionId, completedFocusCount, task, lastCompletedSessionId } = raw;
  if (typeof mode !== 'string' || !MODES.has(mode)) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  if (!(endAt === null || isFiniteNumber(endAt))) return null;
  if (!isFiniteNumber(remainingMs) || remainingMs < 0) return null;
  if (!isNullableString(sessionId)) return null;
  if (!isNonNegInt(completedFocusCount)) return null;
  const today = parseToday(raw.today);
  if (!today) return null;
  if (typeof task !== 'string') return null;
  if (!isNullableString(lastCompletedSessionId)) return null;
  return {
    version: 1,
    mode: mode as Mode,
    status: status as Status,
    endAt,
    remainingMs,
    sessionId,
    completedFocusCount,
    today,
    task,
    lastCompletedSessionId,
  };
}

/** Resolve window.localStorage / sessionStorage without ever throwing. */
function resolveWebStorage(kind: 'local' | 'session'): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    const store: unknown = kind === 'local' ? window.localStorage : window.sessionStorage;
    if (!store) return null;
    const s = store as StorageLike;
    if (typeof s.getItem !== 'function' || typeof s.setItem !== 'function') return null;
    return s;
  } catch {
    return null;
  }
}

class MemoryStore implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * Build a StorageAdapter.
 *  - 'local' / 'session': window.localStorage / sessionStorage. `available` is false when the
 *    storage object cannot be reached or a probe read throws; load() and save() then behave as
 *    "nothing stored" / "write failed" so the engine keeps running in memory.
 *  - 'memory': a Map that lives as long as the page (QA runs, `?storage=memory`).
 *  - `backend` (extension, optional): inject any StorageLike; used by the tests to simulate
 *    quota errors and corrupt payloads.
 */
export function createStorage(kind: StorageKind, key: string, backend?: StorageLike): StorageAdapter {
  const store: StorageLike | null =
    backend ?? (kind === 'memory' ? new MemoryStore() : resolveWebStorage(kind));

  let available = false;
  if (store) {
    try {
      // Probe read: a blocked Storage may only throw on first use.
      store.getItem(key);
      available = true;
    } catch {
      available = false;
    }
  }

  return {
    get available() {
      return available;
    },
    load(): PersistedState | null {
      if (!store) return null;
      let text: string | null;
      try {
        text = store.getItem(key);
      } catch {
        available = false;
        return null;
      }
      if (text === null || text === undefined) return null;
      try {
        return parsePersistedState(JSON.parse(text));
      } catch {
        // Corrupt JSON: ignore and start fresh. Not removed; other keys never touched.
        return null;
      }
    },
    save(state: PersistedState): boolean {
      if (!store) return false;
      try {
        store.setItem(key, JSON.stringify(state));
        available = true;
        return true;
      } catch {
        available = false;
        return false;
      }
    },
  };
}
