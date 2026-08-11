import { Client } from "pg";

/**
 * Readiness probe for the permission store (issue #775).
 *
 * The naive `pool.connect()` + `SELECT 1` check cannot detect a rotated
 * database credential on a long-lived pod: the pool reuses idle clients that
 * authenticated BEFORE the rotation, and the kubelet readiness cadence (~5s)
 * keeps at least one such client alive forever (pg idle timeout 10s), so
 * readiness stays green while every NEW connection fails auth and every
 * request 503s. This probe closes that hole with two layers:
 *
 * 1. Fast pool ping (every call) — preserves the original check; detects a
 *    down/unreachable store within one probe period.
 * 2. Amortized fresh-connection probe (at most once per `intervalMs`) — opens
 *    a brand-new client (NEVER the pool) so a rotated credential fails to
 *    authenticate, and verifies real coherence with `has_table_privilege`, so
 *    "password correct but migration 0048 grants missing" also fails loud.
 *
 * FAIL CLOSED: only SUCCESS is cached. While failing, every readiness call
 * retries the fresh connection (~1 new connection per probe period during an
 * outage — exactly when it matters). Error messages never include the DSN.
 */

/** Minimal pool surface (structurally satisfied by pg.Pool; injectable in tests). */
export interface PingPool {
  connect(): Promise<{
    query(sql: string): Promise<unknown>;
    /** Passing an error DESTROYS the client instead of returning it to the pool. */
    release(err?: Error): void;
  }>;
}

