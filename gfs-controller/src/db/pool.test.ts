import { EventEmitter } from "node:events";
import { Pool, type PoolConfig } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPermissionStoreProbe } from "../authz/storeProbe";
import { DeadlineRollbackOutcomeUnknownError, withDeadlineTransaction } from "./deadlineQuery";
import { createGfsPool } from "./pool";
import { PgTransactor, RollbackOutcomeUnknownError } from "./writeStore";

// No client in this file connects; db.invalid (RFC 2606) never resolves.
const DSN = "postgres://gfs_controller@db.invalid:5432/gfs";

type QueryResult = { rows: Record<string, unknown>[] };
type QueryCallback = (err: Error | undefined, result?: QueryResult) => void;

/**
 * Stands in for pg's Client under the real pg-pool, so the pool's own idle
 * listener, removal and re-emit run unchanged. `failConnection` does what pg's
 * Client does when its connection fails (`pg/lib/client.js:411-418`): mark the
 * client not queryable, reject the in-flight query, and emit `error`. Like any
 * EventEmitter, that emit throws when nothing listens, which in the service is
 * the uncaught exception that crashed the pod.
 */
class FakePgClient extends EventEmitter {
  static instances: FakePgClient[] = [];
  /** The next query on any client stays in flight until the connection fails. */
  static hangNextQuery = false;
  static onHang: (() => void) | undefined;

  readonly queries: string[] = [];
  ended = false;
  _queryable = true;
  _ending = false;
  private readonly inFlight: Array<(err: Error) => void> = [];

  constructor(readonly options: unknown) {
    super();
    FakePgClient.instances.push(this);
  }

  connect(callback: (err?: Error) => void): void {
    process.nextTick(() => callback());
  }

  query(text: string, values?: unknown[] | QueryCallback, callback?: QueryCallback): Promise<QueryResult> | undefined {
    const done = typeof values === "function" ? values : callback;
    const result = this.run(text);
    if (!done) return result;
    result.then((rows) => done(undefined, rows), (err: Error) => done(err));
    return undefined;
  }

  private run(text: string): Promise<QueryResult> {
    if (!this._queryable) {
      return Promise.reject(new Error("Client has encountered a connection error and is not queryable"));
    }
    this.queries.push(text);
    if (FakePgClient.hangNextQuery) {
      FakePgClient.hangNextQuery = false;
      const pending = new Promise<QueryResult>((_, reject) => this.inFlight.push(reject));
      FakePgClient.onHang?.();
      return pending;
    }
    return Promise.resolve({ rows: [{ ok: 1 }] });
  }

  failConnection(err: Error): void {
    this._queryable = false;
    for (const reject of this.inFlight.splice(0)) reject(err);
    this.emit("error", err);
  }

  end(callback?: () => void): Promise<void> {
    this._ending = true;
    this.ended = true;
    if (callback) process.nextTick(callback);
    return Promise.resolve();
  }
}

class FakeClientPool extends Pool {
  constructor(config: PoolConfig) {
    super({ ...config, Client: FakePgClient as unknown as NonNullable<PoolConfig["Client"]> });
  }
}

