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
  immutableSchemaReady?: boolean;
  canInsertManifests?: boolean;
  canUpdateManifests?: boolean;
  canDeleteManifests?: boolean;
  canInsertResources?: boolean;
  canUpdateResources?: boolean;
  auditSchemaReady?: boolean;
  auditConstraintsReady?: boolean;
  canMutateResources?: boolean;
  canMutateGrants?: boolean;
  canMutateShares?: boolean;
  canMutateManifests?: boolean;
  canMutateAudit?: boolean;
  canUpdateAuditSequence?: boolean;
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
            {
              can_read: behavior.canRead !== false,
              can_audit: behavior.canAudit !== false,
              can_read_blob_key: behavior.immutableSchemaReady !== false,
              can_read_digest: behavior.immutableSchemaReady !== false,
              can_read_manifests: behavior.immutableSchemaReady !== false,
              resource_schema_ready: behavior.immutableSchemaReady !== false,
              manifest_schema_ready: behavior.immutableSchemaReady !== false,
              can_insert_manifests: behavior.canInsertManifests !== false,
              can_update_manifests: behavior.canUpdateManifests !== false,
              can_delete_manifests: behavior.canDeleteManifests !== false,
              can_insert_resources: behavior.canInsertResources !== false,
              can_update_resources: behavior.canUpdateResources !== false,
              audit_schema_ready: behavior.auditSchemaReady !== false,
              audit_constraints_ready: behavior.auditConstraintsReady !== false,
              can_mutate_resources: behavior.canMutateResources === true,
              can_mutate_grants: behavior.canMutateGrants === true,
              can_mutate_shares: behavior.canMutateShares === true,
              can_mutate_manifests: behavior.canMutateManifests === true,
              can_mutate_audit: behavior.canMutateAudit === true,
              can_update_audit_sequence: behavior.canUpdateAuditSequence === true,
            },
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/gfs_audit.*INSERT|INSERT on gfs_audit/s);
  });

  it("rejects a pre-0068 reader schema before serving requests", async () => {
    const { factory } = fakeClientFactory({ immutableSchemaReady: false });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "reader",
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/migration 0068/);
  });

  it("keeps reader readiness independent of the writer-only manifest schema", async () => {
    const probeClient = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "reader",
      clientFactory: probeClient.factory,
      now: () => 0,
    });
    await expect(probe()).resolves.toBeUndefined();
    expect(probeClient.lastSql()).not.toContain("manifest_schema_ready");
    expect(probeClient.lastSql()).not.toContain("candidate_kind, state");
    expect(probeClient.lastSql()).toContain("FROM pg_attribute");
    expect(probeClient.lastSql()).toContain("'cached_authorization_source'");
    expect(probeClient.lastSql()).toContain("gfs_audit_record_type_fields_valid");
  });

  it.each([
    ["resource mutation", { canMutateResources: true }],
    ["grant mutation", { canMutateGrants: true }],
    ["share mutation", { canMutateShares: true }],
    ["manifest mutation", { canMutateManifests: true }],
    ["non-append audit mutation", { canMutateAudit: true }],
    ["audit sequence update", { canUpdateAuditSequence: true }],
  ] satisfies Array<[string, FakeClientBehavior]>)
  ("rejects a reader granted forbidden %s privileges", async (_privilege, behavior) => {
    const { factory } = fakeClientFactory(behavior);
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "reader",
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/reader has forbidden GFS mutation privileges.*0069/s);
  });

  it("does not apply reader-only negative privilege checks to the writer", async () => {
    const { factory } = fakeClientFactory({
      canMutateResources: true,
      canMutateManifests: true,
    });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "writer",
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).resolves.toBeUndefined();
  });

  it.each(["reader", "writer"] as const)(
    "rejects a %s when migration 0070 audit columns are missing",
    async (storageRole) => {
      const { factory } = fakeClientFactory({ auditSchemaReady: false });
      const probe = createPermissionStoreProbe({
        pool: fakePool(),
        connectionString: DSN,
        intervalMs: INTERVAL,
        storageRole,
        clientFactory: factory,
        now: () => 0,
      });
      await expect(probe()).rejects.toThrow(/migration 0070/);
    }
  );

  it.each(["reader", "writer"] as const)(
    "rejects a %s when migration 0070 audit constraints are missing or unvalidated",
    async (storageRole) => {
      const { factory } = fakeClientFactory({ auditConstraintsReady: false });
      const probe = createPermissionStoreProbe({
        pool: fakePool(),
        connectionString: DSN,
        intervalMs: INTERVAL,
        storageRole,
        clientFactory: factory,
        now: () => 0,
      });
      await expect(probe()).rejects.toThrow(/migration 0070/);
    }
  );

  it.each([
    ["manifest INSERT", { canInsertManifests: false }],
    ["manifest UPDATE", { canUpdateManifests: false }],
    ["manifest DELETE", { canDeleteManifests: false }],
    ["resource INSERT", { canInsertResources: false }],
    ["resource UPDATE", { canUpdateResources: false }],
  ] satisfies Array<[string, FakeClientBehavior]>)
  ("rejects a writer missing only %s", async (_privilege, behavior) => {
    const { factory } = fakeClientFactory(behavior);
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "writer",
      clientFactory: factory,
      now: () => 0,
    });
    await expect(probe()).rejects.toThrow(/writer lacks.*0068/s);
  });

  it("pins the coherence canary SQL to both least-privilege grants", async () => {
    // Regression guard: gutting COHERENCE_SQL (e.g. SELECT true AS can_read...)
    // must fail here even though every behavior test uses a fake client.
    const probeClient = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "writer",
      clientFactory: probeClient.factory,
      now: () => 0,
    });
    await probe();
    const sql = probeClient.lastSql() ?? "";
    expect(sql).toContain("has_table_privilege");
    expect(sql).toMatch(/gfs_resources'\s*,\s*'SELECT'/);
    expect(sql).toMatch(/gfs_audit'\s*,\s*'INSERT'/);
    expect(sql).toContain("gfs_blob_manifests");
    expect(sql).toContain("blob_key, content_sha256 FROM gfs_resources WHERE false");
    expect(sql).toMatch(/gfs_blob_manifests'\s*,\s*'INSERT'/);
    expect(sql).toMatch(/gfs_blob_manifests'\s*,\s*'UPDATE'/);
    expect(sql).toMatch(/gfs_blob_manifests'\s*,\s*'DELETE'/);
    expect(sql).toMatch(/gfs_resources'\s*,\s*'INSERT'/);
    expect(sql).toMatch(/gfs_resources'\s*,\s*'UPDATE'/);
    expect(sql).toContain("FROM pg_attribute");
    expect(sql).toContain("'record_type'");
    expect(sql).toContain("'matched_subject'");
    expect(sql).toContain("'authorization_source'");
    expect(sql).toContain("'cached_authorization_source'");
    expect(sql).toContain("'mutation_outcome'");
    expect(sql).toContain("gfs_audit_record_type_valid");
    expect(sql).toContain("gfs_audit_authorization_source_valid");
    expect(sql).toContain("gfs_audit_cached_authorization_source_valid");
    expect(sql).toContain("gfs_audit_mutation_outcome_valid");
    expect(sql).toContain("gfs_audit_record_type_fields_valid");
    expect(sql).toContain("convalidated");
    expect(sql).not.toContain("can_mutate_resources");
    expect(sql).not.toContain("can_update_audit_sequence");
  });

  it("pins the reader coherence canary to every forbidden mutation class", async () => {
    const probeClient = fakeClientFactory({});
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      storageRole: "reader",
      clientFactory: probeClient.factory,
      now: () => 0,
    });
    await probe();
    const sql = probeClient.lastSql() ?? "";
    expect(sql).toMatch(/gfs_resources'\s*,\s*'INSERT, UPDATE, DELETE, TRUNCATE'/);
    expect(sql).toMatch(/gfs_grants'\s*,\s*'INSERT, UPDATE, DELETE, TRUNCATE'/);
    expect(sql).toMatch(/gfs_shares'\s*,\s*'INSERT, UPDATE, DELETE, TRUNCATE'/);
    expect(sql).toMatch(/gfs_blob_manifests'\s*,\s*'INSERT, UPDATE, DELETE, TRUNCATE'/);
    expect(sql).toMatch(/gfs_audit'\s*,\s*'UPDATE, DELETE, TRUNCATE'/);
    expect(sql).toMatch(/gfs_audit_sequence_no_seq'\s*,\s*'UPDATE'/);
  });

  it("bounds a hanging coherence QUERY with the probe timeout", async () => {
    const hanging = fakeClientFactory({ queryHangs: true });
    const probe = createPermissionStoreProbe({
      pool: fakePool(),
      connectionString: DSN,
      intervalMs: INTERVAL,
      connectTimeoutMs: 20,
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
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
      storageRole: "reader",
      clientFactory: failing.factory,
      now: () => 0,
    });
    await expect(failProbe()).rejects.toThrow(/boom/);
    expect(failing.ends()).toBe(1);
  });
});
