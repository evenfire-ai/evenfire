import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { type SchedulingRecipe, reconcileScheduling } from './schedulingHandler'

function makeRecipe(overrides: Partial<SchedulingRecipe> = {}): SchedulingRecipe {
  return {
    metadata: {
      name: 'daily-report',
      namespace: 'sandbox-recipes',
      uid: 'uid-123',
      labels: { 'clerum.io/workflow-team-id': '11111111-1111-4111-8111-111111111111' },
      ...(overrides.metadata ?? {}),
    },
    spec: {
      scheduling: {
        cron: '0 9 * * *',
        timezone: 'UTC',
      },
      ...(overrides.spec ?? {}),
    },
  }
}

describe('reconcileScheduling', () => {
  const query = vi.fn()
  const pool = { query } as unknown as Pool

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('denormalizes runRetention on schedule creation', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await reconcileScheduling(
      pool,
      makeRecipe({
        spec: {
          scheduling: {
            cron: '0 9 * * *',
            timezone: 'UTC',
          },
          runRetention: {
            maxRunDurationSeconds: 7200,
            ttlSecondsAfterFinished: 3600,
          },
        },
      })
    )

    expect(result).toEqual({ action: 'created' })
    const insertCall = query.mock.calls[1] as [string, unknown[]]
    expect(insertCall[0]).toContain('INSERT INTO workflow_schedules')
    expect(insertCall[0]).toContain('max_duration_seconds')
    expect(insertCall[0]).toContain('ttl_seconds_after_finished')
    expect(insertCall[1]?.[8]).toBe(7200)
    expect(insertCall[1]?.[9]).toBe(3600)
  })

  it('defaults schedule artifact retention to 30 days when omitted', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await reconcileScheduling(pool, makeRecipe())

    expect(result).toEqual({ action: 'created' })
    const insertCall = query.mock.calls[1] as [string, unknown[]]
    expect(insertCall[0]).toContain('ttl_seconds_after_finished')
    expect(insertCall[1]?.[9]).toBe(2_592_000)
  })

  it('updates the denormalized retention fields when retention changes', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            cron_expression: '0 9 * * *',
            timezone: 'UTC',
            enabled: true,
            allowed_actors: null,
            max_duration_seconds: 600,
            ttl_seconds_after_finished: 1200,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await reconcileScheduling(
      pool,
      makeRecipe({
        spec: {
          scheduling: {
            cron: '0 9 * * *',
            timezone: 'UTC',
          },
          runRetention: {
            maxRunDurationSeconds: 900,
            ttlSecondsAfterFinished: 1800,
          },
        },
      })
    )

    expect(result).toEqual({ action: 'updated' })
    const updateCall = query.mock.calls[1] as [string, unknown[]]
    expect(updateCall[0]).toContain('UPDATE workflow_schedules')
    expect(updateCall[0]).toContain('max_duration_seconds = $4')
    expect(updateCall[0]).toContain('ttl_seconds_after_finished = $5')
    expect(updateCall[0]).not.toContain('next_fire_at =')
    expect(updateCall[1]?.[3]).toBe(900)
    expect(updateCall[1]?.[4]).toBe(1800)
  })
})
