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

/**
 * Every transaction in this suite runs as the PRODUCTION runtime role, not as
 * the superuser that creates the database. `plugin_workload_sdk_spend_outcomes`
 * is granted SELECT/INSERT only (access profile `append`), so a write outside
 * that envelope raises 42501 and fails the test. Running these paths as a
 * superuser is exactly how an UPDATE against the spend ledger shipped green.
 *
 * `SET LOCAL` is transaction-scoped, so a pooled connection can never leak the
 * role into a later checkout, and `CREATE DATABASE` / `initDb` / `DROP
 * DATABASE` stay superuser.
 */
async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN')
  await client.query('SET LOCAL ROLE control_api_runtime')
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

  const CODEX_TARGET = {
    targetRef: 'primary-codex',
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    credentialSlot: '',
  }
  const OPENAI_TARGET = {
    targetRef: 'primary-openai',
    provider: 'openai',
    model: 'gpt-4o-mini',
    credentialSlot: 'openai-api-key',
  }

  async function seedAttempt(
    client: PoolClient,
    options: {
      status?: PromptBridgeFinalizationInput['status']
      leaseExpired?: boolean
      codex?: boolean
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
    const target = options.codex ? { ...CODEX_TARGET } : { ...OPENAI_TARGET }
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

  /** Link a Codex ledger row to an SDK attempt, optionally already usage-ready. */
  async function linkCodex(
    client: PoolClient,
    input: PromptBridgeFinalizationInput,
    options: { ready?: boolean; providerAttemptId?: string; attemptIndex?: number } = {}
  ): Promise<string> {
    const attempt = await insertLlmProviderAttempt(client, {
      callerKind: 'recipe',
      hostRef: input.hostRef,
      recipeNamespace: input.recipeNamespace,
      recipeName: input.recipeName,
      invocationId: input.invocationId,
      attemptGeneration: input.attemptGeneration,
      providerAttemptIndex: options.attemptIndex ?? input.providerAttemptIndex,
      model: CODEX_TARGET.model,
      requestHash: 'a'.repeat(64),
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      budgetReservationId: randomUUID(),
      connectionRevision: 1,
      pluginWorkloadSdkProviderAttemptId: options.providerAttemptId ?? input.providerAttemptId,
    })
    if (options.ready) await markCodexUsageReady(client, attempt.id)
    return attempt.id
  }

  /**
   * The state the Codex proxy finalize leaves behind on success. Written
   * directly because driving the whole ticket lifecycle is the dual-ledger
   * suite's job, not this one's.
   */
  async function markCodexUsageReady(
    client: PoolClient,
    codexAttemptId: string,
    tokens: [number, number] = [12, 7]
  ): Promise<void> {
    await client.query(
      `UPDATE llm_provider_attempts
          SET status = 'finalized', outcome = 'success',
              usage_input_tokens = $2, usage_output_tokens = $3, finalized_at = now()
        WHERE id = $1`,
      [codexAttemptId, tokens[0], tokens[1]]
    )
  }

  /** Insert an extra physical attempt, as a failover would have left behind. */
  async function seedPriorAttempt(
    client: PoolClient,
    input: PromptBridgeFinalizationInput,
    options: { attemptIndex: number; status: string; codex?: boolean }
  ): Promise<string> {
    const id = randomUUID()
    const target = options.codex ? CODEX_TARGET : OPENAI_TARGET
    await client.query(
      `INSERT INTO plugin_workload_sdk_provider_attempts
         (id, invocation_id, recipe_namespace, recipe_name, attempt_generation,
          attempt_index, target_ref, provider, model, credential_slot, status,
          completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        id,
        input.invocationId,
        input.recipeNamespace,
        input.recipeName,
        input.attemptGeneration,
        options.attemptIndex,
        target.targetRef,
        target.provider,
        target.model,
        target.credentialSlot,
        options.status,
      ]
    )
    return id
  }

  async function spendRows(providerAttemptId: string) {
    const result = await dbPool.query(
      `SELECT outcome, reason, input_tokens, output_tokens, usage_request_id, host_ref
         FROM plugin_workload_sdk_spend_outcomes
        WHERE provider_attempt_id = $1`,
      [providerAttemptId]
    )
    return result.rows as Array<Record<string, unknown>>
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

  it('never rewrites the sweeper floor; late Codex usage is derived at read time', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { codex: true, leaseExpired: true })
      // Out of the in-flight grace, so the sweeper is free to close it.
      const codexAttemptId = await linkCodex(client, input)
      await client.query(
        `UPDATE llm_provider_attempts SET created_at = now() - interval '30 minutes' WHERE id = $1`,
        [codexAttemptId]
      )
      expect(await failStaleInvocationsInTransaction(1, client)).toBe(1)
      await commit(client)

      expect(await spendRows(input.providerAttemptId)).toEqual([
        {
          outcome: 'unknown',
          reason: 'stale_lease',
          input_tokens: null,
          output_tokens: null,
          usage_request_id: null,
          host_ref: null,
        },
      ])

      // Codex reports its usage after the sweep.
      const usageClient = await dbPool.connect()
      try {
        await begin(usageClient)
        await markCodexUsageReady(usageClient, codexAttemptId)
        await commit(usageClient)
      } finally {
        usageClient.release()
      }

      const replayClient = await dbPool.connect()
      try {
        await begin(replayClient)
        const replay = await finalizePromptBridgeInTransaction(
          {
            ...input,
            status: 'complete',
            usage: {
              llmSecretName: '',
              callerRef: 'integration-test',
              fallbackUsed: false,
              attemptCount: 1,
              inputTokens: 99,
              outputTokens: 99,
            },
          },
          replayClient
        )
        await commit(replayClient)
        // J3: the outcome reports the derived truth...
        expect(replay).toMatchObject({ outcome: 'exact', idempotent: true, usageAccepted: false })
      } finally {
        replayClient.release()
      }

      // ...while the floor itself is byte-for-byte what the sweeper wrote.
      // An UPDATE here would have been a 42501 under the runtime role.
      expect(await spendRows(input.providerAttemptId)).toEqual([
        {
          outcome: 'unknown',
          reason: 'stale_lease',
          input_tokens: null,
          output_tokens: null,
          usage_request_id: null,
          host_ref: null,
        },
      ])
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('lets the sweeper freeze exact when the linked Codex usage already landed', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { codex: true, leaseExpired: true })
      await linkCodex(client, input, { ready: true })
      expect(await failStaleInvocationsInTransaction(1, client)).toBe(1)
      await commit(client)

      // Addendum A.4: a ready Codex row is the best floor provable without a
      // JWT, so the sweeper no longer under-reports it as unknown.
      expect(await spendRows(input.providerAttemptId)).toEqual([
        {
          outcome: 'exact',
          reason: 'stale_lease',
          input_tokens: 12,
          output_tokens: 7,
          usage_request_id: null,
          host_ref: null,
        },
      ])
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('closes a failed oauth attempt whose Codex row is ready as exact and non-revivable', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { codex: true, status: 'failed' })
      input.reason = 'provider_stream_failed'
      await linkCodex(client, input, { ready: true })
      // N-BLK-2(a): this used to persist `unknown` WITH tokens and die on
      // token_pair_check (23514 -> 500).
      const result = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)

      expect(result).toMatchObject({ status: 'failed', outcome: 'exact', idempotent: false })
      expect(await spendRows(input.providerAttemptId)).toEqual([
        {
          outcome: 'exact',
          reason: 'provider_stream_failed',
          input_tokens: 12,
          output_tokens: 7,
          usage_request_id: null,
          host_ref: input.hostRef,
        },
      ])

      // Guard 1.a: reviveFailedInvocation only matches `status = 'failed'`, so
      // persisting provider_unavailable is what stops the same idempotency key
      // from launching a second billable Codex call.
      const state = await dbPool.query(
        `SELECT inv.status AS invocation_status,
                receipt.status AS receipt_status,
                attempt.status AS provider_status
           FROM plugin_workload_sdk_invocations inv
           JOIN plugin_workload_sdk_invocation_attempts receipt
             ON receipt.invocation_id = inv.id
           JOIN plugin_workload_sdk_provider_attempts attempt ON attempt.id = $1
          WHERE inv.id = $2`,
        [input.providerAttemptId, input.invocationId]
      )
      expect(state.rows[0]).toEqual({
        invocation_status: 'provider_unavailable',
        receipt_status: 'provider_unavailable',
        provider_status: 'provider_unavailable',
      })
      const revivable = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_invocations
          WHERE id = $1 AND status = 'failed'`,
        [input.invocationId]
      )
      expect(revivable.rows[0]?.count).toBe(0)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('resolves three identical failed calls while Codex usage lands between them (N-05)', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { codex: true, status: 'failed' })
      const codexAttemptId = await linkCodex(client, input)
      await client.query(
        `UPDATE llm_provider_attempts SET status = 'finalized', outcome = 'unknown' WHERE id = $1`,
        [codexAttemptId]
      )
      const first = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)
      expect(first).toMatchObject({ outcome: 'unknown', idempotent: false })

      const usageClient = await dbPool.connect()
      try {
        await begin(usageClient)
        await markCodexUsageReady(usageClient, codexAttemptId)
        await commit(usageClient)
      } finally {
        usageClient.release()
      }

      // Before the fix the second call rewrote the row to `exact` and the third
      // then 409'd against its own predecessor. The floor is immutable now, so
      // both replays agree.
      for (const _attempt of [2, 3]) {
        const replayClient = await dbPool.connect()
        try {
          await begin(replayClient)
          const replay = await finalizePromptBridgeInTransaction(input, replayClient)
          await commit(replayClient)
          expect(replay).toMatchObject({
            status: 'failed',
            outcome: 'exact',
            idempotent: true,
            usageAccepted: false,
          })
        } finally {
          replayClient.release()
        }
      }
      expect(await spendRows(input.providerAttemptId)).toEqual([
        {
          outcome: 'unknown',
          reason: 'integration_provider_unavailable',
          input_tokens: null,
          output_tokens: null,
          usage_request_id: null,
          host_ref: input.hostRef,
        },
      ])
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('settles the attempts a successful failover displaced (RP-539-003)', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { codex: true, status: 'complete' })
      // The winner is attempt 3; 1 and 2 are the terminal attempts a
      // successful failover leaves behind and never finalizes.
      await client.query(
        `UPDATE plugin_workload_sdk_provider_attempts SET attempt_index = 3 WHERE id = $1`,
        [input.providerAttemptId]
      )
      input.providerAttemptIndex = 3
      const failedId = await seedPriorAttempt(client, input, { attemptIndex: 1, status: 'failed' })
      const unavailableId = await seedPriorAttempt(client, input, {
        attemptIndex: 2,
        status: 'provider_unavailable',
        codex: true,
      })
      await linkCodex(client, input, {
        ready: true,
        providerAttemptId: unavailableId,
        attemptIndex: 2,
      })
      await linkCodex(client, input, { ready: true, attemptIndex: 3 })

      const result = await finalizePromptBridgeInTransaction(input, client)
      await commit(client)
      expect(result).toMatchObject({ outcome: 'exact', idempotent: false })

      expect(await spendRows(failedId)).toEqual([
        {
          outcome: 'not_executed',
          reason: 'prior_attempt_failed',
          input_tokens: null,
          output_tokens: null,
          usage_request_id: null,
          host_ref: input.hostRef,
        },
      ])
      // A displaced oauth attempt whose Codex row is ready still owes exact
      // spend, even though the host never reported it.
      expect(await spendRows(unavailableId)).toEqual([
        {
          outcome: 'exact',
          reason: 'prior_attempt_provider_unavailable',
          input_tokens: 12,
          output_tokens: 7,
          usage_request_id: null,
          host_ref: input.hostRef,
        },
      ])

      // A replay is pure reads: no second row, no rewrite.
      const replayClient = await dbPool.connect()
      try {
        await begin(replayClient)
        await expect(finalizePromptBridgeInTransaction(input, replayClient)).resolves.toMatchObject(
          { idempotent: true, outcome: 'exact' }
        )
        await commit(replayClient)
      } finally {
        replayClient.release()
      }
      const total = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE invocation_id = $1`,
        [input.invocationId]
      )
      expect(total.rows[0]?.count).toBe(3)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('fails loudly when a displaced attempt is not terminal', async () => {
    const client = await dbPool.connect()
    try {
      await begin(client)
      const input = await seedAttempt(client, { status: 'complete' })
      await client.query(
        `UPDATE plugin_workload_sdk_provider_attempts SET attempt_index = 2 WHERE id = $1`,
        [input.providerAttemptId]
      )
      input.providerAttemptIndex = 2
      await seedPriorAttempt(client, input, { attemptIndex: 1, status: 'in_progress' })

      await expect(finalizePromptBridgeInTransaction(input, client)).rejects.toThrow(
        /is not terminal \(status=in_progress\); the reservation fence is broken/
      )
      await client.query('ROLLBACK')

      // The whole transaction rolled back, so no half-settled ledger survives.
      const total = await dbPool.query(
        `SELECT count(*)::int AS count
           FROM plugin_workload_sdk_spend_outcomes
          WHERE invocation_id = $1`,
        [input.invocationId]
      )
      expect(total.rows[0]?.count).toBe(0)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })
})
