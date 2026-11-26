import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  type DbRunProcessor,
  type DbRunProcessorOptions,
  createDbRunProcessor,
} from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// SQL checks of the workflow-recipes run processor against the schema built by
// control-api's own migrations. The processor runs as `workflow_recipes_runtime`
// (SET LOCAL ROLE inside every transaction), as it does in production.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const DEFAULT_CAP_SECONDS = 86_400

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

interface RunFixture {
  phase: 'Pending' | 'Running' | 'AuthorizationPaused' | 'Succeeded' | 'Failed' | 'Canceled'
  ownerInstanceId: string | null
  maxDurationSeconds: number | null
  startedSecondsAgo: number | null
  childRecipeName: string | null
  cancelRequested?: boolean
}

describeRealPostgres('workflow run processor SQL on PostgreSQL 16', () => {
  const database = `workflow_processor_sql_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  let processors: DbRunProcessor[] = []

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    databasePool = new Pool({ connectionString })
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => databasePool.connect() })
  })

  beforeEach(async () => {
    processors = []
    await databasePool.query('TRUNCATE workflow_runs CASCADE')
  })

  afterEach(async () => {
    for (const processor of processors) await processor.stop()
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function insertRun(fixture: RunFixture): Promise<string> {
    const runId = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type,
         trigger_source, ttl_seconds_after_finished, owner_instance_id,
         max_duration_seconds, started_at, child_recipe_name, child_recipe_namespace,
         last_reconciled_at, cancel_requested_at, canceled_by
       ) VALUES (
         $1, 'demo', 'echo', $2, 'user', 'onDemand', 0, $3, $4,
         CASE WHEN $5::double precision IS NULL THEN NULL
              ELSE now() - make_interval(secs => $5::double precision) END,
         $6, CASE WHEN $6::text IS NULL THEN NULL ELSE 'sandbox-recipes' END,
         now(),
         CASE WHEN $7 THEN now() ELSE NULL END,
         CASE WHEN $7 THEN 'canceller-user' ELSE NULL END
       )`,
      [
        runId,
        fixture.phase,
        fixture.ownerInstanceId,
        fixture.maxDurationSeconds,
        fixture.startedSecondsAgo,
        fixture.childRecipeName,
        fixture.cancelRequested === true,
      ]
    )
    return runId
  }

  async function phaseOf(runId: string): Promise<string> {
    const result = await databasePool.query<{ phase: string }>(
      'SELECT phase FROM workflow_runs WHERE run_id = $1',
      [runId]
    )
    expect(result.rows).toHaveLength(1)
    return result.rows[0].phase
  }

  async function runtimeClient(): Promise<PoolClient> {
    const client = await databasePool.connect()
    return {
      query: async (...args: Parameters<PoolClient['query']>) => {
        const result = await client.query(...args)
        if (typeof args[0] === 'string' && args[0].trim().toUpperCase() === 'BEGIN') {
          await client.query('SET LOCAL ROLE workflow_recipes_runtime')
        }
        return result
      },
      on: client.on.bind(client),
      release: client.release.bind(client),
    } as unknown as PoolClient
  }

  /** A pool whose every statement runs as the workflow-recipes runtime role. */
  function runtimePool(): Pool {
    return {
      connect: runtimeClient,
      query: async (text: string, values?: unknown[]) => {
        const client = await runtimeClient()
        try {
          await client.query('BEGIN')
          const result = await client.query(text, values)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
    } as unknown as Pool
  }

  function processor(
    overrides: Partial<DbRunProcessorOptions> & Pick<DbRunProcessorOptions, 'instanceId'>
  ): DbRunProcessor {
    const created = createDbRunProcessor({
      pool: runtimePool(),
      runPollMs: 60_000,
      maxRunDurationCapSeconds: DEFAULT_CAP_SECONDS,
      createChildRecipe: async () => {
        throw new Error('no child is created by this test')
      },
      ...overrides,
    })
    processors.push(created)
    return created
  }

  describe('stuck sweep (X13)', () => {
    const storedDurations = [null, DEFAULT_CAP_SECONDS, 2 * DEFAULT_CAP_SECONDS, 300] as const

    it.each([DEFAULT_CAP_SECONDS, 600])(
      'the stuck sweep bounds every owned run by the cap (cap %i s)',
      async cap => {
        const instanceId = `stuck-sweep-${cap}-${randomUUID()}`
        const swept: string[] = []
        const kept: string[] = []
        for (const stored of storedDurations) {
          const bound = Math.min(stored ?? cap, cap)
          swept.push(
            await insertRun({
              phase: 'Running',
              ownerInstanceId: instanceId,
              maxDurationSeconds: stored,
              startedSecondsAgo: bound + 120,
              childRecipeName: `child-${randomBytes(4).toString('hex')}`,
            })
          )
          kept.push(
            await insertRun({
              phase: 'Running',
              ownerInstanceId: instanceId,
              maxDurationSeconds: stored,
              startedSecondsAgo: bound - 120,
              childRecipeName: `child-${randomBytes(4).toString('hex')}`,
            })
          )
        }
        const onRunTerminal = vi.fn()
        const sweeper = processor({ instanceId, maxRunDurationCapSeconds: cap, onRunTerminal })

        // checkStuckRuns logs and returns 0 on a failed statement, so the
        // count and the swept rows are asserted in the same call.
        await expect(sweeper.checkStuckRuns()).resolves.toBe(storedDurations.length)

        expect(onRunTerminal.mock.calls.map(([runId]) => runId).sort()).toEqual([...swept].sort())
        for (const call of onRunTerminal.mock.calls) expect(call[1]).toBe('Failed')
        for (const runId of swept) expect(await phaseOf(runId)).toBe('Failed')
        for (const runId of kept) expect(await phaseOf(runId)).toBe('Running')
      }
    )

    it('a paused owned run is swept at the cap; an ownerless paused run is not', async () => {
      const instanceId = `stuck-paused-${randomUUID()}`
      const owned = await insertRun({
        phase: 'AuthorizationPaused',
        ownerInstanceId: instanceId,
        maxDurationSeconds: null,
        startedSecondsAgo: DEFAULT_CAP_SECONDS + 120,
        childRecipeName: `child-${randomBytes(4).toString('hex')}`,
      })
      const ownerless = await insertRun({
        phase: 'AuthorizationPaused',
        ownerInstanceId: null,
        maxDurationSeconds: null,
        startedSecondsAgo: DEFAULT_CAP_SECONDS + 120,
        childRecipeName: `child-${randomBytes(4).toString('hex')}`,
      })
      const onRunTerminal = vi.fn()
      const sweeper = processor({ instanceId, onRunTerminal })

      await expect(sweeper.checkStuckRuns()).resolves.toBe(1)

      expect(onRunTerminal).toHaveBeenCalledOnce()
      expect(onRunTerminal).toHaveBeenCalledWith(owned, 'Failed')
      expect(await phaseOf(owned)).toBe('Failed')
      expect(await phaseOf(ownerless)).toBe('AuthorizationPaused')
    })
  })
})
