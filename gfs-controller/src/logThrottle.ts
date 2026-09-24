/** Distinct keys one throttle tracks before new keys share a single entry. */
export const LOG_THROTTLE_MAX_KEYS = 1_000;

/**
 * Bounds how many lines one event writes: at most one per key per interval.
 * A suppressed event is only counted, and the next admitted line for that key
 * carries the count, so no occurrence disappears from the log without a trace.
 * Callers keep their metrics unthrottled; this only sheds log volume, such as
 * one warn line per request from a client retrying a rate-limit denial.
 *
 * Keys idle for two intervals are dropped by a sweep that runs at most once per
 * interval, so the map is bounded by the keys active in the last two intervals.
 * A count still pending when its key is swept is lost from the log, not from
 * the metrics.
 *
 * Keys often come from clients, and a client can send a new one on every
 * request. Once `maxKeys` keys are tracked, every key not already tracked shares
 * one overflow entry: together they get at most one line per interval, and that
 * line carries their combined suppressed count. So one interval writes at most
 * `maxKeys + 1` lines, and the map holds at most `maxKeys + 1` entries.
 *
 * Same semantics as control-api's `src/observability/logThrottle.ts`.
 */
export class LogThrottle {
  private readonly entries = new Map<string, { emittedAt: number; suppressed: number }>();
  private lastSweep: number;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys: number = LOG_THROTTLE_MAX_KEYS,
  ) {
    if (!(intervalMs > 0)) throw new Error("LogThrottle: intervalMs must be > 0");
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new Error("LogThrottle: maxKeys must be a positive integer");
    }
    this.lastSweep = now();
  }

  /** Number of keys currently held. Read by tests to observe the sweep. */
  get trackedKeyCount(): number {
    return this.entries.size;
  }

  /**
   * Record one event for `key`. Returns the number of events suppressed since
   * the key's previous line when a line is due now, or `undefined` when this
   * event is suppressed.
   */
  admit(key: string): number | undefined {
    const now = this.now();
    this.sweep(now);
    const trackedKey =
      this.entries.has(key) || this.entries.size < this.maxKeys ? key : OVERFLOW_KEY;
    const entry = this.entries.get(trackedKey);
    if (entry && now - entry.emittedAt < this.intervalMs) {
      entry.suppressed += 1;
      return undefined;
    }
    this.entries.set(trackedKey, { emittedAt: now, suppressed: 0 });
    return entry?.suppressed ?? 0;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.intervalMs) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.emittedAt >= 2 * this.intervalMs) this.entries.delete(key);
    }
    this.lastSweep = now;
  }
}

// A NUL byte cannot appear in a key built from a denial kind and a hex hash,
// so the overflow entry cannot collide with a real key.
const OVERFLOW_KEY = "\u0000overflow";
