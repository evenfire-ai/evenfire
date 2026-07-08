import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  type SchedulingRecipe,
  computeNextFire,
  deleteScheduling,
  reconcileScheduling,
} from '../../../src/workflow/schedulingHandler'

const baseRecipe: SchedulingRecipe = {
  metadata: {
    name: 'daily-report',
    namespace: 'sandbox-recipes',
    uid: 'uid-abc',
    labels: { 'clerum.io/workflow-team-id': '11111111-1111-4111-8111-111111111111' },
  },
  spec: {
    scheduling: {
      cron: '0 9 * * *',
      timezone: 'America/New_York',
    },
  },
}

interface QueryCall {
  sql: string
  params: unknown[]
}

function makePool(selectRows: Array<Record<string, unknown>> = []): {
  pool: Pool
  calls: QueryCall[]
  query: ReturnType<typeof vi.fn>
} {
  const calls: QueryCall[] = []
  let selectIndex = 0
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const entry: QueryCall = { sql, params: params ?? [] }
    calls.push(entry)
    const trimmed = sql.trim().toUpperCase()
    if (trimmed.startsWith('SELECT')) {
      const rawRow = selectIndex < selectRows.length ? selectRows[selectIndex++] : null
      const rows = rawRow
        ? [
            {
              team_id: '11111111-1111-4111-8111-111111111111',
              allowed_actors: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: 2_592_000,
              ...rawRow,
            },
          ]
        : []
      return { rows, rowCount: rows.length }
    }
    if (trimmed.startsWith('DELETE')) {
      const row = selectRows[0]
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    return { rows: [], rowCount: 1 }
  })
  return { pool: { query } as unknown as Pool, calls, query }
}

describe('computeNextFire', () => {
  it('computes next occurrence for hourly cron', () => {
    const from = new Date('2026-04-20T10:15:00Z')
    const next = computeNextFire('0 * * * *', 'UTC', from)
    expect(next.toISOString()).toBe('2026-04-20T11:00:00.000Z')
  })

  it('honors timezone when computing next fire', () => {
    // "0 9 * * *" in America/New_York is 13:00 or 14:00 UTC depending on DST.
    const from = new Date('2026-04-20T10:00:00Z') // DST in effect → EDT (UTC-4)
    const next = computeNextFire('0 9 * * *', 'America/New_York', from)
    expect(next.toISOString()).toBe('2026-04-20T13:00:00.000Z')
  })

  it('defaults to UTC when timezone is empty string', () => {
    const from = new Date('2026-04-20T10:15:00Z')
    const next = computeNextFire('30 10 * * *', '', from)
    expect(next.toISOString()).toBe('2026-04-20T10:30:00.000Z')
  })
})

