import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { createPermissionStoreProbe } from '../../gfs-controller/src/authz/storeProbe.js'
import { CONTROL_API_MIGRATIONS, assertDbReady, initDb } from '../src/db.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('GFS Phase 0 real PostgreSQL readiness', () => {
  const latestMigration = CONTROL_API_MIGRATIONS.at(-1)!.version
  const database = `gfs_readiness_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool

  function probeAs(client: PoolClient) {
    return createPermissionStoreProbe({
      pool: {
        connect: async () => {
          const pingClient = await pool.connect()
          return {
            query: (sql: string) => pingClient.query(sql),
            release: (error?: Error) => pingClient.release(error),
          }
        },
      },
      connectionString,
      intervalMs: 0,
      storageRole: 'writer',
      connectTimeoutMs: 2_000,
      clientFactory: () => ({
        connect: async () => undefined,
        query: (sql: string) => client.query(sql),
        end: async () => undefined,
      }),
    })
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('fails Control API readiness while the latest migration is absent', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM schema_migrations WHERE version=$1`, [latestMigration])
      await expect(assertDbReady(client)).rejects.toThrow(new RegExp(latestMigration))
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('fails GFSC readiness while the immutable blob schema is absent', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DROP TABLE gfs_blob_manifests')
      await client.query('SET LOCAL ROLE gfs_controller')
      await expect(probeAs(client)()).rejects.toThrow(/gfs_blob_manifests|0068/i)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('fails GFSC readiness while the 0092 audit actor-correlation constraint is absent', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE gfs_audit DROP CONSTRAINT gfs_audit_actor_correlation_valid')
      await client.query('SET LOCAL ROLE gfs_controller')
      await expect(probeAs(client)()).rejects.toThrow(/audit actor-correlation|0092/i)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('passes GFSC writer readiness under the migrated runtime role', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE gfs_controller')
      await expect(probeAs(client)()).resolves.toBeUndefined()
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it.each([
    ['resource SELECT', 'REVOKE SELECT ON gfs_resources FROM gfs_controller'],
    ['audit INSERT', 'REVOKE INSERT ON gfs_audit FROM gfs_controller'],
    ['manifest SELECT', 'REVOKE SELECT ON gfs_blob_manifests FROM gfs_controller'],
    ['manifest INSERT', 'REVOKE INSERT ON gfs_blob_manifests FROM gfs_controller'],
    ['manifest UPDATE', 'REVOKE UPDATE ON gfs_blob_manifests FROM gfs_controller'],
    ['manifest DELETE', 'REVOKE DELETE ON gfs_blob_manifests FROM gfs_controller'],
    ['resource INSERT', 'REVOKE INSERT ON gfs_resources FROM gfs_controller'],
    ['resource UPDATE', 'REVOKE UPDATE ON gfs_resources FROM gfs_controller'],
  ])('fails GFSC writer readiness without only %s', async (_name, revokeSql) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(revokeSql)
      await client.query('SET LOCAL ROLE gfs_controller')
      await expect(probeAs(client)()).rejects.toThrow(
        /coherence check failed|permission denied|0068|0048/i
      )
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })
})
