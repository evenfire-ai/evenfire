import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb } from '../src/db.js'
import {
  type LlmProviderAttemptInsert,
  insertLlmProviderAttempt,
  registerLlmProviderAttemptTicket,
} from '../src/services/llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from '../src/services/llmProviderAttemptTicket.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function attemptInput(overrides: Partial<LlmProviderAttemptInsert> = {}): LlmProviderAttemptInsert {
  return {
    callerKind: 'recipe',
    hostRef: 'research-host',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'prompt-notify',
    invocationId: `invocation-${randomUUID()}`,
    attemptGeneration: 1,
    providerAttemptIndex: 1,
    model: 'gpt-5.4',
    requestHash: 'c'.repeat(64),
    policyRevision: 7,
    policyHash: 'policy-hash',
    budgetReservationId: 'reservation-1',
    connectionRevision: 3,
    ...overrides,
  }
}

describeRealPostgres('LLM provider-attempt ledger on real PostgreSQL', () => {
  const database = `llm_provider_attempt_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pool = new Pool({ connectionString })
    await initDb({ connect: () => pool.connect() })
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (adminPool) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
        .catch(() => undefined)
      await adminPool.end()
    }
  })

  it('creates the attempt and ticket tables without raw prompt, token, or ticket columns', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [['llm_provider_attempt_tickets', 'llm_provider_attempts']]
    )
    expect(tables.rows.map(row => row.table_name)).toEqual([
      'llm_provider_attempt_tickets',
      'llm_provider_attempts',
    ])

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [['llm_provider_attempt_tickets', 'llm_provider_attempts']]
    )
    const names = columns.rows.map(row => row.column_name)
    expect(names).toEqual(
      expect.arrayContaining(['host_ref', 'request_hash', 'jti', 'receipt_hash'])
    )
    expect(names.join(',')).not.toMatch(
      /prompt|completion|access_token|refresh_token|execution_ticket|authorization|cookie|header/i
    )
  })

  it('keeps attempt bindings immutable and rejects a duplicate invocation winner', async () => {
    const input = attemptInput({ invocationId: 'shared-invocation' })
    const first = await insertLlmProviderAttempt(pool, input)
    await expect(insertLlmProviderAttempt(pool, input)).rejects.toThrow(/duplicate|unique/i)

    const [winner, loser] = await Promise.allSettled([
      insertLlmProviderAttempt(pool, { ...input, providerAttemptIndex: 2 }),
      insertLlmProviderAttempt(pool, { ...input, providerAttemptIndex: 2 }),
    ])
    const fulfilled = [winner, loser].filter(result => result.status === 'fulfilled')
    const rejected = [winner, loser].filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const stored = await pool.query<{ model: string; request_hash: string }>(
      `SELECT model, request_hash FROM llm_provider_attempts WHERE id = $1`,
      [first.id]
    )
    expect(stored.rows[0]).toEqual({ model: 'gpt-5.4', request_hash: 'c'.repeat(64) })
  })

  it('registers jti before returning the JWT and lets only one concurrent jti win', async () => {
    const attempt = await insertLlmProviderAttempt(pool, attemptInput())
    const issued = await issueRegisteredCodexExecutionTicket(pool, {
      sub: 'host/research-host',
      hostRef: attempt.hostRef,
      recipeNamespace: attempt.recipeNamespace ?? undefined,
      recipeName: attempt.recipeName ?? undefined,
      invocationId: attempt.invocationId,
      attemptGeneration: attempt.attemptGeneration,
      providerAttemptId: attempt.id,
      providerAttemptIndex: attempt.providerAttemptIndex,
      model: attempt.model,
      requestHash: attempt.requestHash,
      policyRevision: attempt.policyRevision,
      policyHash: attempt.policyHash,
      budgetReservationId: attempt.budgetReservationId,
      connectionRevision: attempt.connectionRevision,
    })

    const ticketRow = await pool.query<{ jti: string; status: string; execution_ticket?: string }>(
      `SELECT jti::text, status FROM llm_provider_attempt_tickets WHERE jti = $1`,
      [issued.claims.jti]
    )
    expect(ticketRow.rows).toEqual([{ jti: issued.claims.jti, status: 'issued' }])
    expect(JSON.stringify(ticketRow.rows[0])).not.toContain(issued.executionTicket)

    const duplicateJti = randomUUID()
    const expiresAt = new Date(Date.now() + 60_000)
    const [firstJti, secondJti] = await Promise.allSettled([
      registerLlmProviderAttemptTicket(pool, {
        jti: duplicateJti,
        providerAttemptId: attempt.id,
        expiresAt,
      }),
      registerLlmProviderAttemptTicket(pool, {
        jti: duplicateJti,
        providerAttemptId: attempt.id,
        expiresAt,
      }),
    ])
    const jtiWins = [firstJti, secondJti].filter(result => result.status === 'fulfilled')
    const jtiLosses = [firstJti, secondJti].filter(result => result.status === 'rejected')
    expect(jtiWins).toHaveLength(1)
    expect(jtiLosses).toHaveLength(1)
  })
})
