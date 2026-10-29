import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb, pool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { archiveTerminalApprovals } from '../src/services/userApprovalRequestArchiveService.js'
import { expirePendingRequests } from '../src/services/userApprovalRequestService.js'
import { updateRunPhase } from '../src/services/workflowRunService.js'
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
          OR current_setting('application_name') LIKE 'approval-expiry-%' THEN
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

  it('archives two rows and advances revisions with a phase-update liveness witness', async () => {
    const ids = await fixture()
    const before = await revisions(ids)
    const connect = vi.spyOn(pool, 'connect').mockImplementation(() => databasePool.connect())
    try {
      expect(await archiveTerminalRuns(gateway, { batchSize: 500, maxBatches: 1 })).toBe(2)
      await archivedWitness(ids)
      expect((await updateRunPhase(ids.live[0]!, 'Running', databasePool))?.phase).toBe('Running')
      const after = await revisions(ids)
      for (const kind of ['user', 'team'] as const) {
        expect(after[kind]).toHaveLength(2)
        for (const [index, row] of after[kind].entries()) {
          const updated = kind === 'user' ? ids.users[0] : ids.teams[1]
          expect(row.revision).toBe(before[kind][index].revision + (row.id === updated ? 5 : 3))
        }
      }
    } finally {
      connect.mockRestore()
    }
  })

  it('commits an archive batch beside updateRunPhase without reversing subject locks', async () => {
    const ids = await fixture()
    const before = await revisions(ids)
    const archiveGate = await databasePool.connect()
    const updateGate = await databasePool.connect()
    const archive = await databasePool.connect()
    const update = await databasePool.connect()
    const archivePid = await pid(archive)
    const updatePid = await pid(update)
    const archiveGatePid = await pid(archiveGate)
    const updateGatePid = await pid(updateGate)
    let archiveOutcome: Promise<Outcome> | undefined
    let updateOutcome: Promise<Outcome> | undefined
    let archiveStarted = false
    let firstIndex = -1
    let outcomes: Outcome[] = []
    // The connection boundary binds the actual archive service to this real
    // database. Neither archiveOneBatch nor updateRunPhase SQL is replaced.
    const connect = vi.spyOn(pool, 'connect').mockResolvedValue(archive)
    try {
      await configure(archive, 'archive-order-archive')
      await configure(update, 'archive-order-phase')
      await archiveGate.query('SELECT pg_advisory_lock($1, 1), pg_advisory_lock($1, 2)', [
        barrierClass,
      ])
      await updateGate.query('SELECT pg_advisory_lock($1, 3)', [barrierClass])
      await databasePool.query(
        `
        INSERT INTO archive_order_barriers VALUES
          ('archive-order-archive', 'authorization_user_revisions', $1, 1),
          ('archive-order-archive', 'authorization_user_revisions', $2, 2),
          ('archive-order-phase', 'authorization_team_revisions', '', 3)
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
      await update.query('BEGIN')
      updateOutcome = observe(updateRunPhase(ids.live[firstIndex]!, 'Running', update))
      const phaseBlocker = await waitForBlock(updatePid, [updateGatePid, archivePid])
      if (phaseBlocker === updateGatePid) {
        // Without the prelock, the phase writer holds the other team's
        // revision before waiting on the archive's first user: a cycle.
        await updateGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(updatePid, [archivePid])
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
      } else {
        // With the prelock, the archive already holds both teams before
        // reaching its first user. The phase writer waits at its first team.
        await archiveGate.query('SELECT pg_advisory_unlock_all()')
        await waitForBlock(updatePid, [updateGatePid])
        await updateGate.query('SELECT pg_advisory_unlock_all()')
      }
      const phaseResult = await updateOutcome
      await update.query(phaseResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      outcomes = [await archiveOutcome, phaseResult]
      console.info(
        'ARCHIVE_ORDER_OUTCOMES',
        outcomes.map(result => ({
          status: result.status,
          code: result.status === 'rejected' ? result.code : undefined,
        }))
      )
    } finally {
      await archiveGate.query('SELECT pg_advisory_unlock_all()')
      await updateGate.query('SELECT pg_advisory_unlock_all()')
      await updateOutcome
      await update.query('ROLLBACK')
      await archiveOutcome
      connect.mockRestore()
      for (const client of [archiveGate, updateGate, update]) client.release()
      if (!archiveStarted) archive.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
    }
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 2 })
    await archivedWitness(ids)
    const after = await revisions(ids)
    for (const kind of ['user', 'team'] as const) {
      for (const [index, row] of after[kind].entries()) {
        const updated = kind === 'user' ? ids.users[firstIndex] : ids.teams[1 - firstIndex]
        expect(row.revision).toBe(before[kind][index].revision + (row.id === updated ? 5 : 3))
      }
    }
    expect(
      (
        await databasePool.query('SELECT phase FROM workflow_runs WHERE run_id = $1', [
          ids.live[firstIndex],
        ])
      ).rows
    ).toEqual([{ phase: 'Running' }])
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

  it('commits an approval archive batch beside a run phase write without reversing subject locks', async () => {
    const ids = await approvalFixture()
    const before = await revisions({ users: [ids.user], teams: [ids.team] })
    const archiveGate = await databasePool.connect()
    const archive = await databasePool.connect()
    const update = await databasePool.connect()
    const archivePid = await pid(archive)
    const updatePid = await pid(update)
    const gatePid = await pid(archiveGate)
    let archiveOutcome: Promise<Outcome> | undefined
    let updateOutcome: Promise<Outcome> | undefined
    const connect = bindFirstSession(archive)
    try {
      await configure(archive, 'approval-archive-order')
      await configure(update, 'approval-phase-order')
      await archiveGate.query('SELECT pg_advisory_lock($1, 21)', [barrierClass])
      await databasePool.query('INSERT INTO archive_order_barriers VALUES ($1, $2, $3, 21)', [
        'approval-archive-order',
        'authorization_user_revisions',
        ids.user,
      ])
      archiveOutcome = observe(archiveTerminalApprovals(180, 500))
      // The prelock pauses on the user only after taking the batch's team.
      await waitForBlock(archivePid, [gatePid])
      await update.query('BEGIN')
      updateOutcome = observe(updateRunPhase(ids.live, 'Running', update))
      // The phase writer takes its team first and waits there, so it can never
      // hold the team this batch already prelocked while asking for its user.
      await waitForBlock(updatePid, [archivePid])
      await archiveGate.query('SELECT pg_advisory_unlock_all()')
      const phaseResult = await updateOutcome
      await update.query(phaseResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      const archiveResult = await archiveOutcome
      console.info('APPROVAL_ORDER_OUTCOMES', {
        archive: archiveResult,
        phase: phaseResult,
      })
      expect([archiveResult.status, phaseResult.status]).toEqual(['fulfilled', 'fulfilled'])
      expect(archiveResult).toEqual({ status: 'fulfilled', value: 2 })
      expect(
        (await databasePool.query('SELECT phase FROM workflow_runs WHERE run_id = $1', [ids.live]))
          .rows
      ).toEqual([{ phase: 'Running' }])
      expect(
        (
          await databasePool.query(
            'SELECT id FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
            [[ids.userApprovalId, ids.teamApprovalId]]
          )
        ).rows
      ).toHaveLength(0)
      // The prelock and the DELETE's row trigger bump each subject once; the
      // phase UPDATE adds a NEW and an OLD attribution pair.
      const after = await revisions({ users: [ids.user], teams: [ids.team] })
      expect(after.user).toEqual([{ id: ids.user, revision: before.user[0]!.revision + 4 }])
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
      await Promise.all([archiveOutcome, updateOutcome])
      await update.query('ROLLBACK')
      connect.mockRestore()
      for (const client of [archiveGate, update]) client.release()
      if (!archiveOutcome) archive.release()
      await databasePool.query('TRUNCATE archive_order_barriers')
      await databasePool.query(
        'DELETE FROM workflow_approval_requests WHERE id = ANY($1::uuid[])',
        [[ids.userApprovalId, ids.teamApprovalId]]
      )
      await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1', [ids.live])
      await databasePool.query('DELETE FROM users WHERE id = $1', [ids.user])
      await databasePool.query('DELETE FROM teams WHERE id = $1', [ids.team])
    }
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
