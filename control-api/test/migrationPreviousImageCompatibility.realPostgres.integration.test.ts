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

  it('installs deletion-compatible revision functions on fresh initialization', async () => {
    const functionState = await databasePool.query<{
      name: string
      config: string[] | null
      definition: string
    }>(`SELECT proname AS name, proconfig AS config, pg_get_functiondef(oid) AS definition
         FROM pg_proc
        WHERE oid = ANY(ARRAY[
          'public.authorization_bump_team_revision(uuid)'::regprocedure,
          'public.authorization_bump_user_revision(uuid)'::regprocedure
        ])
        ORDER BY proname`)
    expect(functionState.rows.map(row => row.name)).toEqual([
      'authorization_bump_team_revision',
      'authorization_bump_user_revision',
    ])
    for (const [name, parentTable, targetId] of [
      ['authorization_bump_team_revision', 'teams', 'target_team_id'],
      ['authorization_bump_user_revision', 'users', 'target_user_id'],
    ]) {
      const state = functionState.rows.find(row => row.name === name)
      expect(state?.config).toContain('search_path=pg_catalog, public, pg_temp')
      expect(state?.definition).toMatch(
        new RegExp(`SELECT ${parentTable}\\.id[\\s\\S]*FROM ${parentTable}`, 'i')
      )
      expect(state?.definition).not.toMatch(new RegExp(`VALUES\\s*\\(${targetId}`, 'i'))
    }
    expect(
      await databasePool.query(
        `SELECT 1 FROM schema_migrations
          WHERE version = '0138_authorization_revision_delete_compatibility'`
      )
    ).toMatchObject({ rowCount: 1 })
  })

  it('fixes an applied 0125 prefix before previous writers delete users or teams', async () => {
    const writerSource = readFileSync(
      new URL('../src/services/directory/teams.ts', import.meta.url)
    )
    expect(createHash('sha256').update(writerSource).digest('hex')).toBe(
      PRE_D34_TEAMS_WRITER_SHA256
    )

    const userId = randomUUID()
    const teamId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'D34 prefix repair')`,
      [userId, `d34-prefix-${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'D34 prefix repair')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'deleted')`,
      [teamId, userId]
    )

    const before = await databasePool.query<{
      name: string
      owner: string
      acl: string[] | null
      config: string[] | null
    }>(
      `SELECT proname AS name, pg_get_userbyid(proowner) AS owner, proacl AS acl,
              proconfig AS config
         FROM pg_proc
        WHERE oid = ANY(ARRAY[
          'public.authorization_bump_team_revision(uuid)'::regprocedure,
          'public.authorization_bump_user_revision(uuid)'::regprocedure
        ])
        ORDER BY proname`
    )
    expect(before.rows).toHaveLength(2)

    await databasePool.query(`
      CREATE OR REPLACE FUNCTION public.authorization_bump_user_revision(target_user_id UUID)
      RETURNS VOID
      LANGUAGE SQL
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        INSERT INTO authorization_user_revisions(user_id, revision, updated_at)
        VALUES(target_user_id, 1, clock_timestamp())
        ON CONFLICT (user_id) DO UPDATE
          SET revision = authorization_user_revisions.revision + 1,
              updated_at = clock_timestamp();
      $$;

      CREATE OR REPLACE FUNCTION public.authorization_bump_team_revision(target_team_id UUID)
      RETURNS VOID
      LANGUAGE SQL
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        INSERT INTO authorization_team_revisions(team_id, revision, updated_at)
        VALUES(target_team_id, 1, clock_timestamp())
        ON CONFLICT (team_id) DO UPDATE
          SET revision = authorization_team_revisions.revision + 1,
              updated_at = clock_timestamp();
      $$;
    `)

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
    await expect(adminDeleteTeam(teamId)).rejects.toMatchObject({ code: '23503' })
    await expect(adminDeleteUser(userId)).rejects.toMatchObject({ code: '23503' })

    await databasePool.query(
      `DELETE FROM schema_migrations
        WHERE version = '0138_authorization_revision_delete_compatibility'`
    )
    await initDb({ connect: () => databasePool.connect() })

    const repaired = await databasePool.query<{
      name: string
      owner: string
      acl: string[] | null
      config: string[] | null
      definition: string
    }>(
      `SELECT proname AS name,
              pg_get_userbyid(proowner) AS owner,
              proacl AS acl,
              proconfig AS config,
              pg_get_functiondef(oid) AS definition
         FROM pg_proc
        WHERE oid = ANY(ARRAY[
          'public.authorization_bump_team_revision(uuid)'::regprocedure,
          'public.authorization_bump_user_revision(uuid)'::regprocedure
        ])
        ORDER BY proname`
    )
    expect(repaired.rows).toHaveLength(2)
    for (const [name, parentTable, targetId] of [
      ['authorization_bump_team_revision', 'teams', 'target_team_id'],
      ['authorization_bump_user_revision', 'users', 'target_user_id'],
    ]) {
      const current = repaired.rows.find(row => row.name === name)
      const original = before.rows.find(row => row.name === name)
      expect(current?.config).toContain('search_path=pg_catalog, public, pg_temp')
      expect(current?.definition).toMatch(
        new RegExp(`SELECT ${parentTable}\\.id[\\s\\S]*FROM ${parentTable}`, 'i')
      )
      expect(current?.definition).not.toMatch(new RegExp(`VALUES\\s*\\(${targetId}`, 'i'))
      expect(current?.owner).toBe(original?.owner)
      expect(current?.acl).toEqual(original?.acl)
    }
    expect(await adminDeleteUser(userId)).toEqual({ ok: true, id: userId })
    expect(await adminDeleteTeam(teamId)).toEqual({ ok: true, id: teamId })
    expect(await databasePool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])).toMatchObject({
      rowCount: 0,
    })
    expect(await databasePool.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])).toMatchObject({
      rowCount: 0,
    })
    expect(
      await databasePool.query(
        `SELECT 1 FROM schema_migrations
          WHERE version = '0138_authorization_revision_delete_compatibility'`
      )
    ).toMatchObject({ rowCount: 1 })
  })
})
