import { describe, expect, it } from "vitest";
import { assertByteQuota, QuotaError } from "./bytes.js";
import { assertObjectQuota } from "./objects.js";
import { RateLimiter, RateLimitExceededError, buildAgentRateLimits } from "./rateLimit.js";

/**
 * P4-S03 — byte + object quotas and per-subject rate limit. Exceeding any →
 * QuotaError (quota_exceeded / rate_limited), capping a small-file flood.
 */

describe("assertByteQuota", () => {
  it("allows a write within the limit", () => {
    expect(() => assertByteQuota(100, 50, 200)).not.toThrow();
    expect(() => assertByteQuota(150, 50, 200)).not.toThrow(); // exactly at limit
  });
  it("rejects a write that exceeds the limit", () => {
    expect(() => assertByteQuota(150, 51, 200)).toThrow(QuotaError);
    try {
      assertByteQuota(150, 51, 200);
    } catch (e) {
      expect((e as QuotaError).code).toBe("byte_quota_exceeded");
    }
  });
  it("treats a negative limit as unlimited", () => {
    expect(() => assertByteQuota(1e9, 1e9, -1)).not.toThrow();
  });
});

describe("assertObjectQuota", () => {
  it("rejects exceeding the object count", () => {
    expect(() => assertObjectQuota(9, 1, 10)).not.toThrow();
    expect(() => assertObjectQuota(10, 1, 10)).toThrow(QuotaError);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit, then rate_limits within the window", () => {
    let t = 1000;
    const rl = new RateLimiter({ limit: 3, windowMs: 100, now: () => t });
    rl.check("host:1st:x");
    rl.check("host:1st:x");
    rl.check("host:1st:x");
    expect(() => rl.check("host:1st:x")).toThrow(QuotaError);
    try {
      rl.check("host:1st:x");
    } catch (e) {
      expect((e as QuotaError).code).toBe("rate_limited");
    }
  });

  it("resets after the window elapses", () => {
    let t = 1000;
    const rl = new RateLimiter({ limit: 1, windowMs: 100, now: () => t });
    rl.check("s");
    expect(() => rl.check("s")).toThrow();
    t += 101; // window elapsed
    expect(() => rl.check("s")).not.toThrow();
  });

  it("tracks subjects independently", () => {
    let t = 1000;
    const rl = new RateLimiter({ limit: 1, windowMs: 100, now: () => t });
    rl.check("a");
    expect(() => rl.check("b")).not.toThrow();
  });

  it("L2: never states a Retry-After longer than the window, even after the clock steps back", () => {
    let t = 1_000_000;
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => t });
    rl.check("s");
    t -= 300_000;
    let denial: unknown;
    try {
      rl.check("s");
    } catch (err) {
      denial = err;
    }
    expect(denial).toBeInstanceOf(RateLimitExceededError);
    expect((denial as RateLimitExceededError).retryAfterSeconds).toBe(60);
  });

  it("L13: denies and sweeps a window holding 130 000 hits without a RangeError", () => {
    let t = 1_000_000;
    const limit = 130_000;
    const rl = new RateLimiter({ limit, windowMs: 60_000, now: () => t });
    for (let i = 0; i < limit; i += 1) rl.check("s");
    let denial: unknown;
    try {
      rl.check("s");
    } catch (err) {
      denial = err;
    }
    expect(denial).toBeInstanceOf(RateLimitExceededError);
    expect((denial as RateLimitExceededError).retryAfterSeconds).toBe(60);
    t += 60_001;
    expect(() => rl.check("other")).not.toThrow();
    // Witness: the sweep ran and evicted the full subject.
    expect(rl.trackedSubjectCount).toBe(1);
  });

  it("L13: keeps each check constant-time on a full window at the configured maximum", () => {
    // 60 000/min is AGENT_RL_PER_MIN_MAX. One hit per millisecond for three
    // windows keeps the window full: every check from the second window on
    // evicts exactly one hit and records one. A check that rescans the window
    // costs 1.2e5 × 6e4 comparisons here, minutes rather than milliseconds, so
    // the bound separates the two by orders of magnitude on any machine.
    let t = 0;
    const limit = 60_000;
    const rl = new RateLimiter({ limit, windowMs: 60_000, now: () => t });
    const started = performance.now();
    for (t = 1; t <= 3 * limit; t += 1) rl.check("s");
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(2_000);
    // Witness: the window is really full, so the loop ran at the limit.
    t -= 1;
    expect(() => rl.check("s")).toThrow(RateLimitExceededError);
  });
});

describe("buildAgentRateLimits", () => {
  it("builds the read and the write limiter from their own budgets on the given clock", () => {
    let t = 1_000_000;
    const limits = buildAgentRateLimits(
      { agentReadRlPerMinPerReplica: 5, agentWriteRlPerMinPerReplica: 2 },
      () => t
    );
    expect(limits.reads.limitPerWindow).toBe(5);
    expect(limits.writes.limitPerWindow).toBe(2);
    expect(limits.reads.windowLengthMs).toBe(60_000);
    expect(limits.writes.windowLengthMs).toBe(60_000);
    limits.writes.check("s");
    limits.writes.check("s");
    expect(() => limits.writes.check("s")).toThrow(RateLimitExceededError);
    t += 60_001;
    expect(() => limits.writes.check("s")).not.toThrow();
  });
});
