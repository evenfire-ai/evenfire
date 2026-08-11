import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import {
  AccessCatalogCursorError,
  decodeAccessCatalogCursor,
} from '../src/services/access/accessCatalogCursor.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function transaction(pool: Pool) {
  return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await pool.connect()) as PoolClient
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

describeRealPostgres('aggregate catalog coordinator on real PostgreSQL', () => {
  const database = `control_api_catalog_coordinator_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const teamIds = [randomUUID(), randomUUID()].sort()
  const session: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
  }
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog User')`, [
      userId,
      `${userId}@example.test`,
    ])
    for (const [index, teamId] of teamIds.entries()) {
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `Team ${index + 1}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')`,
        [teamId, userId, index === 0 ? 'admin' : 'member']
      )
    }
  })

  afterAll(async () => {
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  it('composes keyset pages and emits access paths that re-resolve live', async () => {
    const first = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 2 },
      { transaction: transaction(databasePool) }
    )

    expect(first.complete).toBe(true)
    expect(first.items.map(item => item.resource.logicalId)).toEqual(teamIds)
    expect(first.nextCursor).toEqual(expect.stringMatching(/^c3\./))
    const firstPath = first.items[0].accessPaths[0]
    const resolved = await resolveLiveAuthorization(
      {
        session,
        requiredCapability: 'team.read',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'team',
          logicalId: teamIds[0],
        }),
        requestedAccessPathId: firstPath.accessPathId,
      },
      { transaction: transaction(databasePool) }
    )
    expect(resolved).toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: firstPath.accessPathId }),
      })
    )

    const second = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 2, cursor: first.nextCursor },
      { transaction: transaction(databasePool) }
    )
    expect(second.items.map(item => item.resource.logicalId)).toEqual([userId])
    expect(second.nextCursor).toBeNull()
  })

  it('rejects a cursor after a live membership revision changes', async () => {
    const page = await buildAccessCatalog(
      { session, families: ['user', 'team'], limit: 1 },
      { transaction: transaction(databasePool) }
    )
    expect(page.nextCursor).not.toBeNull()
    await databasePool.query(
      `UPDATE team_members SET role = 'inviter', updated_at = NOW()
        WHERE team_id = $1 AND user_id = $2`,
      [teamIds[0], userId]
    )

    await expect(
      buildAccessCatalog(
        { session, families: ['user', 'team'], limit: 1, cursor: page.nextCursor },
        { transaction: transaction(databasePool) }
      )
    ).rejects.toBeInstanceOf(AccessCatalogCursorError)
  })

  it('signs a complete per-producer continuation vector', async () => {
    const page = await buildAccessCatalog(
      { session, families: ['team'], limit: 1 },
      { transaction: transaction(databasePool) }
    )
    const budget = AccessExecutionBudget.create('catalog')
    try {
      const cursor = decodeAccessCatalogCursor(page.nextCursor!, budget)
      expect(Object.keys(cursor.producers)).toHaveLength(12)
      expect(cursor.producers.team.afterKey?.[1]).toBe('team')
      expect(cursor.producers.host).toEqual({ afterKey: null, exhausted: true })
    } finally {
      budget.close()
    }
  })
})
