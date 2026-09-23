import { describe, expect, it } from "vitest";
import { LogThrottle } from "./logThrottle";

describe("LogThrottle", () => {
  it("admits the first event per key, suppresses the rest of the interval, and reports how many it dropped", () => {
    let t = 1_000;
    const throttle = new LogThrottle(60_000, () => t);

    expect(throttle.admit("a")).toBe(0);
    const inInterval = Array.from({ length: 49 }, () => throttle.admit("a"));
    // Witness: 49 events were offered and every one was suppressed.
    expect(inInterval).toHaveLength(49);
    expect(inInterval.every((r) => r === undefined)).toBe(true);

    t += 60_000;
    expect(throttle.admit("a")).toBe(49);
    expect(throttle.admit("a")).toBeUndefined();
  });

  it("throttles each key on its own", () => {
    const t = 1_000;
    const throttle = new LogThrottle(60_000, () => t);

    expect(throttle.admit("a")).toBe(0);
    expect(throttle.admit("b")).toBe(0);
    expect(throttle.admit("a")).toBeUndefined();
    expect(throttle.admit("b")).toBeUndefined();
  });

  it("keeps a pending suppressed count through a sweep until the second interval ends", () => {
    let t = 1_000;
    const throttle = new LogThrottle(60_000, () => t);
    throttle.admit("a");
    throttle.admit("a");
    throttle.admit("a");

    // Another key's event at 1.5 intervals runs the sweep first.
    t += 90_000;
    throttle.admit("b");
    expect(throttle.admit("a")).toBe(2);
  });

  it("sweeps keys idle for two intervals, so the map is bounded by the keys active recently", () => {
    let t = 1_000;
    const throttle = new LogThrottle(60_000, () => t);
    for (let i = 0; i < 1_000; i += 1) throttle.admit(`k${i}`);
    // Witness: every key is tracked before the sweep.
    expect(throttle.trackedKeyCount).toBe(1_000);

    t += 120_000;
    throttle.admit("live");
    expect(throttle.trackedKeyCount).toBe(1);
  });

  it("rejects a non-positive interval", () => {
    expect(() => new LogThrottle(0)).toThrow(/intervalMs must be > 0/);
  });
});
