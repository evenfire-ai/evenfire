import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const PRE_D34_TEAMS_WRITER_SHA256 =
  'b91e7c4cec80a4c4e7be7d92b380d1a28fda2493e96a6047aca9be864c9cde5b'

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function withDatabaseTransaction<T>(
  databasePool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await databasePool.connect()
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

describeRealPostgres('D34 previous-image writer compatibility on real PostgreSQL', () => {
  const database = `control_api_d34_previous_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    vi.doUnmock('../src/db.js')
    vi.resetModules()
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.end()
    }
  })

  it('runs the byte-identical pre-D34 team writer against the final additive schema', async () => {
    const writerSource = readFileSync(
      new URL('../src/services/directory/teams.ts', import.meta.url)
    )
    expect(createHash('sha256').update(writerSource).digest('hex')).toBe(
      PRE_D34_TEAMS_WRITER_SHA256
    )

    const actualDb = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
    vi.doMock('../src/db.js', () => ({
      ...actualDb,
      pool: databasePool,
      withTransaction: <T>(work: (client: PoolClient) => Promise<T>) =>
        withDatabaseTransaction(databasePool, work),
    }))
    const { createTeamForUser } = await import('../src/services/directory/teams.js')

    const userId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'D34 previous writer')`,
      [userId, `d34-previous-${userId}@example.test`]
    )
    const team = await createTeamForUser(userId, 'D34 previous-image team')

    const membership = await databasePool.query<{ role: string; status: string }>(
      `SELECT role, status FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [team.id, userId]
    )
    expect(membership.rows).toEqual([{ role: 'admin', status: 'active' }])
    const revision = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM authorization_team_revisions
        WHERE team_id = $1`,
      [team.id]
    )
    expect(Number(revision.rows[0]?.count ?? 0)).toBeGreaterThan(0)
  })
})