describe('reconcileScheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DELETEs row when scheduling spec is absent (was a schedule)', async () => {
    // Simulate "row exists" via selectRows so the DELETE returns rowCount>0 → 'deleted'.
    const { pool, calls } = makePool([
      { cron_expression: '0 9 * * *', timezone: 'UTC', enabled: true },
    ])
    const result = await reconcileScheduling(pool, { ...baseRecipe, spec: {} })
    expect(result.action).toBe('deleted')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/DELETE FROM workflow_schedules/)
    expect(calls[0].params).toEqual(['sandbox-recipes', 'daily-report'])
  })

  it('returns skipped when no scheduling spec and no row existed', async () => {
    const { pool } = makePool([])
    const result = await reconcileScheduling(pool, { ...baseRecipe, spec: {} })
    expect(result.action).toBe('skipped')
  })

  it('INSERTs a new row with next_fire_at when schedule is new', async () => {
    const { pool, calls } = makePool([]) // SELECT returns empty → no prev row
    const result = await reconcileScheduling(pool, baseRecipe)
    expect(result.action).toBe('created')
    expect(calls).toHaveLength(2) // SELECT + INSERT
    expect(calls[1].sql).toMatch(/INSERT INTO workflow_schedules/)
    const [ns, name, teamId, cron, tz, nextFire, enabled] = calls[1].params
    expect(ns).toBe('sandbox-recipes')
    expect(name).toBe('daily-report')
    expect(teamId).toBe('11111111-1111-4111-8111-111111111111')
    expect(cron).toBe('0 9 * * *')
    expect(tz).toBe('America/New_York')
    expect(nextFire).toBeInstanceOf(Date)
    expect(enabled).toBe(true)
  })

  it('UPDATEs with cron + next_fire_at reset when cron expression changed', async () => {
    const { pool, calls } = makePool([
      { cron_expression: '0 8 * * *', timezone: 'America/New_York', enabled: true },
    ])
    const result = await reconcileScheduling(pool, baseRecipe)
    expect(result.action).toBe('updated')
    expect(calls).toHaveLength(2)
    expect(calls[1].sql).toMatch(/UPDATE workflow_schedules/)
    expect(calls[1].sql).toMatch(/next_fire_at/)
    expect(calls[1].sql).toMatch(/updated_at = now\(\)/)
  })

  it('UPDATEs with reset next_fire_at when timezone changed', async () => {
    const { pool, calls } = makePool([
      { cron_expression: '0 9 * * *', timezone: 'UTC', enabled: true },
    ])
    const result = await reconcileScheduling(pool, baseRecipe)
    expect(result.action).toBe('updated')
    expect(calls[1].sql).toMatch(/next_fire_at/)
  })

  it('returns suspended when previously enabled and spec now suspends', async () => {
    const { pool, calls } = makePool([
      { cron_expression: '0 9 * * *', timezone: 'America/New_York', enabled: true },
    ])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: { scheduling: { cron: '0 9 * * *', timezone: 'America/New_York', suspend: true } },
    }
    const result = await reconcileScheduling(pool, recipe)
    expect(result.action).toBe('suspended')
    // Suspension path UPDATE must NOT reset next_fire_at.
    expect(calls[1].sql).toMatch(/UPDATE workflow_schedules/)
    expect(calls[1].sql).not.toMatch(/next_fire_at/)
    expect(calls[1].sql).toMatch(/updated_at = now\(\)/)
    const params = calls[1].params
    expect(params[0]).toBe(false) // enabled set to false
  })

  it('returns resumed and resets next_fire_at when re-enabling after suspend', async () => {
    const { pool, calls } = makePool([
      { cron_expression: '0 9 * * *', timezone: 'America/New_York', enabled: false },
    ])
    const result = await reconcileScheduling(pool, baseRecipe) // suspend: false (default)
    expect(result.action).toBe('resumed')
    // Resume path MUST reset next_fire_at — stored value may be stale.
    expect(calls[1].sql).toMatch(/next_fire_at/)
  })

  it('skips UPDATE when row matches spec exactly (no drift)', async () => {
    const { pool, calls } = makePool([
      { cron_expression: '0 9 * * *', timezone: 'America/New_York', enabled: true },
    ])
    const result = await reconcileScheduling(pool, baseRecipe)
    expect(result.action).toBe('skipped')
    expect(calls).toHaveLength(1) // only SELECT, no UPDATE
  })

  it('defaults timezone to UTC when omitted in spec', async () => {
    const { pool, calls } = makePool([])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: { scheduling: { cron: '*/5 * * * *' } },
    }
    const result = await reconcileScheduling(pool, recipe)
    expect(result.action).toBe('created')
    expect(calls[1].params[4]).toBe('UTC')
  })

  it('persists allowedActors as JSONB string on INSERT so the worker can gate fires', async () => {
    const { pool, calls } = makePool([])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: {
        scheduling: { cron: '0 9 * * *', timezone: 'UTC' },
        allowedActors: ['user', 'autonomous'],
      },
    }
    const result = await reconcileScheduling(pool, recipe)
    expect(result.action).toBe('created')
    expect(calls[1].sql).toMatch(/INSERT INTO workflow_schedules/)
    expect(calls[1].sql).toMatch(/allowed_actors/)
    // Param 7 is `allowed_actors` (1-indexed $7). Serialized as a JSON string
    // for jsonb cast — node-pg will coerce to jsonb via the $N::jsonb cast.
    expect(calls[1].params[7]).toBe(JSON.stringify(['user', 'autonomous']))
  })

  it('normalizes an empty allowedActors to SQL NULL (matches admin no-restriction semantic)', async () => {
    const { pool, calls } = makePool([])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: {
        scheduling: { cron: '0 9 * * *', timezone: 'UTC' },
        allowedActors: [],
      },
    }
    await reconcileScheduling(pool, recipe)
    // Empty list on the CRD is almost always "no gating", not "deny all" —
    // we mirror getOnDemandAllowedActors() in control-api and store NULL.
    expect(calls[1].params[7]).toBeNull()
  })

  it('issues an UPDATE when only allowedActors drifts (cron + tz + enabled unchanged)', async () => {
    const { pool, calls } = makePool([
      {
        cron_expression: '0 9 * * *',
        timezone: 'America/New_York',
        enabled: true,
        allowed_actors: null,
      },
    ])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: {
        scheduling: { cron: '0 9 * * *', timezone: 'America/New_York' },
        allowedActors: ['user'],
      },
    }
    const result = await reconcileScheduling(pool, recipe)
    expect(result.action).toBe('updated')
    expect(calls[1].sql).toMatch(/UPDATE workflow_schedules/)
    // The non-cron UPDATE path MUST NOT reset next_fire_at (worker owns that
    // value once it starts advancing), but MUST carry allowed_actors.
    expect(calls[1].sql).not.toMatch(/next_fire_at/)
    expect(calls[1].sql).toMatch(/allowed_actors/)
    expect(calls[1].params[2]).toBe(JSON.stringify(['user']))
  })

  it('issues an UPDATE when only runRetention drifts (cron + tz + enabled unchanged)', async () => {
    const { pool, calls } = makePool([
      {
        cron_expression: '0 9 * * *',
        timezone: 'America/New_York',
        enabled: true,
        allowed_actors: null,
        max_duration_seconds: null,
        ttl_seconds_after_finished: null,
      },
    ])
    const recipe: SchedulingRecipe = {
      ...baseRecipe,
      spec: {
        scheduling: { cron: '0 9 * * *', timezone: 'America/New_York' },
        runRetention: { maxRunDurationSeconds: 1800, ttlSecondsAfterFinished: 3600 },
      },
    }
    const result = await reconcileScheduling(pool, recipe)
    expect(result.action).toBe('updated')
    expect(calls[1].sql).toMatch(/max_duration_seconds/)
    expect(calls[1].sql).toMatch(/ttl_seconds_after_finished/)
    expect(calls[1].sql).not.toMatch(/next_fire_at/)
    expect(calls[1].params[3]).toBe(1800)
    expect(calls[1].params[4]).toBe(3600)
  })

  it('fails closed when a scheduled recipe has no workflow team label', async () => {
    const { pool } = makePool([])
    await expect(
      reconcileScheduling(pool, {
        ...baseRecipe,
        metadata: {
          name: 'daily-report',
          namespace: 'sandbox-recipes',
          uid: 'uid-abc',
          labels: {},
        },
      })
    ).rejects.toThrow('requires clerum.io/workflow-team-id')
  })

  it('fails closed when a scheduled recipe has an invalid workflow team label', async () => {
    const { pool } = makePool([])
    await expect(
      reconcileScheduling(pool, {
        ...baseRecipe,
        metadata: {
          name: 'daily-report',
          namespace: 'sandbox-recipes',
          uid: 'uid-abc',
          labels: { 'clerum.io/workflow-team-id': 'not-a-uuid' },
        },
      })
    ).rejects.toThrow('invalid clerum.io/workflow-team-id')
  })
})

describe('deleteScheduling', () => {
  it('issues DELETE with (namespace, name) composite key', async () => {
    const { pool, calls } = makePool([])
    await deleteScheduling(pool, 'sandbox-recipes', 'daily-report')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/DELETE FROM workflow_schedules/)
    expect(calls[0].params).toEqual(['sandbox-recipes', 'daily-report'])
  })

  it('is idempotent (does not throw when no row exists)', async () => {
    const { pool } = makePool([])
    await expect(deleteScheduling(pool, 'ns', 'nope')).resolves.toBeUndefined()
  })
})
