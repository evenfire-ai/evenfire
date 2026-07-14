import { beforeEach, describe, expect, it, vi } from 'vitest'
// Imports AFTER vi.mock() so the service picks up the fakes.
import {
  computeNextFire,
  processMaturedSchedules,
} from '../src/services/workflowScheduleWorkerService.js'

/**
 * Tests for `workflowScheduleWorkerService.processMaturedSchedules`.
 *
 * The worker acquires a session-scoped `pg_try_advisory_lock` on a client
 * obtained via `pool.connect()`, drains matured rows from `workflow_schedules`,
 * and for each row calls `createRun()` + advances `next_fire_at`. We mock:
 *   - `pool.connect` → programmable fake client
 *   - `./workflowRunService.createRun` → spy that returns a deterministic row
 *   - `../observability/logger.js` → silent
 *   - `../observability/metrics.js` → no-op counters
 */

type LockQueryResult = { rows: Array<{ acquired: boolean }>; rowCount: number }
type AnyQueryResult = { rows: unknown[]; rowCount: number | null }
type ScheduleRow = {
  schedule_id: string
  recipe_namespace: string
  recipe_name: string
  team_id: string | null
  cron_expression: string
  timezone: string
  next_fire_at: Date
  input_template: Record<string, unknown> | null
  allowed_actors?: Array<'user' | 'autonomous' | 'scheduled'> | null
  max_duration_seconds?: number | null
  ttl_seconds_after_finished?: number | null
}

// ─── Mock state ────────────────────────────────────────────────────────────

const maturedRows: ScheduleRow[] = []
let lockAcquired = true
const updatedSchedules: Array<{ schedule_id: string; next_fire_at?: Date; enabled?: boolean }> = []
const txEvents: Array<'BEGIN' | 'COMMIT' | 'ROLLBACK'> = []
/** Test-configurable hook that can inject a failure at SELECT time. */
let selectQueryError: Error | null = null

const clientQuery = vi.fn(
  async (sql: unknown, params?: unknown[]): Promise<AnyQueryResult | LockQueryResult> => {
    const text = typeof sql === 'string' ? sql : ''

    if (/^\s*BEGIN\s*$/i.test(text)) {
      txEvents.push('BEGIN')
      return { rows: [], rowCount: null }
    }
    if (/^\s*COMMIT\s*$/i.test(text)) {
      txEvents.push('COMMIT')
      return { rows: [], rowCount: null }
    }
    if (/^\s*ROLLBACK\s*$/i.test(text)) {
      txEvents.push('ROLLBACK')
      return { rows: [], rowCount: null }
    }

    if (/pg_try_advisory_lock/i.test(text)) {
      return { rows: [{ acquired: lockAcquired }], rowCount: 1 }
    }
    if (/pg_advisory_unlock/i.test(text)) {
      return { rows: [], rowCount: 1 }
    }

    if (
      /SELECT schedule_id, recipe_namespace, recipe_name/i.test(text) &&
      /FROM workflow_schedules/i.test(text)
    ) {
      if (selectQueryError) throw selectQueryError
      // Contract assertions: the worker MUST read the denormalized policy fields
      // written by the WRC schedule sync so it can preserve runtime semantics
      // from the WorkflowRecipe CRD.
      if (!/allowed_actors/i.test(text)) {
        throw new Error('SELECT must include allowed_actors column')
      }
      if (!/max_duration_seconds/i.test(text)) {
        throw new Error('SELECT must include max_duration_seconds column')
      }
      if (!/ttl_seconds_after_finished/i.test(text)) {
        throw new Error('SELECT must include ttl_seconds_after_finished column')
      }
      if (!/team_id/i.test(text)) {
        throw new Error('SELECT must include team_id column')
      }
      const limit = Number(params?.[0] ?? 0)
      const batch = maturedRows.splice(0, limit)
      return { rows: batch, rowCount: batch.length }
    }

    if (/UPDATE workflow_schedules/i.test(text) && /enabled = FALSE/i.test(text)) {
      const scheduleId = String(params?.[0] ?? '')
      updatedSchedules.push({ schedule_id: scheduleId, enabled: false })
      return { rows: [], rowCount: 1 }
    }

    if (/UPDATE workflow_schedules/i.test(text) && /next_fire_at/i.test(text)) {
      const nextFire = params?.[0] as Date
      const scheduleId = String(params?.[1] ?? '')
      updatedSchedules.push({ schedule_id: scheduleId, next_fire_at: nextFire })
      return { rows: [], rowCount: 1 }
    }

    return { rows: [], rowCount: null }
  }
)
const clientRelease = vi.fn()
const mockConnect = vi.fn(async () => ({
  query: clientQuery,
  release: clientRelease,
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: () => mockConnect(),
  },
  withTransaction: vi.fn(),
}))

const createRunMock = vi.fn(async (input: Record<string, unknown>, _client?: unknown) => ({
  row: {
    run_id: `run-${(input.idempotency_key as string) ?? 'missing'}`,
  },
}))
vi.mock('../src/services/workflowRunService.js', () => ({
  createRun: (input: Record<string, unknown>, client?: unknown) => createRunMock(input, client),
}))

vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../src/observability/metrics.js', () => ({
  workflowScheduleWorkerRunsTotal: { inc: vi.fn() },
  workflowScheduleWorkerFiresTotal: { inc: vi.fn() },
  workflowScheduleWorkerDurationSeconds: { observe: vi.fn() },
}))

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('processMaturedSchedules', () => {
  beforeEach(() => {
    maturedRows.length = 0
    updatedSchedules.length = 0
    txEvents.length = 0
    lockAcquired = true
    selectQueryError = null
    clientQuery.mockClear()
    clientRelease.mockClear()
    mockConnect.mockClear()
    createRunMock.mockClear()
  })

  it('fires a single matured schedule, inserts a run, and advances next_fire_at', async () => {
    const fireTime = new Date('2026-04-20T09:00:00Z')
    maturedRows.push({
      schedule_id: 's-1',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'daily-report',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      next_fire_at: fireTime,
      input_template: { topic: 'hello' },
      max_duration_seconds: 900,
      ttl_seconds_after_finished: 1800,
    })

    const result = await processMaturedSchedules()

    expect(result.fired).toBe(1)
    expect(result.actorNotAllowed).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.skippedLock).toBe(false)

    expect(createRunMock).toHaveBeenCalledTimes(1)
    const createRunArg = createRunMock.mock.calls[0][0]
    expect(createRunArg.recipe_namespace).toBe('sandbox-recipes')
    expect(createRunArg.recipe_name).toBe('daily-report')
    expect(createRunArg.actor_type).toBe('scheduled')
    expect(createRunArg.team_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(createRunArg.trigger_source).toBe('schedule')
    expect(createRunArg.max_duration_seconds).toBe(900)
    expect(createRunArg.ttl_seconds_after_finished).toBe(1800)
    // Idempotency key is deterministic — same (schedule_id, fire time) → same key.
    expect(createRunArg.idempotency_key).toBe(`schedule/s-1/${fireTime.toISOString()}`)
    expect(createRunArg.inputs).toEqual({ topic: 'hello' })

    // next_fire_at was advanced exactly one cron period forward (not to "now").
    expect(updatedSchedules).toHaveLength(1)
    expect(updatedSchedules[0].schedule_id).toBe('s-1')
    expect(updatedSchedules[0].next_fire_at?.toISOString()).toBe('2026-04-21T09:00:00.000Z')

    // Lock hygiene.
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('fires a batch of matured schedules in a single sweep', async () => {
    const baseTime = new Date('2026-04-20T10:00:00Z')
    for (let i = 0; i < 3; i++) {
      maturedRows.push({
        schedule_id: `s-${i}`,
        recipe_namespace: 'sandbox-recipes',
        recipe_name: `recipe-${i}`,
        team_id: `11111111-1111-4111-8111-11111111111${i}`,
        cron_expression: '*/5 * * * *',
        timezone: 'UTC',
        next_fire_at: baseTime,
        input_template: null,
      })
    }

    const result = await processMaturedSchedules({ batchSize: 10 })

    expect(result.fired).toBe(3)
    expect(createRunMock).toHaveBeenCalledTimes(3)
    // All 3 schedules should be advanced by the same +5min window.
    expect(updatedSchedules).toHaveLength(3)
    for (const u of updatedSchedules) {
      expect(u.next_fire_at?.toISOString()).toBe('2026-04-20T10:05:00.000Z')
    }
  })

  it('skips entirely when another replica holds the advisory lock', async () => {
    lockAcquired = false
    maturedRows.push({
      schedule_id: 's-contended',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'contended',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 * * * *',
      timezone: 'UTC',
      next_fire_at: new Date('2026-04-20T09:00:00Z'),
      input_template: null,
    })

    const result = await processMaturedSchedules()

    expect(result.skippedLock).toBe(true)
    expect(result.fired).toBe(0)
    expect(result.actorNotAllowed).toBe(0)
    expect(createRunMock).not.toHaveBeenCalled()
    // No SELECT against workflow_schedules either.
    const selectCalls = clientQuery.mock.calls.filter(([sql]) =>
      /FROM workflow_schedules/i.test(String(sql))
    )
    expect(selectCalls.length).toBe(0)
    // Contended row is preserved for the next sweep.
    expect(maturedRows.length).toBe(1)
    // Client released so the pool recovers even on contention.
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })

  it('disables schedules with invalid cron expressions (no fire, no run)', async () => {
    maturedRows.push({
      schedule_id: 's-bad',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'broken',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: 'not-a-real-cron',
      timezone: 'UTC',
      next_fire_at: new Date('2026-04-20T09:00:00Z'),
      input_template: null,
    })

    const result = await processMaturedSchedules()

    expect(result.fired).toBe(0)
    expect(result.actorNotAllowed).toBe(0)
    expect(result.errors).toBe(1)
    expect(createRunMock).not.toHaveBeenCalled()
    // Schedule was disabled via UPDATE … SET enabled = FALSE.
    const disabled = updatedSchedules.find(u => u.enabled === false)
    expect(disabled?.schedule_id).toBe('s-bad')
  })

  it('keeps next_fire_at unchanged when createRun fails so the same window can retry', async () => {
    createRunMock.mockRejectedValueOnce(new Error('db write failed'))
    const fireTime = new Date('2026-04-20T09:00:00Z')
    maturedRows.push({
      schedule_id: 's-fail',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'fails',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      next_fire_at: fireTime,
      input_template: null,
    })

    const result = await processMaturedSchedules()

    expect(result.fired).toBe(0)
    expect(result.actorNotAllowed).toBe(0)
    expect(result.errors).toBe(1)
    expect(createRunMock).toHaveBeenCalledTimes(1)
    // Preserve the current slot for retry; dropping the window would lose a run.
    expect(updatedSchedules).toHaveLength(0)
  })

  it("skips fire when allowed_actors is set and does not include 'scheduled'", async () => {
    // Recipe sets spec.triggers.onDemand.allowedActors = ['user'], denormalized
    // into workflow_schedules.allowed_actors. The worker MUST refuse to create
    // a run but SHOULD still advance next_fire_at so the same window does not
    // re-queue forever.
    const fireTime = new Date('2026-04-20T09:00:00Z')
    maturedRows.push({
      schedule_id: 's-gated',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'user-only',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      next_fire_at: fireTime,
      input_template: null,
      allowed_actors: ['user'],
    })

    const result = await processMaturedSchedules()

    expect(result.fired).toBe(0)
    expect(result.actorNotAllowed).toBe(1)
    // Policy-driven skip is NOT an error — dashboards would otherwise page
    // on intentional configuration.
    expect(result.errors).toBe(0)
    expect(createRunMock).not.toHaveBeenCalled()
    // next_fire_at was advanced so the policy-blocked window doesn't keep
    // re-matching the SELECT predicate on every sweep.
    expect(updatedSchedules).toHaveLength(1)
    expect(updatedSchedules[0].schedule_id).toBe('s-gated')
    expect(updatedSchedules[0].next_fire_at?.toISOString()).toBe('2026-04-21T09:00:00.000Z')
  })

  it("fires normally when allowed_actors explicitly includes 'scheduled'", async () => {
    const fireTime = new Date('2026-04-20T09:00:00Z')
    maturedRows.push({
      schedule_id: 's-scheduled-ok',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'cron-allowed',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      next_fire_at: fireTime,
      input_template: null,
      allowed_actors: ['user', 'scheduled'],
    })

    const result = await processMaturedSchedules()

    expect(result.fired).toBe(1)
    expect(result.actorNotAllowed).toBe(0)
    expect(createRunMock).toHaveBeenCalledTimes(1)
  })

  it('rolls back the whole batch transaction when the SELECT query fails', async () => {
    // "All-or-nothing" batch semantic: if the transaction-level query throws
    // (lost connection, deadlock, etc.), the worker must issue ROLLBACK and
    // propagate the error so the outer sweep can record it and release the
    // advisory lock. No partial side-effects may leak.
    selectQueryError = new Error('connection reset by peer')
    // Push rows that WOULD be fired if the SELECT had succeeded; they must
    // NOT be processed on this sweep.
    maturedRows.push({
      schedule_id: 's-lost-1',
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'rolled-back',
      team_id: '11111111-1111-4111-8111-111111111111',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      next_fire_at: new Date('2026-04-20T09:00:00Z'),
      input_template: null,
    })

    await expect(processMaturedSchedules()).rejects.toThrow('connection reset by peer')

    // Contract: BEGIN must precede the failed SELECT, ROLLBACK must follow it,
    // COMMIT must NOT appear between them.
    expect(txEvents[0]).toBe('BEGIN')
    expect(txEvents).toContain('ROLLBACK')
    expect(txEvents).not.toContain('COMMIT')
    expect(createRunMock).not.toHaveBeenCalled()
    expect(updatedSchedules).toHaveLength(0)
    // Lock is still released even though the batch threw — otherwise the next
    // sweep would skip forever.
    expect(clientRelease).toHaveBeenCalledTimes(1)
  })
})

describe('computeNextFire', () => {
  it('advances by one cron period relative to the from timestamp, not to now()', () => {
    const fromBehind = new Date('2026-04-20T08:59:59Z')
    // "0 9 * * *" UTC should fire at 09:00 UTC.
    const next = computeNextFire('0 9 * * *', 'UTC', fromBehind)
    expect(next.toISOString()).toBe('2026-04-20T09:00:00.000Z')
  })

  it('honors IANA timezone for DST-sensitive schedules', () => {
    // 09:00 America/New_York during EDT (UTC-4) = 13:00 UTC.
    const from = new Date('2026-04-20T08:00:00Z')
    const next = computeNextFire('0 9 * * *', 'America/New_York', from)
    expect(next.toISOString()).toBe('2026-04-20T13:00:00.000Z')
  })

  it('defaults to UTC when timezone is an empty string', () => {
    const from = new Date('2026-04-20T10:15:00Z')
    const next = computeNextFire('30 10 * * *', '', from)
    expect(next.toISOString()).toBe('2026-04-20T10:30:00.000Z')
  })
})
