import { describe, it, expect, vi } from "vitest";
import { withRetry, computeBackoff } from "../../src/coordinator/retry";

describe("withRetry()", () => {
  it("resolves immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, backoffSeconds: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on failure and succeeds on second attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, backoffSeconds: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after maxAttempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { maxAttempts: 3, backoffSeconds: 0 }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry callback with attempt number and error", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockResolvedValue("ok");
    await withRetry(fn, { maxAttempts: 3, backoffSeconds: 0, onRetry });
    expect(onRetry).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ message: "e1" }),
    );
  });

  it("does not call onRetry when first attempt succeeds", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue("ok");
    await withRetry(fn, { maxAttempts: 3, backoffSeconds: 0, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("calls onRetry for each retry attempt", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue("ok");
    await withRetry(fn, { maxAttempts: 4, backoffSeconds: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it("works with maxAttempts=1 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(
      withRetry(fn, { maxAttempts: 1, backoffSeconds: 0 }),
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("throws Error (not undefined) when maxAttempts is 0", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(
      withRetry(fn, { maxAttempts: 0, backoffSeconds: 0 }),
    ).rejects.toThrow("maxAttempts must be >= 1");
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws Error (not undefined) when maxAttempts is negative", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(
      withRetry(fn, { maxAttempts: -1, backoffSeconds: 0 }),
    ).rejects.toThrow("maxAttempts must be >= 1");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("computeBackoff()", () => {
  it("returns base backoff for attempt 1", () => {
    expect(computeBackoff(5, 1)).toBe(5);
  });

  it("doubles for attempt 2", () => {
    expect(computeBackoff(5, 2)).toBe(10);
  });

  it("quadruples for attempt 3", () => {
    expect(computeBackoff(5, 3)).toBe(20);
  });

  it("caps at 300 seconds", () => {
    expect(computeBackoff(10, 6)).toBe(300);
  });

  it("returns 0 when backoffSeconds is 0", () => {
    expect(computeBackoff(0, 5)).toBe(0);
  });
});
