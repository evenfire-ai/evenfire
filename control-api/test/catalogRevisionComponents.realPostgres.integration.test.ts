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
import { acknowledgeDesktopNotificationDelivery } from '../src/services/notificationAckService.js'
import {
  markUserBoundNotificationDeliveryFailed,
  markUserBoundNotificationDeliverySent,
  markUserBoundNotificationDeliverySkippedNoBot,
} from '../src/services/notificationDeliveryQueueService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

// Catalog writer tables and the revision component each one advances. This
// was a production table with no reader (P-13); it is now test data.
const CATALOG_WRITER_COMPONENTS = Object.freeze([
  ['users', 'user'],
  ['teams', 'team'],
  ['team_members', 'user+team'],
  ['user_contexts', 'user'],
  ['team_contexts', 'team'],
  ['user_agents', 'user'],
  ['team_agents', 'team'],
  ['user_workflow_triggers', 'user'],
  ['team_workflow_triggers', 'team'],
  ['workflow_runs', 'user+team'],
  ['workflow_approval_requests', 'user+team'],
  ['notification_deliveries', 'user+team'],
  ['gfs_resources', 'resource+gfs-subjects'],
  ['gfs_grants', 'resource+user+team'],
  ['gfs_shares', 'resource+user+team'],
  ['operational_resource_index', 'resource+source-state'],
  ['operational_resource_relationships', 'resource+source-state'],
  ['operational_catalog_source_state', 'source-state'],
] as const)

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

  async function teamRevision(teamId: string): Promise<number> {
    const result = await databasePool.query<{ revision: string }>(
      `SELECT revision::text FROM authorization_team_revisions WHERE team_id = $1`,
      [teamId]
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
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('maps the complete writer class without a singleton revision trigger', async () => {
    await applyComposableCatalogRevisionSchema(databasePool)
    await applyComposableCatalogRevisionSchema(databasePool)
    expect(CATALOG_WRITER_COMPONENTS).toHaveLength(18)
    const registry = await databasePool.query<{ relation: string | null }>(
      `SELECT to_regclass('public.authorization_catalog_writer_components')::text AS relation`
    )
    expect(registry.rows).toEqual([{ relation: null }])

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
    for (const [writerTable] of CATALOG_WRITER_COMPONENTS) {
      expect(triggered.has(writerTable) || directlyVersioned.has(writerTable), writerTable).toBe(
        true
      )
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

  it('bumps the team revision for allowed-team changes', async () => {
    const recipeName = `p10-${randomUUID()}`
    let revision = await teamRevision(teamIds[0])
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(recipe_namespace, recipe_name, team_id)
       VALUES ('sandbox-recipes', $1, $2)`,
      [recipeName, teamIds[0]]
    )
    expect(await teamRevision(teamIds[0])).toBeGreaterThan(revision)

    revision = await teamRevision(teamIds[0])
    await databasePool.query(
      `DELETE FROM workflow_recipe_allowed_teams
       WHERE recipe_namespace = 'sandbox-recipes' AND recipe_name = $1 AND team_id = $2`,
      [recipeName, teamIds[0]]
    )
    expect(await teamRevision(teamIds[0])).toBeGreaterThan(revision)
  })

  it('bumps the user revision for approval medium-account changes', async () => {
    let revision = await userRevision(userIds[1])
    const account = await databasePool.query<{ id: string }>(
      `INSERT INTO workflow_approval_medium_accounts(
         user_id, medium, provider_user_id, verified_at
       ) VALUES ($1, 'slack', $2, NOW())
       RETURNING id::text`,
      [userIds[1], `provider-${randomUUID()}`]
    )
    expect(await userRevision(userIds[1])).toBeGreaterThan(revision)

    revision = await userRevision(userIds[1])
    await databasePool.query(`DELETE FROM workflow_approval_medium_accounts WHERE id = $1`, [
      account.rows[0]!.id,
    ])
    expect(await userRevision(userIds[1])).toBeGreaterThan(revision)
  })

  it('leaves run subject revisions unchanged on heartbeats and bumps them on a subject change', async () => {
    const team = teamIds[0]
    const nextTeam = teamIds[1]
    const user = userIds[0]
    const run = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type,
         actor_id, team_id, usage_team_id, trigger_source)
       VALUES ($1, 'sandbox-recipes', 'revision-heartbeat', 'Pending', 'user', $2, $3, $4,
         'onDemand')`,
      [run, user, team, team]
    )
    const beforeUser = await userRevision(user)
    const beforeTeam = await teamRevision(team)
    const beforeNextTeam = await teamRevision(nextTeam)

    // The workflow-recipes reconciler SQL, run as its runtime role. None of
    // these statements changes a column a catalog consumer reads.
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE workflow_recipes_runtime')
      const progress = await client.query(
        `UPDATE workflow_runs
     SET last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $1
     AND phase IN ('Pending', 'Running')`,
        [run]
      )
      expect(progress.rowCount).toBe(1)
      const claim = await client.query(
        `UPDATE workflow_runs
     SET phase = 'Running',
         owner_instance_id = $1,
         child_recipe_name = $2,
         child_recipe_namespace = $3,
         started_at = now(),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $4
     AND phase = 'Pending'
     AND (owner_instance_id IS NULL OR owner_instance_id = $1)`,
        ['owner-heartbeat', null, null, run]
      )
      expect(claim.rowCount).toBe(1)
      const terminal = await client.query(
        `UPDATE workflow_runs
     SET phase = $1,
         completed_at = COALESCE($2::timestamptz, now()),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $3
     AND (
       phase IN ('Pending', 'Running')
       OR (phase = 'Failed' AND $1 = 'Succeeded')
     )`,
        ['Succeeded', null, run]
      )
      expect(terminal.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }

    // Write witness: the heartbeat rows really changed.
    expect(
      (
        await databasePool.query(
          `SELECT phase, last_reconciled_at IS NOT NULL AS reconciled,
                  started_at IS NOT NULL AS started, completed_at IS NOT NULL AS completed,
                  owner_instance_id
             FROM workflow_runs WHERE run_id = $1`,
          [run]
        )
      ).rows
    ).toEqual([
      {
        phase: 'Succeeded',
        reconciled: true,
        started: true,
        completed: true,
        owner_instance_id: 'owner-heartbeat',
      },
    ])
    // Negative witness: no subject revision moved.
    expect(await userRevision(user)).toBe(beforeUser)
    expect(await teamRevision(team)).toBe(beforeTeam)
    expect(await teamRevision(nextTeam)).toBe(beforeNextTeam)

    // Liveness witness in the same test: a subject change still bumps. The
    // team moves to nextTeam while the usage team stays on the old team, so the
    // NEW image bumps nextTeam and the old usage team, and the OLD image bumps
    // the old team and the old usage team: the old team moves three times.
    await databasePool.query('UPDATE workflow_runs SET team_id = $2 WHERE run_id = $1', [
      run,
      nextTeam,
    ])
    expect(await userRevision(user)).toBe(beforeUser + 2)
    expect(await teamRevision(team)).toBe(beforeTeam + 3)
    expect(await teamRevision(nextTeam)).toBe(beforeNextTeam + 1)
  })

  it('bumps ordered audit-run subjects and permits the Admin UI sentinel', async () => {
    const runId = randomUUID()
    let userBefore = await userRevision(userIds[0])
    let teamBefore = await teamRevision(teamIds[1])
    await databasePool.query(
      `INSERT INTO workflow_runs_audit(
         run_id, run_namespace, run_name, recipe_namespace, recipe_name,
         triggerer_team_id, usage_team_id, triggerer_user_id, triggerer_actor_type,
         trigger_source, idempotency_key, triggered_at, completed_at,
         final_phase, step_count, snapshot_sha
       ) VALUES (
         $1, 'revision', $2, 'sandbox-recipes', $2,
         $3, NULL, $4, 'user', 'onDemand', $5, NOW(), NOW(),
         'Succeeded', 0, 'p15-audit-witness'
       )`,
      [runId, `audit-${randomUUID()}`, teamIds[1], userIds[0], `audit-${randomUUID()}`]
    )
    expect(await userRevision(userIds[0])).toBeGreaterThan(userBefore)
    expect(await teamRevision(teamIds[1])).toBeGreaterThan(teamBefore)

    userBefore = await userRevision(userIds[0])
    teamBefore = await teamRevision(teamIds[1])
    await databasePool.query(`DELETE FROM workflow_runs_audit WHERE run_id = $1`, [runId])
    expect(await userRevision(userIds[0])).toBeGreaterThan(userBefore)
    expect(await teamRevision(teamIds[1])).toBeGreaterThan(teamBefore)

    const sentinelRunId = randomUUID()
    userBefore = await userRevision(userIds[1])
    teamBefore = await teamRevision(teamIds[0])
    await databasePool.query(
      `INSERT INTO workflow_runs_audit(
         run_id, run_namespace, run_name, recipe_namespace, recipe_name,
         triggerer_team_id, usage_team_id, triggerer_user_id, triggerer_actor_type,
         trigger_source, idempotency_key, triggered_at, completed_at,
         final_phase, step_count, snapshot_sha
       ) VALUES (
         $1, 'revision', $2, 'sandbox-recipes', $2,
         NULL, 'control-plane-admin-ui', NULL, 'scheduled', 'schedule', $3,
         NOW(), NOW(), 'Succeeded', 0, 'p15-sentinel-witness'
       )`,
      [sentinelRunId, `audit-${randomUUID()}`, `audit-${randomUUID()}`]
    )
    expect(await userRevision(userIds[1])).toBe(userBefore)
    expect(await teamRevision(teamIds[0])).toBe(teamBefore)

    await expect(
      databasePool.query(
        `INSERT INTO workflow_runs_audit(
           run_id, run_namespace, run_name, recipe_namespace, recipe_name,
           triggerer_team_id, usage_team_id, triggerer_user_id, triggerer_actor_type,
           trigger_source, idempotency_key, triggered_at, completed_at,
           final_phase, step_count, snapshot_sha
         ) VALUES (
           $1, 'revision', $2, 'sandbox-recipes', $2,
           NULL, 'not-a-uuid', NULL, 'scheduled', 'schedule', $3,
           NOW(), NOW(), 'Succeeded', 0, 'p15-invalid-witness'
         )`,
        [randomUUID(), `audit-${randomUUID()}`, `audit-${randomUUID()}`]
      )
    ).rejects.toMatchObject({ code: 'P0001' })
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

  it('leaves GFS resource revisions unchanged on content writes and bumps them on a rename', async () => {
    const resourceId = randomUUID()
    const drive = `r6-${randomBytes(4).toString('hex')}`
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, $2, 'content-resource', 'file')`,
      [resourceId, drive]
    )
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($3, $1, 'user', $2, ARRAY['read']::text[])`,
      [resourceId, userIds[0], drive]
    )
    const beforeResource = await resourceRevision(resourceId)
    const beforeUser = await userRevision(userIds[0])

    const blobKey = `${resourceId.replaceAll('-', '')}/${randomUUID()}`
    const contentSha = 'a'.repeat(64)
    // The gfs-controller content save: version, bytes, blob_key, content_sha256.
    await databasePool.query(
      `UPDATE gfs_resources
          SET version = version + 1,
              bytes = 4096,
              blob_key = $2,
              content_sha256 = $3,
              updated_at = clock_timestamp()
        WHERE resource_id = $1`,
      [resourceId, blobKey, contentSha]
    )
    // Write witness: the content save really changed the row.
    expect(
      (
        await databasePool.query(
          `SELECT version, bytes::text AS bytes, blob_key, content_sha256
             FROM gfs_resources WHERE resource_id = $1`,
          [resourceId]
        )
      ).rows
    ).toEqual([
      {
        version: 1,
        bytes: '4096',
        blob_key: blobKey,
        content_sha256: contentSha,
      },
    ])
    // Negative witness: a content save is not a catalog change, neither for the
    // resource component nor for its direct grant subjects.
    expect(await resourceRevision(resourceId)).toBe(beforeResource)
    expect(await userRevision(userIds[0])).toBe(beforeUser)

    // Liveness witness in the same test: a rename still bumps both.
    await databasePool.query(
      `UPDATE gfs_resources SET name = 'content-resource-renamed' WHERE resource_id = $1`,
      [resourceId]
    )
    expect(await resourceRevision(resourceId)).toBe(beforeResource + 1)
    expect(await userRevision(userIds[0])).toBe(beforeUser + 1)
  })

  it('leaves notification subject revisions unchanged on delivery state writes and bumps them when a catalog column changes', async () => {
    const notificationUser = userIds[0]
    const notificationTeam = teamIds[0]
    async function delivery(
      eventType: string,
      audience: Record<string, string>,
      payload: Record<string, unknown>
    ): Promise<string> {
      const result = await databasePool.query<{ id: string }>(
        `INSERT INTO notification_deliveries(
           event_type, dedupe_key, audience, payload, status, next_attempt_at
         ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 'queued', NOW() - INTERVAL '1 minute')
         RETURNING id::text`,
        [
          eventType,
          `notification-revision-${randomUUID()}`,
          JSON.stringify(audience),
          JSON.stringify(payload),
        ]
      )
      return result.rows[0]!.id
    }

    // One row per writer (N6): every mark* only writes while its row is still
    // queued/retrying, so a row reused after `sent` would make the next call a
    // silent no-op and its negative assertion vacuous.
    const sentRow = await delivery('approval.requested', { userId: notificationUser }, {})
    const failedRow = await delivery('approval.requested', { userId: notificationUser }, {})
    // At least one state write targets a team audience, so the team negative
    // has a write witness of its own.
    const skippedRow = await delivery('approval.requested', { teamId: notificationTeam }, {})
    const claimRow = await delivery('approval.requested', { userId: notificationUser }, {})
    // No `notificationId` in the payload: the ack then skips
    // markSdkNotificationDelivered, which writes through the module pool
    // instead of the test client (notificationAckService.ts:36-39).
    const desktopRow = await delivery(
      'plugin_workload_sdk.notification',
      { userId: notificationUser },
      { origin: 'plugin_workload_sdk', title: 'no invocation' }
    )
    const beforeUser = await userRevision(notificationUser)
    const beforeTeam = await teamRevision(notificationTeam)

    // The real exported writers, each against the test pool as their `db`.
    expect(await markUserBoundNotificationDeliverySent(sentRow, databasePool)).toBe(true)
    expect(await markUserBoundNotificationDeliveryFailed(failedRow, databasePool)).toBe(true)
    expect(await markUserBoundNotificationDeliverySkippedNoBot(skippedRow, databasePool)).toBe(true)
    expect(
      await acknowledgeDesktopNotificationDelivery(notificationUser, desktopRow, databasePool)
    ).toEqual({ status: 'acked' })
    // The claims' literal SET clause (notificationDeliveryQueueService.ts:315-321,
    // :698-704); both claims change only these three columns.
    await databasePool.query(
      `UPDATE notification_deliveries nd
          SET status = 'retrying',
              attempts = nd.attempts + 1,
              next_attempt_at = NOW() + INTERVAL '30 seconds'
        WHERE nd.id = $1`,
      [claimRow]
    )

    // Write witness: the state writes really changed the rows.
    const written = await databasePool.query<{
      id: string
      status: string
      attempts: number
      delivered_medium: string | null
    }>(
      `SELECT id::text, status, attempts, delivered_medium
         FROM notification_deliveries
        WHERE id = ANY($1::uuid[])`,
      [[sentRow, failedRow, skippedRow, claimRow, desktopRow]]
    )
    expect(Object.fromEntries(written.rows.map(row => [row.id, row]))).toEqual({
      [sentRow]: { id: sentRow, status: 'sent', attempts: 0, delivered_medium: null },
      [failedRow]: { id: failedRow, status: 'retrying', attempts: 0, delivered_medium: null },
      [skippedRow]: {
        id: skippedRow,
        status: 'skipped_no_bot',
        attempts: 0,
        delivered_medium: null,
      },
      [claimRow]: { id: claimRow, status: 'retrying', attempts: 1, delivered_medium: null },
      [desktopRow]: { id: desktopRow, status: 'sent', attempts: 0, delivered_medium: 'desktop' },
    })
    // Negative witness: none of the delivery state writes is a catalog change.
    expect(await userRevision(notificationUser)).toBe(beforeUser)
    expect(await teamRevision(notificationTeam)).toBe(beforeTeam)

    // Liveness in the same test. Each step starts from a fresh row, and each
    // UPDATE bumps the NEW and the OLD subject of its own row.
    const expiresRow = await delivery('approval.requested', { userId: notificationUser }, {})
    let userBefore = await userRevision(notificationUser)
    await databasePool.query(
      `UPDATE notification_deliveries
          SET expires_at = NOW() + INTERVAL '1 hour'
        WHERE id = $1`,
      [expiresRow]
    )
    // One user audience: NEW user +1 and OLD user +1.
    expect(await userRevision(notificationUser)).toBe(userBefore + 2)

    const eventTypeRow = await delivery('approval.requested', { userId: notificationUser }, {})
    userBefore = await userRevision(notificationUser)
    await databasePool.query(
      `UPDATE notification_deliveries SET event_type = 'approval.updated' WHERE id = $1`,
      [eventTypeRow]
    )
    // event_type is the hydration display name (catalogHydrationSql.ts:629).
    expect(await userRevision(notificationUser)).toBe(userBefore + 2)

    const audienceRow = await delivery('approval.requested', { userId: notificationUser }, {})
    userBefore = await userRevision(notificationUser)
    let teamBefore = await teamRevision(notificationTeam)
    await databasePool.query(
      `UPDATE notification_deliveries SET audience = $2::jsonb WHERE id = $1`,
      [audienceRow, JSON.stringify({ teamId: notificationTeam })]
    )
    // user -> team: OLD user +1, NEW team +1.
    expect(await userRevision(notificationUser)).toBe(userBefore + 1)
    expect(await teamRevision(notificationTeam)).toBe(teamBefore + 1)
    userBefore = await userRevision(notificationUser)
    teamBefore = await teamRevision(notificationTeam)
    await databasePool.query(
      `UPDATE notification_deliveries SET audience = $2::jsonb WHERE id = $1`,
      [audienceRow, JSON.stringify({ userId: notificationUser })]
    )
    // team -> user: OLD team +1, NEW user +1; the round trip is user +2, team +2.
    expect(await userRevision(notificationUser)).toBe(userBefore + 1)
    expect(await teamRevision(notificationTeam)).toBe(teamBefore + 1)

    const deleteRow = await delivery('approval.requested', { teamId: notificationTeam }, {})
    teamBefore = await teamRevision(notificationTeam)
    await databasePool.query('DELETE FROM notification_deliveries WHERE id = $1', [deleteRow])
    // DELETE bumps the removed row's subject once.
    expect(await teamRevision(notificationTeam)).toBe(teamBefore + 1)

    userBefore = await userRevision(notificationUser)
    await delivery('approval.requested', { userId: notificationUser }, {})
    // A new delivery has a random id that can sort before a client cursor, so
    // INSERT keeps bumping once.
    expect(await userRevision(notificationUser)).toBe(userBefore + 1)
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
      authGeneration: 1,
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
