import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { accessCatalogGrantSql } from '../src/services/access/accessCatalog.js'

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

describeRealPostgres('aggregate access catalog real PostgreSQL producer', () => {
  const database = `access_catalog_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const teamA = randomUUID()
  const teamB = randomUUID()
  let adminPool: Pool
  let dbPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString })
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => dbPool.connect() })

    await dbPool.query(`INSERT INTO users(id, email) VALUES($1, 'catalog@example.com')`, [userId])
    await dbPool.query(`INSERT INTO teams(id, name) VALUES($1, 'Team A'), ($2, 'Team B')`, [
      teamA,
      teamB,
    ])
    await dbPool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $3, 'member', 'active'), ($2, $3, 'admin', 'active')`,
      [teamA, teamB, userId]
    )
    await dbPool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES($1, 'shared-host')`, [
      userId,
    ])
    await dbPool.query(
      `INSERT INTO team_agents(team_id, agent_name)
       VALUES($1, 'shared-host'), ($2, 'shared-host')`,
      [teamA, teamB]
    )
  }, 120_000)

  afterAll(async () => {
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      await adminPool.end()
    }
  })

  it('returns one direct and every active team path in one set-based query with an executable plan', async () => {
    const result = await dbPool.query(accessCatalogGrantSql(), [
      userId,
      'test:postgres',
      'mcp-host',
      'mcp-server',
      [],
      10_000,
      50_000,
    ])
    const hostPaths = result.rows.filter(
      row => row.resource_type === 'host' && row.logical_id === 'shared-host'
    )

    expect(hostPaths.map(row => [row.kind, row.team_id].filter(Boolean)).sort()).toEqual(
      [['direct'], ['team', teamA], ['team', teamB]].sort()
    )

    const explain = await dbPool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${accessCatalogGrantSql()}`,
      [userId, 'test:postgres', 'mcp-host', 'mcp-server', [], 10_000, 50_000]
    )
    expect(explain.rows[0]?.['QUERY PLAN']).toBeDefined()
  })
})
