import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { initDb } from '../src/db.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import { failStaleInvocationsInTransaction } from '../src/services/pluginWorkloadSdkDb.js'
import {
  PromptBridgeFinalizationError,
  type PromptBridgeFinalizationInput,
  finalizePromptBridgeInTransaction,
} from '../src/services/pluginWorkloadSdkFinalization.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN')
}

async function commit(client: PoolClient): Promise<void> {
  await client.query('COMMIT')
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(value => {
    resolve = value
  })
  return { promise, resolve }
}

describeRealPostgres('Plugin Workload SDK finalization on real PostgreSQL', () => {
  const database = `control_api_sdk_finalization_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let dbPool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    dbPool = new Pool({ connectionString })
    await initDb({ connect: () => dbPool.connect() })
  })

  afterAll(async () => {
    await dbPool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      await adminPool.end()
    }
  })

  async function seedAttempt(
    client: PoolClient,
    options: {
      status?: PromptBridgeFinalizationInput['status']
      leaseExpired?: boolean
    } = {}
  ): Promise<PromptBridgeFinalizationInput> {
    const invocationId = randomUUID()
    const providerAttemptId = randomUUID()
    const recipeNamespace = 'sandbox-recipes'
    const recipeName = `real-finalization-${invocationId}`
    const status = options.status ?? 'provider_unavailable'
    const leaseExpression = options.leaseExpired
      ? "now() - interval '5 minutes'"
      : "now() + interval '5 minutes'"
    const target = {
      targetRef: 'primary-openai',
      provider: 'openai',
      model: 'gpt-4o-mini',
      credentialSlot: 'openai-api-key',
    }
    await client.query(
      `INSERT INTO plugin_workload_sdk_invocations
         (id, recipe_namespace, recipe_name, caller_ref, method, detail,
          idempotency_key_hash, payload_hash, status, authorization_decision,
          contract_version, attempt_generation, lease_expires_at)
       VALUES ($1, $2, $3, 'integration-test', 'promptBridge', '{}',
               $4, $5, 'in_progress', 'allowed', 2, 1, ${leaseExpression})`,
      [invocationId, recipeNamespace, recipeName, randomUUID(), randomUUID()]
    )
    await client.query(
      `INSERT INTO plugin_workload_sdk_invocation_attempts
         (invocation_id, recipe_namespace, recipe_name, attempt_generation,
          method, target_refs, status, lease_expires_at)
       VALUES ($1, $2, $3, 1, 'promptBridge', $4::jsonb, 'in_progress',
               ${leaseExpression})`,
      [invocationId, recipeNamespace, recipeName, JSON.stringify([target.targetRef])]
    )
    await client.query(
      `INSERT INTO plugin_workload_sdk_provider_attempts
         (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
          attempt_index, target_ref, provider, model, credential_slot, status,
          lease_expires_at)
       VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, 'in_progress',
               now() + interval '5 minutes')`,
      [
        providerAttemptId,
        invocationId,
        recipeNamespace,
        recipeName,
        target.targetRef,
        target.provider,
        target.model,
        target.credentialSlot,
      ]
    )
    return {
      invocationId,
      recipeNamespace,
      recipeName,
      hostRef: 'mcp-host/integration',
      attemptGeneration: 1,
      providerAttemptId,
      providerAttemptIndex: 1,
      status,
      target,
      reason: 'integration_provider_unavailable',
      ...(status === 'complete'
        ? {
            usage: {
              llmSecretName: 'openai-api-key',
              callerRef: 'integration-test',
              fallbackUsed: false,
              attemptCount: 1,
              inputTokens: 23,
              outputTokens: 11,
            },
          }
        : {}),
    }
  }

  it('writes one immutable unknown outcome and makes an identical replay idempotent', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client)
      const first = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)

      expect(first).toMatchObject({
        status: 'provider_unavailable',
        outcome: 'unknown',
        idempotent: false,
      })

      const replayClient = await dbPool.connect()
      try {
        await begin(replayClient)
        const replay = await finalizePromptBridgeInTransaction(input, replayClient)
        await commit(replayClient)
        expect(replay).toMatchObject({
          status: 'provider_unavailable',
          outcome: 'unknown',
          idempotent: true,
        })
      } finally {
        replayClient.release()
      }

      const count = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE provider_attempt_id = $1`,
        [input.providerAttemptId]
      )
      expect(count.rows[0]?.count).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('deterministically re-reads the sweeper outcome after ON CONFLICT', async () => {
    const seedClient = await dbPool.connect()
    const sweeperClient = await dbPool.connect()
    const finalizerClient = await dbPool.connect()
    try {
      await begin(seedClient)
      const input = await seedAttempt(seedClient, {
        status: 'provider_unavailable',
        leaseExpired: true,
      })
      await commit(seedClient)

      await begin(sweeperClient)
      // The sweeper writes its immutable outcome but keeps the transaction
      // open. The finalizer therefore cannot see the row in its first
      // READ COMMITTED ledger lookup, while the invocation row remains locked.
      await failStaleInvocationsInTransaction(1, sweeperClient)

      const initialLedgerRead = deferred<void>()
      const releaseInitialLedgerRead = deferred<void>()
      let ledgerReadCount = 0
      let conflictInsertRowCount: number | null = null
      const finalizerDb = {
        query: async (statement: string, values?: unknown[]) => {
          const result = await finalizerClient.query(statement, values)
          const isLedgerRead =
            /^\s*SELECT/i.test(statement) &&
            /FROM plugin_workload_sdk_spend_outcomes/i.test(statement)
          if (isLedgerRead) {
            ledgerReadCount += 1
            if (ledgerReadCount === 1 && result.rows.length === 0) {
              initialLedgerRead.resolve()
              await releaseInitialLedgerRead.promise
            }
          }
          if (
            /INSERT INTO plugin_workload_sdk_spend_outcomes/i.test(statement) &&
            /ON CONFLICT \(provider_attempt_id\) DO NOTHING/i.test(statement)
          ) {
            conflictInsertRowCount = result.rowCount
          }
          return result
        },
      }

      await begin(finalizerClient)
      const finalizationPromise = finalizePromptBridgeInTransaction(input, finalizerDb)

      // This barrier proves the finalizer completed its initial empty read
      // before the sweeper commits. Releasing it earlier would let the first
      // read observe the committed outcome and bypass the ON CONFLICT branch.
      await initialLedgerRead.promise
      await commit(sweeperClient)
      releaseInitialLedgerRead.resolve()

      const result = await finalizationPromise
      await commit(finalizerClient)

      expect(result).toMatchObject({
        status: 'provider_unavailable',
        outcome: 'unknown',
        idempotent: true,
        usageAccepted: false,
      })
      expect(ledgerReadCount).toBe(2)
      expect(conflictInsertRowCount).toBe(0)

      const count = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE provider_attempt_id = $1`,
        [input.providerAttemptId]
      )
      expect(count.rows[0]?.count).toBe(1)
    } finally {
      await Promise.all([
        sweeperClient.query('ROLLBACK').catch(() => undefined),
        finalizerClient.query('ROLLBACK').catch(() => undefined),
      ])
      seedClient.release()
      sweeperClient.release()
      finalizerClient.release()
    }
  })

  it('records exact usage and projects it once; an identical replay does not bill twice', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { status: 'complete' })
      const first = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)

      expect(first).toMatchObject({
        status: 'complete',
        outcome: 'exact',
        idempotent: false,
        usageAccepted: true,
      })

      const replayClient = await dbPool.connect()
      try {
        await begin(replayClient)
        const replay = await finalizePromptBridgeInTransaction(input, replayClient)
        await commit(replayClient)
        expect(replay).toMatchObject({
          status: 'complete',
          outcome: 'exact',
          idempotent: true,
          usageAccepted: true,
        })
      } finally {
        replayClient.release()
      }

      const counts = await dbPool.query(
        `SELECT
            (SELECT count(*) FROM plugin_workload_sdk_spend_outcomes WHERE provider_attempt_id = $1::uuid)::int AS spend_count,
            (SELECT count(*) FROM usage_events WHERE request_id = $1::uuid)::int AS usage_count,
            (SELECT count(*) FROM agent_run_events WHERE source_event_id = $1::text)::int AS trace_count,
            (SELECT count(*) FROM governed_event_stream stream
               JOIN agent_run_events event ON event.event_id = stream.event_id
              WHERE event.source_event_id = $1::text)::int AS stream_count`,
        [input.providerAttemptId]
      )
      expect(counts.rows[0]).toEqual({
        spend_count: 1,
        usage_count: 1,
        trace_count: 1,
        stream_count: 1,
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('records a proven pre-provider failure as not_executed and keeps it idempotent', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { status: 'failed' })
      input.reason = 'integration_credential_resolution_failed'
      const first = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)
      expect(first).toMatchObject({ status: 'failed', outcome: 'not_executed', idempotent: false })

      const state = await dbPool.query(
        `SELECT inv.status AS invocation_status,
                receipt.status AS receipt_status,
                attempt.status AS provider_status,
                outcome.outcome
           FROM plugin_workload_sdk_invocations inv
           JOIN plugin_workload_sdk_invocation_attempts receipt ON receipt.invocation_id = inv.id
           JOIN plugin_workload_sdk_provider_attempts attempt ON attempt.id = $1
           JOIN plugin_workload_sdk_spend_outcomes outcome ON outcome.provider_attempt_id = $1
          WHERE inv.id = $2`,
        [input.providerAttemptId, input.invocationId]
      )
      expect(state.rows[0]).toEqual({
        invocation_status: 'failed',
        receipt_status: 'failed',
        provider_status: 'failed',
        outcome: 'not_executed',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('contains stale-sweeper/finalizer interleaving without a raw 500 or duplicate spend row', async () => {
    const seedClient = await dbPool.connect()
    const finalizerClient = await dbPool.connect()
    const sweeperClient = await dbPool.connect()
    try {
      await begin(seedClient)
      const input = await seedAttempt(seedClient, {
        status: 'provider_unavailable',
        leaseExpired: true,
      })
      await commit(seedClient)
      await Promise.all([begin(finalizerClient), begin(sweeperClient)])

      // Both operations contend on the invocation row lock. Do not await both
      // before committing: the loser cannot finish until the winner releases
      // its lock, so Promise.allSettled followed by two commits deadlocks the
      // test itself. Commit/rollback the first completed transaction, then
      // await the contender and release its transaction as well.
      const finalizerPromise = finalizePromptBridgeInTransaction(input, finalizerClient)
        .then(result => ({ kind: 'finalizer' as const, status: 'fulfilled' as const, result }))
        .catch(reason => ({ kind: 'finalizer' as const, status: 'rejected' as const, reason }))
      const sweeperPromise = failStaleInvocationsInTransaction(1, sweeperClient)
        .then(result => ({ kind: 'sweeper' as const, status: 'fulfilled' as const, result }))
        .catch(reason => ({ kind: 'sweeper' as const, status: 'rejected' as const, reason }))

      const first = await Promise.race([finalizerPromise, sweeperPromise])
      const release = async (winner: typeof first, client: PoolClient): Promise<void> => {
        if (winner.status === 'fulfilled') await commit(client)
        else await client.query('ROLLBACK')
      }
      if (first.kind === 'finalizer') await release(first, finalizerClient)
      else await release(first, sweeperClient)

      const second = first.kind === 'finalizer' ? await sweeperPromise : await finalizerPromise
      if (second.kind === 'finalizer') await release(second, finalizerClient)
      else await release(second, sweeperClient)

      const results = [first, second]
      expect(results.some(result => result.status === 'fulfilled')).toBe(true)
      const sweeperResult = results.find(result => result.kind === 'sweeper')!
      expect(sweeperResult.status).toBe('fulfilled')
      if (sweeperResult.status === 'rejected') throw sweeperResult.reason
      for (const result of results) {
        if (result.status === 'rejected' && result.kind === 'finalizer') {
          expect(result.reason).toBeInstanceOf(PromptBridgeFinalizationError)
          expect((result.reason as PromptBridgeFinalizationError).httpStatus).toBe(409)
        }
      }

      const count = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE provider_attempt_id = $1`,
        [input.providerAttemptId]
      )
      expect(count.rows[0]?.count).toBe(1)
    } finally {
      await Promise.all([
        finalizerClient.query('ROLLBACK').catch(() => undefined),
        sweeperClient.query('ROLLBACK').catch(() => undefined),
      ])
      seedClient.release()
      finalizerClient.release()
      sweeperClient.release()
    }
  })

  it('does not freeze oauth spend while a linked Codex attempt is still in flight', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { leaseExpired: true })
      await client.query(
        `UPDATE plugin_workload_sdk_provider_attempts
            SET provider = 'codex-subscription',
                model = 'gpt-5.1',
                credential_slot = '',
                target_ref = 'primary-codex'
          WHERE id = $1`,
        [input.providerAttemptId]
      )
      await insertLlmProviderAttempt(client, {
        callerKind: 'recipe',
        hostRef: input.hostRef,
        recipeNamespace: input.recipeNamespace,
        recipeName: input.recipeName,
        invocationId: input.invocationId,
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        model: 'gpt-5.1',
        requestHash: 'a'.repeat(64),
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
        budgetReservationId: randomUUID(),
        connectionRevision: 1,
        pluginWorkloadSdkProviderAttemptId: input.providerAttemptId,
      })
      const closed = await failStaleInvocationsInTransaction(1, client)
      await commit(client)

      expect(closed).toBe(0)
      const spend = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE provider_attempt_id = $1`,
        [input.providerAttemptId]
      )
      expect(spend.rows[0]?.count).toBe(0)
      const invocation = await dbPool.query(
        `SELECT status FROM plugin_workload_sdk_invocations WHERE id = $1`,
        [input.invocationId]
      )
      expect(invocation.rows[0]?.status).toBe('in_progress')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })
})