/** What a Postgres restart sends to every backend (fast shutdown). */
function adminShutdown(): Error {
  return Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
    severity: "FATAL",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let pools: Pool[] = [];

function gfsPool(log: (message: string) => void): Pool {
  const pool = createGfsPool(DSN, log, FakeClientPool);
  pools.push(pool);
  return pool;
}

beforeEach(() => {
  FakePgClient.instances = [];
  FakePgClient.hangNextQuery = false;
  FakePgClient.onHang = undefined;
});

afterEach(async () => {
  const open = pools;
  pools = [];
  await Promise.all(open.map((pool) => pool.end()));
});

describe("createGfsPool: idle client connection errors", () => {
  it("logs a 57P01 on an idle client, discards that client, and serves the next query on a new connection", async () => {
    const log = vi.fn();
    const pool = gfsPool(log);
    const first = await pool.connect();
    await first.query("SELECT 1");
    first.release();
    expect(pool.idleCount).toBe(1);
    const idle = FakePgClient.instances[0];

    expect(() => idle.failConnection(adminShutdown())).not.toThrow();

    // Liveness witness: the pool's handler ran, once, with the error code.
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toBe(
      "[gfsc] pg pool discarded an idle client after a connection error: " +
        "57P01 terminating connection due to administrator command"
    );
    // pg-pool attaches the client, whose options carry the DSN, to the error.
    expect(log.mock.calls[0][0]).not.toContain("db.invalid");
    expect(idle.ended).toBe(true);
    expect(pool.totalCount).toBe(0);

    await expect(pool.query("SELECT 2")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(FakePgClient.instances).toHaveLength(2);
    expect(FakePgClient.instances[1].queries).toEqual(["SELECT 2"]);
  });
});

describe("checked-out client connection errors", () => {
  it("PgTransactor: an error while idle in a transaction fails that transaction and destroys the client", async () => {
    const log = vi.fn();
    const pool = gfsPool(log);
    const transactor = new PgTransactor(pool);
    const idleInTransaction = deferred<void>();
    const resume = deferred<void>();

    const outcome = transactor.transaction(async (client) => {
      await client.query("SELECT 1");
      idleInTransaction.resolve();
      await resume.promise;
      return client.query("SELECT 2");
    });
    const settled = outcome.then(
      () => undefined,
      (err: unknown) => err
    );
    await idleInTransaction.promise;
    const checkedOut = FakePgClient.instances[0];
    expect(checkedOut.queries).toEqual(["BEGIN", "SELECT 1"]);

    try {
      expect(() => checkedOut.failConnection(adminShutdown())).not.toThrow();
    } finally {
      // Let the parked transaction finish either way, so it releases its client.
      resume.resolve();
    }

    const failure = await settled;
    expect(failure).toBeInstanceOf(RollbackOutcomeUnknownError);
    expect((failure as RollbackOutcomeUnknownError).cause).toMatchObject({
      message: "Client has encountered a connection error and is not queryable",
    });
    expect(checkedOut.queries).toEqual(["BEGIN", "SELECT 1"]);
    expect(checkedOut.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
    // The checkout listener took the error, so the pool handler did not.
    expect(log).not.toHaveBeenCalled();

    await expect(transactor.transaction((client) => client.query("SELECT 3"))).resolves.toEqual({
      rows: [{ ok: 1 }],
    });
    expect(FakePgClient.instances[1].queries).toEqual(["BEGIN", "SELECT 3", "COMMIT"]);
  });

  it("withDeadlineTransaction: an error during an in-flight query rejects the operation and destroys the client", async () => {
    const log = vi.fn();
    const pool = gfsPool(log);
    const inFlight = deferred<void>();
    FakePgClient.onHang = () => inFlight.resolve();

    const outcome = withDeadlineTransaction(pool, { deadlineAtMs: Date.now() + 60_000 }, true, (client) => {
      FakePgClient.hangNextQuery = true;
      return client.query("SELECT gfs_lookup()");
    });
    const settled = outcome.then(
      () => undefined,
      (err: unknown) => err
    );
    await inFlight.promise;
    const checkedOut = FakePgClient.instances[0];
    expect(checkedOut.queries).toEqual([
      "BEGIN READ ONLY",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT gfs_lookup()",
    ]);

    expect(() => checkedOut.failConnection(adminShutdown())).not.toThrow();

    const failure = await settled;
    expect(failure).toBeInstanceOf(DeadlineRollbackOutcomeUnknownError);
    expect((failure as DeadlineRollbackOutcomeUnknownError).cause).toMatchObject({ code: "57P01" });
    expect(checkedOut.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("permission store probe: an error during the pool ping rejects the probe and destroys the client", async () => {
    const log = vi.fn();
    const pool = gfsPool(log);
    const freshClient = vi.fn();
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: 60_000,
      storageRole: "writer",
      clientFactory: freshClient,
    });
    const inFlight = deferred<void>();
    FakePgClient.hangNextQuery = true;
    FakePgClient.onHang = () => inFlight.resolve();

    const ping = probe();
    const settled = ping.then(
      () => undefined,
      (err: unknown) => err
    );
    await inFlight.promise;
    const checkedOut = FakePgClient.instances[0];
    expect(checkedOut.queries).toEqual(["SELECT 1"]);

    expect(() => checkedOut.failConnection(adminShutdown())).not.toThrow();

    expect(await settled).toMatchObject({ code: "57P01" });
    expect(checkedOut.ended).toBe(true);
    expect(pool.totalCount).toBe(0);
    expect(freshClient).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

/** Every coherence field a passing writer probe reads (authz/storeProbe.ts). */
const WRITER_COHERENCE_ROW: Record<string, unknown> = Object.fromEntries(
  [
    "can_read",
    "can_audit",
    "can_read_blob_key",
    "can_read_digest",
    "can_read_manifests",
    "resource_schema_ready",
    "manifest_schema_ready",
    "can_insert_manifests",
    "can_update_manifests",
    "can_delete_manifests",
    "can_insert_resources",
    "can_update_resources",
    "audit_decision_evidence_schema_ready",
    "audit_decision_evidence_constraints_ready",
    "audit_actor_correlation_columns_ready",
    "audit_actor_correlation_constraint_ready",
    "authority_users_columns_ready",
    "authority_admin_columns_ready",
    "authority_admin_session_epoch_ready",
    "authority_links_columns_ready",
    "authority_users_privileges_ready",
    "authority_admin_privileges_ready",
    "authority_links_privileges_ready",
  ].map((field) => [field, true])
);

/**
 * Stands in for the probe's standalone pg Client. `failConnection` does what
 * pg does on a connection failure (`pg/lib/client.js:411-418`): reject the
 * in-flight query and emit `error`, which throws when nothing listens.
 */
class FakeProbeClient extends EventEmitter {
  /** When set, the coherence query stays in flight until the connection fails. */
  hangQuery = false;
  /** Emitted before the query result is returned (outside any pending call). */
  errorBeforeResult: Error | undefined;
  /** Emitted while end() runs. */
  errorWhileClosing: Error | undefined;
  readonly queryStarted = deferred<void>();
  ends = 0;
  private readonly inFlight: Array<(err: Error) => void> = [];

  async connect(): Promise<void> {}

  query(_sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queryStarted.resolve();
    if (this.hangQuery) return new Promise((_, reject) => this.inFlight.push(reject));
    if (this.errorBeforeResult) this.failConnection(this.errorBeforeResult);
    return Promise.resolve({ rows: [WRITER_COHERENCE_ROW] });
  }

  failConnection(err: Error): void {
    for (const reject of this.inFlight.splice(0)) reject(err);
    this.emit("error", err);
  }

  async end(): Promise<void> {
    this.ends += 1;
    if (this.errorWhileClosing) this.failConnection(this.errorWhileClosing);
  }
}

describe("permission store probe: standalone fresh-connection client errors", () => {
  function freshProbe(client: FakeProbeClient) {
    return createPermissionStoreProbe({
      pool: gfsPool(vi.fn()),
      connectionString: DSN,
      intervalMs: 60_000,
      storageRole: "writer",
      clientFactory: () => client,
    });
  }

  it("an error during the coherence query rejects the probe and still closes the client", async () => {
    const client = new FakeProbeClient();
    client.hangQuery = true;
    const settled = freshProbe(client)().then(
      () => undefined,
      (err: unknown) => err
    );
    await client.queryStarted.promise;

    expect(() => client.failConnection(adminShutdown())).not.toThrow();

    expect(await settled).toMatchObject({ code: "57P01" });
    expect(client.ends).toBe(1);
  });

  it("an error emitted outside a pending call fails the probe instead of caching success", async () => {
    const client = new FakeProbeClient();
    client.errorBeforeResult = adminShutdown();
    const probe = freshProbe(client);

    const failure = await probe().then(
      () => undefined,
      (err: unknown) => err
    );

    // Witness: the coherence query ran and returned a passing row.
    await expect(client.queryStarted.promise).resolves.toBeUndefined();
    expect(failure).toMatchObject({ code: "57P01" });
    expect(client.ends).toBe(1);
  });

  it("an error emitted while closing a passed probe is logged, not raised", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const client = new FakeProbeClient();
      client.errorWhileClosing = adminShutdown();

      await expect(freshProbe(client)()).resolves.toBeUndefined();

      expect(client.ends).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[gfsc] store-probe client error while closing: terminating connection due to administrator command"
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
