import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  type DbRunProcessor,
  type DbRunProcessorOptions,
  createDbRunProcessor,
} from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import type { WorkflowRecipeCRD } from '../../workflow-recipes/src/types.js'
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

/** One read of the cancel delivery statement, as the processor made it. */
interface CancelRead {
  /** What the test was doing when the read started. */
  stage: string
  /** True for the notification statement (filtered by run id). */
  byRunId: boolean
  rows: number
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

  async function stepOf(
    runId: string,
    stepId: string
  ): Promise<{ phase: string; error: string | null }[]> {
    const result = await databasePool.query<{ phase: string; error: string | null }>(
      'SELECT phase, error FROM workflow_run_steps WHERE run_id = $1 AND step_id = $2',
      [runId, stepId]
    )
    return result.rows
  }

  /** The child recipe status the runtime's report produces, as the watcher syncs it. */
  function childReport(
    runId: string,
    childName: string,
    executionPhase: 'running' | 'completed' | 'failed' | 'cancelled',
    steps: { id: string; phase: string; error?: string }[]
  ): WorkflowRecipeCRD {
    return {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: childName,
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/workflow-run-id': runId },
      },
      spec: {},
      status: {
        phase: 'active',
        workflowExecution: { phase: executionPhase },
        steps,
      },
    } as WorkflowRecipeCRD
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

  /** The runtime pool, recording every read of the cancel delivery statement. */
  function recordingPool(reads: CancelRead[], stage: () => string): Pool {
    const base = runtimePool()
    return {
      connect: base.connect.bind(base),
      query: async (text: string, values?: unknown[]) => {
        if (!text.includes('cancel_requested_at IS NOT NULL')) return base.query(text, values)
        const startedIn = stage()
        const result = await base.query(text, values)
        reads.push({
          stage: startedIn,
          byRunId: values?.length === 1,
          rows: result.rowCount ?? 0,
        })
        return result
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
      deliverCancelSignal: () => {
        throw new Error('no cancel is delivered by this test')
      },
      ...overrides,
    })
    processors.push(created)
    return created
  }

  it('an unbound run makes no authority checkpoint', async () => {
    const instanceId = `unbound-${randomUUID()}`
    const runId = await insertRun({
      phase: 'Pending',
      ownerInstanceId: null,
      maxDurationSeconds: null,
      startedSecondsAgo: null,
      childRecipeName: null,
    })
    const childName = `child-${randomBytes(4).toString('hex')}`
    const checkpointAuthority = vi.fn()
    const onRunStarted = vi.fn()
    const createChildRecipe = vi.fn(async () => ({ name: childName, namespace: 'sandbox-recipes' }))
    const claimer = processor({ instanceId, checkpointAuthority, onRunStarted, createChildRecipe })

    await expect(claimer.processPending(runId)).resolves.toBeUndefined()

    const claimed = await databasePool.query(
      'SELECT phase, child_recipe_name, owner_instance_id FROM workflow_runs WHERE run_id = $1',
      [runId]
    )
    expect(claimed.rows).toEqual([
      { phase: 'Running', child_recipe_name: childName, owner_instance_id: instanceId },
    ])
    expect(createChildRecipe).toHaveBeenCalledOnce()
    expect(onRunStarted).toHaveBeenCalledOnce()
    expect(onRunStarted).toHaveBeenCalledWith(runId)
    expect(checkpointAuthority).not.toHaveBeenCalled()
  })

