import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootLogger } from '../src/observability/logger.js'
import {
  workflowScheduleWorkerConcurrencyForbiddenSustainedTotal,
  workflowScheduleWorkerFiresTotal,
} from '../src/observability/metrics.js'
// Imports AFTER vi.mock() so the service picks up the fakes.
import {
  FORBID_PENDING_ACTIVE_BOUND_SECONDS,
  FORBID_RUNNING_GRACE_SECONDS,
  FORBID_RUNNING_MAX_DURATION_CAP_SECONDS,
  FORBID_SUSTAINED_SKIP_THRESHOLD,
  computeNextFire,
  processMaturedSchedules,
  resetConcurrencyForbiddenStreaksForTests,
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
  concurrency_policy?: 'Forbid' | 'Replace' | 'Allow' | null
}

// ─── Mock state ────────────────────────────────────────────────────────────

const maturedRows: ScheduleRow[] = []
let lockAcquired = true
const updatedSchedules: Array<{ schedule_id: string; next_fire_at?: Date; enabled?: boolean }> = []
const txEvents: Array<'BEGIN' | 'COMMIT' | 'ROLLBACK'> = []
/** Test-configurable hook that can inject a failure at SELECT time. */
let selectQueryError: Error | null = null

/** Non-terminal workflow_runs keyed by `${recipe_namespace}/${recipe_name}`. */
type FakeRun = {
  run_id: string
  phase: 'Pending' | 'Running'
  created_at: Date
  started_at: Date | null
  max_duration_seconds: number | null
}
const activeRuns = new Map<string, FakeRun>()
/** Test-configurable hook that can inject a failure into the active-run lookup. */
let activeRunQueryError: Error | null = null

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
      if (!/concurrency_policy/i.test(text)) {
        throw new Error('SELECT must include concurrency_policy column')
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

    if (/FROM workflow_runs/i.test(text)) {
      if (activeRunQueryError) throw activeRunQueryError
      if (!/phase = 'Pending'/.test(text) || !/phase = 'Running'/.test(text)) {
        throw new Error('active-run lookup must filter on non-terminal phases')
      }
      const run = activeRuns.get(`${String(params?.[0])}/${String(params?.[1])}`)
      if (!run) return { rows: [], rowCount: 0 }
      // Minimal emulation of the stale-run bounds ($3 Pending bound, $4 cap,
      // $5 grace) so the worker's wiring is exercised. The SQL semantics are
      // proven against real Postgres in
      // services.workflowScheduleForbid.realPostgres.integration.test.ts.
      const [pendingBound, cap, grace] = [
        Number(params?.[2]),
        Number(params?.[3]),
        Number(params?.[4]),
      ]
      const now = Date.now()
      const live =
        run.phase === 'Pending'
          ? run.created_at.getTime() > now - pendingBound * 1000
          : (run.started_at ?? run.created_at).getTime() >
            now - (Math.min(run.max_duration_seconds ?? cap, cap) + grace) * 1000
      if (!live) return { rows: [], rowCount: 0 }
      const { run_id, phase, created_at, started_at } = run
      return { rows: [{ run_id, phase, created_at, started_at }], rowCount: 1 }
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
  workflowScheduleWorkerConcurrencyForbiddenSustainedTotal: { inc: vi.fn() },
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
    activeRuns.clear()
    activeRunQueryError = null
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

  describe('concurrencyPolicy', () => {
    const teamId = '11111111-1111-4111-8111-111111111111'
    const NOW = new Date('2026-04-20T09:00:05Z')
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

    function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
      return {
        schedule_id: 's-forbid',
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'pr-review',
        team_id: teamId,
        cron_expression: '*/5 * * * *',
        timezone: 'UTC',
        next_fire_at: new Date('2026-04-20T09:00:00Z'),
        input_template: null,
        concurrency_policy: 'Forbid',
        ...overrides,
      }
    }

    function setActiveRun(overrides: Partial<FakeRun> = {}, key = 'sandbox-recipes/pr-review') {
      activeRuns.set(key, {
        run_id: 'run-active',
        phase: 'Running',
        created_at: minutesAgo(3),
        started_at: minutesAgo(2),
        max_duration_seconds: null,
        ...overrides,
      })
    }

    function activeRunLookups(): unknown[][] {
      return clientQuery.mock.calls
        .filter(([sql]) => /FROM workflow_runs/i.test(String(sql)))
        .map(([, params]) => (params ?? []) as unknown[])
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      resetConcurrencyForbiddenStreaksForTests()
      vi.mocked(rootLogger.info).mockClear()
      vi.mocked(rootLogger.warn).mockClear()
      vi.mocked(workflowScheduleWorkerFiresTotal.inc).mockClear()
      vi.mocked(workflowScheduleWorkerConcurrencyForbiddenSustainedTotal.inc).mockClear()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('skips the tick under Forbid while a Running run of the recipe exists, records the reason, and advances', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(0)
      expect(result.concurrencyForbidden).toBe(1)
      expect(result.actorNotAllowed).toBe(0)
      expect(result.errors).toBe(0)
      expect(createRunMock).not.toHaveBeenCalled()
      expect(updatedSchedules).toEqual([
        { schedule_id: 's-forbid', next_fire_at: new Date('2026-04-20T09:05:00.000Z') },
      ])
      expect(workflowScheduleWorkerFiresTotal.inc).toHaveBeenCalledWith(
        { result: 'concurrency_forbidden' },
        1
      )
      expect(rootLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'workflow_schedule_worker_concurrency_forbidden',
          scheduleId: 's-forbid',
          recipe: 'sandbox-recipes/pr-review',
          activeRunId: 'run-active',
          activeRunPhase: 'Running',
          activeRunAgeSeconds: 120,
          consecutiveSkips: 1,
          skippedFireAt: '2026-04-20T09:00:00.000Z',
          nextFireAt: '2026-04-20T09:05:00.000Z',
        }),
        expect.any(String)
      )
      // The skip is not a fire: last_fire_at must not be stamped.
      const skipUpdate = clientQuery.mock.calls.find(([sql]) =>
        /UPDATE workflow_schedules/i.test(String(sql))
      )
      expect(String(skipUpdate?.[0])).not.toMatch(/last_fire_at/)
      expect(txEvents).toEqual(['BEGIN', 'COMMIT'])
    })

    it('emits the sweep summary log for a skip-only sweep', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow())

      await processMaturedSchedules()

      expect(rootLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'workflow_schedule_worker_run',
          fired: 0,
          errors: 0,
          concurrencyForbidden: 1,
        }),
        'schedule worker sweep complete'
      )
    })

    it('treats a fresh Pending run as active', async () => {
      setActiveRun({
        run_id: 'run-pending',
        phase: 'Pending',
        created_at: minutesAgo(1),
        started_at: null,
      })
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.concurrencyForbidden).toBe(1)
      expect(createRunMock).not.toHaveBeenCalled()
      expect(rootLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ activeRunId: 'run-pending', activeRunAgeSeconds: 60 }),
        expect.any(String)
      )
    })

    it('stops counting a Pending run as active once it is older than the Pending bound', async () => {
      // Nothing terminalises a Pending row whose child CR never got created.
      setActiveRun({ phase: 'Pending', created_at: minutesAgo(16), started_at: null })
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(1)
      expect(result.concurrencyForbidden).toBe(0)
      expect(createRunMock).toHaveBeenCalledTimes(1)
    })

    it('blocks on a Running run still inside max_duration_seconds + grace', async () => {
      // 600 s deadline passed 2 min ago, but the 5 min reaper grace has not.
      setActiveRun({ max_duration_seconds: 600, started_at: minutesAgo(12) })
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.concurrencyForbidden).toBe(1)
      expect(createRunMock).not.toHaveBeenCalled()
    })

    it('stops counting a Running run as active past max_duration_seconds + grace', async () => {
      setActiveRun({ max_duration_seconds: 600, started_at: minutesAgo(16) })
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(1)
      expect(createRunMock).toHaveBeenCalledTimes(1)
    })

    it('bounds a Running run with no or an oversized max_duration_seconds by the 24 h cap', async () => {
      setActiveRun({ max_duration_seconds: null, started_at: minutesAgo(23 * 60) })
      maturedRows.push(scheduleRow())
      expect((await processMaturedSchedules()).concurrencyForbidden).toBe(1)

      // The CRD default (604800) exceeds the controller ceiling: clamp to the cap.
      setActiveRun({ max_duration_seconds: 604_800, started_at: minutesAgo(24 * 60 + 6) })
      maturedRows.push(scheduleRow({ next_fire_at: new Date('2026-04-20T09:05:00Z') }))
      vi.setSystemTime(new Date('2026-04-20T09:05:05Z'))
      expect((await processMaturedSchedules()).fired).toBe(1)
    })

    it('binds the named stale-run bounds into the lookup', async () => {
      maturedRows.push(scheduleRow())

      await processMaturedSchedules()

      expect(FORBID_PENDING_ACTIVE_BOUND_SECONDS).toBe(900)
      expect(FORBID_RUNNING_MAX_DURATION_CAP_SECONDS).toBe(86_400)
      expect(FORBID_RUNNING_GRACE_SECONDS).toBe(300)
      expect(activeRunLookups()).toEqual([['sandbox-recipes', 'pr-review', 900, 86_400, 300]])
      const lookupSql = String(
        clientQuery.mock.calls.find(([sql]) => /FROM workflow_runs/i.test(String(sql)))?.[0]
      )
      expect(lookupSql).toMatch(/created_at > now\(\) - make_interval\(secs => \$3\)/)
      expect(lookupSql).toMatch(
        /COALESCE\(started_at, created_at\) > now\(\) - make_interval\(secs => LEAST\(COALESCE\(max_duration_seconds, \$4\), \$4\) \+ \$5\)/
      )
    })

    it('advances past a backlog to the next future window instead of replaying it', async () => {
      // The worker was down for an hour: next_fire_at is 12 windows behind.
      setActiveRun()
      maturedRows.push(scheduleRow({ next_fire_at: new Date('2026-04-20T08:00:00Z') }))

      await processMaturedSchedules()

      // 09:05 (first window after now), not 08:05 (one step after the stale slot).
      expect(updatedSchedules[0]?.next_fire_at?.toISOString()).toBe('2026-04-20T09:05:00.000Z')
    })

    it('fires the first tick after the active run finishes', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow())

      const skipped = await processMaturedSchedules()
      expect(skipped.concurrencyForbidden).toBe(1)
      const advancedTo = updatedSchedules[0]?.next_fire_at
      expect(advancedTo?.toISOString()).toBe('2026-04-20T09:05:00.000Z')

      // The run reaches a terminal phase; the schedule matures at its new slot.
      activeRuns.clear()
      updatedSchedules.length = 0
      vi.setSystemTime(new Date('2026-04-20T09:05:02Z'))
      maturedRows.push(scheduleRow({ next_fire_at: advancedTo! }))

      const fired = await processMaturedSchedules()

      expect(fired.fired).toBe(1)
      expect(fired.concurrencyForbidden).toBe(0)
      expect(createRunMock).toHaveBeenCalledTimes(1)
      expect(createRunMock.mock.calls[0]?.[0].idempotency_key).toBe(
        'schedule/s-forbid/2026-04-20T09:05:00.000Z'
      )
      expect(updatedSchedules[0]?.next_fire_at?.toISOString()).toBe('2026-04-20T09:10:00.000Z')
    })

    it('warns once after 6 consecutive skips and restarts the streak after a fire', async () => {
      setActiveRun({ started_at: minutesAgo(1) })
      let slot = new Date('2026-04-20T09:00:00Z')
      const tick = async () => {
        vi.setSystemTime(new Date(slot.getTime() + 5_000))
        updatedSchedules.length = 0
        maturedRows.push(scheduleRow({ next_fire_at: slot }))
        const result = await processMaturedSchedules()
        slot = updatedSchedules[0]!.next_fire_at!
        return result
      }

      for (let i = 1; i < FORBID_SUSTAINED_SKIP_THRESHOLD; i += 1) await tick()
      expect(rootLogger.warn).not.toHaveBeenCalled()

      await tick() // 6th consecutive skip
      expect(rootLogger.warn).toHaveBeenCalledTimes(1)
      expect(rootLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'workflow_schedule_worker_concurrency_forbidden_sustained',
          scheduleId: 's-forbid',
          activeRunId: 'run-active',
          consecutiveSkips: FORBID_SUSTAINED_SKIP_THRESHOLD,
        }),
        expect.any(String)
      )
      expect(workflowScheduleWorkerConcurrencyForbiddenSustainedTotal.inc).toHaveBeenCalledTimes(1)

      await tick() // 7th: still skipping, no second warning for the same streak
      expect(rootLogger.warn).toHaveBeenCalledTimes(1)

      activeRuns.clear()
      expect((await tick()).fired).toBe(1)
      setActiveRun()
      vi.mocked(rootLogger.info).mockClear()
      await tick()
      expect(rootLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveSkips: 1 }),
        expect.any(String)
      )
    })

    it('defaults a null concurrency_policy to Forbid', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow({ concurrency_policy: null }))

      const result = await processMaturedSchedules()

      expect(result.concurrencyForbidden).toBe(1)
      expect(createRunMock).not.toHaveBeenCalled()
    })

    it('still overlaps under Allow and never looks up active runs', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow({ concurrency_policy: 'Allow' }))

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(1)
      expect(result.concurrencyForbidden).toBe(0)
      expect(createRunMock).toHaveBeenCalledTimes(1)
      expect(activeRunLookups()).toHaveLength(0)
    })

    it('treats Replace exactly like Allow (Replace is not implemented)', async () => {
      setActiveRun()
      maturedRows.push(scheduleRow({ concurrency_policy: 'Replace' }))

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(1)
      expect(result.concurrencyForbidden).toBe(0)
      expect(createRunMock).toHaveBeenCalledTimes(1)
      expect(activeRunLookups()).toHaveLength(0)
    })

    it('does not block on an active run of a different recipe', async () => {
      setActiveRun({ run_id: 'run-other' }, 'sandbox-recipes/other-recipe')
      setActiveRun({ run_id: 'run-other-ns' }, 'other-namespace/pr-review')
      maturedRows.push(scheduleRow())

      const result = await processMaturedSchedules()

      expect(result.fired).toBe(1)
      expect(activeRunLookups().map(params => params.slice(0, 2))).toEqual([
        ['sandbox-recipes', 'pr-review'],
      ])
      const lookupSql = String(
        clientQuery.mock.calls.find(([sql]) => /FROM workflow_runs/i.test(String(sql)))?.[0]
      )
      expect(lookupSql).toMatch(/recipe_namespace = \$1/)
      expect(lookupSql).toMatch(/AND recipe_name = \$2/)
      expect(lookupSql).not.toMatch(/child_recipe_name/)
    })

    it('runs the active-run check inside the locked batch transaction, before createRun, on the same client', async () => {
      maturedRows.push(scheduleRow())

      await processMaturedSchedules()

      const calls = clientQuery.mock.calls.map(([sql]) => String(sql))
      const order = clientQuery.mock.invocationCallOrder
      const lockAt = calls.findIndex(sql => /pg_try_advisory_lock/i.test(sql))
      const beginAt = calls.findIndex(sql => /^\s*BEGIN\s*$/i.test(sql))
      const selectAt = calls.findIndex(sql => /FOR UPDATE SKIP LOCKED/i.test(sql))
      const lookupAt = calls.findIndex(sql => /FROM workflow_runs/i.test(sql))
      const commitAt = calls.findIndex(sql => /^\s*COMMIT\s*$/i.test(sql))
      expect(lockAt).toBeGreaterThanOrEqual(0)
      expect(beginAt).toBeGreaterThan(lockAt)
      expect(selectAt).toBeGreaterThan(beginAt)
      expect(lookupAt).toBeGreaterThan(selectAt)
      expect(commitAt).toBeGreaterThan(lookupAt)
      expect(createRunMock).toHaveBeenCalledTimes(1)
      const createRunOrder = createRunMock.mock.invocationCallOrder[0]!
      expect(createRunOrder).toBeGreaterThan(order[lookupAt]!)
      expect(createRunOrder).toBeLessThan(order[commitAt]!)
      // createRun inserts through the same transaction-scoped client.
      const runClient = createRunMock.mock.calls[0]?.[1] as { query: unknown }
      expect(runClient.query).toBe(clientQuery)
    })

    it('rolls back without firing when the active-run lookup fails', async () => {
      activeRunQueryError = new Error('canceling statement due to statement timeout')
      maturedRows.push(scheduleRow())

      await expect(processMaturedSchedules()).rejects.toThrow('statement timeout')

      expect(createRunMock).not.toHaveBeenCalled()
      expect(updatedSchedules).toHaveLength(0)
      expect(txEvents).toEqual(['BEGIN', 'ROLLBACK'])
      expect(clientRelease).toHaveBeenCalledTimes(1)
    })
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