/** Minimal ephemeral-client surface (structurally satisfied by pg.Client). */
export interface ProbeClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export interface StoreProbeOptions {
  /** Shared pool used by the serving path — fast liveness ping only. */
  pool: PingPool;
  /** Same DSN the pool uses; the fresh probe dials it with a NEW client. */
  connectionString: string;
  /** Amortization window for the fresh-connection probe (e.g. 60_000). */
  intervalMs: number;
  /** Selects the exact least-privilege readiness contract; never inferred. */
  storageRole: "writer" | "reader";
  /**
   * Hard bound on each fresh-probe step (connect AND coherence query).
   * Without it, a black-hole partition (unreachable but not refusing) leaves
   * connect() pending for the OS TCP timeout (~minutes) while the kubelet
   * fires a new probe every few seconds — an unbounded pile-up of dangling
   * connection attempts. Default 5_000.
   */
  connectTimeoutMs?: number;
  /** Injectable for tests; defaults to a real pg.Client. */
  clientFactory?: (connectionString: string) => ProbeClient;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bounded await — the probe must fail loud and fast, never dangle. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms (permission store unreachable?)`)),
      ms
    );
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Coherence canary: both halves of the role's least-privilege contract. A
// broken SELECT on gfs_resources breaks every authorization lookup; a broken
// INSERT on gfs_audit breaks every request too (audit-write failures propagate
// — no un-audited op is served), so either one must flip readiness instead of
// surfacing as chronic per-request 503s.
const BASE_COHERENCE_SQL =
  "SELECT has_table_privilege(current_user, 'gfs_resources', 'SELECT') AS can_read, " +
  "has_table_privilege(current_user, 'gfs_audit', 'INSERT') AS can_audit, " +
  "has_column_privilege(current_user, 'gfs_resources', 'blob_key', 'SELECT') AS can_read_blob_key, " +
  "has_column_privilege(current_user, 'gfs_resources', 'content_sha256', 'SELECT') AS can_read_digest, " +
  "EXISTS (SELECT 1 FROM (SELECT blob_key, content_sha256 FROM gfs_resources WHERE false) AS resource_probe) = false AS resource_schema_ready, " +
  "(SELECT count(*) = 8 " +
  "AND bool_and(attname <> 'desktop_user_id' OR atttypid = 'uuid'::regtype) " +
  "AND bool_and(attname = 'desktop_user_id' OR atttypid = 'text'::regtype) " +
  "AND bool_and(attname <> 'record_type' OR attnotnull) FROM pg_attribute " +
  "WHERE attrelid = 'gfs_audit'::regclass AND attnum > 0 AND NOT attisdropped " +
  "AND attname = ANY (ARRAY['actor_on_behalf_of', 'desktop_user_id', 'authority_source', 'record_type', 'matched_subject', 'authorization_source', 'cached_authorization_source', 'mutation_outcome'])) AS audit_schema_ready, " +
  "(SELECT count(*) = 6 FROM pg_constraint WHERE conrelid = 'gfs_audit'::regclass " +
  "AND conname = ANY (ARRAY['gfs_audit_actor_correlation_valid', 'gfs_audit_record_type_valid', 'gfs_audit_authorization_source_valid', 'gfs_audit_cached_authorization_source_valid', 'gfs_audit_mutation_outcome_valid', 'gfs_audit_record_type_fields_valid']) " +
  "AND contype = 'c' AND convalidated) AS audit_constraints_ready";

// The reader is deliberately read-only except for append-only audit records.
// Positive checks alone are insufficient: a stale/manual grant would keep the
// role Ready while silently expanding its blast radius. These checks use the
// effective current_user privileges, so inherited or PUBLIC grants fail too.
const READER_COHERENCE_SQL =
  BASE_COHERENCE_SQL +
  ", has_table_privilege(current_user, 'gfs_resources', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_mutate_resources, " +
  "has_table_privilege(current_user, 'gfs_grants', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_mutate_grants, " +
  "has_table_privilege(current_user, 'gfs_shares', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_mutate_shares, " +
  "has_table_privilege(current_user, 'gfs_blob_manifests', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_mutate_manifests, " +
  "has_table_privilege(current_user, 'gfs_audit', 'UPDATE, DELETE, TRUNCATE') AS can_mutate_audit, " +
  "has_sequence_privilege(current_user, 'gfs_audit_sequence_no_seq', 'UPDATE') AS can_update_audit_sequence";

const WRITER_COHERENCE_SQL =
  BASE_COHERENCE_SQL +
  ", has_table_privilege(current_user, 'gfs_blob_manifests', 'SELECT') AS can_read_manifests, " +
  "has_table_privilege(current_user, 'gfs_blob_manifests', 'INSERT') AS can_insert_manifests, " +
  "has_table_privilege(current_user, 'gfs_blob_manifests', 'UPDATE') AS can_update_manifests, " +
  "has_table_privilege(current_user, 'gfs_blob_manifests', 'DELETE') AS can_delete_manifests, " +
  "has_table_privilege(current_user, 'gfs_resources', 'INSERT') AS can_insert_resources, " +
  "has_table_privilege(current_user, 'gfs_resources', 'UPDATE') AS can_update_resources, " +
  "EXISTS (SELECT 1 FROM (SELECT blob_key, candidate_kind, state, content_sha256, bytes FROM gfs_blob_manifests WHERE false) AS manifest_probe) = false AS manifest_schema_ready";

export function createPermissionStoreProbe(opts: StoreProbeOptions): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  // @types/pg resolves Client.connect() to Promise<Client>; the probe contract
  // wants Promise<void> — awaited and discarded (same adaptation as the LISTEN
  // client in index.ts). connectionTimeoutMillis is belt-and-suspenders under
  // the probe-level withTimeout bound (which also covers the query).
  const clientFactory =
    opts.clientFactory ??
    ((connectionString: string): ProbeClient => {
      const client = new Client({ connectionString, connectionTimeoutMillis: connectTimeoutMs });
      return {
        connect: async () => {
          await client.connect();
        },
        query: (sql: string) => client.query(sql),
        end: () => client.end(),
      };
    });
  let lastFreshOkAt: number | null = null;

  return async (): Promise<void> => {
    // Layer 1 — fast pool ping (original check, always runs), bounded like
    // Layer 2. The acquire needs orphan-handling that the ephemeral client
    // does not: when the deadline wins the race, the underlying
    // pool.connect() keeps running, and if it EVENTUALLY succeeds (a
    // partition clearing) the checked-out client must be returned or the
    // pool slot leaks — sustained probes would starve the serving path's own
    // pool. Ordering is safe: the race rejection's await continuation (which
    // sets the flag) is queued before any later acquire resolution.
    let acquireTimedOut = false;
    const acquire = opts.pool.connect();
    acquire.then(
      client => {
        if (acquireTimedOut) client.release();
      },
      () => undefined // late rejection: nothing was checked out
    );
    let pooled: Awaited<ReturnType<PingPool["connect"]>>;
    try {
      pooled = await withTimeout(acquire, connectTimeoutMs, "permission store pool ping");
    } catch (err) {
      acquireTimedOut = true;
      throw err;
    }
    let pingFailure: Error | undefined;
    try {
      await withTimeout(pooled.query("SELECT 1"), connectTimeoutMs, "permission store pool ping");
    } catch (err) {
      // DESTROY (release-with-error) a client whose ping hung or failed —
      // returning a connection with an in-flight query to the pool would
      // poison later checkouts.
      pingFailure = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      if (pingFailure) {
        pooled.release(pingFailure);
      } else {
        pooled.release();
      }
    }

    // Layer 2 — amortized fresh-connection credential + coherence probe.
    if (lastFreshOkAt !== null && now() - lastFreshOkAt < opts.intervalMs) {
      return;
    }
    const client = clientFactory(opts.connectionString);
    try {
      // A rotated credential fails HERE with the real auth error — the pool
      // would have masked it by reusing a pre-rotation connection. Both steps
      // are hard-bounded so a black-hole partition fails this probe cycle
      // instead of dangling until the OS TCP timeout.
      await withTimeout(client.connect(), connectTimeoutMs, "permission store connect");
      const result = await withTimeout(
        client.query(opts.storageRole === "writer" ? WRITER_COHERENCE_SQL : READER_COHERENCE_SQL),
        connectTimeoutMs,
        "permission store coherence query"
      );
      const row = result.rows[0];
      if (row?.can_read !== true) {
        throw new Error(
          "permission store coherence check failed: role lacks SELECT on gfs_resources " +
            "(control-api migration 0048 not applied?)"
        );
      }
      if (row?.can_audit !== true) {
        throw new Error(
          "permission store coherence check failed: role lacks INSERT on gfs_audit " +
            "(audit-write failures would 503 every request; control-api migration 0048 not applied?)"
        );
      }
      if (
        row?.can_read_blob_key !== true ||
        row?.can_read_digest !== true ||
        row?.resource_schema_ready !== true
      ) {
        throw new Error(
          "permission store coherence check failed: immutable GFS blob schema/reader privileges " +
            "are missing (control-api migration 0068 not applied?)"
        );
      }
      if (row?.audit_schema_ready !== true || row?.audit_constraints_ready !== true) {
        throw new Error(
          "permission store coherence check failed: GFS audit actor-correlation schema is missing " +
            "(control-api migration 0092 not applied?)"
        );
      }
      if (
        opts.storageRole === "reader" &&
        (row?.can_mutate_resources !== false ||
          row?.can_mutate_grants !== false ||
          row?.can_mutate_shares !== false ||
          row?.can_mutate_manifests !== false ||
          row?.can_mutate_audit !== false ||
          row?.can_update_audit_sequence !== false)
      ) {
        throw new Error(
          "permission store coherence check failed: reader has forbidden GFS mutation privileges " +
            "(control-api migration 0069 grants drifted?)"
        );
      }
      if (
        opts.storageRole === "writer" &&
        (row?.can_read_manifests !== true ||
          row?.manifest_schema_ready !== true ||
          row?.can_insert_manifests !== true ||
          row?.can_update_manifests !== true ||
          row?.can_delete_manifests !== true ||
          row?.can_insert_resources !== true ||
          row?.can_update_resources !== true)
      ) {
        throw new Error(
          "permission store coherence check failed: writer lacks GFS manifest/resource mutation " +
            "privileges (control-api migration 0068 not applied?)"
        );
      }
      lastFreshOkAt = now(); // cache SUCCESS only — failures always retry
    } finally {
      // Best-effort close of the ephemeral client; a close error must not mask
      // the probe verdict, but it is logged loudly (never swallowed silently).
      await client.end().catch((err) => {
        console.error(`[gfsc] store-probe client close error: ${errMsg(err)}`);
      });
    }
  };
}
