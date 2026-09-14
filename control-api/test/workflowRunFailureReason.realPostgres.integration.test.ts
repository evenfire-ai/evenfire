import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { createDbRunProcessor } from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import { WorkflowAuthorityCheckpointError } from '../../workflow-recipes/src/reconciler/workflowActionCheckpointClient.js'
import { pool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { listRunsByRecipe } from '../src/services/workflowRunService.js'
import { archiveTerminalRuns } from '../src/services/workflowRunsArchiveService.js'
import { mapDbRun } from '../src/services/workflows/workflowRunReadService.js'
import { createWorkflowTriggerApprovalRequest } from '../src/services/workflows/workflowTriggerApprovalService.js'

vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const permanentFailures = [
  ['denied', 'workflow_authority_denied'],
  ['not_found', 'workflow_authority_not_found'],
  ['access_path_stale', 'workflow_authority_access_path_stale'],
  ['invalid_binding', 'workflow_authority_invalid_binding'],
] as const

const transientFailures = ['authority_unavailable', 'invalid_response', 'timeout'] as const

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('workflow run failure reasons on PostgreSQL 16', () => {
  const database = `workflow_failure_reason_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    databasePool = new Pool({ connectionString })
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
  })

  afterAll(async () => {
    corePoolConnectSpy?.mockRestore()
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      await adminPool.end()
    }
  })

  async function insertPendingRun(): Promise<string> {
    const runId = randomUUID()
    const bindingId = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_authority_bindings (
         id, binding_kind, entity_type, entity_id, binding_version, binding_hash,
         user_id, session_id, session_version, delegation_jti, operation_id,
         resource, target, target_hash, access_path_id, authorization_revision,
         path_kind, effective_team_id, behavior_binding_hash,
         source_issued_at, source_expires_at
       ) VALUES (
         $1, 'trigger', 'workflow_trigger', $2, 2, $3,
         $4, $5, 1, $6, 'workflow.trigger', $7::jsonb, $8::jsonb,
         $9, $10, $11, 'direct', NULL, $12, NOW(), NOW() + interval '5 minutes'
       )`,
      [
        bindingId,
        `demo/echo:${runId}`,
        randomBytes(32).toString('hex'),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify({ type: 'workflow_recipe', logicalId: 'demo/echo' }),
        JSON.stringify({ recipeNamespace: 'demo', recipeName: 'echo' }),
        `ath2_${randomBytes(22).toString('base64url')}`,
        `ap1_${randomBytes(22).toString('base64url')}`,
        `ar1_${randomBytes(22).toString('base64url')}`,
        `bh2_${randomBytes(22).toString('base64url')}`,
      ]
    )
    await databasePool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type,
         trigger_source, ttl_seconds_after_finished, initiating_authority_binding_id
       ) VALUES ($1, 'demo', 'echo', 'Pending', 'user', 'onDemand', 0, $2)`,
      [runId, bindingId]
    )
    return runId
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
      release: client.release.bind(client),
    } as unknown as PoolClient
  }

  function processor(
    failure: (typeof permanentFailures)[number][0] | (typeof transientFailures)[number]
  ) {
    return createDbRunProcessor({
      instanceId: 'r6-l5-real-postgres',
      pool: { connect: runtimeClient } as unknown as Pool,
      runPollMs: 30_000,
      createChildRecipe: async () => {
        throw new Error('protected_child_must_not_be_created')
      },
      checkpointAuthority: async () => {
        const retryable = transientFailures.includes(failure as (typeof transientFailures)[number])
        throw new WorkflowAuthorityCheckpointError(failure, retryable)
      },
    })
  }

  it('supports fresh and upgrade migration paths with a closed nullable vocabulary', async () => {
    const fresh = await databasePool.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workflow_runs'
          AND column_name = 'failure_reason'`
    )
    expect(fresh.rows).toEqual([{ is_nullable: 'YES' }])

    await databasePool.query(`
      ALTER TABLE workflow_runs DROP COLUMN failure_reason;
      DELETE FROM schema_migrations WHERE version = '0114_workflow_run_failure_reason';
    `)
    const { initDb } = await import('../src/db.js')
    await initDb({ connect: () => databasePool.connect() })

    const upgraded = await databasePool.query<{ version: string }>(
      `SELECT version FROM schema_migrations
        WHERE version = '0114_workflow_run_failure_reason'`
    )
    expect(upgraded.rows).toEqual([{ version: '0114_workflow_run_failure_reason' }])

    const runId = await insertPendingRun()
    await expect(
      databasePool.query(
        `UPDATE workflow_runs SET failure_reason = 'Bearer token https://secret.invalid'
          WHERE run_id = $1`,
        [runId]
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it.each(permanentFailures)(
    'persists and reads permanent %s as %s through the runtime role',
    async (failure, expectedReason) => {
      const runId = await insertPendingRun()
      const runProcessor = processor(failure)

      await expect(runProcessor.processPending(runId)).resolves.toBeUndefined()
      const result = await databasePool.query<{
        phase: string
        failure_reason: string | null
      }>('SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1', [runId])
      expect(result.rows).toEqual([{ phase: 'Failed', failure_reason: expectedReason }])

      const exactRun = (await listRunsByRecipe('demo', 'echo', 100, databasePool)).find(
        candidate => candidate.run_id === runId
      )
      expect(exactRun).toBeDefined()
      expect(mapDbRun(exactRun!).message).toBe(expectedReason)
    }
  )

  it.each(transientFailures)(
    'rolls back transient %s and leaves the run retryable',
    async failure => {
      const runId = await insertPendingRun()
      const runProcessor = processor(failure)

      await expect(runProcessor.processPending(runId)).rejects.toThrow()
      const result = await databasePool.query<{
        phase: string
        failure_reason: string | null
      }>('SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1', [runId])
      expect(result.rows).toEqual([{ phase: 'Pending', failure_reason: null }])
    }
  )

  it('archives the same safe reason into the audit error field', async () => {
    const runId = await insertPendingRun()
    await processor('invalid_binding').processPending(runId)
    const gateway = {} as K8sGateway

    await expect(
      archiveTerminalRuns(gateway, {
        connectionPool: databasePool,
        graceMs: 0,
        batchSize: 100,
        maxBatches: 2,
      })
    ).resolves.toBeGreaterThanOrEqual(1)

    const audit = await databasePool.query<{ error_message: string | null }>(
      'SELECT error_message FROM workflow_runs_audit WHERE run_id = $1',
      [runId]
    )
    expect(audit.rows).toEqual([{ error_message: 'workflow_authority_invalid_binding' }])
  })

  it('returns the typed reason through an approval idempotency readback', async () => {
    const userId = randomUUID()
    const idempotencyKey = `failure-readback-${randomUUID()}`
    const request = {
      recipeNamespace: 'demo',
      recipeName: 'failure-readback',
      callerKey: 'external-rest-api',
      targetUserId: userId,
      payload: { message: 'Approve the workflow trigger' },
      idempotencyKey,
      runIntent: {
        actorType: 'user' as const,
        actorId: userId,
        teamId: null,
        usageTeamId: null,
        triggerSource: 'onDemand' as const,
        ttlSecondsAfterFinished: 0,
      },
    }
    const approval = await createWorkflowTriggerApprovalRequest(request)
    expect(approval.kind).toBe('approval')
    if (approval.kind !== 'approval') throw new Error('expected approval request')

    await databasePool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
         idempotency_key, trigger_source, approval_request_id,
         ttl_seconds_after_finished, failure_reason
       ) VALUES ($1, 'demo', 'failure-readback', 'Failed', 'user', $2,
                 $3, 'onDemand', $4, 0, 'workflow_authority_denied')`,
      [randomUUID(), userId, idempotencyKey, approval.approvalRequestId]
    )

    const retried = await createWorkflowTriggerApprovalRequest(request)
    expect(retried.kind).toBe('run')
    if (retried.kind !== 'run') throw new Error('expected existing run')
    expect(retried.row.failure_reason).toBe('workflow_authority_denied')
    expect(mapDbRun(retried.row).message).toBe('workflow_authority_denied')
  })
})
