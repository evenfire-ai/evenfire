import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Pool } from 'pg'
import { type DbClient, initDb, withTransaction } from '../src/db.js'
import { reserveInDangerZone } from '../src/services/budgets/reservations.js'
import { insertLlmProviderAttempt } from '../src/services/llmProviderAttemptStore.js'
import {
  createPostgresCommitReplyBlackhole,
  createPostgresDisconnectBlackhole,
} from './helpers/realPostgresCancellation.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
if (process.env.CONTROL_API_REAL_PG_REQUIRED === '1' && !adminUrl) {
  throw new Error('physical cancellation tests require CONTROL_API_REAL_PG_ADMIN_URL')
}
const realPostgres = adminUrl ? describe : describe.skip

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function observe(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('physical PostgreSQL cleanup did not complete')
    await nextTurn()
  }
}

// Mechanism proof uses real schema/helpers but bypasses authorize and signing.
// Full authorization cancellation lives in services.llmProviderAttemptAuthorization.
realPostgres('scoped transaction cancellation mechanism and durable outcome', () => {
  const database = `authorize_cancel_${randomBytes(6).toString('hex')}`
  let admin: Pool
  let observer: Pool
  let pool: Pool
  let connectionString: string
  let budgetId: string

  beforeAll(async () => {
    admin = new Pool({
      connectionString: adminUrl,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 15_000,
    })
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    connectionString = url.toString()
    pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 15_000,
      idleTimeoutMillis: 1_000,
    })
    observer = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 2_000,
      idleTimeoutMillis: 1_000,
    })
    const runtime = await pool.query<{ version: string; version_num: string }>(
      "SELECT version(), current_setting('server_version_num') AS version_num"
    )
    expect(Number(runtime.rows[0].version_num)).toBeGreaterThanOrEqual(160000)
    expect(Number(runtime.rows[0].version_num)).toBeLessThan(170000)
    expect(runtime.rows[0].version).toMatch(/linux|darwin|bsd|illumos/i)
    await initDb({ connect: () => pool.connect() })
    const budget = await pool.query<{ id: string }>(
      `INSERT INTO token_budgets (name, unit, limit_amount, period, max_task_amount)
       VALUES ('cancellation fixture', 'tokens', 100, 'daily', 4) RETURNING id`
    )
    budgetId = budget.rows[0].id
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(pool)
      await endPoolAndWaitForClients(observer)
      if (admin) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await admin?.end()
    }
  })

  async function writeAuthorizeRows(db: DbClient, invocationId: string) {
    const reservation = await reserveInDangerZone(
      {
        budgetId,
        limit: 100,
        spent: 95,
        minStart: 1,
        estAmount: 4,
        taskRef: invocationId,
        hostRef: 'cancel-host',
      },
      undefined,
      db
    )
    expect(reservation.decision).toBe('allow')
    if (reservation.decision !== 'allow') throw new Error('fixture reservation denied')
    const attempt = await insertLlmProviderAttempt(db, {
      callerKind: 'host',
      hostRef: 'cancel-host',
      recipeNamespace: null,
      recipeName: null,
      invocationId,
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      model: 'gpt-5.1',
      requestHash: 'a'.repeat(64),
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      budgetReservationId: reservation.reservationId,
      connectionRevision: 1,
      connectionId: null,
    })
    await db.query(
      `INSERT INTO llm_provider_attempt_tickets (jti, provider_attempt_id, status, expires_at)
       VALUES ($1, $2, 'issued', NOW() + INTERVAL '1 minute')`,
      [randomUUID(), attempt.id]
    )
  }

  async function rowCounts(invocationId: string) {
    const result = await observer.query<{
      attempts: number
      tickets: number
      reservations: number
    }>(
      `SELECT
        (SELECT COUNT(*)::int FROM llm_provider_attempts WHERE invocation_id = $1) AS attempts,
        (SELECT COUNT(*)::int FROM llm_provider_attempt_tickets t JOIN llm_provider_attempts a
          ON t.provider_attempt_id = a.id WHERE a.invocation_id = $1) AS tickets,
        (SELECT COUNT(*)::int FROM budget_pending_reservations WHERE task_ref = $1) AS reservations`,
      [invocationId]
    )
    return result.rows[0]
  }

  async function backendGone(pid: number) {
    await observe(async () => {
      const result = await observer.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE pid = $1 AND datname = $2',
        [pid, database]
      )
      return result.rows[0].count === 0
    })
  }

  async function lockAvailable(lock: number) {
    await withTransaction(async db => {
      const result = await db.query('SELECT pg_try_advisory_xact_lock($1) AS available', [lock])
      expect((result.rows[0] as { available: boolean }).available).toBe(true)
    }, observer)
  }

  it.each(['active', 'idle'] as const)(
    'ends the %s backend, releases writer locks and rolls attempt/ticket/reservation back before COMMIT',
    async mode => {
      const invocationId = randomUUID()
      const lock = mode === 'active' ? 806301 : 806302
      const entered = deferred<number>()
      const controller = new AbortController()
      const reason = Object.assign(new Error('authorize_aborted'), { code: 'authorize_aborted' })
      const outcome = withTransaction(
        async db => {
          const identity = await db.query('SELECT pg_backend_pid() AS pid')
          await writeAuthorizeRows(db, invocationId)
          await db.query('SELECT pg_advisory_xact_lock($1)', [lock])
          entered.resolve((identity.rows[0] as { pid: number }).pid)
          if (mode === 'active') await db.query('SELECT pg_sleep(30)')
          else await once(controller.signal, 'abort')
        },
        pool,
        { signal: controller.signal }
      ).then(
        value => ({ value }),
        error => ({ error })
      )
      const pid = await entered.promise
      await observe(async () => {
        const result = await observer.query<{ state: string; query: string }>(
          'SELECT state, query FROM pg_stat_activity WHERE pid = $1',
          [pid]
        )
        return mode === 'active'
          ? result.rows[0]?.state === 'active' && result.rows[0]?.query === 'SELECT pg_sleep(30)'
          : result.rows[0]?.state === 'idle in transaction'
      })
      controller.abort(reason)
      expect(((await outcome) as { error: unknown }).error).toBe(reason)
      expect(pool.totalCount).toBe(0)
      await backendGone(pid)
      await lockAvailable(lock)
      expect(await rowCounts(invocationId)).toEqual({ attempts: 0, tickets: 0, reservations: 0 })

      // The same physical writes still commit normally after cancellation.
      const later = randomUUID()
      await withTransaction(db => writeAuthorizeRows(db, later), pool)
      expect(await rowCounts(later)).toEqual({ attempts: 1, tickets: 1, reservations: 1 })
      await pool.query('DELETE FROM budget_pending_reservations WHERE task_ref = $1', [later])
    },
    10_000
  )

  it('retains a committed attempt/reservation when a real COMMIT reply is lost; cancellation is not rollback proof', async () => {
    const proxy = await createPostgresCommitReplyBlackhole(connectionString)
    const uncertainPool = new Pool({
      connectionString: proxy.connectionString,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 15_000,
    })
    const invocationId = randomUUID()
    const controller = new AbortController()
    const reason = Object.assign(new Error('authorize_timeout'), { code: 'authorize_timeout' })
    try {
      const outcome = withTransaction(db => writeAuthorizeRows(db, invocationId), uncertainPool, {
        signal: controller.signal,
      }).then(
        value => ({ value }),
        error => ({ error })
      )
      await proxy.commitForwarded
      await observe(async () => (await rowCounts(invocationId)).attempts === 1)
      controller.abort(reason)
      expect(((await outcome) as { error: unknown }).error).toBe(reason)
      expect(await rowCounts(invocationId)).toEqual({ attempts: 1, tickets: 1, reservations: 1 })
      expect(uncertainPool.totalCount).toBe(0)
    } finally {
      controller.abort(reason)
      proxy.allowReplies()
      await endPoolAndWaitForClients(uncertainPool)
      await proxy.close()
    }
  }, 10_000)
  it.each(['idle', 'active-then-aborted'] as const)(
    'bounds the remote %s transaction after local cleanup when a protocol blackhole hides both replies and disconnects',
    async mode => {
      const proxy = await createPostgresDisconnectBlackhole(connectionString)
      const isolated = new Pool({
        connectionString: proxy.connectionString,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 2_000,
        statement_timeout: 2_000,
        options: '-c idle_in_transaction_session_timeout=0',
      })
      const invocationId = randomUUID()
      const lock = mode === 'idle' ? 806303 : 806304
      const entered = deferred<number>()
      const controller = new AbortController()
      const reason = Object.assign(new Error('authorize_timeout'), { code: 'authorize_timeout' })
      try {
        const outcome = withTransaction(
          async db => {
            const identity = await db.query('SELECT pg_backend_pid() AS pid')
            const setting = await db.query(
              "SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'"
            )
            expect((setting.rows[0] as { setting: string }).setting).toBe('2000')
            await writeAuthorizeRows(db, invocationId)
            await db.query('SELECT pg_advisory_xact_lock($1)', [lock])
            entered.resolve((identity.rows[0] as { pid: number }).pid)
            if (mode === 'active-then-aborted') await db.query('SELECT pg_sleep(30)')
            else await once(controller.signal, 'abort')
          },
          isolated,
          { signal: controller.signal }
        ).then(
          value => ({ value }),
          error => ({ error })
        )
        const pid = await Promise.race([
          entered.promise,
          outcome.then(early => {
            if ('error' in early) throw early.error
            throw new Error('transaction ended before the physical fixture was ready')
          }),
        ])
        const backendState = async () => {
          const result = await observer.query<{ state: string; query: string }>(
            'SELECT state, query FROM pg_stat_activity WHERE pid = $1 AND datname = $2',
            [pid, database]
          )
          return result.rows[0]
        }
        await observe(async () => {
          const backend = await backendState()
          return mode === 'idle'
            ? backend?.state === 'idle in transaction'
            : backend?.state === 'active' && backend.query === 'SELECT pg_sleep(30)'
        })
        proxy.dropRepliesAndDisconnects()
        controller.abort(reason)
        expect(((await outcome) as { error: unknown }).error).toBe(reason)
        expect(isolated.totalCount).toBe(0)
        await observe(async () => proxy.suppressedDisconnects > 0)
        // Local completion cannot establish remote cleanup. The backend still
        // exists with its socket held by the fault proxy, independently observed.
        expect(await backendState()).toBeDefined()
        if (mode === 'active-then-aborted') {
          // The server statement timeout first enters TRANS_ABORT. A SET LOCAL
          // idle limit would have reverted to zero here and leave this backend
          // alive indefinitely; the pre-BEGIN session backstop must remain.
          await observe(
            async () => (await backendState())?.state === 'idle in transaction (aborted)',
            4_000
          )
          expect(proxy.discardedReplyBytes).toBeGreaterThan(0)
        }
        await observe(async () => !(await backendState()), 6_000)
        await lockAvailable(lock)
        expect(await rowCounts(invocationId)).toEqual({ attempts: 0, tickets: 0, reservations: 0 })
        proxy.allowReplies()

        // With max one, a fresh physical backend still serves and commits the
        // real writer after both the local checkout and remote backend ended.
        const later = randomUUID()
        await withTransaction(db => writeAuthorizeRows(db, later), isolated, {
          signal: new AbortController().signal,
        })
        expect(await rowCounts(later)).toEqual({ attempts: 1, tickets: 1, reservations: 1 })
        await pool.query('DELETE FROM budget_pending_reservations WHERE task_ref = $1', [later])
      } finally {
        controller.abort(reason)
        proxy.allowReplies()
        await endPoolAndWaitForClients(isolated)
        await proxy.close()
      }
    },
    20_000
  )
})
