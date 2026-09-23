import type { GfsConfig } from "../config.js";
import { QuotaError } from "./bytes.js";

/**
 * A `rate_limited` denial that carries when the caller may retry. The message
 * never names the subject: the limiter is keyed by a host identity and the
 * denial can reach the caller.
 */
export class RateLimitExceededError extends QuotaError {
  constructor(readonly retryAfterSeconds: number) {
    super("rate_limited", "rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

/**
 * Per-subject sliding-window rate limiter (spec §gfs-controller Quotas; plan
 * P4-S03). Caps an agent's reads or writes so a compromised agent cannot flood
 * gfsc; exceeding → rate_limited. In-memory per process, so a budget is per
 * replica; the durable counter is a follow-up. Clock is injectable for
 * deterministic tests.
 */
export class RateLimiter {
  private readonly hits = new Map<string, SubjectWindow>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) {
      throw new Error("RateLimiter: limit and windowMs must be > 0");
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.lastSweep = this.now();
  }

  get limitPerWindow(): number {
    return this.limit;
  }

  get windowLengthMs(): number {
    return this.windowMs;
  }

  /** Number of subjects currently holding a window. Read by tests to observe eviction. */
  get trackedSubjectCount(): number {
    return this.hits.size;
  }

  /**
   * Record a hit for `subject`; throw RateLimitExceededError if the window is
   * full. Retry-after is when the oldest retained hit leaves the window, the
   * exact moment one slot frees, clamped to [1, window] so a clock stepped
   * backwards cannot state a wait longer than the window itself.
   *
   * Hits are appended in time order, so the expired ones sit at the front:
   * advancing `head` past them makes each check O(1) amortized instead of a
   * rescan of the whole window. After a backward clock step the order breaks;
   * eviction from the front then keeps extra hits, which only denies sooner.
   */
  check(subject: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    this.evictExpired(now, cutoff);
    const window = this.hits.get(subject) ?? { times: [], head: 0 };
    while (window.head < window.times.length && window.times[window.head] <= cutoff) {
      window.head += 1;
    }
    if (window.head > 0 && window.head * 2 >= window.times.length) {
      window.times = window.times.slice(window.head);
      window.head = 0;
    }
    if (window.times.length - window.head >= this.limit) {
      this.hits.set(subject, window);
      const oldest = window.times[window.head];
      const untilFreeSeconds = Math.ceil((oldest + this.windowMs - now) / 1000);
      throw new RateLimitExceededError(
        Math.min(Math.ceil(this.windowMs / 1000), Math.max(1, untilFreeSeconds)),
      );
    }
    window.times.push(now);
    this.hits.set(subject, window);
  }

  /**
   * Delete every subject whose newest hit has left the window. Runs at most once
   * per window length, inside check(), so the map is bounded by the subjects
   * active in the last two windows without a timer in the data path.
   */
  private evictExpired(now: number, cutoff: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    for (const [subject, window] of this.hits) {
      if (window.times[window.times.length - 1] <= cutoff) this.hits.delete(subject);
    }
    this.lastSweep = now;
  }
}

/** One subject's hits in arrival order; entries before `head` have expired. */
interface SubjectWindow {
  times: number[];
  head: number;
}

/**
 * The agent read and write limiters, built from their per-replica budgets with
 * a one-minute window. The single place that maps each budget to its limiter,
 * shared by the process entry point and the tests that pin the wiring.
 */
export function buildAgentRateLimits(
  config: Pick<GfsConfig, "agentReadRlPerMinPerReplica" | "agentWriteRlPerMinPerReplica">,
  now?: () => number,
): { reads: RateLimiter; writes: RateLimiter } {
  return {
    reads: new RateLimiter({ limit: config.agentReadRlPerMinPerReplica, windowMs: 60_000, now }),
    writes: new RateLimiter({ limit: config.agentWriteRlPerMinPerReplica, windowMs: 60_000, now }),
  };
}
