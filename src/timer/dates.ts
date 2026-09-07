// Local-date helpers. Records are aggregated by the device's LOCAL calendar day.

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 'YYYY-MM-DD' of the given epoch ms in the device's local time zone. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Epoch ms of the local midnight that starts the day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Compare two 'YYYY-MM-DD' keys. Negative when a < b, 0 when equal, positive when a > b.
 * Zero-padded keys sort lexicographically, so plain string comparison is exact.
 */
export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
