import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import { AccessCatalogCursorError } from '../src/services/access/accessCatalogCursor.js'
import { GFS_HYDRATION_SQL } from '../src/services/access/catalogHydrationSql.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { applyComposableCatalogRevisionSchema } from '../src/services/access/userAccessFoundationSchema.js'
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
    const client = await pool.connect()
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

describeRealPostgres('composable catalog revisions on real PostgreSQL', () => {
  const database = `control_api_catalog_revision_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userIds = [randomUUID(), randomUUID()]
  const teamIds = [randomUUID(), randomUUID()]
  let adminPool: Pool
  let databasePool: Pool

  async function userRevision(userId: string): Promise<number> {
    const result = await databasePool.query<{ revision: string }>(
      `SELECT revision::text FROM authorization_user_revisions WHERE user_id = $1`,
      [userId]
    )
    return Number(result.rows[0]?.revision ?? 1)
  }

  async function resourceRevision(resourceId: string): Promise<number> {
    const result = await databasePool.query<{ revision: string }>(
      `SELECT revision::text
         FROM authorization_resource_revisions
        WHERE environment_id = $1
          AND resource_type = 'gfs_resource'
          AND resource_id = $2`,
      [canonicalEnvironmentId(), resourceId]
    )
    return Number(result.rows[0]?.revision ?? 0)
  }

  async function backendPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return result.rows[0]!.pid
  }

  async function waitForBlock(blockedPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await databasePool.query<{ blocked: boolean }>(
        `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
        [blockedPid, blockerPid]
      )
      if (result.rows[0]?.blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('expected revision writer to block on the same component')
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    for (const [index, userId] of userIds.entries()) {
      await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
        userId,
        `revision-${index}-${userId}@example.test`,
        `Revision ${index}`,
      ])
    }
    for (const [index, teamId] of teamIds.entries()) {
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `Revision Team ${index}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [teamId, userIds[0]]
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

  it('maps the complete writer class without a singleton revision trigger', async () => {
    await applyComposableCatalogRevisionSchema(databasePool)
    await applyComposableCatalogRevisionSchema(databasePool)
    const mappings = await databasePool.query<{
      writer_table: string
      component_class: string
    }>(
      `SELECT writer_table, component_class
         FROM authorization_catalog_writer_components
        ORDER BY catalog_utf8_bytes(writer_table)`
    )
    expect(mappings.rows).toHaveLength(18)
    expect(mappings.rows.filter(row => row.writer_table.startsWith('gfs_'))).toEqual([
      { writer_table: 'gfs_grants', component_class: 'resource+user+team' },
      { writer_table: 'gfs_resources', component_class: 'resource+gfs-subjects' },
      { writer_table: 'gfs_shares', component_class: 'resource+user+team' },
    ])

    const globalTriggers = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE '%_catalog_revision'`
    )
    expect(globalTriggers.rows).toEqual([{ count: '0' }])

    const triggerTables = await databasePool.query<{ table_name: string }>(
      `SELECT DISTINCT event_object_table AS table_name
         FROM information_schema.triggers
        WHERE trigger_name LIKE '%_authorization_revision'`
    )
    const directlyVersioned = new Set(['operational_catalog_source_state'])
    const triggered = new Set(triggerTables.rows.map(row => row.table_name))
    for (const mapping of mappings.rows) {
      expect(
        triggered.has(mapping.writer_table) || directlyVersioned.has(mapping.writer_table),
        mapping.writer_table
      ).toBe(true)
    }
  })

  it('commits and rolls back only the relevant principal component', async () => {
    const initial = await userRevision(userIds[0])
    const unrelatedInitial = await userRevision(userIds[1])

    const rollback = await databasePool.connect()
    try {
      await rollback.query('BEGIN')
      await rollback.query(`UPDATE users SET name = 'rolled back' WHERE id = $1`, [userIds[0]])
      await rollback.query('ROLLBACK')
    } finally {
      rollback.release()
    }
    expect(await userRevision(userIds[0])).toBe(initial)

    await databasePool.query(`UPDATE users SET name = 'committed' WHERE id = $1`, [userIds[0]])
    expect(await userRevision(userIds[0])).toBeGreaterThan(initial)
    expect(await userRevision(userIds[1])).toBe(unrelatedInitial)
  })

  it('bumps the mapped principal for dynamic catalog writer classes', async () => {
    let revision = await userRevision(userIds[0])
    const workflowRun = await databasePool.query<{ run_id: string }>(
      `INSERT INTO workflow_runs(
         recipe_namespace, recipe_name, phase, actor_type, actor_id, trigger_source
       ) VALUES ('sandbox-recipes', 'revision-test', 'Pending', 'user', $1, 'onDemand')
       RETURNING run_id::text`,
      [userIds[0]]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)

    revision = await userRevision(userIds[0])
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         recipe_namespace, recipe_name, expires_at, status, target_user_id,
         payload, idempotency_key
       ) VALUES ('sandbox-recipes', 'revision-test', NOW() + INTERVAL '1 hour',
                 'pending', $1, '{}'::jsonb, $2)`,
      [userIds[0], `revision-${randomUUID()}`]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)

    revision = await userRevision(userIds[0])
    await databasePool.query(
      `INSERT INTO notification_deliveries(
         event_type, dedupe_key, audience, payload, status
       ) VALUES ('revision.test', $1, jsonb_build_object('userId', $2::text), '{}'::jsonb, 'queued')`,
      [`revision-${randomUUID()}`, userIds[0]]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)

    const resourceId = randomUUID()
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, '3rd', 'revision-test', 'file')`,
      [resourceId]
    )
    revision = await userRevision(userIds[0])
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ('3rd', $1, 'user', $2, ARRAY['read']::text[])`,
      [resourceId, userIds[0]]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)

    revision = await userRevision(userIds[0])
    await databasePool.query(
      `UPDATE gfs_resources SET name = 'revision-test-2' WHERE resource_id = $1`,
      [resourceId]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)

    revision = await userRevision(userIds[0])
    await databasePool.query(`DELETE FROM workflow_runs WHERE run_id = $1`, [
      workflowRun.rows[0]!.run_id,
    ])
    expect(await userRevision(userIds[0])).toBeGreaterThan(revision)
  })

  it('moves GFS resource and subject components for the complete writer class', async () => {
    const firstResourceId = randomUUID()
    const secondResourceId = randomUUID()
    const firstDrive = `r6-${randomBytes(4).toString('hex')}`
    const secondDrive = `r6-${randomBytes(4).toString('hex')}`
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, $3, 'resource-one', 'file'),
              ($2, $4, 'resource-two', 'file')`,
      [firstResourceId, secondResourceId, firstDrive, secondDrive]
    )
    const firstInsertedRevision = await resourceRevision(firstResourceId)
    const secondInsertedRevision = await resourceRevision(secondResourceId)
    expect(firstInsertedRevision).toBeGreaterThan(0)
    expect(secondInsertedRevision).toBeGreaterThan(0)

    const grant = await databasePool.query<{ id: string }>(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($3, $1, 'user', $2, ARRAY['read']::text[])
       RETURNING id::text`,
      [firstResourceId, userIds[0], firstDrive]
    )
    expect(await resourceRevision(firstResourceId)).toBeGreaterThan(firstInsertedRevision)
    expect(await resourceRevision(secondResourceId)).toBe(secondInsertedRevision)

    const beforeMoveFirst = await resourceRevision(firstResourceId)
    const beforeMoveSecond = await resourceRevision(secondResourceId)
    await databasePool.query(`UPDATE gfs_grants SET resource_id = $2, drive = $3 WHERE id = $1`, [
      grant.rows[0]!.id,
      secondResourceId,
      secondDrive,
    ])
    expect(await resourceRevision(firstResourceId)).toBeGreaterThan(beforeMoveFirst)
    expect(await resourceRevision(secondResourceId)).toBeGreaterThan(beforeMoveSecond)

    const share = await databasePool.query<{ id: string }>(
      `INSERT INTO gfs_shares(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($3, $1, 'team', $2, ARRAY['read']::text[])
       RETURNING id::text`,
      [firstResourceId, teamIds[0], firstDrive]
    )
    const beforeShareMoveFirst = await resourceRevision(firstResourceId)
    const beforeShareMoveSecond = await resourceRevision(secondResourceId)
    await databasePool.query(`UPDATE gfs_shares SET resource_id = $2, drive = $3 WHERE id = $1`, [
      share.rows[0]!.id,
      secondResourceId,
      secondDrive,
    ])
    expect(await resourceRevision(firstResourceId)).toBeGreaterThan(beforeShareMoveFirst)
    expect(await resourceRevision(secondResourceId)).toBeGreaterThan(beforeShareMoveSecond)

    const beforeGrantDelete = await resourceRevision(secondResourceId)
    await databasePool.query(`DELETE FROM gfs_grants WHERE id = $1`, [grant.rows[0]!.id])
    expect(await resourceRevision(secondResourceId)).toBeGreaterThan(beforeGrantDelete)

    const beforeShareDelete = await resourceRevision(secondResourceId)
    await databasePool.query(`DELETE FROM gfs_shares WHERE id = $1`, [share.rows[0]!.id])
    expect(await resourceRevision(secondResourceId)).toBeGreaterThan(beforeShareDelete)

    const beforeRollback = await resourceRevision(firstResourceId)
    const rollback = await databasePool.connect()
    try {
      await rollback.query('BEGIN')
      await rollback.query(`UPDATE gfs_resources SET name = 'rolled-back' WHERE resource_id = $1`, [
        firstResourceId,
      ])
      await rollback.query('ROLLBACK')
    } finally {
      rollback.release()
    }
    expect(await resourceRevision(firstResourceId)).toBe(beforeRollback)

    const userRevisionBefore = await userRevision(userIds[0])
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($3, $1, 'user', $2, ARRAY['read']::text[])`,
      [firstResourceId, userIds[0], firstDrive]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(userRevisionBefore)

    const hydratedBefore = await databasePool.query<{ resource_revision: string }>(
      GFS_HYDRATION_SQL,
      [userIds[0], [firstResourceId], canonicalEnvironmentId(), 8]
    )
    const beforeResourceUpdate = await resourceRevision(firstResourceId)
    await databasePool.query(
      `UPDATE gfs_resources SET name = name || '-changed' WHERE resource_id = $1`,
      [firstResourceId]
    )
    const hydratedAfter = await databasePool.query<{ resource_revision: string }>(
      GFS_HYDRATION_SQL,
      [userIds[0], [firstResourceId], canonicalEnvironmentId(), 8]
    )
    expect(await resourceRevision(firstResourceId)).toBeGreaterThan(beforeResourceUpdate)
    expect(Number(hydratedAfter.rows[0]?.resource_revision)).toBeGreaterThan(
      Number(hydratedBefore.rows[0]?.resource_revision)
    )
  })

  it('preserves concurrent GFS invalidation increments on one resource component', async () => {
    const resourceId = randomUUID()
    const drive = `r6-${randomBytes(4).toString('hex')}`
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, $2, 'concurrent-resource', 'file')`,
      [resourceId, drive]
    )
    const before = await resourceRevision(resourceId)
    const blocker = await databasePool.connect()
    const blocked = await databasePool.connect()
    try {
      await blocker.query('BEGIN')
      await blocked.query('BEGIN')
      const blockerPid = await backendPid(blocker)
      const blockedPid = await backendPid(blocked)
      await blocker.query('SELECT authorization_bump_gfs_resource_component($1)', [resourceId])
      const pending = blocked.query('SELECT authorization_bump_gfs_resource_component($1)', [
        resourceId,
      ])
      await waitForBlock(blockedPid, blockerPid)
      await blocker.query('COMMIT')
      await pending
      await blocked.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocked.query('ROLLBACK').catch(() => undefined)
      blocker.release()
      blocked.release()
    }
    expect(await resourceRevision(resourceId)).toBe(before + 2)
  })

  it('does not serialize independent components and preserves same-component increments', async () => {
    const first = await databasePool.connect()
    const second = await databasePool.connect()
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await first.query('SELECT authorization_bump_user_revision($1)', [userIds[0]])

      await expect(
        second.query('SELECT authorization_bump_user_revision($1)', [userIds[1]])
      ).resolves.toBeDefined()
      await second.query('COMMIT')
      await first.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      first.release()
      second.release()
    }

    const before = await userRevision(userIds[0])
    const blocker = await databasePool.connect()
    const blocked = await databasePool.connect()
    try {
      await blocker.query('BEGIN')
      await blocked.query('BEGIN')
      const blockerPid = await backendPid(blocker)
      const blockedPid = await backendPid(blocked)
      await blocker.query('SELECT authorization_bump_user_revision($1)', [userIds[0]])
      const pending = blocked.query('SELECT authorization_bump_user_revision($1)', [userIds[0]])
      await waitForBlock(blockedPid, blockerPid)
      await blocker.query('COMMIT')
      await pending
      await blocked.query('COMMIT')
    } finally {
      blocker.release()
      blocked.release()
    }
    expect(await userRevision(userIds[0])).toBe(before + 2)
  })

  it('rejects a cursor after a committed relevant component change', async () => {
    const session: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: userIds[0],
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
    }
    const first = await buildAccessCatalog(
      { session, families: ['team'], limit: 1 },
      { transaction: transaction(databasePool) }
    )
    expect(first.nextCursor).not.toBeNull()

    await databasePool.query(`UPDATE teams SET name = name || ' changed' WHERE id = $1`, [
      teamIds[0],
    ])

    await expect(
      buildAccessCatalog(
        { session, families: ['team'], limit: 1, cursor: first.nextCursor },
        { transaction: transaction(databasePool) }
      )
    ).rejects.toEqual(expect.objectContaining<AccessCatalogCursorError>({ code: 'stale_cursor' }))
  })

  it('reads authority data and its component from one repeatable-read snapshot', async () => {
    const snapshot = await databasePool.connect()
    try {
      await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const before = await snapshot.query<{ name: string; revision: string }>(
        `SELECT teams.name, revisions.revision::text
           FROM teams
           JOIN authorization_team_revisions revisions ON revisions.team_id = teams.id
          WHERE teams.id = $1`,
        [teamIds[1]]
      )
      await databasePool.query(`UPDATE teams SET name = name || ' committed' WHERE id = $1`, [
        teamIds[1],
      ])
      const during = await snapshot.query<{ name: string; revision: string }>(
        `SELECT teams.name, revisions.revision::text
           FROM teams
           JOIN authorization_team_revisions revisions ON revisions.team_id = teams.id
          WHERE teams.id = $1`,
        [teamIds[1]]
      )
      expect(during.rows).toEqual(before.rows)
      await snapshot.query('COMMIT')

      const after = await databasePool.query<{ name: string; revision: string }>(
        `SELECT teams.name, revisions.revision::text
           FROM teams
           JOIN authorization_team_revisions revisions ON revisions.team_id = teams.id
          WHERE teams.id = $1`,
        [teamIds[1]]
      )
      expect(after.rows[0]?.name).not.toBe(before.rows[0]?.name)
      expect(Number(after.rows[0]?.revision)).toBeGreaterThan(Number(before.rows[0]?.revision))
    } finally {
      await snapshot.query('ROLLBACK').catch(() => undefined)
      snapshot.release()
    }
  })
})
