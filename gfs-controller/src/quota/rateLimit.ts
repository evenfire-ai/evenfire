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
  private readonly hits = new Map<string, number[]>();
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
   * exact moment one slot frees.
   */
  check(subject: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    this.evictExpired(now, cutoff);
    const recent = (this.hits.get(subject) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(subject, recent);
      const oldest = Math.min(...recent);
      throw new RateLimitExceededError(
        Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      );
    }
    recent.push(now);
    this.hits.set(subject, recent);
  }

  /**
   * Delete every subject whose newest hit has left the window. Runs at most once
   * per window length, inside check(), so the map is bounded by the subjects
   * active in the last two windows without a timer in the data path.
   */
  private evictExpired(now: number, cutoff: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    for (const [subject, times] of this.hits) {
      if (Math.max(...times) <= cutoff) this.hits.delete(subject);
    }
    this.lastSweep = now;
  }
}
