import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditSink } from "../authz/audit";
import { publishRename } from "./renamePublication";
import { PgTransactor, type Transactor, type TxClient } from "./writeStore";

// Regression harness for the served rename SQL. The unit suite runs the
// publication against a scripted client, so a statement that only breaks on a
// real parser — like the RETURNING list turning ambiguous once the
// jsonb_to_recordset path alias is in scope — sails through it. This test
// executes the exact statements on real PostgreSQL. Gated like the control-api
// real-PG suites so one environment variable drives all of them.
const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL;
const describeRealPostgres = adminUrl ? describe : describe.skip;

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describeRealPostgres("renamePublication on real PostgreSQL", () => {
  const database = `gfsc_rename_pub_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  const tx: Transactor = {
    async transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (text: string, values?: unknown[]) => client.query(text, values as never[]),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };

  const noopAudit: AuditSink = { record: async () => undefined };

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE ${database}`);
    pool = new Pool({ connectionString: databaseUrl(adminUrl as string, database) });
    // Minimal live-schema shape for the statements under test; full-schema
    // semantics stay covered by the control-api real-PG migration suites.
    await pool.query(`
      CREATE TABLE gfs_resources (
        resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        drive TEXT NOT NULL,
        parent_resource_id UUID NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path_cache TEXT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        bytes BIGINT NOT NULL DEFAULT 0,
        blob_key TEXT NULL,
        content_sha256 TEXT NULL,
        deleted_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (!adminPool) return;
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  });

  it("renames a folder root and rewrites every descendant path in one transaction", async () => {
    const seeded = await pool.query(`
      WITH drive_root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        VALUES ('main', NULL, '', 'directory', '/')
        RETURNING resource_id
      ),
      root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, version)
        SELECT 'main', resource_id, 'projects', 'directory', '/projects', 4 FROM drive_root
        RETURNING resource_id
      ),
      child_dir AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        SELECT 'main', resource_id, 'docs', 'directory', '/projects/docs' FROM root
        RETURNING resource_id
      ),
      child_file AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, bytes)
        SELECT 'main', resource_id, 'notes.txt', 'file', '/projects/docs/notes.txt', 12 FROM child_dir
        RETURNING resource_id
      )
      SELECT root.resource_id::text AS root_id,
             child_dir.resource_id::text AS dir_id,
             child_file.resource_id::text AS file_id
        FROM root, child_dir, child_file;
    `);
    const { root_id: rootId, dir_id: dirId, file_id: fileId } = seeded.rows[0] as {
      root_id: string;
      dir_id: string;
      file_id: string;
    };

    const renamed = await publishRename(tx, {
      requestId: "req-rename-realpg-1",
      subject: "host:1st:mcp-host/agent-a",
      audit: noopAudit,
      drive: "main",
      resourceId: rootId,
      newName: "archive",
      ifMatch: 4,
      maxObjects: 1000,
      deadlineAtMs: Date.now() + 30_000,
    });

    expect(renamed.name).toBe("archive");

    const rows = await pool.query(
      `SELECT resource_id::text AS id, name, path_cache, version
         FROM gfs_resources ORDER BY path_cache`
    );
    const byId = new Map(rows.rows.map(row => [row.id as string, row]));
    expect(byId.get(rootId)).toMatchObject({ name: "archive", path_cache: "/archive", version: 5 });
    expect(byId.get(dirId)).toMatchObject({ name: "docs", path_cache: "/archive/docs", version: 0 });
    expect(byId.get(fileId)).toMatchObject({
      name: "notes.txt",
      path_cache: "/archive/docs/notes.txt",
      version: 0,
    });
  });

  // The admission bounds run through the REAL transactor here: PgTransactor
  // arms statement_timeout on a live session and gates acquisition on the
  // deadline, so both paths execute against the actual PostgreSQL parser and
  // pool instead of the scripted client the unit suite uses.
  it("rejects an oversized subtree with payload_too_large via the real LIMIT before any UPDATE", async () => {
    const seeded = await pool.query(`
      WITH drive_root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        VALUES ('bound', NULL, '', 'directory', '/')
        RETURNING resource_id
      ),
      root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, version)
        SELECT 'bound', resource_id, 'big', 'directory', '/big', 1 FROM drive_root
        RETURNING resource_id
      ),
      children AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        SELECT 'bound', root.resource_id, 'file-' || n, 'file', '/big/file-' || n
          FROM root, generate_series(1, 2) AS n
        RETURNING resource_id
      )
      SELECT root.resource_id::text AS root_id FROM root;
    `);
    const rootId = (seeded.rows[0] as { root_id: string }).root_id;
    const realTx = new PgTransactor(pool);

    await expect(publishRename(realTx, {
      requestId: "req-rename-realpg-2",
      subject: "host:1st:mcp-host/agent-a",
      audit: noopAudit,
      drive: "bound",
      resourceId: rootId,
      newName: "renamed-big",
      ifMatch: 1,
      maxObjects: 2,
      deadlineAtMs: Date.now() + 30_000,
    })).rejects.toMatchObject({ code: "payload_too_large" });

    const after = await pool.query(
      `SELECT name, path_cache FROM gfs_resources WHERE drive = 'bound' AND resource_id = $1`,
      [rootId]
    );
    expect(after.rows[0]).toMatchObject({ name: "big", path_cache: "/big" });
  });

  it("fails precondition_failed through the real transactor when the rename deadline is already exhausted", async () => {
    const existing = await pool.query(
      `SELECT resource_id::text AS id, name FROM gfs_resources
        WHERE drive = 'bound' AND name = 'big' LIMIT 1`
    );
    const rootId = (existing.rows[0] as { id: string }).id;
    const realTx = new PgTransactor(pool);

    await expect(publishRename(realTx, {
      requestId: "req-rename-realpg-3",
      subject: "host:1st:mcp-host/agent-a",
      audit: noopAudit,
      drive: "bound",
      resourceId: rootId,
      newName: "too-late",
      ifMatch: 1,
      maxObjects: 1000,
      deadlineAtMs: Date.now() - 1,
    })).rejects.toMatchObject({
      code: "precondition_failed",
      message: "synchronous mutation deadline exceeded",
    });

    const after = await pool.query(
      `SELECT name FROM gfs_resources WHERE drive = 'bound' AND resource_id = $1`,
      [rootId]
    );
    expect(after.rows[0]).toMatchObject({ name: "big" });
  });

  // Concurrency: the served rename holds an advisory lock + `FOR UPDATE` and
  // re-checks the If-Match version inside the transaction. Two renames of the
  // same root racing with the SAME If-Match can ONLY be adjudicated by real
  // PostgreSQL row locks — the scripted-client unit suite cannot observe the
  // serialization, so this lives here.
  it("serializes two concurrent renames of the same root: exactly one wins, the loser is precondition_failed", async () => {
    const seeded = await pool.query(`
      WITH drive_root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        VALUES ('race', NULL, '', 'directory', '/')
        RETURNING resource_id
      ),
      root AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, version)
        SELECT 'race', resource_id, 'contended', 'directory', '/contended', 7 FROM drive_root
        RETURNING resource_id
      )
      SELECT root.resource_id::text AS root_id FROM root;
    `);
    const rootId = (seeded.rows[0] as { root_id: string }).root_id;

    // Each attempt runs on its OWN real transactor (its own pooled connection),
    // both launched together. Same If-Match=7: whichever transaction acquires
    // the row lock first bumps the version 7->8 and commits; the other then sees
    // version 8 != If-Match 7 and must fail precondition_failed. Deterministic —
    // the lock decides the order, the If-Match decides that only one may win.
    const attempt = (newName: string) =>
      publishRename(new PgTransactor(pool), {
        requestId: `req-rename-race-${newName}`,
        subject: "host:1st:mcp-host/agent-a",
        audit: noopAudit,
        drive: "race",
        resourceId: rootId,
        newName,
        ifMatch: 7,
        maxObjects: 1000,
        deadlineAtMs: Date.now() + 30_000,
      });

    const results = await Promise.allSettled([attempt("winner-a"), attempt("winner-b")]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof publishRename>>> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "precondition_failed" });

    // Business truth: exactly one mutation landed — the version bumped once
    // (7->8), and the persisted name/path is the winner's, never a blend of both.
    const winnerName = fulfilled[0]!.value.name;
    const after = await pool.query(
      `SELECT name, path_cache, version FROM gfs_resources WHERE drive='race' AND resource_id=$1`,
      [rootId]
    );
    expect(after.rows[0]).toMatchObject({
      name: winnerName,
      path_cache: `/${winnerName}`,
      version: 8,
    });
  });
});
