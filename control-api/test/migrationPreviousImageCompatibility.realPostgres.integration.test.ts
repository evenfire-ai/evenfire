import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
/**
 * sha256 of dev's team writer: `createTeam` and `createTeamForUser`, the code this
 * test runs, as one slice of teams.ts. Only that slice is pinned, so other
 * functions in the file can change without the test running anything but dev's
 * writer.
 */
const PRE_D34_TEAMS_WRITER_SHA256 =
  '83aa2e9868be7618a049a5da5ce37d5598ddf0241b1e8364eb97c44a8535ada4'

/** From `export async function createTeam(` to the closing brace of `createTeamForUser`. */
function teamWriterSource(source: string): string {
  const start = source.indexOf('export async function createTeam(')
  const forUser = source.indexOf('export async function createTeamForUser(', start)
  const end = source.indexOf('\n}\n', forUser)
  if (start < 0 || forUser < 0 || end < 0) {
    throw new Error('the team writer was not found in teams.ts')
  }
  return source.slice(start, end + 2)
}

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
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      vi.doUnmock('../src/db.js')
      vi.resetModules()
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it("runs dev's team writer against the PR1 schema", async () => {
    const writerSource = teamWriterSource(
      readFileSync(new URL('../src/services/directory/teams.ts', import.meta.url), 'utf8')
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
  })

  it('lets the runtime role delete a user and a team with a deleted membership', async () => {
    const userId = randomUUID()
    const teamId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'D34 runtime delete')`,
      [userId, `d34-runtime-delete-${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'D34 runtime delete')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'deleted')`,
      [teamId, userId]
    )

    vi.resetModules()
    const actualDb = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
    vi.doMock('../src/db.js', () => ({
      ...actualDb,
      pool: databasePool,
      withTransaction: <T>(work: (client: PoolClient) => Promise<T>) =>
        withDatabaseTransaction(databasePool, async client => {
          await client.query('SET LOCAL ROLE control_api_runtime')
          return work(client)
        }),
    }))
    const [{ adminDeleteTeam }, { adminDeleteUser }] = await Promise.all([
      import('../src/services/directory/teams.js'),
      import('../src/services/directory/users.js'),
    ])

    expect(await adminDeleteUser(userId)).toEqual({ ok: true, id: userId })
    expect(await adminDeleteTeam(teamId)).toEqual({ ok: true, id: teamId })
    expect(await databasePool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])).toMatchObject({
      rowCount: 0,
    })
    expect(await databasePool.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])).toMatchObject({
      rowCount: 0,
    })
  })
})