  describe('cancel delivery (X9)', () => {
    it('every tick re-delivers until the run is terminal', async () => {
      const firstInstance = `deliver-a-${randomUUID()}`
      const childName = `child-${randomBytes(4).toString('hex')}`
      const runId = await insertRun({
        phase: 'Running',
        ownerInstanceId: firstInstance,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName: childName,
        cancelRequested: true,
      })
      const reads: CancelRead[] = []
      let stage = 'first instance'
      const pool = recordingPool(reads, () => stage)

      const deliveredFirst = vi.fn()
      const first = processor({
        instanceId: firstInstance,
        pool,
        runPollMs: 40,
        deliverCancelSignal: deliveredFirst,
      })
      await first.start()
      await vi.waitFor(() => expect(deliveredFirst.mock.calls.length).toBeGreaterThanOrEqual(2), {
        timeout: 5_000,
      })
      await first.stop()

      // A restart: a new processor instance with an empty signal store.
      stage = 'after restart'
      const deliveredRestarted = vi.fn()
      const restarted = processor({
        instanceId: `deliver-b-${randomUUID()}`,
        pool,
        runPollMs: 40,
        deliverCancelSignal: deliveredRestarted,
      })
      await restarted.start()
      await vi.waitFor(() => expect(deliveredRestarted).toHaveBeenCalled(), { timeout: 5_000 })

      // The phase UPDATE also fires the table's notify trigger: the
      // notification read runs too, after the commit, and finds nothing.
      await databasePool.query(
        `UPDATE workflow_runs SET phase = 'Canceled', completed_at = now() WHERE run_id = $1`,
        [runId]
      )
      stage = 'terminal'
      const terminalTickReads = () =>
        reads.filter(read => read.stage === 'terminal' && !read.byRunId)
      await vi.waitFor(() => expect(terminalTickReads().length).toBeGreaterThanOrEqual(2), {
        timeout: 5_000,
      })
      await restarted.stop()

      const rowsRead = (stages: string[]) =>
        reads.filter(read => stages.includes(read.stage)).reduce((sum, read) => sum + read.rows, 0)
      for (const call of [...deliveredFirst.mock.calls, ...deliveredRestarted.mock.calls]) {
        expect(call).toEqual([childName, runId])
      }
      // One delivery per row read; every row came from a tick read before the
      // run was terminal.
      expect(deliveredFirst).toHaveBeenCalledTimes(rowsRead(['first instance']))
      expect(deliveredRestarted).toHaveBeenCalledTimes(rowsRead(['after restart', 'terminal']))
      expect(reads.filter(read => read.byRunId).every(read => read.rows === 0)).toBe(true)
      // The tick read ran after the row became terminal and returned nothing.
      expect(terminalTickReads().length).toBeGreaterThanOrEqual(2)
      expect(reads.filter(read => read.stage === 'terminal').every(read => read.rows === 0)).toBe(
        true
      )
    })

    it('first delivery: the run notification queues the signal before any tick', async () => {
      const instanceId = `deliver-notify-${randomUUID()}`
      const childName = `child-${randomBytes(4).toString('hex')}`
      // Inserted before the listener starts, so the insert's own notification
      // is not heard; the explicit notify below is the one the cancel route
      // sends after storing the request.
      const runId = await insertRun({
        phase: 'Running',
        ownerInstanceId: instanceId,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName: childName,
        cancelRequested: true,
      })
      const reads: CancelRead[] = []
      const delivered = vi.fn()
      const listener = processor({
        instanceId,
        pool: recordingPool(reads, () => 'notification'),
        runPollMs: 600_000,
        deliverCancelSignal: delivered,
      })
      await listener.start()

      await databasePool.query(`SELECT pg_notify('workflow_run_update', $1)`, [runId])

      await vi.waitFor(() => expect(delivered).toHaveBeenCalled(), { timeout: 5_000 })
      expect(delivered).toHaveBeenCalledOnce()
      expect(delivered).toHaveBeenCalledWith(childName, runId)
      expect(reads).toEqual([{ stage: 'notification', byRunId: true, rows: 1 }])
    })

    it('the tick cursor reaches a newer request behind 200 unresolved ones', async () => {
      const inserted = await databasePool.query<{ run_id: string }>(
        `INSERT INTO workflow_runs (
           run_id, recipe_namespace, recipe_name, phase, actor_type,
           trigger_source, ttl_seconds_after_finished, owner_instance_id,
           started_at, child_recipe_name, child_recipe_namespace,
           last_reconciled_at, cancel_requested_at, canceled_by
         )
         SELECT gen_random_uuid(), 'demo', 'echo', 'Running', 'user', 'onDemand', 0, NULL,
                now() - interval '60 seconds', 'child-' || lpad(i::text, 4, '0'),
                'sandbox-recipes', now(), now() - make_interval(secs => 1000 - i),
                'canceller-user'
           FROM generate_series(1, 201) AS i
          ORDER BY i
         RETURNING run_id, cancel_requested_at`
      )
      const byAge = inserted.rows.map(row => row.run_id)
      expect(byAge).toHaveLength(201)
      const ordered = await databasePool.query<{ run_id: string }>(
        `SELECT run_id FROM workflow_runs ORDER BY cancel_requested_at, run_id`
      )
      const oldest = ordered.rows[0].run_id
      const newest = ordered.rows[200].run_id
      const ticks: string[][] = []
      const walker = processor({
        instanceId: `deliver-cursor-${randomUUID()}`,
        deliverCancelSignal: (_childName, runId) => ticks[ticks.length - 1].push(runId),
      })
      const tick = async () => {
        ticks.push([])
        await walker.deliverCancelRequests()
      }

      await tick()
      await tick()
      await tick()

      expect(ticks[0]).toHaveLength(200)
      expect(new Set(ticks[0]).size).toBe(200)
      expect([...ticks[0], ...ticks[1]]).toContain(newest)
      expect(ticks[2][0]).toBe(oldest)
    })
  })

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

