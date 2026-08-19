import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineCommitOutcomeUnknownError, withDeadlineTransaction } from "./deadlineQuery";

class Pool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  releaseError: Error | boolean | undefined;
  fail = "";
  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        this.calls.push({ sql, values });
        if (sql === this.fail) throw Object.assign(new Error(`failed ${sql}`), sql.includes("pg_sleep") ? { code: "57014" } : {});
        return { rows: [{ ok: true }] };
      },
      release: (error?: Error | boolean) => { this.releaseError = error; },
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deadline-bounded PostgreSQL transactions", () => {
  it("installs statement_timeout before useful SQL in one checked-out READ ONLY transaction", async () => {
    const pool = new Pool();
    await withDeadlineTransaction(pool, { deadlineAtMs: 5000, now: () => 1000 }, true,
      client => client.query("SELECT pg_sleep(0)"));
    expect(pool.calls).toEqual([
      { sql: "BEGIN READ ONLY", values: [] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", values: ["4000"] },
      { sql: "SELECT pg_sleep(0)", values: [] },
      { sql: "COMMIT", values: [] },
    ]);
  });

  it("maps a real PostgreSQL statement-timeout code after rollback", async () => {
    const pool = new Pool(); pool.fail = "SELECT pg_sleep(10)";
    await expect(withDeadlineTransaction(pool, { deadlineAtMs: 5000, now: () => 1000 }, true,
      client => client.query("SELECT pg_sleep(10)"))).rejects.toMatchObject({ code: "precondition_failed" });
    expect(pool.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(pool.releaseError).toBeUndefined();
  });

  it("destroys the connection and preserves commit ambiguity", async () => {
    const pool = new Pool(); pool.fail = "COMMIT";
    await expect(withDeadlineTransaction(pool, { deadlineAtMs: 5000, now: () => 1000 }, false,
      client => client.query("UPDATE durable_state SET value = 1"))).rejects.toBeInstanceOf(DeadlineCommitOutcomeUnknownError);
    expect(pool.releaseError).toBeInstanceOf(Error);
  });

  it("bounds pool acquisition and releases a client that arrives after the deadline without issuing SQL", async () => {
    vi.useFakeTimers();
    const acquisition = deferred<Awaited<ReturnType<Pool["connect"]>>>();
    const lateClient = await new Pool().connect();
    const query = vi.spyOn(lateClient, "query");
    const release = vi.spyOn(lateClient, "release");
    const operation = vi.fn();
    const pool = { connect: () => acquisition.promise };

    const transaction = withDeadlineTransaction(
      pool,
      { deadlineAtMs: 10, now: () => 0 },
      true,
      operation
    );
    const rejected = expect(transaction).rejects.toMatchObject({ code: "precondition_failed" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    expect(operation).not.toHaveBeenCalled();
    acquisition.resolve(lateClient);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-arms deadlines larger than Node's maximum timer delay instead of expiring early", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const maxTimerMs = 2_147_483_647;
    const acquisition = deferred<Awaited<ReturnType<Pool["connect"]>>>();
    const transaction = withDeadlineTransaction(
      { connect: () => acquisition.promise },
      { deadlineAtMs: maxTimerMs + 50 },
      true,
      vi.fn()
    );
    let settled = false;
    void transaction.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(maxTimerMs);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    const rejected = expect(transaction).rejects.toMatchObject({ code: "precondition_failed" });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it("handles a pool acquisition that rejects after the deadline", async () => {
    vi.useFakeTimers();
    const acquisition = deferred<Awaited<ReturnType<Pool["connect"]>>>();
    const operation = vi.fn();
    const transaction = withDeadlineTransaction(
      { connect: () => acquisition.promise },
      { deadlineAtMs: 5, now: () => 0 },
      false,
      operation
    );
    const rejected = expect(transaction).rejects.toMatchObject({ code: "precondition_failed" });
    await vi.advanceTimersByTimeAsync(5);
    await rejected;

    acquisition.reject(new Error("late connect failure"));
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
  });

  it("abandons a pending pool acquisition when the request is aborted", async () => {
    const acquisition = deferred<Awaited<ReturnType<Pool["connect"]>>>();
    const controller = new AbortController();
    const lateClient = await new Pool().connect();
    const query = vi.spyOn(lateClient, "query");
    const release = vi.spyOn(lateClient, "release");
    const operation = vi.fn();
    const transaction = withDeadlineTransaction(
      { connect: () => acquisition.promise },
      { deadlineAtMs: Date.now() + 10_000, signal: controller.signal },
      true,
      operation
    );

    controller.abort();
    await expect(transaction).rejects.toMatchObject({ code: "precondition_failed" });
    acquisition.resolve(lateClient);
    await Promise.resolve();

    expect(operation).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not start pool acquisition for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();

    await expect(withDeadlineTransaction(
      { connect },
      { deadlineAtMs: Date.now() + 10_000, signal: controller.signal },
      true,
      vi.fn()
    )).rejects.toMatchObject({ code: "precondition_failed" });
    expect(connect).not.toHaveBeenCalled();
  });
});
