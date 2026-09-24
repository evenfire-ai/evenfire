import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  claimMcpSecretRollbackPermit,
  finalizeMcpSecretRollbackPermitClaim,
  issueMcpSecretRollbackPermit,
  releaseMcpSecretRollbackPermitClaim,
} from '../src/services/mcpSecretRollbackPermitService.js'

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

describeRealPostgres('MCP Secret rollback permits on real PostgreSQL', () => {
  const database = `mcp_rollback_${randomBytes(6).toString('hex')}`
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const basePermit = {
    sessionJti: `session-${randomBytes(12).toString('hex')}`,
    namespace: 'mcp-server',
    name: `credential-${randomBytes(5).toString('hex')}`,
    uid: `uid-${randomBytes(8).toString('hex')}`,
    resourceVersion: '17',
  }
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    if (pool) {
      // A concurrent consume test opens several pg clients. pg@8 may emit a
      // late idle-client error while their sockets finish closing, so retain a
      // pool-level listener through teardown and wait for the backend rows to
      // disappear before using the administrative fallback below.
      pool.on('error', () => {})
      await pool.end()
    }
    if (!adminPool) return
    let activeConnections = 0
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const active = await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      activeConnections = Number(active.rows[0]?.count ?? 0)
      if (activeConnections === 0) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (activeConnections > 0) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
    }
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('grants the runtime role the exact DML needed to issue and consume a permit', async () => {
    const client = await pool.connect()
    const permit = { ...basePermit, name: `${basePermit.name}-runtime` }
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      await issueMcpSecretRollbackPermit(permit, client)
      await expect(
        claimMcpSecretRollbackPermit(
          {
            sessionJti: permit.sessionJti,
            namespace: permit.namespace,
            name: permit.name,
          },
          client
        )
      ).resolves.toMatchObject({ uid: permit.uid, resourceVersion: permit.resourceVersion })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('allows exactly one winner across concurrent PostgreSQL sessions', async () => {
    const permit = { ...basePermit, name: `${basePermit.name}-concurrent` }
    await issueMcpSecretRollbackPermit(permit, pool)

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        claimMcpSecretRollbackPermit(
          {
            sessionJti: permit.sessionJti,
            namespace: permit.namespace,
            name: permit.name,
          },
          pool
        )
      )
    )

    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ uid: permit.uid, resourceVersion: permit.resourceVersion })

    await releaseMcpSecretRollbackPermitClaim(
      {
        sessionJti: permit.sessionJti,
        namespace: permit.namespace,
        name: permit.name,
        claimToken: winners[0]!.claimToken,
      },
      pool
    )
    const retry = await claimMcpSecretRollbackPermit(
      {
        sessionJti: permit.sessionJti,
        namespace: permit.namespace,
        name: permit.name,
      },
      pool
    )
    expect(retry).not.toBeNull()
    await finalizeMcpSecretRollbackPermitClaim(
      {
        sessionJti: permit.sessionJti,
        namespace: permit.namespace,
        name: permit.name,
        claimToken: retry!.claimToken,
      },
      pool
    )
  })

  it('binds the permit to its session and rejects it at the PostgreSQL expiry boundary', async () => {
    const permit = { ...basePermit, name: `${basePermit.name}-expiry` }
    await issueMcpSecretRollbackPermit(permit, pool)

    await expect(
      claimMcpSecretRollbackPermit(
        {
          sessionJti: 'different-admin-session',
          namespace: permit.namespace,
          name: permit.name,
        },
        pool
      )
    ).resolves.toBeNull()

    const ttl = await pool.query<{ ttlSeconds: string }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::text AS "ttlSeconds"
         FROM mcp_secret_rollback_permits
        WHERE namespace = $1 AND name = $2`,
      [permit.namespace, permit.name]
    )
    expect(Number(ttl.rows[0]?.ttlSeconds)).toBe(120)

    await pool.query(
      `UPDATE mcp_secret_rollback_permits
          SET created_at = statement_timestamp() - interval '121 seconds',
              expires_at = statement_timestamp() - interval '1 second'
        WHERE namespace = $1 AND name = $2`,
      [permit.namespace, permit.name]
    )

    await expect(
      claimMcpSecretRollbackPermit(
        {
          sessionJti: permit.sessionJti,
          namespace: permit.namespace,
          name: permit.name,
        },
        pool
      )
    ).resolves.toBeNull()
  })

  it('allows another replica to reclaim a permit after a crashed claim lease expires', async () => {
    const permit = { ...basePermit, name: `${basePermit.name}-crash-recovery` }
    await issueMcpSecretRollbackPermit(permit, pool)
    const first = await claimMcpSecretRollbackPermit(
      { sessionJti: permit.sessionJti, namespace: permit.namespace, name: permit.name },
      pool
    )
    expect(first).not.toBeNull()

    await pool.query(
      `UPDATE mcp_secret_rollback_permits
          SET claim_expires_at = statement_timestamp() - interval '1 second'
        WHERE namespace = $1 AND name = $2`,
      [permit.namespace, permit.name]
    )

    const reclaimed = await claimMcpSecretRollbackPermit(
      { sessionJti: permit.sessionJti, namespace: permit.namespace, name: permit.name },
      pool
    )
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.claimToken).not.toBe(first!.claimToken)
  })

  it('prevents an old claim from finalizing a reissued permit for a new identity', async () => {
    const original = { ...basePermit, name: `${basePermit.name}-reissue` }
    await issueMcpSecretRollbackPermit(original, pool)
    const oldClaim = await claimMcpSecretRollbackPermit(
      { sessionJti: original.sessionJti, namespace: original.namespace, name: original.name },
      pool
    )
    expect(oldClaim).not.toBeNull()

    const replacement = { ...original, uid: `${original.uid}-replacement`, resourceVersion: '1' }
    await issueMcpSecretRollbackPermit(replacement, pool)
    await finalizeMcpSecretRollbackPermitClaim(
      {
        sessionJti: original.sessionJti,
        namespace: original.namespace,
        name: original.name,
        claimToken: oldClaim!.claimToken,
      },
      pool
    )

    await expect(
      claimMcpSecretRollbackPermit(
        {
          sessionJti: replacement.sessionJti,
          namespace: replacement.namespace,
          name: replacement.name,
        },
        pool
      )
    ).resolves.toMatchObject({ uid: replacement.uid, resourceVersion: '1' })
  })
})