  describe('terminal label after a cancel request (X11)', () => {
    it('a cancelled report moves a paused run with a request to Canceled and emits run_end', async () => {
      const instanceId = `label-paused-${randomUUID()}`
      const childName = `child-${randomBytes(4).toString('hex')}`
      const runId = await insertRun({
        phase: 'AuthorizationPaused',
        ownerInstanceId: instanceId,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName: childName,
        cancelRequested: true,
      })
      const before = await databasePool.query(
        'SELECT phase, child_recipe_name FROM workflow_runs WHERE run_id = $1',
        [runId]
      )
      expect(before.rows).toEqual([{ phase: 'AuthorizationPaused', child_recipe_name: childName }])
      const onRunTerminal = vi.fn()
      const syncer = processor({ instanceId, onRunTerminal })

      await syncer.syncFromRecipeExecution(childReport(runId, childName, 'cancelled', []))

      expect(await phaseOf(runId)).toBe('Canceled')
      expect(onRunTerminal).toHaveBeenCalledOnce()
      expect(onRunTerminal).toHaveBeenCalledWith(runId, 'Canceled')
    })

    it('a failed report on a run with a cancel request is recorded Canceled', async () => {
      const instanceId = `label-failed-${randomUUID()}`
      const fixture = (cancelRequested: boolean): RunFixture => ({
        phase: 'Running',
        ownerInstanceId: instanceId,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName: `child-${randomBytes(4).toString('hex')}`,
        cancelRequested,
      })
      const requested = await insertRun(fixture(true))
      const plain = await insertRun(fixture(false))
      const failedStep = { id: 'step-1', phase: 'failed', error: 'step approval cancelled' }
      const onRunTerminal = vi.fn()
      const syncer = processor({ instanceId, onRunTerminal })

      await syncer.syncFromRecipeExecution(
        childReport(requested, 'child-a', 'failed', [failedStep])
      )
      await syncer.syncFromRecipeExecution(childReport(plain, 'child-b', 'failed', [failedStep]))

      expect(await phaseOf(requested)).toBe('Canceled')
      expect(await stepOf(requested, 'step-1')).toEqual([
        { phase: 'Failed', error: 'step approval cancelled' },
      ])
      // The same report on a run without a request is recorded as the failure it is.
      expect(await phaseOf(plain)).toBe('Failed')
      expect(onRunTerminal.mock.calls).toEqual([
        [requested, 'Canceled'],
        [plain, 'Failed'],
      ])
    })

    it('the stuck sweep and the missing-child reclaim record Canceled for a run with a request', async () => {
      // Stuck sweep: two owned runs past the cap, one with a request.
      const sweepInstance = `label-sweep-${randomUUID()}`
      const stuck = (cancelRequested: boolean): RunFixture => ({
        phase: 'Running',
        ownerInstanceId: sweepInstance,
        maxDurationSeconds: null,
        startedSecondsAgo: DEFAULT_CAP_SECONDS + 120,
        childRecipeName: `child-${randomBytes(4).toString('hex')}`,
        cancelRequested,
      })
      const sweptRequested = await insertRun(stuck(true))
      const sweptPlain = await insertRun(stuck(false))
      const sweepTerminal = vi.fn()
      const sweeper = processor({ instanceId: sweepInstance, onRunTerminal: sweepTerminal })

      await expect(sweeper.checkStuckRuns()).resolves.toBe(2)

      expect(await phaseOf(sweptRequested)).toBe('Canceled')
      expect(await phaseOf(sweptPlain)).toBe('Failed')
      expect(new Map(sweepTerminal.mock.calls)).toEqual(
        new Map([
          [sweptRequested, 'Canceled'],
          [sweptPlain, 'Failed'],
        ])
      )
      expect(sweepTerminal).toHaveBeenCalledTimes(2)

      // Missing-child reclaim: ownerless Running runs whose child is gone
      // (both branches: a child name that does not exist, and no child name).
      const orphan = (childRecipeName: string | null, cancelRequested: boolean): RunFixture => ({
        phase: 'Running',
        ownerInstanceId: null,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName,
        cancelRequested,
      })
      const goneRequested = await insertRun(orphan(`child-${randomBytes(4).toString('hex')}`, true))
      const gonePlain = await insertRun(orphan(`child-${randomBytes(4).toString('hex')}`, false))
      const unnamedRequested = await insertRun(orphan(null, true))
      const reclaimTerminal = vi.fn()
      const childRecipeExists = vi.fn(async () => false)
      const reclaimer = processor({
        instanceId: `label-reclaim-${randomUUID()}`,
        runPollMs: 40,
        childRecipeExists,
        deliverCancelSignal: vi.fn(),
        onRunTerminal: reclaimTerminal,
      })
      await reclaimer.start()
      await vi.waitFor(() => expect(reclaimTerminal).toHaveBeenCalledTimes(3), { timeout: 5_000 })
      await reclaimer.stop()

      expect(childRecipeExists).toHaveBeenCalledTimes(2)
      expect(await phaseOf(goneRequested)).toBe('Canceled')
      expect(await phaseOf(gonePlain)).toBe('Failed')
      expect(await phaseOf(unnamedRequested)).toBe('Canceled')
      expect(new Map(reclaimTerminal.mock.calls)).toEqual(
        new Map([
          [goneRequested, 'Canceled'],
          [gonePlain, 'Failed'],
          [unnamedRequested, 'Canceled'],
        ])
      )
    })

    it('a late step report on a Canceled run writes the step and leaves the phase', async () => {
      const instanceId = `label-late-${randomUUID()}`
      const childName = `child-${randomBytes(4).toString('hex')}`
      const runId = await insertRun({
        phase: 'Canceled',
        ownerInstanceId: instanceId,
        maxDurationSeconds: null,
        startedSecondsAgo: 30,
        childRecipeName: childName,
        cancelRequested: true,
      })
      const onRunTerminal = vi.fn()
      const syncer = processor({ instanceId, onRunTerminal })

      await syncer.syncFromRecipeExecution(
        childReport(runId, childName, 'failed', [
          { id: 'step-2', phase: 'failed', error: 'late failure' },
        ])
      )

      expect(await stepOf(runId, 'step-2')).toEqual([{ phase: 'Failed', error: 'late failure' }])
      expect(await phaseOf(runId)).toBe('Canceled')
      expect(onRunTerminal).not.toHaveBeenCalled()
    })
  })
})
