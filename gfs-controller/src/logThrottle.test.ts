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

  it("sends every key past maxKeys to one shared overflow entry, so an interval writes at most maxKeys + 1 lines", () => {
    let t = 1_000;
    const throttle = new LogThrottle(60_000, () => t, 3);

    const tracked = ["a", "b", "c"].map((key) => throttle.admit(key));
    const overflow = Array.from({ length: 50 }, (_, i) => throttle.admit(`new-${i}`));

    // Witness: the three tracked keys each got their line.
    expect(tracked).toEqual([0, 0, 0]);
    // Fifty distinct new keys share one line between them.
    expect(overflow.filter((r) => r !== undefined)).toEqual([0]);
    expect(throttle.trackedKeyCount).toBe(4);
    // A tracked key is still throttled on its own entry.
    expect(throttle.admit("a")).toBeUndefined();

    t += 60_000;
    // The overflow line carries the combined count of the 49 it suppressed.
    expect(throttle.admit("new-999")).toBe(49);
  });

  it("tracks at most 1 000 keys by default", () => {
    const t = 1_000;
    const throttle = new LogThrottle(60_000, () => t);
    const admitted = Array.from({ length: 5_000 }, (_, i) => throttle.admit(`k${i}`)).filter(
      (r) => r !== undefined,
    );
    expect(admitted).toHaveLength(1_001);
    expect(throttle.trackedKeyCount).toBe(1_001);
  });

  it("rejects a non-positive interval and a non-positive key cap", () => {
    expect(() => new LogThrottle(0)).toThrow(/intervalMs must be > 0/);
    expect(() => new LogThrottle(1_000, () => 0, 0)).toThrow(/maxKeys must be a positive integer/);
    expect(() => new LogThrottle(1_000, () => 0, 1.5)).toThrow(
      /maxKeys must be a positive integer/,
    );
  });
});
