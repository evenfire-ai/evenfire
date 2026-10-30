import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { initDb, pool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { type GfsSubject, writeGfsGrantBatchInTransaction } from '../src/routes/gfs/grants.js'
import { writeGfsShareBatchInTransaction } from '../src/routes/gfs/shares.js'
import { createRun } from '../src/services/workflowRunService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const barrierClass = 33_405
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
]

type Outcome = { status: 'fulfilled' } | { status: 'rejected'; code: string }

function observe(write: Promise<unknown>): Promise<Outcome> {
  return write.then(
    () => ({ status: 'fulfilled' }),
    error => ({ status: 'rejected', code: String(error.code) })
  )
}

describeRealPostgres('revision writers share one lock order on real PostgreSQL', () => {
  const database = `control_api_revision_writers_${randomBytes(6).toString('hex')}`
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
    // Test-only AFTER triggers pause a writer only after the real revision
    // upsert has acquired its row lock. No production bump function is replaced.
    await databasePool.query(`
      CREATE TABLE revision_writer_barriers (
        application_name TEXT NOT NULL,
        revision_table TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        gate INTEGER NOT NULL
      );
      CREATE FUNCTION revision_writer_barrier() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE barrier RECORD;
      BEGIN
        FOR barrier IN
          SELECT gate FROM revision_writer_barriers
           WHERE application_name = current_setting('application_name')
             AND revision_table = TG_TABLE_NAME
             AND (subject_id = '' OR subject_id = COALESCE(
               to_jsonb(NEW)->>'user_id', to_jsonb(NEW)->>'team_id',
               to_jsonb(NEW)->>'resource_id'))
        LOOP
          PERFORM pg_advisory_xact_lock(${barrierClass}, barrier.gate);
        END LOOP;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER revision_writer_barrier AFTER INSERT OR UPDATE
        ON authorization_user_revisions FOR EACH ROW EXECUTE FUNCTION revision_writer_barrier();
      CREATE TRIGGER revision_writer_barrier AFTER INSERT OR UPDATE
        ON authorization_team_revisions FOR EACH ROW EXECUTE FUNCTION revision_writer_barrier();
      CREATE TRIGGER revision_writer_barrier AFTER INSERT OR UPDATE
        ON authorization_resource_revisions FOR EACH ROW EXECUTE FUNCTION revision_writer_barrier();
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
    const users = [randomUUID(), randomUUID()].sort()
    const teams = [randomUUID(), randomUUID()].sort()
    const resources = [randomUUID(), randomUUID()]
    const drive = `revision-writers-${randomBytes(6).toString('hex')}`
    for (const id of users) {
      await databasePool.query(
        "INSERT INTO users(id, email, name) VALUES ($1, $2, 'Revision writer')",
        [id, `revision-${id}@example.test`]
      )
    }
    for (const id of teams) {
      await databasePool.query('INSERT INTO teams(id, name) VALUES ($1, $2)', [id, `Team ${id}`])
    }
    for (const [index, id] of resources.entries()) {
      await databasePool.query(
        "INSERT INTO gfs_resources(resource_id, drive, name, kind) VALUES ($1, $2, 'order', 'file')",
        [id, index === 0 ? drive : `${drive}-b`]
      )
    }
    return { users, teams, resources, drive }
  }

  async function revision(type: 'user' | 'team' | 'resource', id: string): Promise<number> {
    const result = await databasePool.query<{ revision: string }>(
      `SELECT revision::text FROM authorization_${type}_revisions WHERE ${type}_id::text = $1`,
      [id]
    )
    expect(result.rows.length).toBeLessThanOrEqual(1)
    return Number(result.rows[0]?.revision ?? 0)
  }

  async function pid(client: PoolClient): Promise<number> {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
  }

  async function waitForBlock(blocked: number, blockers: number[]): Promise<number> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await databasePool.query<{ pids: number[] }>(
        'SELECT pg_blocking_pids($1::int) AS pids',
        [blocked]
      )
      const blocker = blockers.find(candidate => result.rows[0]!.pids.includes(candidate))
      if (blocker !== undefined) return blocker
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`writer ${blocked} did not block on one of ${blockers.join(', ')}`)
  }

  async function begin(client: PoolClient, application: string) {
    await client.query('BEGIN')
    await client.query("SELECT set_config('application_name', $1, true)", [application])
    await client.query("SET LOCAL deadlock_timeout = '100ms'")
    await client.query("SET LOCAL statement_timeout = '8s'")
  }

  async function finish(client: PoolClient, outcome: Outcome) {
    await client.query(outcome.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
  }

  async function barrier(application: string, table: string, id: string, gate: number) {
    await databasePool.query('INSERT INTO revision_writer_barriers VALUES ($1, $2, $3, $4)', [
      application,
      `authorization_${table}_revisions`,
      id,
      gate,
    ])
  }

  async function stagedWriters(
    firstWrite: (client: PoolClient) => Promise<unknown>,
    secondWrite: (client: PoolClient) => Promise<unknown>,
    secondGate = false
  ) {
    const gateOne = await databasePool.connect()
    const gateTwo = await databasePool.connect()
    const first = await databasePool.connect()
    const second = await databasePool.connect()
    const outcomes: Outcome[] = []
    try {
      await gateOne.query('SELECT pg_advisory_lock($1, 1)', [barrierClass])
      await gateTwo.query('SELECT pg_advisory_lock($1, 2)', [barrierClass])
      const firstPid = await pid(first)
      const secondPid = await pid(second)
      const gateOnePid = await pid(gateOne)
      const gateTwoPid = await pid(gateTwo)
      await begin(first, 'revision-first')
      await begin(second, 'revision-second')
      const firstOutcome = observe(firstWrite(first))
      await waitForBlock(firstPid, [gateOnePid])
      const secondOutcome = observe(secondWrite(second))
      const secondBlocker = await waitForBlock(
        secondPid,
        secondGate ? [firstPid, gateTwoPid] : [firstPid]
      )
      // Opposite first rows are directly observed through pg_blocking_pids;
      // releasing both barriers then lets PostgreSQL detect the real 40P01.
      await gateOne.query('SELECT pg_advisory_unlock($1, 1)', [barrierClass])
      if (secondBlocker === gateTwoPid) {
        await gateTwo.query('SELECT pg_advisory_unlock($1, 2)', [barrierClass])
      }
      const one = await firstOutcome
      outcomes.push(one)
      await finish(first, one)
      if (secondGate && secondBlocker === firstPid) {
        await waitForBlock(secondPid, [gateTwoPid])
        await gateTwo.query('SELECT pg_advisory_unlock($1, 2)', [barrierClass])
      }
      const two = await secondOutcome
      outcomes.push(two)
      await finish(second, two)
    } finally {
      await gateOne.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await gateTwo.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      for (const client of [gateOne, gateTwo, first, second]) client.release()
      await databasePool.query('TRUNCATE revision_writer_barriers')
    }
    expect(outcomes).toEqual([{ status: 'fulfilled' }, { status: 'fulfilled' }])
  }

  async function grant(drive: string, resource: string, type: string, id: string) {
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ($1, $2, $3, $4, ARRAY['read'])`,
      [drive, resource, type, id]
    )
  }

  it.each(
    ['gfs_grants', 'gfs_shares'].flatMap(table =>
      ['INSERT', 'UPDATE', 'DELETE'].map(operation => [table, operation] as const)
    )
  )('takes the resource before the subject for %s %s', async (table, operation) => {
    const {
      users: [user],
      resources: [resource],
      drive,
    } = await fixture()
    // Keep a committed authority visible to the resource writer, including
    // when the competing authority row is an uncommitted INSERT or DELETE.
    await grant(drive, resource!, 'user', user!)
    const authorityId = randomUUID()
    if (operation !== 'INSERT') {
      await databasePool.query(
        `INSERT INTO ${table}(id, drive, resource_id, subject_type, subject_id, permissions)
             VALUES ($1, $2, $3, 'user', $4, ARRAY['read'])
             ON CONFLICT (drive, resource_id, subject_type, subject_id) DO UPDATE
               SET id = EXCLUDED.id`,
        [authorityId, drive, resource, user]
      )
    }
    // INSERT uses the same subject but another authority table to avoid an
    // unrelated unique-key conflict with the committed witness above.
    if (operation === 'INSERT' && table === 'gfs_grants') {
      await databasePool.query(
        `INSERT INTO gfs_shares(drive, resource_id, subject_type, subject_id, permissions)
             VALUES ($1, $2, 'user', $3, ARRAY['read'])`,
        [drive, resource, user]
      )
      await databasePool.query('DELETE FROM gfs_grants WHERE resource_id = $1', [resource])
    }
    const beforeUser = await revision('user', user!)
    const beforeResource = await revision('resource', resource!)
    await barrier('revision-first', 'resource', resource!, 1)
    await stagedWriters(
      client =>
        client.query('UPDATE gfs_resources SET name = name || $2 WHERE resource_id = $1', [
          resource,
          '-resource',
        ]),
      client =>
        operation === 'INSERT'
          ? client.query(
              `INSERT INTO ${table}(drive, resource_id, subject_type, subject_id, permissions)
               VALUES ($1, $2, 'user', $3, ARRAY['read'])`,
              [drive, resource, user]
            )
          : client.query(
              operation === 'UPDATE'
                ? `UPDATE ${table} SET permissions = ARRAY['read', 'write'] WHERE id = $1`
                : `DELETE FROM ${table} WHERE id = $1`,
              [authorityId]
            )
    )
    expect(await revision('resource', resource!)).toBe(beforeResource + 2)
    expect(await revision('user', user!)).toBe(beforeUser + 2)
  })

  it.each(['workflow', 'membership'] as const)(
    'takes teams before users for a %s write competing with a resource UPDATE',
    async writer => {
      const {
        users: [user],
        teams: [team],
        resources: [resource],
        drive,
      } = await fixture()
      await grant(drive, resource!, 'team', team!)
      await grant(drive, resource!, 'user', user!)
      if (writer === 'membership') {
        await databasePool.query(
          "INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')",
          [team, user]
        )
      }
      const beforeUser = await revision('user', user!)
      const beforeTeam = await revision('team', team!)
      const beforeResource = await revision('resource', resource!)
      await barrier('revision-first', 'team', team!, 1)
      await stagedWriters(
        client =>
          client.query('UPDATE gfs_resources SET name = name || $2 WHERE resource_id = $1', [
            resource,
            '-resource',
          ]),
        client =>
          writer === 'workflow'
            ? // A phase-only UPDATE bumps no revision, so the workflow writer is
              // a run INSERT of the same team and user: it takes the team first.
              createRun(
                {
                  recipe_namespace: 'test',
                  recipe_name: 'revision-order',
                  actor_type: 'user',
                  team_id: team,
                  usage_team_id: team,
                  actor_id: user,
                  idempotency_key: null,
                  trigger_source: 'onDemand',
                  ttl_seconds_after_finished: 2_592_000,
                },
                client
              )
            : client.query(
                "UPDATE team_members SET role = 'admin' WHERE team_id = $1 AND user_id = $2",
                [team, user]
              )
      )
      // The resource UPDATE bumps the resource and its two subjects once each;
      // the run INSERT adds one user bump and two team bumps.
      expect(await revision('user', user!)).toBe(beforeUser + 2)
      expect(await revision('team', team!)).toBe(beforeTeam + (writer === 'workflow' ? 3 : 2))
      expect(await revision('resource', resource!)).toBe(beforeResource + 1)
    }
  )

  it.each(['workflow usage team', 'workflow attribution change', 'membership team change'])(
    'orders every affected team for a %s',
    async writer => {
      const {
        users: [user],
        teams,
        resources: [resource],
        drive,
      } = await fixture()
      for (const team of teams) await grant(drive, resource!, 'team', team)
      await grant(drive, resource!, 'user', user!)
      let runId: string | undefined
      if (writer === 'workflow attribution change') {
        runId = (
          await databasePool.query<{ run_id: string }>(
            `INSERT INTO workflow_runs(recipe_namespace, recipe_name, phase, actor_type, actor_id,
             trigger_source, team_id, usage_team_id)
           VALUES ('test', 'team-order', 'Pending', 'user', $1, 'onDemand', $2, $3)
           RETURNING run_id::text`,
            [user, teams[0], null]
          )
        ).rows[0]!.run_id
      } else if (writer === 'membership team change') {
        await databasePool.query(
          "INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')",
          [teams[0], user]
        )
      }
      const beforeTeams = await Promise.all(teams.map(team => revision('team', team)))
      const beforeUser = await revision('user', user!)
      const beforeResource = await revision('resource', resource!)
      await barrier('revision-first', 'team', teams[0]!, 1)
      await stagedWriters(
        client =>
          client.query('UPDATE gfs_resources SET name = name || $2 WHERE resource_id = $1', [
            resource,
            '-team-order',
          ]),
        client =>
          writer === 'workflow usage team'
            ? // A phase-only UPDATE bumps no revision, so the two-team workflow
              // writer is a run INSERT whose team and usage team are reversed
              // against the sorted order the trigger must still follow.
              createRun(
                {
                  recipe_namespace: 'test',
                  recipe_name: 'team-order',
                  actor_type: 'user',
                  team_id: teams[1],
                  usage_team_id: teams[0],
                  actor_id: user,
                  idempotency_key: null,
                  trigger_source: 'onDemand',
                  ttl_seconds_after_finished: 2_592_000,
                },
                client
              )
            : writer === 'workflow attribution change'
              ? client.query(
                  "UPDATE workflow_runs SET team_id = $2, phase = 'Running' WHERE run_id = $1",
                  [runId, teams[1]]
                )
              : client.query(
                  'UPDATE team_members SET team_id = $3 WHERE team_id = $1 AND user_id = $2',
                  [teams[0], user, teams[1]]
                )
      )
      // The resource UPDATE bumps both teams and the user once; the run INSERT
      // adds one bump per team and one for the user. The two UPDATE writers
      // bump a NEW and an OLD attribution pair.
      for (const [index, team] of teams.entries()) {
        expect(await revision('team', team)).toBe(beforeTeams[index]! + 2)
      }
      expect(await revision('user', user!)).toBe(
        beforeUser + (writer === 'workflow usage team' ? 2 : 3)
      )
      expect(await revision('resource', resource!)).toBe(beforeResource + 1)
    }
  )

  it.each(['removal', 'change'] as const)(
    'orders OLD and NEW audit subjects together for a team %s',
    async operation => {
      const {
        users: [user],
        teams,
        resources: [resource],
        drive,
      } = await fixture()
      const affectedTeams = operation === 'removal' ? teams.slice(0, 1) : teams
      for (const team of affectedTeams) await grant(drive, resource!, 'team', team)
      await grant(drive, resource!, 'user', user!)
      const runId = randomUUID()
      await databasePool.query(
        `INSERT INTO workflow_runs_audit(
           run_id, run_namespace, run_name, recipe_namespace, recipe_name,
           triggerer_team_id, triggerer_user_id, triggerer_actor_type,
           trigger_source, idempotency_key, triggered_at, completed_at,
           final_phase, step_count, snapshot_sha
         ) VALUES (
           $1, 'revision', $1::uuid::text, 'revision', 'audit-order',
           $2, $3, 'user', 'onDemand', $1::uuid::text, NOW(), NOW(),
           'Succeeded', 0, 'audit-order-witness'
         )`,
        [runId, teams[0], user]
      )
      const beforeTeams = await Promise.all(affectedTeams.map(team => revision('team', team)))
      const beforeUser = await revision('user', user!)
      const beforeResource = await revision('resource', resource!)
      const nextTeam = operation === 'removal' ? null : teams[1]
      await barrier('revision-first', 'team', teams[0]!, 1)
      await stagedWriters(
        client =>
          client.query('UPDATE gfs_resources SET name = name || $2 WHERE resource_id = $1', [
            resource,
            '-audit-order',
          ]),
        // NULL is also the row image produced by the audit team's FK
        // ON DELETE SET NULL action. Both images must share one sort.
        client =>
          client.query('UPDATE workflow_runs_audit SET triggerer_team_id = $2 WHERE run_id = $1', [
            runId,
            nextTeam,
          ])
      )
      for (const [index, team] of affectedTeams.entries()) {
        expect(await revision('team', team)).toBe(beforeTeams[index]! + 2)
      }
      expect(await revision('user', user!)).toBe(beforeUser + 3)
      expect(await revision('resource', resource!)).toBe(beforeResource + 1)
      expect(
        (
          await databasePool.query(
            'SELECT triggerer_team_id FROM workflow_runs_audit WHERE run_id = $1',
            [runId]
          )
        ).rows
      ).toEqual([{ triggerer_team_id: nextTeam }])
    }
  )

  for (const kind of ['grant', 'share'] as const) {
    it.each(['user IDs', 'subject types'] as const)(
      `orders ${kind} batch %s with opposite overlapping request orders`,
      async subjectCase => {
        const {
          users,
          teams: [team],
          resources,
          drive,
        } = await fixture()
        const subjects: GfsSubject[] =
          subjectCase === 'user IDs'
            ? users.map(id => ({ type: 'user', id }))
            : [
                { type: 'team', id: team },
                { type: 'user', id: users[0] },
              ]
        const before = await Promise.all(
          subjects.map(subject => revision(subject.type as 'team' | 'user', subject.id!))
        )
        const beforeResources = await Promise.all(resources.map(id => revision('resource', id)))
        for (const table of ['user', 'team']) {
          await barrier('revision-first', table, '', 1)
          await barrier('revision-second', table, '', 2)
        }
        const write = async (client: PoolClient, resource: string, targets: GfsSubject[]) => {
          const params = {
            req: {
              ip: '127.0.0.1',
              headers: {},
              adminAuth: { sub: users[0] },
            } as unknown as Request,
            caller: { isOperator: true, actorKey: 'operator:', subjects: new Set(['operator:']) },
            drive: resource === resources[0] ? drive : `${drive}-b`,
            resourceId: resource,
            subjects: targets,
            permissions: ['read'] as const,
          }
          const result =
            kind === 'grant'
              ? await writeGfsGrantBatchInTransaction(client, { ...params, inherit: false })
              : await writeGfsShareBatchInTransaction(client, {
                  ...params,
                  includeDescendants: false,
                })
          expect(result.error).toBeNull()
        }
        await stagedWriters(
          client => write(client, resources[0]!, [...subjects].reverse()),
          client => write(client, resources[1]!, subjects),
          true
        )
        for (const [index, subject] of subjects.entries()) {
          expect(await revision(subject.type as 'team' | 'user', subject.id!)).toBe(
            before[index]! + 2
          )
        }
        for (const [index, resource] of resources.entries()) {
          expect(await revision('resource', resource)).toBe(
            beforeResources[index]! + subjects.length
          )
        }
        const rows = await databasePool.query<{ count: string }>(
          `SELECT count(*)::text FROM gfs_${kind === 'grant' ? 'grants' : 'shares'}
           WHERE resource_id = ANY($1::uuid[])`,
          [resources]
        )
        expect(Number(rows.rows[0]!.count)).toBe(subjects.length * 2)
      }
    )
  }

  it('accepts exactly the Admin UI usage-team sentinel for INSERT, UPDATE and DELETE', async () => {
    const adminId = randomUUID()
    const query = vi.spyOn(pool, 'query').mockImplementation(databasePool.query.bind(databasePool))
    let runId: string
    try {
      const result = await triggerWorkflow({
        gateway: {
          getResource: async () => ({
            metadata: { name: 'admin-revision', namespace: config.sandboxNamespace },
            spec: { triggers: { onDemand: { requiresApproval: false } } },
          }),
        } as unknown as K8sGateway,
        caller: { kind: 'admin-ui', userId: adminId },
        recipeNamespace: config.sandboxNamespace,
        recipeName: 'admin-revision',
        body: {},
        idempotencyKey: randomUUID(),
      })
      expect(result.kind).toBe('run')
      if (result.kind !== 'run') throw new Error('expected a real Admin UI run')
      expect(result.created).toBe(true)
      expect(result.row.usage_team_id).toBe('control-plane-admin-ui')
      runId = result.row.run_id
      expect(
        (await databasePool.query('SELECT run_id FROM workflow_runs WHERE run_id = $1', [runId]))
          .rowCount
      ).toBe(1)
    } finally {
      query.mockRestore()
    }
    expect(
      (
        await databasePool.query(
          // A phase-only UPDATE skips the run revision trigger, so the sentinel
          // is witnessed on UPDATE only when a guarded column changes too.
          "UPDATE workflow_runs SET phase = 'Running', actor_id = $2 WHERE run_id = $1 RETURNING run_id",
          [runId, randomUUID()]
        )
      ).rowCount
    ).toBe(1)
    expect(
      (
        await databasePool.query('DELETE FROM workflow_runs WHERE run_id = $1 RETURNING run_id', [
          runId,
        ])
      ).rowCount
    ).toBe(1)
    const {
      users: [user],
      teams: [team],
    } = await fixture()
    const beforeUser = await revision('user', user!)
    const beforeTeam = await revision('team', team!)
    expect(
      (
        await databasePool.query(
          `INSERT INTO workflow_runs(recipe_namespace, recipe_name, phase, actor_type, actor_id,
         trigger_source, usage_team_id) VALUES ('test', 'uuid-revision', 'Pending', 'user', $1,
         'onDemand', $2) RETURNING run_id`,
          [user, team]
        )
      ).rowCount
    ).toBe(1)
    expect(await revision('user', user!)).toBe(beforeUser + 1)
    expect(await revision('team', team!)).toBe(beforeTeam + 1)
    for (const invalid of ['not-a-team', 'CONTROL-PLANE-ADMIN-UI', 'control-plane-admin-ui ']) {
      await expect(
        databasePool.query(
          `INSERT INTO workflow_runs(recipe_namespace, recipe_name, phase, actor_type, actor_id,
           trigger_source, usage_team_id) VALUES ('test', 'invalid-revision', 'Pending', 'admin',
           $1, 'onDemand', $2)`,
          [adminId, invalid]
        )
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('invalid catalog team subject identifier'),
      })
    }
    // The sentinel exception is confined to usage_team_id; it is not a valid actor UUID.
    for (const type of ['user', 'team']) {
      await expect(
        databasePool.query(
          "SELECT authorization_bump_subject_revision($1, 'control-plane-admin-ui')",
          [type]
        )
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining(`invalid catalog ${type} subject identifier`),
      })
    }
  })

  it('a delivery claim takes no revision row while a run INSERT holds its subjects', async () => {
    const {
      users: [user],
      teams: [team],
    } = await fixture()
    // Two deliveries, one per audience an approval delivery can name
    // (notificationEmitter.ts:18-23). The user row is older, so the claim's
    // ORDER BY visits it first: the cycle shape the review probe reproduced as
    // P1/P2.
    const inserted = await databasePool.query<{ id: string; event_type: string }>(
      `INSERT INTO notification_deliveries(
         event_type, dedupe_key, audience, payload, status, next_attempt_at, created_at
       ) VALUES
         ('approval.requested', $1, jsonb_build_object('userId', $2::text), '{}'::jsonb,
          'queued', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '2 minutes'),
         ('approval.requested', $3, jsonb_build_object('teamId', $4::text), '{}'::jsonb,
          'queued', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')
       RETURNING id::text`,
      [`claim-user-${randomUUID()}`, user, `claim-team-${randomUUID()}`, team]
    )
    const deliveryIds = inserted.rows.map(row => row.id)

    // The claim tail, copied from notificationDeliveryQueueService.ts:299-321
    // (`locked` + `claimed`); only the candidates source is a test fixture.
    const claim = `
      WITH candidates AS (
        SELECT nd.id,
               'telegram'::text AS medium,
               'provider-user'::text AS provider_user_id,
               NULL::text AS provider_workspace_id,
               'provider-channel'::text AS provider_channel_id,
               NULL::text AS communication_channel_ref,
               'sandbox-recipes/claim'::text AS mcp_host_ref,
               1 AS sort_priority,
               nd.created_at
          FROM notification_deliveries nd
         WHERE nd.id = ANY($1::uuid[])
      ),
      locked AS (
        SELECT nd.id,
               c.medium,
               c.provider_user_id,
               c.provider_workspace_id,
               c.provider_channel_id,
               c.communication_channel_ref,
               c.mcp_host_ref
          FROM notification_deliveries nd
          JOIN candidates c ON c.id = nd.id
         ORDER BY c.sort_priority ASC,
                  c.created_at ASC,
                  nd.id ASC
         LIMIT $2
         FOR UPDATE OF nd SKIP LOCKED
      ),
      claimed AS (
        UPDATE notification_deliveries nd
           SET status = 'retrying',
               attempts = nd.attempts + 1,
               next_attempt_at = NOW() + INTERVAL '30 seconds'
          FROM locked c
         WHERE nd.id = c.id
      RETURNING nd.id
      )
      SELECT id::text FROM claimed`

    async function revisionRowHeld(table: string, column: string, id: string): Promise<string> {
      const witness = await databasePool.connect()
      try {
        await witness.query('BEGIN')
        await witness.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 FOR UPDATE NOWAIT`, [id])
        return 'acquired'
      } catch (error) {
        return String((error as { code?: string }).code)
      } finally {
        await witness.query('ROLLBACK').catch(() => undefined)
        witness.release()
      }
    }

    const beforeUser = await revision('user', user!)
    const beforeTeam = await revision('team', team!)
    const runInsert = await databasePool.connect()
    const claimSession = await databasePool.connect()
    let claimSettled = false
    try {
      // Session B: the competing run INSERT of (team, user), uncommitted. The
      // run trigger takes the team revision before the user revision.
      await begin(runInsert, 'claim-run-insert')
      const runOutcome = observe(
        createRun(
          {
            recipe_namespace: 'test',
            recipe_name: 'claim-order',
            actor_type: 'user',
            team_id: team,
            usage_team_id: team,
            actor_id: user,
            idempotency_key: null,
            trigger_source: 'onDemand',
            ttl_seconds_after_finished: 2_592_000,
          },
          runInsert
        )
      )
      // N8 witness: before the claim runs, the uncommitted run INSERT really
      // holds both revision rows. `FOR UPDATE NOWAIT` is the direct probe.
      const deadline = Date.now() + 5_000
      let held = ['', '']
      while (Date.now() < deadline) {
        held = [
          await revisionRowHeld('authorization_user_revisions', 'user_id', user!),
          await revisionRowHeld('authorization_team_revisions', 'team_id', team!),
        ]
        if (held.every(code => code === '55P03')) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(held).toEqual(['55P03', '55P03'])

      // Session A: the claim with a 1 s lock timeout. Without the guard the
      // claim's first row (the user audience) waits for the run INSERT's user
      // revision and fails with 55P03, as probe P2 measured at 1.5 s (57014).
      await begin(claimSession, 'claim-session')
      await claimSession.query("SET LOCAL lock_timeout = '1s'")
      const claimOutcome = claimSession.query<{ id: string }>(claim, [deliveryIds, 2]).then(
        result => ({ status: 'fulfilled' as const, ids: result.rows.map(row => row.id) }),
        error => ({
          status: 'rejected' as const,
          code: String((error as { code?: string }).code),
          ids: [] as string[],
        })
      )
      const claimResult = await claimOutcome
      await claimSession.query(claimResult.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK')
      claimSettled = true
      const runResult = await runOutcome
      await runInsert.query('ROLLBACK')
      console.info('DELIVERY_CLAIM_OUTCOMES', {
        claim: claimResult,
        runInsert: runResult.status,
      })
      expect(claimResult.status).toBe('fulfilled')
      expect(claimResult.ids.sort()).toEqual([...deliveryIds].sort())
      expect(runResult.status).toBe('fulfilled')

      // Write witness: the claim really claimed both rows.
      const claimedRows = await databasePool.query<{
        id: string
        status: string
        attempts: number
      }>(
        `SELECT id::text, status, attempts FROM notification_deliveries
          WHERE id = ANY($1::uuid[])`,
        [deliveryIds]
      )
      expect(
        Object.fromEntries(
          claimedRows.rows.map(row => [row.id, { status: row.status, attempts: row.attempts }])
        )
      ).toEqual({
        [deliveryIds[0]!]: { status: 'retrying', attempts: 1 },
        [deliveryIds[1]!]: { status: 'retrying', attempts: 1 },
      })
      // Negative witness: the claim took no revision row, and the run INSERT
      // rolled back, so both subjects stay where the fixture left them.
      expect(await revision('user', user!)).toBe(beforeUser)
      expect(await revision('team', team!)).toBe(beforeTeam)
    } finally {
      await Promise.resolve()
      if (!claimSettled) await claimSession.query('ROLLBACK').catch(() => undefined)
      await runInsert.query('ROLLBACK').catch(() => undefined)
      claimSession.release()
      runInsert.release()
      await databasePool.query('DELETE FROM notification_deliveries WHERE id = ANY($1::uuid[])', [
        deliveryIds,
      ])
    }
  })
})
