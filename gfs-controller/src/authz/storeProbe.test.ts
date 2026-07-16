import { describe, expect, it } from "vitest";
import {
  createPermissionStoreProbe,
  type PingPool,
  type ProbeClient,
} from "./storeProbe.js";

/**
 * Issue #775: the readiness store check must detect a rotated database
 * credential on a long-lived pod. The pool masks rotation (idle clients
 * authenticated before the rotation stay alive), so the probe must dial a
 * fresh connection — amortized, success-cached-only, fail-closed.
 */

const DSN = "postgresql://gfs_controller:redacted@db.example:5432/profiles";
const INTERVAL = 60_000;

function fakePool(): PingPool & {
  pings: number;
  failPing: boolean;
  hangConnect: boolean;
  hangQuery: boolean;
  /** connect() resolves only after this many ms (late acquire, NOT a hang). */
  lateConnectMs: number;
  releases: Array<Error | undefined>;
} {
  const makeClient = () => ({
    query: async (_sql: string) => {
      if (pool.hangQuery) return new Promise<never>(() => undefined);
      pool.pings += 1;
      if (pool.failPing) throw new Error("pool exhausted: connection refused");
      return {};
    },
    release: (err?: Error) => {
      pool.releases.push(err);
    },
  });
  const pool = {
    pings: 0,
    failPing: false,
    hangConnect: false,
    hangQuery: false,
    lateConnectMs: 0,
    releases: [] as Array<Error | undefined>,
    connect: async () => {
      if (pool.hangConnect) return new Promise<never>(() => undefined);
      if (pool.lateConnectMs > 0) {
        await new Promise(resolve => setTimeout(resolve, pool.lateConnectMs));
      }
      return makeClient();
    },
  };
  return pool;
}

interface FakeClientBehavior {
  connectError?: Error;
  /** connect() never settles — the black-hole partition case. */
  connectHangs?: boolean;
  /** query() never settles — partition AFTER a successful handshake. */
  queryHangs?: boolean;
  canRead?: boolean;
  canAudit?: boolean;
  queryError?: Error;
}

function fakeClientFactory(behavior: FakeClientBehavior): {
  factory: (cs: string) => ProbeClient;
  created: () => number;
  ends: () => number;
  lastDsn: () => string | null;
  lastSql: () => string | null;
} {
  let created = 0;
  let ends = 0;
  let lastDsn: string | null = null;
  let lastSql: string | null = null;
  const factory = (cs: string): ProbeClient => {
    created += 1;
    lastDsn = cs;
    return {
      connect: async () => {
        if (behavior.connectHangs) return new Promise<never>(() => undefined);
        if (behavior.connectError) throw behavior.connectError;
      },
      query: async (sql: string) => {
        lastSql = sql;
        if (behavior.queryHangs) return new Promise<never>(() => undefined);
        if (behavior.queryError) throw behavior.queryError;
        return {
          rows: [
            { can_read: behavior.canRead !== false, can_audit: behavior.canAudit !== false },
          ],
        };
      },
      end: async () => {
        ends += 1;
      },
    };
  };
  return {
    factory,
    created: () => created,
    ends: () => ends,
    lastDsn: () => lastDsn,
    lastSql: () => lastSql,
  };
}

