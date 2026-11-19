import type { EventEmitter } from "node:events";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGfsPool } from "./pool";
import { PgTransactor, RollbackOutcomeUnknownError } from "./writeStore";

// The unit suite drives pg-pool with a stand-in client. This suite lets real
// PostgreSQL end the backends with pg_terminate_backend, which sends the same
// FATAL 57P01 a Postgres restart sends (issue #700). Without the listeners the
// real pg Client's `error` emit is an uncaught exception, which vitest reports
// as a failed run. Gated like the other real-PG suites.
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL;
const describeRealPostgres = adminUrl ? describe : describe.skip;

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describeRealPostgres("gfs pool connection errors on real PostgreSQL", () => {
  const database = `gfsc_pool_errors_${Date.now()}`;
  let adminPool: Pool;

  async function terminate(pid: number): Promise<void> {
    const { rows } = await adminPool.query("SELECT pg_terminate_backend($1) AS terminated", [pid]);
    expect(rows[0].terminated).toBe(true);
    await vi.waitFor(
      async () => {
        const gone = await adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1", [pid]);
        expect(gone.rows[0].n).toBe(0);
      },
      { timeout: 5_000, interval: 20 }
    );
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE ${database}`);
  });

  afterAll(async () => {
    if (!adminPool) return;
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  });

  it("survives a terminated idle pooled connection and reconnects on the next query", async () => {
    const log = vi.fn();
    const pool = createGfsPool(databaseUrl(adminUrl as string, database), log);
    try {
      const before = await pool.query("SELECT pg_backend_pid() AS pid");
      const pid = before.rows[0].pid as number;
      expect(pool.idleCount).toBe(1);

      await terminate(pid);
      // Liveness witness: the pool handler logged the server's 57P01.
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce(), { timeout: 5_000, interval: 20 });
      expect(log.mock.calls[0][0]).toBe(
        "[gfsc] pg pool discarded an idle client after a connection error: " +
          "57P01 terminating connection due to administrator command"
      );
      expect(pool.totalCount).toBe(0);

      const after = await pool.query("SELECT pg_backend_pid() AS pid");
      expect(after.rows[0].pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });

  it("fails a transaction whose connection is terminated while idle in transaction, then serves the next one", async () => {
    const log = vi.fn();
    const pool = createGfsPool(databaseUrl(adminUrl as string, database), log);
    const transactor = new PgTransactor(pool);
    let terminatedPid: number | undefined;
    try {
      const failure = await transactor
        .transaction(async (client) => {
          const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
          terminatedPid = rows[0].pid as number;
          const ended = new Promise<void>((resolve) => (client as unknown as EventEmitter).once("end", resolve));
          await terminate(terminatedPid);
          await ended;
          return client.query("SELECT 1");
        })
        .then(
          () => undefined,
          (err: unknown) => err
        );

      expect(terminatedPid).toBeTypeOf("number");
      expect(failure).toBeInstanceOf(RollbackOutcomeUnknownError);
      expect((failure as RollbackOutcomeUnknownError).cause).toMatchObject({
        message: "Client has encountered a connection error and is not queryable",
      });
      expect(pool.totalCount).toBe(0);
      expect(log).not.toHaveBeenCalled();

      const next = await transactor.transaction((client) => client.query("SELECT pg_backend_pid() AS pid"));
      expect(next.rows[0].pid).not.toBe(terminatedPid);
    } finally {
      await pool.end();
    }
  });
});
