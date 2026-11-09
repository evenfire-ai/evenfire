import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import {
  type ChildRecipeCreator,
  type DbRunProcessor,
  createDbRunProcessor,
} from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import type { WorkflowRecipeCRD } from '../../workflow-recipes/src/types.js'
import { initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// The workflow-recipes controller starts a Pending run in three steps: a short
// transaction reserves the run (owner_instance_id + last_reconciled_at, a
// one-minute lease), the child WorkflowRecipe is created with no transaction,
// lock or pooled client held, and a second short transaction claims the run.
// These cases run that code against the real control-api schema.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe.sequential : describe.skip
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

function captureLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: () => logger,
  }
  return logger
}

const CHILD = { name: 'demo-parent-child', namespace: 'sandbox-recipes' }

describeRealPostgres('workflow run start reservation (real PostgreSQL)', () => {
  const database = `control_api_wrc_start_reservation_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  // The controller's own pool, as in production: max 4.
  let wrcPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    wrcPool = new Pool({ connectionString, max: 4 })
  })

  afterAll(async () => {
    try {
      if (wrcPool) await endPoolAndWaitForClients(wrcPool)
      if (databasePool) await endPoolAndWaitForClients(databasePool)
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

  function processor(
    instanceId: string,
    createChildRecipe: ChildRecipeCreator,
    logger = captureLogger()
  ): DbRunProcessor {
    return createDbRunProcessor({
      instanceId,
      pool: wrcPool,
      // The poll is not started; each case calls processPending directly.
      runPollMs: 3_600_000,
      createChildRecipe,
      logger,
    })
  }

  async function insertPendingRun(
    reservation: { owner: string; ageSeconds: number } | null = null
  ): Promise<string> {
    const result = await databasePool.query<{ run_id: string }>(
      `INSERT INTO workflow_runs (
         recipe_namespace, recipe_name, phase, actor_type, trigger_source,
         owner_instance_id, last_reconciled_at
       )
       VALUES ('sandbox-recipes', 'demo-parent', 'Pending', 'user', 'onDemand',
               $1::text,
               CASE WHEN $1::text IS NULL THEN NULL
                    ELSE now() - make_interval(secs => $2::int) END)
       RETURNING run_id::text AS run_id`,
      [reservation?.owner ?? null, reservation?.ageSeconds ?? 0]
    )
    return result.rows[0]!.run_id
  }

  async function runRow(runId: string) {
    const result = await databasePool.query<{
      phase: string
      owner_instance_id: string | null
      child_recipe_name: string | null
      child_recipe_namespace: string | null
      last_reconciled_at: Date | null
    }>(
      `SELECT phase, owner_instance_id, child_recipe_name, child_recipe_namespace,
              last_reconciled_at
         FROM workflow_runs
        WHERE run_id = $1`,
      [runId]
    )
    return result.rows[0]
  }

  it('creates the child with no lock held and makes a concurrent starter return without a create', async () => {
    const runId = await insertPendingRun()
    let markCreateEntered!: () => void
    let releaseCreate!: () => void
    const createEntered = new Promise<void>(resolve => {
      markCreateEntered = resolve
    })
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve
    })
    const createA = vi.fn(async () => {
      markCreateEntered()
      await createGate
      return CHILD
    })
    const createB = vi.fn(async () => CHILD)
    const loggerB = captureLogger()
    const starterA = processor('wrc-a', createA).processPending(runId)
    const starterASettled = starterA.then(
      () => 'resolved' as const,
      (error: unknown) => error
    )

    try {
      await createEntered
      // While A's create is in flight, nothing holds the run: another session
      // takes the per-run advisory key and the row lock without waiting.
      const probe = await databasePool.connect()
      try {
        await probe.query('BEGIN')
        const advisory = await probe.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext('wrc-run-' || $1::text)) AS locked",
          [runId]
        )
        expect(advisory.rows[0]?.locked).toBe(true)
        const locked = await probe.query(
          `SELECT owner_instance_id, phase
             FROM workflow_runs
            WHERE run_id = $1
            FOR UPDATE NOWAIT`,
          [runId]
        )
        // The reservation is committed and visible before the create returns.
        expect(locked.rows[0]).toEqual({ owner_instance_id: 'wrc-a', phase: 'Pending' })
      } finally {
        await probe.query('ROLLBACK')
        probe.release()
      }

      await processor('wrc-b', createB, loggerB).processPending(runId)
      expect(createB).not.toHaveBeenCalled()
      // Witness: B ran its reservation and found A's lease.
      expect(loggerB.info).toHaveBeenCalledWith(
        'pending run start already reserved',
        expect.objectContaining({ run_id: runId, owner_instance_id: 'wrc-a' })
      )
    } finally {
      releaseCreate()
    }

    expect(await starterASettled).toBe('resolved')
    expect(createA).toHaveBeenCalledTimes(1)
    expect(await runRow(runId)).toMatchObject({
      phase: 'Running',
      owner_instance_id: 'wrc-a',
      child_recipe_name: CHILD.name,
      child_recipe_namespace: CHILD.namespace,
    })
  })

  it('keeps the reservation after a failed create and retries once the lease expires', async () => {
    const runId = await insertPendingRun()
    const create = vi
      .fn<ChildRecipeCreator>()
      .mockRejectedValueOnce(new Error('apiserver unavailable'))
      .mockResolvedValue(CHILD)
    const logger = captureLogger()
    const starter = processor('wrc-a', create, logger)

    await expect(starter.processPending(runId)).rejects.toThrow('apiserver unavailable')
    const reserved = await runRow(runId)
    expect(reserved).toMatchObject({
      phase: 'Pending',
      owner_instance_id: 'wrc-a',
      child_recipe_name: null,
    })
    expect(reserved?.last_reconciled_at).toBeInstanceOf(Date)

    // An immediate retry, even from the same instance, finds the lease held.
    await starter.processPending(runId)
    expect(create).toHaveBeenCalledTimes(1)
    // Witness: the retry ran its reservation and found the lease held.
    expect(logger.info).toHaveBeenCalledWith(
      'pending run start already reserved',
      expect.objectContaining({ run_id: runId, owner_instance_id: 'wrc-a' })
    )

    await databasePool.query(
      `UPDATE workflow_runs
          SET last_reconciled_at = now() - interval '2 minutes'
        WHERE run_id = $1`,
      [runId]
    )
    await starter.processPending(runId)
    expect(create).toHaveBeenCalledTimes(2)
    expect(await runRow(runId)).toMatchObject({
      phase: 'Running',
      owner_instance_id: 'wrc-a',
      child_recipe_name: CHILD.name,
    })
  })

  it("does not let a Pending run's child heartbeat renew an expired reservation", async () => {
    const runId = await insertPendingRun({ owner: 'wrc-gone', ageSeconds: 120 })
    const before = await runRow(runId)
    const create = vi.fn<ChildRecipeCreator>().mockResolvedValue(CHILD)
    const starter = processor('wrc-b', create)

    const child: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: CHILD.name,
        namespace: CHILD.namespace,
        labels: { 'clerum.io/workflow-run-id': runId },
      },
      spec: {},
      status: { phase: 'active', steps: [{ id: 'prepare', phase: 'pending' }] },
    }
    await starter.syncFromRecipeExecution(child)

    // Witness: the non-terminal sync ran and wrote the step row.
    const steps = await databasePool.query(
      'SELECT step_id, phase FROM workflow_run_steps WHERE run_id = $1',
      [runId]
    )
    expect(steps.rows).toEqual([{ step_id: 'prepare', phase: 'Pending' }])
    expect((await runRow(runId))?.last_reconciled_at).toEqual(before?.last_reconciled_at)

    await starter.processPending(runId)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await runRow(runId)).toMatchObject({
      phase: 'Running',
      owner_instance_id: 'wrc-b',
      child_recipe_name: CHILD.name,
    })
  })

  it('rejects the pre-reservation claim of an older replica against a live reservation', async () => {
    const runId = await insertPendingRun({ owner: 'wrc-new', ageSeconds: 0 })
    // CLAIM_PENDING as released before the reservation existed (dev d02fcb9f1).
    const olderClaim = await databasePool.query(
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
      ['wrc-old', CHILD.name, CHILD.namespace, runId]
    )
    expect(olderClaim.rowCount).toBe(0)
    expect(await runRow(runId)).toMatchObject({ phase: 'Pending', owner_instance_id: 'wrc-new' })
  })
})
