import { QuotaError } from "./bytes.js";

/**
 * Per-subject sliding-window rate limiter (spec §gfs-controller Quotas; plan
 * P4-S03). Caps mint + write ops per subject so a compromised agent cannot flood
 * gfsc; exceeding → rate_limited. In-memory per reader; the durable counter is a
 * follow-up. Clock is injectable for deterministic tests.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) {
      throw new Error("RateLimiter: limit and windowMs must be > 0");
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Record a hit for `subject`; throw rate_limited if over the limit in the window. */
  check(subject: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(subject) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      throw new QuotaError("rate_limited", `rate limit exceeded for ${subject}`);
    }
    recent.push(now);
    this.hits.set(subject, recent);
  }
}
