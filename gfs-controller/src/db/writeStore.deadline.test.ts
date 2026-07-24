import { afterEach, describe, expect, it, vi } from "vitest";
import { PgTransactor, type PoolLike } from "./writeStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PgTransactor deadline-bounded acquisition", () => {
  it("releases a late client and executes no SQL after the deadline", async () => {
    vi.useFakeTimers();
    const acquisition = deferred<Awaited<ReturnType<PoolLike["connect"]>>>();
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const operation = vi.fn();
    const transaction = new PgTransactor({ connect: () => acquisition.promise }).transaction(
      operation,
      { deadlineAtMs: 10, now: () => 0 }
    );
    const rejected = expect(transaction).rejects.toMatchObject({ code: "precondition_failed" });

    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    acquisition.resolve({ query, release });
    await Promise.resolve();

    expect(operation).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
