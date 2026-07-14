import { describe, expect, it } from "vitest";
import { assertByteQuota, QuotaError } from "./bytes.js";
import { assertObjectQuota } from "./objects.js";
import { RateLimiter } from "./rateLimit.js";

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
});