describe("createPermissionStoreProbe", () => {
  it("rejects when the fresh connection fails to authenticate (rotated credential)", async () => {
    const { factory } = fakeClientFactory({
      connectError: new Error('password authentication failed for user "gfs_controller"'),
    });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/password authentication failed/);
  });

  it("rejects with a migration hint when the role lacks SELECT on gfs_resources", async () => {
    const { factory } = fakeClientFactory({ canRead: false });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/gfs_resources.*0048/s);
  });

  it("rejects when the role lacks INSERT on gfs_audit (chronic per-request 503 mode)", async () => {
    const { factory } = fakeClientFactory({ canAudit: false });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/gfs_audit.*INSERT|INSERT on gfs_audit/s);
  });

  it("pins the coherence canary SQL to both least-privilege grants", async () => {
    // Regression guard: gutting COHERENCE_SQL (e.g. SELECT true AS can_read...)
    // must fail here even though every behavior test uses a fake client.
    const probeClient = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: probeClient.factory,
      now: () => 0,
    });
    await probe();
    const sql = probeClient.lastSql() ?? "";
    expect(sql).toContain("has_table_privilege");
    expect(sql).toMatch(/gfs_resources'\s*,\s*'SELECT'/);
    expect(sql).toMatch(/gfs_audit'\s*,\s*'INSERT'/);
  });

  it("bounds a hanging coherence QUERY with the probe timeout", async () => {
    const hanging = fakeClientFactory({ queryHangs: true });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 20,
      clientFactory: hanging.factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/coherence query timed out after 20ms/);
    expect(hanging.ends()).toBe(1);
  });

  it("releases a pool client whose acquire resolves only AFTER the probe timed out", async () => {
    // The orphan case: the deadline wins the race, then the underlying
    // pool.connect() succeeds later (partition clears). The late client MUST
    // be handed back or the pool leaks one slot per probe cycle.
    const pool = fakePool();
    pool.lateConnectMs = 40;
    const { factory } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 10,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/pool ping timed out after 10ms/);
    expect(pool.releases).toHaveLength(0); // not settled yet
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(pool.releases).toHaveLength(1); // late acquire returned to the pool
    expect(pool.releases[0]).toBeUndefined(); // clean release, not a destroy
  });

  it("DESTROYS the pooled client when the ping query hangs (release with error)", async () => {
    // A connection with an in-flight query must not go back into rotation.
    const pool = fakePool();
    pool.hangQuery = true;
    const { factory } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 15,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/pool ping timed out after 15ms/);
    expect(pool.releases).toHaveLength(1);
    expect(pool.releases[0]).toBeInstanceOf(Error); // destroy, not reuse
  });

  it("bounds a hanging POOL ping with the probe timeout (full-partition case)", async () => {
    const pool = fakePool();
    pool.hangConnect = true;
    const { factory, created } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 20,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/pool ping timed out after 20ms/);
    expect(created()).toBe(0); // fails before ever dialing a fresh client
  });

  it("bounds a black-hole connect with the probe timeout and still closes the client", async () => {
    const hanging = fakeClientFactory({ connectHangs: true });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 20,
      clientFactory: hanging.factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/permission store connect timed out after 20ms/);
    expect(hanging.ends()).toBe(1); // the dangling attempt is torn down, not leaked
  });

  it("amortizes the fresh probe within intervalMs while the pool ping still runs", async () => {
    let t = 1_000;
    const pool = fakePool();
    const { factory, created } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => t,
    });
    await probe();
    t += INTERVAL - 1;
    await probe();
    expect(created()).toBe(1); // fresh probe amortized
    expect(pool.pings).toBe(2); // pool ping never skipped
  });

  it("re-runs the fresh probe after intervalMs elapses", async () => {
    let t = 1_000;
    const { factory, created } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => t,
    });
    await probe();
    t += INTERVAL;
    await probe();
    expect(created()).toBe(2);
  });

  it("never caches a failure: an immediate retry dials a new connection", async () => {
    const { factory, created } = fakeClientFactory({
      connectError: new Error("password authentication failed"),
    });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow();
    await expect(probe()).rejects.toThrow();
    expect(created()).toBe(2); // no time advanced, yet the probe retried
  });

  it("rejects on pool ping failure even when the fresh probe recently succeeded", async () => {
    let t = 1_000;
    const pool = fakePool();
    const { factory } = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool,
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: factory,
      now: () => t,
    });
    await probe(); // fresh probe succeeds and is cached
    pool.failPing = true;
    t += 1;
    await expect(probe()).rejects.toThrow(/connection refused/);
  });

  it("always closes the ephemeral client, on success and on failure", async () => {
    const success = fakeClientFactory({});
    const okProbe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: success.factory,
      now: () => 0,
    });
    await okProbe();
    expect(success.ends()).toBe(1);
    expect(success.lastDsn()).toBe(DSN);

    const failing = fakeClientFactory({ queryError: new Error("boom") });
    const failProbe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      clientFactory: failing.factory,
      now: () => 0,
    });
    await expect(failProbe()).rejects.toThrow(/boom/);
    expect(failing.ends()).toBe(1);
  });
});
