import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: vi.fn(async () => null),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const suite = describe.skipIf(!adminUrl)('R1-M1 snapshot classification on real PostgreSQL', () => {
  const database = `r1m1_r6snap_${randomUUID().replaceAll('-', '')}`
  let adminPool: Pool
  let pool: Pool
  const subject = '11111111-1111-4111-8111-111111111111'
  const ids = {
    root: '00000000-0000-4000-8000-000000000001',
    a: '00000000-0000-4000-8000-000000000002',
    b: '00000000-0000-4000-8000-000000000003',
    resource: '00000000-0000-4000-8000-000000000004',
  }
  const caller = {
    isOperator: false,
    subjects: new Set([`user:${subject}`]),
    actorKey: `user:${subject}`,
    desktopUserId: subject,
    primaryTeamId: null,
    authoritySource: 'user-session' as const,
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    await pool.query(`CREATE TABLE team_members (
      team_id uuid NOT NULL, user_id uuid NOT NULL, status text NOT NULL)`)
    await pool.query(`CREATE TABLE gfs_resources (
      resource_id uuid PRIMARY KEY, drive text NOT NULL, parent_resource_id uuid,
      name text NOT NULL, kind text NOT NULL, path_cache text, version int NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`)
    await pool.query(`CREATE TABLE gfs_grants (
      drive text NOT NULL, resource_id uuid NOT NULL, subject_type text NOT NULL,
      subject_id text NOT NULL, permissions text[] NOT NULL, inherit boolean NOT NULL,
      granted_by text, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (drive, resource_id, subject_type, subject_id))`)
    await pool.query(`CREATE TABLE gfs_shares (
      drive text NOT NULL, resource_id uuid NOT NULL, subject_type text NOT NULL,
      subject_id text NOT NULL, permissions text[] NOT NULL, include_descendants boolean NOT NULL,
      created_by text, UNIQUE (drive, resource_id, subject_type, subject_id))`)
    await pool.query(`CREATE TABLE gfs_audit (
      sequence_no bigserial PRIMARY KEY, subject text NOT NULL, actor_on_behalf_of text,
      op text NOT NULL, gfs_uri text NOT NULL, outcome text NOT NULL, source_ip text,
      request_id text, row_hash text NOT NULL, desktop_user_id uuid, authority_source text)`)
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(pool)
      if (!adminPool) return
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function reset(initialGrant: boolean) {
    await pool.query('TRUNCATE gfs_shares, gfs_grants, gfs_resources')
    await pool.query(
      `INSERT INTO gfs_resources
      (resource_id, drive, parent_resource_id, name, kind, path_cache) VALUES
      ($1, 'main', NULL, '/', 'directory', '/'),
      ($2, 'main', $1, 'A', 'directory', '/A'),
      ($3, 'main', $1, 'B', 'directory', '/B'),
      ($4, 'main', $2, 'R.txt', 'file', '/A/R.txt')`,
      [ids.root, ids.a, ids.b, ids.resource]
    )
    if (initialGrant) await grant(ids.a, true)
  }
  async function grant(resourceId: string, inherit: boolean) {
    const { writeGfsGrantBatchInTransaction } = await import('../src/routes/gfs/grants.js')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await writeGfsGrantBatchInTransaction(client as never, {
        req: { adminAuth: { sub: 'operator-test' }, ip: '127.0.0.1' } as never,
        caller: { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
        drive: 'main',
        resourceId,
        subjects: [{ type: 'user', id: subject }],
        permissions: ['read'],
        inherit,
      })
      expect(result.error).toBeNull()
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  async function revoke(resourceId: string) {
    await pool.query(
      `DELETE FROM gfs_grants WHERE drive='main' AND resource_id=$1
      AND subject_type='user' AND subject_id=$2`,
      [resourceId, subject]
    )
  }
  async function share(resourceId: string) {
    const { writeGfsShareBatchInTransaction } = await import('../src/routes/gfs/shares.js')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await writeGfsShareBatchInTransaction(client as never, {
        req: { adminAuth: { sub: 'operator-test' }, ip: '127.0.0.1' } as never,
        caller: { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
        drive: 'main',
        resourceId,
        subjects: [{ type: 'user', id: subject }],
        permissions: ['read'],
        includeDescendants: true,
      })
      expect(result.error).toBeNull()
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  async function moveToB() {
    const { applyResourcePatch } = await import('../src/routes/gfs/resources.js')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyResourcePatch(
        client,
        { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
        'main',
        ids.resource,
        { newParentId: ids.b },
        async () => {}
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  it('generates real PostgreSQL producer/evaluation orders against coherent snapshots', async () => {
    const { heldPermissions } = await import('../src/routes/gfs/grants.js')
    const variants = [
      {
        name: 'move+inherited-grant',
        impossible: true,
        mutate: async () => {
          await moveToB()
          await grant(ids.a, true)
        },
      },
      {
        name: 'move+share',
        impossible: true,
        mutate: async () => {
          await moveToB()
          await share(ids.a)
        },
      },
      {
        name: 'direct-noninheriting',
        impossible: false,
        mutate: async () => {
          await moveToB()
          await grant(ids.resource, false)
        },
      },
      { name: 'inherited-grant', impossible: false, mutate: async () => grant(ids.a, true) },
      { name: 'revoke-inherited', impossible: false, mutate: async () => revoke(ids.a) },
    ] as const
    const schedules = (
      ['before-dispatch', 'between-first-result-and-next-query', 'after-evaluation'] as const
    ).flatMap(order => variants.map(variant => ({ ...variant, order })))
    const generated = fc.sample(
      fc.shuffledSubarray(schedules, { minLength: schedules.length, maxLength: schedules.length }),
      { seed: 6_129, numRuns: 1 }
    )[0]
    const classifications: string[] = []
    for (const scenario of generated) {
      await reset(scenario.name === 'revoke-inherited')
      const beforeAllowed = scenario.name === 'revoke-inherited'
      if (scenario.order === 'before-dispatch') await scenario.mutate()
      let resolveFirst!: () => void
      let releaseFirst!: () => void
      const firstDone = new Promise<void>(resolve => {
        resolveFirst = resolve
      })
      const gate = new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      let calls = 0
      const candidateIndependentDb = {
        async query(text: string, values?: unknown[]) {
          const call = ++calls
          const result = await pool.query(text, values)
          if (scenario.order === 'between-first-result-and-next-query' && call === 1) {
            resolveFirst()
            await gate
          }
          return result
        },
      }
      const pending = heldPermissions(candidateIndependentDb, caller, 'main', ids.resource)
      if (scenario.order === 'between-first-result-and-next-query') {
        await firstDone
        // The scheduled SQL mutation is the real producer-side effect; release the reader only
        // after its transaction has committed, without depending on query text.
        const [sqlScheduler] = fc.sample(fc.scheduler(), {
          seed: 61_290 + schedules.indexOf(scenario),
          numRuns: 1,
        })
        const mutationDescriptor = sqlScheduler.schedule(
          Promise.resolve({ mutate: scenario.mutate }),
          `${scenario.order}:${scenario.name}`
        )
        // The actual SQL mutation is chained behind the scheduler-controlled result. Merely
        // scheduling a Promise that already started mutation would not gate the side effect.
        const mutation = mutationDescriptor.then(descriptor => descriptor.mutate())
        await sqlScheduler.waitAll()
        await mutation
        releaseFirst()
      } else if (scenario.order === 'after-evaluation') {
        const actualAllowed = (await pending).includes('read')
        await scenario.mutate()
        expect(actualAllowed, `${scenario.order}:${scenario.name} uses pre-mutation state`).toBe(
          beforeAllowed
        )
        expect(calls).toBe(1)
        classifications.push(`${scenario.order}:${scenario.name}=valid-before-evaluation`)
        continue
      }
      const actualAllowed = (await pending).includes('read')
      const afterAllowed =
        scenario.name === 'move+inherited-grant' || scenario.name === 'move+share'
          ? false
          : scenario.name === 'direct-noninheriting' || scenario.name === 'inherited-grant'
      if (scenario.order === 'before-dispatch') {
        expect(actualAllowed, `${scenario.order}:${scenario.name} uses post-mutation state`).toBe(
          afterAllowed
        )
        expect(calls).toBe(1)
        classifications.push(`${scenario.order}:${scenario.name}=valid-after-evaluation`)
      } else {
        // The permission statement's snapshot was taken before the controlled
        // mutation commit, so this is the valid pre-mutation evaluation result.
        expect(actualAllowed, `${scenario.order}:${scenario.name} uses pre-mutation snapshot`).toBe(
          beforeAllowed
        )
        expect(calls).toBe(1)
        classifications.push(`${scenario.order}:${scenario.name}=valid-before-evaluation`)
      }
    }
    expect(generated.map(item => item.order)).toContain('before-dispatch')
    expect(generated.map(item => item.order)).toContain('between-first-result-and-next-query')
    expect(generated.map(item => item.order)).toContain('after-evaluation')
    expect(classifications.filter(value => value.includes('valid-before-evaluation'))).toHaveLength(
      10
    )
    process.stdout.write(
      JSON.stringify({
        generated: generated.map(item => `${item.order}:${item.name}`),
        classifications,
        barrier: 'first result completion; no SQL-text match',
        correctedSingleStatement: 'user-session authority executed as one statement',
      }) + '\n'
    )
  }, 60_000)

  it('coherent D0 returns a valid evaluation-point result for a move and inherited grant', async () => {
    const { heldPermissions } = await import('../src/routes/gfs/grants.js')
    await reset(false)
    let resolveFirst!: () => void
    let releaseFirst!: () => void
    const firstDone = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let calls = 0
    const candidateIndependentDb = {
      async query(text: string, values?: unknown[]) {
        const result = await pool.query(text, values)
        if (++calls === 1) {
          resolveFirst()
          await gate
        }
        return result
      },
    }
    const pending = heldPermissions(candidateIndependentDb, caller, 'main', ids.resource)
    await firstDone
    await moveToB()
    await grant(ids.a, true)
    releaseFirst()

    // The one statement observed the pre-move, no-grant state; the later move and grant
    // are ordered after its permission evaluation.
    expect(await pending).not.toContain('read')
    expect(calls).toBe(1)
  }, 60_000)

  it('records an analyzed plan for the exact production permission statement', async () => {
    const { heldPermissions } = await import('../src/routes/gfs/grants.js')
    await reset(true)
    const statements: Array<{ text: string; values?: unknown[] }> = []
    const observingDb = {
      async query(text: string, values?: unknown[]) {
        statements.push({ text, values })
        return pool.query(text, values)
      },
    }

    await expect(heldPermissions(observingDb, caller, 'main', ids.resource)).resolves.toContain(
      'read'
    )
    expect(statements).toHaveLength(1)
    const planResult = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statements[0]!.text}`,
      statements[0]!.values
    )
    const plan = planResult.rows[0]?.['QUERY PLAN']?.[0]
    expect(plan?.Plan).toBeTruthy()
    process.stdout.write(
      JSON.stringify({
        statementCount: statements.length,
        planningTimeMs: plan?.['Planning Time'],
        executionTimeMs: plan?.['Execution Time'],
        rootPlanNode: plan?.Plan?.['Node Type'],
      }) + '\n'
    )
  }, 30_000)
})
