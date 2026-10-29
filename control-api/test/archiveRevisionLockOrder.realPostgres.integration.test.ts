import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'
import { initDb, pool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { archiveTerminalApprovals } from '../src/services/userApprovalRequestArchiveService.js'
import {
  expirePendingRequests,
  recordDecision,
} from '../src/services/userApprovalRequestService.js'
import { createApprovedRun, createRun } from '../src/services/workflowRunService.js'
import { archiveTerminalRuns } from '../src/services/workflowRunsArchiveService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const barrierClass = 33_406
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
]
const gateway = { deleteResource: vi.fn() } as unknown as K8sGateway

type Outcome = { status: 'fulfilled'; value: unknown } | { status: 'rejected'; code: string }

function observe(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', code: String(error.code) })
  )
}

describeRealPostgres('archive batches and phase updates share revision lock order', () => {
  const database = `control_api_archive_order_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let databasePool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    databasePool = new Pool({ connectionString: url.toString(), max: 12 })
    await initDb({ connect: () => databasePool.connect() })
    // Only a test AFTER trigger pauses after a real revision upsert has
    // acquired its lock. Production SQL and bump functions run unchanged.
    await databasePool.query(`
      CREATE TABLE archive_order_barriers (
        application_name TEXT NOT NULL,
        revision_table TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        gate INTEGER NOT NULL
      );
      CREATE TABLE archive_delete_revision_observations (
        position BIGSERIAL, application_name TEXT, revision_table TEXT,
        subject_id TEXT, revision BIGINT
      );
      CREATE FUNCTION archive_order_barrier() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE barrier RECORD;
      BEGIN
        IF current_setting('application_name') LIKE 'archive-delete-%'
          OR current_setting('application_name') LIKE 'delete-principal-%'
          OR current_setting('application_name') LIKE 'approval-archive-%'
          OR current_setting('application_name') LIKE 'approval-expiry-%'
          OR current_setting('application_name') LIKE 'approval-decision-%'
          OR current_setting('application_name') LIKE 'approval-approved-run-%'
          OR current_setting('application_name') LIKE 'recipe-delete-%' THEN
          INSERT INTO archive_delete_revision_observations
            (application_name, revision_table, subject_id, revision)
          VALUES (current_setting('application_name'), TG_TABLE_NAME,
            COALESCE(to_jsonb(NEW)->>'user_id', to_jsonb(NEW)->>'team_id'), NEW.revision);
        END IF;
        FOR barrier IN
          SELECT gate FROM archive_order_barriers
           WHERE application_name = current_setting('application_name')
             AND revision_table = TG_TABLE_NAME
             AND (subject_id = '' OR subject_id = COALESCE(
               to_jsonb(NEW)->>'user_id', to_jsonb(NEW)->>'team_id'))
        LOOP
          PERFORM pg_advisory_xact_lock(${barrierClass}, barrier.gate);
        END LOOP;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER archive_order_barrier AFTER INSERT OR UPDATE
        ON authorization_user_revisions FOR EACH ROW EXECUTE FUNCTION archive_order_barrier();
      CREATE TRIGGER archive_order_barrier AFTER INSERT OR UPDATE
        ON authorization_team_revisions FOR EACH ROW EXECUTE FUNCTION archive_order_barrier();
    `)
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function fixture() {
    const users = [randomUUID(), randomUUID()]
    const teams = [randomUUID(), randomUUID()]
    const archived = [randomUUID(), randomUUID()]
    const live = [randomUUID(), randomUUID()]
    for (const user of users) {
      await databasePool.query(
        "INSERT INTO users(id, email, name) VALUES ($1, $2, 'Archive order')",
        [user, `archive-${user}@example.test`]
      )
    }
    for (const team of teams) {
      await databasePool.query('INSERT INTO teams(id, name) VALUES ($1, $2)', [
        team,
        `Archive team ${team}`,
      ])
    }
    for (const index of [0, 1]) {
      await databasePool.query(
        `
        INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
          team_id, trigger_source, completed_at, ttl_seconds_after_finished)
        VALUES ($1, 'revision', 'archive-order', 'Succeeded', 'user', $2, $3, 'onDemand',
          NOW() - interval '2 hours', 0)
      `,
        [archived[index], users[index], teams[index]]
      )
      await databasePool.query(
        `
        INSERT INTO workflow_run_steps(run_id, step_id, phase)
        VALUES ($1, 'archive-step', 'Succeeded')
      `,
        [archived[index]]
      )
      // Whichever old row is visited first, a live run shares its user and
      // the other old row's team. The test observes, rather than assumes, order.
      await databasePool.query(
        `
        INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
          team_id, trigger_source)
        VALUES ($1, 'revision', 'live-order', 'Pending', 'user', $2, $3, 'onDemand')
      `,
        [live[index], users[index], teams[1 - index]]
      )
    }
    return { users, teams, archived, live }
  }

  async function revisions(ids: { users: string[]; teams: string[] }) {
    const user = await databasePool.query(
      'SELECT user_id::text AS id, revision::int FROM authorization_user_revisions WHERE user_id = ANY($1::uuid[]) ORDER BY user_id',
      [ids.users]
    )
    const team = await databasePool.query(
      'SELECT team_id::text AS id, revision::int FROM authorization_team_revisions WHERE team_id = ANY($1::uuid[]) ORDER BY team_id',
      [ids.teams]
    )
    return { user: user.rows, team: team.rows }
  }

  async function pid(client: PoolClient): Promise<number> {
    return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  }

  function byId(rows: Array<{ id: string; revision: number }>): Record<string, number> {
    return Object.fromEntries(rows.map(row => [row.id, row.revision]))
  }

  // Bind the real archive/expiry service to one configured session for its
  // first transaction; later drain batches get ordinary pooled connections.
  function bindFirstSession(session: PoolClient) {
    let connects = 0
    return vi.spyOn(pool, 'connect').mockImplementation(() => {
      connects += 1
      return connects === 1 ? Promise.resolve(session) : databasePool.connect()
    })
  }

  async function waitForBlock(blocked: number, blockers: number[]) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await databasePool.query('SELECT pg_blocking_pids($1::int) AS pids', [blocked])
      const blocker = blockers.find(candidate => result.rows[0].pids.includes(candidate))
      if (blocker !== undefined) {
        console.info('ARCHIVE_ORDER_BLOCK', { blocked, blocker, observed: result.rows[0].pids })
        return blocker
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`writer ${blocked} did not block on one of ${blockers.join(', ')}`)
  }

  async function configure(client: PoolClient, application: string) {
    await client.query("SELECT set_config('application_name', $1, false)", [application])
    await client.query("SET deadlock_timeout = '100ms'")
    await client.query("SET statement_timeout = '8s'")
  }

  async function archivedWitness(ids: { archived: string[] }) {
    expect(
      (
        await databasePool.query(
          'SELECT run_id FROM workflow_runs WHERE run_id = ANY($1::uuid[])',
          [ids.archived]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (
        await databasePool.query(
          'SELECT run_id FROM workflow_run_steps WHERE run_id = ANY($1::uuid[])',
          [ids.archived]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (
        await databasePool.query(
          'SELECT run_id FROM workflow_runs_audit WHERE run_id = ANY($1::uuid[])',
          [ids.archived]
        )
      ).rows
    ).toHaveLength(2)
    expect(
      (
        await databasePool.query(
          'SELECT run_id FROM workflow_run_step_audit WHERE run_id = ANY($1::uuid[])',
          [ids.archived]
        )
      ).rows
    ).toHaveLength(2)
  }

  // One archive batch holding a user-targeted approval and a team-targeted one,
  // drained by the real archive sweep.
  async function approvalFixture() {
    const [userApprovalId, teamApprovalId] = [randomUUID(), randomUUID()].sort()
    const user = randomUUID()
    const team = randomUUID()
    const live = randomUUID()
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      user,
      `approval-order-${user}@example.test`,
    ])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Approval order')", [team])
    // The user-targeted approval is first in heap order and lower in id order,
    // so both a sequential and an index scan reach its subject first.
    const targets = [
      [userApprovalId, 'target_user_id', user],
      [teamApprovalId, 'target_team_id', team],
    ] as const
    for (const [id, column, target] of targets) {
      await databasePool.query(
        `INSERT INTO workflow_approval_requests(
           id, recipe_namespace, recipe_name, expires_at, status, ${column},
           payload, idempotency_key, requested_at, decided_at
         ) VALUES ($1, 'revision', 'approval-order', NOW() - INTERVAL '200 days',
           'approved', $2, '{}'::jsonb, $3, NOW() - INTERVAL '200 days',
           NOW() - INTERVAL '200 days')`,
        [id, target, `approval-order-${id}`]
      )
    }
    // A live run shares the team and the user, so a phase write takes T then U.
    await databasePool.query(
      `INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type,
         actor_id, team_id, trigger_source)
       VALUES ($1, 'revision', 'approval-order', 'Pending', 'user', $2, $3, 'onDemand')`,
      [live, user, team]
    )
    return { userApprovalId, teamApprovalId, user, team, live }
  }

  // Two pending approvals that the expiry sweep already considers expired: the
  // user-targeted row is first in heap order and lower in id order.
  async function expiryFixture() {
    const [userApprovalId, teamApprovalId] = [randomUUID(), randomUUID()].sort()
    const user = randomUUID()
    const team = randomUUID()
    const live = randomUUID()
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      user,
      `approval-expiry-${user}@example.test`,
    ])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Approval expiry')", [team])
    const targets = [
      [userApprovalId, 'target_user_id', user],
      [teamApprovalId, 'target_team_id', team],
    ] as const
    for (const [id, column, target] of targets) {
      await databasePool.query(
        `INSERT INTO workflow_approval_requests(
           id, recipe_namespace, recipe_name, expires_at, status, ${column},
           payload, idempotency_key, requested_at
         ) VALUES ($1, 'revision', 'approval-expiry', NOW() - INTERVAL '1 hour',
           'pending', $2, '{}'::jsonb, $3, NOW() - INTERVAL '2 hours')`,
        [id, target, `approval-expiry-${id}`]
      )
    }
    await databasePool.query(
      `INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type,
         actor_id, team_id, trigger_source)
       VALUES ($1, 'revision', 'approval-expiry', 'Pending', 'user', $2, $3, 'onDemand')`,
      [live, user, team]
    )
    return { userApprovalId, teamApprovalId, user, team, live }
  }

  it('archives two rows and advances revisions with a run-insert liveness witness', async () => {
    const ids = await fixture()
    const before = await revisions(ids)
    const connect = vi.spyOn(pool, 'connect').mockImplementation(() => databasePool.connect())
    try {
      expect(await archiveTerminalRuns(gateway, { batchSize: 500, maxBatches: 1 })).toBe(2)
      await archivedWitness(ids)
      // A phase-only UPDATE no longer bumps revisions, so the witness is a run
      // INSERT of the same user and the other live run's team.
      const created = await createRun(
        {
          recipe_namespace: 'revision',
          recipe_name: 'archive-order-witness',
          actor_type: 'user',
          team_id: ids.teams[1],
          usage_team_id: ids.teams[1],
          actor_id: ids.users[0],
          idempotency_key: null,
          trigger_source: 'onDemand',
          ttl_seconds_after_finished: 2_592_000,
        },
        databasePool
      )
      expect(created.created).toBe(true)
      const after = await revisions(ids)
      // Archive: prelock + live DELETE + audit INSERT, one bump each per
      // subject. The INSERT adds one bump for the user and, because team and
      // usage team are the same subject, two for that team.
      expect(byId(after.user)).toEqual({
        [ids.users[0]!]: byId(before.user)[ids.users[0]!]! + 4,
        [ids.users[1]!]: byId(before.user)[ids.users[1]!]! + 3,
      })
      expect(byId(after.team)).toEqual({
        [ids.teams[0]!]: byId(before.team)[ids.teams[0]!]! + 3,
        [ids.teams[1]!]: byId(before.team)[ids.teams[1]!]! + 5,
      })
    } finally {
      connect.mockRestore()
    }
  })

  it('commits an archive batch beside a run INSERT without reversing subject locks', async () => {
    const ids = await fixture()
    const before = await revisions(ids)
    const archiveGate = await databasePool.connect()
    const competitorGate = await databasePool.connect()
    const archive = await databasePool.connect()
    const competitor = await databasePool.connect()
    const archivePid = await pid(archive)
    const competitorPid = await pid(competitor)
    const archiveGatePid = await pid(archiveGate)
    const competitorGatePid = await pid(competitorGate)
    let archiveOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    let archiveStarted = false
    let firstIndex = -1
    let outcomes: Outcome[] = []
    // The connection boundary binds the actual archive service to this real
    // database. Neither archiveOneBatch nor the INSERT SQL is replaced.
    const connect = vi.spyOn(pool, 'connect').mockResolvedValue(archive)
    try {
      await configure(archive, 'archive-order-archive')
      await configure(competitor, 'archive-order-insert')
      await archiveGate.query('SELECT pg_advisory_lock($1, 1), pg_advisory_lock($1, 2)', [
        barrierClass,
      ])
      await competitorGate.query('SELECT pg_advisory_lock($1, 3)', [barrierClass])
      await databasePool.query(
        `
        INSERT INTO archive_order_barriers VALUES
          ('archive-order-archive', 'authorization_user_revisions', $1, 1),
          ('archive-order-archive', 'authorization_user_revisions', $2, 2),
          ('archive-order-insert', 'authorization_team_revisions', '', 3)
      `,
        ids.users
      )
      archiveStarted = true
      archiveOutcome = observe(archiveTerminalRuns(gateway, { batchSize: 500, maxBatches: 1 }))
      await waitForBlock(archivePid, [archiveGatePid])
      const waiting = await databasePool.query(
        `
        SELECT objid::int AS gate FROM pg_locks
         WHERE pid = $1 AND locktype = 'advisory' AND NOT granted AND classid = $2::oid
      `,
        [archivePid, barrierClass]
      )
      expect(waiting.rows).toHaveLength(1)
      expect([1, 2]).toContain(waiting.rows[0].gate)
      firstIndex = waiting.rows[0].gate - 1
      console.info('ARCHIVE_ORDER_FIRST_USER', {
        index: firstIndex,
        user: ids.users[firstIndex],
        team: ids.teams[firstIndex],
      })
      await competitor.query('BEGIN')
      // A phase-only UPDATE no longer bumps revisions, so the competitor is a
      // run INSERT of the user the archive holds and the other live team.
      competitorOutcome = observe(
        createRun(
          {
            recipe_namespace: 'revision',
            recipe_name: 'archive-order-competitor',
            actor_type: 'user',
            team_id: ids.teams[1 - firstIndex],
            usage_team_id: ids.teams[1 - firstIndex],
            actor_id: ids.users[firstIndex],
            idempotency_key: null,
            trigger_source: 'onDemand',
            ttl_seconds_after_finished: 2_592_000,
          },
          competitor
        )
      )
      const competitorBlocker = await waitForBlock(competitorPid, [competitorGatePid, archivePid])
      if (competitorBlocker === competitorGatePid) {
        // Without the prelock, the INSERT holds the other team's revision
        // before waiting on the archive's first user: a cycle.
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [archivePid])
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        // With the prelock, the archive already holds both teams before
        // reaching its first user. The INSERT waits at its first team.
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [competitorGatePid])
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
      }
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [await archiveOutcome, competitorResult]
      console.info(
        'ARCHIVE_ORDER_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
    } finally {
      await archiveGate.query('SELECT pg_advisory_unlock_all()')
      await competitorGate.query('SELECT pg_advisory_unlock_all()')
      await competitorOutcome
      await competitor.query('ROLLBACK')
      await archiveOutcome
      connect.mockRestore()
      for (const client of [archiveGate, competitorGate, competitor]) client.release()
      if (!archiveStarted) archive.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 2 })
    await archivedWitness(ids)
    const after = await revisions(ids)
    // Archive: prelock + live DELETE + audit INSERT, one bump each per subject.
    // The INSERT adds one bump for the user it names and, because team and
    // usage team are one subject, two for that team.
    expect(byId(after.user)).toEqual({
      [ids.users[firstIndex]!]: byId(before.user)[ids.users[firstIndex]!]! + 4,
      [ids.users[1 - firstIndex]!]: byId(before.user)[ids.users[1 - firstIndex]!]! + 3,
    })
    expect(byId(after.team)).toEqual({
      [ids.teams[1 - firstIndex]!]: byId(before.team)[ids.teams[1 - firstIndex]!]! + 5,
      [ids.teams[firstIndex]!]: byId(before.team)[ids.teams[firstIndex]!]! + 3,
    })
    expect(
      (
        await databasePool.query(
          `SELECT phase FROM workflow_runs WHERE actor_id = $1 AND team_id = $2
            AND recipe_name = 'archive-order-competitor'`,
          [ids.users[firstIndex], ids.teams[1 - firstIndex]]
        )
      ).rows
    ).toEqual([{ phase: 'Pending' }])
  })

  it.each(['user', 'team'] as const)(
    'commits an archive batch beside %s deletion with parent-before-revision locks',
    async kind => {
      const user = randomUUID()
      const team = randomUUID()
      const run = randomUUID()
      await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
        user,
        `${user}@example.test`,
      ])
      await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Archive delete')", [team])
      await databasePool.query(
        `INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type,
           actor_id, team_id, trigger_source, completed_at, ttl_seconds_after_finished)
         VALUES ($1, 'revision', 'archive-delete', 'Succeeded', 'user', $2, $3,
           'onDemand', NOW() - interval '3 hours', 0)`,
        [run, user, team]
      )
      await databasePool.query(
        "INSERT INTO workflow_run_steps(run_id, step_id, phase) VALUES ($1, 'delete-step', 'Succeeded')",
        [run]
      )
      const ids = { users: [user], teams: [team] }
      const before = await revisions(ids)
      const archiveGate = await databasePool.connect()
      const archive = await databasePool.connect()
      const deletion = await databasePool.connect()
      const archivePid = await pid(archive)
      const deletionPid = await pid(deletion)
      const gatePid = await pid(archiveGate)
      const subject = kind === 'user' ? user : team
      const revisionTable = `authorization_${kind}_revisions`
      let archiveOutcome: Promise<Outcome> | undefined
      let deletionOutcome: Promise<Outcome> | undefined
      const connect = vi.spyOn(pool, 'connect').mockResolvedValue(archive)
      try {
        await configure(archive, `archive-delete-${kind}`)
        await configure(deletion, `delete-principal-${kind}`)
        await archiveGate.query('SELECT pg_advisory_lock($1, 10)', [barrierClass])
        await databasePool.query('INSERT INTO archive_order_barriers VALUES ($1, $2, $3, 10)', [
          `archive-delete-${kind}`,
          revisionTable,
          subject,
        ])
        archiveOutcome = observe(archiveTerminalRuns(gateway, { batchSize: 1, maxBatches: 1 }))
        // The real prelock has bumped the subject and holds its revision row.
        await waitForBlock(archivePid, [gatePid])
        deletionOutcome = observe(
          deletion.query(`DELETE FROM ${kind === 'user' ? 'users' : 'teams'} WHERE id = $1`, [
            subject,
          ])
        )
        await waitForBlock(deletionPid, [archivePid])
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
        const outcomes = await Promise.all([archiveOutcome, deletionOutcome])
        console.info('ARCHIVE_DELETE_OUTCOMES', { kind, outcomes })
        expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 1 })
        expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { rowCount: 1 } })
        expect(
          (
            await databasePool.query(
              `SELECT id FROM ${kind === 'user' ? 'users' : 'teams'} WHERE id = $1`,
              [subject]
            )
          ).rows
        ).toHaveLength(0)
        expect(
          (await databasePool.query('SELECT run_id FROM workflow_runs WHERE run_id = $1', [run]))
            .rows
        ).toHaveLength(0)
        expect(
          (
            await databasePool.query('SELECT run_id FROM workflow_run_steps WHERE run_id = $1', [
              run,
            ])
          ).rows
        ).toHaveLength(0)
        expect(
          (
            await databasePool.query(
              'SELECT run_id, triggerer_user_id, triggerer_team_id FROM workflow_runs_audit WHERE run_id = $1',
              [run]
            )
          ).rows
        ).toEqual([
          {
            run_id: run,
            triggerer_user_id: kind === 'user' ? null : user,
            triggerer_team_id: kind === 'team' ? null : team,
          },
        ])
        expect(
          (
            await databasePool.query(
              'SELECT step_id FROM workflow_run_step_audit WHERE run_id = $1',
              [run]
            )
          ).rows
        ).toEqual([{ step_id: 'delete-step' }])
        const after = await revisions(ids)
        const deleted = kind === 'user' ? 'user' : 'team'
        const surviving = kind === 'user' ? 'team' : 'user'
        expect(after[deleted]).toEqual([])
        // Archive: prelock + audit INSERT + live DELETE. Principal deletion
        // nulls audit attribution, bumping its surviving subject twice.
        expect(after[surviving]).toEqual([
          {
            id: before[surviving][0].id,
            revision: before[surviving][0].revision + 5,
          },
        ])
        for (const revisionKind of ['user', 'team'] as const) {
          const recorded = await databasePool.query(
            `SELECT revision::int FROM archive_delete_revision_observations
             WHERE application_name = $1 AND revision_table = $2 AND subject_id = $3
             ORDER BY position`,
            [
              `archive-delete-${kind}`,
              `authorization_${revisionKind}_revisions`,
              revisionKind === 'user' ? user : team,
            ]
          )
          expect(recorded.rows).toEqual(
            [1, 2, 3].map(delta => ({ revision: before[revisionKind][0].revision + delta }))
          )
        }
        console.info(
          'ARCHIVE_DELETE_WITNESSES',
          JSON.stringify({ kind, before, after, archived: run, deleted: subject })
        )
      } finally {
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
        await Promise.all([archiveOutcome, deletionOutcome])
        connect.mockRestore()
        if (!archiveOutcome) archive.release()
        archiveGate.release()
        deletion.release()
        await databasePool.query('TRUNCATE archive_order_barriers')
        await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1', [run])
        await databasePool.query('DELETE FROM workflow_runs_audit WHERE run_id = $1', [run])
        await databasePool.query('DELETE FROM users WHERE id = $1', [user])
        await databasePool.query('DELETE FROM teams WHERE id = $1', [team])
      }
    }
  )

  it('creates missing revisions once per subject in team-then-user order', async () => {
    const ids = await fixture()
    const usageTeam = randomUUID()
    const adminActor = randomUUID()
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Usage team')", [usageTeam])
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      adminActor,
      `${adminActor}@example.test`,
    ])
    await databasePool.query('UPDATE workflow_runs SET usage_team_id = $2 WHERE run_id = $1', [
      ids.archived[0],
      ids.teams[1],
    ])
    await databasePool.query('UPDATE workflow_runs SET usage_team_id = $2 WHERE run_id = $1', [
      ids.archived[1],
      usageTeam,
    ])
    await databasePool.query(
      `UPDATE workflow_runs SET actor_type = 'admin', actor_id = $2,
         usage_team_id = 'control-plane-admin-ui' WHERE run_id = $1`,
      [ids.live[1], adminActor]
    )
    const subjects = { users: ids.users, teams: [...ids.teams, usageTeam] }
    const adminBefore = await revisions({ users: [adminActor], teams: [] })
    await databasePool.query(
      'DELETE FROM authorization_user_revisions WHERE user_id = ANY($1::uuid[])',
      [subjects.users]
    )
    await databasePool.query(
      'DELETE FROM authorization_team_revisions WHERE team_id = ANY($1::uuid[])',
      [subjects.teams]
    )
    await databasePool.query(`
      CREATE TABLE archive_prelock_observations (
        position BIGSERIAL, subject_type TEXT, subject_id TEXT
      );
      CREATE FUNCTION observe_archive_prelock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO archive_prelock_observations(subject_type, subject_id)
        VALUES (
          CASE WHEN TG_TABLE_NAME = 'authorization_team_revisions' THEN 'team' ELSE 'user' END,
          COALESCE(to_jsonb(NEW)->>'team_id', to_jsonb(NEW)->>'user_id')
        );
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER observe_archive_prelock AFTER INSERT OR UPDATE
        ON authorization_team_revisions FOR EACH ROW EXECUTE FUNCTION observe_archive_prelock();
      CREATE TRIGGER observe_archive_prelock AFTER INSERT OR UPDATE
        ON authorization_user_revisions FOR EACH ROW EXECUTE FUNCTION observe_archive_prelock();
    `)
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      for (const expectedRevision of [1, 2]) {
        await client.query('SELECT authorization_prelock_workflow_run_revisions($1::uuid[])', [
          [...ids.archived, ...ids.live, ids.archived[0], randomUUID()],
        ])
        const after = await client.query<{ revision: number }>(
          `SELECT revision::int FROM authorization_user_revisions WHERE user_id = ANY($1::uuid[])
           UNION ALL
           SELECT revision::int FROM authorization_team_revisions WHERE team_id = ANY($2::uuid[])`,
          [subjects.users, subjects.teams]
        )
        expect(after.rows).toEqual(
          Array.from({ length: 5 }, () => ({ revision: expectedRevision }))
        )
      }
      await client.query('COMMIT')
      const expectedOrder = [
        ...subjects.teams.sort().map(subject_id => ({ subject_type: 'team', subject_id })),
        ...subjects.users.sort().map(subject_id => ({ subject_type: 'user', subject_id })),
      ]
      const observed = await databasePool.query(
        'SELECT subject_type, subject_id FROM archive_prelock_observations ORDER BY position'
      )
      expect(observed.rows).toEqual([...expectedOrder, ...expectedOrder])
      expect(await revisions({ users: [adminActor], teams: [] })).toEqual(adminBefore)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await databasePool.query(`
        DROP TRIGGER observe_archive_prelock ON authorization_team_revisions;
        DROP TRIGGER observe_archive_prelock ON authorization_user_revisions;
        DROP FUNCTION observe_archive_prelock();
        DROP TABLE archive_prelock_observations;
      `)
    }
  })

  it('creates missing revisions once per approval-batch subject in team-then-user order', async () => {
    const targetUser = randomUUID()
    const runActor = randomUUID()
    const targetTeam = randomUUID()
    const runTeam = randomUUID()
    const usageTeam = randomUUID()
    const userApproval = randomUUID()
    const teamApproval = randomUUID()
    const run = randomUUID()
    for (const user of [targetUser, runActor]) {
      await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
        user,
        `approval-prelock-${user}@example.test`,
      ])
    }
    for (const team of [targetTeam, runTeam, usageTeam]) {
      await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Approval prelock')", [
        team,
      ])
    }
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_user_id,
         payload, idempotency_key
       ) VALUES ($1, 'revision', 'approval-prelock', NOW() + INTERVAL '1 hour', 'pending',
         $2, '{}'::jsonb, $3)`,
      [userApproval, targetUser, `approval-prelock-user-${userApproval}`]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_team_id,
         payload, idempotency_key
       ) VALUES ($1, 'revision', 'approval-prelock', NOW() + INTERVAL '1 hour', 'pending',
         $2, '{}'::jsonb, $3)`,
      [teamApproval, targetTeam, `approval-prelock-team-${teamApproval}`]
    )
    // The referencing run's attribution joins the approval targets.
    await databasePool.query(
      `INSERT INTO workflow_runs(run_id, recipe_namespace, recipe_name, phase, actor_type,
         actor_id, team_id, usage_team_id, trigger_source, approval_request_id)
       VALUES ($1, 'revision', 'approval-prelock', 'Pending', 'user', $2, $3, $4, 'onDemand', $5)`,
      [run, runActor, runTeam, usageTeam, userApproval]
    )
    const subjects = {
      users: [targetUser, runActor].sort(),
      teams: [targetTeam, runTeam, usageTeam].sort(),
    }
    await databasePool.query(
      'DELETE FROM authorization_user_revisions WHERE user_id = ANY($1::uuid[])',
      [subjects.users]
    )
    await databasePool.query(
      'DELETE FROM authorization_team_revisions WHERE team_id = ANY($1::uuid[])',
      [subjects.teams]
    )
    await databasePool.query(`
      CREATE TABLE approval_prelock_observations (
        position BIGSERIAL, subject_type TEXT, subject_id TEXT
      );
      CREATE FUNCTION observe_approval_prelock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO approval_prelock_observations(subject_type, subject_id)
        VALUES (
          CASE WHEN TG_TABLE_NAME = 'authorization_team_revisions' THEN 'team' ELSE 'user' END,
          COALESCE(to_jsonb(NEW)->>'team_id', to_jsonb(NEW)->>'user_id')
        );
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER observe_approval_prelock AFTER INSERT OR UPDATE
        ON authorization_team_revisions FOR EACH ROW EXECUTE FUNCTION observe_approval_prelock();
      CREATE TRIGGER observe_approval_prelock AFTER INSERT OR UPDATE
        ON authorization_user_revisions FOR EACH ROW EXECUTE FUNCTION observe_approval_prelock();
    `)
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE control_api_runtime')
      const expectedOrder = [
        ...subjects.teams.map(subject_id => ({ subject_type: 'team', subject_id })),
        ...subjects.users.map(subject_id => ({ subject_type: 'user', subject_id })),
      ]
      for (const expectedRevision of [1, 2]) {
        // The duplicate first id proves the batch is deduplicated.
        await client.query('SELECT authorization_prelock_workflow_approval_revisions($1::uuid[])', [
          [userApproval, teamApproval, userApproval, randomUUID()],
        ])
        const after = await client.query<{ revision: number }>(
          `SELECT revision::int FROM authorization_user_revisions WHERE user_id = ANY($1::uuid[])
           UNION ALL
           SELECT revision::int FROM authorization_team_revisions WHERE team_id = ANY($2::uuid[])`,
          [subjects.users, subjects.teams]
        )
        expect(after.rows).toEqual(
          Array.from({ length: 5 }, () => ({ revision: expectedRevision }))
        )
      }
      await client.query('COMMIT')
      // Each call bumps every subject once, teams before users.
      const observed = await databasePool.query(
        'SELECT subject_type, subject_id FROM approval_prelock_observations ORDER BY position'
      )
      expect(observed.rows).toEqual([...expectedOrder, ...expectedOrder])
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await databasePool.query(`
        DROP TRIGGER observe_approval_prelock ON authorization_team_revisions;
        DROP TRIGGER observe_approval_prelock ON authorization_user_revisions;
        DROP FUNCTION observe_approval_prelock();
        DROP TABLE approval_prelock_observations;
      `)
      await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1', [run])
      await databasePool.query(
        'DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
        [[userApproval, teamApproval]]
      )
      await databasePool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [subjects.users])
      await databasePool.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [subjects.teams])
    }
  })

  it('commits an approval archive batch beside a run INSERT without reversing subject locks', async () => {
    const ids = await approvalFixture()
    const before = await revisions({ users: [ids.user], teams: [ids.team] })
    const archiveGate = await databasePool.connect()
    const archive = await databasePool.connect()
    const competitor = await databasePool.connect()
    const archivePid = await pid(archive)
    const competitorPid = await pid(competitor)
    const gatePid = await pid(archiveGate)
    let archiveOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    const connect = bindFirstSession(archive)
    try {
      await configure(archive, 'approval-archive-order')
      await configure(competitor, 'approval-insert-order')
      await archiveGate.query('SELECT pg_advisory_lock($1, 21)', [barrierClass])
      await databasePool.query('INSERT INTO archive_order_barriers VALUES ($1, $2, $3, 21)', [
        'approval-archive-order',
        'authorization_user_revisions',
        ids.user,
      ])
      archiveOutcome = observe(archiveTerminalApprovals(180, 500))
      // The prelock pauses on the user only after taking the batch's team.
      await waitForBlock(archivePid, [gatePid])
      await competitor.query('BEGIN')
      // A phase-only UPDATE no longer bumps revisions, so the competitor is a
      // run INSERT of the same user and team.
      competitorOutcome = observe(
        createRun(
          {
            recipe_namespace: 'revision',
            recipe_name: 'approval-insert-competitor',
            actor_type: 'user',
            team_id: ids.team,
            usage_team_id: ids.team,
            actor_id: ids.user,
            idempotency_key: null,
            trigger_source: 'onDemand',
            ttl_seconds_after_finished: 2_592_000,
          },
          competitor
        )
      )
      // The INSERT takes its team first and waits there, so it can never hold
      // the team this batch already prelocked while asking for its user.
      await waitForBlock(competitorPid, [archivePid])
      await archiveGate.query('SELECT pg_advisory_unlock_all()')
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      const archiveResult = await archiveOutcome
      console.info('APPROVAL_ORDER_OUTCOMES', {
        archive: archiveResult,
        competitor: competitorResult,
      })
      expect([archiveResult.status, competitorResult.status]).toEqual(['fulfilled', 'fulfilled'])
      expect(archiveResult).toEqual({ status: 'fulfilled', value: 2 })
      expect(
        (
          await databasePool.query(
            `SELECT phase FROM workflow_runs WHERE actor_id = $1 AND team_id = $2
              AND recipe_name = 'approval-insert-competitor'`,
            [ids.user, ids.team]
          )
        ).rows
      ).toEqual([{ phase: 'Pending' }])
      expect(
        (
          await databasePool.query(
            'SELECT id FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
            [[ids.userApprovalId, ids.teamApprovalId]]
          )
        ).rows
      ).toHaveLength(0)
      // The prelock and the DELETE's row trigger bump each subject once; the
      // INSERT adds one user bump and two team bumps (team and usage team are
      // the same subject).
      const after = await revisions({ users: [ids.user], teams: [ids.team] })
      expect(after.user).toEqual([{ id: ids.user, revision: before.user[0]!.revision + 3 }])
      expect(after.team).toEqual([{ id: ids.team, revision: before.team[0]!.revision + 4 }])
      // The prelock takes the team first; the DELETE then meets the
      // user-targeted row first, as the fixture intends.
      expect(
        (
          await databasePool.query(
            `SELECT revision_table, subject_id FROM archive_delete_revision_observations
              WHERE application_name = $1 ORDER BY position`,
            ['approval-archive-order']
          )
        ).rows
      ).toEqual([
        { revision_table: 'authorization_team_revisions', subject_id: ids.team },
        { revision_table: 'authorization_user_revisions', subject_id: ids.user },
        { revision_table: 'authorization_user_revisions', subject_id: ids.user },
        { revision_table: 'authorization_team_revisions', subject_id: ids.team },
      ])
    } finally {
      await archiveGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([archiveOutcome, competitorOutcome])
      await competitor.query('ROLLBACK')
      connect.mockRestore()
      for (const client of [archiveGate, competitor]) client.release()
      if (!archiveOutcome) archive.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
      await databasePool.query(
        'DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
        [[ids.userApprovalId, ids.teamApprovalId]]
      )
      await databasePool.query(
        'DELETE FROM workflow_runs WHERE recipe_name = $1 AND actor_id = $2',
        ['approval-insert-competitor', ids.user]
      )
      await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1', [ids.live])
      await databasePool.query('DELETE FROM users WHERE id = $1', [ids.user])
      await databasePool.query('DELETE FROM teams WHERE id = $1', [ids.team])
    }
  })

  it('expires pending approvals beside a run INSERT without reversing subject locks', async () => {
    const ids = await expiryFixture()
    const before = await revisions({ users: [ids.user], teams: [ids.team] })
    const sweepGate = await databasePool.connect()
    const sweep = await databasePool.connect()
    const competitor = await databasePool.connect()
    const sweepPid = await pid(sweep)
    const competitorPid = await pid(competitor)
    const gatePid = await pid(sweepGate)
    let sweepOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    const connect = bindFirstSession(sweep)
    try {
      await configure(sweep, 'approval-expiry-sweep')
      await configure(competitor, 'approval-insert-order')
      // The sweep pauses on the user revision, after taking its team.
      await sweepGate.query('SELECT pg_advisory_lock($1, 22)', [barrierClass])
      await databasePool.query('INSERT INTO archive_order_barriers VALUES ($1, $2, $3, 22)', [
        'approval-expiry-sweep',
        'authorization_user_revisions',
        ids.user,
      ])
      sweepOutcome = observe(expirePendingRequests())
      await waitForBlock(sweepPid, [gatePid])
      await competitor.query('BEGIN')
      // A phase-only UPDATE no longer bumps revisions, so the competitor is a
      // run INSERT of the same user and team.
      competitorOutcome = observe(
        createRun(
          {
            recipe_namespace: 'revision',
            recipe_name: 'approval-expiry-competitor',
            actor_type: 'user',
            team_id: ids.team,
            usage_team_id: ids.team,
            actor_id: ids.user,
            idempotency_key: null,
            trigger_source: 'onDemand',
            ttl_seconds_after_finished: 2_592_000,
          },
          competitor
        )
      )
      // The INSERT takes its team first and waits there, so the sweep never has
      // to wait for the user it already holds.
      await waitForBlock(competitorPid, [sweepPid])
      await sweepGate.query('SELECT pg_advisory_unlock_all()')
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      const sweepResult = await sweepOutcome
      console.info('APPROVAL_EXPIRY_OUTCOMES', { sweep: sweepResult, competitor: competitorResult })
      expect([sweepResult.status, competitorResult.status]).toEqual(['fulfilled', 'fulfilled'])
      expect(sweepResult).toEqual({ status: 'fulfilled', value: 2 })
      expect(
        (
          await databasePool.query(
            `SELECT id::text AS id, status FROM workflow_approval_requests
              WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[ids.userApprovalId, ids.teamApprovalId]]
          )
        ).rows
      ).toEqual([
        { id: ids.userApprovalId, status: 'expired' },
        { id: ids.teamApprovalId, status: 'expired' },
      ])
      expect(
        (
          await databasePool.query(
            `SELECT phase FROM workflow_runs WHERE actor_id = $1 AND team_id = $2
              AND recipe_name = 'approval-expiry-competitor'`,
            [ids.user, ids.team]
          )
        ).rows
      ).toEqual([{ phase: 'Pending' }])
      // The prelock takes the team first; the UPDATE then meets the
      // user-targeted row first and bumps both sides of its attribution.
      expect(
        (
          await databasePool.query(
            `SELECT revision_table, subject_id FROM archive_delete_revision_observations
              WHERE application_name = $1 ORDER BY position`,
            ['approval-expiry-sweep']
          )
        ).rows
      ).toEqual([
        { revision_table: 'authorization_team_revisions', subject_id: ids.team },
        { revision_table: 'authorization_user_revisions', subject_id: ids.user },
        { revision_table: 'authorization_user_revisions', subject_id: ids.user },
        { revision_table: 'authorization_user_revisions', subject_id: ids.user },
        { revision_table: 'authorization_team_revisions', subject_id: ids.team },
        { revision_table: 'authorization_team_revisions', subject_id: ids.team },
      ])
      // Prelock plus the UPDATE's NEW and OLD attribution pairs, plus the
      // INSERT's one user bump and two team bumps (team and usage team are the
      // same subject).
      const after = await revisions({ users: [ids.user], teams: [ids.team] })
      expect(after.user).toEqual([{ id: ids.user, revision: before.user[0]!.revision + 4 }])
      expect(after.team).toEqual([{ id: ids.team, revision: before.team[0]!.revision + 5 }])
    } finally {
      await sweepGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([sweepOutcome, competitorOutcome])
      await competitor.query('ROLLBACK')
      connect.mockRestore()
      for (const client of [sweepGate, competitor]) client.release()
      if (!sweepOutcome) sweep.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
      await databasePool.query(
        'DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
        [[ids.userApprovalId, ids.teamApprovalId]]
      )
      await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1', [ids.live])
      await databasePool.query(
        'DELETE FROM workflow_runs WHERE recipe_name = $1 AND actor_id = $2',
        ['approval-expiry-competitor', ids.user]
      )
      await databasePool.query('DELETE FROM users WHERE id = $1', [ids.user])
      await databasePool.query('DELETE FROM teams WHERE id = $1', [ids.team])
    }
  })

  // A user-targeted approval whose stored run intent is team T, usage team T
  // and actor U, plus the trigger grant the approved-trigger paths require.
  async function triggerApprovalFixture(decision: 'pending' | 'approved') {
    const approvalId = randomUUID()
    const user = randomUUID()
    const team = randomUUID()
    const recipeName = `approval-trigger-${randomBytes(4).toString('hex')}`
    const idempotencyKey = `approval-trigger-${randomUUID()}`
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      user,
      `approval-trigger-${user}@example.test`,
    ])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Approval trigger')", [team])
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, 'revision', $2)`,
      [user, recipeName]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_user_id,
         payload, idempotency_key, requested_at, decided_at, decided_by_user_id
       ) VALUES ($1, 'revision', $2, NOW() + INTERVAL '1 hour', $3, $4::uuid, '{}'::jsonb, $5,
         NOW(), CASE WHEN $3 = 'approved' THEN NOW() END,
         CASE WHEN $3 = 'approved' THEN $4::uuid::text END)`,
      [approvalId, recipeName, decision, user, idempotencyKey]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_trigger_intents(
         approval_request_id, trigger_namespace, trigger_name, trigger_caller_key
       ) VALUES ($1, 'revision', $2, 'revision/' || $2)`,
      [approvalId, recipeName]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_trigger_run_intents(
         approval_request_id, actor_type, actor_id, team_id, usage_team_id,
         trigger_source, idempotency_key, idempotency_payload_hash,
         ttl_seconds_after_finished
       ) VALUES ($1, 'user', $2, $3, $4, 'onDemand', $5, 'hash-approval-trigger', 2592000)`,
      [approvalId, user, team, team, idempotencyKey]
    )
    return { approvalId, user, team, recipeName, idempotencyKey }
  }

  async function observedRevisions(application: string) {
    return (
      await databasePool.query(
        `SELECT revision_table, subject_id FROM archive_delete_revision_observations
          WHERE application_name = $1 ORDER BY position`,
        [application]
      )
    ).rows
  }

  async function triggerApprovalCleanup(ids: { approvalId: string; user: string; team: string }) {
    await databasePool.query('DELETE FROM workflow_runs WHERE approval_request_id = $1', [
      ids.approvalId,
    ])
    await databasePool.query('DELETE FROM workflow_approval_requests WHERE id = $1', [
      ids.approvalId,
    ])
    await databasePool.query('DELETE FROM user_workflow_triggers WHERE user_id = $1', [ids.user])
    await databasePool.query('DELETE FROM users WHERE id = $1', [ids.user])
    await databasePool.query('DELETE FROM teams WHERE id = $1', [ids.team])
  }

  // Returns the witness rows so the caller can assert them before cleanup.
  async function triggerApprovalWitness(ids: { approvalId: string; user: string; team: string }) {
    const runs = (
      await databasePool.query(
        `SELECT run_id, phase, approval_request_id, team_id, usage_team_id, actor_id
           FROM workflow_runs WHERE approval_request_id = $1`,
        [ids.approvalId]
      )
    ).rows
    const approval = (
      await databasePool.query('SELECT status FROM workflow_approval_requests WHERE id = $1', [
        ids.approvalId,
      ])
    ).rows
    return { runs, approval }
  }

  // A phase-only UPDATE no longer bumps the run's subjects, so the competing
  // writer is a run INSERT of the same team, usage team and actor: it takes the
  // team before the user, exactly as the approved-trigger paths do.
  function competingRunInsert(
    ids: { user: string; team: string },
    recipeName: string
  ): Parameters<typeof createRun>[0] {
    return {
      recipe_namespace: 'revision',
      recipe_name: recipeName,
      actor_type: 'user',
      team_id: ids.team,
      usage_team_id: ids.team,
      actor_id: ids.user,
      idempotency_key: null,
      trigger_source: 'onDemand',
      ttl_seconds_after_finished: 2_592_000,
    }
  }

  it('decides a user-targeted approval beside a run INSERT without reversing subject locks', async () => {
    const ids = await triggerApprovalFixture('pending')
    const decisionGate = await databasePool.connect()
    const competitorGate = await databasePool.connect()
    const decision = await databasePool.connect()
    const competitor = await databasePool.connect()
    const decisionPid = await pid(decision)
    const competitorPid = await pid(competitor)
    const decisionGatePid = await pid(decisionGate)
    const competitorGatePid = await pid(competitorGate)
    let decisionOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    let decisionSettled = false
    let outcomes: Outcome[] = []
    let witness: Awaited<ReturnType<typeof triggerApprovalWitness>> | undefined
    try {
      await configure(decision, 'approval-decision-order')
      await configure(competitor, 'approval-create-run')
      await decisionGate.query('SELECT pg_advisory_lock($1, 31)', [barrierClass])
      await competitorGate.query('SELECT pg_advisory_lock($1, 32)', [barrierClass])
      await databasePool.query(
        `INSERT INTO archive_order_barriers VALUES
           ('approval-decision-order', 'authorization_user_revisions', $1, 31),
           ('approval-create-run', 'authorization_team_revisions', '', 32)`,
        [ids.user]
      )
      await decision.query('BEGIN')
      decisionOutcome = observe(
        recordDecision(
          ids.approvalId,
          'approve',
          { userId: ids.user },
          undefined,
          undefined,
          decision
        )
      )
      // The decision locks the approval row and then its subjects; it pauses on
      // the user only after the team bump.
      await waitForBlock(decisionPid, [decisionGatePid])
      await competitor.query('BEGIN')
      competitorOutcome = observe(
        createRun(competingRunInsert(ids, 'approval-decision-competitor'), competitor)
      )
      const competitorBlocker = await waitForBlock(competitorPid, [decisionPid, competitorGatePid])
      if (competitorBlocker === competitorGatePid) {
        // Without the prelock the decision holds only the user, so the INSERT
        // takes the team and waits behind the barrier before asking for it.
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [decisionPid])
        await decisionGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        // With the prelock the decision already holds the team, so the INSERT
        // waits on the decision itself.
        await decisionGate.query('SELECT pg_advisory_unlock_all()')
        const decisionResult = await decisionOutcome
        await decision.query(decisionResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        decisionSettled = true
        await waitForBlock(competitorPid, [competitorGatePid])
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
      }
      const decisionResult = await decisionOutcome
      if (!decisionSettled) {
        await decision.query(decisionResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        decisionSettled = true
      }
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [decisionResult, competitorResult]
      console.info(
        'APPROVAL_TRIGGER_DECISION_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
      witness = await triggerApprovalWitness(ids)
    } finally {
      await decisionGate.query('SELECT pg_advisory_unlock_all()')
      await competitorGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([decisionOutcome, competitorOutcome])
      if (!decisionSettled) await decision.query('ROLLBACK')
      await competitor.query('ROLLBACK')
      for (const client of [decisionGate, competitorGate, decision, competitor]) client.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
      await triggerApprovalCleanup(ids)
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(witness).toEqual({
      runs: [
        {
          run_id: expect.any(String),
          phase: 'Pending',
          approval_request_id: ids.approvalId,
          team_id: ids.team,
          usage_team_id: ids.team,
          actor_id: ids.user,
        },
      ],
      approval: [{ status: 'consumed' }],
    })
    // The prelock holds the team before the user it pauses on; without it the
    // first subject is the approval target and this list starts with the user.
    const observed = await observedRevisions('approval-decision-order')
    expect(observed.slice(0, 2)).toEqual([
      { revision_table: 'authorization_team_revisions', subject_id: ids.team },
      { revision_table: 'authorization_user_revisions', subject_id: ids.user },
    ])
  })

  it('creates an approved run beside a run INSERT without reversing subject locks', async () => {
    const ids = await triggerApprovalFixture('approved')
    const approvedGate = await databasePool.connect()
    const competitorGate = await databasePool.connect()
    const approved = await databasePool.connect()
    const competitor = await databasePool.connect()
    const approvedPid = await pid(approved)
    const competitorPid = await pid(competitor)
    const approvedGatePid = await pid(approvedGate)
    const competitorGatePid = await pid(competitorGate)
    let approvedOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    let outcomes: Outcome[] = []
    let witness: Awaited<ReturnType<typeof triggerApprovalWitness>> | undefined
    const connect = vi.spyOn(pool, 'connect').mockResolvedValue(approved)
    try {
      await configure(approved, 'approval-approved-run-order')
      await configure(competitor, 'approval-create-run')
      await approvedGate.query('SELECT pg_advisory_lock($1, 33)', [barrierClass])
      await competitorGate.query('SELECT pg_advisory_lock($1, 34)', [barrierClass])
      await databasePool.query(
        `INSERT INTO archive_order_barriers VALUES
           ('approval-approved-run-order', 'authorization_user_revisions', $1, 33),
           ('approval-create-run', 'authorization_team_revisions', '', 34)`,
        [ids.user]
      )
      approvedOutcome = observe(
        createApprovedRun({
          ...competingRunInsert(ids, ids.recipeName),
          idempotency_key: ids.idempotencyKey,
          approval_request_id: ids.approvalId,
          idempotency_payload_hash: 'hash-approval-trigger',
          approval_caller_key: `revision/${ids.recipeName}`,
          correlation_id: 'approval-approved-run-order',
        })
      )
      // The consume prelock takes the team before the user it pauses on.
      await waitForBlock(approvedPid, [approvedGatePid])
      await competitor.query('BEGIN')
      competitorOutcome = observe(
        createRun(competingRunInsert(ids, 'approval-approved-run-competitor'), competitor)
      )
      const competitorBlocker = await waitForBlock(competitorPid, [approvedPid, competitorGatePid])
      if (competitorBlocker === competitorGatePid) {
        // Without the prelock the consumer holds only the user, so the INSERT
        // takes the team and waits behind the barrier before asking for it.
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [approvedPid])
        await approvedGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        await approvedGate.query('SELECT pg_advisory_unlock_all()')
        await approvedOutcome
        await waitForBlock(competitorPid, [competitorGatePid])
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
      }
      const approvedResult = await approvedOutcome
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [approvedResult, competitorResult]
      console.info(
        'APPROVAL_TRIGGER_APPROVED_RUN_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
      witness = await triggerApprovalWitness(ids)
    } finally {
      await approvedGate.query('SELECT pg_advisory_unlock_all()')
      await competitorGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([approvedOutcome, competitorOutcome])
      await competitor.query('ROLLBACK')
      connect.mockRestore()
      // The pool spy hands this client to createApprovedRun, which releases it
      // in its own finally; release it only when the call never started.
      if (!approvedOutcome) approved.release()
      for (const client of [approvedGate, competitorGate, competitor]) client.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
      await triggerApprovalCleanup(ids)
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(witness).toEqual({
      runs: [
        {
          run_id: expect.any(String),
          phase: 'Pending',
          approval_request_id: ids.approvalId,
          team_id: ids.team,
          usage_team_id: ids.team,
          actor_id: ids.user,
        },
      ],
      approval: [{ status: 'consumed' }],
    })
    const observed = await observedRevisions('approval-approved-run-order')
    expect(observed.slice(0, 2)).toEqual([
      { revision_table: 'authorization_team_revisions', subject_id: ids.team },
      { revision_table: 'authorization_user_revisions', subject_id: ids.user },
    ])
  })

  // The cleanup statements of WorkflowReconciler.reconcileDelete's transaction,
  // copied verbatim. The first new case below binds this copy to the production
  // file in the same order, so these tests exercise the real cleanup, not a
  // divergent local variant.
  const recipeDeleteStatements = {
    approvalLock: `SELECT id FROM workflow_approval_requests
              WHERE recipe_namespace = $1 AND recipe_name = $2
                AND status IN ('pending', 'approved')
              ORDER BY id
                FOR UPDATE`,
    prelock: 'SELECT authorization_prelock_workflow_recipe_policy_revisions($1, $2)',
    deleteUserGrants: `DELETE FROM user_workflow_triggers
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
    deleteTeamGrants: `DELETE FROM team_workflow_triggers
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
    deleteAllowedTeams: `DELETE FROM workflow_recipe_allowed_teams
              WHERE recipe_namespace = $1 AND recipe_name = $2`,
    legacyLookup: `SELECT to_regclass('public.workflow_recipe_allowed_users')::text AS "regclass"`,
    deleteLegacyGrants: `DELETE FROM workflow_recipe_allowed_users
                WHERE recipe_namespace = $1 AND recipe_name = $2`,
    cancelApprovals: `UPDATE workflow_approval_requests
                SET status = 'cancelled',
                    cancelled_at = COALESCE(cancelled_at, NOW()),
                    cancelled_by = COALESCE(cancelled_by, 'workflow-recipe-delete')
              WHERE recipe_namespace = $1
                AND recipe_name = $2
                AND status IN ('pending', 'approved')`,
  } as const

  async function runRecipeDeleteCleanup(
    client: PoolClient,
    recipe: { namespace: string; name: string }
  ): Promise<void> {
    await client.query(recipeDeleteStatements.approvalLock, [recipe.namespace, recipe.name])
    await client.query(recipeDeleteStatements.prelock, [recipe.namespace, recipe.name])
    for (const statement of [
      recipeDeleteStatements.deleteUserGrants,
      recipeDeleteStatements.deleteTeamGrants,
      recipeDeleteStatements.deleteAllowedTeams,
    ]) {
      await client.query(statement, [recipe.namespace, recipe.name])
    }
    const legacy = await client.query<{ regclass?: string | null }>(
      recipeDeleteStatements.legacyLookup
    )
    if (legacy.rows[0]?.regclass) {
      await client.query(recipeDeleteStatements.deleteLegacyGrants, [recipe.namespace, recipe.name])
    }
    await client.query(recipeDeleteStatements.cancelApprovals, [recipe.namespace, recipe.name])
  }

  async function recipePolicyWitness(recipe: { namespace: string; name: string }) {
    const grants = await databasePool.query<{ table_name: string; rows: number }>(
      `SELECT 'user_workflow_triggers' AS table_name,
              count(*)::int AS rows
         FROM user_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2
        UNION ALL
       SELECT 'team_workflow_triggers', count(*)::int
         FROM team_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2
        UNION ALL
       SELECT 'workflow_recipe_allowed_teams', count(*)::int
         FROM workflow_recipe_allowed_teams
        WHERE recipe_namespace = $1 AND recipe_name = $2
        ORDER BY table_name`,
      [recipe.namespace, recipe.name]
    )
    const approvals = await databasePool.query<{ status: string; cancelled_by: string | null }>(
      `SELECT status, cancelled_by FROM workflow_approval_requests
        WHERE recipe_namespace = $1 AND recipe_name = $2
        ORDER BY id`,
      [recipe.namespace, recipe.name]
    )
    return { grants: grants.rows, approvals: approvals.rows }
  }

  async function removeRecipePolicyFixture(
    recipe: { namespace: string; name: string },
    fixture: { runRecipes?: string[]; approvals?: string[]; users?: string[]; teams?: string[] }
  ) {
    await databasePool.query('TRUNCATE archive_order_barriers')
    await databasePool.query('DELETE FROM workflow_runs WHERE recipe_name = ANY($1::text[])', [
      fixture.runRecipes ?? [],
    ])
    await databasePool.query('DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])', [
      fixture.approvals ?? [],
    ])
    for (const table of [
      'user_workflow_triggers',
      'team_workflow_triggers',
      'workflow_recipe_allowed_teams',
    ]) {
      await databasePool.query(
        `DELETE FROM ${table} WHERE recipe_namespace = $1 AND recipe_name = $2`,
        [recipe.namespace, recipe.name]
      )
    }
    await databasePool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [fixture.users ?? []])
    await databasePool.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [fixture.teams ?? []])
  }

  it('runs the cleanup statements the reconciler executes, in the same order', () => {
    const source = readFileSync(
      new URL('../../workflow-recipes/src/workflow/workflowReconciler.ts', import.meta.url),
      'utf8'
    )
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    const normalizedSource = normalize(source)
    let position = -1
    for (const statement of [
      recipeDeleteStatements.approvalLock,
      recipeDeleteStatements.prelock,
      recipeDeleteStatements.deleteUserGrants,
      recipeDeleteStatements.deleteTeamGrants,
      recipeDeleteStatements.deleteAllowedTeams,
      recipeDeleteStatements.legacyLookup,
      recipeDeleteStatements.deleteLegacyGrants,
      recipeDeleteStatements.cancelApprovals,
    ]) {
      const index = normalizedSource.indexOf(normalize(statement), position + 1)
      expect(index, `missing after the previous statement: ${statement}`).toBeGreaterThan(position)
      position = index
    }
  })

  it('deletes grant rows beside a run INSERT without reversing subject locks', async () => {
    const recipe = {
      namespace: 'sandbox-recipes',
      name: `recipe-delete-grants-${randomBytes(4).toString('hex')}`,
    }
    const runRecipe = `recipe-delete-grants-run-${randomBytes(4).toString('hex')}`
    const user = randomUUID()
    const team = randomUUID()
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      user,
      `recipe-delete-${user}@example.test`,
    ])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Recipe delete grants')", [
      team,
    ])
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [user, recipe.namespace, recipe.name]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [team, recipe.namespace, recipe.name]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [team, recipe.namespace, recipe.name]
    )
    const cleanupGate = await databasePool.connect()
    const competitorGate = await databasePool.connect()
    const cleanup = await databasePool.connect()
    const competitor = await databasePool.connect()
    const cleanupPid = await pid(cleanup)
    const competitorPid = await pid(competitor)
    const cleanupGatePid = await pid(cleanupGate)
    const competitorGatePid = await pid(competitorGate)
    let cleanupOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    let cleanupSettled = false
    let outcomes: Outcome[] = []
    let witness:
      | {
          policy: Awaited<ReturnType<typeof recipePolicyWitness>>
          runs: Array<{ run_id: string }>
          observed: Array<{ revision_table: string; subject_id: string }>
        }
      | undefined
    try {
      await configure(cleanup, 'recipe-delete-grants')
      await configure(competitor, 'recipe-delete-run-insert')
      await cleanupGate.query('SELECT pg_advisory_lock($1, 41)', [barrierClass])
      await competitorGate.query('SELECT pg_advisory_lock($1, 42)', [barrierClass])
      await databasePool.query(
        `INSERT INTO archive_order_barriers VALUES
           ('recipe-delete-grants', 'authorization_user_revisions', $1, 41),
           ('recipe-delete-run-insert', 'authorization_team_revisions', '', 42)`,
        [user]
      )
      await cleanup.query('BEGIN')
      await cleanup.query('SET LOCAL ROLE workflow_recipes_runtime')
      cleanupOutcome = observe(runRecipeDeleteCleanup(cleanup, recipe))
      // The prelock holds the team before the user it pauses on.
      await waitForBlock(cleanupPid, [cleanupGatePid])
      await competitor.query('BEGIN')
      competitorOutcome = observe(
        createRun(competingRunInsert({ user, team }, runRecipe), competitor)
      )
      const competitorBlocker = await waitForBlock(competitorPid, [cleanupPid, competitorGatePid])
      if (competitorBlocker === competitorGatePid) {
        // Without the prelock the cleanup holds only the user grant row and the
        // user revision, so the INSERT takes the team and waits behind the
        // barrier before asking for that user: a cycle.
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [cleanupPid])
        await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        // With the prelock the cleanup already holds the team, so the INSERT
        // waits on the cleanup itself.
        await cleanupGate.query('SELECT pg_advisory_unlock_all()')
        const settled = await cleanupOutcome
        await cleanup.query(settled.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        cleanupSettled = true
        await waitForBlock(competitorPid, [competitorGatePid])
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
      }
      const cleanupResult = await cleanupOutcome
      if (!cleanupSettled) {
        await cleanup.query(cleanupResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        cleanupSettled = true
      }
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [cleanupResult, competitorResult]
      console.info(
        'RECIPE_DELETE_GRANTS_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
      witness = {
        policy: await recipePolicyWitness(recipe),
        runs: (
          await databasePool.query(
            `SELECT run_id FROM workflow_runs
              WHERE recipe_name = $1 AND team_id = $2 AND actor_id = $3`,
            [runRecipe, team, user]
          )
        ).rows,
        observed: (await observedRevisions('recipe-delete-grants')).slice(0, 2),
      }
    } finally {
      await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      await competitorGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([cleanupOutcome, competitorOutcome])
      if (!cleanupSettled) await cleanup.query('ROLLBACK')
      await competitor.query('ROLLBACK')
      for (const client of [cleanupGate, competitorGate, cleanup, competitor]) client.release()
      await removeRecipePolicyFixture(recipe, {
        runRecipes: [runRecipe],
        users: [user],
        teams: [team],
      })
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(witness.policy).toEqual({
      grants: [
        { table_name: 'team_workflow_triggers', rows: 0 },
        { table_name: 'user_workflow_triggers', rows: 0 },
        { table_name: 'workflow_recipe_allowed_teams', rows: 0 },
      ],
      approvals: [],
    })
    expect(witness.runs).toHaveLength(1)
    // The prelock holds the team first; without it the cleanup's first user
    // DELETE bumps the user revision first.
    expect(witness.observed).toEqual([
      { revision_table: 'authorization_team_revisions', subject_id: team },
      { revision_table: 'authorization_user_revisions', subject_id: user },
    ])
  })

  it('cancels approvals beside a run INSERT without reversing subject locks', async () => {
    const recipe = {
      namespace: 'sandbox-recipes',
      name: `recipe-delete-approvals-${randomBytes(4).toString('hex')}`,
    }
    const runRecipe = `recipe-delete-approvals-run-${randomBytes(4).toString('hex')}`
    const [userApprovalId, teamApprovalId] = [randomUUID(), randomUUID()].sort() as [string, string]
    const user = randomUUID()
    const team = randomUUID()
    await databasePool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [
      user,
      `recipe-delete-approval-${user}@example.test`,
    ])
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Recipe delete approvals')", [
      team,
    ])
    // The user-targeted approval is first in heap order and lower in id order,
    // so both a sequential and an index scan reach its subject first.
    const targets = [
      [userApprovalId, 'target_user_id', user],
      [teamApprovalId, 'target_team_id', team],
    ] as const
    for (const [id, column, target] of targets) {
      await databasePool.query(
        `INSERT INTO workflow_approval_requests(
           id, recipe_namespace, recipe_name, expires_at, status, ${column},
           payload, idempotency_key, requested_at
         ) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', 'pending', $4,
           '{}'::jsonb, $5, NOW())`,
        [id, recipe.namespace, recipe.name, target, `recipe-delete-approval-${id}`]
      )
    }
    const cleanupGate = await databasePool.connect()
    const competitorGate = await databasePool.connect()
    const cleanup = await databasePool.connect()
    const competitor = await databasePool.connect()
    const cleanupPid = await pid(cleanup)
    const competitorPid = await pid(competitor)
    const cleanupGatePid = await pid(cleanupGate)
    const competitorGatePid = await pid(competitorGate)
    let cleanupOutcome: Promise<Outcome> | undefined
    let competitorOutcome: Promise<Outcome> | undefined
    let cleanupSettled = false
    let outcomes: Outcome[] = []
    let witness:
      | {
          policy: Awaited<ReturnType<typeof recipePolicyWitness>>
          runs: Array<{ run_id: string }>
          observed: Array<{ revision_table: string; subject_id: string }>
        }
      | undefined
    try {
      await configure(cleanup, 'recipe-delete-approvals')
      await configure(competitor, 'recipe-delete-approvals-run')
      await cleanupGate.query('SELECT pg_advisory_lock($1, 43)', [barrierClass])
      await competitorGate.query('SELECT pg_advisory_lock($1, 44)', [barrierClass])
      await databasePool.query(
        `INSERT INTO archive_order_barriers VALUES
           ('recipe-delete-approvals', 'authorization_user_revisions', $1, 43),
           ('recipe-delete-approvals-run', 'authorization_team_revisions', '', 44)`,
        [user]
      )
      await cleanup.query('BEGIN')
      await cleanup.query('SET LOCAL ROLE workflow_recipes_runtime')
      cleanupOutcome = observe(runRecipeDeleteCleanup(cleanup, recipe))
      await waitForBlock(cleanupPid, [cleanupGatePid])
      await competitor.query('BEGIN')
      competitorOutcome = observe(
        createRun(competingRunInsert({ user, team }, runRecipe), competitor)
      )
      const competitorBlocker = await waitForBlock(competitorPid, [cleanupPid, competitorGatePid])
      if (competitorBlocker === competitorGatePid) {
        // Without the prelock the first cancelled approval is the user-targeted
        // row, so the cleanup holds the user and the INSERT takes the team
        // before asking for it: a cycle.
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(competitorPid, [cleanupPid])
        await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        await cleanupGate.query('SELECT pg_advisory_unlock_all()')
        const settled = await cleanupOutcome
        await cleanup.query(settled.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        cleanupSettled = true
        await waitForBlock(competitorPid, [competitorGatePid])
        await competitorGate.query('SELECT pg_advisory_unlock_all()')
      }
      const cleanupResult = await cleanupOutcome
      if (!cleanupSettled) {
        await cleanup.query(cleanupResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
        cleanupSettled = true
      }
      const competitorResult = await competitorOutcome
      await competitor.query(competitorResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [cleanupResult, competitorResult]
      console.info(
        'RECIPE_DELETE_APPROVALS_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
      witness = {
        policy: await recipePolicyWitness(recipe),
        runs: (
          await databasePool.query(
            `SELECT run_id FROM workflow_runs
              WHERE recipe_name = $1 AND team_id = $2 AND actor_id = $3`,
            [runRecipe, team, user]
          )
        ).rows,
        observed: (await observedRevisions('recipe-delete-approvals')).slice(0, 2),
      }
    } finally {
      await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      await competitorGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([cleanupOutcome, competitorOutcome])
      if (!cleanupSettled) await cleanup.query('ROLLBACK')
      await competitor.query('ROLLBACK')
      for (const client of [cleanupGate, competitorGate, cleanup, competitor]) client.release()
      await removeRecipePolicyFixture(recipe, {
        runRecipes: [runRecipe],
        approvals: [userApprovalId, teamApprovalId],
        users: [user],
        teams: [team],
      })
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(witness.policy).toEqual({
      grants: [
        { table_name: 'team_workflow_triggers', rows: 0 },
        { table_name: 'user_workflow_triggers', rows: 0 },
        { table_name: 'workflow_recipe_allowed_teams', rows: 0 },
      ],
      approvals: [
        { status: 'cancelled', cancelled_by: 'workflow-recipe-delete' },
        { status: 'cancelled', cancelled_by: 'workflow-recipe-delete' },
      ],
    })
    expect(witness.runs).toHaveLength(1)
    expect(witness.observed).toEqual([
      { revision_table: 'authorization_team_revisions', subject_id: team },
      { revision_table: 'authorization_user_revisions', subject_id: user },
    ])
  })

  it('keeps its grant rows beside an approval-target revoke without reversing locks', async () => {
    const recipe = {
      namespace: 'sandbox-recipes',
      name: `recipe-delete-revoke-${randomBytes(4).toString('hex')}`,
    }
    const team = randomUUID()
    await databasePool.query("INSERT INTO teams(id, name) VALUES ($1, 'Recipe delete revoke')", [
      team,
    ])
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [team, recipe.namespace, recipe.name]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [team, recipe.namespace, recipe.name]
    )
    const cleanupGate = await databasePool.connect()
    const cleanup = await databasePool.connect()
    const revoke = await databasePool.connect()
    const cleanupPid = await pid(cleanup)
    const revokePid = await pid(revoke)
    const cleanupGatePid = await pid(cleanupGate)
    let cleanupOutcome: Promise<Outcome> | undefined
    let revokeOutcome: Promise<Outcome> | undefined
    let cleanupSettled = false
    let outcomes: Outcome[] = []
    let witness: Awaited<ReturnType<typeof recipePolicyWitness>> | undefined
    try {
      await configure(cleanup, 'recipe-delete-revoke')
      await configure(revoke, 'recipe-delete-revoke-grant')
      await cleanupGate.query('SELECT pg_advisory_lock($1, 45)', [barrierClass])
      await databasePool.query(
        `INSERT INTO archive_order_barriers VALUES
           ('recipe-delete-revoke', 'authorization_team_revisions', $1, 45)`,
        [team]
      )
      await cleanup.query('BEGIN')
      await cleanup.query('SET LOCAL ROLE workflow_recipes_runtime')
      cleanupOutcome = observe(runRecipeDeleteCleanup(cleanup, recipe))
      // The prelock holds the grant row before it bumps the paused team.
      await waitForBlock(cleanupPid, [cleanupGatePid])
      await revoke.query('BEGIN')
      // The production approval-target revoke (workflowGrantManagementService
      // revokeWorkflowRecipeApprovalTeam) without its audit CTE.
      revokeOutcome = observe(
        revoke.query(
          `DELETE FROM workflow_recipe_allowed_teams
            WHERE recipe_namespace = $1 AND recipe_name = $2 AND team_id = $3::uuid
            RETURNING team_id`,
          [recipe.namespace, recipe.name, team]
        )
      )
      // With the grant-row phase the revoke waits on the cleanup's row lock.
      // Without it the revoke holds the row and waits on the team revision the
      // cleanup holds: a cycle.
      await waitForBlock(revokePid, [cleanupPid])
      await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      const cleanupResult = await cleanupOutcome
      await cleanup.query(cleanupResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      cleanupSettled = true
      const revokeResult = await revokeOutcome
      await revoke.query(revokeResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [cleanupResult, revokeResult]
      console.info(
        'RECIPE_DELETE_REVOKE_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
      expect(revokeResult).toMatchObject({ status: 'fulfilled', value: { rowCount: 0 } })
      witness = await recipePolicyWitness(recipe)
    } finally {
      await cleanupGate.query('SELECT pg_advisory_unlock_all()')
      await Promise.all([cleanupOutcome, revokeOutcome])
      if (!cleanupSettled) await cleanup.query('ROLLBACK')
      await revoke.query('ROLLBACK')
      for (const client of [cleanupGate, cleanup, revoke]) client.release()
      await removeRecipePolicyFixture(recipe, { teams: [team] })
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(witness).toEqual({
      grants: [
        { table_name: 'team_workflow_triggers', rows: 0 },
        { table_name: 'user_workflow_triggers', rows: 0 },
        { table_name: 'workflow_recipe_allowed_teams', rows: 0 },
      ],
      approvals: [],
    })
  })

  it.each(['not-a-uuid', 'CONTROL-PLANE-ADMIN-UI'])(
    'keeps P0001 validation for non-sentinel usage team %s',
    async invalidTeam => {
      const ids = await fixture()
      // Seed a legacy malformed value without invoking the live-row trigger;
      // the scoped function must still use the production subject validator.
      await databasePool.query(
        'ALTER TABLE workflow_runs DISABLE TRIGGER workflow_runs_authorization_revision'
      )
      try {
        await databasePool.query('UPDATE workflow_runs SET usage_team_id = $2 WHERE run_id = $1', [
          ids.archived[0],
          invalidTeam,
        ])
      } finally {
        await databasePool.query(
          'ALTER TABLE workflow_runs ENABLE TRIGGER workflow_runs_authorization_revision'
        )
      }
      const before = await revisions(ids)
      await expect(
        databasePool.query('SELECT authorization_prelock_workflow_run_revisions($1::uuid[])', [
          ids.archived,
        ])
      ).rejects.toMatchObject({ code: 'P0001' })
      expect(await revisions(ids)).toEqual(before)
    }
  )
})
